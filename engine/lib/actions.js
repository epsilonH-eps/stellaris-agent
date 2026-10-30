/**
 * 动作目录：一个动词 = 一条定义。
 *
 * 数据驱动的好处：加动作只改这个文件（+ 一条测试），编译器和工具表自动跟上。
 *
 * 每条定义：
 *   level    core（高置信）/ exp（需验证）/ raw（原始脚本）
 *   scope    country | planet | leader | fleet | foreign（需要目标国家）
 *   params   参数名 → 类型（`?` 结尾 = 可选）
 *   help     给模型/人看的一句话
 *   build    生成 effect 片段（在对应作用域内；ACK 与寻址由编译器包）
 *   sample   测试用的一组合法参数
 *
 * 类型：key（脚本 key）、number、text、planet、leader、fleet、country、enum
 *
 * @module dsh-stellaris-bridge/actions
 */

export const RESOURCE_KEYS = [
  'energy', 'minerals', 'food', 'alloys', 'consumer_goods', 'unity', 'influence',
  'physics_research', 'society_research', 'engineering_research',
  'sr_living_metal', 'sr_zro', 'sr_dark_matter', 'nanites', 'minor_artifacts',
]

export const UI_VIEWS = [
  'ascension', 'traditions', 'technology', 'government', 'leaders',
  'fleets', 'diplomacy', 'relics', 'policies', 'planets',
]

const KEY = 'key'
const NUM = 'number'
const TXT = 'text'
const PLANET = 'planet'
const LEADER = 'leader'
const FLEET = 'fleet'
const COUNTRY = 'country'
const ENUM = 'enum'

