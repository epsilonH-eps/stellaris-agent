import test from 'node:test'
import assert from 'node:assert/strict'

import { ChatHub } from '../agent/lib/chat.mjs'
import { ChatHub as _unused } from '../agent/lib/chat.mjs'

test('入站：必须带 id 与 text', () => {
  const hub = new ChatHub({ config: { chat: { maxHistory: 10 } } })
  assert.equal(hub.inbound({ text: 'hi' }).error, 'MISSING_ID')
  assert.equal(hub.inbound({ id: 'player' }).error, 'EMPTY_TEXT')
  const ok = hub.inbound({ id: 'player:1', text: '你好' })
  assert.equal(ok.ok, true)
  assert.equal(ok.message.seq, 1)
  assert.equal(hub.hasPending(), true)
})

test('出站 + 轮询游标', () => {
  const hub = new ChatHub({ config: { chat: { maxHistory: 10 } } })
  hub.inbound({ id: 'p1', text: 'A' })
  hub.outbound({ text: 'B' })
  hub.inbound({ id: 'p2', text: 'C' })
  const all = hub.poll({ since: 0 })
  assert.equal(all.messages.length, 3)
  assert.equal(all.next, 3)
  const tail = hub.poll({ since: 2 })
  assert.deepEqual(tail.messages.map((row) => row.text), ['C'])
  assert.equal(tail.last, 3)
})

test('待处理人话只消费一次', () => {
  const hub = new ChatHub({ config: { chat: { maxHistory: 10 } } })
  hub.inbound({ id: 'p', text: '1' })
  hub.inbound({ id: 'p', text: '2' })
  assert.equal(hub.takePending().length, 2)
  assert.equal(hub.takePending().length, 0)
  assert.equal(hub.hasPending(), false)
})

test('历史裁剪 + transcript 角色映射', () => {
  const hub = new ChatHub({ config: { chat: { maxHistory: 20 } } })
  for (let i = 0; i < 30; i += 1) hub.inbound({ id: `p${i}`, text: `m${i}` })
  assert.equal(hub.messages.length, 20)
  hub.outbound({ text: 'reply' })
  const transcript = hub.transcript({ limit: 3 })
  assert.equal(transcript.at(-1).role, 'main')
  assert.equal(transcript.at(-1).text, 'reply')
  assert.equal(hub.status().pending, 30)
})

test('空出站被拒绝', () => {
  const hub = new ChatHub({ config: { chat: { maxHistory: 10 } } })
  assert.equal(hub.outbound({ text: '   ' }).error, 'EMPTY_TEXT')
  assert.equal(_unused, ChatHub)
})
