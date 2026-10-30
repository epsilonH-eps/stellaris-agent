/**
 * 读取层：一次把「这一局」尽量读全。
 *
 * 层次（对应上游的 progressive disclosure）：
 *  L1 全局：get_status（日期/暂停/速度/资源/容量/计数）
 *  L2 域：政府/内阁/法令/传统/科研/领袖/物种/市场/外交/战争/事件/局势/银河/舰队
 *  L3 明细：每颗殖民地的详情/岗位/陆军/可建项/特区/障碍/决议/改造/特征；
 *           每支舰队的详情；每个已接触国家的外交选项；每场战争的战争目标；
 *           每颗相关星系的建筑与巨构。
 *  + 元数据：已启用模组（本地/工坊/DLC）、最新存档 meta、已激活事件链（含后续）。
 *
 * 容错：单个方法失败只记录到 `errors`，并把「不认识的方法」记进 `unsupported`，
 * 后续不再重试——不同版本的 DLL 方法表不完全一样。
 *
 * @module stellaris-agent/reader
 */
import { listMods, modsDigest } from './mods.mjs'
import { resolveActiveChains } from './events.mjs'
import { readSaveState } from './save.mjs'

export function asArray(value) {
  if (Array.isArray(value)) return value
  if (value && typeof value === 'object') {
    // 不同 DLL 版本会把列表放在不同键里（items/events/alerts/…）
    for (const key of ['items', 'events', 'alerts', 'notifications', 'situations', 'wars', 'fleets', 'list', 'rows', 'data']) {
      if (Array.isArray(value[key])) return value[key]
    }
  }
  return []
}

function uniqueNumbers(list) {
  return [...new Set(list.map(Number).filter((value) => Number.isFinite(value)))]
}

/** 从多种可能的返回结构里抽殖民地列表。 */
export function extractColonies(world) {
  const out = new Map()
  const push = (row) => {
    if (!row || typeof row !== 'object') return
    const id = row.planet_id ?? row.planetId ?? row.id
    if (!Number.isFinite(Number(id))) return
    if (!out.has(Number(id))) out.set(Number(id), { planet_id: Number(id), ...row })
  }
  const summaries = [
    world.outliner?.sectors_summary,
    world.status?.outliner?.sectors_summary,
    world.sectors?.sectors_summary,
  ].filter(Boolean)
  for (const summary of summaries) {
    for (const sector of asArray(summary.sectors)) {
      for (const colony of asArray(sector.colonies_summary)) push(colony)
      for (const colony of asArray(sector.colonies)) push(colony)
    }
    for (const colony of asArray(summary.colonies_summary)) push(colony)
  }
  for (const colony of asArray(world.outliner?.colonies)) push(colony)
  for (const colony of asArray(world.status?.colonies)) push(colony)
  for (const colony of asArray(world.planetList?.planets)) push(colony)
  return [...out.values()]
}

/** 从多种可能的返回结构里抽舰队列表（含民用）。 */
export function isValidColonyId(value) {
  const id = Number(value)
  return Number.isFinite(id) && id >= 0 && id !== 4294967295
}

export function extractFleets(world) {
  const out = new Map()
  const push = (row, kind) => {
    if (!row || typeof row !== 'object') return
    const id = row.fleet_id ?? row.fleetId ?? row.id
    if (!Number.isFinite(Number(id))) return
    if (!out.has(Number(id))) out.set(Number(id), { fleet_id: Number(id), kind, ...row })
  }
  for (const fleet of asArray(world.fleets?.fleets)) push(fleet, 'mixed')
  for (const fleet of asArray(world.militaryFleets?.fleets)) push(fleet, 'military')
  for (const fleet of asArray(world.civilianFleets?.science_ships)) push(fleet, 'science')
  for (const fleet of asArray(world.civilianFleets?.construction_ships)) push(fleet, 'construction')
  for (const fleet of asArray(world.civilianFleets?.colony_ships)) push(fleet, 'colony')
  for (const fleet of asArray(world.civilianFleets?.transport_fleets)) push(fleet, 'transport')
  return [...out.values()]
}

