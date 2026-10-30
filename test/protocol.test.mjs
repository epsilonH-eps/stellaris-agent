import test from 'node:test'
import assert from 'node:assert/strict'

import { extractJsonBlock, parseMainDecision, parseUnitDecision, parseAnalysis } from '../agent/lib/ai/protocol.mjs'

test('extractJsonBlock：围栏 / 裸对象 / 前后噪声', () => {
  assert.deepEqual(extractJsonBlock('```json\n{"a":1}\n```').value, { a: 1 })
  assert.deepEqual(extractJsonBlock('前言\n```\n{"a":2}\n```\n后记').value, { a: 2 })
  assert.deepEqual(extractJsonBlock('好的：{"a":3} 完毕').value, { a: 3 })
  assert.deepEqual(extractJsonBlock('{"a":{"b":[1,2]},"c":"}"}').value, { a: { b: [1, 2] }, c: '}' })
  assert.equal(extractJsonBlock('没有 JSON').ok, false)
})

test('parseMainDecision：规范化 spawn/intervals/pause', () => {
  const parsed = parseMainDecision(
    '```json\n{"say":"开工","pause":true,"spawn":[{"unit":"research","goal":"点科技"},{"id":"fleet:3"}],"intervals":{"fleet:3":30},"report":"r"}\n```',
  )
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.say, '开工')
  assert.equal(parsed.value.pause, true)
  assert.equal(parsed.value.spawn.length, 2)
  assert.deepEqual(parsed.value.spawn[1], { unit: 'fleet:3', goal: '' })
  assert.deepEqual(parsed.value.intervals, { 'fleet:3': 30 })
})

test('parseMainDecision：非法 spawn 被过滤，非法 interval 被丢弃', () => {
  const parsed = parseMainDecision('{"spawn":[{"goal":"x"},null,"laws"],"intervals":{"a":1}}')
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.value.spawn, [{ unit: 'laws', goal: '' }])
  assert.deepEqual(parsed.value.intervals, {})
})

test('parseUnitDecision：actions 形状 + 默认 status', () => {
  const withActions = parseUnitDecision('{"actions":[{"method":"a","params":{"x":1}},{"action":"b"}],"say":"hi"}')
  assert.equal(withActions.ok, true)
  assert.equal(withActions.value.actions.length, 2)
  assert.equal(withActions.value.status, 'continue')
  assert.equal(withActions.value.done, true)

  const idle = parseUnitDecision('{"actions":[]}')
  assert.equal(idle.value.status, 'ok')

  const blocked = parseUnitDecision('{"actions":[],"status":"blocked","cause":"没资源"}')
  assert.equal(blocked.value.status, 'blocked')
  assert.equal(blocked.value.cause, '没资源')
})

test('parseAnalysis：失败分析字段', () => {
  const parsed = parseAnalysis('```json\n{"cause":"key 不存在","evidence":"unknown tech","suggestion":"换 tech_lasers_2","retry":[{"method":"select_research"}]}\n```')
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.cause, 'key 不存在')
  assert.equal(parsed.value.retry.length, 1)
})

test('解析失败时返回错误而不是抛异常', () => {
  const parsed = parseMainDecision('模型开始胡说八道')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.value, null)
  assert.ok(parsed.error)
})
