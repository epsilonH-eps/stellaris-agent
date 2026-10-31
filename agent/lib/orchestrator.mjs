/**
 * 编排器：把「读取层 / 执行器 / AI 层 / 聊天」组装起来跑。
 *
 *   bridge ── reader ── world ─┬─ 触发器 ── 特殊事件子会话
 *                              ├─ 完成事件 ─ 主会话上下文
 *                              └─ 单位清单 ─ 1:1 单位子会话
 *   executor ←── 单位/事件子会话（动作 → 执行 → 回执）
 *   chat ⇄ 主会话（人说的话进，主会话说的话出）
 *
 * 生命周期：`start()` 会做一次**全量读取**（含模组、已激活事件链、存档 meta），
 * 然后启动世界轮询、主会话定时器与事件队列；`stop()` 收摊并恢复游戏（可配）。
 *
 * @module stellaris-agent/orchestrator
 */
import { ensureBridge } from './bridge.mjs'
import { Reader } from './reader.mjs'
import { World } from './world.mjs'
import { EventGraph, resolveActiveChains } from './events.mjs'
import { listMods, modsDigest } from './mods.mjs'
import { ChatHub } from './chat.mjs'
import { Executor } from './executor.mjs'
import { AgentJournal } from './journal.mjs'
import { discoverUnits } from './context.mjs'
import { validateActions } from './actions.mjs'
import { createBackend, checkBackend } from './ai/backend.mjs'
import { MainSession } from './ai/main.mjs'
import { EventSession, UnitSession } from './ai/worker.mjs'
import { resolveUserDir } from '../../engine/lib/paths.js'
import { resolveInstallDir } from '../../engine/lib/steam.js'
import { readSaveState, resolveSaveDir, saveIdentity } from './save.mjs'
import { MainSessionStore } from './main-sessions.mjs'
import { agentHome } from './config.mjs'
import { FailureStore } from './failures.mjs'

export class OrchestratorError extends Error {
  constructor(message, { code = 'ORCHESTRATOR_ERROR', detail = null } = {}) {
    super(message)
    this.name = 'OrchestratorError'
    this.code = code
    this.detail = detail
  }
}

export function resolvePaths(config) {
  const legacy = {
    stellarisInstallDir: config?.paths?.stellarisInstallDir || '',
    stellarisUserDir: config?.paths?.stellarisUserDir || '',
  }
  const user = resolveUserDir(legacy)
  const install = resolveInstallDir(legacy)
  const save = resolveSaveDir({ config, userDir: user.dir })
  return {
    userDir: user.dir || null,
    userDirSource: user.source,
    installDir: install.dir || null,
    installSource: install.source,
    saveDir: save.dir || null,
    saveDirSource: save.source,
  }
}

export class Orchestrator {
  /**
   * @param {object} options
   * @param {object} options.config
   * @param {string} [options.home]
   * @param {Function} [options.log]
   */
  constructor({ config, home = agentHome(), log = () => {} }) {
    this.config = config
    this.home = home
    this.log = log
    this.running = false
    this.startedAt = 0
    this.lastError = null
    this.bridge = null
    this.bridgeInjected = false
    this.reader = null
    this.world = null
    this.eventGraph = null
    this.executor = null
    this.chat = null
    this.backend = null
    this.backendInfo = null
    this.main = null
    this.journal = null
    this.failures = new FailureStore({ home: this.home, config: this.config, log: this.log })
    this.units = new Map()
    this.eventSessions = new Map()
    this.recentEvents = []
    this.mainStore = new MainSessionStore({ home: this.home, log: this.log })
    this.mainSave = null
    this.saveTimer = null
    this.switchingSave = false
    this.eventQueue = []
    this.eventRunning = false
    this.unitIntervals = new Map()
    this.mainTimer = null
    this.mainInterval = null
    this.lastScheduleAt = 0
    this.objective = String(config?.objective || '')
    this.paths = resolvePaths(config)
    this.stats = { mainTicks: 0, unitRuns: 0, eventRuns: 0, failures: 0 }
  }

