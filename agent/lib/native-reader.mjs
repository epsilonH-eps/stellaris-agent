/**
 * 原生读取层：一次抓全量状态。
 *
 * 原则：
 * - 能用原生桥读的，全部走原生桥（实时、不受日志/存档延迟影响）；
 * - 读不到的字段不硬编码，保留原始 JSON，mod 加的字段自然带出来；
 * - 每个方法独立容错，单个失败不影响整体。
 *
 * @module stellaris-agent/native-reader
 */

import { loadChains, chainOf } from './event-chains.mjs'
import { agentHome } from './config.mjs'
import { join } from 'node:path'

const BASE_METHODS = [
  'get_status',
  'get_government',
  'get_research_state',
  'get_traditions',
  'get_tradition_candidates',
  'get_ascension_candidates',
  'get_leaders',
  'get_council_candidates',
  'get_fleets',
  'get_military_fleets',
  'get_civilian_fleets',
  'get_contacts',
  'get_pending_diplomacy',
  'get_wars',
  'get_active_events',
  'get_alerts',
  'get_notifications',
  'get_market',
  'get_galaxy_overview',
  'get_ship_designs',
  'get_defense_scan',
  'get_fleet_tactics',
]

function colonyIds(status) {
  const ids = new Set()
  for (const sector of status?.outliner?.sectors_summary?.sectors || []) {
    for (const colony of sector.colonies_summary || []) {
      if (Number.isFinite(colony.planet_id)) ids.add(colony.planet_id)
    }
  }
  return [...ids]
}

function fleetIds(data) {
  const ids = new Set()
  const military = data.methods?.get_military_fleets?.fleets || []
  const civilian = data.methods?.get_civilian_fleets || {}
  const groups = [military, civilian.colony_ships, civilian.science_ships, civilian.construction_ships, civilian.transport_fleets]
  for (const group of groups) {
    for (const fleet of group || []) {
      if (Number.isFinite(fleet.fleet_id)) ids.add(fleet.fleet_id)
    }
  }
  return [...ids]
}

/**
 * @param {import('./native-bridge.mjs').NativePipe} pipe
 * @param {{log?: Function, deep?: boolean}} options
 */
