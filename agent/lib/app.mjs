/**
 * 应用服务：把配置、编排器、插件安装/重载收在一个对象里，
 * 给 CLI、HTTP 服务、GUI 共用（它们都只跟 App 打交道）。
 *
 * @module stellaris-agent/app
 */
import { agentHome, configFile, loadConfig, saveConfig, mergeConfig, backendOf } from './config.mjs'
import { Orchestrator, resolvePaths } from './orchestrator.mjs'
import { installPlugin, reloadDsh, updateAndReloadPlugin, pluginVersions } from './dsh-plugin.mjs'
import { FailureStore } from './failures.mjs'
import { PRESETS, normalizePersona, personaPrompt, personaSummary } from './persona.mjs'
import { VoiceLog } from './voice.mjs'
import { discoverDsh } from './ai/dsh.mjs'
import { createBackend } from './ai/backend.mjs'
import { ensureBridge, findGameProcess, getSharedBridge } from './bridge.mjs'
import { createLogger } from './logger.mjs'

function redactConfig(config) {
  const copy = JSON.parse(JSON.stringify(config || {}))
  const key = String(copy?.ai?.deepseek?.apiKey || '')
  copy.ai = copy.ai || {}
  copy.ai.deepseek = copy.ai.deepseek || {}
  copy.ai.deepseek.apiKey = ''
  copy.ai.deepseek.apiKeyConfigured = Boolean(key)
  copy.ai.deepseek.apiKeyHint = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : ''
  if (copy.chat?.token) copy.chat.token = '***'
  return copy
}

export class App {
  constructor({ home = agentHome(), log = null } = {}) {
    this.home = home
    this.log = log || createLogger('app')
    this.config = null
    this.configFile = configFile()
    this.configError = null
    this.orchestrator = null
    this.lastError = null
    this.lastPlugin = null
    this.startedAt = 0
    this.lastConnect = null
    this._readiness = null
    this._readinessAt = 0
    this._gameProcess = null
    this._gameProcessAt = 0
    this.watcherTimer = null
    this._connecting = false
    this._starting = false
    this.autoStartSuppressedAt = 0
    this.reload()
  }

  reload() {
    const loaded = loadConfig()
    this.config = loaded.config
    this.configFile = loaded.file
    this.configError = loaded.error
    this._probeBackend = null
    if (loaded.created) this.log('app.config.created', { file: loaded.file })
    return loaded
  }

  /** 编排器没启动时，失败报告列表也要能读（直接扫 failures 目录）。 */
  failureStore() {
    return this.orchestrator?.failures || new FailureStore({ home: this.home, config: this.config, log: this.log })
  }

  /** 人格：配置 + 预设 + 当前 system prompt 预览。 */
  personaInfo() {
    const persona = normalizePersona(this.config?.persona)
    return {
      persona: personaSummary(persona),
      raw: persona,
      presets: Object.values(PRESETS).map((preset) => ({ id: preset.id, label: preset.label, name: preset.name, traits: preset.traits })),
      prompt: this.orchestrator?.main?.personaPrompt?.() || personaPrompt(persona),
    }
  }

  /** 保存人格并立即应用到运行中的主会话（不重启调度）。 */
  async setPersona(persona) {
    const next = normalizePersona(persona, this.config?.persona)
    this.config.persona = next
    saveConfig(this.config)
    this.orchestrator?.main?.applyPersona(next)
    this.log('app.persona.saved', {
      name: next.name,
      preset: next.preset,
      traits: next.traits,
      components: next.components.length,
      voice: next.voice,
    })
    return this.personaInfo()
  }

  /** 主会话的人话输出（编排器没启动时读今天的 voice 日志）。 */
  voices({ since = '', limit = 50 } = {}) {
    const log = this.orchestrator?.main?.voices || new VoiceLog({ home: this.home, log: this.log })
    return { dir: log.dir, voices: log.list({ since, limit }), latest: log.latest() }
  }

  /** 编排器没启动时，readiness 也要复用同一个后端实例（DSH 端口发现要缓存） */
  _probe() {
    if (!this._probeBackend) this._probeBackend = createBackend({ config: this.config, log: this.log })
    return this._probeBackend
  }

  get running() {
    return Boolean(this.orchestrator?.running)
  }

  get paths() {
    return resolvePaths(this.config)
  }

  backendKind() {
    return backendOf(this.config)
  }

