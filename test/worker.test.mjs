import test from 'node:test'
import assert from 'node:assert/strict'

import { UnitSession, EventSession } from '../agent/lib/ai/worker.mjs'

class ScriptedBackend {
  constructor(replies) {
    this.replies = [...replies]
    this.calls = []
  }

  async complete({ messages }) {
    this.calls.push(messages)
    const text = this.replies.shift()
    if (text === undefined) throw new Error('backend script exhausted')
    return { text, usage: null, model: 'scripted', backend: 'scripted' }
  }
}

class FakeExecutor {
  constructor(results) {
    this.results = [...results]
    this.submitted = []
    this.pausedByUs = false
  }

  async submit(job) {
    this.submitted.push(job)
    return this.results.shift() || { ok: true, summary: '1/1 成功', actions: [{ index: 0, method: job.actions[0]?.method, status: 'ok' }] }
  }

  status() {
    return { running: false, queuedActions: 0 }
  }
}

const config = {
  ai: { unit: { attempts: 2, maxActionsPerTurn: 2, historyMessages: 8 }, event: { attempts: 1, maxActionsPerTurn: 2 }, deepseek: { maxTokens: 100 } },
  executor: { maxAttempts: 2 },
}

function researchWorld() {
  return {
    date: '2200.01.01',
    resources: { physics_research: { stockpile: 1, net: 1 } },
    research: { physics: { current: { key: null, progress: 0 }, options: [{ key: 'tech_lasers_1' }] } },
    traditions: {},
    situations: {},
    eventChains: { active: [] },
    activeEvents: [],
    alerts: [],
    government: {},
  }
}

const unit = { id: 'research', type: 'research', name: '国家科研' }

test('硬性指标：两棵未闭门树存在时禁止开新传统树', () => {
  const unit = { id: 'unit:laws', type: 'laws' }
  const session = new UnitSession({
    unit,
    backend: null,
    executor: new FakeExecutor([]),
    getWorld: () => null,
    config,
    log: () => {},
  })
  const world = {
    traditions: {
      adopted_trees: [
        { key: 'tradition_expansion', is_finished: false },
        { key: 'tradition_adaptability', is_finished: false },
      ],
      nodes: {
        tradition_aptitude: [{ key: 'tr_aptitude_adopt', tree_key: 'tradition_aptitude' }],
        tradition_adaptability: [{ key: 'tr_adaptability_recycling', tree_key: 'tradition_adaptability' }],
      },
    },
  }
  const blocked = session.precheckActions([{ method: 'adopt_tradition', params: { tradition_key: 'tr_aptitude_adopt' } }], world)
  assert.equal(blocked.allowed.length, 0)
  assert.match(blocked.errors[0], /未闭门传统树/)

  const allowed = session.precheckActions([{ method: 'adopt_tradition', params: { tradition_key: 'tr_adaptability_recycling' } }], world)
  assert.equal(allowed.allowed.length, 1)
  assert.equal(allowed.errors.length, 0)
})

test('子会话：模型最后 blocked 时，失败报告仍保留上一次执行器结果', async () => {
  const failed = {
    ok: false,
    summary: '0/1 成功；第 1 项 select_research 失败',
    error: 'Technology key ... not found',
    actions: [{ index: 0, method: 'select_research', status: 'failed', error: '-32044' }],
  }
  const backend = new ScriptedBackend([
    '```json\n{"say":"试一下","actions":[{"method":"select_research","params":{"slot":"society","tech_key":"tech_x"}}]}\n```',
    '```json\n{"say":"不行","actions":[],"status":"blocked","cause":"候选池不一致"}\n```',
  ])
  const executor = new FakeExecutor([failed])
  const session = new UnitSession({
    unit,
    backend,
    executor,
    getWorld: researchWorld,
    config,
    onReport: () => {},
  })
  const report = await session.run({ goal: '测试' })
  assert.equal(report.status, 'blocked')
  assert.equal(report.result, failed)
  assert.deepEqual(report.actions, ['select_research'])
})

test('子会话：非法动作被打回，下一轮换成合法动作成功', async () => {
  const backend = new ScriptedBackend([
    '```json\n{"say":"乱来","actions":[{"method":"nope","params":{}}]}\n```',
    '```json\n{"say":"研究激光","actions":[{"method":"select_research","params":{"slot":"physics","tech_key":"tech_lasers_1"}}]}\n```',
  ])
  const executor = new FakeExecutor([{ ok: true, summary: '1/1 成功', actions: [{ index: 0, method: 'select_research', status: 'ok' }] }])
  let reported = null
  const session = new UnitSession({
    unit,
    backend,
    executor,
    getWorld: researchWorld,
    config,
    onReport: (report) => {
      reported = report
    },
  })
  const report = await session.run({ goal: '点一个科技' })
  assert.equal(report.status, 'ok')
  assert.equal(report.attempts, 2)
  assert.equal(executor.submitted.length, 1)
  assert.equal(executor.submitted[0].unit, 'research')
  assert.equal(executor.submitted[0].actions[0].method, 'select_research')
  assert.ok(reported)
  assert.equal(reported.status, 'ok')
  // 第二轮上下文里应包含"动作校验失败"的反馈
  const secondPrompt = backend.calls[1].map((m) => m.content).join('\n')
  assert.match(secondPrompt, /动作校验失败/)
})