export class Reader {
  /**
   * @param {object} options
   * @param {{request:Function}} options.bridge
   * @param {object} options.config
   * @param {string} options.home
   * @param {Function} [options.log]
   * @param {{userDir:string, installDir:string, saveDir:string}} [options.paths]
   */
  constructor({ bridge, config, home, log = () => {}, paths = {} }) {
    this.bridge = bridge
    this.config = config
    this.home = home
    this.log = log
    this.paths = paths
    this.unsupported = new Set()
    this.errors = []
    this.stats = { calls: 0, ok: 0, failed: 0, lastAt: null }
    this.lastWorld = null
  }

  setPaths(paths) {
    this.paths = { ...this.paths, ...paths }
  }

  async call(method, params = {}) {
    if (this.unsupported.has(method)) {
      const error = new Error(`方法不被当前 DLL 支持：${method}`)
      error.code = 'UNSUPPORTED'
      throw error
    }
    this.stats.calls += 1
    const started = Date.now()
    try {
      const value = await this.bridge.request(method, params)
      this.stats.ok += 1
      this.stats.lastAt = Date.now()
      this.log('read.call', { method, ms: Date.now() - started })
      return value
    } catch (error) {
      this.stats.failed += 1
      this.stats.lastAt = Date.now()
      const message = String(error?.message || error)
      const code = error?.code || 'RPC_ERROR'
      if (/unknown|unsupported|not\s*found|invalid method|没有|不支持/i.test(message)) this.unsupported.add(method)
      this.errors.push({ method, params, code, message })
      this.log('read.call.failed', { method, code, message })
      throw error
    }
  }

  async safe(method, params = {}, fallback = null) {
    try {
      return await this.call(method, params)
    } catch {
      return fallback
    }
  }