  /**
   * 启动编排器（全量读取 + 主会话 + 事件队列）。
   */
  async start({ objective = null } = {}) {
    if (this.running) return this.status()
    if (this._starting) return this.status()
    if (this.configError) {
      const error = new Error(this.configError)
      error.code = 'CONFIG_INVALID'
      throw error
    }
    this._starting = true
    const orchestrator = new Orchestrator({ config: this.config, home: this.home, log: this.log })
    try {
      await orchestrator.start({ objective })
      this.orchestrator = orchestrator
      this.startedAt = Date.now()
      this.lastError = null
      this.autoStartSuppressedAt = 0
      this._readinessAt = 0
      this.startWatcher()
      return this.status()
    } catch (error) {
      this.lastError = { code: error.code || 'START_FAILED', message: String(error.message || error), detail: error.detail || null, at: Date.now() }
      this.log('app.start.failed', this.lastError)
      throw error
    } finally {
      this._starting = false
    }
  }

  async stop({ resume = true, suppressAuto = false } = {}) {
    if (suppressAuto) this.autoStartSuppressedAt = Date.now()
    if (!this.orchestrator) return { ok: true, already: true }
    const orchestrator = this.orchestrator
    this.orchestrator = null
    try {
      await orchestrator.stop({ resume })
      this._readinessAt = 0
      return { ok: true }
    } catch (error) {
      this.lastError = { code: 'STOP_FAILED', message: String(error.message || error), at: Date.now() }
      return { ok: false, error: String(error.message || error) }
    }
  }

  async restart({ objective = null } = {}) {
    const wasRunning = this.running
    await this.stop({ resume: false })
    if (!wasRunning) return { ok: true, restarted: false }
    return { ok: true, restarted: true, status: await this.start({ objective }) }
  }

  /**
   * 保存设置；运行中则重启编排器让新设置生效。
   * @param {object} patch 与 config.json 同构的局部对象
   */
  async applySettings(patch = {}) {
    const current = this.config || loadConfig().config
    // 前端可能把「脱敏后的完整配置」直接回传：剔除只读字段，避免写进配置文件
    const sanitized = JSON.parse(JSON.stringify(patch || {}))
    if (sanitized.ai?.deepseek) {
      delete sanitized.ai.deepseek.apiKeyConfigured
      delete sanitized.ai.deepseek.apiKeyHint
    }
    if (sanitized.chat?.token === '***') delete sanitized.chat.token
    const next = mergeConfig(current, sanitized)
    // 空字符串的 apiKey 表示"保持原值"，避免 GUI 掩码写回把 key 清掉
    if (sanitized?.ai?.deepseek?.apiKey === '') next.ai.deepseek.apiKey = current.ai.deepseek.apiKey
    saveConfig(next)
    this.config = next
    this._probeBackend = null
    this.configError = null
    this.log('app.settings.saved', { file: this.configFile, backend: this.backendKind() })
    this.stopWatcher()
    this.startWatcher()
    this._readinessAt = 0
    let restart = null
    if (this.running) {
      try {
        restart = await this.restart({ objective: this.orchestrator?.objective || this.config.objective || null })
      } catch (error) {
        restart = { ok: false, error: String(error.message || error), code: error.code || 'RESTART_FAILED' }
        this.lastError = { code: 'RESTART_FAILED', message: String(error.message || error), at: Date.now() }
      }
    }
    return { ok: true, saved: this.configFile, config: redactConfig(this.config), restart }
  }

  async installPlugin({ copy = false } = {}) {
    const result = installPlugin({
      profileDir: this.config?.dshPlugin?.profileDir || '',
      copy,
      log: this.log,
    })
    const reload = result.ok ? await this.reloadPlugin({ allowRestart: false }) : null
    this.lastPlugin = { install: result, reload, at: Date.now() }
    return { ...result, reload }
  }

  async reloadPlugin({ allowRestart = false } = {}) {
    const result = await reloadDsh({ config: this.config, log: this.log, allowRestart })
    this.lastPlugin = { ...(this.lastPlugin || {}), reload: result, at: Date.now() }
    return result
  }

  async updatePlugin({ allowRestart = false } = {}) {
    const result = await updateAndReloadPlugin({
      config: this.config,
      log: this.log,
      profileDir: this.config?.dshPlugin?.profileDir || '',
      allowRestart,
    })
    this.lastPlugin = { ...result, at: Date.now() }
    return result
  }

  async discoverDsh() {
    return discoverDsh({ configuredUrl: this.config?.ai?.dsh?.url || '' })
  }

  // ---------------------------------------------------------------- 连接状态
  async _gameProcessCached() {
    const now = Date.now()
    if (now - this._gameProcessAt < 10000) return this._gameProcess
    this._gameProcessAt = now
    try {
      this._gameProcess = await findGameProcess()
    } catch {
      this._gameProcess = null
    }
    return this._gameProcess
  }

