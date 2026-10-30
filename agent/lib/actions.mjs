/**
 * 动作目录：**唯一**的动作真相源（读取方法 + 写动作 + 单位归属）。
 *
 * 由来：DLL 实际暴露的方法远多于旧版接线的 34 个。这里按
 *   上游 stellaris-mcp（MIT，v0.5.1）文档 + DLL 字符串表 + 旧版真机验证过的参数
 * 整理成表，每条都写明参数与归属单位。`confidence` 标记证据强度：
 *   - `verified`：真机验证过 / 上游文档写明参数；
 *   - `inferred`：从 DLL 字符串推断，首次使用若参数不符，执行器会把错误回传，
 *     子会话据此改参并重报（这正是新的失败回流设计）。
 *
 * 一条动作 = 一次 RPC；参数在 `validateAction` 里做类型与必填校验，
 * 未知参数直接拒绝（避免模型塞一堆幻觉字段）。
 *
 * @module stellaris-agent/actions
 */

const T = { int: 'int', number: 'number', string: 'string', bool: 'bool', array: 'array', map: 'map' }

/** 单位/模块类型：子会话的 1:1 归属。 */
export const UNIT_TYPES = {
  control: { label: '时间与执行控制', actions: ['set_paused', 'set_speed'] },
  research: { label: '国家科研', actions: ['select_research', 'cancel_research'] },
  council: {
    label: '国家内阁',
    actions: ['hire_leader', 'dismiss_leader', 'assign_leader', 'set_council_agenda', 'launch_council_agenda', 'select_leader_trait'],
  },
  laws: { label: '法令与物种权利', actions: ['toggle_edict', 'adopt_tradition', 'set_species_rights'] },
  economy: { label: '经济与市场', actions: ['market_trade', 'set_monthly_trade'] },
  diplomacy: {
    label: '外交与战争',
    actions: ['diplomacy_action', 'respond_diplomacy', 'set_defender_war_goal', 'close_war_goals', 'improve_relations', 'establish_embassy', 'add_system_claim'],
  },
  fleet: {
    label: '舰队',
    actions: [
      'move_fleet', 'survey', 'set_fleet_stance', 'follow_fleet', 'merge_fleets', 'reinforce_fleet',
      'set_fleet_template_quota', 'build_ship', 'upgrade_fleet', 'build_outpost', 'build_stations',
      'colonize', 'build_megastructure', 'cancel_fleet_orders', 'focus_fleet',
    ],
  },
  planet: {
    label: '星球',
    actions: [
      'build_building', 'upgrade_building', 'build_district', 'set_district_zone', 'set_job_priority',
      'set_job_workforce_limit', 'clear_blocker', 'enact_planetary_decision', 'start_terraforming',
      'cancel_terraforming', 'set_planet_army_settings', 'recruit_planet_army', 'disband_planet_army',
      'move_army_to_orbit', 'land_armies', 'cancel_construction', 'focus_planet',
    ],
  },
  event: {
    label: '特殊事件',
    actions: ['resolve_event', 'open_alert', 'open_notification', 'set_situation_approach', 'show_panel', 'set_paused'],
  },
}

/**
 * 写动作表。
 * verify：
 *   read        执行后要回读的方法
 *   params      从动作参数里挑哪些传给 read（默认全部同名参数）
 *   path        回读结果里的字段路径（支持 {param} 模板）
 *   equalsParam 期望值来自动作的哪个参数
 *   equals      固定期望值
 *   includesParam 回读结果 JSON 里应包含该参数的值
 *   excludesParam 回读结果 JSON 里不应包含该参数的值
 *   soft        true = 校验不通过只记警告，不算动作失败（参数语义不确定时用）
 */
