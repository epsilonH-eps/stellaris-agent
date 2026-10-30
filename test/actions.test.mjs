import test from 'node:test'
import assert from 'node:assert/strict'

import {
  ACTIONS,
  ACTION_BY_METHOD,
  UNIT_TYPES,
  READ_METHODS,
  actionsForUnit,
  describeActions,
  validateAction,
  validateActions,
  isMutating,
} from '../agent/lib/actions.mjs'

test('动作目录：方法名唯一、单位存在、参数形状完整', () => {
  const seen = new Set()
  for (const action of ACTIONS) {
    assert.ok(!seen.has(action.method), `重复动作 ${action.method}`)
    seen.add(action.method)
    assert.ok(UNIT_TYPES[action.unit], `${action.method} 的单位 ${action.unit} 不存在`)
    assert.ok(Object.keys(action.params).length >= 0)
    for (const required of action.required || []) {
      assert.ok(required in action.params, `${action.method} 必填参数 ${required} 不在 params 里`)
    }
    assert.ok(action.desc && action.desc.length > 2, `${action.method} 缺少描述`)
  }
})

test('单位白名单里的动作都真实存在', () => {
  for (const [type, meta] of Object.entries(UNIT_TYPES)) {
    for (const method of meta.actions) {
      assert.ok(ACTION_BY_METHOD.has(method), `${type} 引用了不存在的动作 ${method}`)
    }
    assert.ok(actionsForUnit(type).length === meta.actions.length)
  }
})

test('verify 规格引用的回读方法都在读取表里', () => {
  const readMethods = new Set(READ_METHODS.map((row) => row.method))
  for (const action of ACTIONS) {
    if (!action.verify) continue
    assert.ok(readMethods.has(action.verify.read), `${action.method} 回读方法 ${action.verify.read} 不在 READ_METHODS`)
    if (action.verify.equalsParam) assert.ok(action.verify.equalsParam in action.params)
    if (action.verify.includesParam) assert.ok(action.verify.includesParam in action.params)
    if (action.verify.params) {
      for (const key of action.verify.params) assert.ok(key in action.params, `${action.method} verify.params 引用了不存在的参数 ${key}`)
    }
  }
})

test('validateAction：必填、类型、未知参数', () => {
  assert.equal(validateAction({ method: 'set_paused', params: { paused: true } }).ok, true)
  assert.equal(validateAction({ method: 'set_paused', params: {} }).ok, false)
  assert.equal(validateAction({ method: 'set_paused', params: { paused: 'yes' } }).ok, false)
  assert.equal(validateAction({ method: 'set_speed', params: { speed: 3.5 } }).ok, false)
  assert.equal(validateAction({ method: 'set_speed', params: { speed: 3 } }).ok, true)
  const unknown = validateAction({ method: 'set_speed', params: { speed: 3, nope: 1 } })
  assert.equal(unknown.ok, false)
  assert.match(unknown.errors.join(' '), /不认识参数/)
  assert.equal(validateAction({ method: 'not_a_method', params: {} }).ok, false)
})

test('validateAction：单位越权被拒绝（event 可以用暂停）', () => {
  const action = { method: 'select_research', params: { slot: 'physics', tech_key: 't1' } }
  assert.equal(validateAction(action, { unitType: 'research' }).ok, true)
  assert.equal(validateAction(action, { unitType: 'planet' }).ok, false)
  assert.equal(validateAction({ method: 'set_paused', params: { paused: true } }, { unitType: 'event' }).ok, true)
  assert.equal(validateAction({ method: 'set_paused', params: { paused: true } }, { unitType: 'fleet' }).ok, false)
})

test('validateActions：批量收集所有错误', () => {
  const result = validateActions([
    { method: 'set_paused', params: { paused: true } },
    { method: 'focus_planet', params: {} },
    { method: 'bogus', params: {} },
  ])
  assert.equal(result.ok, false)
  assert.equal(result.errors.length, 2)
  assert.match(result.errors[0], /#2/)
  assert.match(result.errors[1], /#3/)
})

test('describeActions 可按单位过滤', () => {
  const all = describeActions()
  assert.ok(all.length >= 40)
  const planet = describeActions({ unit: 'planet' })
  assert.ok(planet.every((row) => row.unit === 'planet'))
  assert.ok(planet.some((row) => row.method === 'build_building'))
})

test('isMutating：纯界面动作不算写', () => {
  assert.equal(isMutating('focus_planet'), false)
  assert.equal(isMutating('show_panel'), false)
  assert.equal(isMutating('build_building'), true)
})
