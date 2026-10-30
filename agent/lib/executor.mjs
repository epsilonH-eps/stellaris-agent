/**
 * 执行器：所有写动作的唯一出口。
 *
 * 契约（对子会话）：
 *   submit({unit, source, actions}) -> Promise<JobResult>
 *   JobResult = {jobId, unit, ok, actions:[...], error, failedIndex, summary, durationMs}
 *
 * 保证：
 *  1. **严格串行**：DLL 是单连接 + 游戏主线程队列，绝不并发下发；
 *  2. **阈值暂停**：队列里待执行的动作数 > `pauseWhenQueuedActions`(X) 时暂停游戏，
 *     降到 `resumeWhenQueuedActionsBelow` 以下且是我们暂停的，才自动恢复；
 *  3. **逐项读回**：每个动作后按 `verify` 规格回读；`soft` 校验不过只记警告；
 *  4. **最多 Y 次**：单动作失败重试 `maxAttempts`(Y) 次，仍失败 → 整个任务在该步终止，
 *     返回每个尝试的错误，交给子会话分析（不自动重排，避免半截计划）；
 *  5. 失败不会让队列卡死：任务结束即继续下一个。
 *
 * @module stellaris-agent/executor
 */
import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { verifySpecOf } from './actions.mjs'

function deepGet(value, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((node, key) => (node == null ? undefined : node[key]), value)
}

function looseEqual(left, right) {
  if (typeof left === 'number' || typeof right === 'number') return Number(left) === Number(right)
  if (typeof left === 'boolean' || typeof right === 'boolean') return Boolean(left) === Boolean(right)
  return JSON.stringify(left) === JSON.stringify(right)
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))

function bridgeParams(method, params = {}) {
  if (method !== 'select_research' && method !== 'cancel_research') return params
  const copy = { ...params }
  const slot = String(copy.slot ?? copy.area ?? '').toLowerCase()
  const area = slot === 'physics' ? 0 : slot === 'society' ? 1 : slot === 'engineering' ? 2 : Number(copy.area)
  delete copy.slot
  if (Number.isInteger(area) && area >= 0 && area <= 2) copy.area = area
  return copy
}

export class Executor extends EventEmitter {
  /**
   * @param {object} options
   * @param {{request:Function}} options.bridge
   * @param {object} options.config
   * @param {Function} [options.log]
   */
  constructor({ bridge, config, log = () => {} }) {
    super()
    this.bridge = bridge
    this.config = config
    this.log = log
    const executor = config?.executor || {}
    this.settings = {
      pauseWhenQueuedActions: Number(executor.pauseWhenQueuedActions ?? 8),
      resumeWhenQueuedActionsBelow: Number(executor.resumeWhenQueuedActionsBelow ?? 3),
      autoPause: executor.autoPause !== false,
      autoResume: executor.autoResume !== false,
      maxAttempts: Math.max(1, Number(executor.maxAttempts ?? 3)),
      retryDelayMs: Number(executor.retryDelayMs ?? 450),
      verify: executor.verify !== false,
      keepJobHistory: Number(executor.keepJobHistory ?? 60),
    }
    this.jobs = []
    this.running = null
    this.draining = false
    this.history = []
    this.pausedByUs = false
    this.lastPauseAt = 0
    this.resumeTimer = null
    this.stopped = false
    this.seq = 0
  }

  get queuedActions() {
    const pending = this.jobs.reduce((sum, job) => sum + job.actions.length - job.cursor, 0)
    const running = this.running ? this.running.actions.length - this.running.cursor : 0
    return pending + running
  }

  status() {
    return {
      running: Boolean(this.running),
      current: this.running
        ? { jobId: this.running.jobId, unit: this.running.unit, total: this.running.actions.length, done: this.running.cursor }
        : null,
      queue: this.jobs.map((job) => ({ jobId: job.jobId, unit: job.unit, actions: job.actions.length })),
      queuedActions: this.queuedActions,
      pausedByUs: this.pausedByUs,
      settings: this.settings,
      history: this.history.slice(-10),
    }
  }

  /**
   * 入队一个任务。
   * @param {{unit?:string, source?:string, actions:Array<{method:string, params?:object}>}} job
   * @returns {Promise<object>}
   */
  submit({ unit = 'main', source = 'session', actions = [], meta = null }) {
    if (this.stopped) return Promise.resolve({ ok: false, error: 'EXECUTOR_STOPPED', actions: [] })
    if (!Array.isArray(actions) || actions.length === 0) {
      return Promise.resolve({ ok: false, error: 'EMPTY_ACTIONS', actions: [] })
    }
    const id = `job-${++this.seq}-${randomUUID().slice(0, 6)}`
    const job = { jobId: id, unit, source, actions, meta, cursor: 0, createdAt: Date.now() }
    const promise = new Promise((resolve) => {
      job.resolve = resolve
    })
    this.jobs.push(job)
    this.emit('queued', { jobId: id, unit, actions: actions.length, queuedActions: this.queuedActions })
    this._schedule()
    return promise
  }

