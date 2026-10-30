/**
 * 存档 → 与日志通道同形的数据。
 *
 * 这一层是「猜测 + 容错」：每个字段都走 mapping 里的候选路径，取不到就 null，
 * 并记 warning。**绝不抛异常**——存档解析失败不应该让工具调用崩掉，而应该
 * 让模型看到「这一块没读到，原因是 X」。
 *
 * @module dsh-stellaris-bridge/save/mapper
 */
import { collect, get, idMapToArray, normalizeDate, pick } from './clausewitz.js'

function unwrapScalar(value) {
  if (value === null || value === undefined) return null
  if (Array.isArray(value)) return unwrapScalar(value[0])
  if (typeof value === 'object') {
    if (value.amount !== undefined) return unwrapScalar(value.amount)
    if (value.value !== undefined) return unwrapScalar(value.value)
    if (value.stockpile !== undefined) return unwrapScalar(value.stockpile)
    return null
  }
  return value
}

function numeric(value) {
  const scalar = unwrapScalar(value)
  if (scalar === null) return null
  const n = Number(scalar)
  return Number.isFinite(n) ? n : null
}

function asObject(node) {
  if (!node || typeof node !== 'object') return {}
  return node
}

/** 把 `{ tech_a = { ... } tech_b = yes }` 折成 key 列表。 */
function keysOf(node) {
  if (Array.isArray(node)) return node.map(String).filter(Boolean)
  const obj = asObject(node)
  const keys = []
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('@') || key === '__id' || key === '__anon') continue
    if (value === false || value === 'no' || value === null) continue
    keys.push(key)
  }
  return keys
}

/** civics/ethics 这类「可能是 `{ a b }`、`{ a=1 }`、`[a,b]`」的列表。 */
function stringList(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') return [value]
  if (typeof value === 'object') {
    if (value['@values'] !== undefined) {
      const raw = value['@values']
      return (Array.isArray(raw) ? raw : [raw]).map(String).filter(Boolean)
    }
    return Object.keys(value).filter((key) => !key.startsWith('@') && key !== '__id')
  }
  return [String(value)]
}

function findPlayerCountryId(gamestate) {
  const candidates = []
  const walk = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 4) return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    const direct = node.country ?? node.country_id
    if (direct !== undefined) candidates.push(direct)
    for (const [key, value] of Object.entries(node)) {
      if (key === 'country' || key === 'country_id') continue
      walk(value, depth + 1)
    }
  }
  walk(gamestate.player)
  for (const value of candidates) {
    const n = Number(unwrapScalar(value))
    if (Number.isFinite(n)) return n
  }
  return null
}

function countryIndex(gamestate) {
  const node = gamestate.country
  if (!node) return new Map()
  const map = new Map()
  if (Array.isArray(node)) {
    node.forEach((entry, index) => map.set(index, entry))
    return map
  }
  for (const [key, value] of Object.entries(node)) {
    if (/^\d+$/.test(key) && value && typeof value === 'object') map.set(Number(key), value)
    else if (key === 'country' && value && typeof value === 'object') {
      for (const [id, entry] of Object.entries(value)) {
        if (/^\d+$/.test(id)) map.set(Number(id), entry)
      }
    }
  }
  return map
}

function container(node, names) {
  if (!node || typeof node !== 'object') return null
  for (const name of names) {
    const found = node[name]
    if (found && typeof found === 'object') {
      // `foo = { foo = { ... } }` 这种再剥一层
      if (found[name] && typeof found[name] === 'object') return found[name]
      return found
    }
  }
  return node
}

function buildingKeys(planet) {
  const keys = new Set()
  const node = planet.buildings ?? planet.building
  if (node && typeof node === 'object') {
    if (Array.isArray(node)) {
      for (const entry of node) {
        if (typeof entry === 'string') keys.add(entry)
        else if (entry && typeof entry === 'object') {
          const key = entry.building ?? entry.type ?? entry.key
          if (typeof key === 'string') keys.add(key)
        }
      }
    } else {
      for (const [key, value] of Object.entries(node)) {
        if (value && typeof value === 'object') {
          const inner = value.building ?? value.type ?? value.key
          if (typeof inner === 'string') keys.add(inner)
        } else if (typeof value === 'string' && value !== 'none') {
          keys.add(value)
        } else if (typeof value === 'string') {
          keys.add(key)
        }
      }
    }
  }
  for (const key of collect(planet, 'building', 200)) {
    if (key && key !== 'none' && key !== 'building') keys.add(key)
  }
  return [...keys].filter((key) => key.startsWith('building_') || key.startsWith('b_'))
}

function districtKeys(planet) {
  const keys = new Set()
  const node = planet.districts ?? planet.district
  if (node && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      if (/^district_/.test(key)) keys.add(key)
      else if (value && typeof value === 'object' && typeof value.type === 'string') keys.add(value.type)
    }
  }
  for (const key of collect(planet, 'district', 100)) {
    if (key.startsWith('district_')) keys.add(key)
  }
  return [...keys]
}

/**
 * @param {object} params {gamestate, meta, mapping}
 * @returns {object}
 */