export const ACTIONS = [
  // ---------------------------------------------------------------- 控制
  {
    method: 'set_paused', unit: 'control', confidence: 'verified',
    params: { paused: T.bool }, required: ['paused'],
    desc: '暂停/继续游戏（原生 CPauseCommand）',
    verify: { read: 'get_status', path: 'is_paused', equalsParam: 'paused' },
  },
  {
    method: 'set_speed', unit: 'control', confidence: 'verified',
    params: { speed: T.int }, required: ['speed'],
    desc: '设置游戏速度 0..4',
    verify: { read: 'get_status', path: 'speed', equalsParam: 'speed' },
  },

  // ---------------------------------------------------------------- 科研
  {
    method: 'select_research', unit: 'research', confidence: 'verified',
    params: { slot: T.string, tech_key: T.string }, required: ['slot', 'tech_key'],
    desc: '选择科研项目（slot: physics/society/engineering）',
    verify: { read: 'get_research_state', path: '{slot}.current.key', equalsParam: 'tech_key', soft: true },
  },
  {
    method: 'cancel_research', unit: 'research', confidence: 'verified',
    params: { slot: T.string }, required: ['slot'],
    desc: '取消当前科研（slot: physics/society/engineering）',
    verify: { read: 'get_research_state', soft: true },
  },

  // ---------------------------------------------------------------- 内阁 / 领袖
  {
    method: 'hire_leader', unit: 'council', confidence: 'verified',
    params: { candidate_id: T.int }, required: ['candidate_id'],
    desc: '从候选池雇佣领袖',
    verify: { read: 'get_leaders', soft: true },
  },
  {
    method: 'dismiss_leader', unit: 'council', confidence: 'verified',
    params: { leader_id: T.int }, required: ['leader_id'],
    desc: '解雇已雇佣领袖',
    verify: { read: 'get_leaders', excludesParam: 'leader_id', soft: true },
  },
  {
    method: 'assign_leader', unit: 'council', confidence: 'verified',
    params: { leader_id: T.int, slot_type: T.string, target_id: T.int }, required: ['leader_id', 'slot_type', 'target_id'],
    desc: '指派领袖（slot_type: council/fleet/planet/army）',
    verify: { read: 'get_leaders', soft: true },
  },
  {
    method: 'set_council_agenda', unit: 'council', confidence: 'verified',
    params: { agenda_key: T.string }, required: ['agenda_key'],
    desc: '选择内阁议程',
    verify: { read: 'get_government', soft: true },
  },
  {
    method: 'launch_council_agenda', unit: 'council', confidence: 'verified',
    params: { agenda_key: T.string }, required: ['agenda_key'],
    desc: '启动/激活内阁议程',
    verify: { read: 'get_government', soft: true },
  },
  {
    method: 'select_leader_trait', unit: 'council', confidence: 'inferred',
    params: { leader_id: T.int, trait_key: T.string }, required: ['leader_id', 'trait_key'],
    desc: '为领袖选择特质（升级时）',
    verify: { read: 'get_leaders', soft: true },
  },

  // ---------------------------------------------------------------- 法令 / 物种
  {
    method: 'toggle_edict', unit: 'laws', confidence: 'verified',
    params: { edict_key: T.string, enabled: T.bool }, required: ['edict_key', 'enabled'],
    desc: '开关帝国法令（原生 CToggleEdictCommand）',
    verify: { read: 'get_edicts', includesParam: 'edict_key', soft: true },
  },
  {
    method: 'adopt_tradition', unit: 'laws', confidence: 'verified',
    params: { tradition_key: T.string }, required: ['tradition_key'],
    desc: '采纳一项传统（key 见 get_traditions 的 available/unlocked）',
    verify: { read: 'get_traditions', includesParam: 'tradition_key', soft: true },
  },
  {
    method: 'set_species_rights', unit: 'laws', confidence: 'verified',
    params: { species_id: T.int, category: T.string, right_value: T.string }, required: ['species_id', 'category', 'right_value'],
    desc: '设置物种权利（category 见 available_rights_catalog）',
    verify: { read: 'get_species', soft: true },
  },

  // ---------------------------------------------------------------- 经济
  {
    method: 'market_trade', unit: 'economy', confidence: 'verified',
    params: { resource: T.string, amount: T.number, is_buy: T.bool }, required: ['resource', 'amount', 'is_buy'],
    desc: '银河市场买卖资源',
    verify: { read: 'get_status', path: 'resources.{resource}.stockpile', soft: true },
  },
  {
    method: 'set_monthly_trade', unit: 'economy', confidence: 'inferred',
    params: { resource: T.string, amount: T.number, is_buy: T.bool }, required: ['resource', 'amount', 'is_buy'],
    desc: '设置每月自动买卖',
    verify: { read: 'get_market', soft: true },
  },

  // ---------------------------------------------------------------- 外交
  {
    method: 'diplomacy_action', unit: 'diplomacy', confidence: 'verified',
    params: { country_id: T.int, action: T.string }, required: ['country_id', 'action'],
    desc: '发起外交动作（action 见 get_diplomacy_options.options[].key）',
    verify: { read: 'get_pending_diplomacy', soft: true },
  },
  {
    method: 'respond_diplomacy', unit: 'diplomacy', confidence: 'verified',
    params: { proposal: T.string, accept: T.bool }, required: ['proposal', 'accept'],
    desc: '回应待处理外交提议',
    verify: { read: 'get_pending_diplomacy', soft: true },
  },
  {
    method: 'set_defender_war_goal', unit: 'diplomacy', confidence: 'verified',
    params: { war_id: T.int, goal_key: T.string }, required: ['war_id', 'goal_key'],
    desc: '设置防御战争目标',
    verify: { read: 'get_wars', soft: true },
  },
  {
    method: 'close_war_goals', unit: 'diplomacy', confidence: 'inferred',
    params: { war_id: T.int }, required: ['war_id'],
    desc: '关闭战争目标界面（确认/退出）',
    verify: { read: 'get_wars', soft: true },
  },
  {
    method: 'improve_relations', unit: 'diplomacy', confidence: 'inferred',
    params: { country_id: T.int }, required: ['country_id'],
    desc: '改善关系',
    verify: { read: 'get_contacts', soft: true },
  },
  {
    method: 'establish_embassy', unit: 'diplomacy', confidence: 'inferred',
    params: { country_id: T.int }, required: ['country_id'],
    desc: '建立大使馆',
    verify: { read: 'get_contacts', soft: true },
  },
  {
    method: 'add_system_claim', unit: 'diplomacy', confidence: 'inferred',
    params: { system_id: T.int }, required: ['system_id'],
    desc: '宣称星系',
    verify: { read: 'get_galaxy_overview', soft: true },
  },

  // ---------------------------------------------------------------- 舰队
  {
    method: 'move_fleet', unit: 'fleet', confidence: 'verified',
    params: { fleet_id: T.int, system_id: T.int }, required: ['fleet_id', 'system_id'],
    desc: '移动舰队到星系',
    verify: { read: 'get_fleets', params: ['fleet_id'], includesParam: 'system_id', soft: true },
  },
  {
    method: 'survey', unit: 'fleet', confidence: 'verified',
    params: { fleet_id: T.int, system_id: T.int }, required: ['fleet_id', 'system_id'],
    desc: '调查星系',
    verify: { read: 'get_fleets', params: ['fleet_id'], soft: true },
  },
  {
    method: 'set_fleet_stance', unit: 'fleet', confidence: 'verified',
    params: { fleet_id: T.int, stance: T.string }, required: ['fleet_id', 'stance'],
    desc: '舰队姿态 aggressive/passive/evasive',
    verify: { read: 'get_fleets', params: ['fleet_id'], includesParam: 'stance', soft: true },
  },
  {
    method: 'follow_fleet', unit: 'fleet', confidence: 'verified',
    params: { fleet_id: T.int, target_fleet_id: T.int }, required: ['fleet_id', 'target_fleet_id'],
    desc: '舰队跟随另一支舰队',
    verify: { read: 'get_fleets', params: ['fleet_id'], soft: true },
  },
  {
    method: 'merge_fleets', unit: 'fleet', confidence: 'verified',
    params: { fleet_ids: T.array }, required: ['fleet_ids'],
    desc: '合并舰队（同星系）',
    verify: { read: 'get_military_fleets', soft: true },
  },
  {
    method: 'reinforce_fleet', unit: 'fleet', confidence: 'verified',
    params: { fleet_id: T.int }, required: ['fleet_id'],
    desc: '按模板补员',
    verify: { read: 'get_fleets', params: ['fleet_id'], soft: true },
  },
  {
    method: 'set_fleet_template_quota', unit: 'fleet', confidence: 'verified',
    params: { fleet_id: T.int, design_id: T.int, target_quota: T.int }, required: ['fleet_id', 'design_id', 'target_quota'],
    desc: '设置舰队模板配额',
    verify: { read: 'get_fleets', params: ['fleet_id'], soft: true },
  },
  {
    method: 'build_ship', unit: 'fleet', confidence: 'verified',
    params: { design_id: T.int, system_id: T.int, count: T.int }, required: ['design_id', 'system_id'],
    desc: '在船坞建造舰船（count 默认 1）',
    verify: { read: 'get_buildable_ships', params: ['system_id'], soft: true },
  },
  {
    method: 'upgrade_fleet', unit: 'fleet', confidence: 'inferred',
    params: { fleet_id: T.int }, required: ['fleet_id'],
    desc: '升级舰队舰船到最新设计',
    verify: { read: 'get_fleets', params: ['fleet_id'], soft: true },
  },
  {
    method: 'build_outpost', unit: 'fleet', confidence: 'verified',
    params: { fleet_id: T.int, system_id: T.int, station_type: T.string }, required: ['fleet_id', 'system_id'],
    desc: '建造前哨站',
    verify: { read: 'get_system', params: ['system_id'], soft: true },
  },
  {
    method: 'build_stations', unit: 'fleet', confidence: 'verified',
    params: { fleet_id: T.int, system_id: T.int }, required: ['fleet_id', 'system_id'],
    desc: '建造采矿/研究站',
    verify: { read: 'get_system', params: ['system_id'], soft: true },
  },
  {
    method: 'colonize', unit: 'fleet', confidence: 'verified',
    params: { planet_id: T.int, fleet_id: T.int }, required: ['planet_id', 'fleet_id'],
    desc: '殖民星球',
    verify: { read: 'get_planet_details', params: ['planet_id'], soft: true },
  },
  {
    method: 'build_megastructure', unit: 'fleet', confidence: 'inferred',
    params: { fleet_id: T.int, megastructure_key: T.string }, required: ['fleet_id', 'megastructure_key'],
    desc: '工程船建造巨型结构（候选见 get_buildable_megastructures）',
    verify: { read: 'get_buildable_megastructures', params: ['fleet_id'], soft: true },
  },
  {
    method: 'cancel_fleet_orders', unit: 'fleet', confidence: 'inferred',
    params: { fleet_id: T.int }, required: ['fleet_id'],
    desc: '取消舰队当前命令',
    verify: { read: 'get_fleets', params: ['fleet_id'], soft: true },
  },
  {
    method: 'focus_fleet', unit: 'fleet', confidence: 'verified',
    params: { fleet_id: T.int }, required: ['fleet_id'],
    desc: '镜头定位舰队（只影响界面）',
    verify: null,
  },

  // ---------------------------------------------------------------- 星球
  {
    method: 'build_building', unit: 'planet', confidence: 'verified',
    params: { planet_id: T.int, slot_index: T.int, building_key: T.string, district_type: T.string },
    required: ['planet_id', 'slot_index', 'building_key', 'district_type'],
    desc: '在星球特区建造建筑',
    verify: { read: 'get_planet_details', params: ['planet_id'], includesParam: 'building_key', soft: true },
  },
  {
    method: 'upgrade_building', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int, building_id: T.int }, required: ['planet_id', 'building_id'],
    desc: '升级建筑',
    verify: { read: 'get_planet_details', params: ['planet_id'], soft: true },
  },
  {
    method: 'build_district', unit: 'planet', confidence: 'verified',
    params: { planet_id: T.int, district_key: T.string }, required: ['planet_id', 'district_key'],
    desc: '建造区划',
    verify: { read: 'get_planet_details', params: ['planet_id'], includesParam: 'district_key', soft: true },
  },
  {
    method: 'set_district_zone', unit: 'planet', confidence: 'verified',
    params: { planet_id: T.int, district_id: T.int, zone_slot: T.int, zone_key: T.string },
    required: ['planet_id', 'district_id', 'zone_slot', 'zone_key'],
    desc: '设置区划特区',
    verify: { read: 'get_available_district_zones', params: ['planet_id'], soft: true },
  },
  {
    method: 'set_job_priority', unit: 'planet', confidence: 'verified',
    params: { planet_id: T.int, job_key: T.string, prioritized: T.bool }, required: ['planet_id', 'job_key', 'prioritized'],
    desc: '调整岗位优先级',
    verify: { read: 'get_planet_jobs', params: ['planet_id'], soft: true },
  },
  {
    method: 'set_job_workforce_limit', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int, job_key: T.string, limit: T.int }, required: ['planet_id', 'job_key', 'limit'],
    desc: '设置岗位人力上限',
    verify: { read: 'get_planet_jobs', params: ['planet_id'], soft: true },
  },
  {
    method: 'clear_blocker', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int, blocker_id: T.int }, required: ['planet_id', 'blocker_id'],
    desc: '清除地块障碍',
    verify: { read: 'get_clearable_blockers', params: ['planet_id'], soft: true },
  },
  {
    method: 'enact_planetary_decision', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int, decision_key: T.string }, required: ['planet_id', 'decision_key'],
    desc: '执行星球决议',
    verify: { read: 'get_planetary_decisions', params: ['planet_id'], soft: true },
  },
  {
    method: 'start_terraforming', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int, target_class: T.string }, required: ['planet_id', 'target_class'],
    desc: '开始地形改造',
    verify: { read: 'get_terraforming_options', params: ['planet_id'], soft: true },
  },
  {
    method: 'cancel_terraforming', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int }, required: ['planet_id'],
    desc: '取消地形改造',
    verify: { read: 'get_planet_details', params: ['planet_id'], soft: true },
  },
  {
    method: 'set_planet_army_settings', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int, settings: T.map }, required: ['planet_id', 'settings'],
    desc: '设置星球陆军招募设置（settings 见 get_planet_armies）',
    verify: { read: 'get_planet_armies', params: ['planet_id'], soft: true },
  },
  {
    method: 'recruit_planet_army', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int, army_key: T.string }, required: ['planet_id', 'army_key'],
    desc: '招募陆军',
    verify: { read: 'get_planet_armies', params: ['planet_id'], soft: true },
  },
  {
    method: 'disband_planet_army', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int, army_id: T.int }, required: ['planet_id', 'army_id'],
    desc: '解散星球陆军',
    verify: { read: 'get_planet_armies', params: ['planet_id'], soft: true },
  },
  {
    method: 'move_army_to_orbit', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int, army_id: T.int }, required: ['planet_id', 'army_id'],
    desc: '陆军进入轨道',
    verify: { read: 'get_planet_armies', params: ['planet_id'], soft: true },
  },
  {
    method: 'land_armies', unit: 'planet', confidence: 'inferred',
    params: { fleet_id: T.int, planet_id: T.int }, required: ['fleet_id', 'planet_id'],
    desc: '陆军登陆',
    verify: { read: 'get_planet_armies', params: ['planet_id'], soft: true },
  },
  {
    method: 'cancel_construction', unit: 'planet', confidence: 'inferred',
    params: { planet_id: T.int, index: T.int }, required: ['planet_id', 'index'],
    desc: '取消建造队列中的某一项',
    verify: { read: 'get_planet_details', params: ['planet_id'], soft: true },
  },
  {
    method: 'focus_planet', unit: 'planet', confidence: 'verified',
    params: { planet_id: T.int }, required: ['planet_id'],
    desc: '镜头定位星球（只影响界面）',
    verify: null,
  },

  // ---------------------------------------------------------------- 事件 / 界面
  {
    method: 'resolve_event', unit: 'event', confidence: 'verified',
    params: { window_id: T.int, option_index: T.int }, required: ['window_id', 'option_index'],
    desc: '选择事件选项并关闭窗口',
    verify: { read: 'get_active_events', excludesParam: 'window_id', soft: true },
  },
  {
    method: 'open_alert', unit: 'event', confidence: 'verified',
    params: { alert_id: T.int }, required: ['alert_id'],
    desc: '打开警报对应的界面',
    verify: null,
  },
  {
    method: 'open_notification', unit: 'event', confidence: 'verified',
    params: { index: T.int }, required: ['index'],
    desc: '打开通知',
    verify: null,
  },
  {
    method: 'set_situation_approach', unit: 'event', confidence: 'verified',
    params: { situation_id: T.int, approach_index: T.int }, required: ['situation_id', 'approach_index'],
    desc: '调整局势应对方式',
    verify: { read: 'get_situation_log', soft: true },
  },
  {
    method: 'show_panel', unit: 'event', confidence: 'verified',
    params: { panel: T.string }, required: ['panel'],
    desc: '打开界面面板',
    verify: null,
  },
]