/** 定义表。build 返回字符串；需要目标国家的动词会用 `$target`。 */
export const CATALOGUE = {
  // ---------------------------------------------------------------- 国家
  resource: {
    level: 'core',
    scope: 'country',
    params: { key: 'resource', amount: NUM },
    help: '加/扣资源。key 见资源表；amount 可负。',
    build: (p) => `add_resource = { ${p.key} = ${Math.round(p.amount)} }`,
    sample: { key: 'alloys', amount: 100 },
  },
  add_modifier: {
    level: 'core',
    scope: 'country',
    params: { key: KEY, days: `${NUM}?`, scope: 'scope?', planet: 'planet?' },
    help: '加修正；days 省略 = 永久；scope=planet 时作用到目标星球。',
    build: (p) => `add_modifier = { modifier = ${p.key} days = ${p.days ?? -1} }`,
    sample: { key: 'dsh_test_modifier' },
  },
  remove_modifier: {
    level: 'core',
    scope: 'country',
    params: { key: KEY, scope: 'scope?', planet: 'planet?' },
    help: '移除修正。',
    build: (p) => `remove_modifier = ${p.key}`,
    sample: { key: 'dsh_test_modifier' },
  },
  give_tech: {
    level: 'core',
    scope: 'country',
    params: { tech: KEY },
    help: '直接给科技。',
    build: (p) => `give_technology = { tech = ${p.tech} }`,
    sample: { tech: 'tech_lasers_1' },
  },
  add_tradition: {
    level: 'core',
    scope: 'country',
    params: { tradition: KEY },
    help: '加传统。',
    build: (p) => `add_tradition = ${p.tradition}`,
    sample: { tradition: 'tr_galactic_administration' },
  },
  add_perk: {
    level: 'core',
    scope: 'country',
    params: { perk: KEY },
    help: '加飞升（effect 名待验证）。',
    build: (p) => `add_ascension_perk = ${p.perk}`,
    sample: { perk: 'ap_galactic_administration' },
  },
  add_relic: {
    level: 'core',
    scope: 'country',
    params: { relic: KEY },
    help: '加遗珍（effect 名待验证）。',
    build: (p) => `add_relic = ${p.relic}`,
    sample: { relic: 'r_dragon_trophy' },
  },
  add_edict: {
    level: 'core',
    scope: 'country',
    params: { key: KEY },
    help: '激活法令（4.5 用 add_edict）。',
    build: (p) => `add_edict = ${p.key}`,
    sample: { key: 'edict_research_subsidies' },
  },
  set_policy: {
    level: 'core',
    scope: 'country',
    params: { policy: KEY, option: KEY },
    help: '改政策。',
    build: (p) => `set_policy = { policy = ${p.policy} option = ${p.option} cooldown = no }`,
    sample: { policy: 'policy_slavery', option: 'policy_slavery_allowed' },
  },
  force_add_civic: {
    level: 'core',
    scope: 'country',
    params: { civic: KEY },
    help: '无视限制加国策。',
    build: (p) => `force_add_civic = ${p.civic}`,
    sample: { civic: 'civic_technocracy' },
  },
  force_remove_civic: {
    level: 'core',
    scope: 'country',
    params: { civic: KEY },
    help: '无视限制移除国策。',
    build: (p) => `force_remove_civic = ${p.civic}`,
    sample: { civic: 'civic_beacon_of_liberty' },
  },
  set_ai_personality: {
    level: 'core',
    scope: 'country',
    params: { personality: KEY },
    help: '设置国家的 AI 人格（引擎效果，4.5 文档字符串确认；对 AI 托管/接管时生效）。',
    build: (p) => `set_ai_personality = ${p.personality}`,
    sample: { personality: 'erudite_explorers' },
  },
  set_origin: {
    level: 'core',
    scope: 'country',
    params: { origin: KEY },
    help: '设置起源（不补触发开局效果）。',
    build: (p) => `set_origin = ${p.origin}`,
    sample: { origin: 'origin_default' },
  },
  set_empire_name: {
    level: 'exp',
    scope: 'country',
    params: { name: TXT },
    help: '改帝国名（effect 参数是 loc key，不是任意文本；用前先确认）。',
    build: (p) => `set_empire_name = "${p.name}"`,
    sample: { name: '新帝国' },
  },
  set_country_flag: {
    level: 'core',
    scope: 'country',
    params: { key: KEY },
    help: '设国家旗标（脚本/事件用）。',
    build: (p) => `set_country_flag = ${p.key}`,
    sample: { key: 'dsh_flag' },
  },
  clear_country_flag: {
    level: 'core',
    scope: 'country',
    params: { key: KEY },
    help: '清国家旗标。',
    build: (p) => `remove_country_flag = ${p.key}`,
    sample: { key: 'dsh_flag' },
  },
  clear_resources: {
    level: 'exp',
    scope: 'country',
    params: {},
    help: '清空国家资源（危险）。',
    build: () => 'clear_resources = yes',
    sample: {},
  },

  // ---------------------------------------------------------------- 外交（需要目标国家）
  add_trust: {
    level: 'core',
    scope: 'foreign',
    params: { country: COUNTRY, amount: NUM },
    help: '加信任。',
    build: (p, ctx) => `add_trust = { who = ${ctx.target} amount = ${Math.round(p.amount)} }`,
    sample: { country: '邻国', amount: 10 },
  },
  add_threat: {
    level: 'core',
    scope: 'foreign',
    params: { country: COUNTRY, amount: NUM },
    help: '加威胁感（会让对方更敌视你）。',
    build: (p, ctx) => `add_threat = { who = ${ctx.target} amount = ${Math.round(p.amount)} }`,
    sample: { country: '邻国', amount: 10 },
  },
  end_rivalry: {
    level: 'core',
    scope: 'foreign',
    params: { country: COUNTRY },
    help: '结束竞争关系。',
    build: (_p, ctx) => `end_rivalry = ${ctx.target}`,
    sample: { country: '邻国' },
  },
  set_truce: {
    level: 'core',
    scope: 'foreign',
    params: { country: COUNTRY, type: 'type?' },
    help: '强制停战（war/liberation/alliance/…）。',
    build: (p, ctx) => `set_truce = { target = ${ctx.target} type = ${p.type ?? 'war'} }`,
    sample: { country: '邻国' },
  },
  end_truce: {
    level: 'core',
    scope: 'foreign',
    params: { country: COUNTRY },
    help: '结束停战。',
    build: (_p, ctx) => `end_truce = ${ctx.target}`,
    sample: { country: '邻国' },
  },
  join_war: {
    level: 'core',
    scope: 'foreign',
    params: { country: COUNTRY },
    help: '加入目标国家这一侧的战争。',
    build: (_p, ctx) => `join_war = ${ctx.target}`,
    sample: { country: '邻国' },
  },
  set_closed_borders: {
    level: 'core',
    scope: 'foreign',
    params: { country: COUNTRY, status: 'bool?' },
    help: '开/关边界。',
    build: (p, ctx) => `set_closed_borders = { who = ${ctx.target} status = ${p.status === false ? 'no' : 'yes'} }`,
    sample: { country: '邻国', status: true },
  },

  // ---------------------------------------------------------------- 星球
  add_building: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET, building: KEY },
    help: '开始建造一座建筑。',
    build: (p) => `add_building = ${p.building}`,
    sample: { planet: 'capital', building: 'building_foundry_01' },
  },
  ruin_building: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET, building: KEY },
    help: '把某座建筑打成废墟。',
    build: (p) => `ruin_building = ${p.building}`,
    sample: { planet: 'capital', building: 'building_foundry_01' },
  },
  remove_building: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET, building: KEY },
    help: '拆除指定建筑（4.5 的 effect 是 remove_building）。',
    build: (p) => `remove_building = ${p.building}`,
    sample: { planet: 'capital', building: 'building_foundry_01' },
  },
  remove_all_buildings: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET },
    help: '移除全部建筑（危险）。',
    build: () => 'remove_all_buildings = yes',
    sample: { planet: 'capital' },
  },
  repair_buildings: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET },
    help: '修复全部废墟建筑。',
    build: () => 'repair_all_buildings = yes',
    sample: { planet: 'capital' },
  },
  downgrade_buildings: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET },
    help: '降级建筑。',
    build: () => 'downgrade_all_buildings = yes',
    sample: { planet: 'capital' },
  },
  add_district: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET, district: KEY },
    help: '加区划。',
    build: (p) => `add_district = ${p.district}`,
    sample: { planet: 'capital', district: 'district_mining' },
  },
  set_designation: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET, designation: KEY },
    help: '改星球定位（4.5 的 effect 是 set_colony_type）。',
    build: (p) => `set_colony_type = ${p.designation}`,
    sample: { planet: 'capital', designation: 'col_capital' },
  },
  set_planet_name: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET, name: TXT },
    help: '改星球名。',
    build: (p) => `set_planet_name = "${p.name}"`,
    sample: { planet: 'capital', name: '新首都' },
  },
  add_planet_devastation: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET, amount: NUM },
    help: '加荒废度（0-100）。',
    build: (p) => `add_planet_devastation = ${Math.round(p.amount)}`,
    sample: { planet: 'capital', amount: 10 },
  },
  clear_blockers: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET },
    help: '清除全部地块障碍。',
    build: () => 'clear_blockers = yes',
    sample: { planet: 'capital' },
  },
  add_deposit: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET, deposit: KEY },
    help: '加资源矿藏。',
    build: (p) => `add_deposit = ${p.deposit}`,
    sample: { planet: 'capital', deposit: 'd_minerals_2' },
  },
  reroll_deposits: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET },
    help: '重掷矿藏。',
    build: () => 'reroll_deposits = yes',
    sample: { planet: 'capital' },
  },
  create_mining_station: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET },
    help: '在目标星球轨道建采矿站（需要玩家拥有）。',
    build: () => 'create_mining_station = { owner = root }',
    sample: { planet: 'capital' },
  },
  create_research_station: {
    level: 'core',
    scope: 'planet',
    params: { planet: PLANET },
    help: '在目标星球轨道建研究站。',
    build: () => 'create_research_station = { owner = root }',
    sample: { planet: 'capital' },
  },

  // ---------------------------------------------------------------- 领袖
  leader_trait: {
    level: 'core',
    scope: 'leader',
    params: { leader: LEADER, trait: KEY },
    help: '给领袖加特质。',
    build: (p) => `add_trait = ${p.trait}`,
    sample: { leader: '张三', trait: 'leader_trait_engineer' },
  },
  leader_skill: {
    level: 'core',
    scope: 'leader',
    params: { leader: LEADER, level: NUM },
    help: '设置领袖等级（1-10）。',
    build: (p) => `set_skill = ${Math.round(p.level)}`,
    sample: { leader: '张三', level: 3 },
  },
  leader_experience: {
    level: 'core',
    scope: 'leader',
    params: { leader: LEADER, amount: NUM },
    help: '加领袖经验。',
    build: (p) => `add_experience = ${Math.round(p.amount)}`,
    sample: { leader: '张三', amount: 100 },
  },
  leader_immortal: {
    level: 'core',
    scope: 'leader',
    params: { leader: LEADER, immortal: 'bool?' },
    help: '设置/取消不朽。',
    build: (p) => `set_immortal = ${p.immortal === false ? 'no' : 'yes'}`,
    sample: { leader: '张三', immortal: true },
  },
  leader_freeze_age: {
    level: 'core',
    scope: 'leader',
    params: { leader: LEADER, freeze: 'bool?' },
    help: '冻结/解冻领袖年龄。',
    build: (p) => `freeze_leader_age = ${p.freeze === false ? 'no' : 'yes'}`,
    sample: { leader: '张三', freeze: true },
  },

  // ---------------------------------------------------------------- 舰队
  fleet_stance: {
    level: 'core',
    scope: 'fleet',
    params: { fleet: FLEET, stance: 'stance' },
    help: '舰队姿态：aggressive/passive/evasive。',
    build: (p) => `set_fleet_stance = ${p.stance}`,
    sample: { fleet: '第一舰队', stance: 'aggressive' },
  },
  fleet_aggro: {
    level: 'core',
    scope: 'fleet',
    params: { fleet: FLEET, range: NUM },
    help: '设置交战范围。',
    build: (p) => `set_aggro_range = ${Math.round(p.range)}`,
    sample: { fleet: '第一舰队', range: 30 },
  },
  fleet_mission: {
    level: 'core',
    scope: 'fleet',
    params: { fleet: FLEET, mission: KEY },
    help: '设置舰队任务（观察站等）。',
    build: (p) => `set_mission = ${p.mission}`,
    sample: { fleet: '第一舰队', mission: 'passive_observation' },
  },
  fleet_repair: {
    level: 'core',
    scope: 'fleet',
    params: { fleet: FLEET, percent: NUM },
    help: '按比例修复舰船（0-1）。',
    build: (p) => `repair_percentage = ${Number(p.percent)}`,
    sample: { fleet: '第一舰队', percent: 0.5 },
  },
  send_fleet: {
    level: 'core',
    scope: 'fleet',
    params: { fleet: FLEET, planet: PLANET },
    help: '让舰队自动前往某星球。',
    build: () => 'auto_move_to_planet = { target = this }',
    sample: { fleet: '第一舰队', planet: '地球' },
  },
  fleet_delete: {
    level: 'exp',
    scope: 'fleet',
    params: { fleet: FLEET },
    help: '删除舰队（危险）。',
    build: () => 'delete_fleet = event_target:dsh_fleet',
    sample: { fleet: '第一舰队' },
  },

  // ---------------------------------------------------------------- 元操作
  event: {
    level: 'core',
    scope: 'country',
    params: { id: KEY },
    help: '触发一个国家事件（万能后门）。',
    build: (p) => `country_event = { id = ${p.id} days = 0 }`,
    sample: { id: 'dsh_reader.9' },
  },
  note: {
    level: 'core',
    scope: 'country',
    params: { text: TXT },
    help: '只写日志，不改档。',
    build: (p) => `log = "DSH1|0|NOTE|from=bridge|text=${String(p.text).replace(/[|\r\n]+/g, ' ').slice(0, 400)}"`,
    sample: { text: '测试' },
  },
  raw_effect: {
    level: 'raw',
    scope: 'country',
    params: { script: TXT },
    help: '原样拼进 effect（需 allowRawEffect）。',
    build: (p) => String(p.script).replace(/\r?\n/g, ' ').trim(),
    sample: { script: 'log = "DSH1|0|NOTE|from=bridge|text=raw"' },
  },
  open_ui: {
    level: 'core',
    scope: 'none',
    params: { view: ENUM },
    help: '打开界面（由 UI 层处理，不走 effect）。',
    build: () => {
      throw Object.assign(new Error('open_ui 不走 effect；请用界面入口'),
        { code: 'USE_UI_TOOL' })
    },
    sample: { view: 'ascension' },
  },
}

