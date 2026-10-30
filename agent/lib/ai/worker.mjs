/**
 * 单位子会话（1:1）与特殊事件子会话。
 *
 * 一次 `run()` 的生命周期：
 *   1. 用当前世界 + 目标拼上下文；
 *   2. 模型给出 `{say, actions, status, cause, suggestion}`；
 *   3. `validateActions` 按该单位的动作白名单/参数表校验，**不合法的直接打回**；
 *   4. 合法动作交给执行器（串行、读回验证、单动作最多 Y 次）；
 *   5. 执行结果原样回给模型：成功收尾；失败换参数重试；
 *   6. 重试 `attempts`(Y) 次仍失败 → 额外问一次"失败分析"，把
 *      `cause/evidence/suggestion` 一起上报主会话。
 *
 * @module stellaris-agent/ai/worker
 */
import { validateActions } from '../actions.mjs'
import { unitContext } from '../context.mjs'
import { AISession } from './session.mjs'
import { failureAnalysisPrompt, unitSystemPrompt, eventSystemPrompt } from './prompts.mjs'
import { parseAnalysis, parseUnitDecision } from './protocol.mjs'

function clip(value, max = 12000) {
  try {
    const text = JSON.stringify(value)
    if (text.length <= max) return value
    return { truncated: true, chars: text.length, preview: text.slice(0, max) }
  } catch {
    return null
  }
}

function feedbackText(result) {
  if (!result) return '执行器没有返回结果。'
  const lines = [`执行器结果：${result.ok ? '成功' : '失败'}（${result.summary || ''}）`]
  for (const row of result.actions || []) {
    if (row.status === 'ok') {
      const verify = row.verify ? ` 读回：${row.verify.detail}${row.verify.soft && !row.verify.ok ? '（soft 未通过）' : ''}` : ''
      lines.push(`- #${row.index + 1} ${row.method} 成功${verify}`)
    } else if (row.status === 'failed') {
      lines.push(`- #${row.index + 1} ${row.method} 失败：${row.error || '未知错误'}（尝试 ${row.attempts?.length || 1} 次）`)
      for (const attempt of (row.attempts || []).slice(-2)) {
        if (attempt.error) lines.push(`    · 第 ${attempt.attempt} 次错误：${attempt.error}${attempt.code ? ` [${attempt.code}]` : ''}`)
        if (attempt.verify && !attempt.verify.ok) lines.push(`    · 第 ${attempt.attempt} 次读回：${attempt.verify.detail}`)
      }
    } else if (row.status === 'skipped') {
      lines.push(`- #${row.index + 1} ${row.method} 未执行（前一步失败后中止）`)
    }
  }
  lines.push('请判断：换参数重试、换动作，还是上报主会话？')
  return lines.join('\n')
}

export class UnitSession {
  /**
   * @param {object} options
   * @param {{id:string,type:string,key?:number,name?:string,windowId?:number,eventId?:string}} options.unit
   * @param {object} options.backend
   * @param {import('../executor.mjs').Executor} options.executor
   * @param {() => object|null} options.getWorld
   * @param {object} options.config
   * @param {Function} [options.log]
   * @param {(report:object) => void} [options.onReport]
   */
  constructor({ unit, backend, executor, getWorld, config, log = () => {}, onReport = () => {} }) {
    this.unit = unit
    this.backend = backend
    this.executor = executor
    this.getWorld = getWorld
    this.config = config
    this.log = log
    this.onReport = onReport
    this.isEvent = unit.type === 'event'
    const settings = this.isEvent ? config?.ai?.event : config?.ai?.unit
    this.attempts = Math.max(1, Number(settings?.attempts ?? config?.executor?.maxAttempts ?? 3))
    this.maxActions = Math.max(1, Number(settings?.maxActionsPerTurn ?? (this.isEvent ? 3 : 4)))
    this.session = new AISession({
      backend,
      system: this.isEvent ? eventSystemPrompt({ config }) : unitSystemPrompt({ unit, config }),
      maxMessages: Math.max(6, Number(settings?.historyMessages ?? 18)),
      label: `unit:${unit.id}`,
      log,
    })
    this.lastRunAt = 0
    this.lastReport = null
    this.running = false
    this.goal = ''
  }

  get id() {
    return this.unit.id
  }