  // ---------------------------------------------------------------- 生命周期
  /**
   * @param {object} [options]
   * @param {string} [options.objective]
   * @param {{request:Function}} [options.bridge] 测试/嵌入时可注入桥
   * @param {object} [options.backend] 测试/嵌入时可注入 AI 后端
   */
  async start({ objective = null, bridge = null, backend = null } = {}) {
    if (this.running) return this.status()
    const began = Date.now()
    if (objective !== null) this.objective = String(objective || '')
    this.log('orchestrator.start', { backend: this.config?.ai?.backend, home: this.home })
    this.lastError = null

    let bridgeResult
    if (bridge) {
      try {
        bridgeResult = { ok: true, injected: false, status: await bridge.request('get_status'), client: bridge }
      } catch (error) {
        bridgeResult = { ok: false, error: 'BRIDGE_UNAVAILABLE', detail: String(error?.message || error) }
      }
    } else {
      bridgeResult = await ensureBridge({ config: this.config, log: this.log })
    }
    if (!bridgeResult.ok) {
      const error = new OrchestratorError(`原生桥不可用：${bridgeResult.error}`, {
        code: bridgeResult.error || 'BRIDGE_UNAVAILABLE',
        detail: bridgeResult.detail || null,
      })
      this.lastError = error.message
      throw error
    }
    this.bridge = bridgeResult.client
    this.bridgeInjected = Boolean(bridgeResult.injected)

    this.paths = resolvePaths(this.config)
    this.journal = new AgentJournal({ dir: `${this.home}/journal`, enabled: this.config?.journal?.enabled !== false })
    this.chat = new ChatHub({ config: this.config, log: this.log })
    this.executor = new Executor({ bridge: this.bridge, config: this.config, log: this.log })
    this.executor.on('job.done', (result) => {
      this.journal?.append({
        kind: 'executor.job',
        unit: result.unit,
        text: result.summary || result.error || '',
        meta: { jobId: result.jobId, ok: result.ok, failedIndex: result.failedIndex, actions: result.actions?.map((row) => row.method) },
      })
    })
    this.executor.on('paused', (event) => this.chat?.outbound({ text: `${event.paused ? '已暂停' : '已恢复'}游戏（${event.reason}）`, id: 'system', kind: 'status' }))

    this.backend = backend || createBackend({ config: this.config, log: this.log })
    this.backendInfo = backend
      ? { ok: true, backend: backend.name || 'injected', ...(backend.describe?.() || {}) }
      : await checkBackend(this.backend)
    this.log('orchestrator.backend', { ok: this.backendInfo.ok, backend: this.backendInfo.backend, error: this.backendInfo.error || null })

    // 模组 → 事件索引（含模组事件目录），再做全量读取
    const mods = listMods({ userDir: this.paths.userDir || '', installDir: this.paths.installDir || '' })
    this.mods = mods
    this.eventGraph = new EventGraph({
      home: this.home,
      installDir: this.paths.installDir || '',
      modEventDirs: mods.eventDirs,
      log: this.log,
    }).build()
    this.log('orchestrator.events', this.eventGraph.status())

    this.reader = new Reader({ bridge: this.bridge, config: this.config, home: this.home, log: this.log, paths: this.paths })
    this.world = new World({ reader: this.reader, config: this.config, home: this.home, log: this.log, eventGraph: this.eventGraph })
    this.world.on('trigger', (trigger) => this.handleTrigger(trigger))
    this.world.on('completion', (event) => this.main?.observe(`完成事件 ${event.type}：${JSON.stringify(event.detail)}`))

    const deep = String(this.config?.read?.onStart || 'full') !== 'quick'
    let world
    try {
      world = await this.world.refresh({ deep, includeSave: true })
    } catch (error) {
      const wrapped = new OrchestratorError(`读取游戏状态失败：${error?.message || error}`, { code: 'READ_FAILED', detail: String(error?.message || error) })
      this.lastError = wrapped.message
      throw wrapped
    }
    if (!world.inGame) {
      const error = new OrchestratorError('游戏进程在，但还停在主菜单；请读档或新开一局', { code: 'GAME_NOT_IN_SESSION' })
      this.lastError = error.message
      throw error
    }

    await this.switchMainSave(world.save, { reason: 'start', force: true })
    this.rebuildUnits(world)
    this.main.setObjective(this.objective)
    this.running = true
    this.startedAt = Date.now()

    this.world.start()
    this.startSaveWatch()
    this.startMainLoop()
    this.journal?.append({ kind: 'orchestrator.start', text: `开始调度：${this.objective || '(无目标)'}`, meta: { paths: this.paths, mods: mods.enabled } })
    this.chat.outbound({
      text: this.backendInfo.ok
        ? `已接管：${world.date || '未知日期'}｜${world.colonies.length} 颗殖民地｜${world.fleetsAll.length} 支舰队｜模组 ${mods.enabled} 个｜事件 ${world.activeEvents.length} 个`
        : `已连接游戏（${world.date || '未知日期'}），但 AI 后端不可用：${this.backendInfo.error}。${this.backendInfo.hint || ''}`,
      id: 'system',
      kind: 'status',
    })

    // 启动时把已激活事件当作特殊事件处理
    if (this.config?.ai?.event?.processOnStart !== false) {
      for (const event of world.activeEvents || []) {
        this.handleTrigger({ type: 'event_window', priority: 100, unit: 'event', payload: event, at: Date.now(), startup: true })
      }
    }
    if (this.config?.ai?.main?.activateOnStart !== false && this.backendInfo.ok) {
      this.scheduleMain('start', 0)
    }
    if (this.eventQueue.length) this.drainEvents().catch(() => {})
    this.log('orchestrator.started', { ms: Date.now() - began, units: this.units.size })
    return this.status()
  }