export const ACTION_BY_METHOD = new Map(ACTIONS.map((action) => [action.method, action]))

/**
 * 读取方法表：`deep` 表示"每颗星球/每支舰队"这一层要单独再读的。
 */
export const READ_METHODS = [
  { method: 'get_status', scope: 'global' },
  { method: 'get_outliner', scope: 'global' },
  { method: 'get_sectors', scope: 'global' },
  { method: 'get_government', scope: 'global' },
  { method: 'get_civics', scope: 'global' },
  { method: 'get_edicts', scope: 'global' },
  { method: 'get_traditions', scope: 'global' },
  { method: 'get_traditions', scope: 'global' },
  { method: 'get_research_state', scope: 'global' },
  { method: 'get_leaders', scope: 'global' },
  { method: 'get_market', scope: 'global' },
  { method: 'get_contacts', scope: 'global' },
  { method: 'get_pending_diplomacy', scope: 'global' },
  { method: 'get_wars', scope: 'global' },
  { method: 'get_war_goal_candidates', scope: 'war', param: 'war_id' },
  { method: 'get_active_events', scope: 'global' },
  { method: 'get_alerts', scope: 'global' },
  { method: 'get_notifications', scope: 'global' },
  { method: 'get_situation_log', scope: 'global' },
  { method: 'get_galaxy_overview', scope: 'global' },
  { method: 'get_galaxy_map', scope: 'global' },
  { method: 'get_fleets', scope: 'global' },
  { method: 'get_military_fleets', scope: 'global' },
  { method: 'get_civilian_fleets', scope: 'global' },
  { method: 'get_armies', scope: 'global' },
  { method: 'get_ship_designs', scope: 'global' },
  { method: 'get_ship_design_catalog', scope: 'global' },
  { method: 'get_discoveries', scope: 'global' },
  { method: 'get_species', scope: 'global' },
  { method: 'get_planet_details', scope: 'planet', param: 'planet_id' },
  { method: 'get_planet_jobs', scope: 'planet', param: 'planet_id' },
  { method: 'get_planet_armies', scope: 'planet', param: 'planet_id' },
  { method: 'get_buildable_buildings', scope: 'planet', param: 'planet_id' },
  { method: 'get_buildable_districts', scope: 'planet', param: 'planet_id' },
  { method: 'get_available_district_zones', scope: 'planet', param: 'planet_id' },
  { method: 'get_clearable_blockers', scope: 'planet', param: 'planet_id' },
  { method: 'get_planetary_decisions', scope: 'planet', param: 'planet_id' },
  { method: 'get_planetary_features', scope: 'planet', param: 'planet_id' },
  { method: 'get_terraforming_options', scope: 'planet', param: 'planet_id' },
  { method: 'get_buildable_megastructures', scope: 'fleet', param: 'fleet_id' },
  { method: 'get_buildable_ships', scope: 'system', param: 'system_id' },
  { method: 'get_fleets', scope: 'fleet', param: 'fleet_id' },
  { method: 'get_system', scope: 'system', param: 'system_id' },
  { method: 'get_diplomacy_options', scope: 'country', param: 'country_id' },
]

