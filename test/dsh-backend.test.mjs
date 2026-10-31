import test from 'node:test'
import assert from 'node:assert/strict'

import { DshBackend } from '../agent/lib/ai/dsh.mjs'

test('DSH 后端：主会话把存档 sessionId 同时放进 label 与字段', async () => {
  const calls = []
  const backend = new DshBackend({
    config: { ai: { dsh: { url: 'http://127.0.0.1:49939', autoDiscover: false } } },
    fetchImpl: async (url, options) => {
      calls.push({ url: String(url), body: JSON.parse(options.body) })
      return { ok: true, json: async () => ({ ok: true, text: 'ok' }) }
    },
  })
  backend.setMainSession({ sessionId: 'stellaris-main-abc', saveKey: 'abc', saveFolder: '2_1', saveName: '人类游牧方舟 2', workspace: 'C:\\Users\\test\\.stellaris-agent\\workspace' })
  backend.discovered = { url: 'http://127.0.0.1:49939', at: Date.now() }
  await backend.complete({ system: 'sys', messages: [], label: 'main' })
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /\/api\/stellaris-orchestrator\/run$/)
  assert.match(calls[0].body.label, /^main:stellaris-main-abc#[^#]+#[^#]+$/)
  assert.equal(calls[0].body.sessionId, 'stellaris-main-abc')
  assert.equal(calls[0].body.saveKey, 'abc')
  assert.equal(calls[0].body.saveName, '人类游牧方舟 2')
  assert.equal(calls[0].body.workspace, 'C:\\Users\\test\\.stellaris-agent\\workspace')
})

test('DSH 后端：子会话不改变 label，也不带主会话字段', async () => {
  const calls = []
  const backend = new DshBackend({
    config: { ai: { dsh: { url: 'http://127.0.0.1:49939', autoDiscover: false } } },
    fetchImpl: async (url, options) => {
      calls.push({ body: JSON.parse(options.body) })
      return { ok: true, json: async () => ({ ok: true, text: 'ok' }) }
    },
  })
  backend.setMainSession({ sessionId: 'stellaris-main-abc', saveKey: 'abc' })
  backend.discovered = { url: 'http://127.0.0.1:49939', at: Date.now() }
  await backend.complete({ system: 'sys', messages: [], label: 'unit:research' })
  assert.equal(calls[0].body.label, 'unit:research')
  assert.equal(calls[0].body.sessionId, undefined)
})