  // ---------------------------------------------------------------- 主会话 / 存档
  /**
   * 切换到某个存档对应的主会话：
   *  - 存档身份见 save.mjs `saveIdentity()`（同一帝国目录的 autosave/manual 算同一个）；
   *  - 每个存档有自己的本地 transcript + 自己的 DSH session id；
   *  - 切换时清掉旧的单位会话，避免跨存档复用。
   */
  async switchMainSave(saveState, { reason = 'save', force = false } = {}) {
    const info = saveIdentity(saveState)
    if (!force && this.main && this.mainSave?.key === info.key) return this.main
    if (this.switchingSave) return this.main
    this.switchingSave = true
    try {
      this.persistMain()
      this.units.clear()
      this.eventSessions.clear()
      this.recentEvents = []
      const transcript = this.mainStore.load(info.key)
      const main = new MainSession({
        backend: this.backendInfo?.ok ? this.backend : null,
        config: this.config,
        executor: this.executor,
        chat: this.chat,
        getWorld: () => this.world?.current || null,
        getUnits: () => this.unitList(),
        getCompletions: () => this.world?.recentCompletions(20) || [],
        dispatch: (unitId, goal) => this.dispatch(unitId, goal),
        setInterval: (unitId, seconds) => this.unitIntervals.set(unitId, Number(seconds) || 0),
        log: this.log,
        journal: this.journal,
        home: this.home,
        saveInfo: info,
        dshSessionId: info.sessionId,
        transcript,
        onStateChange: () => this.persistMain(),
      })
      main.setObjective(this.objective)
      this.main = main
      this.mainSave = info
      this.backend?.setMainSession?.({
        sessionId: info.sessionId,
        saveKey: info.key,
        saveFolder: info.folder,
        saveName: info.name,
      })
      this.journal?.append({
        kind: 'main.save.attach',
        text: `主会话挂载存档：${info.name || info.folder || info.key}`,
        meta: { saveKey: info.key, sessionId: info.sessionId, reason, folder: info.folder },
      })
      this.log('orchestrator.main.save', { saveKey: info.key, sessionId: info.sessionId, reason, folder: info.folder, transcript: transcript?.messages?.length || 0 })
      if (reason !== 'start') {
        this.chat?.outbound({
          text: `主会话已切换到存档：${info.name || info.folder || info.key}`,
          id: 'system',
          kind: 'save',
          meta: { saveKey: info.key, sessionId: info.sessionId },
        })
        this.scheduleMain('save-switch', 800)
      }
      return main
    } finally {
      this.switchingSave = false
    }
  }

