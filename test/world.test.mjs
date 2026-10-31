import test from 'node:test'
import assert from 'node:assert/strict'

import { diffWorld, mergeDeepContext } from '../agent/lib/world.mjs'

function world(overrides = {}) {
  return {
    date: '2200.01.01',
    colonies: [],
    fleetsAll: [],
    research: { physics: { current: { key: null } }, society: { current: { key: null } }, engineering: { current: { key: null } } },
    government: {},
    leaders: { hired: [] },
    edicts: { active_edicts: [] },
    traditions: { unlocked_traditions: [] },
    activeEvents: [],
    alerts: [],
    notifications: [],
    pendingDiplomacy: { proposals: [] },
    wars: { wars: [] },
    situations: { situations: [] },
    megaScan: { megastructures: [] },
    ...overrides,
  }
}

test('轻量刷新保留 deep 字段：舰队位置 / 银河图 / 殖民地明细', () => {
  const previous = {
    colonies: [{ planet_id: 3, name: 'A', details: { colony_id: 0, system_id: 7 }, jobs: { jobs: [] } }],
    fleetsAll: [{ fleet_id: 1, system_id: 255 }],
    galaxyMap: { rows: [[255, 'F', 0, 0, null, 4, 0, 'SF']] },
    fleetSystems: { 1: 255 },
    systems: { 255: { id: 255 } },
    mods: { total: 1 },
    traditions: { nodes: { tradition_adaptability: [{ key: 'tr_adaptability_adopt' }] } },
  }
  const light = {
    colonies: [{ planet_id: 3, name: 'A2' }],
    fleetsAll: [{ fleet_id: 1, system_id: null }],
    galaxyMap: null,
    fleetSystems: null,
    traditions: { summary: { next_tradition_cost: 100 } },
  }
  const merged = mergeDeepContext(previous, light)
  assert.equal(merged.galaxyMap.rows.length, 1)
  assert.equal(merged.fleetSystems[1], 255)
  assert.equal(merged.fleetsAll[0].system_id, 255)
  assert.equal(merged.colonies[0].name, 'A2')
  assert.equal(merged.colonies[0].details.system_id, 7)
  assert.equal(merged.systems[255].id, 255)
  assert.equal(merged.mods.total, 1)
  assert.equal(merged.traditions.nodes.tradition_adaptability.length, 1)
})

test('研究：开始与完成', () => {
  const prev = world()
  const next = world({ research: { physics: { current: { key: 'tech_a' } }, society: { current: { key: null } }, engineering: { current: { key: null } } } })
  const delta = diffWorld(prev, next)
  assert.ok(delta.events.some((row) => row.type === 'research_started'))

  const done = diffWorld(next, world({ research: { physics: { current: { key: 'tech_b' } }, society: { current: { key: null } }, engineering: { current: { key: null } } } }))
  assert.ok(done.events.some((row) => row.type === 'research_completed' && row.detail.key === 'tech_a'))
})

test('殖民地建立 / 失去', () => {
  const prev = world({ colonies: [{ planet_id: 1, details: {} }] })
  const next = world({ colonies: [{ planet_id: 1, details: {} }, { planet_id: 2, details: {} }] })
  const delta = diffWorld(prev, next)
  assert.ok(delta.events.some((row) => row.type === 'colony_established' && row.componentId === 'planet:2'))
  const lost = diffWorld(next, prev)
  assert.ok(lost.events.some((row) => row.type === 'colony_lost' && row.componentId === 'planet:2'))
})

test('新事件弹窗 → 高优先级触发器', () => {
  const prev = world()
  const next = world({ activeEvents: [{ window_id: 4, id: 'evt.9', title: '突袭' }] })
  const delta = diffWorld(prev, next)
  assert.equal(delta.triggers.length, 1)
  assert.equal(delta.triggers[0].type, 'event_window')
  assert.equal(delta.triggers[0].priority, 100)
  assert.equal(delta.triggers[0].unit, 'event')
})

test('总统换届：事件 + 触发器', () => {
  const prev = world({ government: { ruler_name: '旧总统' } })
  const next = world({ government: { ruler_name: '新总统' } })
  const delta = diffWorld(prev, next)
  assert.ok(delta.events.some((row) => row.type === 'ruler_changed'))
  assert.ok(delta.triggers.some((row) => row.type === 'election_result' && row.unit === 'council'))
})

test('警报：选举类归到 council', () => {
  const prev = world()
  const next = world({ alerts: [{ alert_id: 12, key: 'alert_council_election', title: 'Election' }] })
  const delta = diffWorld(prev, next)
  assert.ok(delta.triggers.some((row) => row.type === 'alert:council'))
})

test('舰队：出现 / 消失 / 订单完成', () => {
  const prev = world({ fleetsAll: [{ fleet_id: 1, status: 'moving' }] })
  const next = world({ fleetsAll: [{ fleet_id: 1, status: 'idle' }, { fleet_id: 2, status: 'idle' }] })
  const delta = diffWorld(prev, next)
  assert.ok(delta.events.some((row) => row.type === 'fleet_appeared' && row.detail.fleet_id === 2))
  assert.ok(delta.events.some((row) => row.type === 'fleet_order_completed' && row.detail.fleet_id === 1))
})

test('政策/传统/法令变化有记录', () => {
  const prev = world()
  const next = world({ edicts: { active_edicts: [{ key: 'edict_x' }] }, traditions: { unlocked_traditions: [{ key: 'tr_a' }] } })
  const delta = diffWorld(prev, next)
  assert.ok(delta.events.some((row) => row.type === 'edict_activated'))
  assert.ok(delta.events.some((row) => row.type === 'tradition_adopted'))
})

test('外交提议 / 新战争变成触发器', () => {
  const prev = world()
  const next = world({
    pendingDiplomacy: { proposals: [{ id: 'p1', kind: 'alliance' }] },
    wars: { wars: [{ war_id: 7, name: 'War' }] },
  })
  const delta = diffWorld(prev, next)
  assert.ok(delta.triggers.some((row) => row.type === 'diplomacy_proposal'))
  assert.ok(delta.triggers.some((row) => row.type === 'war_started'))
})

test('没有变化时不产生事件', () => {
  const same = world({ colonies: [{ planet_id: 1, details: { population: 5 } }] })
  const delta = diffWorld(same, { ...same })
  assert.equal(delta.events.length, 0)
  assert.equal(delta.triggers.length, 0)
})
