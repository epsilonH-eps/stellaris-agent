/**
 * 主会话：积极收集信息 → 推理 → 决策 → 派发。
 *
 * 它**不直接操作游戏**（除了暂停/恢复），所有执行都交给 1:1 子会话；
 * 它拿到的是压缩后的全局摘要、最近完成事件、子会话上报、玩家聊天，
 * 输出的是"要谁去做什么"以及"对玩家说什么"。
 *
 * 触发方式：
 *  - 定时（`ai.main.intervalSeconds`）；
 *  - 玩家在聊天里说话；
 *  - 子会话上报（成功/失败/需要决策）；
 *  - 特殊事件（事件弹窗/选举/外交请求/war）。
 *
 * @module stellaris-agent/ai/main
 */
import { worldDigest, clip } from '../context.mjs'
import { actionsForUnit } from '../actions.mjs'
import { agentHome } from '../config.mjs'
import { normalizePersona, personaSummary, personaPrompt as buildPersonaPrompt } from '../persona.mjs'
import { VoiceLog } from '../voice.mjs'
import { AISession } from './session.mjs'
import { mainSystemPrompt } from './prompts.mjs'
import { parseMainDecision } from './protocol.mjs'

export class MainSession {
  /**
   * @param {object} options
   * @param {object} options.backend
   * @param {object} options.config
   * @param {import('../executor.mjs').Executor} options.executor
   * @param {import('../chat.mjs').ChatHub} options.chat
   * @param {() => object|null} options.getWorld
   * @param {() => Array<object>} options.getUnits
   * @param {() => Array<object>} options.getCompletions
   * @param {(unit:string, goal:string) => Promise<object>} options.dispatch
   * @param {(unit:string, seconds:number) => void} [options.setInterval]
   * @param {Function} [options.log]
   * @param {object} [options.journal]
   */
  constructor({
    backend,
    config,
    executor,
    chat,
    getWorld,
    getUnits,
    getCompletions,
    dispatch,
    setInterval = () => {},
    log = () => {},
    journal = null,
    home = null,
    saveInfo = null,
    dshSessionId = null,
    transcript = null,
    onStateChange = () => {},
  }) {
    this.backend = backend
    this.config = config
    this.executor = executor
    this.chat = chat
    this.home = home || agentHome()
    this.saveInfo = saveInfo || null
    this.dshSessionId = dshSessionId || saveInfo?.sessionId || null
    this.onStateChange = onStateChange
    this.persona = normalizePersona(config?.persona)
    this.voices = new VoiceLog({ home: this.home, log })
    this.lastVoice = null
    this.lastVoiceAt = 0
    this.getWorld = getWorld
    this.getUnits = getUnits
    this.getCompletions = getCompletions
    this.dispatch = dispatch
    this.setInterval = setInterval
    this.log = log
    this.journal = journal
    this.session = new AISession({
      backend,
      system: '',
      maxMessages: Math.max(6, Number(config?.ai?.main?.historyMessages ?? 24)),
      label: 'main',
      log,
    })
    this.reports = []
    this.observations = []
    this.lastDecision = null
    this.lastTickAt = 0
    this.lastError = null
    this.ticking = false
    this.turns = 0
    if (Array.isArray(transcript?.messages) && transcript.messages.length) {
      this.session.messages = transcript.messages
        .filter((row) => row && (row.role === 'user' || row.role === 'assistant') && row.content)
        .slice(-Math.max(6, Number(config?.ai?.main?.historyMessages ?? 24)))
        .map((row) => ({ role: row.role, content: String(row.content), ts: Number(row.ts) || Date.now() }))
      this.session.turns = Number(transcript.turns) || this.session.messages.filter((row) => row.role === 'user').length
      this.session.lastAt = Number(transcript.updatedAt) || Date.now()
      this.turns = this.session.turns
      this.log('main.transcript.loaded', { saveKey: this.saveInfo?.key || null, messages: this.session.messages.length })
    }
    this.setObjective(config?.objective || '')
  }

  /** 导出给「每存档一个主会话」的持久化用。 */
  exportState() {
    return {
      save: this.saveInfo,
      saveKey: this.saveInfo?.key || 'unknown',
      dshSessionId: this.dshSessionId,
      objective: this.objective,
      turns: this.session.turns,
      messages: this.session.messages.slice(-80).map((row) => ({ role: row.role, content: row.content, ts: row.ts })),
      lastDecision: this.lastDecision
        ? { say: this.lastDecision.say, spawned: this.lastDecision.spawn?.map((row) => row.unit) || [], at: this.lastDecision.at }
        : null,
      updatedAt: Date.now(),
    }
  }