export function extractArchive({ gamestate, meta, mapping }) {
  const warnings = []
  const out = {
    source: 'save',
    meta: {},
    empire: null,
    resources: {},
    planets: [],
    leaders: [],
    fleets: [],
    techs: [],
    traditions: [],
    perks: [],
    relics: [],
    edicts: [],
    policies: [],
    diplo: [],
    wars: [],
    situations: [],
    chains: [],
    flags: [],
    variables: [],
    stats: {},
    warnings,
  }

  const metaRoot = asObject(meta)
  out.meta = {
    date: normalizeDate(pick(metaRoot, mapping.meta.date)),
    version: pick(metaRoot, mapping.meta.version) ?? null,
    ironman: Boolean(pick(metaRoot, mapping.meta.ironman)),
    playerName: pick(metaRoot, mapping.meta.playerName) ?? null,
  }
  // 开局设置（星系大小/难度/堕落帝国数等）：各版本位置不同，读不到就留空
  const setupRoot = gamestate.galaxy ?? gamestate.galaxy_setup ?? {}
  out.meta.galaxySize = numeric(pick(setupRoot, ['size', 'galaxy_size']))
  out.meta.difficulty = pick(setupRoot, ['difficulty', 'game_difficulty']) ?? null
  out.meta.ironman = out.meta.ironman || Boolean(pick(gamestate, ['ironman', 'game_state.ironman']))

  const playerId = findPlayerCountryId(gamestate)
  const countries = countryIndex(gamestate)
  const country = playerId !== null ? countries.get(playerId) : undefined
  if (!country) {
    warnings.push('没定位到玩家国家（player.country 缺失或 country 表结构变了）')
    return out
  }

  out.stats.countries = countries.size
  out.empire = {
    name: pick(country, mapping.country.name) ?? null,
    authority: pick(country, mapping.country.authority) ?? null,
    government: pick(country, mapping.country.government) ?? null,
    ruler: pick(country, mapping.country.ruler) ?? null,
    capital: pick(country, mapping.country.capital) ?? null,
    civics: stringList(pick(country, mapping.country.civics)),
    ethics: stringList(pick(country, mapping.country.ethics)),
    origin: pick(country, ['origin', 'empire_origin', 'origin_key']) ?? null,
    species: pick(country, ['species', 'founder_species', 'dominant_species']) ?? null,
    countryId: playerId,
  }

  const sumIncome = (node, key, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 3) return 0
    let total = 0
    for (const [k, v] of Object.entries(node)) {
      if (k === key) total += Number(v) || 0
      else if (v && typeof v === 'object') total += sumIncome(v, key, depth + 1)
    }
    return total
  }
  const incomeRoot = country.budget?.current_month?.income
  for (const key of ['energy', 'minerals', 'food', 'alloys', 'consumer_goods', 'unity', 'influence']) {
    const stock = numeric(pick(country, mapping.country[`resources.${key}`] || []))
    const income = incomeRoot ? sumIncome(incomeRoot, key) : null
    if (stock === null && income === null) continue
    out.resources[key] = { key, stock, income: income === null ? null : Number(income.toFixed(3)) }
  }
  if (Object.keys(out.resources).length === 0) {
    warnings.push('资源没读到：4.5 的库存不在 country 里（日志通道会给 stock/income）')
  }

  out.techs = keysOf(pick(country, mapping.country.techs)).map((key) => ({ key }))
  out.traditions = keysOf(pick(country, mapping.country.traditions)).map((key) => ({ key }))
  out.perks = keysOf(pick(country, mapping.country.perks)).map((key) => ({ key }))
  out.relics = keysOf(pick(country, mapping.country.relics)).map((key) => ({ key }))
  out.edicts = keysOf(pick(country, mapping.country.edicts)).map((key) => ({ key }))
  out.policies = Object.entries(asObject(pick(country, mapping.country.policies))).map(([key, value]) => ({
    key,
    option: typeof value === 'string' ? value : String(unwrapScalar(value) ?? ''),
  }))

  // ---- 行星
  const planetRoot = container(gamestate.planets, ['planet', 'planets'])
  const planetList = idMapToArray(planetRoot)
  for (const planet of planetList) {
    const planetOwnerRaw = planet.owner ?? planet.owner_id
    if (planetOwnerRaw === undefined || planetOwnerRaw === null) continue
    const owner = Number(unwrapScalar(planetOwnerRaw))
    if (!Number.isFinite(owner)) continue
    if (playerId !== null && owner !== playerId) continue
    out.planets.push({
      ord: out.planets.length,
      name: pick(planet, mapping.planet.name) ?? null,
      size: numeric(pick(planet, mapping.planet.size)),
      cls: pick(planet, mapping.planet.class) ?? null,
      designation: pick(planet, mapping.planet.designation) ?? null,
      pops: numeric(pick(planet, mapping.planet.pops)),
      stability: numeric(pick(planet, mapping.planet.stability)),
      crime: numeric(pick(planet, mapping.planet.crime)),
      housing: numeric(pick(planet, ['housing', 'free_housing'])),
      amenities: numeric(pick(planet, ['amenities', 'free_amenities'])),
      governor: pick(planet, mapping.planet.governor) ?? null,
      sector: pick(planet, ['sector', 'sector_id']) ?? null,
      megastructure: pick(planet, ['megastructure', 'megastructure_type']) ?? null,
      buildings: buildingKeys(planet),
      districts: districtKeys(planet),
      source: 'save',
    })
  }
  if (planetList.length && out.planets.length === 0) {
    warnings.push('行星列表读到了，但没有一颗 owner 匹配玩家；owner 字段可能改名')
  }
  out.stats.planets = out.planets.length

  // ---- 领袖
  const leaderRoot = container(gamestate.leaders, ['leader', 'leaders'])
  for (const leader of idMapToArray(leaderRoot)) {
    const leaderOwnerRaw = leader.country ?? leader.owner
    if (leaderOwnerRaw === undefined || leaderOwnerRaw === null) continue
    const owner = Number(unwrapScalar(leaderOwnerRaw))
    if (!Number.isFinite(owner)) continue
    if (playerId !== null && owner !== playerId) continue
    out.leaders.push({
      id: leader.__id ?? null,
      name: pick(leader, mapping.leader.name) ?? null,
      level: numeric(pick(leader, mapping.leader.level)),
      cls: pick(leader, mapping.leader.class) ?? null,
      traits: keysOf(pick(leader, mapping.leader.traits)),
      assignment: pick(leader, mapping.leader.assignment) ?? null,
      source: 'save',
    })
  }

  // ---- 舰队
  const fleetRoot = container(gamestate.fleet, ['fleet', 'fleets'])
  for (const fleet of idMapToArray(fleetRoot)) {
    const fleetOwnerRaw = fleet.owner ?? fleet.country
    if (fleetOwnerRaw === undefined || fleetOwnerRaw === null) continue
    const owner = Number(unwrapScalar(fleetOwnerRaw))
    if (!Number.isFinite(owner)) continue
    if (playerId !== null && owner !== playerId) continue
    const shipsNode = fleet.ships ?? fleet.ship
    out.fleets.push({
      id: fleet.__id ?? null,
      name: pick(fleet, mapping.fleet.name) ?? null,
      ships: numeric(pick(fleet, mapping.fleet.ships)) ?? (shipsNode && typeof shipsNode === 'object' ? Object.keys(shipsNode).length : null),
      strength: numeric(pick(fleet, mapping.fleet.strength)),
      source: 'save',
    })
  }

  // ---- 其它国家（给 add_trust 这类动作用）
  for (const [id, other] of countries) {
    if (id === playerId) continue
    out.diplo.push({
      countryId: id,
      country: pick(other, ['name', 'custom_name']) ?? String(id),
      opinion: null,
      trust: null,
      attitude: null,
      source: 'save',
    })
  }

  const warRoot = container(gamestate.war, ['war', 'wars'])
  for (const war of idMapToArray(warRoot)) {
    out.wars.push({
      name: pick(war, ['name']) ?? null,
      id: war.__id ?? null,
      source: 'save',
    })
  }

  // ---- 局势 / 事件链 / 旗标 / 变量
  // 这四样是「事件链全链」的骨架：
  //   situation  正在推进的局势（含 progress/stage）
  //   event_chain 历史链（如果该版本存档里存了）
  //   flags/variables 模组/原版用来记「链走到哪一步」的标记
  const situationRoot = container(gamestate.situations, ['situation', 'situations'])
  for (const item of idMapToArray(situationRoot)) {
    const owner = Number(unwrapScalar(item.country ?? item.owner))
    if (Number.isFinite(owner) && playerId !== null && owner !== playerId) continue
    out.situations.push({
      key: pick(item, ['key', 'type', 'name']) ?? null,
      progress: numeric(pick(item, ['progress', 'current_progress'])),
      stage: pick(item, ['stage', 'phase', 'current_stage']) ?? null,
      id: item.__id ?? null,
      source: 'save',
    })
  }

  const chainRoot = container(gamestate.event_chain, ['event_chain', 'chain', 'event_chains'])
  for (const item of idMapToArray(chainRoot)) {
    out.chains.push({
      id: item.__id ?? pick(item, ['id', 'key']) ?? null,
      key: pick(item, ['key', 'name', 'type']) ?? null,
      status: pick(item, ['status', 'state']) ?? null,
      nodes: collect(item, 'event', 200),
      source: 'save',
    })
  }

  for (const flag of keysOf(pick(country, ['flags', 'country_flags']))) {
    out.flags.push({ key: flag, date: out.meta.date, source: 'save' })
  }
  const variables = asObject(pick(country, ['variables', 'country_variables']))
  for (const [key, value] of Object.entries(variables)) {
    if (/^(focus_|level_|paragon_|global\.)/.test(key)) continue
    const numericValue = Number(unwrapScalar(value))
    out.variables.push({ key, value: Number.isFinite(numericValue) ? numericValue : null, source: 'save' })
  }

  out.stats.leaders = out.leaders.length
  out.stats.fleets = out.fleets.length
  out.stats.techs = out.techs.length
  out.stats.situations = out.situations.length
  out.stats.chains = out.chains.length
  out.stats.flags = out.flags.length
  return out
}
