/**
 * 快照仓库：把一条条 DSH1 记录拼成「当前战局」。
 *
 * 职责：
 *   1. 记录聚合（同一 snap 内 BEGIN…END 覆盖旧快照；partial 也收，但标记）
 *   2. 星球序号（ord）分配：**按记录出现顺序**，因为模组 A 就是按
 *      every_owned_planet 的迭代序写出来的；桥按同一顺序编号，操作层才对得上。
 *   3. ACK 追踪：每条命令的 recv/done 两个阶段
 *   4. 给模型看的摘要（budget 控制长度）
 *
 * 不负责：读日志（logtail）、读存档（save/*）、编译动作（compiler）。
 *
 * @module dsh-stellaris-bridge/state
 */
import { EventEmitter } from 'node:events'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { toNumber } from './protocol.js'

function emptySnapshot() {
  return {
    id: null,
    partial: false,
    date: null,
    startedAt: 0,
    endedAt: 0,
    count: 0,
    empire: null,
    meta: null,
    resources: {},
    planets: [],
    leaders: [],
    fleets: [],
    techs: [],
    traditions: [],
    perks: [],
    relics: [],
    edicts: [],
    laws: [],
    modifiers: [],
    diplo: [],
    wars: [],
    situations: [],
    events: [],
    chains: [],
    flags: [],
    variables: [],
    notes: [],
  }
}

export class SnapshotStore extends EventEmitter {
  constructor(options = {}) {
    super()
    this.file = options.file ?? null
    this.current = emptySnapshot()
    this.ackByCmd = new Map()
    this.logLocalisation = null // null = 未探测；true/false = 探测结果
    this.probeSeen = false
    this.dirtyFields = new Set()
    this.saveIndex = null
    this._saveTimer = null
  }

  get ageMs() {
    const stamp = this.current.endedAt || this.current.startedAt
    return stamp ? Date.now() - stamp : Infinity
  }

  get ageSec() {
    const ms = this.ageMs
    return Number.isFinite(ms) ? Math.round(ms / 1000) : null
  }

  reset() {
    this.current = emptySnapshot()
  }