  _changed() {
    try {
      this.onStateChange(this)
    } catch (error) {
      this.log('main.state.persist.failed', { error: String(error?.message || error) })
    }
  }

  setObjective(objective) {
    this.objective = String(objective || '')
    this.session.system = mainSystemPrompt({
      config: { ...this.config, objective: this.objective, persona: this.persona },
      units: this.getUnits(),
    })
  }

  /** 设置页/接口修改人格后，立即重建 system prompt（不用重启调度）。 */
  applyPersona(persona) {
    this.persona = normalizePersona(persona, this.persona)
    this.setObjective(this.objective)
    this.log('main.persona.applied', { name: this.persona.name, preset: this.persona.preset, components: this.persona.components.length })
    return personaSummary(this.persona)
  }

  /** 主会话 system prompt 里的人格段（设置页预览用）。 */
  personaPrompt() {
    return buildPersonaPrompt(this.persona)
  }

  /** 子会话的上报进入下一轮上下文。 */
  observeReport(report) {
    if (!report) return
    this.reports.push(report)
    if (this.reports.length > 60) this.reports = this.reports.slice(-60)
    this.log('main.report.received', { unit: report.unit, status: report.status })
  }

  /** 世界触发器/执行器事件等旁路信息。 */
  observe(text, meta = null) {
    if (!text) return
    this.observations.push({ text: String(text).slice(0, 2000), meta, at: Date.now() })
    if (this.observations.length > 80) this.observations = this.observations.slice(-80)
  }

  status() {
    return {
      lastTickAt: this.lastTickAt || null,
      ticking: this.ticking,
      turns: this.turns,
      objective: this.objective,
      lastError: this.lastError,
      lastDecision: this.lastDecision
        ? {
            say: this.lastDecision.say,
            spawned: this.lastDecision.spawn.map((row) => row.unit),
            pause: this.lastDecision.pause,
            resume: this.lastDecision.resume,
            at: this.lastDecision.at,
          }
        : null,
      pendingReports: this.reports.length,
      pendingObservations: this.observations.length,
      usage: this.session.lastUsage,
      persona: {
        name: this.persona.name,
        title: this.persona.title,
        preset: this.persona.preset,
        traits: this.persona.traits,
        voice: this.persona.voice,
        components: this.persona.components.length,
      },
      lastVoice: this.lastVoice,
      voiceCount: this.voices.rows.length,
    }
  }

  /** 会话列表用的摘要。 */
  summary() {
    return {
      id: 'main',
      kind: 'main',
      type: 'main',
      label: this.saveInfo?.name || '主会话',
      name: this.persona.name,
      running: this.ticking,
      status: this.lastError ? 'error' : this.lastDecision ? 'ok' : 'idle',
      turns: this.session.turns,
      messageCount: this.session.messages.length,
      updatedAt: this.session.lastAt || this.lastTickAt || null,
      createdAt: this.session.createdAt,
      usage: this.session.lastUsage,
      lastError: this.lastError,
      say: this.lastDecision?.say || '',
      pendingReports: this.reports.length,
      save: this.saveInfo,
      dshSessionId: this.dshSessionId,
    }
  }

  /** 会话详情（界面用）。 */
  snapshot(options = {}) {
    const base = this.session.snapshot(options)
    return {
      ...base,
      ...this.summary(),
      system: base.system,
      objective: this.objective,
      lastDecision: this.lastDecision
        ? {
            say: this.lastDecision.say,
            report: this.lastDecision.report,
            spawn: this.lastDecision.spawn,
            pause: this.lastDecision.pause,
            resume: this.lastDecision.resume,
            applied: this.lastDecision.applied,
            at: this.lastDecision.at,
          }
        : null,
      pendingObservations: this.observations.map((row) => row.text).slice(-20),
    }
  }