export const READ_BY_SCOPE = READ_METHODS.reduce((acc, row) => {
  ;(acc[row.scope] ||= []).push(row)
  return acc
}, {})

/** 把目录整理成给模型/接口看的形状。 */
export function describeActions({ unit = null } = {}) {
  const list = unit ? ACTIONS.filter((action) => action.unit === unit) : ACTIONS
  return list.map((action) => ({
    method: action.method,
    unit: action.unit,
    desc: action.desc,
    params: Object.entries(action.params).map(([name, type]) => ({
      name,
      type,
      required: action.required?.includes(name) ?? false,
    })),
    confidence: action.confidence,
    hasVerify: Boolean(action.verify),
  }))
}

export function actionsForUnit(unitType) {
  const meta = UNIT_TYPES[unitType]
  if (!meta) return []
  return meta.actions.map((method) => ACTION_BY_METHOD.get(method)).filter(Boolean)
}

/** 给提示词用的一行式动作清单。 */
export function actionsPrompt(unitType) {
  const meta = UNIT_TYPES[unitType]
  return actionsForUnit(unitType)
    .map((action) => {
      const params = Object.entries(action.params)
        .map(([name, type]) => `${name}${action.required?.includes(name) ? '' : '?'}:${type}`)
        .join(', ')
      return `- ${action.method}(${params}) — ${action.desc}`
    })
    .join('\n')
}

