/**
 * 编译器：动作 → 一行一条的控制台命令。
 *
 * **4.5 "Cygnus" 适配**：全局变量（`set_global_variable`）在 4.5 已经不存在，
 * 所以不再用「全局计数器」定位第 N 个对象。4.5 原生提供：
 *
 *   ordered_owned_planet = { position = N <effects> save_event_target_as = dsh_hit }
 *   ordered_owned_leader / ordered_owned_fleet / ordered_country  同理
 *
 * 于是寻址变成：
 *   1. ordered_* 用 position 命中第 N 个（0 基，和模组导出的迭代序一致）；
 *   2. 命中后把对象存成局部事件目标 `dsh_hit`；
 *   3. 循环外按 `exists = event_target:dsh_hit` 写 done / fail。
 *
 * 好处：不依赖任何变量；position 越界不会命中，自然走 fail。
 *
 * @module dsh-stellaris-bridge/compiler
 */
import { CATALOGUE } from './actions.js'

const MAX_LINE = 5900

export class CompileError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

function ackLog(cmd, phase) {
  return `log = "DSH1|0|ACK|cmd=${cmd}|phase=${phase}"`
}

export function makeCmdId(planId, index, lane = 0) {
  return `l${Number(lane) || 0}-${planId}-${index}`
}

export function resolvePlanet(state, query, options = {}) {
  const text = String(query ?? '').trim()
  if (!text) throw new CompileError('MISSING_PARAM', 'planet 不能为空')
  if (text.toLowerCase() === 'capital') return { kind: 'capital' }
  const found = state.findPlanet(text)
  if (!found) {
    const names = state.current.planets.slice(0, 12).map((p) => `[${p.ord}] ${p.name}`).join('，')
    throw new CompileError('UNKNOWN_PLANET', `找不到星球「${text}」。已知：${names || '（还没有快照）'}`)
  }
  if (options.staleLimit && state.ageMs > options.staleLimit && !options.force) {
    throw new CompileError('STALE_SNAPSHOT', `快照已经 ${Math.round(state.ageMs / 1000)} 秒没更新；先 refresh，或传 force`)
  }
  return { kind: 'ordinal', index: found.index, planet: found.planet }
}

function findIndexByName(list, query, extraKeys = []) {
  const text = String(query ?? '').trim()
  if (!text) return -1
  const lower = text.toLowerCase()
  const exact = list.findIndex((item) => String(item.name || '').toLowerCase() === lower)
  if (exact >= 0) return exact
  const byId = list.findIndex((item) => extraKeys.some((key) => String(item[key] ?? '') === text))
  if (byId >= 0) return byId
  return list.findIndex((item) => String(item.name || '').toLowerCase().includes(lower))
}

export function resolveLeader(state, query) {
  const list = state.current.leaders.length ? state.current.leaders : state.saveData?.leaders || []
  const index = findIndexByName(list, query)
  if (index < 0) throw new CompileError('UNKNOWN_LEADER', `找不到领袖「${query}」（领袖明细要存档通道才全）`)
  return { index, item: list[index] }
}

export function resolveFleet(state, query) {
  const list = state.current.fleets.length ? state.current.fleets : state.saveData?.fleets || []
  const index = findIndexByName(list, query)
  if (index < 0) throw new CompileError('UNKNOWN_FLEET', `找不到舰队「${query}」`)
  return { index, item: list[index] }
}

/**
 * 目标国家：ordered_country 的 position 是「所有国家按 id 排序后的名次」。
 * 用存档里的 player countryId + 其它国家 id 计算；拿不到就退回列表下标。
 */
export function resolveCountry(state, query) {
  const text = String(query ?? '').trim()
  const list = state.saveData?.diplo || state.current.diplo || []
  const index = findIndexByName(list, text, ['countryId', 'country'])
  if (index < 0) {
    throw new CompileError('UNKNOWN_COUNTRY', `找不到国家「${text}」；国家列表来自存档通道（stellaris_save_scan）`)
  }
  const target = list[index]
  const targetId = Number(target.countryId)
  const playerId = Number(state.saveData?.empire?.countryId ?? NaN)
  let position = index
  if (Number.isFinite(targetId)) {
    const ids = list.map((item) => Number(item.countryId)).filter((id) => Number.isFinite(id))
    if (Number.isFinite(playerId)) ids.push(playerId)
    position = ids.filter((id) => id < targetId).length
  }
  return { index, position, item: target }
}

function orderedHit(iterator, position, body, marker = 'dsh_hit') {
  return `${iterator} = { position = ${position} ${body} save_event_target_as = ${marker} }`
}