test('子会话：执行失败后重试，用满 Y 次再做失败分析并上报', async () => {
  const failResult = {
    ok: false,
    error: 'ACTION_FAILED',
    failedIndex: 0,
    summary: '第 1 项 select_research 失败：unknown tech',
    actions: [{ index: 0, method: 'select_research', status: 'failed', error: 'unknown tech', attempts: [{ attempt: 1, error: 'unknown tech' }] }],
  }
  const backend = new ScriptedBackend([
    '{"actions":[{"method":"select_research","params":{"slot":"physics","tech_key":"bad"}}]}',
    '{"actions":[{"method":"select_research","params":{"slot":"physics","tech_key":"bad2"}}]}',
    '```json\n{"cause":"科技 key 不存在","evidence":"unknown tech","suggestion":"从 options 里挑一个真实 key"}\n```',
  ])
  const executor = new FakeExecutor([failResult, failResult])
  const reports = []
  const session = new UnitSession({
    unit,
    backend,
    executor,
    getWorld: researchWorld,
    config,
    onReport: (report) => reports.push(report),
  })
  const report = await session.run({ goal: '点科技' })
  assert.equal(report.status, 'blocked')
  assert.equal(report.attempts, 2)
  assert.equal(executor.submitted.length, 2)
  assert.match(report.cause, /key 不存在/)
  assert.match(report.suggestion, /真实 key/)
  assert.ok(reports.at(-1).cause)
  // 失败分析应该把执行器的原始错误喂给模型
  const lastPrompt = backend.calls.at(-1).map((m) => m.content).join('\n')
  assert.match(lastPrompt, /unknown tech/)
})

test('子会话：模型明确表示不需要动作时直接收尾', async () => {
  const backend = new ScriptedBackend(['{"actions":[],"status":"ok","say":"暂无必要"}'])
  const executor = new FakeExecutor([])
  const session = new UnitSession({ unit, backend, executor, getWorld: researchWorld, config })
  const report = await session.run({ goal: '看看' })
  assert.equal(report.status, 'ok')
  assert.equal(executor.submitted.length, 0)
  assert.equal(report.say, '暂无必要')
})

test('子会话：反复给出非法 JSON 时不会崩，最终 blocked', async () => {
  const backend = new ScriptedBackend(['胡说八道', '继续胡说'])
  const executor = new FakeExecutor([])
  const session = new UnitSession({ unit, backend, executor, getWorld: researchWorld, config })
  const report = await session.run({ goal: 'x' })
  assert.equal(report.status, 'blocked')
  assert.equal(executor.submitted.length, 0)
})

test('特殊事件子会话：resolve_event 走事件单位白名单', async () => {
  const backend = new ScriptedBackend(['{"say":"选第二项","actions":[{"method":"resolve_event","params":{"window_id":5,"option_index":1}}]}'])
  const executor = new FakeExecutor([{ ok: true, summary: '1/1 成功', actions: [{ index: 0, method: 'resolve_event', status: 'ok' }] }])
  const session = new EventSession({
    unit: { unitId: 'event:5', windowId: 5, eventId: 'evt.1', name: '测试事件' },
    backend,
    executor,
    getWorld: () => ({ ...researchWorld(), eventChains: { active: [{ windowId: 5, id: 'evt.1', title: 'T', chain: null }] } }),
    config,
  })
  const report = await session.run({ goal: '处理事件' })
  assert.equal(report.status, 'ok')
  assert.equal(report.unit, 'event:5')
  assert.equal(executor.submitted[0].actions[0].method, 'resolve_event')
})

test('并发保护：同一子会话 running 时第二次 run 直接返回', async () => {
  let release
  const backend = {
    complete: () => new Promise((resolve) => {
      release = () => resolve({ text: '{"actions":[]}', usage: null })
    }),
  }
  const session = new UnitSession({ unit, backend, executor: new FakeExecutor([]), getWorld: researchWorld, config })
  const first = session.run({ goal: 'a' })
  const second = await session.run({ goal: 'b' })
  assert.equal(second.error, 'ALREADY_RUNNING')
  release()
  await first
})