export async function readAll(pipe, { log = () => {}, deep = true } = {}) {
  const data = { readAt: new Date().toISOString(), methods: {}, errors: [] }

  for (const method of BASE_METHODS) {
    try {
      data.methods[method] = await pipe.request(method, {})
    } catch (error) {
      data.errors.push({ method, error: String(error?.message || error) })
    }
  }

  const status = data.methods.get_status
  if (!deep || !status) return data

  // 每颗殖民地：详情 / 岗位 / 可建建筑 / 可建区划
  const colonies = colonyIds(status)
  data.colonies = []
  for (const planetId of colonies) {
    const row = { planet_id: planetId }
    for (const [key, method, params] of [
      ['details', 'get_planet_details', { planet_id: planetId }],
      ['jobs', 'get_planet_jobs', { planet_id: planetId }],
      ['buildings', 'get_buildable_buildings', { planet_id: planetId }],
      ['districts', 'get_buildable_districts', { planet_id: planetId }],
      ['districtZones', 'get_available_district_zones', { planet_id: planetId, district_type: 'district_city' }],
    ]) {
      try {
        row[key] = await pipe.request(method, params)
      } catch (error) {
        row[key] = { error: String(error?.message || error) }
      }
    }
    // 星球所在星系 + 船坞可建舰船
    if (row.details?.system_id) {
      try { row.system = await pipe.request('get_system', { system_id: row.details.system_id }) } catch (error) { row.system = { error: String(error?.message || error) } }
      try { row.ships = await pipe.request('get_buildable_ships', { system_id: row.details.system_id }) } catch (error) { row.ships = { error: String(error?.message || error) } }
    }
    row.zoneTypes = {}
    for (const districtType of ['district_city', 'district_mining', 'district_farming', 'district_generator']) {
      try { row.zoneTypes[districtType] = await pipe.request('get_available_district_zones', { planet_id: planetId, district_type: districtType }) } catch (error) { row.zoneTypes[districtType] = { error: String(error?.message || error) } }
    }
    data.colonies.push(row)
    log('native.reader.colony', { planetId })
  }

  // 每支舰队：详情（含舰船）
  data.fleets = []
  for (const fleetId of fleetIds(data)) {
    try {
      data.fleets.push({ fleet_id: fleetId, detail: await pipe.request('get_fleets', { fleet_id: fleetId }) })
    } catch (error) {
      data.fleets.push({ fleet_id: fleetId, error: String(error?.message || error) })
    }
  }

  // 巨型结构：从已拥有星系收集 + 工程船可建列表
  data.megastructures = {}
  for (const row of data.colonies || []) {
    for (const mega of row.system?.megastructures || []) {
      data.megastructures[mega.id] = { ...mega, system_id: row.details?.system_id ?? null }
    }
  }
  data.megastructureOptions = []
  for (const ship of data.methods?.get_civilian_fleets?.construction_ships || []) {
    try {
      data.megastructureOptions.push(await pipe.request('get_buildable_megastructures', { fleet_id: ship.fleet_id }))
    } catch (error) {
      data.megastructureOptions.push({ fleet_id: ship.fleet_id, error: String(error?.message || error) })
    }
  }

  // 外交选项：每个已接触国家
  data.diplomacy = []
  for (const empire of data.methods?.get_contacts?.empires || []) {
    try {
      data.diplomacy.push({ country_id: empire.country_id, options: await pipe.request('get_diplomacy_options', { country_id: empire.country_id }) })
    } catch (error) {
      data.diplomacy.push({ country_id: empire.country_id, error: String(error?.message || error) })
    }
  }

  // 战争目标候选：每场战争
  data.warGoals = []
  for (const war of data.methods?.get_wars?.wars || []) {
    try {
      data.warGoals.push({ war_id: war.war_id, candidates: await pipe.request('get_war_goal_candidates', { war_id: war.war_id }) })
    } catch (error) {
      data.warGoals.push({ war_id: war.war_id, error: String(error?.message || error) })
    }
  }

  // 事件链：把进行中事件接到静态链图上（mod 事件也在图里）
  try {
    const cache = loadChains(join(agentHome(), 'event-chains.json'))
    const active = data.methods?.get_active_events || []
    data.eventChains = Array.isArray(active) ? active.map((event) => ({
      event_id: event.id || event.event_id || null,
      chain: event.id || event.event_id ? chainOf(cache, event.id || event.event_id, 3) : null,
    })) : []
    data.eventChainIndex = cache ? { events: cache.count, builtAt: cache.builtAt } : null
  } catch {
    data.eventChains = []
    data.eventChainIndex = null
  }

  return data
}

/** 给模型看的紧凑摘要（原始数据另存 JSON）。 */
export function summarize(data) {
  const status = data.methods?.get_status || {}
  const colonies = (status.outliner?.sectors_summary?.sectors || []).flatMap((sector) => sector.colonies_summary || [])
  const resourceLines = Object.entries(status.resources || {})
    .filter(([, v]) => v && (v.stockpile || v.income || v.expense))
    .map(([k, v]) => `${k} ${v.stockpile ?? '?'}(${v.net >= 0 ? '+' : ''}${v.net ?? '?'})`)
    .join('，')
  return [
    `日期：${status.date?.formatted || '?'}｜暂停：${status.is_paused}`,
    `殖民地：${colonies.map((c) => `${c.name}(pops ${c.pops})`).join('、') || '无'}`,
    `资源：${resourceLines || '无'}`,
    `舰队：军事 ${status.fleets?.military_fleets_count ?? '?'}，民用 ${status.fleets?.civilian_fleets_count ?? '?'}`,
    `事件：进行中 ${data.methods?.get_active_events?.length ?? '?'}，警报 ${data.methods?.get_alerts?.length ?? '?'}，通知 ${data.methods?.get_notifications?.length ?? '?'}`,
    `事件链缓存：${data.eventChainIndex?.events ?? '?'} 个事件`,
    `读取失败：${data.errors.length}`,
  ].join('\n')
}