  persistMain() {
    if (!this.main || !this.mainSave?.key) return null
    return this.mainStore.save(this.mainSave.key, this.main.exportState())
  }

  startSaveWatch() {
    if (this.saveTimer) return
    const seconds = Math.max(15, Number(this.config?.bridge?.watchSeconds ?? 15) * 2)
    this.saveTimer = setInterval(async () => {
      if (!this.running || this.switchingSave) return
      try {
        const state = await readSaveState({
          config: this.config,
          userDir: this.paths?.userDir || '',
          cacheDir: this.home,
          log: this.log,
        })
        const info = saveIdentity(state)
        if (info.key === this.mainSave?.key) return
        this.log('orchestrator.save.changed', { from: this.mainSave?.key || null, to: info.key, folder: info.folder })
        const world = await this.world?.refresh({ deep: true, includeSave: true })
        await this.switchMainSave(world?.save || state, { reason: 'save-watch' })
        if (world) {
          this.rebuildUnits(world)
          this.main?.setObjective(this.objective)
        }
      } catch (error) {
        this.log('orchestrator.save.watch.failed', { error: String(error?.message || error) })
      }
    }, seconds * 1000)
    this.saveTimer.unref?.()
    this.log('orchestrator.save.watch', { seconds })
  }

  stopSaveWatch() {
    if (this.saveTimer) clearInterval(this.saveTimer)
    this.saveTimer = null
  }

  async stop({ resume = true } = {}) {
    if (!this.running) return { ok: true, already: true }
    this.running = false
    if (this.mainTimer) clearTimeout(this.mainTimer)
    if (this.mainInterval) clearInterval(this.mainInterval)
    this.mainTimer = null
    this.mainInterval = null
    this.stopSaveWatch()
    this.persistMain()
    this.world?.stop()
    if (resume && this.executor?.pausedByUs) {
      try {
        await this.executor.resume('orchestrator-stop')
      } catch {
        /* ignore */
      }
    }
    this.executor?.stop()
    this.journal?.append({ kind: 'orchestrator.stop', text: '停止调度' })
    this.log('orchestrator.stop')
    return { ok: true }
  }

  async restart(options = {}) {
    await this.stop({ resume: false })
    return this.start(options)
  }

  // ---------------------------------------------------------------- 单位
  unitList() {
    return [...this.units.values()].map((session) => session.unit)
  }

  rebuildUnits(world) {
    const descriptors = discoverUnits(world, this.config?.units || {})
    const seen = new Set()
    for (const descriptor of descriptors) {
      seen.add(descriptor.id)
      const existing = this.units.get(descriptor.id)
      if (existing) {
        existing.unit = { ...existing.unit, ...descriptor }
        continue
      }
      const session = new UnitSession({
        unit: descriptor,
        backend: this.backendInfo?.ok ? this.backend : null,
        executor: this.executor,
        getWorld: () => this.world?.current || null,
        config: this.config,
        log: this.log,
        onReport: (report) => this.onUnitReport(report, session),
      })
      this.units.set(descriptor.id, session)
    }
    for (const id of [...this.units.keys()]) {
      if (!seen.has(id)) this.units.delete(id)
    }
    this.main?.setObjective(this.objective)
    this.log('orchestrator.units', { count: this.units.size })
  }

