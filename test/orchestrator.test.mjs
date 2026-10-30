import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Orchestrator } from '../agent/lib/orchestrator.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeBridge {
  constructor() {
    this.calls = []
    this.connected = true
    this.pipeName = 'fake-pipe'
    this.handlers = {
      get_status: () => ({
        in_game: true,
        date: { formatted: '2200.03.01' },
        is_paused: false,
        speed: 2,
        resources: { energy: { stockpile: 200, net: 12 }, alloys: { stockpile: 50, net: 3 } },
        outliner: { sectors_summary: { sectors: [{ colonies_summary: [{ planet_id: 3, name: 'Earth', pops: 12 }] }] } },
      }),
      get_outliner: () => ({ sectors_summary: { sectors: [{ colonies_summary: [{ planet_id: 3, name: 'Earth', pops: 12 }] }] } }),
      get_military_fleets: () => ({ fleets: [{ fleet_id: 1, name: '第一舰队', system_id: 7, status: 'idle' }] }),
      get_fleets: (params) => (params?.fleet_id ? { fleet_id: params.fleet_id, status: 'idle', system_id: 7 } : { fleets: [{ fleet_id: 1, name: '第一舰队' }] }),
      get_planet_details: () => ({ system_id: 7, planet_name: 'Earth', population: 12, construction_queue: [] }),
      get_system: () => ({ system_id: 7, megastructures: [] }),
      get_active_events: () => [],
      get_alerts: () => [],
      get_notifications: () => [],
      get_research_state: () => ({ physics: { current: { key: null }, options: [{ key: 'tech_a' }] } }),
      get_government: () => ({ ruler_name: 'A', government_type: 'democratic' }),
      get_leaders: () => ({ hired: [] }),
      get_edicts: () => ({ active_edicts: [] }),
      get_traditions: () => ({ unlocked_traditions: [] }),
      get_contacts: () => ({ empires: [] }),
      get_pending_diplomacy: () => ({ proposals: [] }),
      get_wars: () => ({ wars: [] }),
      get_situations: () => ({ situations: [] }),
      get_situation_log: () => ({ situations: [] }),
      get_galaxy_overview: () => ({ player: { owned_systems: 3 } }),
      set_paused: (params) => ({ ok: true, requested: params.paused }),
      resolve_event: () => ({ ok: true }),
      focus_planet: () => ({ ok: true }),
    }
  }

  async request(method, params = {}) {
    this.calls.push({ method, params })
    const handler = this.handlers[method]
    if (handler) return handler(params)
    if (method.startsWith('get_')) return {}
    throw new Error(`unexpected method ${method}`)
  }

  count(method) {
    return this.calls.filter((call) => call.method === method)
  }
}

function fakeBackend(replies) {
  const queue = [...replies]
  return {
    name: 'deepseek',
    available: true,
    describe: () => ({ backend: 'deepseek', model: 'fake-model', ok: true }),
    async health() {
      return { ok: true }
    },
    async complete() {
      const text = queue.shift() || '{"say":"","actions":[]}'
      return { text, usage: null, model: 'fake-model', backend: 'deepseek' }
    },
  }
}

function makeConfig(root) {
  const userDir = join(root, 'user')
  const installDir = join(root, 'game')
  mkdirSync(join(userDir, 'mod'), { recursive: true })
  mkdirSync(join(installDir, 'events'), { recursive: true })
  return {
    version: 2,
    paths: { stellarisUserDir: userDir, stellarisInstallDir: installDir, saveDir: join(root, 'saves') },
    read: { deep: true, refreshSeconds: 9999, includeDiplomacyOptions: false, includeGalaxyMap: false, includeCivilianFleets: false },
    executor: { pauseWhenQueuedActions: 8, resumeWhenQueuedActionsBelow: 2, autoPause: true, autoResume: true, maxAttempts: 2, retryDelayMs: 0 },
    ai: {
      backend: 'deepseek',
      deepseek: { apiKey: 'test', maxTokens: 100 },
      main: { activateOnStart: false, intervalSeconds: 9999 },
      unit: { attempts: 1, maxActionsPerTurn: 2 },
      event: { attempts: 1, maxActionsPerTurn: 2, processOnStart: false },
    },
    units: { research: true, council: true, laws: true, economy: true, diplomacy: true, fleets: true, planets: true },
    chat: { port: 0, maxHistory: 50 },
    journal: { enabled: false },
    log: { level: 'error' },
  }
}