  /**
   * 读一次世界。
   * @param {object} options
   * @param {boolean} [options.deep] 是否读每颗殖民地/舰队的明细
   * @param {boolean} [options.includeSave] 是否读最新存档 meta
   * @param {import('./events.mjs').EventGraph} [options.eventGraph]
   * @param {{userDir?:string, installDir?:string, saveDir?:string}} [options.paths]
   */
  async readWorld(options = {}) {
    const read = { ...(this.config?.read || {}), ...(options.read || {}) }
    const deep = options.deep ?? read.deep !== false
    const paths = { ...this.paths, ...(options.paths || {}) }
    this.errors = []
    this.stats = { calls: 0, ok: 0, failed: 0, lastAt: null }
    const started = Date.now()

    const status = await this.call('get_status')
    const world = {
      readAt: new Date().toISOString(),
      readMs: 0,
      inGame: Boolean(status?.in_game),
      date: status?.date?.formatted || status?.date || null,
      paused: Boolean(status?.is_paused),
      speed: status?.speed ?? null,
      status,
      resources: status?.resources || {},
      outliner: await this.safe('get_outliner'),
      sectors: await this.safe('get_sectors'),
      government: await this.safe('get_government'),
      civics: await this.safe('get_civics'),
      edicts: await this.safe('get_edicts'),
      traditions: await this.safe('get_traditions'),
      research: await this.safe('get_research_state'),
      leaders: await this.safe('get_leaders'),
      species: await this.safe('get_species', { mode: 'empire' }),
      market: await this.safe('get_market'),
      contacts: await this.safe('get_contacts'),
      pendingDiplomacy: await this.safe('get_pending_diplomacy'),
      wars: await this.safe('get_wars'),
      activeEvents: asArray(await this.safe('get_active_events')),
      alerts: asArray(await this.safe('get_alerts')),
      notifications: asArray(await this.safe('get_notifications')),
      situations: await this.safe('get_situation_log'),
      galaxy: await this.safe('get_galaxy_overview'),
      fleets: await this.safe('get_fleets', { include_civilian: read.includeCivilianFleets !== false }),
      militaryFleets: await this.safe('get_military_fleets'),
      civilianFleets: read.includeCivilianFleets === false ? null : await this.safe('get_civilian_fleets'),
      armies: await this.safe('get_armies'),
      designs: await this.safe('get_ship_designs'),
      designCatalog: await this.safe('get_ship_design_catalog'),
      discoveries: await this.safe('get_discoveries'),
      colonies: [],
      colonyIssues: [],
      fleetsDetail: [],
      systems: {},
      diplomacyOptions: [],
      warGoals: [],
      galaxyMap: null,
      megaScan: null,
      mods: null,
      save: null,
      eventChains: null,
      errors: [],
      unsupported: [],
      stats: null,
    }

    world.colonies = extractColonies(world).filter((colony) => colony.colony_id === undefined || isValidColonyId(colony.colony_id))
    const overviewCapital = Number(world.galaxy?.player?.capital_system_id)
    if (Number.isFinite(overviewCapital) && overviewCapital > 0) world.capitalSystemId = overviewCapital
    world.fleetsAll = extractFleets(world)
    const capitalPlanet = world.colonies[0]?.planet_id ?? status?.capital_planet_id ?? null

    // ---- 殖民地明细
    if (deep) {
      const colonyRows = []
      for (const colony of world.colonies) {
        const planetId = colony.planet_id
        const details = await this.safe('get_planet_details', { planet_id: planetId })
        const colonyId = details?.colony_id ?? colony.colony_id
        if (colonyId !== undefined && colonyId !== null && !isValidColonyId(colonyId)) {
          this.log('reader.colony.invalid', { planetId, colonyId })
          world.colonyIssues.push({ planet_id: planetId, colony_id: colonyId, reason: 'COLONY_LOOKUP_FAILED', system_id: details?.system_id ?? null })
          // 保留在殖民地列表里（统计/首都仍正确），但标记为不可操作，避免反复派发必败的建造任务
          colonyRows.push({ ...colony, details, unreadable: true, readError: 'COLONY_LOOKUP_FAILED' })
          continue
        }
        colonyRows.push({
          ...colony,
          details,
          jobs: await this.safe('get_planet_jobs', { planet_id: planetId }),
          armies: await this.safe('get_planet_armies', { planet_id: planetId }),
          buildableBuildings: await this.safe('get_buildable_buildings', { planet_id: planetId }),
          buildableDistricts: await this.safe('get_buildable_districts', { planet_id: planetId }),
          districtZones: await this.safe('get_available_district_zones', { planet_id: planetId }),
          clearableBlockers: await this.safe('get_clearable_blockers', { planet_id: planetId }),
          decisions: await this.safe('get_planetary_decisions', { planet_id: planetId }),
          features: await this.safe('get_planetary_features', { planet_id: planetId }),
          terraforming: await this.safe('get_terraforming_options', { planet_id: planetId }),
        })
        const systemId = details?.system_id ?? colony.system_id
        if (Number.isFinite(Number(systemId))) await this.ensureSystem(world, Number(systemId))
        if (planetId === capitalPlanet && details?.system_id) world.capitalSystemId = Number(details.system_id)
      }
      world.colonies = colonyRows
    }

    // ---- 舰队明细
    if (deep) {
      const rawRows = [
        ...asArray(world.fleets?.fleets),
        ...asArray(world.militaryFleets?.fleets),
        ...asArray(world.civilianFleets?.science_ships),
        ...asArray(world.civilianFleets?.construction_ships),
        ...asArray(world.civilianFleets?.colony_ships),
        ...asArray(world.civilianFleets?.transport_fleets),
      ]
      const byId = new Map()
      for (const row of rawRows) {
        const id = Number(row?.fleet_id ?? row?.fleetId ?? row?.id)
        if (!Number.isFinite(id)) continue
        const previous = byId.get(id)
        byId.set(id, previous ? { ...previous, ...row, system_id: row.system_id ?? previous.system_id } : row)
      }
      const num = (...values) => {
        for (const value of values) {
          const parsed = Number(value)
          if (Number.isFinite(parsed) && parsed >= 0) return parsed
        }
        return null
      }
      for (const fleet of world.fleetsAll) {
        const raw = byId.get(Number(fleet.fleet_id)) || null
        const systemId = num(
          raw?.system_id,
          raw?.systemId,
          raw?.center_system_id,
          raw?.location?.system_id,
          raw?.system?.id,
          fleet.system_id,
          fleet.center_system_id,
        )
        if (systemId !== null) fleet.system_id = systemId
        world.fleetsDetail.push({
          fleet_id: fleet.fleet_id,
          kind: fleet.kind,
          summary: { ...fleet, system_id: systemId ?? fleet.system_id ?? null },
          detail: raw,
          system_id: systemId ?? null,
        })
        if (systemId !== null) await this.ensureSystem(world, systemId)
      }

      world.fleetSystems = Object.fromEntries(world.fleetsAll.map((fleet) => [fleet.fleet_id, fleet.system_id ?? null]))
    }

    // ---- 外交选项 / 战争目标
    if (deep && read.includeDiplomacyOptions !== false) {
      const contacts = asArray(world.contacts?.empires).slice(0, Number(read.maxDiplomacyCountries ?? 24))
      for (const empire of contacts) {
        const countryId = empire?.country_id ?? empire?.empire_id ?? empire?.id
        if (!Number.isFinite(Number(countryId))) continue
        world.diplomacyOptions.push({
          country_id: Number(countryId),
          name: empire?.name ?? null,
          options: await this.safe('get_diplomacy_options', { country_id: Number(countryId) }),
        })
      }
    }
    if (deep) {
      for (const war of asArray(world.wars?.wars)) {
        const warId = war?.war_id ?? war?.id
        if (!Number.isFinite(Number(warId))) continue
        world.warGoals.push({ war_id: Number(warId), candidates: await this.safe('get_war_goal_candidates', { war_id: Number(warId) }) })
      }
    }

    // ---- 银河图 + 巨构扫描（只扫已拥有/已知星系里带 M 标记的）
    if (deep && read.includeGalaxyMap !== false && world.capitalSystemId) {
      world.galaxyMap = await this.safe('get_galaxy_map', {
        center_system_id: world.capitalSystemId,
        jumps: Number(read.galaxyMapJumps ?? 60),
      })
      const megaSystems = []
      for (const row of asArray(world.galaxyMap?.rows)) {
        if (!Array.isArray(row)) continue
        const [systemId, name, , , ownerId, , , flags] = row
        if (!String(flags || '').includes('M')) continue
        megaSystems.push({ system_id: Number(systemId), name, owner_id: ownerId ?? null })
      }
      world.megaScan = { systems: megaSystems.length, megastructures: [] }
      for (const system of megaSystems.slice(0, 40)) {
        const detail = await this.ensureSystem(world, system.system_id)
        for (const mega of asArray(detail?.megastructures)) {
          world.megaScan.megastructures.push({ ...mega, system_id: system.system_id, system_name: system.name })
        }
      }
    }

    if (deep) await this.resolveFleetSystems(world)

    // ---- 模组
    world.mods = listMods({ userDir: paths.userDir || '', installDir: paths.installDir || '' })

    // ---- 已激活事件链（含后续）
    if (options.eventGraph) {
      const chains = resolveActiveChains(options.eventGraph, world.activeEvents, {
        depth: Number(read.eventChainDepth ?? 6),
        max: Number(read.maxEventChains ?? 300),
      })
      world.eventChains = { ...chains, index: options.eventGraph.status() }
    } else {
      world.eventChains = { active: [], unresolved: [], count: 0, index: null }
    }

    // ---- 存档 meta（可选，最贵的收尾项）
    if (options.includeSave) {
      try {
        world.save = await readSaveState({
          config: this.config,
          userDir: paths.userDir || '',
          cacheDir: this.home ? `${this.home}/cache` : null,
          log: this.log,
        })
      } catch (error) {
        world.save = { error: String(error?.message || error) }
      }
    }

    world.errors = [...this.errors]
    world.unsupported = [...this.unsupported]
    world.stats = { ...this.stats, calls: this.stats.calls }
    world.readMs = Date.now() - started
    world.capitalPlanetId = capitalPlanet
    world.modsDigest = modsDigest(world.mods)
    this.lastWorld = world
    this.log('read.world', {
      ms: world.readMs,
      calls: world.stats.calls,
      failed: world.errors.length,
      colonies: world.colonies.length,
      fleets: world.fleetsAll.length,
      events: world.activeEvents.length,
      mods: world.mods?.enabled ?? 0,
    })
    return world
  }

