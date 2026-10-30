/**
 * 世界状态：周期刷新 + 差分。
 *
 * 输出两类东西：
 *  - `completions`：发生了什么的"事实"（研究完成/船造好/殖民地建立/巨构完工…），
 *    给主会话做复盘与下一步判断；
 *  - `triggers`：需要**立刻**处理的事情（新事件弹窗、新警报、选举/换届、外交请求、
 *    新战争），由编排器拉特殊事件子会话。
 *
 * 刷新策略：
 *  - 每 `refreshSeconds` 一次轻量读（全局域 + 事件/警报 + 舰队概览）；
 *  - 每 `deepEveryTicks` 次做一次全量读（每颗星球/舰队明细 + 银河图 + 巨构）；
 *  - 启动时由编排器显式做一次全量读。
 *
 * @module stellaris-agent/world
 */
import { EventEmitter } from 'node:events'
import { asArray, extractColonies, extractFleets } from './reader.mjs'
import { eventIdOf } from './events.mjs'

function pick(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '')
}

function idList(rows, keys = ['id', 'key', 'planet_id', 'fleet_id', 'leader_id', 'war_id', 'country_id', 'alert_id', 'index']) {
  const out = new Set()
  for (const row of asArray(rows)) {
    if (row === null || row === undefined) continue
    if (typeof row === 'number' || typeof row === 'string') {
      out.add(String(row))
      continue
    }
    for (const key of keys) {
      const value = row[key]
      if (value !== undefined && value !== null) {
        out.add(String(value))
        break
      }
    }
  }
  return out
}

function added(before, after) {
  return [...after].filter((value) => !before.has(value))
}

function fmt(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') return value
  return JSON.stringify(value).slice(0, 200)
}

/**
 * 两个世界快照的差分。
 * @returns {{events:Array<object>, triggers:Array<object>}}
 */