function typeOk(value, type) {
  switch (type) {
    case T.int:
      return Number.isInteger(value)
    case T.number:
      return typeof value === 'number' && Number.isFinite(value)
    case T.string:
      return typeof value === 'string' && value.length > 0
    case T.bool:
      return typeof value === 'boolean'
    case T.array:
      return Array.isArray(value)
    case T.map:
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    default:
      return true
  }
}

/**
 * 校验并归一化一个动作。
 * 未知方法 / 缺参 / 类型不符 / 多余参数 → 拒绝（多余参数是幻觉的重灾区）。
 * @returns {{ok:boolean, errors:string[], action?:{method:string, params:object, spec:object}}}
 */
export function validateAction(input, { unitType = null } = {}) {
  const errors = []
  if (!input || typeof input !== 'object') return { ok: false, errors: ['动作必须是对象'] }
  const method = String(input.method || '').trim()
  const spec = ACTION_BY_METHOD.get(method)
  if (!spec) return { ok: false, errors: [`未知动作：${method || '(空)'}`] }
  if (unitType && spec.unit !== unitType && !(unitType === 'event' && spec.unit === 'control')) {
    errors.push(`动作 ${method} 属于「${spec.unit}」而不是「${unitType}」`)
  }
  const raw = input.params && typeof input.params === 'object' ? input.params : {}
  const params = {}
  for (const [name, type] of Object.entries(spec.params)) {
    const value = raw[name]
    const required = spec.required?.includes(name)
    if (value === undefined || value === null || value === '') {
      if (required) errors.push(`${method} 缺少必填参数 ${name}（${type}）`)
      continue
    }
    if (!typeOk(value, type)) {
      errors.push(`${method} 参数 ${name} 类型应为 ${type}，实际是 ${JSON.stringify(value)}`)
      continue
    }
    params[name] = value
  }
  const unknown = Object.keys(raw).filter((key) => !(key in spec.params))
  if (unknown.length) errors.push(`${method} 不认识参数 ${unknown.join(', ')}`)
  if (errors.length) return { ok: false, errors }
  return { ok: true, errors: [], action: { method, params, spec } }
}

export function validateActions(input, options = {}) {
  if (!Array.isArray(input)) return { ok: false, errors: ['actions 必须是数组'], actions: [] }
  const errors = []
  const actions = []
  for (const [index, item] of input.entries()) {
    const result = validateAction(item, options)
    if (!result.ok) errors.push(...result.errors.map((error) => `#${index + 1} ${error}`))
    else actions.push(result.action)
  }
  return { ok: errors.length === 0, errors, actions }
}

/** 执行器按动作名查回读规格。 */
export function verifySpecOf(method) {
  return ACTION_BY_METHOD.get(method)?.verify || null
}

/** 这个动作会不会改游戏状态（是 = 需要暂停/入队）。 */
export function isMutating(method) {
  const spec = ACTION_BY_METHOD.get(method)
  if (!spec) return false
  return !['focus_planet', 'focus_fleet', 'open_alert', 'open_notification', 'show_panel'].includes(method)
}
