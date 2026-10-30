/**
 * 原生动作登记表：所有「真人能在界面里做、且原生桥暴露了命令」的动作。
 *
 * 用途：
 *  - native-actions 列出全部能力；
 *  - native-audit 跟 DSL 动词表对账，找出漏掉的动作；
 *  - native-run / 调度器按这里的参数形状执行并读回验证。
 *
 * @module stellaris-agent/native-actions
 */

export const NATIVE_READ_ACTIONS = [
  ['get_status', '全局状态'],
  ['get_government', '政府/内阁'],
  ['get_research_state', '科研'],
  ['get_traditions', '传统'],
  ['get_tradition_candidates', '可选传统'],
  ['get_ascension_candidates', '可选飞升'],
  ['get_leaders', '领袖'],
  ['get_council_candidates', '内阁候选'],
  ['get_fleets', '舰队'],
  ['get_military_fleets', '军事舰队'],
  ['get_civilian_fleets', '民用舰队'],
  ['get_contacts', '外交接触'],
  ['get_pending_diplomacy', '待处理外交'],
  ['get_wars', '战争'],
  ['get_active_events', '进行中事件'],
  ['get_alerts', '警报'],
  ['get_notifications', '通知'],
  ['get_market', '市场'],
  ['get_galaxy_overview', '银河概览'],
  ['get_ship_designs', '舰船设计'],
  ['get_defense_scan', '防御扫描'],
  ['get_fleet_tactics', '舰队战术'],
  ['get_planet_details', '星球详情'],
  ['get_planet_jobs', '星球岗位'],
  ['get_buildable_buildings', '可建建筑'],
  ['get_buildable_districts', '可建区划'],
  ['get_buildable_ships', '可建舰船'],
  ['get_available_district_zones', '特区'],
  ['get_system', '星系'],
  ['find_path', '寻路'],
  ['find_systems', '找星系'],
  ['get_war_goal_candidates', '战争目标候选'],
  ['get_diplomacy_options', '外交选项'],
]

/**
 * 写动作：参数按原生桥的实际校验逻辑列，不做“猜参数”。
 * verify 为读回方法；native-run 会在执行后调用它。
 */