const KEY_RE = /^[A-Za-z0-9_.\-]+$/
const STANCES = new Set(['aggressive', 'passive', 'evasive'])
const RESOURCE_SET = new Set(RESOURCE_KEYS)
const UI_SET = new Set(UI_VIEWS)

function isOptional(type) {
  return String(type).endsWith('?')
}

function baseType(type) {
  return String(type).replace(/\?$/, '')
}

function checkValue(name, type, value) {
  const kind = baseType(type)
  const text = typeof value === 'string' ? value.trim() : value
  if (kind === 'key') {
    if (!KEY_RE.test(String(text))) return { code: 'BAD_PARAM', message: `参数 ${name} 不是合法 key：${JSON.stringify(value)}` }
    return null
  }
  if (kind === 'number') {
    if (!Number.isFinite(Number(text))) return { code: 'BAD_PARAM', message: `参数 ${name} 不是数字：${JSON.stringify(value)}` }
    return null
  }
  if (kind === 'text') {
    if (String(text).length === 0) return { code: 'BAD_PARAM', message: `参数 ${name} 不能为空` }
    if (String(text).length > 400) return { code: 'BAD_PARAM', message: `参数 ${name} 太长（>400）` }
    return null
  }
  if (kind === 'stance') {
    if (!STANCES.has(String(text))) return { code: 'BAD_PARAM', message: '姿态只能是 aggressive/passive/evasive' }
    return null
  }
  if (kind === 'enum') {
    if (!UI_SET.has(String(text))) return { code: 'BAD_VIEW', message: `界面只能是：${UI_VIEWS.join(', ')}` }
    return null
  }
  if (kind === 'resource') {
    if (!RESOURCE_SET.has(String(text))) return { code: 'BAD_RESOURCE', message: `不认识的资源 key：${text}` }
    return null
  }
  return null
}