function hitCheck(done, fail) {
  return [
    `if = { limit = { exists = event_target:dsh_hit } ${done} }`,
    `if = { limit = { NOT = { exists = event_target:dsh_hit } } ${fail} }`,
  ].join(' ')
}

export function effectBody(action, ctx) {
  const spec = CATALOGUE[action.verb]
  if (!spec) throw new CompileError('UNKNOWN_VERB', `编译器不认识：${action.verb}`)
  const { state, cmd, options } = ctx
  const recv = ackLog(cmd, 'recv')
  const done = ackLog(cmd, 'done')
  const fail = ackLog(cmd, 'fail')
  const params = action.params || {}

  const withPlanet = (query, makeBody) => {
    const target = resolvePlanet(state, query, options)
    if (target.kind === 'capital') {
      return `${recv} capital_scope = { ${makeBody()} } ${done}`
    }
    return `${recv} ${orderedHit('ordered_owned_planet', target.index, makeBody())} ${hitCheck(done, fail)}`
  }

  if ((action.verb === 'add_modifier' || action.verb === 'remove_modifier') && params.scope === 'planet') {
    return withPlanet(params.planet, () => spec.build(params, ctx))
  }

  switch (spec.scope) {
    case 'planet':
      return withPlanet(params.planet, () => spec.build(params, ctx))

    case 'leader': {
      const found = resolveLeader(state, params.leader)
      return `${recv} ${orderedHit('ordered_owned_leader', found.index, spec.build(params, ctx))} ${hitCheck(done, fail)}`
    }

    case 'fleet': {
      const found = resolveFleet(state, params.fleet)
      if (action.verb === 'fleet_delete') {
        return [
          recv,
          `ordered_owned_fleet = { position = ${found.index} save_event_target_as = dsh_fleet }`,
          `if = { limit = { exists = event_target:dsh_fleet } delete_fleet = event_target:dsh_fleet ${done} }`,
          `if = { limit = { NOT = { exists = event_target:dsh_fleet } } ${fail} }`,
        ].join(' ')
      }
      if (action.verb === 'send_fleet') {
        const planet = resolvePlanet(state, params.planet, options)
        if (planet.kind === 'capital') {
          throw new CompileError('UNSUPPORTED', 'send_fleet 暂不支持 capital 目标，请用星球名/ord')
        }
        const saveTarget = `ordered_owned_planet = { position = ${planet.index} save_event_target_as = dsh_move_target }`
        const move = `if = { limit = { exists = event_target:dsh_move_target } ordered_owned_fleet = { position = ${found.index} auto_move_to_planet = { target = event_target:dsh_move_target clear_auto_move_on_arrival = yes } save_event_target_as = dsh_hit } }`
        return `${recv} ${saveTarget} ${move} ${hitCheck(done, fail)}`
      }
      return `${recv} ${orderedHit('ordered_owned_fleet', found.index, spec.build(params, ctx))} ${hitCheck(done, fail)}`
    }

    case 'foreign': {
      const found = resolveCountry(state, params.country)
      const body = spec.build(params, { ...ctx, target: 'event_target:dsh_country' })
      return [
        recv,
        `ordered_country = { position = ${found.position} save_event_target_as = dsh_country }`,
        `if = { limit = { exists = event_target:dsh_country } ${body} ${done} }`,
        `if = { limit = { NOT = { exists = event_target:dsh_country } } ${fail} }`,
      ].join(' ')
    }

    case 'none':
      throw new CompileError('USE_UI_TOOL', `${action.verb} 不走 effect；请用界面入口（stellaris_open_ui / open_ui 工具）`)

    case 'country':
    default: {
      const body = spec.build(params, ctx)
      if (action.verb === 'note') return `${body} ${done}`
      return `${recv} ${body} ${done}`
    }
  }
}

export function compilePlan(actions, ctx) {
  const commands = []
  const errors = []
  const planId = ctx.planId || 'p'
  const options = {
    staleLimit: ctx.config?.stalePlanetMs ?? 600000,
    force: Boolean(ctx.force),
  }
  for (const [index, action] of actions.entries()) {
    const cmd = makeCmdId(planId, index, ctx.lane)
    try {
      const body = effectBody(action, { state: ctx.state, cmd, options })
      const line = `effect = { ${body} }`.replace(/\s+/g, ' ').trim()
      if (line.length > MAX_LINE) throw new CompileError('TOO_LONG', `命令太长（${line.length} > ${MAX_LINE}）`)
      commands.push({ cmd, verb: action.verb, params: action.params, level: action.level, line })
    } catch (error) {
      errors.push({
        index,
        verb: action.verb,
        code: error?.code || 'COMPILE_ERROR',
        message: String(error?.message || error),
      })
    }
  }
  return { commands, errors }
}

export { MAX_LINE }
