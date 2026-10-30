/**
 * 存档字段映射：默认候选路径。
 *
 * 为什么是「候选路径数组」而不是「一条固定路径」：
 * 群星存档的 schema 每个大版本都会动（尤其 3.x → 4.x 的经济模块），
 * 写死一条路径就是等着某天全部读不到。这里对每个字段给 2~4 个候选，
 * 取第一个有值的；读不到就返回 null，并在 warnings 里记一笔。
 *
 * 用户可以在 `~/.dsh/stellaris-bridge/mapping.json` 里覆盖**任意一层**，
 * 格式与这里一致（深合并）。比如 4.5 把资源挪到了别的模块，就改成：
 *
 *   { "resources": { "energy": ["economy.stockpile.energy"] } }
 *
 * 每个 section 的路径都是相对「该 section 的根对象」的：
 *   meta    → meta 文件解析结果
 *   country → 玩家国家对象
 *   planet  → 单个行星对象
 *
 * @module dsh-stellaris-bridge/save/mapping
 */

export const DEFAULT_MAPPING = {
  meta: {
    date: ['date'],
    version: ['version', 'stellaris_version'],
    ironman: ['ironman'],
    playerName: ['player_name', 'name', 'player.0.name'],
    checksum: ['checksum'],
  },
  country: {
    name: ['name', 'custom_name'],
    authority: ['authority'],
    government: ['government', 'government_type'],
    ruler: ['ruler', 'ruler_name'],
    capital: ['capital', 'capital_planet'],
    civics: ['civics', 'government.civics'],
    ethics: ['ethos', 'ethics'],
    // 资源：不同版本分别躺在 resources / budget / economy 里
    'resources.energy': ['resources.energy', 'budget.current_month.energy', 'economy.energy'],
    'resources.minerals': ['resources.minerals', 'budget.current_month.minerals', 'economy.minerals'],
    'resources.food': ['resources.food', 'budget.current_month.food', 'economy.food'],
    'resources.alloys': ['resources.alloys', 'budget.current_month.alloys', 'economy.alloys'],
    'resources.consumer_goods': ['resources.consumer_goods', 'budget.current_month.consumer_goods'],
    'resources.unity': ['resources.unity', 'budget.current_month.unity'],
    'resources.influence': ['resources.influence', 'budget.current_month.influence'],
    // 这三桶在存档里的键名五花八门，给足候选
    techs: ['tech_status.technology', 'tech_status.tech', 'technology.tech', 'tech.tech', 'techs.tech'],
    traditions: ['traditions', 'tradition_manager.traditions'],
    perks: ['ascension_perks', 'ascension_perk'],
    relics: ['relics', 'relic_manager.relics'],
    edicts: ['edicts', 'active_edicts'],
    policies: ['policies', 'policy_manager'],
    leaderIds: ['leaders', 'leader_ids'],
  },
  planet: {
    name: ['name', 'custom_name'],
    size: ['planet_size', 'size'],
    class: ['planet_class', 'class'],
    designation: ['designation', 'planet_designation'],
    pops: ['num_pops', 'pop_amount', 'pops'],
    stability: ['stability'],
    crime: ['crime'],
    housing: ['housing', 'free_housing'],
    amenities: ['amenities', 'free_amenities'],
    governor: ['governor', 'governor_id'],
    buildings: ['buildings', 'building'],
    districts: ['districts', 'district'],
  },
  leader: {
    name: ['name'],
    level: ['level', 'skill'],
    class: ['class', 'leader_class'],
    traits: ['traits', 'trait'],
    country: ['country', 'owner'],
    assignment: ['assignment', 'location'],
  },
  fleet: {
    name: ['name'],
    ships: ['ships', 'num_ships'],
    owner: ['owner', 'country'],
    strength: ['military_power', 'strength'],
  },
}

/** 深合并用户覆盖。 */
export function mergeMapping(base, override) {
  const out = { ...base }
  if (!override || typeof override !== 'object') return out
  for (const [section, value] of Object.entries(override)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base[section] && typeof base[section] === 'object') {
      out[section] = { ...base[section], ...value }
    } else {
      out[section] = value
    }
  }
  return out
}
