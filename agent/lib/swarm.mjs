/**
 * 群体调度：主会话分析 + 每个组件一个子会话 + 串行执行器。
 *
 * 规则：
 *  - 主会话按 mainTickSeconds 反复醒来，看全局状态、队列、活跃组件，做判断；
 *  - 每个组件（一支舰队/一颗星球/一个帝国方向）有独立子会话，按 tickSeconds 醒来；
 *  - 子会话只产出 ```stellaris-native 步骤，不直接执行；
 *  - 执行器严格串行；队列 >= queuePauseThreshold 时暂停游戏并立即排空；
 *  - 执行中被阻塞（超时/拒绝）时保持暂停，最多重试 attempts 次；
 *  - 同一组件有在途步骤时，新的指令直接拒绝，并在主会话上下文里标注“忙”；
 *  - 活跃组件每轮把 lastAction 报给主会话，避免重复指令。
 *
 * @module stellaris-agent/swarm
 */
import { ensureNativeBridge } from './native-bridge.mjs'
import { runSteps } from './native-operator.mjs'
import { NATIVE_VERBS } from './native-verbs.mjs'
import { DSHOrchestrator } from './dsh-orchestrator.mjs'

function extractNativeSteps(text) {
  const source = String(text || '')
  const fence = /```stellaris-native\s*\n([\s\S]*?)```/.exec(source) || /```json\s*\n([\s\S]*?)```/.exec(source)
  if (!fence) return null
  try {
    const parsed = JSON.parse(fence[1])
    return Array.isArray(parsed) ? parsed : Array.isArray(parsed.steps) ? parsed.steps : null
  } catch {
    return null
  }
}


const NATIVE_ALIASES = {
  send_fleet: 'move_fleet',
  fleet_stance: 'set_fleet_stance',
  add_building: 'build_building',
  add_district: 'build_district',
  add_perk: 'adopt_ascension_perk',
  event: 'resolve_event',
  open_ui: 'show_panel',
  fleet_repair: 'reinforce_fleet',
  fleet_delete: 'delete_fleet',
  add_tradition: 'adopt_tradition',
}

const COMPONENT_METHODS = {
  planet: ['build_building', 'build_district', 'set_district_zone', 'set_job_priority'],
  fleet: ['move_fleet', 'survey', 'set_fleet_stance', 'follow_fleet', 'reinforce_fleet', 'merge_fleets', 'build_outpost', 'build_stations', 'colonize', 'upgrade_fleet', 'build_ship'],
}