  /** 主会话/用户显式暂停。 */
  async pause(reason = 'manual') {
    if (this.pausedByUs) return { ok: true, already: true }
    const result = await this._setPaused(true, reason)
    if (result.ok) this.pausedByUs = true
    return result
  }

  /** 主会话/用户显式恢复。 */
  async resume(reason = 'manual') {
    const result = await this._setPaused(false, reason)
    if (result.ok) this.pausedByUs = false
    return result
  }

  async _setPaused(paused, reason) {
    try {
      const status = await this.bridge.request('set_paused', { paused })
      this.log('executor.pause', { paused, reason })
      this.emit('paused', { paused, reason, status })
      return { ok: true }
    } catch (error) {
      this.log('executor.pause.failed', { paused, reason, error: String(error?.message || error) })
      return { ok: false, error: String(error?.message || error) }
    }
  }

  _maybePause() {
    if (!this.settings.autoPause || this.pausedByUs) return false
    return this.queuedActions >= this.settings.pauseWhenQueuedActions
  }

  _schedule() {
    if (this.draining || this.stopped) return
    setImmediate(() => {
      this._drain().catch((error) => this.log('executor.drain', { error: String(error?.message || error) }))
    })
  }

  async _drain() {
    if (this.draining) return
    this.draining = true
    try {
      // 先按阈值暂停，再开始执行——暂停失败不阻塞（游戏可能在主菜单/已暂停）
      if (this._maybePause()) {
        await this.pause('queue-threshold').catch(() => ({}))
      }
      while (this.jobs.length && !this.stopped) {
        const job = this.jobs.shift()
        this.running = job
        this.emit('job.start', { jobId: job.jobId, unit: job.unit })
        const result = await this._runJob(job)
        this.running = null
        this.history.push(result)
        if (this.history.length > this.settings.keepJobHistory) this.history.shift()
        this.emit('job.done', result)
        job.resolve(result)
      }
    } finally {
      this.draining = false
      this._maybeResume()
    }
  }

  _maybeResume() {
    if (!this.settings.autoResume || !this.pausedByUs) return
    if (this.queuedActions > this.settings.resumeWhenQueuedActionsBelow) return
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    this.resumeTimer = setTimeout(() => {
      this.resumeTimer = null
      if (this.queuedActions > this.settings.resumeWhenQueuedActionsBelow) return
      this.resume('queue-drained').catch(() => {})
    }, 600)
    this.resumeTimer.unref?.()
  }

  async _runJob(job) {
    const startedAt = Date.now()
    const results = []
    for (let index = 0; index < job.actions.length; index += 1) {
      if (this.stopped) {
        return this._finishJob(job, results, { ok: false, error: 'EXECUTOR_STOPPED', failedIndex: index, startedAt })
      }
      job.cursor = index
      const action = job.actions[index]
      const outcome = await this._runAction(action, index, job)
      results.push(outcome)
      if (!outcome.ok) {
        const skipped = job.actions.slice(index + 1).map((rest, offset) => ({
          index: index + 1 + offset,
          method: rest.method,
          params: rest.params || {},
          status: 'skipped',
          attempts: [],
        }))
        results.push(...skipped)
        return this._finishJob(job, results, {
          ok: false,
          error: 'ACTION_FAILED',
          failedIndex: index,
          message: outcome.error,
          startedAt,
        })
      }
    }
    job.cursor = job.actions.length
    return this._finishJob(job, results, { ok: true, startedAt })
  }

  _finishJob(job, results, { ok, error = null, failedIndex = null, message = null, startedAt }) {
    const result = {
      jobId: job.jobId,
      unit: job.unit,
      source: job.source,
      ok,
      error,
      failedIndex,
      message,
      actions: results,
      summary: this._summarize(results, ok),
      durationMs: Date.now() - startedAt,
    }
    this.log('executor.job', {
      jobId: job.jobId,
      unit: job.unit,
      ok,
      failedIndex,
      actions: results.length,
      ms: result.durationMs,
    })
    return result
  }

  _summarize(results, ok) {
    const done = results.filter((row) => row.status === 'ok').length
    const failed = results.find((row) => row.status === 'failed')
    const skipped = results.filter((row) => row.status === 'skipped').length
    if (ok) return `${done}/${results.length} 成功`
    const pieces = [`${done}/${results.length} 成功`]
    if (failed) pieces.push(`第 ${failed.index + 1} 项 ${failed.method} 失败：${failed.error || '未知错误'}`)
    if (skipped) pieces.push(`${skipped} 项未执行`)
    return pieces.join('；')
  }