  /**
   * 「大模型是否连上」+「游戏是否连上」，给状态栏用。
   * - DSH：真的打一次本地 /health；
   * - DeepSeek：默认只看 Key 是否配置，`verifyLlm` 时才真发一次 1 token 请求；
   * - 游戏：编排器在跑就用它的桥状态；否则用共享客户端探测（**不**注入）。
   * 结果缓存 4 秒，GUI 每 5 秒轮询不会造成负担。
   */
  async readiness({ force = false, verifyLlm = false } = {}) {
    const now = Date.now()
    if (!force && !verifyLlm && this._readiness && now - this._readinessAt < 4000) return this._readiness
    const kind = this.backendKind()

    let llm
    if (kind === 'dsh') {
      const backend = this.orchestrator?.backend || this._probe()
      let health
      try {
        health = await backend.health()
      } catch (error) {
        health = { ok: false, error: String(error?.message || error) }
      }
      llm = {
        ok: Boolean(health.ok),
        backend: 'dsh',
        label: 'DSH',
        detail: health.ok ? `DSH ${backend.baseUrl || health.url || ''}` : health.error || 'DSH 未连接',
        url: backend.baseUrl || health.url || null,
        service: health.service || null,
        verified: Boolean(health.ok),
        checkedAt: now,
      }
    } else {
      const key = String(this.config?.ai?.deepseek?.apiKey || '').trim()
      llm = {
        ok: Boolean(key),
        backend: 'deepseek',
        label: 'DeepSeek',
        detail: key ? `${this.config?.ai?.deepseek?.model || 'deepseek-chat'} · Key 已配置` : '未配置 API Key',
        model: this.config?.ai?.deepseek?.model || null,
        verified: null,
        checkedAt: now,
      }
      if (verifyLlm && key) {
        try {
          const backend = this.orchestrator?.backend || this._probe()
          const reply = await backend.complete({
            system: '你是一个连通性探针，只回复 ok。',
            messages: [{ role: 'user', content: 'ping' }],
            maxTokens: 4,
            timeoutMs: 8000,
          })
          llm = { ...llm, ok: true, verified: true, detail: `${llm.model} · 已验证`, sample: String(reply.text || '').slice(0, 40) }
        } catch (error) {
          llm = { ...llm, ok: false, verified: false, detail: `调用失败：${String(error?.message || error).slice(0, 160)}` }
        }
      }
    }

    let game = { ok: false, inGame: false, date: null, running: false, injected: false, pid: null, detail: '未检测' }
    if (this.orchestrator?.running) {
      const status = this.orchestrator.status()
      const connected = Boolean(status.bridge?.connected)
      game = {
        ok: connected,
        inGame: Boolean(status.world?.inGame),
        date: status.world?.date || null,
        running: true,
        injected: Boolean(status.bridge?.injected || this.lastConnect?.injected),
        pid: this.lastConnect?.pid || null,
        detail: connected ? (status.world?.inGame ? '原生桥已连接' : '原生桥已连接（主菜单）') : '原生桥断开',
      }
    } else if (!this._connecting) {
      const client = getSharedBridge({
        pipeName: this.config?.bridge?.pipeName || undefined,
        timeoutMs: Number(this.config?.bridge?.requestTimeoutMs) || 15000,
        log: this.log,
      })
      let status = null
      try {
        status = await client.request('get_status', {}, { timeoutMs: 1500 })
      } catch {
        status = null
      }
      if (status) {
        game = {
          ok: true,
          inGame: Boolean(status.in_game),
          date: status.date?.formatted || null,
          running: false,
          injected: Boolean(this.lastConnect?.injected),
          pid: null,
          detail: status.in_game ? '原生桥已连接（未接管）' : '原生桥已连接（主菜单）',
        }
      } else {
        const proc = await this._gameProcessCached()
        const auto = this.config?.bridge?.autoInject !== false
        game = {
          ok: false,
          inGame: false,
          date: null,
          running: false,
          injected: false,
          pid: proc?.pid || null,
          detail: proc ? (auto ? '游戏在运行，桥未注入（自动注入中）' : '游戏在运行，桥未注入') : '游戏未运行',
        }
      }
    }

    this._readiness = {
      llm,
      game,
      running: this.running,
      autoInject: this.config?.bridge?.autoInject !== false,
      autoStart: this.config?.bridge?.autoStartOrchestrator !== false,
      lastConnect: this.lastConnect,
      checkedAt: now,
    }
    this._readinessAt = now
    return this._readiness
  }

