import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { saveIdentity } from '../agent/lib/save.mjs'
import { MainSessionStore } from '../agent/lib/main-sessions.mjs'
import { MainSession } from '../agent/lib/ai/main.mjs'
import { Orchestrator } from '../agent/lib/orchestrator.mjs'

function saveState(folder, name = 'Test Empire', date = '2206.01.01') {
  return {
    dir: 'C:/saves',
    latest: { file: `C:/saves/${folder}/${date}.sav`, name: `${date}.sav` },
    meta: { name, version: 'Cygnus v4.5.2', date },
  }
}

test('存档身份：同一目录的 autosave/manual 是同一个主会话', () => {
  const a = saveIdentity(saveState('2_556003495', 'Empire', '2206.01.01'))
  const b = saveIdentity(saveState('2_556003495', 'Empire', '2206.07.01'))
  const other = saveIdentity(saveState('_-1766688091', 'Empire', '2262.01.01'))
  assert.equal(a.key, b.key)
  assert.notEqual(a.key, other.key)
  assert.equal(a.sessionId, `stellaris-main-${a.key}`)
  assert.equal(a.folder, '2_556003495')
})

test('存档身份：版本/标题变化不会让同一目录换主会话', () => {
  const a = saveState('2_556003495', '人类游牧方舟 2')
  const b = { ...a, meta: { ...a.meta, version: 'Cygnus v4.5.3', name: '人类游牧方舟 2（改名）' } }
  assert.equal(saveIdentity(a).key, saveIdentity(b).key)
  assert.equal(saveIdentity(a).sessionId, saveIdentity(b).sessionId)
})

test('MainSessionStore：每个 saveKey 独立持久化', () => {
  const home = mkdtempSync(join(tmpdir(), 'stellaris-main-sessions-'))
  try {
    const store = new MainSessionStore({ home })
    const keyA = saveIdentity(saveState('A')).key
    const keyB = saveIdentity(saveState('B')).key
    store.save(keyA, { objective: 'A 的目标', messages: [{ role: 'user', content: 'A' }], turns: 1 })
    store.save(keyB, { objective: 'B 的目标', messages: [{ role: 'user', content: 'B' }], turns: 1 })
    assert.equal(store.load(keyA).objective, 'A 的目标')
    assert.equal(store.load(keyB).objective, 'B 的目标')
    assert.equal(store.list().length, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('编排器：切换存档时换主会话，并保留各自的 transcript', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stellaris-main-switch-'))
  try {
    const orch = new Orchestrator({ config: { ai: { main: { historyMessages: 24 } } }, home, log: () => {} })
    const backendCalls = []
    orch.backend = { setMainSession: (value) => backendCalls.push(value) }
    const a = saveState('A', 'Empire A')
    const b = saveState('B', 'Empire B')
    const keyA = saveIdentity(a).key
    const keyB = saveIdentity(b).key
    await orch.switchMainSave(a, { reason: 'start' })
    assert.equal(orch.mainSave.key, keyA)
    assert.equal(orch.main.dshSessionId, `stellaris-main-${keyA}`)
    assert.equal(backendCalls.at(-1).sessionId, `stellaris-main-${keyA}`)
    assert.equal(backendCalls.at(-1).saveName, 'Empire A')
    orch.main.session.pushUser('A 存档的问题')
    orch.persistMain()

    await orch.switchMainSave(b, { reason: 'start' })
    assert.equal(orch.mainSave.key, keyB)
    assert.equal(backendCalls.at(-1).sessionId, `stellaris-main-${keyB}`)
    assert.equal(orch.main.session.messages.length, 0)
    orch.main.session.pushUser('B 存档的问题')
    orch.persistMain()

    await orch.switchMainSave(a, { reason: 'start' })
    assert.equal(orch.mainSave.key, keyA)
    assert.equal(orch.main.session.messages[0].content, 'A 存档的问题')
    assert.equal(orch.main.dshSessionId, `stellaris-main-${keyA}`)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('主会话：恢复某个存档的 transcript，并导出新状态', () => {
  const home = mkdtempSync(join(tmpdir(), 'stellaris-main-transcript-'))
  try {
    const info = saveIdentity(saveState('2_1', 'Empire'))
    const transcript = {
      messages: [
        { role: 'user', content: '第一轮问题', ts: 1 },
        { role: 'assistant', content: '第一轮回答', ts: 2 },
      ],
      turns: 1,
    }
    const main = new MainSession({
      backend: null,
      config: { ai: { main: { historyMessages: 24 } } },
      executor: { status: () => ({}) },
      chat: { outbound: () => {}, takePending: () => [] },
      getWorld: () => null,
      getUnits: () => [],
      getCompletions: () => [],
      dispatch: async () => {},
      home,
      saveInfo: info,
      transcript,
      onStateChange: () => {},
    })
    assert.equal(main.session.messages.length, 2)
    assert.equal(main.session.messages[0].content, '第一轮问题')
    assert.equal(main.turns, 1)
    const state = main.exportState()
    assert.equal(state.saveKey, info.key)
    assert.equal(state.dshSessionId, info.sessionId)
    assert.equal(state.messages.length, 2)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