  status() {
    return {
      id: this.unit.id,
      type: this.unit.type,
      name: this.unit.name,
      running: this.running,
      goal: this.goal,
      lastRunAt: this.lastRunAt || null,
      lastReport: this.lastReport
        ? { status: this.lastReport.status, say: this.lastReport.say, at: this.lastReport.at, attempts: this.lastReport.attempts }
        : null,
    }
  }

  /** 会话列表用的摘要。 */
  summary() {
    const kind = this.isEvent ? 'event' : 'unit'
    return {
      id: this.unit.id,
      kind,
      type: this.unit.type,
      label: this.isEvent ? `特殊事件 · ${this.unit.name || this.unit.id}` : `${this.unit.type} · ${this.unit.name || this.unit.id}`,
      name: this.unit.name || null,
      running: this.running,
      status: this.lastReport?.status || (this.lastRunAt ? 'idle' : 'new'),
      turns: this.session.turns,
      messageCount: this.session.messages.length,
      updatedAt: this.session.lastAt || this.lastRunAt || null,
      createdAt: this.session.createdAt,
      usage: this.session.lastUsage,
      say: this.lastReport?.say || '',
      cause: this.lastReport?.cause || '',
      attempts: this.lastReport?.attempts ?? null,
      goal: this.goal || '',
      windowId: this.unit.windowId ?? null,
      eventId: this.unit.eventId ?? null,
      error: this.lastReport?.status === 'ok' ? null : this.lastReport?.cause || null,
    }
  }

  /** 会话详情（界面用）。 */
  snapshot(options = {}) {
    const base = this.session.snapshot(options)
    const report = this.lastReport
    return {
      ...base,
      ...this.summary(),
      system: base.system,
      unit: {
        id: this.unit.id,
        type: this.unit.type,
        name: this.unit.name || null,
        key: this.unit.key ?? null,
        windowId: this.unit.windowId ?? null,
        eventId: this.unit.eventId ?? null,
        triggerType: this.unit.triggerType || null,
      },
      lastReport: report
        ? {
            status: report.status,
            say: report.say,
            cause: report.cause,
            suggestion: report.suggestion,
            evidence: report.evidence,
            attempts: report.attempts,
            actions: report.actions,
            at: report.at,
            ms: report.ms,
          }
        : null,
      lastResult: report?.result
        ? {
            ok: report.result.ok,
            summary: report.result.summary,
            error: report.result.error,
            failedIndex: report.result.failedIndex,
            actions: (report.result.actions || []).map((row) => ({
              index: row.index,
              method: row.method,
              status: row.status,
              error: row.error || null,
              verify: row.verify ? { ok: row.verify.ok, soft: row.verify.soft, detail: row.verify.detail } : null,
            })),
          }
        : null,
    }
  }

  _turnPrompt({ reason, attempt, lastResult }) {
    const world = this.getWorld()
    const context = unitContext(this.unit, world)
    const lines = [
      `本轮触发：${reason}（第 ${attempt}/${this.attempts} 次尝试）`,
      this.goal ? `主会话给的目标：${this.goal}` : '没有明确目标：先判断当前是否需要处理，不需要就 status="ok"、actions=[]。',
      this.isEvent
        ? `你要处理的特殊事件：${JSON.stringify(clip(this.unit.event ?? context?.window ?? {}, 4000))}`
        : '',
      `当前状态：${JSON.stringify(clip(context, 12000))}`,
      `执行器状态：${JSON.stringify(this.executor.status())}`,
      lastResult ? `上一次执行结果：\n${feedbackText(lastResult)}` : '',
      `输出要求：最多 ${this.maxActions} 个动作；只能使用动作清单里的方法名与参数名。`,
    ].filter(Boolean)
    return lines.join('\n\n')
  }