  _buildPrompt({ reason }) {
    const world = this.getWorld()
    const human = this.chat ? this.chat.takePending() : []
    const units = this.getUnits()
    const reports = this.reports.splice(0, this.reports.length)
    const observations = this.observations.splice(0, this.observations.length)
    const digest = worldDigest(world, {
      completions: this.getCompletions(),
      maxEvents: 8,
      maxAlerts: 8,
    })
    return {
      human,
      units,
      payload: {
        reason,
        now: new Date().toISOString(),
        objective: this.objective || null,
        human: human.map((row) => ({ id: row.id, text: row.text, at: row.ts })),
        unitReports: reports.map((report) => ({
          unit: report.unit,
          status: report.status,
          say: report.say,
          cause: report.cause,
          suggestion: report.suggestion,
          attempts: report.attempts,
          actions: report.actions,
          error: report.result?.error || null,
        })),
        observations: observations.map((row) => row.text),
        executor: this.executor.status(),
        units: units.map((unit) => ({ id: unit.id, type: unit.type, name: unit.name })),
        world: clip(digest, 24000),
      },
    }
  }

  /**
   * 跑一轮决策。
   * @param {{reason?:string}} [options]
   */
  async _bridgeTurn({ reason = 'timer', human = [] } = {}) {
    if (this.ticking) return { ok: false, error: 'BUSY', reason }
    this.ticking = true
    const startedAt = Date.now()
    try {
      this.log('main.bridge.start', { reason })
      const world = this.getWorld()
      if (!world) return { ok: false, error: 'NO_WORLD', reason }
      const units = this.getUnits().map((unit) => ({
        id: unit.id,
        type: unit.type,
        name: unit.name,
        goal: unit.goal || null,
        actions: actionsForUnit(unit.type),
      }))
      this.log('main.bridge.units', { count: units.length })
      const payload = {
        saveKey: this.saveInfo?.key || null,
        sessionId: this.saveInfo?.sessionId || this.dshSessionId || null,
        polityName: this.saveInfo?.name || '群星参谋',
        workspace: this.saveInfo?.workspace || null,
        persona: buildPersonaPrompt(this.persona),
        reason,
        human,
        units,
        world: worldDigest(world, { completions: this.getCompletions(), maxEvents: 8, maxAlerts: 8 }),
        timeoutMs: this.config?.ai?.dsh?.timeoutMs || 600000,
        reasoningEffort: this.config?.ai?.main?.reasoningEffort || 'high',
      }
      this.log('main.bridge.payload', { units: units.length, human: human.length })
      const result = await this.backend.bridgeTurn(payload)
      this.log('main.bridge.received', { ok: result?.ok, actions: result?.actions?.length || 0 })
      let executed = null
      if (Array.isArray(result.actions) && result.actions.length) {
        executed = await this.executor.submit({ unit: 'main', source: 'dsh-bridge', actions: result.actions, meta: { reason } })
      }
      const say = result.say || ''
      if (say) this.chat?.outbound({ text: say, id: 'main', kind: 'say' })
      if (result.audience) this.chat?.outbound({ text: result.audience, id: 'audience', kind: 'audience' })
      for (const row of result.dialogue || []) {
        if (row?.text) this.chat?.outbound({ text: row.text, id: String(row.id || 'human'), kind: 'dialogue' })
      }
      const voice = this._emitVoice({ say, voice: result.voice || '', mood: '' }, { reason })
      const text = JSON.stringify({
        say,
        audience: result.audience || '',
        dialogue: result.dialogue || [],
        actions: result.actions || [],
        dispatches: result.dispatches || [],
      })
      this.session.pushAssistant(text)
      this.turns += 1
      this.lastTickAt = Date.now()
      this.lastError = null
      this.lastDecision = { ...result, at: Date.now(), applied: executed }
      this.journal?.append({ kind: 'main.bridge', text: say || result.audience || '(bridge)', meta: { reason, actions: result.actions?.length || 0, dispatched: result.dispatches?.length || 0 } })
      this.log('main.bridge.tick', { reason, actions: result.actions?.length || 0, spawned: result.dispatches?.length || 0, ms: Date.now() - startedAt })
      this._changed()
      return { ok: true, reason, say, voice, audience: result.audience || '', spawned: (result.dispatches || []).map((row) => row.target), executed }
    } catch (error) {
      this.lastError = String(error?.message || error)
      this.log('main.bridge.failed', { error: this.lastError })
      return { ok: false, error: 'BRIDGE_FAILED', detail: this.lastError, reason }
    } finally {
      this.ticking = false
    }
  }

