import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { EventGraph, resolveActiveChains, eventIdOf } from '../agent/lib/events.mjs'

const EVENT_FILE = `country_event = {
	id = test.1
	title = test.1.name
	option = {
		name = test.1.a
		country_event = { id = test.2 }
	}
}

country_event = {
	id = test.2
	title = test.2.name
	option = {
		name = test.2.a
		country_event = { id = test.3 }
	}
}

country_event = {
	id = test.3
	title = test.3.name
}
`

const MOD_EVENT_FILE = `country_event = {
	id = mod.1
	title = mod.1.name
}
`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'stellaris-events-'))
  const installDir = join(root, 'game')
  const home = join(root, 'home')
  const modDir = join(root, 'mod-a')
  mkdirSync(join(installDir, 'events'), { recursive: true })
  mkdirSync(join(modDir, 'events'), { recursive: true })
  mkdirSync(home, { recursive: true })
  writeFileSync(join(installDir, 'events', 'test_events.txt'), EVENT_FILE, 'utf8')
  writeFileSync(join(modDir, 'events', 'mod_events.txt'), MOD_EVENT_FILE, 'utf8')
  return { root, installDir, home, modDir }
}

test('事件图：原版事件被索引，后继树可展开', () => {
  const { root, installDir, home } = fixture()
  try {
    const graph = new EventGraph({ home, installDir }).build()
    assert.equal(graph.status().ready, true)
    assert.ok(graph.status().events >= 3)
    assert.equal(graph.status().files, 1)

    const chain = graph.successors('test.1', 3)
    assert.ok(chain)
    assert.equal(chain.root.id, 'test.1')
    const ids = chain.nodes.map((node) => node.id)
    assert.ok(ids.includes('test.1'))
    assert.ok(ids.includes('test.2'))
    assert.ok(ids.includes('test.3'), '应展开到第二层后继')
    assert.equal(graph.successors('nope.1'), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('事件图：模组事件目录被合并（原版 + 模组都能读）', () => {
  const { root, installDir, home, modDir } = fixture()
  try {
    const vanilla = new EventGraph({ home, installDir }).build()
    assert.equal(vanilla.info('mod.1'), null)

    const withMods = new EventGraph({ home, installDir, modEventDirs: [join(modDir, 'events')] }).build()
    assert.ok(withMods.info('mod.1'), '模组事件应进入索引')
    assert.ok(withMods.info('test.1'), '原版事件仍在')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('事件图：缓存命中后事件与文件数保持一致（不重复计文件）', () => {
  const { root, installDir, home } = fixture()
  try {
    const first = new EventGraph({ home, installDir }).build()
    const firstStatus = first.status()
    assert.equal(firstStatus.cacheHit, false)

    const second = new EventGraph({ home, installDir }).build()
    const secondStatus = second.status()
    assert.equal(secondStatus.cacheHit, true)
    assert.equal(secondStatus.events, firstStatus.events)
    assert.equal(secondStatus.files, firstStatus.files)
    assert.equal(secondStatus.files, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveActiveChains：把当前弹窗接到事件链后续上', () => {
  const { root, installDir, home } = fixture()
  try {
    const graph = new EventGraph({ home, installDir }).build()
    const active = [{ window_id: 7, id: 'test.2', title: '测试事件', options: [{ text: '确定', enabled: true }] }]
    const result = resolveActiveChains(graph, active, { depth: 3 })
    assert.equal(result.count, 1)
    const row = result.active[0]
    assert.equal(row.windowId, 7)
    assert.equal(row.id, 'test.2')
    assert.equal(row.options.length, 1)
    assert.ok(row.chain)
    const ids = row.chain.nodes.map((node) => node.id)
    assert.ok(ids.includes('test.2'))
    assert.ok(ids.includes('test.3'))
    assert.deepEqual(result.unresolved, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveActiveChains：未知事件进 unresolved，不崩', () => {
  const { root, installDir, home } = fixture()
  try {
    const graph = new EventGraph({ home, installDir }).build()
    const result = resolveActiveChains(graph, [{ window_id: 1, id: 'ghost.1' }])
    assert.equal(result.active.length, 1)
    assert.equal(result.active[0].chain, null)
    assert.deepEqual(result.unresolved, ['ghost.1'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('eventIdOf 兼容多种字段名', () => {
  assert.equal(eventIdOf({ id: 'a.1' }), 'a.1')
  assert.equal(eventIdOf({ event_id: 'b.2' }), 'b.2')
  assert.equal(eventIdOf({ key: 'c.3' }), 'c.3')
  assert.equal(eventIdOf({}), null)
  assert.equal(eventIdOf(null), null)
})