  async ensureSystem(world, systemId) {
    if (!Number.isFinite(Number(systemId))) return null
    const key = String(systemId)
    if (world.systems[key] !== undefined) return world.systems[key]
    const detail = await this.safe('get_system', { system_id: Number(systemId) })
    world.systems[key] = detail
    return detail
  }

  /**
   * 舰队的 system_id 读取不到时，用银河图 + get_system 反查一次（最多 80 个星系）。
   * 必须在 galaxyMap 建好之后调用。
   */
  async resolveFleetSystems(world) {
    const unresolved = (world.fleetsAll || []).filter((fleet) => !Number.isFinite(Number(fleet.system_id)))
    if (!unresolved.length || !Array.isArray(world.galaxyMap?.rows)) {
      world.fleetSystems = Object.fromEntries((world.fleetsAll || []).map((fleet) => [fleet.fleet_id, fleet.system_id ?? null]))
      return
    }
    const num = (...values) => {
      for (const value of values) {
        const parsed = Number(value)
        if (Number.isFinite(parsed) && parsed >= 0) return parsed
      }
      return null
    }
    const wanted = new Set(unresolved.map((fleet) => Number(fleet.fleet_id)))
    const found = new Map()
    for (const row of world.galaxyMap.rows.slice(0, 80)) {
      if (found.size === wanted.size) break
      const systemId = num(Array.isArray(row) ? row[0] : row?.system_id)
      if (systemId === null) continue
      const detail = await this.ensureSystem(world, systemId)
      const rows = [
        ...asArray(detail?.fleets),
        ...asArray(detail?.owned_fleets),
        ...asArray(detail?.fleet_ids).map((value) => ({ fleet_id: value })),
      ]
      for (const item of rows) {
        const id = num(item?.fleet_id ?? item?.id ?? item)
        if (id !== null && wanted.has(id)) found.set(id, systemId)
      }
    }
    for (const fleet of unresolved) {
      const systemId = found.get(Number(fleet.fleet_id))
      if (systemId === undefined) continue
      fleet.system_id = systemId
      const row = world.fleetsDetail.find((detail) => Number(detail.fleet_id) === Number(fleet.fleet_id))
      if (row) {
        row.system_id = systemId
        row.summary = { ...row.summary, system_id: systemId }
      }
      this.log('reader.fleet.location', { fleetId: fleet.fleet_id, systemId })
    }
    world.fleetSystems = Object.fromEntries((world.fleetsAll || []).map((fleet) => [fleet.fleet_id, fleet.system_id ?? null]))
  }

  status() {
    return {
      stats: this.stats,
      unsupported: [...this.unsupported],
      lastReadAt: this.lastWorld?.readAt || null,
      lastReadMs: this.lastWorld?.readMs || null,
    }
  }
}