  /**
   * 手动/自动连接：确保桥（必要时注入），可选自动启动编排器。
   */
  async connect({ start = null } = {}) {
    const shouldStart = start === null ? this.config?.bridge?.autoStartOrchestrator !== false : Boolean(start)
    const result = await ensureBridge({ config: this.config, log: this.log })
    this.lastConnect = { ok: result.ok, error: result.error || null, injected: Boolean(result.injected), pid: result.pid || null, at: Date.now() }
    this.log('app.connect', this.lastConnect)
    let started = null
    if (result.ok && shouldStart && !this.running && result.status?.in_game) {
      try {
        await this.start()
        started = true
      } catch (error) {
        started = false
        this.lastConnect.startError = String(error?.message || error)
      }
    }
    this._readinessAt = 0
    return {
      ok: result.ok,
      injected: Boolean(result.injected),
      error: result.error || null,
      detail: result.detail || null,
      started,
      readiness: await this.readiness({ force: true }),
    }
  }

  startWatcher() {
    if (this.watcherTimer) return
    const seconds = Math.max(5, Number(this.config?.bridge?.watchSeconds ?? 15))
    this.watcherTimer = setInterval(() => {
      this.tickWatcher().catch((error) => this.log('app.watch.error', { error: String(error?.message || error) }))
    }, seconds * 1000)
    this.watcherTimer.unref?.()
    this.log('app.watch.start', { seconds })
    // 立刻跑一次：打开程序就能自动连上，不用等第一个间隔
    this.tickWatcher().catch((error) => this.log('app.watch.error', { error: String(error?.message || error) }))
  }

  stopWatcher() {
    if (this.watcherTimer) clearInterval(this.watcherTimer)
    this.watcherTimer = null
  }

  /**
   * 看护循环：游戏在跑就保证桥可用；进局了就保证编排器在跑。
   * 一次注入后，游戏重启/程序重启都会自动续上，不需要再点按钮。
   */
  async tickWatcher() {
    if (this._connecting || this._starting) return
    const wantInject = this.config?.bridge?.autoInject !== false
    const wantStart = this.config?.bridge?.autoStartOrchestrator !== false
    if (!wantInject && !wantStart) return
    if (this.running) {
      this._readinessAt = 0
      return
    }
    // 用户刚手动停止过：给 5 分钟冷静期，别马上又拉起来
    if (wantStart && Date.now() - (this.autoStartSuppressedAt || 0) < 5 * 60 * 1000) return

    const client = getSharedBridge({
      pipeName: this.config?.bridge?.pipeName || undefined,
      timeoutMs: Number(this.config?.bridge?.requestTimeoutMs) || 15000,
      log: this.log,
    })
    let status = null
    try {
      status = await client.request('get_status', {}, { timeoutMs: 1500 })
    } catch {
      status = null
    }

    if (!status) {
      const game = await this._gameProcessCached()
      if (!game) return
      if (!wantInject) return
      this._connecting = true
      try {
        const result = await ensureBridge({ config: this.config, log: this.log })
        this.lastConnect = { ok: result.ok, error: result.error || null, injected: Boolean(result.injected), pid: result.pid || null, at: Date.now() }
        this.log('app.watch.inject', this.lastConnect)
        if (!result.ok) return
        status = result.status
      } finally {
        this._connecting = false
      }
    }

    this._readinessAt = 0
    if (status?.in_game && wantStart && !this.running) {
      try {
        await this.start()
        this.log('app.watch.autostart', { date: status.date?.formatted || null })
      } catch (error) {
        this.log('app.watch.autostart.failed', { code: error?.code || null, error: String(error?.message || error) })
      }
    }
  }

  status() {
    const orchestrator = this.orchestrator?.status() || null
    return {
      running: this.running,
      startedAt: this.startedAt || null,
      uptimeMs: this.startedAt && this.running ? Date.now() - this.startedAt : 0,
      home: this.home,
      configFile: this.configFile,
      configError: this.configError,
      backend: this.backendKind(),
      paths: this.paths,
      plugin: { ...pluginVersions(), last: this.lastPlugin },
      orchestrator,
      readiness: this._readiness,
      lastConnect: this.lastConnect,
      watcher: { running: Boolean(this.watcherTimer), seconds: Number(this.config?.bridge?.watchSeconds ?? 15) },
      lastError: this.lastError,
    }
  }

  brief() {
    if (this.orchestrator) return this.orchestrator.brief()
    return `未启动。配置：${this.configFile}\n游戏：${this.paths.installDir || '未找到'}\n存档：${this.paths.saveDir || '未找到'}`
  }
}

export { redactConfig }