  async tick({ reason = 'timer' } = {}) {
    if (this.ticking) return { ok: false, error: 'BUSY', reason }
    if (!this.backend) return { ok: false, error: 'NO_BACKEND', reason }
    const world = this.getWorld()
    if (!world) return { ok: false, error: 'NO_WORLD', reason }
    if (typeof this.backend.bridgeTurn === 'function') return this._bridgeTurn({ reason })
    this.ticking = true
    const startedAt = Date.now()
    try {
      if (!this.session.system) this.setObjective(this.objective)
      const { payload } = this._buildPrompt({ reason })
      this.session.pushUser(`回合输入：\n${JSON.stringify(payload)}`)
      const reply = await this.session.ask({ maxTokens: this.config?.ai?.deepseek?.maxTokens })
      const parsed = parseMainDecision(reply.text)
      if (!parsed.ok) {
        this.lastError = parsed.error
        this.session.pushObservation(`你的回复解析失败：${parsed.error}。请只输出一个 json 代码块，字段见系统提示。`)
        this.log('main.parse.failed', { error: parsed.error })
        return { ok: false, error: 'PARSE_FAILED', detail: parsed.error, reason }
      }
      const decision = parsed.value
      const applied = await this._apply(decision)
      const voice = this._emitVoice(decision, { reason })
      this.lastDecision = { ...decision, at: Date.now(), applied }
      this.lastTickAt = Date.now()
      this.lastError = null
      this.turns += 1
      this.journal?.append({
        kind: 'main.decision',
        text: decision.say || decision.report || '(no say)',
        meta: { reason, spawned: applied.spawned, pause: decision.pause, resume: decision.resume, voice: voice?.id || null, ms: Date.now() - startedAt },
      })
      this.log('main.tick', { reason, spawned: applied.spawned.length, say: Boolean(decision.say), voice: Boolean(voice), ms: Date.now() - startedAt })
      this._changed()
      return { ok: true, reason, say: decision.say, voice, spawned: applied.spawned, paused: applied.paused, resumed: applied.resumed }
    } catch (error) {
      this.lastError = String(error?.message || error)
      this.log('main.tick.failed', { error: this.lastError })
      return { ok: false, error: 'TICK_FAILED', detail: this.lastError, reason }
    } finally {
      this.ticking = false
    }
  }

  /**
   * 直接和主会话智能体对话：同步返回它这一轮说的话（以及暂停/派发结果）。
   * 与定时 tick 共用 `ticking` 锁，避免两个模型调用互相覆盖上下文。
   * @param {{id?:string, text:string, timeoutMs?:number}} input
   */
  async ask({ id = 'human', text, timeoutMs = 120000 } = {}) {
    const message = String(text || '').trim()
    if (!message) return { ok: false, error: 'EMPTY_TEXT' }
    if (!this.backend) return { ok: false, error: 'NO_BACKEND' }
    const world = this.getWorld()
    if (!world) return { ok: false, error: 'NO_WORLD' }
    if (typeof this.backend.bridgeTurn === 'function') {
      return this._bridgeTurn({ reason: 'human-ask', human: [{ id: String(id || 'human'), text: message }] })
    }

    // 正在跑定时决策时等它结束（最多 30 秒），避免并发写同一段会话
    const deadline = Date.now() + 30000
    while (this.ticking && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 150))
    if (this.ticking) return { ok: false, error: 'BUSY' }