  /**
   * 派发一个单位子会话。
   * @returns {Promise<object>} 子会话报告
   */
  async dispatch(unitId, goal = '', { reason = 'main', force = false } = {}) {
    const session = this.units.get(unitId)
    if (!session) return { ok: false, status: 'error', unit: unitId, error: 'UNKNOWN_UNIT' }
    if (!this.backendInfo?.ok) return { ok: false, status: 'error', unit: unitId, error: 'AI_UNAVAILABLE', detail: this.backendInfo?.error }
    if (session.running) return { ok: false, status: 'busy', unit: unitId }
    const cooldown = Math.max(0, Number(this.unitIntervals.get(unitId) ?? this.config?.ai?.unit?.intervalSeconds ?? 45)) * 1000
    if (!force && cooldown > 0 && Date.now() - (session.lastRunAt || 0) < cooldown) {
      this.log('orchestrator.dispatch.cooldown', { unit: unitId, waitMs: cooldown - (Date.now() - session.lastRunAt) })
      return { ok: false, status: 'cooldown', unit: unitId }
    }
    this.stats.unitRuns += 1
    const startedAt = Date.now()
    try {
      return await session.run({ goal, reason })
    } catch (error) {
      this.stats.failures += 1
      const detail = String(error?.message || error)
      this.log('orchestrator.dispatch.failed', { unit: unitId, error: detail })
      const report = {
        unit: unitId,
        unitType: session.unit?.type || null,
        name: session.unit?.name || null,
        status: 'error',
        say: '子会话运行异常',
        cause: detail,
        suggestion: '',
        attempts: 0,
        actions: [],
        result: null,
        goal: goal || session.goal || '',
        at: Date.now(),
        ms: Date.now() - startedAt,
      }
      this.onUnitReport(report, session)
      return { ok: false, ...report, error: detail }
    }
  }

  onUnitReport(report, session = null) {
    this.journal?.append({
      kind: 'unit.report',
      unit: report.unit,
      text: report.say || report.cause || '',
      meta: { status: report.status, attempts: report.attempts, actions: report.actions, suggestion: report.suggestion },
    })
    this.main?.observeReport(report)
    if (report.status !== 'ok') {
      // 失败的子会话：把完整现场落盘（json + markdown），并让主会话/界面知道
      try {
        const exported = this.failures.record(report, { session, world: this.world?.current, source: report.source || 'unit' })
        if (exported) {
          report.exported = exported
          this.chat?.outbound({
            text: `[${report.unit}] 失败原因已导出：${exported.file}`,
            id: 'system',
            kind: 'failure-export',
            meta: { failureId: exported.id, markdown: exported.markdownFile },
          })
          this.log('orchestrator.failure.exported', { unit: report.unit, id: exported.id, file: exported.file })
        }
      } catch (error) {
        this.log('orchestrator.failure.export.failed', { unit: report.unit, error: String(error?.message || error) })
      }
      this.chat?.outbound({
        text: `[${report.unit}] ${report.say || '执行受阻'}${report.cause ? `｜原因：${report.cause}` : ''}${report.suggestion ? `｜建议：${report.suggestion}` : ''}`,
        id: 'unit',
        kind: 'report',
      })
    }
    this.scheduleMain(`report:${report.unit}`, 1500)
  }

  // ---------------------------------------------------------------- 主会话
  startMainLoop() {
    const seconds = Math.max(15, Number(this.config?.ai?.main?.intervalSeconds ?? 120))
    this.mainInterval = setInterval(() => {
      this.main?.tick({ reason: 'timer' }).then((result) => {
        if (result?.ok) this.stats.mainTicks += 1
      }).catch((error) => this.log('orchestrator.main.timer', { error: String(error?.message || error) }))
    }, seconds * 1000)
    this.mainInterval.unref?.()
  }

