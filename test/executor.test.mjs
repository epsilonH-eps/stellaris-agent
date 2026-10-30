import test from 'node:test'
import assert from 'node:assert/strict'

import { Executor } from '../agent/lib/executor.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeBridge {
  constructor(handlers = {}) {
    this.handlers = handlers
    this.calls = []
    this.connected = true
  }

  async request(method, params = {}) {
    this.calls.push({ method, params })
    const handler = this.handlers[method]
    if (typeof handler === 'function') return handler(params, this)
    if (handler !== undefined) return handler
    if (method === 'set_paused') return { ok: true }
    throw new Error(`unknown method ${method}`)
  }

  count(method) {
    return this.calls.filter((call) => call.method === method).length
  }
}

function executorConfig(overrides = {}) {
  return {
    executor: {
      pauseWhenQueuedActions: 8,
      resumeWhenQueuedActionsBelow: 3,
      autoPause: true,
      autoResume: true,
      maxAttempts: 2,
      retryDelayMs: 0,
      verify: true,
      keepJobHistory: 10,
      ...overrides,
    },
  }
}

test('串行执行并保持顺序', async () => {
  const order = []
  const bridge = new FakeBridge({
    focus_planet: (params) => {
      order.push(params.planet_id)
      return { ok: true }
    },
  })
  const executor = new Executor({ bridge, config: executorConfig() })
  const result = await executor.submit({
    unit: 'planet:1',
    actions: [
      { method: 'focus_planet', params: { planet_id: 1 } },
      { method: 'focus_planet', params: { planet_id: 2 } },
    ],
  })
  assert.equal(result.ok, true)
  assert.deepEqual(order, [1, 2])
  assert.equal(result.actions.length, 2)
  assert.equal(result.summary, '2/2 成功')
})

test('单动作重试 Y 次后失败，剩余动作不再执行', async () => {
  let attempts = 0
  const bridge = new FakeBridge({
    set_speed: () => {
      attempts += 1
      throw Object.assign(new Error('boom'), { code: 'RPC_ERROR' })
    },
    focus_planet: () => ({ ok: true }),
  })
  const executor = new Executor({ bridge, config: executorConfig({ maxAttempts: 3 }) })
  const result = await executor.submit({
    unit: 'main',
    actions: [
      { method: 'set_speed', params: { speed: 3 } },
      { method: 'focus_planet', params: { planet_id: 9 } },
    ],
  })
  assert.equal(result.ok, false)
  assert.equal(result.failedIndex, 0)
  assert.equal(attempts, 3)
  assert.equal(result.actions[0].status, 'failed')
  assert.equal(result.actions[1].status, 'skipped')
  assert.equal(bridge.count('focus_planet'), 0, '前一步失败后不应执行后续动作')
})

test('读回校验成功：set_speed 用 get_status.speed 比对', async () => {
  let speed = 1
  const bridge = new FakeBridge({
    set_speed: (params) => {
      speed = params.speed
      return { ok: true }
    },
    get_status: () => ({ speed, is_paused: false }),
  })
  const executor = new Executor({ bridge, config: executorConfig() })
  const result = await executor.submit({ unit: 'main', actions: [{ method: 'set_speed', params: { speed: 3 } }] })
  assert.equal(result.ok, true)
  assert.equal(result.actions[0].verify.ok, true)
})

test('读回校验失败：hard verify 会重试并最终失败', async () => {
  const bridge = new FakeBridge({
    set_paused: () => ({ ok: true }),
    get_status: () => ({ is_paused: false }),
  })
  const executor = new Executor({ bridge, config: executorConfig({ maxAttempts: 2 }) })
  const result = await executor.submit({ unit: 'main', actions: [{ method: 'set_paused', params: { paused: true } }] })
  assert.equal(result.ok, false)
  assert.equal(bridge.count('set_paused'), 2)
  assert.match(result.actions[0].error, /读回校验不通过/)
})

test('soft verify 不通过不算失败', async () => {
  const bridge = new FakeBridge({
    toggle_edict: () => ({ ok: true }),
    get_edicts: () => ({ edicts: [] }),
  })
  const executor = new Executor({ bridge, config: executorConfig() })
  const result = await executor.submit({ unit: 'laws', actions: [{ method: 'toggle_edict', params: { edict_key: 'edict_x', enabled: true } }] })
  assert.equal(result.ok, true)
  assert.equal(result.actions[0].verify.ok, false)
})

test('动作数超过阈值(X)时暂停游戏，排空后恢复', async () => {
  const bridge = new FakeBridge({ focus_planet: () => ({ ok: true }) })
  const executor = new Executor({
    bridge,
    config: executorConfig({ pauseWhenQueuedActions: 2, resumeWhenQueuedActionsBelow: 1, autoResume: true }),
  })
  const result = await executor.submit({
    unit: 'planet:1',
    actions: [
      { method: 'focus_planet', params: { planet_id: 1 } },
      { method: 'focus_planet', params: { planet_id: 2 } },
      { method: 'focus_planet', params: { planet_id: 3 } },
    ],
  })
  assert.equal(result.ok, true)
  const pauses = bridge.calls.filter((call) => call.method === 'set_paused').map((call) => call.params.paused)
  assert.ok(pauses.includes(true), '队列达到阈值应暂停')
  await sleep(750)
  const after = bridge.calls.filter((call) => call.method === 'set_paused').map((call) => call.params.paused)
  assert.ok(after.includes(false), '排空后应恢复')
  assert.equal(executor.pausedByUs, false)
})

test('低于阈值不暂停', async () => {
  const bridge = new FakeBridge({ focus_planet: () => ({ ok: true }) })
  const executor = new Executor({ bridge, config: executorConfig({ pauseWhenQueuedActions: 99 }) })
  await executor.submit({ unit: 'planet:1', actions: [{ method: 'focus_planet', params: { planet_id: 1 } }] })
  assert.equal(bridge.count('set_paused'), 0)
})

test('科研动作：slot 映射为桥接要求的 area 整数（0/1/2）', async () => {
  const bridge = new FakeBridge({
    select_research: () => ({ ok: true }),
    cancel_research: () => ({ ok: true }),
    get_research_state: () => ({
      physics: { current: { key: null } },
      society: { current: { key: 'tech_x' } },
      engineering: { current: { key: null } },
    }),
  })
  const executor = new Executor({ bridge, config: executorConfig() })
  await executor.submit({
    unit: 'research',
    actions: [
      { method: 'select_research', params: { slot: 'society', tech_key: 'tech_x' } },
      { method: 'cancel_research', params: { slot: 'engineering' } },
    ],
  })
  const select = bridge.calls.find((call) => call.method === 'select_research')
  const cancel = bridge.calls.find((call) => call.method === 'cancel_research')
  assert.deepEqual(select.params, { area: 1, tech_key: 'tech_x' })
  assert.deepEqual(cancel.params, { area: 2 })
})

test('空动作 / 停止后的任务返回明确错误', async () => {
  const bridge = new FakeBridge({})
  const executor = new Executor({ bridge, config: executorConfig() })
  const empty = await executor.submit({ unit: 'main', actions: [] })
  assert.equal(empty.ok, false)
  assert.equal(empty.error, 'EMPTY_ACTIONS')
  executor.stop()
  const stopped = await executor.submit({ unit: 'main', actions: [{ method: 'focus_planet', params: { planet_id: 1 } }] })
  assert.equal(stopped.error, 'EXECUTOR_STOPPED')
})
