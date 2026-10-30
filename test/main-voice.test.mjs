import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { MainSession } from '../agent/lib/ai/main.mjs'

function fakeWorld() {
  return {
    date: '2200.01.01',
    paused: false,
    speed: 2,
    inGame: true,
    resources: { energy: { stockpile: 100, net: 1 } },
    status: {},
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
  }
}

function build({ replies, persona = {}, home = mkdtempSync(join(tmpdir(), 'stellaris-voice-main-')) } = {}) {
  const calls = []
  const chatOut = []
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
    status: () => ({ queuedActions: 0, running: false }),
    pause: async () => ({ ok: true }),
    resume: async () => ({ ok: true }),
  }
  const chat = { outbound: (message) => chatOut.push(message), takePending: () => [] }
  const main = new MainSession({
    backend,
    config: {
      objective: '测试',
      ai: { deepseek: { maxTokens: 100 }, main: { maxActionsPerTurn: 4 } },
      persona: {
        name: '测试者',
        voice: { enabled: true, everyTurns: 1, minIntervalSeconds: 0 },
        speech: { maxChars: 40 },
        ...persona,
      },
    },
    executor,
    chat,
    getWorld: fakeWorld,
    getUnits: () => [{ id: 'research', type: 'research', name: '科研' }],
    getCompletions: () => [],
    dispatch: async () => ({ ok: true }),
    log: () => {},
    home,
  })
  return { main, calls, chatOut, home }
}

test('主会话人话：tick 产出 voice，写聊天出站与文件', async () => {
  const { main, chatOut, home } = build({
    replies: ['```json\n{"say":"观察边境","voice":"他们以为我们不敢动手，那就让他们继续以为。","mood":"冷静","intent":"试探","spawn":[]}\n```'],
  })
  try {
    const result = await main.tick({ reason: 'test' })
    assert.equal(result.ok, true)
    assert.ok(result.voice)
    assert.equal(result.voice.text, '他们以为我们不敢动手，那就让他们继续以为。')
    assert.equal(result.voice.mood, '冷静')
    assert.equal(result.voice.intent, '试探')
    assert.ok(chatOut.some((message) => message.kind === 'voice' && message.text.includes('不敢动手')))
    assert.ok(existsSync(join(home, 'voice', 'latest.json')))
    assert.equal(main.lastVoice.id, result.voice.id)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('主会话人话：everyTurns 控制隔几轮说一次', async () => {
  const reply = '```json\n{"say":"ok","voice":"这一句该被节流。","spawn":[]}\n```'
  const { main, home } = build({
    replies: [reply, reply, reply, reply],
    persona: { voice: { enabled: true, everyTurns: 3, minIntervalSeconds: 0 } },
  })
  try {
    assert.equal((await main.tick({ reason: 't1' })).voice, null)
    assert.equal((await main.tick({ reason: 't2' })).voice, null)
    const third = await main.tick({ reason: 't3' })
    assert.ok(third.voice, '第 3 轮应该说')
    assert.equal(third.voice.turn, 3)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('主会话人话：关闭 voice 后不再产出', async () => {
  const { main, chatOut, home } = build({
    replies: ['```json\n{"say":"ok","voice":"不该出现","spawn":[]}\n```'],
    persona: { voice: { enabled: false, everyTurns: 1, minIntervalSeconds: 0 } },
  })
  try {
    const result = await main.tick({ reason: 'off' })
    assert.equal(result.voice, null)
    assert.equal(chatOut.filter((message) => message.kind === 'voice').length, 0)
    assert.equal(main.voices.latest(), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('主会话人话：超长会按 maxChars 截断', async () => {
  const long = '这是一段很长的自言自语，'.repeat(10)
  const { main, home } = build({
    replies: [`\`\`\`json\n${JSON.stringify({ say: 'ok', voice: long, spawn: [] })}\n\`\`\``],
    persona: { voice: { enabled: true, everyTurns: 1, minIntervalSeconds: 0 }, speech: { maxChars: 20 } },
  })
  try {
    const result = await main.tick({ reason: 'long' })
    assert.ok(result.voice.text.length <= 20)
    assert.match(result.voice.text, /…$/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('主会话人话：直接对话 ask 强制说一句', async () => {
  const { main, home } = build({
    replies: ['```json\n{"say":"我在","voice":"先别急，让我看看地图。","spawn":[]}\n```'],
    persona: { voice: { enabled: true, everyTurns: 99, minIntervalSeconds: 999 } },
  })
  try {
    const result = await main.ask({ id: 'player', text: '怎么办？' })
    assert.equal(result.ok, true)
    assert.ok(result.voice, 'ask 应该绕过节流')
    assert.match(result.voice.text, /地图/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('人格：applyPersona 后 system prompt 立即变化', async () => {
  const { main, calls, home } = build({ replies: [] })
  try {
    main.applyPersona({ name: '灰烬', identity: '从废墟里爬出来的指挥官。', traits: { aggression: 95 } })
    const result = await main.ask({ id: 'p', text: '你是谁？' }).catch((error) => ({ ok: false, error: String(error) }))
    // 没有脚本回复时会失败，但 system prompt 已经重建
    assert.equal(result.ok, false)
    assert.match(calls[0].system, /灰烬/)
    assert.match(calls[0].system, /侵略性 95\/100/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