export function normalizeSteps(component, steps) {
  if (!Array.isArray(steps)) return []
  const allowed = COMPONENT_METHODS[component.type]
  return steps.map((step) => {
    const method = NATIVE_ALIASES[step.method] || step.method
    if (!NATIVE_VERBS[method]) return null
    if (allowed && !allowed.includes(method)) return null
    const params = { ...(step.params || {}) }
    if (component.type === 'planet' && !params.planet_id) params.planet_id = component.key
    if (component.type === 'fleet' && !params.fleet_id) params.fleet_id = component.key
    return { ...step, method, params }
  }).filter(Boolean)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class Swarm {
  constructor({ engine, orchestrator, config, log = () => {} }) {
    this.engine = engine
    this.orchestrator = orchestrator
    this.config = config
    this.log = log
    this.settings = {
      tickSeconds: 60,
      mainTickSeconds: 180,
      queuePauseThreshold: 10,
      watchSeconds: 15,
      megastructureScanSeconds: 300,
      attempts: 5,
      backend: 'local',
      dshUrl: 'http://127.0.0.1:49939',
      autoUnpause: false,
      ...(config.swarm || {}),
    }
    this.runner = this.settings.backend === 'dsh'
      ? new DSHOrchestrator({ baseUrl: this.settings.dshUrl })
      : orchestrator
    this.components = new Map()
    this.queue = []
    this.running = false
    this.draining = false
    this.pausedByUs = false
    this.stopped = false
    this.activity = new Map()
    this.timers = []
    this.drainTimer = null
    this.watchTimer = null
    this.megastructureTimer = null
    this.megastructureCache = {}
    this.world = null
    this.completions = []
  }

  async start({ once = false } = {}) {
    const bridge = await ensureNativeBridge({ log: this.log })
    if (!bridge.ok) return { ok: false, error: bridge.error || 'BRIDGE_UNAVAILABLE' }
    this.pipe = bridge.pipe
    this.stopped = false
    await this.discover()

    await this.scanMegastructures()
    await this.watch()

    if (once) {
      await this.mainTick()
      for (const component of this.components.values()) await this.componentTick(component)
      await this.drain()
      return { ok: true, once: true, queue: this.queue.length, components: [...this.components.keys()] }
    }

    this.megastructureTimer = setInterval(() => this.scanMegastructures().catch((error) => this.log('swarm.megastructures', { error: String(error) })), this.settings.megastructureScanSeconds * 1000)
    this.watchTimer = setInterval(() => this.watch().catch((error) => this.log('swarm.watch', { error: String(error) })), this.settings.watchSeconds * 1000)
    this.timers.push(setInterval(() => this.mainTick().catch((error) => this.log('swarm.main', { error: String(error) })), this.settings.mainTickSeconds * 1000))
    this.timers.push(setInterval(() => this.componentTicks().catch((error) => this.log('swarm.components', { error: String(error) })), this.settings.tickSeconds * 1000))
    await this.mainTick()
    await this.componentTicks()
    return { ok: true, components: [...this.components.keys()], settings: this.settings }
  }

  stop() {
    this.stopped = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    if (this.drainTimer) clearTimeout(this.drainTimer)
    if (this.watchTimer) clearInterval(this.watchTimer)
    if (this.megastructureTimer) clearInterval(this.megastructureTimer)
    this.pipe?.close()
  }

  async discover() {
    if (this.components.size) return
    const status = await this.pipe.request('get_status')
    for (const sector of status.outliner?.sectors_summary?.sectors || []) {
      for (const colony of sector.colonies_summary || []) {
        const id = `planet:${colony.planet_id}`
        this.components.set(id, {
          id,
          type: 'planet',
          key: colony.planet_id,
          name: colony.name,
          intervalSeconds: this.settings.tickSeconds,
          lastAction: null,
          busy: false,
        })
      }
    }
    for (const fleet of (await this.pipe.request('get_military_fleets')).fleets || []) {
      const id = `fleet:${fleet.fleet_id}`
      this.components.set(id, {
        id,
        type: 'fleet',
        key: fleet.fleet_id,
        name: fleet.name,
        intervalSeconds: this.settings.tickSeconds,
        lastAction: null,
        busy: false,
      })
    }
    // 配置里可以覆盖/追加组件
    for (const row of this.config.swarm?.components || []) {
      if (!row?.id) continue
      this.components.set(row.id, {
        intervalSeconds: this.settings.tickSeconds,
        lastAction: null,
        busy: false,
        ...row,
      })
    }
    this.log('swarm.discover', { components: [...this.components.keys()] })
  }

  async globalSummary() {
    const [status, military, civilians, contacts] = await Promise.all([
      this.pipe.request('get_status'),
      this.pipe.request('get_military_fleets').catch(() => ({ fleets: [] })),
      this.pipe.request('get_civilian_fleets').catch(() => ({})),
      this.pipe.request('get_contacts', { mode: 'all' }).catch(() => ({ empires: [] })),
    ])
    return {
      date: status.date?.formatted,
      paused: status.is_paused,
      resources: Object.fromEntries(
        ['energy', 'minerals', 'alloys', 'unity', 'influence'].map((key) => [key, status.resources?.[key]?.stockpile ?? null]),
      ),
      colonies: (status.outliner?.sectors_summary?.sectors || []).flatMap((s) => s.colonies_summary || []).map((c) => ({ id: c.planet_id, name: c.name, pops: c.pops })),
      fleets: (military.fleets || []).map((f) => ({ id: f.fleet_id, name: f.name, status: f.status })),
      civilians: {
        colony: civilians.colony_ships?.length || 0,
        science: civilians.science_ships?.length || 0,
        construction: civilians.construction_ships?.length || 0,
      },
      contacts: (contacts.empires || []).map((e) => ({ id: e.country_id, name: e.name })),
      queue: this.queue.map((row) => ({ component: row.componentId, steps: row.steps.length })),
      active: [...this.activity.entries()].map(([id, row]) => ({ id, ...row })),
      components: [...this.components.keys()],
    }
  }

  async runAgent(params) {
    const backend = this.settings.backend || 'local'
    if (backend === 'dsh') {
      if (!this.dshChecked) {
        await this.runner.health()
        this.dshChecked = true
      }
      return this.runner.run({ goal: params.goal, label: params.label })
    }
    return this.orchestrator.run(params)
  }

  async dshTick() {
    if (this.stopped) return
    const global = await this.globalSummary()
    const components = [...this.components.values()].map((c) => ({ id: c.id, type: c.type, name: c.name, intervalSeconds: c.intervalSeconds, lastAction: c.lastAction }))
    const prompt = [
      '你在 DSH 内部担任群星总指挥。',
      '请用 DSH 自己的子代理/委派机制组织工作；需要拆成组件（星球/舰队）时，由你在 DSH 内拉起子会话。',
      '最终只输出一个 ' + String.fromCharCode(96,96,96) + 'stellaris-native JSON 数组，元素形如 {"method":"...","params":{...},"verify":{...}}。',
      this.config.swarm?.objective ? '战略目标：' + this.config.swarm.objective : '',
      '全局：' + JSON.stringify(global),
      '组件：' + JSON.stringify(components),
      '上次主会话之后的完成事件：' + JSON.stringify(this.completions.filter((e) => e.at > (this.lastMain?.at || 0)).slice(-20)),
    ].filter(Boolean).join('\n')
    const result = await this.runner.runTeam({ goal: prompt, label: '群星-DSH团队' })
    this.lastMain = { at: Date.now(), text: result.text || '', usage: result.usage || null, backend: 'dsh' }
    const steps = normalizeSteps({ type: 'team', key: null }, extractNativeSteps(result.text))
    if (steps.length) this.enqueue({ id: 'dsh-team', type: 'team', key: null, name: 'DSH 团队' }, steps)
    this.log('swarm.dsh.tick', { queue: this.queue.length, steps: steps.length })
  }

  async mainTick() {
    if (this.stopped) return
    const global = await this.globalSummary()
    const goal = [
      '你是群星总指挥的主会话。看全局，不要亲自操作。',
      (this.config.swarm?.objective ? `战略目标：${this.config.swarm.objective}` : ''),
      '输出一个 ```json 代码块，字段可选：pause、unpause、reset(组件id数组)、intervals(组件id→秒)、disabled(组件id数组，暂停该组件)、enabled(组件id数组，恢复)。',
      '正在忙的组件会出现在 busy 列表里；不要给它们重复指令。',
      JSON.stringify({ ...global, completions: this.completions.filter((e) => e.at > (this.lastMain?.at || 0)).slice(-20), pendingWork: await this.pendingWork() }),
    ].join('\n')
    const result = await this.runAgent({
      goal,
      label: 'swarm-main',
      role: 'operator',
      allowWrite: false,
      useTools: false,
      maxSteps: 1,
    })
    this.lastMain = { at: Date.now(), text: result.text || '', usage: result.usage || null }
    const directive = this.parseDirective(result.text)
    if (!this.settings.planOnly) {
      if (directive.pause && !this.pausedByUs) await this.pauseGame()
      if (directive.unpause) await this.unpauseGame()
    }
    for (const id of directive.reset || []) this.activity.delete(id)
    for (const id of directive.disabled || []) { const c = this.components.get(id); if (c) c.disabled = true }
    for (const id of directive.enabled || []) { const c = this.components.get(id); if (c) c.disabled = false }
    for (const [id, seconds] of Object.entries(directive.intervals || {})) {
      const component = this.components.get(id)
      if (component) component.intervalSeconds = Number(seconds) || component.intervalSeconds
    }
    this.log('swarm.main.tick', { queue: this.queue.length, active: this.activity.size })
  }

  parseDirective(text) {
    const match = /```json\s*\n([\s\S]*?)```/.exec(String(text || ''))
    if (!match) return {}
    try {
      return JSON.parse(match[1])
    } catch {
      return {}
    }
  }

  async componentTicks() {
    if (this.stopped) return
    const now = Date.now()
    for (const component of this.components.values()) {
      if (component.busy || component.disabled) continue
      if (this.queue.some((row) => row.componentId === component.id)) continue
      if (now - (component.lastTickAt || 0) < component.intervalSeconds * 1000) continue
      await this.componentTick(component)
    }
  }

  async componentTick(component) {
    if (this.stopped || component.busy) return
    component.busy = true
    component.lastTickAt = Date.now()
    try {
      const context = await this.componentContext(component)
      const global = await this.globalSummary()
      const goal = [
        `你是组件「${component.name}」（${component.id}）的子会话，只负责这一个组件。`,
        (this.config.swarm?.objective ? `战略目标：${this.config.swarm.objective}` : ''),
        '最多给 3 个步骤；只输出一个 ```stellaris-native JSON 数组。',
        `只能用这些原生动词：${Object.entries(NATIVE_VERBS).map(([m, v]) => `${m}(${v.params.join(',')})`).join('；')}`,
        '每步形如 {"method":"...","params":{...},"verify":{...}}。',
        '如果当前没有必要的操作，输出 []。',
        `全局：${JSON.stringify(global)}`,
        `本组件：${JSON.stringify(context)}`,
        '只能用候选列表里真实存在的 key/zone_id/district_type；不要猜。',
        `本组件上次操作：${JSON.stringify(component.lastAction)}`,
        `已完成事件：${JSON.stringify(this.completions.filter((e) => e.componentId === component.id || e.componentId === 'empire').slice(-10))}`,
      ].join('\n')
      const result = await this.runAgent({
        goal,
        label: `swarm-${component.id}`,
        role: 'operator',
        allowWrite: false,
        useTools: false,
        maxSteps: 2,
      })
      const rawSteps = extractNativeSteps(result.text)
      const steps = normalizeSteps(component, rawSteps)
      if (!steps || steps.length === 0) {
        this.activity.set(component.id, { status: 'idle', at: Date.now(), text: (result.text || '').slice(0, 200) })
        return
      }
      const valid = await this.validateSteps(component, steps)
      if (!valid.length) {
        this.activity.set(component.id, { status: 'invalid-plan', at: Date.now(), text: (result.text || '').slice(0, 300) })
        return
      }
      this.enqueue(component, valid)
    } finally {
      component.busy = false
    }
  }

  async componentContext(component) {
    if (component.type === 'fleet') {
      const detail = await this.pipe.request('get_fleets', { fleet_id: component.key })
      const military = await this.pipe.request('get_military_fleets').catch(() => ({ fleets: [] }))
      const summary = (military.fleets || []).find((row) => row.fleet_id === component.key) || null
      return { detail, summary }
    }
    return {
      details: await this.pipe.request('get_planet_details', { planet_id: component.key }),
      jobs: await this.pipe.request('get_planet_jobs', { planet_id: component.key }).catch(() => null),
      buildings: await this.pipe.request('get_buildable_buildings', { planet_id: component.key }).catch(() => null),
      districts: await this.pipe.request('get_buildable_districts', { planet_id: component.key }).catch(() => null),
      candidateRule: 'build_building 只能用 buildings.zones[].zone_id 作为 slot_index、对应 district 作为 district_type、buildable[].key 作为 building_key；build_district 只能用 districts.buildable[].key。',
    }
  }

  async validateSteps(component, steps) {
    if (component.type !== 'planet') return steps
    const buildings = await this.pipe.request('get_buildable_buildings', { planet_id: component.key }).catch(() => null)
    const districts = await this.pipe.request('get_buildable_districts', { planet_id: component.key }).catch(() => null)
    return steps.filter((step) => {
      if (step.method === 'build_building') {
        const p = step.params || {}
        const zone = buildings?.zones?.find((z) => z.zone_id === p.slot_index && z.district === p.district_type)
        const ok = Boolean(zone?.buildable?.some((x) => x.key === p.building_key))
        if (!ok) this.log('swarm.invalid-step', { component: component.id, step: 'build_building', params: p })
        return ok
      }
      if (step.method === 'build_district') {
        const key = step.params?.district_key
        const ok = Boolean(districts?.buildable?.some((x) => x.key === key))
        if (!ok) this.log('swarm.invalid-step', { component: component.id, step: 'build_district', params: step.params })
        return ok
      }
      return true
    })
  }

  enqueue(component, steps) {
    if (this.settings.planOnly) {
      this.activity.set(component.id, { status: 'planned', at: Date.now(), steps: steps.length })
      this.log('swarm.plan', { component: component.id, steps })
      return true
    }
    if (this.queue.some((row) => row.componentId === component.id)) {
      this.log('swarm.enqueue.duplicate', { component: component.id })
      return false
    }
    this.queue.push({ componentId: component.id, component, steps, enqueuedAt: Date.now() })
    this.activity.set(component.id, { status: 'queued', at: Date.now(), steps: steps.length })
    this.log('swarm.enqueue', { component: component.id, steps: steps.length, queue: this.queue.length })
    this.scheduleDrain()
    return true
  }

  async pauseGame() {
    try {
      await this.pipe.request('set_paused', { paused: true })
      this.pausedByUs = true
      this.log('swarm.pause', { queue: this.queue.length })
    } catch (error) {
      this.log('swarm.pause.failed', { error: String(error) })
    }
  }

  async unpauseGame() {
    try {
      await this.pipe.request('set_paused', { paused: false })
      this.pausedByUs = false
    } catch (error) {
      this.log('swarm.unpause.failed', { error: String(error) })
    }
  }

  scheduleDrain(delayMs = 800) {
    if (this.settings.planOnly || this.stopped) return
    if (this.drainTimer) clearTimeout(this.drainTimer)
    this.drainTimer = setTimeout(() => {
      this.drainTimer = null
      this.drain().catch((error) => this.log('swarm.drain', { error: String(error) }))
    }, delayMs)
    this.drainTimer.unref?.()
  }

  async drain() {
    if (this.draining) return
    if (!this.queue.length) return
    this.draining = true
    // 队列达到阈值时暂停批处理；低于阈值时按顺序执行，不强行暂停
    if (this.queue.length >= this.settings.queuePauseThreshold && !this.pausedByUs) await this.pauseGame()
    try {
      while (this.queue.length && !this.stopped) {
        const row = this.queue.shift()
        this.activity.set(row.componentId, { status: 'executing', at: Date.now(), steps: row.steps.length })
        const result = await runSteps(this.pipe, row.steps, {
          attempts: this.settings.attempts,
          log: this.log,
          pause: true,
        })
        row.component.lastAction = {
          at: Date.now(),
          ok: result.ok,
          steps: row.steps.map((s) => s.method),
          error: result.error || null,
          attempts: (result.results || []).map((row) => ({ index: row.index, status: row.status, lastError: (row.attempts || []).at(-1)?.error || (row.attempts || []).at(-1)?.verified?.detail || null })),
        }
        this.activity.set(row.componentId, {
          status: result.ok ? 'done' : 'blocked',
          at: Date.now(),
          steps: row.steps.length,
          error: result.error || null,
        })
        if (!result.ok) {
          await this.pauseGame()
          // 操作堵塞：保持暂停，交给主会话/用户处理；不自动重排，避免半截动作
          this.log('swarm.blocked', { component: row.componentId, error: result.error, failedIndex: result.failedIndex })
          break
        }
      }
      if (!this.queue.length && this.settings.autoUnpause && this.stopped === false) await this.unpauseGame()
    } finally {
      this.draining = false
    }
  }

  async scanMegastructures() {
    const status = await this.pipe.request('get_status')
    const colonies = (status.outliner?.sectors_summary?.sectors || []).flatMap((s) => s.colonies_summary || [])
    const capital = colonies[0]?.planet_id
    if (!capital) return
    const details = await this.pipe.request('get_planet_details', { planet_id: capital }).catch(() => null)
    const center = details?.system_id
    if (!center) return
    const map = await this.pipe.request('get_galaxy_map', { center_system_id: center, jumps: 60 }).catch(() => null)
    const rows = map?.rows || []
    const cache = {}
    for (const row of rows) {
      const [systemId, name, , , ownerId, , , flags] = row
      if (!String(flags || '').includes('M')) continue
      const system = await this.pipe.request('get_system', { system_id: systemId }).catch(() => null)
      for (const mega of system?.megastructures || []) {
        cache[mega.id] = { id: mega.id, system_id: systemId, system: name, type: mega.type, type_name: mega.type_name, owner_id: ownerId ?? mega.owner_id ?? null }
      }
    }
    this.megastructureCache = cache
    this.log('swarm.megastructures.scan', { systems: rows.length, megastructures: Object.keys(cache).length })
  }

  async pendingWork() {
    if (!this.world) return null
    return {
      research: this.world.research,
      construction: this.world.construction,
      ships: this.world.ships,
      fleets: this.world.fleets,
      armies: this.world.armies,
      megastructures: this.world.megastructures,
      starbaseLevel: this.world.starbaseLevel,
    }
  }

  async watch() {
    const next = await this.snapshotWorld()
    if (this.world) {
      const events = this.diffWorld(this.world, next)
      if (events.length) {
        this.completions.push(...events)
        this.completions = this.completions.slice(-100)
        for (const event of events) this.log('swarm.completion', event)
      }
    }
    this.world = next
  }

  async snapshotWorld() {
    const status = await this.pipe.request('get_status')
    const research = await this.pipe.request('get_research_state').catch(() => ({}))
    const military = await this.pipe.request('get_military_fleets').catch(() => ({ fleets: [] }))
    const civilians = await this.pipe.request('get_civilian_fleets').catch(() => ({}))
    const galaxy = await this.pipe.request('get_galaxy_overview').catch(() => null)
    const colonies = (status.outliner?.sectors_summary?.sectors || []).flatMap((s) => s.colonies_summary || [])
    const construction = {}
    const armies = {}
    const pops = {}
    const megastructures = {}
    const systemCache = new Map()
    const systemOf = async (systemId) => {
      if (!systemId) return null
      if (!systemCache.has(systemId)) systemCache.set(systemId, await this.pipe.request('get_system', { system_id: systemId }).catch(() => null))
      return systemCache.get(systemId)
    }
    for (const colony of colonies) {
      const details = await this.pipe.request('get_planet_details', { planet_id: colony.planet_id }).catch(() => null)
      construction[colony.planet_id] = (details?.construction_queue || []).map((item) => item.key || item.building || item.district || item.name || JSON.stringify(item))
      armies[colony.planet_id] = {
        recruitment: details?.armies_summary?.recruitment_queue_count ?? 0,
        stationed: details?.armies_summary?.total_stationed_armies ?? 0,
      }
      pops[colony.planet_id] = (details?.population_breakdown || []).reduce((sum, row) => sum + (Number(row.pop_count) || 0), 0)
      const system = await systemOf(details?.system_id)
      for (const mega of system?.megastructures || []) {
        megastructures[mega.id] = { id: mega.id, system_id: details.system_id, type: mega.type, type_name: mega.type_name, owner_id: mega.owner_id }
      }
    }
    const capital = colonies[0]?.planet_id
    let ships = []
    let starbaseLevel = null
    let notifications = []
    if (capital) {
      const details = await this.pipe.request('get_planet_details', { planet_id: capital }).catch(() => null)
      if (details?.system_id) {
        const yard = await this.pipe.request('get_buildable_ships', { system_id: details.system_id }).catch(() => null)
        ships = (yard?.queue || []).map((item) => item.key || item.design_id || item.name || JSON.stringify(item))
        const system = await systemOf(details.system_id)
        starbaseLevel = system?.starbase?.level || null
        for (const mega of system?.megastructures || []) {
          megastructures[mega.id] = { id: mega.id, system_id: details.system_id, type: mega.type, type_name: mega.type_name, owner_id: mega.owner_id }
        }
      }
    }
    notifications = (await this.pipe.request('get_notifications').catch(() => []))
      .slice(0, 30)
      .map((row) => row.title_key || row.title || row.param || row.type || row.message || '')
      .filter(Boolean)
    const fleets = {}
    for (const fleet of [...(military.fleets || []), ...(civilians.science_ships || []), ...(civilians.construction_ships || []), ...(civilians.colony_ships || [])]) {
      fleets[fleet.fleet_id] = fleet.status
    }
    return {
      date: status.date?.formatted,
      research: Object.fromEntries(Object.entries(research).map(([area, row]) => [area, { key: row.current?.key || null, name: row.current?.name || null }])),
      construction,
      armies,
      pops,
      ships,
      megastructures: { ...this.megastructureCache, ...megastructures },
      starbaseLevel,
      notifications,
      fleets,
      colonies: colonies.length,
      ownedSystems: galaxy?.player?.owned_systems ?? null,
    }
  }

  diffWorld(prev, next) {
    const events = []
    for (const [area, row] of Object.entries(next.research || {})) {
      const before = prev.research?.[area]
      if (before?.key && before.key !== row.key) {
        events.push({ type: 'research_completed', componentId: 'empire', at: Date.now(), detail: { area, key: before.key, name: before.name } })
      }
      if (!before?.key && row.key) {
        events.push({ type: 'research_started', componentId: 'empire', at: Date.now(), detail: { area, key: row.key, name: row.name } })
      }
    }
    for (const [planetId, list] of Object.entries(next.construction || {})) {
      const before = prev.construction?.[planetId] || []
      for (const item of before) if (!list.includes(item)) events.push({ type: 'construction_completed', componentId: `planet:${planetId}`, at: Date.now(), detail: { planet_id: Number(planetId), item } })
      for (const item of list) if (!before.includes(item)) events.push({ type: 'construction_started', componentId: `planet:${planetId}`, at: Date.now(), detail: { planet_id: Number(planetId), item } })
    }
    for (const item of prev.ships || []) if (!(next.ships || []).includes(item)) events.push({ type: 'ship_completed', componentId: 'empire', at: Date.now(), detail: { item } })
    for (const [planetId, row] of Object.entries(next.armies || {})) {
      const before = prev.armies?.[planetId]
      if (!before) continue
      if (before.recruitment > row.recruitment) events.push({ type: 'army_recruitment_completed', componentId: `planet:${planetId}`, at: Date.now(), detail: { planet_id: Number(planetId), before: before.recruitment, after: row.recruitment } })
      if (before.recruitment < row.recruitment) events.push({ type: 'army_recruitment_started', componentId: `planet:${planetId}`, at: Date.now(), detail: { planet_id: Number(planetId), before: before.recruitment, after: row.recruitment } })
      if (before.stationed !== row.stationed) events.push({ type: 'army_count_changed', componentId: `planet:${planetId}`, at: Date.now(), detail: { planet_id: Number(planetId), before: before.stationed, after: row.stationed } })
    }
    for (const [planetId, count] of Object.entries(next.pops || {})) {
      const before = prev.pops?.[planetId]
      if (before === undefined) continue
      if (count > before) events.push({ type: 'pop_grown', componentId: `planet:${planetId}`, at: Date.now(), detail: { planet_id: Number(planetId), before, after: count } })
      if (count < before) events.push({ type: 'pop_lost', componentId: `planet:${planetId}`, at: Date.now(), detail: { planet_id: Number(planetId), before, after: count } })
    }
    for (const [id, mega] of Object.entries(next.megastructures || {})) {
      const before = prev.megastructures?.[id]
      if (!before) {
        events.push({ type: 'megastructure_started', componentId: 'empire', at: Date.now(), detail: mega })
      } else if (before.type !== mega.type) {
        const done = /complete|finished|ruined/.test(String(mega.type)) && !/under_construction|site/.test(String(mega.type))
        events.push({ type: done ? 'megastructure_completed' : 'megastructure_upgraded', componentId: 'empire', at: Date.now(), detail: { before, after: mega } })
      }
    }
    for (const [id, mega] of Object.entries(prev.megastructures || {})) {
      if (!next.megastructures?.[id]) events.push({ type: 'megastructure_lost', componentId: 'empire', at: Date.now(), detail: mega })
    }
    if (prev.starbaseLevel && next.starbaseLevel && prev.starbaseLevel !== next.starbaseLevel) events.push({ type: 'starbase_upgraded', componentId: 'empire', at: Date.now(), detail: { before: prev.starbaseLevel, after: next.starbaseLevel } })
    const beforeNotifications = new Set(prev.notifications || [])
    for (const title of next.notifications || []) {
      if (beforeNotifications.has(title)) continue
      const mega = /megastructure|巨型/.test(String(title).toLowerCase())
      events.push({ type: mega ? 'megastructure_completed' : 'notification', componentId: 'empire', at: Date.now(), detail: { title } })
    }
    for (const [fleetId, status] of Object.entries(next.fleets || {})) {
      const before = prev.fleets?.[fleetId]
      if (before && before !== status && /无指令|待命/.test(status)) {
        events.push({ type: 'fleet_order_completed', componentId: `fleet:${fleetId}`, at: Date.now(), detail: { fleet_id: Number(fleetId), from: before, to: status } })
      }
    }
    if (prev.colonies !== null && next.colonies > prev.colonies) events.push({ type: 'colony_established', componentId: 'empire', at: Date.now(), detail: { from: prev.colonies, to: next.colonies } })
    if (prev.ownedSystems !== null && next.ownedSystems > prev.ownedSystems) events.push({ type: 'outpost_completed', componentId: 'empire', at: Date.now(), detail: { from: prev.ownedSystems, to: next.ownedSystems } })
    return events
  }

  status() {
    return {
      settings: this.settings,
      queue: this.queue.map((row) => ({ component: row.componentId, steps: row.steps.length })),
      draining: this.draining,
      pausedByUs: this.pausedByUs,
      components: [...this.components.values()].map((c) => ({
        id: c.id,
        type: c.type,
        name: c.name,
        busy: c.busy,
        intervalSeconds: c.intervalSeconds,
        lastTickAt: c.lastTickAt,
        lastAction: c.lastAction,
      })),
      activity: [...this.activity.entries()].map(([id, row]) => ({ id, ...row })),
      completions: this.completions.slice(-20),
      lastMain: this.lastMain || null,
    }
  }
}