export function diffWorld(prev, next) {
  const events = []
  const triggers = []
  const at = Date.now()
  const add = (type, detail, componentId = 'empire') => events.push({ type, componentId, at, detail })
  if (!prev) return { events, triggers }

  // 研究
  for (const area of ['physics', 'society', 'engineering']) {
    const before = prev.research?.[area]?.current?.key ?? null
    const after = next.research?.[area]?.current?.key ?? null
    if (before && before !== after) add('research_completed', { area, key: before }, 'research')
    if (!before && after) add('research_started', { area, key: after }, 'research')
  }

  // 殖民地：新增/失去
  const beforeColonies = new Set((prev.colonies || []).map((colony) => String(colony.planet_id)))
  const afterColonies = new Set((next.colonies || []).map((colony) => String(colony.planet_id)))
  for (const id of added(beforeColonies, afterColonies)) add('colony_established', { planet_id: Number(id) }, `planet:${id}`)
  for (const id of added(afterColonies, beforeColonies)) add('colony_lost', { planet_id: Number(id) }, `planet:${id}`)

  // 建造队列 / 人口 / 陆军
  const beforeColonyMap = new Map((prev.colonies || []).map((colony) => [String(colony.planet_id), colony]))
  for (const colony of next.colonies || []) {
    const id = String(colony.planet_id)
    const before = beforeColonyMap.get(id)
    if (!before) continue
    const beforeQueue = (before.details?.construction_queue || []).map((item) => item.key || item.building || item.district || item.name || JSON.stringify(item))
    const afterQueue = (colony.details?.construction_queue || []).map((item) => item.key || item.building || item.district || item.name || JSON.stringify(item))
    for (const item of beforeQueue) if (!afterQueue.includes(item)) add('construction_completed', { planet_id: Number(id), item }, `planet:${id}`)
    for (const item of afterQueue) if (!beforeQueue.includes(item)) add('construction_started', { planet_id: Number(id), item }, `planet:${id}`)
    const beforePops = Number(before.details?.population ?? before.pops ?? NaN)
    const afterPops = Number(colony.details?.population ?? colony.pops ?? NaN)
    if (Number.isFinite(beforePops) && Number.isFinite(afterPops) && beforePops !== afterPops) {
      add(afterPops > beforePops ? 'pop_grown' : 'pop_lost', { planet_id: Number(id), before: beforePops, after: afterPops }, `planet:${id}`)
    }
    const beforeArmies = Number(before.armies?.total_stationed_armies ?? NaN)
    const afterArmies = Number(colony.armies?.total_stationed_armies ?? NaN)
    if (Number.isFinite(beforeArmies) && Number.isFinite(afterArmies) && beforeArmies !== afterArmies) {
      add('army_count_changed', { planet_id: Number(id), before: beforeArmies, after: afterArmies }, `planet:${id}`)
    }
  }

  // 舰队：新增/失去/状态变化
  const beforeFleets = new Map((prev.fleetsAll || []).map((fleet) => [String(fleet.fleet_id), fleet]))
  const afterFleets = new Map((next.fleetsAll || []).map((fleet) => [String(fleet.fleet_id), fleet]))
  for (const [id, fleet] of afterFleets) {
    if (!beforeFleets.has(id)) add('fleet_appeared', { fleet_id: Number(id), name: fleet.name || null, kind: fleet.kind }, `fleet:${id}`)
  }
  for (const [id, fleet] of beforeFleets) {
    if (!afterFleets.has(id)) add('fleet_destroyed', { fleet_id: Number(id), name: fleet.name || null }, `fleet:${id}`)
  }
  for (const [id, fleet] of afterFleets) {
    const before = beforeFleets.get(id)
    if (!before) continue
    const beforeStatus = String(before.status ?? '')
    const afterStatus = String(fleet.status ?? '')
    if (beforeStatus && afterStatus && beforeStatus !== afterStatus && /idle|无指令|待命/i.test(afterStatus)) {
      add('fleet_order_completed', { fleet_id: Number(id), from: beforeStatus, to: afterStatus }, `fleet:${id}`)
    }
  }

  // 政府 / 内阁 / 领袖
  const beforeRuler = pick(prev.government?.ruler_name, prev.government?.ruler, prev.status?.ruler_name)
  const afterRuler = pick(next.government?.ruler_name, next.government?.ruler, next.status?.ruler_name)
  if (beforeRuler && afterRuler && beforeRuler !== afterRuler) {
    add('ruler_changed', { from: beforeRuler, to: afterRuler }, 'council')
    triggers.push({ type: 'election_result', priority: 95, unit: 'council', payload: { from: beforeRuler, to: afterRuler }, at })
  }
  const beforeGov = pick(prev.government?.government_type, prev.government?.government, prev.status?.government_type)
  const afterGov = pick(next.government?.government_type, next.government?.government, next.status?.government_type)
  if (beforeGov && afterGov && beforeGov !== afterGov) add('government_changed', { from: beforeGov, to: afterGov }, 'council')

  const beforeLeaders = idList(prev.leaders?.hired || prev.leaders?.leaders)
  const afterLeaders = idList(next.leaders?.hired || next.leaders?.leaders)
  for (const id of added(beforeLeaders, afterLeaders)) add('leader_hired', { leader_id: Number(id) }, 'council')
  for (const id of added(afterLeaders, beforeLeaders)) add('leader_lost', { leader_id: Number(id) }, 'council')

  // 法令 / 传统 / 飞升
  const beforeEdicts = idList(prev.edicts?.active_edicts || prev.edicts?.edicts)
  const afterEdicts = idList(next.edicts?.active_edicts || next.edicts?.edicts)
  for (const id of added(beforeEdicts, afterEdicts)) add('edict_activated', { key: id }, 'laws')
  for (const id of added(afterEdicts, beforeEdicts)) add('edict_deactivated', { key: id }, 'laws')
  const beforeTraditions = idList(prev.traditions?.unlocked_traditions || prev.traditions?.traditions)
  const afterTraditions = idList(next.traditions?.unlocked_traditions || next.traditions?.traditions)
  for (const id of added(beforeTraditions, afterTraditions)) add('tradition_adopted', { key: id }, 'research')

  // 事件弹窗：新窗口 = 需要立刻处理
  const beforeEvents = new Set((prev.activeEvents || []).map((event) => String(pick(event.window_id, event.id, event.event_id, eventIdOf(event)) ?? JSON.stringify(event).slice(0, 60))))
  for (const event of next.activeEvents || []) {
    const key = String(pick(event.window_id, event.id, event.event_id, eventIdOf(event)) ?? JSON.stringify(event).slice(0, 60))
    if (beforeEvents.has(key)) continue
    triggers.push({ type: 'event_window', priority: 100, unit: 'event', payload: event, at })
    add('event_opened', { window_id: pick(event.window_id, event.id), title: pick(event.title, event.title_key) }, 'event')
  }

  // 警报：选举、议程、未分配领袖、稳定度…… 都从标题/类型里认
  const beforeAlerts = new Set((prev.alerts || []).map((alert) => String(pick(alert.alert_id, alert.id, alert.key) ?? '')))
  for (const alert of next.alerts || []) {
    const key = String(pick(alert.alert_id, alert.id, alert.key) ?? '')
    if (key && beforeAlerts.has(key)) continue
    const signature = `${alert.alert_id ?? ''} ${alert.key ?? ''} ${alert.title ?? ''} ${alert.title_key ?? ''} ${alert.type ?? ''}`.toLowerCase()
    const kind = /council|election|agenda/.test(signature)
      ? 'council'
      : /diplom|first_contact|espionage/.test(signature)
        ? 'diplomacy'
        : /situation|timed_project|astral/.test(signature)
          ? 'situation'
          : /research/.test(signature)
            ? 'research'
            : 'alert'
    triggers.push({ type: `alert:${kind}`, priority: kind === 'council' ? 90 : 70, unit: 'event', payload: alert, at })
    add('alert_new', { alert_id: pick(alert.alert_id, alert.id), title: pick(alert.title, alert.title_key) }, 'event')
  }

  // 外交请求 / 战争
  const warsOf = (value) => asArray(value?.wars ?? value)
  const situationsOf = (value) => asArray(value?.situations ?? value)
  const proposalsOf = (value) => asArray(value?.proposals ?? value?.pending ?? value)
  const beforeProposals = idList(proposalsOf(prev.pendingDiplomacy))
  for (const proposal of proposalsOf(next.pendingDiplomacy)) {
    const key = pick(proposal?.id, proposal?.proposal, proposal?.country_id, JSON.stringify(proposal).slice(0, 40))
    if (key !== undefined && beforeProposals.has(String(key))) continue
    triggers.push({ type: 'diplomacy_proposal', priority: 85, unit: 'diplomacy', payload: proposal, at })
    add('diplomacy_proposal', { proposal: fmt(proposal?.kind || proposal?.action || proposal?.proposal || key) }, 'diplomacy')
  }
  const beforeWars = new Set(warsOf(prev.wars).map((war) => String(pick(war.war_id, war.id) ?? '')))
  for (const war of warsOf(next.wars)) {
    const key = String(pick(war.war_id, war.id) ?? '')
    if (key && beforeWars.has(key)) continue
    triggers.push({ type: 'war_started', priority: 80, unit: 'diplomacy', payload: war, at })
    add('war_started', { war_id: pick(war.war_id, war.id), name: war.name }, 'diplomacy')
  }

  // 局势 / 通知 / 巨构 / 星球数量
  const beforeSituations = idList(situationsOf(prev.situations))
  for (const situation of situationsOf(next.situations)) {
    const key = pick(situation?.situation_id, situation?.id)
    if (key === undefined || beforeSituations.has(String(key))) continue
    triggers.push({ type: 'situation_started', priority: 60, unit: 'event', payload: situation, at })
  }

  const beforeNotifications = new Set((prev.notifications || []).map((row) => JSON.stringify(row).slice(0, 120)))
  for (const row of next.notifications || []) {
    const key = JSON.stringify(row).slice(0, 120)
    if (beforeNotifications.has(key)) continue
    add('notification', { title: pick(row.title, row.title_key, row.message, row.param) }, 'event')
  }

  const beforeMega = new Set(Object.keys(prev.megaScan?.megastructures ? indexBy(prev.megaScan.megastructures) : {}))
  const afterMega = indexBy(next.megaScan?.megastructures || [])
  for (const [id, mega] of Object.entries(afterMega)) {
    if (beforeMega.has(id)) continue
    add('megastructure_found', { id, type: mega.type, system: mega.system_name || null }, 'empire')
  }

  return { events, triggers }
}

