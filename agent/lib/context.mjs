/**
 * 上下文裁剪：把"世界"压成模型真正需要的那一小块。
 *
 * 原则：
 *  - 主会话要**广**：资源/容量/殖民地/舰队/科研/事件/警报/报告各取摘要；
 *  - 单位子会话要**深**：只给这一个单位的明细与"下一步可选项"（候选 key）；
 *  - 一律按字符预算截断，避免一次全量读取把上下文撑爆。
 *
 * @module stellaris-agent/context
 */
import { asArray, isValidColonyId } from './reader.mjs'

export function clip(value, maxChars = 6000) {
  if (value === undefined || value === null) return value
  let text
  try {
    text = JSON.stringify(value)
  } catch {
    return null
  }
  if (text.length <= maxChars) return value
  return { truncated: true, chars: text.length, preview: text.slice(0, maxChars) }
}

function n(value, fallback = null) {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

function resourceSummary(resources) {
  const out = {}
  for (const [key, row] of Object.entries(resources || {})) {
    if (!row || typeof row !== 'object') continue
    const stock = n(row.stockpile ?? row.stock)
    const net = n(row.net ?? (n(row.income, 0) - n(row.expense ?? row.upkeep, 0)))
    if (stock === null && net === null) continue
    out[key] = { stock, net }
  }
  return out
}

function colonySummary(colony) {
  const details = colony.details || {}
  return {
    planet_id: colony.planet_id,
    name: colony.name || details.planet_name || details.name || null,
    pops: n(details.population ?? colony.pops),
    stability: n(details.stability ?? colony.stability),
    free_jobs: n(details.free_jobs ?? details.available_jobs ?? colony.free_jobs),
    designation: details.designation_key ?? details.designation ?? colony.designation ?? null,
    building_slots: n(details.max_buildings ?? details.building_slots),
    districts: n(details.districts_count ?? details.district_slots),
    queue: asArray(details.construction_queue).length,
    armies: n(colony.armies?.total_stationed_armies),
  }
}

function fleetSummary(fleet, detail) {
  const row = detail || fleet
  return {
    fleet_id: n(fleet.fleet_id),
    name: fleet.name || row.name || null,
    kind: fleet.kind || null,
    status: row.status ?? row.stance_name ?? fleet.status ?? null,
    ships: n(row.ship_count ?? row.ships ?? fleet.ships),
    power: n(row.military_power ?? row.power ?? fleet.military_power),
    system_id: n(row.system_id ?? fleet.system_id ?? fleet.location?.system_id),
    stance: row.stance ?? row.stance_name ?? fleet.stance ?? null,
    order: row.order ?? fleet.order ?? null,
  }
}

/**
 * 主会话的全局摘要。
 */
export function worldDigest(world, { maxAlerts = 8, maxEvents = 8, maxCompletions = 20, completions = null } = {}) {
  if (!world) return null
  const colonies = (world.colonies || []).map(colonySummary)
  const fleets = (world.fleetsAll || []).map((fleet) => {
    const detail = (world.fleetsDetail || []).find((row) => row.fleet_id === fleet.fleet_id)?.detail
    return fleetSummary(fleet, detail)
  })
  const research = {}
  for (const area of ['physics', 'society', 'engineering']) {
    const slot = world.research?.[area]
    research[area] = {
      current: slot?.current?.key ?? null,
      progress: n(slot?.current?.progress ?? slot?.progress),
      options: asArray(slot?.options).slice(0, 6).map((option) => option.key || option.tech_key || option.name).filter(Boolean),
    }
  }
  return {
    date: world.date,
    paused: world.paused,
    speed: world.speed,
    inGame: world.inGame,
    resources: resourceSummary(world.resources),
    capacity: {
      naval: n(world.status?.naval_capacity ?? world.status?.fleet_capacity),
      naval_used: n(world.status?.naval_size ?? world.status?.used_naval_capacity),
      starbase: n(world.status?.starbase_capacity),
      starbase_used: n(world.status?.starbases),
      empire_size: n(world.status?.empire_size),
      colonies: n(world.status?.empire_colonies_count) ?? colonies.length,
      systems: n(world.status?.owned_systems ?? world.galaxy?.player?.owned_systems),
    },
    colonies,
    fleets,
    colonyIssues: (world.colonyIssues || []).length,
    research,
    government: {
      ruler: world.government?.ruler_name ?? world.government?.ruler ?? null,
      government: world.government?.government_type_name ?? world.government?.government_type ?? null,
      agenda: world.government?.active_agenda ?? world.government?.active_agenda_name ?? null,
      council: asArray(world.government?.council_seats || world.government?.council).map((seat) => ({
        seat: seat.seat_index ?? seat.index ?? null,
        leader: seat.leader_name ?? seat.name ?? null,
      })),
    },
    edicts: asArray(world.edicts?.active_edicts || world.edicts?.edicts).slice(0, 12),
    traditions: {
      unlocked: asArray(world.traditions?.unlocked_traditions || world.traditions?.traditions).length,
      available: asArray(world.traditions?.available_trees || world.traditions?.trees).slice(0, 6).map((tree) => tree.key || tree.name).filter(Boolean),
      perks: asArray(world.traditions?.ascension_perks || world.traditions?.perks).slice(0, 8),
    },
    alerts: (world.alerts || []).slice(0, maxAlerts).map((alert) => ({
      alert_id: alert.alert_id ?? alert.id ?? null,
      title: alert.title ?? alert.title_key ?? alert.name ?? null,
    })),
    notifications: (world.notifications || []).length,
    activeEvents: (world.activeEvents || []).slice(0, maxEvents).map((event) => ({
      window_id: event.window_id ?? event.id ?? null,
      id: event.event_id ?? event.id ?? null,
      title: event.title ?? event.title_key ?? null,
      options: asArray(event.options).map((option) => option.text ?? option.name ?? option.key ?? null).slice(0, 6),
    })),
    eventChains: (world.eventChains?.active || []).slice(0, maxEvents).map((row) => ({
      window_id: row.windowId,
      id: row.id,
      title: row.title,
      next: (row.chain?.nodes || [])
        .filter((node) => node.level > 0)
        .slice(0, 6)
        .map((node) => ({ id: node.id, title: node.title, hidden: node.hidden })),
    })),
    diplomacy: {
      contacts: asArray(world.contacts?.empires).slice(0, 12).map((empire) => ({
        country_id: empire.country_id ?? empire.id ?? null,
        name: empire.name ?? null,
        opinion: n(empire.opinion),
        attitude: empire.attitude ?? null,
      })),
      pending: asArray(world.pendingDiplomacy?.proposals || world.pendingDiplomacy).slice(0, 6),
      wars: asArray(world.wars?.wars).slice(0, 6).map((war) => ({ war_id: war.war_id ?? war.id ?? null, name: war.name ?? null, score: n(war.warscore) })),
    },
    situations: asArray(world.situations?.situations || world.situations).slice(0, 8).map((situation) => ({
      id: situation.situation_id ?? situation.id ?? null,
      key: situation.key ?? situation.situation_key ?? null,
      stage: situation.stage ?? situation.current_stage ?? null,
      progress: n(situation.progress),
    })),
    megastructures: (world.megaScan?.megastructures || []).slice(0, 10).map((mega) => ({ id: mega.id, type: mega.type, system: mega.system_name ?? mega.system_id })),
    mods: world.modsDigest || null,
    completions: (completions || world.completions || []).slice(-maxCompletions),
  }
}

/**
 * 单个单位子会话的上下文。
 * @param {{type:string, key?:number, id:string}} unit
 */
export function unitContext(unit, world) {
  if (!world) return null
  switch (unit.type) {
    case 'research':
      return {
        date: world.date,
        resources: resourceSummary(world.resources),
        research: world.research,
        traditions: world.traditions,
        situations: world.situations,
      }
    case 'council':
      return {
        date: world.date,
        government: world.government,
        leaders: world.leaders,
        research: world.research,
        unity: world.resources?.unity ?? null,
      }
    case 'laws':
      return {
        date: world.date,
        edicts: world.edicts,
        traditions: world.traditions,
        species: world.species,
        unity: world.resources?.unity ?? null,
        influence: world.resources?.influence ?? null,
      }
    case 'economy':
      return { date: world.date, market: world.market, resources: resourceSummary(world.resources), capacity: { naval: world.status?.naval_capacity } }
    case 'diplomacy':
      return {
        date: world.date,
        contacts: world.contacts,
        pending: world.pendingDiplomacy,
        wars: world.wars,
        warGoals: world.warGoals,
        options: world.diplomacyOptions,
        fleets: (world.fleetsAll || []).filter((fleet) => fleet.kind === 'military').length,
      }
    case 'fleet': {
      const detail = (world.fleetsDetail || []).find((row) => row.fleet_id === unit.key)
      const systemId = detail?.system_id ?? detail?.summary?.system_id ?? null
      const system = Number.isFinite(Number(systemId)) ? world.systems?.[String(systemId)] : null
      const galaxyRows = asArray(world.galaxyMap?.rows).slice(0, 80).map((row) => {
        if (!Array.isArray(row)) return null
        const [id, name, , , ownerId, , , flags] = row
        const text = String(flags || '')
        return {
          system_id: Number(id),
          name: name || null,
          owner_id: ownerId ?? null,
          flags: text || null,
          surveyed: text.includes('S'),
          colonized: text.includes('C'),
          starbase: text.includes('B'),
          fleet_present: text.includes('F'),
          anomaly: text.includes('A'),
          claimed: text.includes('K'),
          megastructure: text.includes('M'),
        }
      }).filter(Boolean)
      return {
        date: world.date,
        fleet: detail || (world.fleetsAll || []).find((fleet) => fleet.fleet_id === unit.key) || null,
        system,
        fleetSystems: world.fleetSystems || null,
        nearbySystems: galaxyRows,
        fleets: (world.fleetsAll || []).map((fleet) => fleetSummary(fleet)),
        designs: asArray(world.designs?.designs || world.designs).slice(0, 20),
        contacts: asArray(world.contacts?.empires).map((empire) => ({ country_id: empire.country_id, name: empire.name })),
        wars: asArray(world.wars?.wars).map((war) => ({ war_id: war.war_id ?? war.id, name: war.name })),
      }
    }
    case 'planet': {
      const colony = (world.colonies || []).find((row) => row.planet_id === unit.key)
      const system = colony?.details?.system_id ? world.systems?.[String(colony.details.system_id)] : null
      return {
        date: world.date,
        planet: colony ? { ...colony, details: clip(colony.details, 8000) } : null,
        system,
        resources: resourceSummary(world.resources),
        buildableRule: 'build_building 只能用 buildableBuildings 里的 key + districtZones 里的 zone_id/district；build_district 只能用 buildableDistricts.buildable[].key；不要猜。',
      }
    }
    case 'event': {
      const windowId = unit.windowId ?? null
      const active = (world.eventChains?.active || []).find(
        (row) => String(row.windowId) === String(windowId) || String(row.id) === String(unit.eventId ?? ''),
      ) || null
      return {
        date: world.date,
        window: active,
        activeEvents: (world.activeEvents || []).slice(0, 6),
        alerts: (world.alerts || []).slice(0, 8),
        resources: resourceSummary(world.resources),
        government: { ruler: world.government?.ruler_name ?? null, agenda: world.government?.active_agenda ?? null },
      }
    }
    default:
      return worldDigest(world)
  }
}

/** 单位清单：从世界里发现所有可 1:1 控制的单位。 */
export function discoverUnits(world, unitsConfig = {}) {
  const units = []
  if (!world) return units
  if (unitsConfig.research !== false) units.push({ id: 'research', type: 'research', name: '国家科研' })
  if (unitsConfig.council !== false) units.push({ id: 'council', type: 'council', name: '国家内阁' })
  if (unitsConfig.laws !== false) units.push({ id: 'laws', type: 'laws', name: '法令与权利' })
  if (unitsConfig.economy !== false) units.push({ id: 'economy', type: 'economy', name: '经济与市场' })
  if (unitsConfig.diplomacy !== false) units.push({ id: 'diplomacy', type: 'diplomacy', name: '外交与战争' })
  if (unitsConfig.fleets !== false) {
    for (const fleet of world.fleetsAll || []) {
      units.push({ id: `fleet:${fleet.fleet_id}`, type: 'fleet', key: fleet.fleet_id, name: fleet.name || `舰队 ${fleet.fleet_id}` })
    }
  }
  if (unitsConfig.planets !== false) {
    for (const colony of world.colonies || []) {
      if (colony.unreadable) continue
      const colonyId = colony.colony_id ?? colony.details?.colony_id
      if (colonyId !== undefined && colonyId !== null && !isValidColonyId(colonyId)) continue
      units.push({ id: `planet:${colony.planet_id}`, type: 'planet', key: colony.planet_id, name: colony.name || colony.details?.planet_name || `星球 ${colony.planet_id}` })
    }
  }
  return units
}