  /** 收到一条记录。返回 true 表示影响到了快照内容。 */
  apply(record) {
    if (!record) return false
    const fields = record.fields || {}
    switch (record.kind) {
      case 'BEGIN':
        this.current = emptySnapshot()
        this.current.id = fields.snap || null
        this.current.date = fields.date || null
        this.current.startedAt = Date.now()
        this.probeSeen = false
        this.emit('begin', this.current)
        return true
      case 'END':
        this.current.partial = false
        this.current.endedAt = Date.now()
        this.current.count = this.current.count
        this.emit('end', this.current)
        this._schedulePersist()
        return true
      case 'META':
        this.current.meta = { ...fields }
        return true
      case 'EMPIRE':
        this.current.empire = {
          name: fields.name ?? null,
          authority: fields.authority ?? null,
          government: fields.government ?? null,
          civics: fields.civics ? String(fields.civics).split(',') : [],
          ruler: fields.ruler ?? null,
          capital: fields.capital ?? null,
          empireId: fields.empire_id ?? null,
        }
        return true
      case 'RESOURCE': {
        const key = String(fields.key || '').trim()
        if (!key) return false
        this.current.resources[key] = {
          key,
          stock: toNumber(fields.stock),
          income: toNumber(fields.income),
        }
        return true
      }
      case 'PLANET': {
        const planet = {
          ord: this.current.planets.length,
          name: fields.name ?? null,
          cls: fields.class ?? null,
          size: toNumber(fields.size, null),
          designation: fields.designation ?? null,
          pops: toNumber(fields.pops, null),
          stability: fields.stability !== undefined ? toNumber(fields.stability, null) : null,
          crime: fields.crime !== undefined ? toNumber(fields.crime, null) : null,
          housing: fields.housing !== undefined ? toNumber(fields.housing, null) : null,
          amenities: fields.amenities !== undefined ? toNumber(fields.amenities, null) : null,
          sector: fields.sector ?? null,
          governor: fields.governor ?? null,
          megastructure: fields.megastructure ?? null,
          source: fields.source ?? 'log',
        }
        this.current.planets.push(planet)
        return true
      }
      case 'LEADER':
        this.current.leaders.push({ ...fields })
        return true
      case 'FLEET':
        this.current.fleets.push({ ...fields })
        return true
      case 'TECH':
        this.current.techs.push({ ...fields })
        return true
      case 'TRADITION':
        this.current.traditions.push({ ...fields })
        return true
      case 'PERK':
        this.current.perks.push({ ...fields })
        return true
      case 'RELIC':
        this.current.relics.push({ ...fields })
        return true
      case 'EDICT':
        this.current.edicts.push({ ...fields })
        return true
      case 'LAW':
        this.current.laws.push({ ...fields })
        return true
      case 'MODIFIER':
        this.current.modifiers.push({ ...fields })
        return true
      case 'DIPLO':
        this.current.diplo.push({ ...fields })
        return true
      case 'WAR':
        this.current.wars.push({ ...fields })
        return true
      case 'SITUATION':
        this.current.situations.push({ ...fields })
        return true
      case 'EVENT':
        this.current.events.push({ ...fields })
        return true
      case 'CHAIN':
        this.current.chains.push({ ...fields })
        return true
      case 'FLAG':
        this.current.flags.push({ ...fields })
        return true
      case 'VARIABLE':
        this.current.variables.push({ ...fields })
        return true
      case 'NOTE': {
        this.current.notes.push({ ...fields })
        if (String(fields.probe || '') === 'loc') {
          // 模组 A 的自检行：如果 name 还是占位符，说明日志不求值本地化
          this.probeSeen = true
          this.logLocalisation = record.dirty.length === 0
        }
        return true
      }
      case 'ACK': {
        const cmd = String(fields.cmd || '')
        const phase = String(fields.phase || '').toLowerCase()
        if (!cmd) return false
        const entry = this.ackByCmd.get(cmd) || { recv: false, done: false, recvAt: 0, doneAt: 0 }
        if (phase === 'recv' && !entry.recv) {
          entry.recv = true
          entry.recvAt = Date.now()
        }
        if (phase === 'done' && !entry.done) {
          entry.done = true
          entry.doneAt = Date.now()
        }
        this.ackByCmd.set(cmd, entry)
        this.emit('ack', { cmd, phase })
        return true
      }
      case 'ERROR':
        this.current.notes.push({ error: '1', ...fields })
        return true
      default:
        // 未知 KIND 已经在 protocol 里过滤掉；这里只可能是未来字段
        this.dirtyFields.add(record.kind)
        return false
    }
  }

  ack(cmd) {
    return this.ackByCmd.get(cmd) || { recv: false, done: false, recvAt: 0, doneAt: 0 }
  }