  scheduleMain(reason, delayMs = 1200) {
    if (!this.running || !this.main || !this.backendInfo?.ok) return
    if (this.mainTimer) return
    const since = Date.now() - this.lastScheduleAt
    const wait = Math.max(0, delayMs, 6000 - since)
    this.mainTimer = setTimeout(() => {
      this.mainTimer = null
      this.lastScheduleAt = Date.now()
      this.main
        .tick({ reason })
        .then((result) => {
          if (result?.ok) this.stats.mainTicks += 1
        })
        .catch((error) => this.log('orchestrator.main.tick', { error: String(error?.message || error) }))
    }, wait)
    this.mainTimer.unref?.()
  }

  // ---------------------------------------------------------------- 特殊事件
  handleTrigger(trigger) {
    if (!trigger?.type) return
    this.journal?.append({ kind: 'trigger', text: trigger.type, meta: { priority: trigger.priority, unit: trigger.unit } })
    if (trigger.type === 'event_window' || trigger.type.startsWith('alert:') || trigger.type === 'election_result') {
      this.enqueueEvent(trigger)
      return
    }
    if (trigger.type === 'diplomacy_proposal') {
      this.main?.observe(`外交请求：${JSON.stringify(trigger.payload).slice(0, 800)}`)
      this.dispatch('diplomacy', '处理刚收到的外交提议：看清对方、条件、后果，再决定接受/拒绝/拖延。', { reason: 'diplomacy-proposal' }).catch(() => {})
      this.scheduleMain('diplomacy', 1000)
      return
    }
    this.main?.observe(`${trigger.type}：${JSON.stringify(trigger.payload ?? {}).slice(0, 600)}`)
    this.scheduleMain(trigger.type, 2000)
  }

  enqueueEvent(trigger) {
    if (this.eventQueue.length >= 30) this.eventQueue.shift()
    this.eventQueue.push(trigger)
    this.drainEvents().catch((error) => this.log('orchestrator.events.drain', { error: String(error?.message || error) }))
  }

  async drainEvents() {
    if (this.eventRunning || !this.running) return
    this.eventRunning = true
    try {
      while (this.eventQueue.length && this.running) {
        const trigger = this.eventQueue.shift()
        await this.runEventSession(trigger)
      }
    } finally {
      this.eventRunning = false
    }
  }

  async runEventSession(trigger) {
    if (!this.backendInfo?.ok) {
      this.main?.observe(`特殊事件（AI 不可用，仅记录）：${JSON.stringify(trigger.payload).slice(0, 800)}`)
      return null
    }
    const payload = trigger.payload || {}
    const windowId = payload.window_id ?? payload.windowId ?? null
    const eventId = payload.event_id ?? payload.id ?? null
    const unitId = `event:${windowId ?? eventId ?? Date.now()}`
    if (this.eventSessions.has(unitId)) return null
    const unit = {
      id: unitId,
      type: 'event',
      unitId,
      windowId,
      eventId,
      name: payload.title || payload.title_key || `事件 ${windowId ?? eventId ?? ''}`,
      event: payload,
      triggerType: trigger.type,
    }
    const session = new EventSession({
      unit,
      backend: this.backend,
      executor: this.executor,
      getWorld: () => this.world?.current || null,
      config: this.config,
      log: this.log,
      onReport: (report) => this.onUnitReport(report, session),
    })
    this.eventSessions.set(unitId, session)
    this.stats.eventRuns += 1
    let pausedForEvent = false
    try {
      // 特殊事件优先：必要时暂停游戏，处理完再交回主会话
      if (String(trigger.type) === 'event_window' && this.config?.executor?.autoPause !== false && !this.executor.pausedByUs) {
        const paused = await this.executor.pause('event-window').catch(() => ({ ok: false }))
        pausedForEvent = Boolean(paused?.ok)
      }
      const goal = this.eventGoal(trigger, unit)
      this.chat?.outbound({ text: `处理特殊事件：${unit.name}`, id: 'system', kind: 'event' })
      const report = await session.run({ goal, reason: `trigger:${trigger.type}` })
      if (pausedForEvent && this.config?.executor?.autoResume !== false) {
        await this.executor.resume('event-done').catch(() => {})
      }
      return report
    } catch (error) {
      if (pausedForEvent && this.config?.executor?.autoResume !== false) {
        await this.executor.resume('event-failed').catch(() => {})
      }
      this.stats.failures += 1
      const detail = String(error?.message || error)
      this.log('orchestrator.event.failed', { unit: unitId, error: detail })
      const report = {
        unit: unitId,
        unitType: 'event',
        name: unit.name,
        status: 'error',
        say: '特殊事件处理异常',
        cause: detail,
        suggestion: '',
        attempts: 0,
        actions: [],
        result: null,
        goal: unit.event?.goal || '',
        at: Date.now(),
        ms: 0,
      }
      this.onUnitReport(report, session)
      return report
    } finally {
      this.recentEvents.push({ id: unitId, at: Date.now(), summary: session.summary(), snapshot: session.snapshot({ maxMessages: 120, maxChars: 10000 }) })
      if (this.recentEvents.length > 12) this.recentEvents.shift()
      this.eventSessions.delete(unitId)
    }
  }