test('编排器：启动 → 全量读取 → 发现 1:1 单位 → 执行 → 停止', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stellaris-orch-'))
  const bridge = new FakeBridge()
  const orchestrator = new Orchestrator({ config: makeConfig(root), home: root, log: () => {} })
  try {
    const status = await orchestrator.start({ objective: '测试目标', bridge, backend: fakeBackend([]) })
    assert.equal(status.running, true)
    assert.equal(status.objective, '测试目标')
    assert.equal(status.world.inGame, true)
    assert.equal(status.world.colonies, 1)
    assert.equal(status.world.fleets, 1)
    const ids = status.units.map((unit) => unit.id).sort()
    for (const expected of ['council', 'diplomacy', 'economy', 'fleet:1', 'laws', 'planet:3', 'research']) {
      assert.ok(ids.includes(expected), `缺少单位 ${expected}（实际 ${ids.join(',')}）`)
    }
    assert.equal(orchestrator.main.backend, orchestrator.backend)

    const result = await orchestrator.execute([{ method: 'focus_planet', params: { planet_id: 3 } }])
    assert.equal(result.ok, true)
    assert.equal(bridge.count('focus_planet').length, 1)

    // 会话列表：主会话置顶 + 每个单位一个
    const sessions = orchestrator.sessions()
    assert.equal(sessions[0].id, 'main')
    assert.equal(sessions[0].kind, 'main')
    const sessionIds = sessions.map((row) => row.id)
    assert.ok(sessionIds.includes('planet:3'))
    assert.ok(sessionIds.includes('fleet:1'))
    assert.ok(sessionIds.includes('research'))
    const mainDetail = orchestrator.sessionDetail('main')
    assert.equal(mainDetail.id, 'main')
    assert.ok(Array.isArray(mainDetail.messages))
    assert.ok(mainDetail.systemChars > 0)
    const planetDetail = orchestrator.sessionDetail('planet:3')
    assert.equal(planetDetail.unit.type, 'planet')
    assert.equal(planetDetail.unit.key, 3)
    assert.equal(orchestrator.sessionDetail('nope'), null)

    const invalid = await orchestrator.execute([{ method: 'nope', params: {} }])
    assert.equal(invalid.ok, false)
    assert.equal(invalid.error, 'VALIDATION')

    const paused = await orchestrator.pause()
    assert.equal(paused.ok, true)
    assert.equal(bridge.count('set_paused').at(-1).params.paused, true)
    await orchestrator.resume()
    assert.equal(bridge.count('set_paused').at(-1).params.paused, false)
  } finally {
    await orchestrator.stop({ resume: false })
    assert.equal(orchestrator.running, false)
    rmSync(root, { recursive: true, force: true })
  }
})

test('编排器：事件触发器拉起特殊事件子会话并执行 resolve_event', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stellaris-orch-event-'))
  const bridge = new FakeBridge()
  const backend = fakeBackend(['```json\n{"say":"选第一项","actions":[{"method":"resolve_event","params":{"window_id":9,"option_index":0}}]}\n```'])
  const orchestrator = new Orchestrator({ config: makeConfig(root), home: root, log: () => {} })
  try {
    await orchestrator.start({ bridge, backend })
    // 模拟 world 发现新事件弹窗
    orchestrator.handleTrigger({ type: 'event_window', priority: 100, unit: 'event', payload: { window_id: 9, id: 'evt.9', title: '突发' }, at: Date.now() })
    for (let i = 0; i < 40 && bridge.count('resolve_event').length === 0; i += 1) await sleep(25)
    const calls = bridge.count('resolve_event')
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].params, { window_id: 9, option_index: 0 })
    // 事件处理前暂停、处理后恢复
    const pauses = bridge.count('set_paused').map((call) => call.params.paused)
    assert.ok(pauses.includes(true))
    await sleep(50)
    assert.equal(bridge.count('set_paused').at(-1).params.paused, false)
    // 报告已进入主会话待处理队列
    assert.ok(orchestrator.main.status().pendingReports >= 0)
    // 会话列表里有这次特殊事件（已结束，仍可回看）
    const eventId = 'event:9'
    const ids = orchestrator.sessions().map((row) => row.id)
    assert.ok(ids.includes(eventId), `会话列表应包含 ${eventId}（实际 ${ids.join(',')}）`)
    const detail = orchestrator.sessionDetail(eventId)
    assert.ok(detail)
    assert.equal(detail.kind, 'event')
    assert.equal(detail.windowId, 9)
    assert.ok(detail.messages.length >= 2)
  } finally {
    await orchestrator.stop({ resume: false })
    rmSync(root, { recursive: true, force: true })
  }
})

test('编排器：游戏停在主菜单时抛 GAME_NOT_IN_SESSION', async () => {
  const root = mkdtempSync(join(tmpdir(), 'stellaris-orch-lobby-'))
  const bridge = new FakeBridge()
  bridge.handlers.get_status = () => ({ in_game: false, date: null, outliner: { sectors_summary: { sectors: [] } } })
  const orchestrator = new Orchestrator({ config: makeConfig(root), home: root, log: () => {} })
  try {
    await assert.rejects(
      () => orchestrator.start({ bridge, backend: fakeBackend([]) }),
      (error) => error.code === 'GAME_NOT_IN_SESSION',
    )
    assert.equal(orchestrator.running, false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
