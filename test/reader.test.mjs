import test from 'node:test'
import assert from 'node:assert/strict'

import { Reader, extractColonies, extractFleets } from '../agent/lib/reader.mjs'

class FakeBridge {
  constructor(handlers = {}) {
    this.handlers = handlers
    this.calls = []
  }

  async request(method, params = {}) {
    this.calls.push({ method, params })
    const handler = this.handlers[method]
    if (typeof handler === 'function') return handler(params)
    if (handler !== undefined) return handler
    throw new Error(`Unknown method: ${method}`)
  }
}

function baseHandlers() {
  return {
    get_status: {
      in_game: true,
      date: { formatted: '2200.02.01' },
      is_paused: false,
      speed: 2,
      resources: { energy: { stockpile: 100, net: 5 } },
      outliner: { sectors_summary: { sectors: [{ colonies_summary: [{ planet_id: 3, name: 'Earth', pops: 10 }] }] } },
    },
    get_outliner: { sectors_summary: { sectors: [{ colonies_summary: [{ planet_id: 3, name: 'Earth', pops: 10 }] }] } },
    get_sectors: { sectors: [] },
    get_government: { ruler_name: 'A', government_type: 'democratic' },
    get_civics: { civics: [] },
    get_edicts: { active_edicts: [] },
    get_traditions: { unlocked_traditions: [] },
    get_research_state: { physics: { current: { key: 't1' } } },
    get_leaders: { hired: [] },
    get_species: () => ({ species: [] }),
    get_market: { resources: [] },
    get_contacts: { empires: [{ country_id: 2, name: 'Neighbour' }] },
    get_pending_diplomacy: { proposals: [] },
    get_wars: { wars: [] },
    get_active_events: [{ window_id: 5, id: 'evt.1', title: 'Test' }],
    get_alerts: [],
    get_notifications: [],
    get_situation_log: { situations: [] },
    get_galaxy_overview: { player: { owned_systems: 4 } },
    get_fleets: (params) => (params.fleet_id ? { fleet_id: params.fleet_id, status: 'idle' } : { fleets: [{ fleet_id: 1, name: '1st' }] }),
    get_military_fleets: { fleets: [{ fleet_id: 1, name: '1st', system_id: 7 }] },
    get_civilian_fleets: { science_ships: [], construction_ships: [], colony_ships: [] },
    get_armies: { armies: [] },
    get_ship_designs: { designs: [] },
    get_ship_design_catalog: {},
    get_discoveries: () => {
      throw new Error('Unknown method: get_discoveries')
    },
    get_planet_details: { system_id: 7, planet_name: 'Earth', population: 10, construction_queue: [] },
    get_planet_jobs: { jobs: [] },
    get_planet_armies: { total_stationed_armies: 2 },
    get_buildable_buildings: { buildable: [] },
    get_buildable_districts: { buildable: [] },
    get_available_district_zones: { zones: [] },
    get_clearable_blockers: { blockers: [] },
    get_planetary_decisions: { decisions: [] },
    get_planetary_features: { features: [] },
    get_terraforming_options: { options: [] },
    get_system: { system_id: 7, megastructures: [{ id: 9, type: 'mega' }] },
    get_diplomacy_options: { options: [] },
    get_galaxy_map: { rows: [[7, 'Sol', null, null, 0, null, null, 'M']] },
  }
}

const fakeGraph = {
  successors: (id) => ({ root: { id, title: 'Root' }, nodes: [{ id, level: 0 }, { id: `${id}.next`, level: 1, title: 'Next' }] }),
  status: () => ({ ready: true, events: 2, files: 1 }),
}

test('extractColonies / extractFleets 兼容多种结构', () => {
  const world = {
    outliner: { sectors_summary: { sectors: [{ colonies_summary: [{ planet_id: 3, name: 'A' }] }] } },
    status: { colonies: [{ planet_id: 4, name: 'B' }] },
    fleets: { fleets: [{ fleet_id: 1 }] },
    militaryFleets: { fleets: [{ fleet_id: 2 }] },
    civilianFleets: { science_ships: [{ fleet_id: 3 }], construction_ships: [{ fleet_id: 4 }] },
  }
  const colonies = extractColonies(world)
  assert.deepEqual(colonies.map((row) => row.planet_id).sort(), [3, 4])
  const fleets = extractFleets(world)
  assert.deepEqual(fleets.map((row) => row.fleet_id).sort(), [1, 2, 3, 4])
})

test('全量读取：全局 + 殖民地 + 舰队 + 事件链（含后续）', async () => {
  const bridge = new FakeBridge(baseHandlers())
  const reader = new Reader({
    bridge,
    config: { read: { includeDiplomacyOptions: true, includeGalaxyMap: true } },
    home: 'C:/tmp/stellaris-agent-test',
    paths: { userDir: '', installDir: '' },
  })
  const world = await reader.readWorld({ deep: true, includeSave: false, eventGraph: fakeGraph })

  assert.equal(world.inGame, true)
  assert.equal(world.date, '2200.02.01')
  assert.equal(world.colonies.length, 1)
  assert.equal(world.colonies[0].details.system_id, 7)
  assert.equal(world.colonies[0].jobs?.jobs?.length, 0)
  assert.equal(world.fleetsAll.length, 1)
  assert.equal(world.fleetsDetail.length, 1)
  assert.equal(world.systems['7'].megastructures.length, 1)
  assert.equal(world.activeEvents.length, 1)
  assert.equal(world.eventChains.active.length, 1)
  assert.equal(world.eventChains.active[0].chain.nodes.length, 2)
  assert.equal(world.diplomacyOptions.length, 1)
  assert.ok(world.megaScan.megastructures.length >= 1)
  assert.ok(Array.isArray(world.errors))
  assert.equal(world.mods.total, 0)
  assert.equal(world.unsupported.includes('get_discoveries'), true)
  assert.ok(world.stats.calls > 20)
})

test('不支持的方法只记一次，后续直接跳过', async () => {
  let calls = 0
  const handlers = baseHandlers()
  handlers.get_discoveries = () => {
    calls += 1
    throw new Error('Unknown method: get_discoveries')
  }
  const bridge = new FakeBridge(handlers)
  const reader = new Reader({ bridge, config: { read: {} }, home: 'C:/tmp/x', paths: {} })
  await reader.readWorld({ deep: false, includeSave: false })
  assert.equal(calls, 1)
  assert.equal(reader.unsupported.has('get_discoveries'), true)

  const before = bridge.calls.filter((call) => call.method === 'get_discoveries').length
  await reader.readWorld({ deep: false, includeSave: false })
  const after = bridge.calls.filter((call) => call.method === 'get_discoveries').length
  assert.equal(after, before, '第二次不应再调用已知不支持的方法')
})

test('读失败不会中断整体，错误里带方法与错误码', async () => {
  const handlers = baseHandlers()
  handlers.get_leaders = () => {
    throw Object.assign(new Error('boom'), { code: 'RPC_ERROR' })
  }
  const bridge = new FakeBridge(handlers)
  const reader = new Reader({ bridge, config: { read: {} }, home: 'C:/tmp/x', paths: {} })
  const world = await reader.readWorld({ deep: false, includeSave: false })
  assert.equal(world.leaders, null)
  const failure = world.errors.find((row) => row.method === 'get_leaders')
  assert.ok(failure)
  assert.equal(failure.code, 'RPC_ERROR')
})