  /**
   * 跑一轮（同步等模型与执行器）。
   * @param {{goal?:string, reason?:string}} [options]
   */
  async run({ goal = null, reason = 'interval' } = {}) {
    if (this.running) return { ok: false, error: 'ALREADY_RUNNING', unit: this.id }
    this.running = true
    this.lastRunAt = Date.now()
    if (goal) this.goal = String(goal).slice(0, 1500)
    const started = Date.now()
    let lastResult = null
    let lastSay = ''
    let attemptsUsed = 0
    try {
      for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
        attemptsUsed = attempt
        this.session.pushUser(this._turnPrompt({ reason, attempt, lastResult }))
        let reply
        try {
          reply = await this.session.ask({ maxTokens: this.config?.ai?.deepseek?.maxTokens })
        } catch (error) {
          const report = this._report({
            status: 'error',
            say: `模型调用失败：${error?.message || error}`,
            attempts: attempt,
            actions: [],
            startedAt: started,
          })
          return report
        }
        const parsed = parseUnitDecision(reply.text)
        if (!parsed.ok) {
          this.session.pushObservation(`你的回复不是可解析的 JSON：${parsed.error}。请只输出一个 json 代码块。`)
          continue
        }
        const decision = parsed.value
        lastSay = decision.say || lastSay
        if (decision.status === 'blocked' && decision.actions.length === 0) {
          return this._report({
            status: 'blocked',
            say: decision.say,
            cause: decision.cause,
            suggestion: decision.suggestion,
            attempts: attempt,
            actions: [],
            startedAt: started,
          })
        }
        if (decision.actions.length === 0) {
          return this._report({
            status: 'ok',
            say: decision.say || '本轮无需动作',
            attempts: attempt,
            actions: [],
            startedAt: started,
          })
        }
        const validated = validateActions(decision.actions.slice(0, this.maxActions), { unitType: this.unit.type })
        if (!validated.ok) {
          this.session.pushObservation(`动作校验失败，未执行：\n- ${validated.errors.join('\n- ')}`)
          continue
        }
        this.log('unit.submit', { unit: this.id, actions: validated.actions.map((action) => action.method), attempt })
        lastResult = await this.executor.submit({
          unit: this.id,
          source: this.isEvent ? 'event' : 'unit',
          actions: validated.actions.map((action) => ({ method: action.method, params: action.params })),
          meta: { goal: this.goal, reason },
        })
        if (lastResult.ok) {
          return this._report({
            status: 'ok',
            say: decision.say || lastSay,
            attempts: attempt,
            actions: validated.actions.map((action) => action.method),
            result: lastResult,
            startedAt: started,
          })
        }
        this.session.pushObservation(feedbackText(lastResult))
      }

      // 用完了重试次数：单独问一次失败分析
      const analysis = await this._analyze(lastResult)
      return this._report({
        status: 'blocked',
        say: lastSay || '多次尝试仍失败',
        cause: analysis?.cause || lastResult?.message || lastResult?.error || '未知原因',
        suggestion: analysis?.suggestion || '',
        evidence: analysis?.evidence || '',
        attempts: attemptsUsed,
        actions: [],
        result: lastResult,
        startedAt: started,
      })
    } finally {
      this.running = false
    }
  }

  async _analyze(lastResult) {
    if (!this.backend) return null
    this.session.pushUser(failureAnalysisPrompt())
    this.session.pushUser(`失败现场：${JSON.stringify(clip(lastResult, 6000))}`)
    try {
      const reply = await this.session.ask({ maxTokens: 1200 })
      const parsed = parseAnalysis(reply.text)
      return parsed.ok ? parsed.value : null
    } catch (error) {
      this.log('unit.analyze.failed', { unit: this.id, error: String(error?.message || error) })
      return null
    }
  }

  _report({ status, say, cause = '', suggestion = '', evidence = '', attempts, actions, result = null, startedAt }) {
    const report = {
      unit: this.id,
      unitType: this.unit.type,
      name: this.unit.name || null,
      status,
      say,
      cause,
      suggestion,
      evidence,
      attempts,
      actions,
      result,
      goal: this.goal,
      at: Date.now(),
      ms: Date.now() - startedAt,
    }
    this.lastReport = report
    this.log('unit.report', { unit: this.id, status, attempts, ms: report.ms })
    try {
      this.onReport(report)
    } catch {
      /* 上报失败不影响子会话 */
    }
    return report
  }
}

/**
 * 特殊事件子会话：同一个循环，但上下文固定为某个事件窗口/警报。
 */
export class EventSession extends UnitSession {
  constructor(options) {
    const unit = { ...options.unit, type: 'event', id: options.unit.unitId || `event:${options.unit.windowId ?? options.unit.eventId ?? Date.now()}` }
    super({ ...options, unit })
  }
}