export const NATIVE_WRITE_ACTIONS = [
  { method: 'set_paused', category: '时间', params: ['paused'], verify: { method: 'get_status', expectPath: 'is_paused', expectParam: 'paused' } },
  { method: 'set_speed', category: '时间', params: ['speed'], verify: { method: 'get_status', expectPath: 'speed', expectParam: 'speed' } },

  { method: 'build_building', category: '星球', params: ['planet_id', 'slot_index', 'building_key', 'district_type'], verify: { method: 'get_buildable_buildings', paramsKey: 'planet_id' } },
  { method: 'set_district_zone', category: '星球', params: ['planet_id', 'district_id', 'zone_slot', 'zone_key'], verify: { method: 'get_available_district_zones', paramsKey: 'planet_id' } },
  { method: 'set_job_priority', category: '星球', params: ['planet_id', 'job_key', 'prioritized'], verify: { method: 'get_planet_jobs', paramsKey: 'planet_id' } },

  { method: 'select_research', category: '科研', params: ['slot', 'tech_key'], verify: { method: 'get_research_state' } },
  { method: 'build_ship', category: '舰队', params: ['design_id', 'system_id', 'count'], verify: { method: 'get_buildable_ships', paramsKey: 'system_id' } },
  { method: 'build_outpost', category: '舰队', params: ['fleet_id', 'system_id', 'station_type'], verify: { method: 'get_system', paramsKey: 'system_id' } },
  { method: 'build_stations', category: '舰队', params: ['fleet_id', 'system_id'], verify: { method: 'get_system', paramsKey: 'system_id' } },
  { method: 'colonize', category: '舰队', params: ['planet_id', 'fleet_id'], verify: { method: 'get_planet_details', paramsKey: 'planet_id' } },
  { method: 'move_fleet', category: '舰队', params: ['fleet_id', 'system_id'], verify: { method: 'find_path', paramsKey: 'fleet_id' } },
  { method: 'survey', category: '舰队', params: ['fleet_id', 'system_id'], verify: { method: 'find_path', paramsKey: 'fleet_id' } },
  { method: 'set_fleet_stance', category: '舰队', params: ['fleet_id', 'stance'], verify: { method: 'get_fleets', paramsKey: 'fleet_id' } },
  { method: 'set_fleet_template_quota', category: '舰队', params: ['fleet_id', 'design_id', 'target_quota'], verify: { method: 'get_fleets' } },
  { method: 'reinforce_fleet', category: '舰队', params: ['fleet_id'], verify: { method: 'get_fleets', paramsKey: 'fleet_id' } },
  { method: 'follow_fleet', category: '舰队', params: ['fleet_id', 'target_fleet_id'], verify: { method: 'get_fleets', paramsKey: 'fleet_id' } },
  { method: 'merge_fleets', category: '舰队', params: ['fleet_ids'], verify: { method: 'get_fleets' } },

  { method: 'build_district', category: '星球', params: ['planet_id', 'district_key'], verify: { method: 'get_planet_details', paramsKey: 'planet_id' } },
  { method: 'adopt_tradition', category: '传统', params: ['tradition_key'], verify: { method: 'get_traditions' } },
  { method: 'adopt_ascension_perk', category: '传统', params: ['perk_key'], verify: { method: 'get_traditions' } },

  { method: 'market_trade', category: '经济', params: ['resource', 'amount', 'buy'], verify: { method: 'get_status' } },

  { method: 'hire_leader', category: '领袖', params: ['leader_id'], verify: { method: 'get_leaders' } },
  { method: 'assign_leader', category: '领袖', params: ['leader_id', 'target_id'], verify: { method: 'get_leaders' } },
  { method: 'assign_councilor', category: '领袖', params: ['leader_id', 'seat_index'], verify: { method: 'get_council_candidates' } },
  { method: 'set_council_agenda', category: '领袖', params: ['agenda_key'], verify: { method: 'get_status' } },

  { method: 'diplomacy_action', category: '外交', params: ['country_id', 'action'], verify: { method: 'get_pending_diplomacy' } },
  { method: 'respond_diplomacy', category: '外交', params: ['proposal', 'accept'], verify: { method: 'get_pending_diplomacy' } },
  { method: 'set_defender_war_goal', category: '外交', params: ['war_id', 'goal_key'], verify: { method: 'get_wars' } },

  { method: 'resolve_event', category: '事件', params: ['window_id', 'option_index'], verify: { method: 'get_active_events' } },
  { method: 'open_alert', category: '事件', params: ['alert_id'], verify: { method: 'get_alerts' } },
  { method: 'open_notification', category: '事件', params: ['index'], verify: { method: 'get_notifications' } },

  { method: 'show_panel', category: '界面', params: ['panel'], verify: null },
  { method: 'focus_planet', category: '界面', params: ['planet_id'], verify: null },
  { method: 'focus_fleet', category: '界面', params: ['fleet_id'], verify: null },
]

/** DSL 动词 → 原生方法的覆盖关系（用于对账）。 */
export const DSL_TO_NATIVE = {
  add_building: 'build_building',
  add_district: 'set_district_zone',
  set_fleet_stance: 'set_fleet_stance',
  send_fleet: 'move_fleet',
  add_tradition: 'adopt_tradition',
  add_perk: 'adopt_ascension_perk',
  event: 'resolve_event',
  open_ui: 'show_panel',
}

/** 原生方法 → 人类界面语义，便于报告。 */
export function describeMethod(method) {
  return NATIVE_WRITE_ACTIONS.find((row) => row.method === method) || { method, category: '其它', params: [] }
}

/** 对账：原生有、DSL 没有的动作。 */
export function auditAgainstDsl(catalogue = {}) {
  const dslMethods = new Set(Object.values(DSL_TO_NATIVE))
  const covered = []
  const gaps = []
  for (const row of NATIVE_WRITE_ACTIONS) {
    if (dslMethods.has(row.method)) covered.push(row)
    else gaps.push(row)
  }
  const dslOnly = Object.keys(catalogue).filter((verb) => !Object.prototype.hasOwnProperty.call(DSL_TO_NATIVE, verb))
  return {
    nativeWriteCount: NATIVE_WRITE_ACTIONS.length,
    nativeReadCount: NATIVE_READ_ACTIONS.length,
    covered: covered.map((row) => row.method),
    gaps,
    dslOnly,
  }
}

/** 生成可直接喂给 native-run 的步骤模板。 */
export function stepFor(method, params = {}) {
  const row = describeMethod(method)
  return {
    method,
    params,
    verify: row.verify || null,
    label: row.category + '/' + method,
  }
}