  async _runAction(action, index, job) {
    const method = action.method
    const params = action.params || {}
    const spec = verifySpecOf(method)
    const row = { index, method, params, status: 'pending', attempts: [], verify: null }
    this.emit('action.start', { jobId: job.jobId, index, method, params })

    let lastError = null
    for (let attempt = 1; attempt <= this.settings.maxAttempts; attempt += 1) {
      const startedAt = Date.now()
      try {
        const response = await this.bridge.request(method, bridgeParams(method, params))
        let verify = null
        if (this.settings.verify && spec) {
          verify = await this._verify(spec, params)
        }
        row.attempts.push({
          attempt,
          ok: verify ? verify.ok || verify.soft : true,
          ms: Date.now() - startedAt,
          response: compact(response),
          verify,
        })
        if (verify && !verify.ok && !verify.soft) {
          lastError = `读回校验不通过：${verify.detail}`
          this.log('executor.verify.failed', { method, attempt, detail: verify.detail })
        } else {
          row.status = 'ok'
          row.ok = true
          row.verify = verify
          row.response = compact(response)
          this.emit('action.done', { jobId: job.jobId, index, method, ok: true, verify })
          return row
        }
      } catch (error) {
        lastError = String(error?.message || error)
        row.attempts.push({ attempt, ok: false, ms: Date.now() - startedAt, error: lastError, code: error?.code || null })
        this.log('executor.action.error', { method, attempt, error: lastError, code: error?.code || null })
      }
      if (attempt < this.settings.maxAttempts) await sleep(this.settings.retryDelayMs * attempt)
    }

    row.status = 'failed'
    row.ok = false
    row.error = lastError || '未知错误'
    this.emit('action.done', { jobId: job.jobId, index, method, ok: false, error: row.error })
    return row
  }

  /**
   * 读回校验。规则见 actions.mjs 的 verify 说明。
   * @returns {Promise<{ok:boolean, soft:boolean, detail:string, result:any}>}
   */
  async _verify(spec, params) {
    const soft = Boolean(spec.soft)
    const readParams = {}
    if (Array.isArray(spec.params)) {
      for (const key of spec.params) if (params[key] !== undefined) readParams[key] = params[key]
    } else {
      for (const [key, value] of Object.entries(params)) readParams[key] = value
    }
    let result
    try {
      result = await this.bridge.request(spec.read, readParams)
    } catch (error) {
      return { ok: false, soft, detail: `回读 ${spec.read} 失败：${error?.message || error}` }
    }
    if (spec.path) {
      const path = String(spec.path).replace(/\{(\w+)\}/g, (_, key) => String(params[key] ?? ''))
      const actual = deepGet(result, path)
      const expected = spec.equalsParam ? params[spec.equalsParam] : spec.equals
      const ok = looseEqual(actual, expected)
      return { ok, soft, detail: `${path} 实际=${JSON.stringify(actual)} 期望=${JSON.stringify(expected)}`, result: compact(result) }
    }
    if (spec.includesParam) {
      const needle = params[spec.includesParam]
      const ok = needle !== undefined && JSON.stringify(result ?? {}).includes(String(needle))
      return { ok, soft, detail: `${spec.read} 是否包含 ${spec.includesParam}=${JSON.stringify(needle)}：${ok}`, result: compact(result) }
    }
    if (spec.excludesParam) {
      const needle = params[spec.excludesParam]
      const ok = needle !== undefined && !JSON.stringify(result ?? {}).includes(String(needle))
      return { ok, soft, detail: `${spec.read} 是否已不含 ${spec.excludesParam}=${JSON.stringify(needle)}：${ok}`, result: compact(result) }
    }
    return { ok: true, soft, detail: `回读 ${spec.read} 成功`, result: compact(result) }
  }

  stop() {
    this.stopped = true
    if (this.resumeTimer) clearTimeout(this.resumeTimer)
    for (const job of this.jobs) job.resolve({ ok: false, error: 'EXECUTOR_STOPPED', actions: [] })
    this.jobs = []
  }
}

/** 回读结果可能很大，日志/历史里只留前 1200 字符。 */
function compact(value, limit = 1200) {
  if (value === undefined) return null
  try {
    const text = JSON.stringify(value)
    if (text.length <= limit) return value
    return { truncated: true, chars: text.length, preview: text.slice(0, limit) }
  } catch {
    return null
  }
}

export const _internals = { deepGet, looseEqual, compact }