  eventGoal(trigger, unit) {
    const world = this.world?.current
    const chain = world
      ? resolveActiveChains(this.eventGraph, [trigger.payload], { depth: Number(this.config?.read?.eventChainDepth ?? 6), max: 4 })
      : null
    const lines = [
      `特殊事件：${unit.name}`,
      `触发类型：${trigger.type}${trigger.startup ? '（启动时已存在）' : ''}`,
      `事件窗口/警报内容：${JSON.stringify(trigger.payload).slice(0, 3000)}`,
    ]
    const active = chain?.active?.[0]
    if (active?.chain?.nodes?.length) {
      lines.push(
        '事件链后续（来自本地事件定义，含模组）：',
        active.chain.nodes
          .slice(0, 12)
          .map((node) => `- L${node.level} ${node.id}${node.title ? `「${node.title}」` : ''}${node.hidden ? '（隐藏）' : ''}`)
          .join('\n'),
      )
    }
    if (trigger.type === 'election_result') {
      lines.push('这是总统/领袖换届：评估新领袖特质、议程是否要调整、内阁是否需要换人。')
    }
    lines.push('如果确实不需要动作，用 status="ok" + cause 说明理由；不要为了"做点什么"而乱发动作。')
    return lines.join('\n')
  }

  // ---------------------------------------------------------------- 对外
  /** 会话列表：主会话 + 每个 1:1 单位 + 正在处理/最近处理过的特殊事件。 */
  sessions() {
    const rows = []
    if (this.main) rows.push(this.main.summary())
    for (const session of this.units.values()) rows.push(session.summary())
    for (const session of this.eventSessions.values()) rows.push(session.summary())
    for (const recent of this.recentEvents) rows.push({ ...recent.summary, active: false, endedAt: recent.at })
    // 主会话置顶，其余按更新时间倒序
    const main = rows.filter((row) => row.kind === 'main')
    const rest = rows
      .filter((row) => row.kind !== 'main')
      .sort((a, b) => (b.running ? 1 : 0) - (a.running ? 1 : 0) || (b.updatedAt || 0) - (a.updatedAt || 0))
    return [...main, ...rest]
  }

  /** 会话详情（含系统提示与完整对话）。 */
  sessionDetail(id, options = {}) {
    const key = String(id || '')
    if (key === 'main') return this.main ? this.main.snapshot({ maxMessages: 120, maxChars: 12000, ...options }) : null
    const live = this.units.get(key) || this.eventSessions.get(key)
    if (live) return live.snapshot({ maxMessages: 120, maxChars: 12000, ...options })
    const recent = this.recentEvents.find((row) => row.id === key)
    return recent ? { ...recent.snapshot, active: false, endedAt: recent.at } : null
  }

  async refreshWorld({ deep = true, includeSave = deep } = {}) {
    if (!this.world) return null
    const world = await this.world.refresh({ deep, includeSave })
    if (world) {
      const info = saveIdentity(world.save)
      if (this.mainSave?.key && info.key !== this.mainSave.key) {
        await this.switchMainSave(world.save, { reason: 'refresh' })
      }
      this.rebuildUnits(world)
      this.main?.setObjective(this.objective)
    }
    return world
  }

