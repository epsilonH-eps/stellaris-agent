/**
 * 全动词表（原生侧）：34 个真人可用动作。
 *
 * 与 03 的 DSL 动词表互补：
 *  - DSL 走 effect/队列；
 *  - 这里走原生桥，实时、逐项、读回验证。
 *
 * @module stellaris-agent/native-verbs
 */
import { NATIVE_WRITE_ACTIONS } from './native-actions.mjs'
import { runSteps } from './native-operator.mjs'

const HELP = {
  set_paused: '暂停/继续游戏',
  set_speed: '设置游戏速度',
  build_building: '在指定星球特区建建筑（需 slot_index + building_key + district_type）',
  set_district_zone: '设置区划特区（需 district_id + slot + zone_key）',
  set_job_priority: '调整星球岗位优先级',
  select_research: '选择科研项目（area: physics/society/engineering）',
  build_ship: '在船坞建造舰船',
  build_outpost: '舰队建前哨站',
  build_stations: '舰队建采矿/研究站',
  colonize: '殖民星球',
  move_fleet: '移动舰队到星系',
  survey: '舰队调查星系',
  set_fleet_stance: '设置舰队姿态',
  set_fleet_template_quota: '设置舰队模板配额',
  reinforce_fleet: '舰队补员',
  follow_fleet: '舰队跟随',
  merge_fleet: '合并舰队',
  adopt_tradition: '采纳传统',
  adopt_ascension_perk: '选择飞升天赋',
  market_trade: '市场买卖资源',
  hire_leader: '雇佣领袖',
  assign_leader: '指派领袖',
  assign_councilor: '任命内阁成员',
  set_council_agenda: '设置内阁议程',
  diplomacy_action: '发起外交动作',
  respond_diplomacy: '回应外交提议',
  set_defender_war_goal: '设置防御战争目标',
  resolve_event: '选择事件选项',
  open_alert: '打开警报',
  open_notification: '打开通知',
  show_panel: '打开界面面板',
  focus_planet: '镜头定位星球',
  focus_fleet: '镜头定位舰队',
}

export const NATIVE_VERBS = Object.fromEntries(
  NATIVE_WRITE_ACTIONS.map((row) => [
    row.method,
    {
      method: row.method,
      category: row.category,
      params: row.params,
      verify: row.verify,
      help: HELP[row.method] || row.method,
    },
  ]),
)

export function listVerbs() {
  return Object.values(NATIVE_VERBS).map((verb) => ({
    verb: verb.method,
    category: verb.category,
    params: verb.params,
    help: verb.help,
    hasVerify: Boolean(verb.verify),
  }))
}

export function verbInfo(name) {
  return NATIVE_VERBS[name] || null
}

/** 单项执行：一次只做一项，失败最多重试 attempts 次，读回验证通过才算完成。 */
export async function runVerb(pipe, name, params = {}, { attempts = 5, log = () => {} } = {}) {
  const verb = verbInfo(name)
  if (!verb) return { ok: false, error: 'UNKNOWN_VERB', verb: name }
  const step = { method: verb.method, params, verify: verb.verify || null, label: `${verb.category}/${verb.method}` }
  return runSteps(pipe, [step], { attempts, log, pause: false })
}
