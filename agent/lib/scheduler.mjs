/**
 * 操作调度器：主会话派任务 → 子会话只思考 → 调度器串行执行。
 *
 * 设计要点：
 * 1. 子会话（worker）只读，输出 ```stellaris 动作块，不直接碰游戏；
 * 2. 所有写操作进同一把全局锁，严格串行，绝不并发注入；
 * 3. 每个任务有明确状态，失败不重试（避免半截操作），交回主会话决策；
 * 4. 队列按 priority + 入队时间排序，先来先做。
 *
 * @module stellaris-agent/scheduler
 */
import { randomUUID } from 'node:crypto'
import { extractActions } from '../../engine/lib/dsl.js'
import { createLock } from '../../engine/lib/lock.js'
import { ensureNativeBridge } from './native-bridge.mjs'
import { runSteps } from './native-operator.mjs'

function extractNativeSteps(text) {
  const fence = /~~~stellaris-native\n([\s\S]*?)~~~/.exec(String(text || '')) || /```stellaris-native\n([\s\S]*?)```/.exec(String(text || ''))
  if (!fence) return null
  try {
    const parsed = JSON.parse(fence[1])
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.steps) ? parsed.steps : null
  } catch {
    return null
  }
}

export class Scheduler {
  constructor({ engine, orchestrator, config, log = () => {} }) {
    this.engine = engine
    this.orchestrator = orchestrator
    this.config = config
    this.log = log
    this.queue = []
    this.current = null
    this.history = []
    this.lock = createLock()
    this.started = false
    this.pending = []
    this.flushTimer = null
    this.lastQueue = null
  }

  dispatch(goal, { priority = 0 } = {}) {
    const task = {
      id: randomUUID().slice(0, 8),
      goal: String(goal || '').trim(),
      priority: Number(priority) || 0,
      status: 'queued',
      createdAt: Date.now(),
    }
    if (!task.goal) return { ok: false, error: 'EMPTY_GOAL' }
    this.queue.push(task)
    this.queue.sort((a, b) => b.priority - a.priority || a.createdAt - b.createdAt)
    this.kick().catch((error) => this.log('scheduler.kick', { error: String(error) }))
    return { ok: true, task }
  }

  status() {
    return {
      running: this.started,
      current: this.current,
      queued: this.queue,
      history: this.history.slice(-20),
    }
  }

  async flushQueue() {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (!this.pending.length) return
    const actions = this.pending.splice(0, this.pending.length)
    const result = await this.lock.run(() => this.engine.applyAuto(actions))
    this.lastQueue = result
    if (!result.ok) {
      this.pending.unshift(...actions)
      throw new Error(result.error || result.code || 'queue write failed')
    }
  }

  async kick() {
    if (this.started) return
    this.started = true
    try {
      while (this.queue.length) {
        const task = this.queue.shift()
        this.current = task
        try {
          await this.runTask(task)
        } catch (error) {
          task.status = 'failed'
          task.error = String(error?.message || error)
        }
        this.current = null
        this.history.push(task)
      }
    } finally {
      this.started = false
    }
  }

  async runTask(task) {
    const maxSteps = this.config.scheduler?.maxSteps ?? 3
    task.status = 'planning'
    task.planStartedAt = Date.now()

    const plan = await this.orchestrator.run({
      goal: task.goal + '\n\n只输出一个 ```stellaris-native 代码块，内容是 JSON 数组，每项形如 {"method":"select_research","params":{...},"verify":{...}}；不要输出解释。',
      label: `worker-${task.id}`,
      role: 'operator',
      allowWrite: false,
      maxSteps,
    })
    task.planText = plan.text || ''
    task.usage = plan.usage || null
    task.planFinishedAt = Date.now()

    const actions = extractActions(task.planText)
    if (!actions.length) {
      task.status = 'no-actions'
      task.error = '子会话没有产出 stellaris 动作块'
      return
    }
    task.actions = actions

    const mode = this.config.scheduler?.execution || 'native'
    if (mode === 'native') {
      const steps = extractNativeSteps(task.planText)
      if (steps && steps.length) {
        task.status = 'executing'
        const bridge = await ensureNativeBridge({ log: this.log })
        if (!bridge.ok) {
          task.status = 'failed'
          task.error = bridge.error
          return
        }
        try {
          const result = await runSteps(bridge.pipe, steps, {
            attempts: this.config.scheduler?.attempts ?? 5,
            log: this.log,
            pause: this.config.scheduler?.pauseBeforeRun !== false,
          })
          task.result = result
          task.steps = result.results
          task.status = result.ok ? 'done' : 'failed'
          if (!result.ok) task.error = `${result.error} at step ${result.failedIndex}`
        } finally {
          bridge.pipe.close()
        }
        return
      }
      // 子会话没按 native 格式输出时，退回队列模式，不丢计划。
    }
    if (mode === 'inject') {
      task.status = 'executing'
      // 全局串行锁：任何时刻只有一个注入在跑
      const result = await this.lock.run(() => this.engine.apply(actions, { force: true }))
      task.result = result
      task.status = result.ok ? 'done' : 'failed'
      if (!result.ok) task.error = result.error || result.code || 'apply failed'
      return
    }

    // 队列模式：不碰按键、不显示控制台；攒批后一次写进 05 队列，读档后由游戏执行
    task.status = 'staged'
    this.pending.push(...actions)
    await this.flushQueue()
    task.queue = this.lastQueue
    task.status = 'queued-for-load'
  }
}