    this.ticking = true
    const startedAt = Date.now()
    try {
      if (!this.session.system) this.setObjective(this.objective)
      const units = this.getUnits()
      const digest = worldDigest(world, { completions: this.getCompletions(), maxEvents: 8, maxAlerts: 8 })
      const payload = {
        reason: 'human-ask',
        speaker: { id: String(id || 'human'), text: message, at: Date.now() },
        instruction: '玩家正在直接和你对话：先用 say 直接回答；需要行动时再 spawn 对应单位。',
        objective: this.objective || null,
        units: units.map((unit) => ({ id: unit.id, type: unit.type, name: unit.name })),
        executor: this.executor.status(),
        world: clip(digest, 20000),
      }
      this.session.pushUser(`直接对话：\n${JSON.stringify(payload)}`)
      const reply = await this.session.ask({ maxTokens: this.config?.ai?.deepseek?.maxTokens, timeoutMs })
      const parsed = parseMainDecision(reply.text)
      if (!parsed.ok) {
        this.lastError = parsed.error
        this.session.pushObservation(`你的回复解析失败：${parsed.error}。请只输出一个 json 代码块，字段见系统提示。`)
        this.log('main.ask.parse.failed', { error: parsed.error })
        return { ok: false, error: 'PARSE_FAILED', detail: parsed.error, raw: String(reply.text || '').slice(0, 2000) }
      }
      const decision = parsed.value
      const applied = await this._apply(decision)
      const voice = this._emitVoice(decision, { reason: 'human-ask', force: true })
      this.lastDecision = { ...decision, at: Date.now(), applied }
      this.lastTickAt = Date.now()
      this.lastError = null
      this.turns += 1
      this.journal?.append({
        kind: 'main.ask',
        text: decision.say || '(no say)',
        meta: { id, spawned: applied.spawned, pause: decision.pause, resume: decision.resume, voice: voice?.id || null, ms: Date.now() - startedAt },
      })
      this.log('main.ask', { id, say: Boolean(decision.say), spawned: applied.spawned.length, voice: Boolean(voice), ms: Date.now() - startedAt })
      this._changed()
      return {
        ok: true,
        id,
        text: message,
        say: decision.say,
        voice,
        report: decision.report,
        spawned: applied.spawned,
        skipped: applied.skipped,
        paused: applied.paused,
        resumed: applied.resumed,
        ms: Date.now() - startedAt,
      }
    } catch (error) {
      this.lastError = String(error?.message || error)
      this.log('main.ask.failed', { error: this.lastError })
      return { ok: false, error: 'ASK_FAILED', detail: this.lastError }
    } finally {
      this.ticking = false
    }
  }

  /** 每轮（或按频率）说一句"人话"，写进 VoiceLog + 聊天出站 + 回调。 */
  _emitVoice(decision, { reason = 'tick', force = false } = {}) {
    const setting = this.persona.voice || {}
    if (setting.enabled === false) return null
    const explicit = String(decision.voice || '').trim()
    const raw = explicit || String(decision.say || '').trim()
    if (!raw) return null
    const every = Math.max(1, Number(setting.everyTurns) || 1)
    const minMs = Math.max(0, Number(setting.minIntervalSeconds) || 0) * 1000
    const turn = this.turns + 1
    if (!force) {
      if (every > 1 && turn % every !== 0) return null
      if (minMs && Date.now() - this.lastVoiceAt < minMs) return null
    }
    const maxChars = Math.max(20, Number(this.persona.speech?.maxChars) || 120)
    const text = raw.length > maxChars ? `${raw.slice(0, maxChars - 1)}…` : raw
    const entry = this.voices.push({
      text,
      mood: decision.mood,
      intent: decision.intent,
      turn,
      reason,
      actions: (decision.spawn || []).map((row) => row.unit),
    })
    if (!entry) return null
    this.lastVoice = entry
    this.lastVoiceAt = Date.now()
    // 没有独立 voice、退回 say 时，聊天里已经发过 say，不再重复发一条
    if (explicit) {
      this.chat?.outbound({ text, id: 'main', kind: 'voice', meta: { voiceId: entry.id, mood: entry.mood, intent: entry.intent } })
    }
    try {
      this.onVoice?.(entry)
    } catch {
      /* 外部订阅失败不影响主循环 */
    }
    this.log('main.voice', { id: entry.id, chars: text.length, reason })
    return entry
  }

  async _apply(decision) {
    const applied = { spawned: [], skipped: [], paused: false, resumed: false }
    if (decision.say) {
      this.chat?.outbound({ text: decision.say, id: 'main', kind: 'say', meta: { reason: 'main.decision' } })
    }
    if (decision.pause) {
      const result = await this.executor.pause('main-session')
      applied.paused = Boolean(result.ok)
    }
    if (decision.resume) {
      const result = await this.executor.resume('main-session')
      applied.resumed = Boolean(result.ok)
    }
    const known = new Set(this.getUnits().map((unit) => unit.id))
    const cap = Math.max(1, Number(this.config?.ai?.main?.maxActionsPerTurn ?? 8))
    const seen = new Set()
    for (const row of decision.spawn) {
      if (applied.spawned.length >= cap) break
      if (!known.has(row.unit)) {
        applied.skipped.push({ unit: row.unit, reason: 'UNKNOWN_UNIT' })
        continue
      }
      if (seen.has(row.unit)) continue
      seen.add(row.unit)
      try {
        this.dispatch(row.unit, row.goal).catch((error) => {
          this.log('main.dispatch.failed', { unit: row.unit, error: String(error?.message || error) })
          this.observe(`派发 ${row.unit} 失败：${error?.message || error}`)
        })
        applied.spawned.push(row.unit)
      } catch (error) {
        applied.skipped.push({ unit: row.unit, reason: String(error?.message || error) })
      }
    }
    for (const [unit, seconds] of Object.entries(decision.intervals || {})) {
      if (known.has(unit)) this.setInterval(unit, seconds)
    }
    return applied
  }
}
