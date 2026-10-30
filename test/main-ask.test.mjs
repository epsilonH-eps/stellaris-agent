import test from 'node:test'
import assert from 'node:assert/strict'

import { MainSession } from '../agent/lib/ai/main.mjs'

function fakeWorld() {
  return {
    date: '2200.01.01',
    paused: false,
    speed: 2,
    inGame: true,
    resources: { energy: { stockpile: 100, net: 1 } },
    status: { naval_capacity: 20, naval_size: 5 },
    research: {
      physics: { current: { key: null }, options: [] },
      society: { current: { key: null }, options: [] },
      engineering: { current: { key: null }, options: [] },
    },
    colonies: [],
    fleetsAll: [],
    fleetsDetail: [],
    government: {},
    edicts: {},
    traditions: {},
    leaders: {},
    alerts: [],
    activeEvents: [],
    notifications: [],
    contacts: { empires: [] },
    pendingDiplomacy: { proposals: [] },
    wars: { wars: [] },
    situations: { situations: [] },
    eventChains: { active: [] },
    megaScan: { megastructures: [] },
    modsDigest: null,
  }
}

function build({ replies, units = [{ id: 'research', type: 'research', name: '科研' }] } = {}) {
  const calls = []
  const chatOut = []
  const dispatched = []
  const queue = [...replies]
  const backend = {
    async complete(request) {
      calls.push(request)
      const text = queue.shift()
      if (text === undefined) throw new Error('backend script exhausted')
      return { text, usage: null, model: 'fake', backend: 'fake' }
    },
  }
  const executor = {
    status: () => ({ queuedActions: 0, running: false, pausedByUs: false }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
  }
  const chat = {
    outbound: (message) => chatOut.push(message),
    takePending: () => [],
  }
  const main = new MainSession({
    backend,
    config: { objective: '测试目标', ai: { deepseek: { maxTokens: 100 }, main: { maxActionsPerTurn: 4 } } },
    executor,
    chat,
    getWorld: fakeWorld,
    getUnits: () => units,
    getCompletions: () => [],
    dispatch: async (unit, goal) => {
      dispatched.push({ unit, goal })
      return { ok: true }
    },
    log: () => {},
  })
  return { main, calls, chatOut, dispatched }
}

test('主会话直连：返回 say，并把话写进聊天出站', async () => {
  const { main, calls, chatOut } = build({ replies: ['```json\n{"say":"我在听，先说说资源。","spawn":[]}\n```'] })
  const result = await main.ask({ id: 'player:1', text: '现在局势怎么样？' })
  assert.equal(result.ok, true)
  assert.equal(result.say, '我在听，先说说资源。')
  assert.equal(result.id, 'player:1')
  assert.equal(chatOut.length, 1)
  assert.equal(chatOut[0].text, '我在听，先说说资源。')
  assert.equal(chatOut[0].id, 'main')
  const prompt = calls[0].messages.map((message) => message.content).join('\n')
  assert.match(prompt, /player:1/)
  assert.match(prompt, /现在局势怎么样/)
  assert.equal(main.status().ticking, false)
  assert.equal(main.status().turns, 1)
})

test('主会话直连：决策里的 spawn 会派发给子会话', async () => {
  const { main, dispatched } = build({
    replies: ['```json\n{"say":"让科研去研究激光","spawn":[{"unit":"research","goal":"研究激光"}]}\n```'],
  })
  const result = await main.ask({ id: 'player', text: '先把物理研究点起来' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.spawned, ['research'])
  assert.equal(dispatched.length, 1)
  assert.equal(dispatched[0].unit, 'research')
  assert.equal(dispatched[0].goal, '研究激光')
})

test('主会话直连：pause/resume 会调用执行器', async () => {
  const pauses = []
  const { main } = build({ replies: ['```json\n{"say":"先暂停","pause":true}\n```'] })
  main.executor.pause = async () => {
    pauses.push('pause')
    return { ok: true }
  }
  const result = await main.ask({ id: 'player', text: '暂停一下' })
  assert.equal(result.paused, true)
  assert.deepEqual(pauses, ['pause'])
})

test('主会话直连：模型回复不是 JSON 时返回 PARSE_FAILED，不崩', async () => {
  const { main, chatOut } = build({ replies: ['我觉得应该先造合金。'] })
  const result = await main.ask({ id: 'player', text: '怎么办？' })
  assert.equal(result.ok, false)
  assert.equal(result.error, 'PARSE_FAILED')
  assert.equal(chatOut.length, 0)
  assert.equal(main.status().ticking, false)
})

test('主会话直连：空文本 / 无世界时明确报错', async () => {
  const { main, calls } = build({ replies: [] })
  assert.equal((await main.ask({ text: '   ' })).error, 'EMPTY_TEXT')
  assert.equal(calls.length, 0)
})

test('主会话直连：prompt 带上了单位清单与执行器状态', async () => {
  const { main, calls } = build({ replies: ['```json\n{"say":"ok"}\n```'] })
  await main.ask({ id: 'p', text: '看看' })
  const prompt = calls[0].messages.map((message) => message.content).join('\n')
  assert.match(prompt, /"research"/)
  assert.match(prompt, /queuedActions/)
})