/**
 * 规范化 + 校验。
 * @param {Array<object>} input
 * @param {object} options
 * @returns {{ok:boolean, actions:Array<object>, errors:Array<object>}}
 */
export function normalizeActions(input, options = {}) {
  const errors = []
  const actions = []
  if (!Array.isArray(input)) return { ok: false, actions, errors: [{ code: 'BAD_INPUT', message: 'actions 必须是数组' }] }
  if (input.length === 0) return { ok: false, actions, errors: [{ code: 'EMPTY', message: '没有任何动作' }] }

  for (const [index, raw] of input.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ index, code: 'BAD_ACTION', message: '动作必须是对象' })
      continue
    }
    let verb = ''
    let params = {}
    if (typeof raw.action === 'string') {
      verb = raw.action
      params = raw.params && typeof raw.params === 'object' ? { ...raw.params } : { ...raw }
      delete params.action
      delete params.params
    } else if (typeof raw.verb === 'string') {
      verb = raw.verb
      params = raw.params && typeof raw.params === 'object' ? { ...raw.params } : {}
    } else {
      const keys = Object.keys(raw).filter((key) => !key.startsWith('_'))
      if (keys.length !== 1) {
        errors.push({ index, code: 'BAD_ACTION', message: `一个动作只能有一个动词，收到 ${keys.length} 个` })
        continue
      }
      verb = keys[0]
      const value = raw[verb]
      params = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {}
    }

    verb = String(verb || '').trim()
    const spec = CATALOGUE[verb]
    if (!spec) {
      errors.push({ index, code: 'UNKNOWN_VERB', message: `没有这个动词：${verb}` })
      continue
    }
    if (spec.level === 'exp' && !options.allowExperimental) {
      errors.push({ index, code: 'EXP_ACTION', message: `${verb} 是 experimental，需要 allowExperimental` })
      continue
    }
    if (spec.level === 'raw' && !options.allowRawEffect) {
      errors.push({ index, code: 'EXP_ACTION', message: 'raw_effect 需要 allowRawEffect' })
      continue
    }

    // 补默认值 / 必填检查 / 类型检查
    const normalized = {}
    let failed = null
    for (const [name, type] of Object.entries(spec.params)) {
      const required = !isOptional(type)
      let value = params[name]
      if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
        if (name === 'scope' && type === 'scope?') {
          normalized.scope = 'country'
          continue
        }
        if (name === 'type' && type === 'type?') {
          normalized.type = 'war'
          continue
        }
        if (name === 'status' && type === 'bool?') {
          normalized.status = true
          continue
        }
        if (name === 'immortal' && type === 'bool?') {
          normalized.immortal = true
          continue
        }
        if (name === 'freeze' && type === 'bool?') {
          normalized.freeze = true
          continue
        }
        if (required) {
          failed = { index, code: 'MISSING_PARAM', message: `${verb} 缺少参数 ${name}` }
          break
        }
        continue
      }
      if (baseType(type) === 'number') value = Number(value)
      if (baseType(type) === 'bool' || type === 'bool?') value = Boolean(value)
      if (baseType(type) === 'enum') value = String(value).toLowerCase()
      if (baseType(type) === 'stance') value = String(value).toLowerCase()
      if (baseType(type) === 'resource') value = String(value).trim()
      if (baseType(type) === 'text') value = String(value).replace(/"/g, "'")
      if (baseType(type) === 'key' || baseType(type) === 'type') value = String(value).trim()
      const problem = checkValue(name, type, value)
      if (problem) {
        failed = { index, code: problem.code || 'BAD_PARAM', message: problem.message || String(problem) }
        break
      }
      normalized[name] = value
    }
    if (failed) {
      errors.push(failed)
      continue
    }

    if (verb === 'resource') {
      const limit = Number(options.maxResourcePerAction ?? 50000)
      if (Math.abs(normalized.amount) > limit) {
        errors.push({ index, code: 'LIMIT_EXCEEDED', message: `单次资源改动 ${normalized.amount} 超过上限 ${limit}` })
        continue
      }
    }
    if (verb === 'add_modifier' && normalized.days !== undefined) {
      if (!Number.isFinite(normalized.days) || normalized.days === 0) {
        errors.push({ index, code: 'BAD_PARAM', message: 'days 必须是非零整数（-1 = 永久）' })
        continue
      }
      normalized.days = Math.round(normalized.days)
    }

    actions.push({ index, verb, params: normalized, level: spec.level, scope: spec.scope })
  }

  return { ok: errors.length === 0, actions, errors }
}

export function catalogueForModel() {
  return Object.entries(CATALOGUE).map(([verb, spec]) => ({
    verb,
    level: spec.level,
    scope: spec.scope,
    params: spec.params,
    help: spec.help,
  }))
}

export { CATALOGUE as _CATALOGUE }