  /**
   * 等某条命令的 done 回执。
   * @param {string} cmd
   * @param {number} timeoutMs
   * @returns {Promise<{recv:boolean, done:boolean, timedOut:boolean}>}
   */
  waitForAck(cmd, timeoutMs) {
    const existing = this.ack(cmd)
    if (existing.done) return Promise.resolve({ recv: true, done: true, timedOut: false })
    return new Promise((resolve) => {
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.off('ack', onAck)
        resolve(result)
      }
      const onAck = ({ cmd: acked }) => {
        if (acked !== cmd) return
        const state = this.ack(cmd)
        if (state.done) finish({ recv: state.recv, done: true, timedOut: false })
      }
      const timer = setTimeout(() => {
        const state = this.ack(cmd)
        finish({ recv: state.recv, done: state.done, timedOut: true })
      }, timeoutMs)
      timer.unref?.()
      this.on('ack', onAck)
    })
  }

  waitForAckRecvOrDone(cmd, timeoutMs) {
    const existing = this.ack(cmd)
    if (existing.recv || existing.done) {
      return Promise.resolve({ recv: existing.recv, done: existing.done, timedOut: false })
    }
    return new Promise((resolve) => {
      let settled = false
      const finish = (result) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.off('ack', onAck)
        resolve(result)
      }
      const onAck = ({ cmd: acked }) => {
        if (acked !== cmd) return
        const state = this.ack(cmd)
        if (state.recv || state.done) finish({ recv: state.recv, done: state.done, timedOut: false })
      }
      const timer = setTimeout(() => {
        const state = this.ack(cmd)
        finish({ recv: state.recv, done: state.done, timedOut: true })
      }, timeoutMs)
      timer.unref?.()
      this.on('ack', onAck)
    })
  }

  /**
   * 用星球名/序号挑一颗。
   * @param {string|number} query
   * @returns {{planet: object, index: number}|null}
   */
  findPlanet(query) {
    const list = this.current.planets
    if (typeof query === 'number' || /^\d+$/.test(String(query ?? '').trim())) {
      const index = Number(query)
      if (Number.isFinite(index) && index >= 0 && index < list.length) {
        return { planet: list[index], index }
      }
      return null
    }
    const text = String(query ?? '').trim()
    if (!text) return null
    const lower = text.toLowerCase()
    const exact = list.findIndex((p) => String(p.name || '').toLowerCase() === lower)
    if (exact >= 0) return { planet: list[exact], index: exact }
    const partial = list.findIndex((p) => String(p.name || '').toLowerCase().includes(lower))
    if (partial >= 0) return { planet: list[partial], index: partial }
    const compact = lower.replace(/\s+/g, '')
    const fuzzy = list.findIndex((p) => String(p.name || '').toLowerCase().replace(/\s+/g, '').includes(compact))
    if (fuzzy >= 0) return { planet: list[fuzzy], index: fuzzy }
    return null
  }

  /** 给模型看的摘要。budget ≈ 字符数上限。 */
  brief(budget = 6000) {
    const s = this.current
    const lines = []
    const push = (line) => lines.push(line)
    push(`## 战局（快照 ${s.id ?? '?'}，${s.date ?? '日期未知'}，${this.ageSec === null ? '未知年龄' : `${this.ageSec}s 前`}${s.partial ? '，partial' : ''}）`)
    if (s.empire) {
      const e = s.empire
      push(`帝国：${e.name ?? '?'}${e.ruler ? `／统治者 ${e.ruler}` : ''}${e.capital ? `／首都 ${e.capital}` : ''}`)
    }
    if (!this.probeSeen) push('提示：还没收到阅读模组的自检行（probe=loc），数据可能来自存档通道。')
    else if (this.logLocalisation === false) {
      push('提示：日志里的数值没有被本地化求值，数值类字段可能缺失；深层数据请用 save 通道。')
    }
    const res = Object.values(s.resources)
    if (res.length) {
      push('资源：' + res.map((r) => `${r.key} ${r.stock}(+${r.income})`).join('，'))
    }
    if (s.planets.length) {
      push(`殖民地 ${s.planets.length} 颗：`)
      for (const p of s.planets.slice(0, 25)) {
        push(`  [${p.ord}] ${p.name ?? '?'}｜pops ${p.pops ?? '?'}｜size ${p.size ?? '?'}${p.designation ? `｜${p.designation}` : ''}`)
      }
      if (s.planets.length > 25) push(`  …另有 ${s.planets.length - 25} 颗（用 stellaris_query 按 ord 取）`)
    }
    if (s.leaders.length) push(`领袖 ${s.leaders.length} 位（明细见存档通道）`)
    if (s.techs.length) push(`科技 ${s.techs.length} 项（存档通道）`)
    if (s.perks.length) push(`飞升 ${s.perks.map((p) => p.key).join('、')}`)
    if (s.relics.length) push(`遗珍 ${s.relics.map((r) => r.key).join('、')}`)
    if (s.diplo.length) push(`外交对象 ${s.diplo.length} 个：` + s.diplo.slice(0, 8).map((d) => d.country).join('、'))
    if (s.wars.length) push(`战争 ${s.wars.length} 场`)
    if (s.situations.length) push(`局势 ${s.situations.length} 个`)
    let text = lines.join('\n')
    if (text.length > budget) text = text.slice(0, budget - 20) + '\n…（已截断）'
    return text
  }

  toJSON() {
    return {
      version: 1,
      logLocalisation: this.logLocalisation,
      snapshot: this.current,
      saveIndex: this.saveIndex,
    }
  }

  _schedulePersist() {
    if (!this.file) return
    if (this._saveTimer) clearTimeout(this._saveTimer)
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null
      try {
        mkdirSync(dirname(this.file), { recursive: true })
        writeFileSync(this.file, JSON.stringify(this.toJSON()), 'utf8')
      } catch {
        /* 缓存写失败不影响使用 */
      }
    }, 500)
    this._saveTimer.unref?.()
  }
}

export { emptySnapshot }