  /** 直接执行一组动作（API/CLI 用），仍走执行器。 */
  async execute(actions, { unit = 'manual', source = 'api' } = {}) {
    const validated = validateActions(actions)
    if (!validated.ok) return { ok: false, error: 'VALIDATION', errors: validated.errors, actions: [] }
    return this.executor.submit({
      unit,
      source,
      actions: validated.actions.map((action) => ({ method: action.method, params: action.params })),
    })
  }

  async pause() {
    return this.executor.pause('api')
  }

  async resume() {
    return this.executor.resume('api')
  }

  setObjective(objective) {
    this.objective = String(objective || '')
    this.main?.setObjective(this.objective)
    this.journal?.append({ kind: 'objective', text: this.objective })
    return { ok: true, objective: this.objective }
  }

  status() {
    return {
      running: this.running,
      startedAt: this.startedAt || null,
      uptimeMs: this.startedAt ? Date.now() - this.startedAt : 0,
      objective: this.objective,
      paths: this.paths,
      bridge: {
        connected: Boolean(this.bridge?.connected),
        injected: this.bridgeInjected,
        pipe: this.bridge?.pipeName || this.config?.bridge?.pipeName || null,
        stats: this.bridge?.stats || null,
      },
      backend: {
        ...(this.backend?.describe?.() || { backend: this.config?.ai?.backend }),
        ok: Boolean(this.backendInfo?.ok),
        error: this.backendInfo?.error || null,
        hint: this.backendInfo?.hint || null,
      },
      world: this.world?.status() || null,
      executor: this.executor?.status() || null,
      main: this.main?.status() || null,
      mainSave: this.mainSave,
      mainSessionId: this.mainSave?.sessionId || null,
      chat: this.chat?.status() || null,
      units: [...this.units.values()].map((session) => session.status()),
      events: {
        graph: this.eventGraph?.status() || null,
        active: this.world?.current?.eventChains?.active?.length ?? 0,
        queued: this.eventQueue.length,
        running: this.eventSessions.size,
      },
      mods: modsDigest(this.mods) || null,
      save: this.world?.current?.save
        ? {
            dir: this.world.current.save.dir || null,
            latest: this.world.current.save.latest?.name || null,
            date: this.world.current.save.meta?.date || null,
            version: this.world.current.save.meta?.version || null,
            ironman: Boolean(this.world.current.save.meta?.ironman),
          }
        : null,
      stats: this.stats,
      failures: {
        dir: this.failures.dir,
        last: this.failures.list({ limit: 1 })[0] || null,
      },
      lastError: this.lastError,
    }
  }

  /** 给 `brief` / 诊断用的紧凑视图。 */
  brief() {
    const world = this.world?.current
    if (!world) return '还没有读取到游戏状态。'
    const lines = [
      `日期：${world.date || '未知'}｜暂停：${world.paused ? '是' : '否'}｜速度：${world.speed ?? '?'}`,
      `殖民地：${world.colonies.length}｜舰队：${world.fleetsAll.length}｜事件：${world.activeEvents.length}｜警报：${world.alerts.length}`,
      `模组：${world.mods?.enabled ?? 0}/${world.mods?.total ?? 0} 启用｜事件索引：${world.eventChains?.index?.events ?? '?'} 个定义`,
      `读取：${world.readMs}ms，调用 ${world.stats?.calls ?? '?'} 次，失败 ${world.errors?.length ?? 0} 次`,
    ]
    if (world.errors?.length) {
      lines.push(`读取失败：${world.errors.slice(0, 5).map((row) => `${row.method}(${row.code})`).join('、')}`)
    }
    if (world.unsupported?.length) lines.push(`当前 DLL 不支持：${world.unsupported.join('、')}`)
    return lines.join('\n')
  }
}