function indexBy(rows) {
  const out = {}
  for (const row of rows || []) {
    const id = row.id ?? row.megastructure_id ?? JSON.stringify(row).slice(0, 40)
    out[String(id)] = row
  }
  return out
}

export class World extends EventEmitter {
  /**
   * @param {object} options
   * @param {import('./reader.mjs').Reader} options.reader
   * @param {object} options.config
   * @param {string} options.home
   * @param {Function} [options.log]
   * @param {import('./events.mjs').EventGraph} [options.eventGraph]
   */
  constructor({ reader, config, home, log = () => {}, eventGraph = null }) {
    super()
    this.reader = reader
    this.config = config
    this.home = home
    this.log = log
    this.eventGraph = eventGraph
    this.current = null
    this.completions = []
    this.triggers = []
    this.tick = 0
    this.timer = null
    this.refreshing = false
    this.stopped = true
    this.lastError = null
    this.settings = {
      refreshSeconds: Number(config?.read?.refreshSeconds ?? 20),
      deepEveryTicks: Number(config?.read?.deepEveryTicks ?? 6),
    }
  }

  get running() {
    return !this.stopped
  }

  async refresh({ deep = null, includeSave = false } = {}) {
    if (this.refreshing) return this.current
    this.refreshing = true
    try {
      const shouldDeep = deep === null ? this.tick % Math.max(1, this.settings.deepEveryTicks) === 0 : Boolean(deep)
      const next = await this.reader.readWorld({
        deep: shouldDeep,
        includeSave,
        eventGraph: this.eventGraph,
      })
      const previous = this.current
      this.current = next
      this.tick += 1
      this.lastError = null
      this.emit('world', next)
      if (previous) {
        const delta = diffWorld(previous, next)
        if (delta.events.length) {
          this.completions.push(...delta.events)
          if (this.completions.length > 300) this.completions = this.completions.slice(-300)
          for (const event of delta.events) this.emit('completion', event)
        }
        if (delta.triggers.length) {
          this.triggers.push(...delta.triggers)
          if (this.triggers.length > 200) this.triggers = this.triggers.slice(-200)
          for (const trigger of delta.triggers) this.emit('trigger', trigger)
        }
        this.emit('delta', delta)
      }
      this.log('world.refresh', {
        deep: shouldDeep,
        ms: next.readMs,
        colonies: next.colonies.length,
        fleets: next.fleetsAll.length,
        events: next.activeEvents.length,
        triggers: this.triggers.length,
      })
      return next
    } catch (error) {
      this.lastError = String(error?.message || error)
      this.log('world.refresh.failed', { error: this.lastError })
      throw error
    } finally {
      this.refreshing = false
    }
  }

  start() {
    if (!this.stopped) return
    this.stopped = false
    const interval = Math.max(5, this.settings.refreshSeconds) * 1000
    this.timer = setInterval(() => {
      this.refresh().catch((error) => this.log('world.timer', { error: String(error?.message || error) }))
    }, interval)
    this.timer.unref?.()
    this.log('world.start', { intervalMs: interval })
  }

  stop() {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 取走待处理触发器（编排器消费后清空）。 */
  takeTriggers() {
    const rows = this.triggers
    this.triggers = []
    return rows
  }

  recentCompletions(limit = 20) {
    return this.completions.slice(-limit)
  }

  status() {
    return {
      running: this.running,
      refreshing: this.refreshing,
      readAt: this.current?.readAt || null,
      date: this.current?.date || null,
      inGame: Boolean(this.current?.inGame),
      colonies: this.current?.colonies?.length ?? 0,
      fleets: this.current?.fleetsAll?.length ?? 0,
      activeEvents: this.current?.activeEvents?.length ?? 0,
      triggers: this.triggers.length,
      completions: this.completions.length,
      lastError: this.lastError,
      tick: this.tick,
    }
  }
}
