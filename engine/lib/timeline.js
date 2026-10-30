/**
 * 事件账本：把「发生了什么」按时间排成一条可追溯的链。
 *
 * 为什么需要它：群星没有「任意事件触发」的钩子，单靠模组只能抓到少数
 * on_action 点；但推理要看的是「这一连串事怎么来的」。所以桥做三件事：
 *
 *   1. 收模组发来的 EVENT / CHAIN 记录（实时、带因果锚点）
 *   2. 收存档里的 situation / event_chain / flag / variable（历史、全量）
 *   3. **快照差分**：两次快照之间新增的殖民地/科技/传统/飞升/战争/局势，
 *      自动变成事件节点（source=diff）
 *
 * 链（chain）是事件的归组键：
 *   planet:<名字>      这颗星球上发生的一切
 *   tech / tradition / ascension   帝国层面的线
 *   war:<名字>         一场战争
 *   situation:<key>    一个局势
 *
 * 同一个 chain 里，新节点自动挂到上一个节点后面（parent=上一个 id），
 * 于是「全链」就是 `chain(chainName)` 返回的那一串。**缺口是显式的**：
 * 桥抓不到的节点不会伪造，只在 `gaps` 里说明来源限制。
 *
 * @module dsh-stellaris-bridge/timeline
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_ENTRIES = 1200

function keyOf(entry) {
  return [entry.kind, entry.chain, entry.node, entry.date, entry.source].join('|')
}

export class Timeline {
  constructor(options = {}) {
    this.file = options.file ?? null
    this.entries = []
    this.seq = 0
    this.knownFlags = new Set()
    this.knownVars = new Set()
    this.load()
  }

  load() {
    if (!this.file || !existsSync(this.file)) return
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8').replace(/^\uFEFF/, ''))
      if (raw && Array.isArray(raw.entries)) {
        this.entries = raw.entries.slice(-MAX_ENTRIES)
        this.seq = Number(raw.seq) || this.entries.length
        this.knownFlags = new Set(raw.knownFlags || [])
        this.knownVars = new Set(raw.knownVars || [])
      }
    } catch {
      /* 文件坏了就当空账本 */
    }
  }

  persist() {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(
        this.file,
        JSON.stringify({
          version: 1,
          seq: this.seq,
          entries: this.entries.slice(-MAX_ENTRIES),
          knownFlags: [...this.knownFlags].slice(-400),
          knownVars: [...this.knownVars].slice(-400),
        }),
        'utf8',
      )
    } catch {
      /* 写不进去不影响本轮 */
    }
  }

  /**
   * 追加一个事件节点。同 key 已存在则返回 null（去重）。
   * @param {object} input {kind, chain, node, date, source, actor, target, detail, parent}
   */
  add(input) {
    const chain = String(input.chain || 'general')
    const entry = {
      id: ++this.seq,
      ts: Date.now(),
      kind: String(input.kind || 'event'),
      chain,
      node: input.node ?? null,
      date: input.date ?? null,
      source: String(input.source || 'log'),
      actor: input.actor ?? null,
      target: input.target ?? null,
      detail: input.detail ?? null,
      parent: input.parent ?? this._lastInChain(chain)?.id ?? null,
    }
    const key = keyOf(entry)
    if (this.entries.some((item) => keyOf(item) === key)) return null
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries = this.entries.slice(-MAX_ENTRIES)
    return entry
  }

  _lastInChain(chain) {
    for (let i = this.entries.length - 1; i >= 0; i -= 1) {
      if (this.entries[i].chain === chain) return this.entries[i]
    }
    return null
  }

  /** 模组的 EVENT / CHAIN 记录。 */
  ingestRecord(record) {
    const f = record.fields || {}
    if (record.kind === 'EVENT') {
      const anchor = String(f.node || f.planet || f.target || 'general')
      return this.add({
        kind: f.kind || 'event',
        chain: f.chain === 'planet' ? `planet:${anchor}` : String(f.chain || `event:${anchor}`),
        node: anchor,
        date: f.date ?? null,
        source: f.source || 'on_action',
        actor: f.actor ?? null,
        target: f.target ?? null,
        detail: f.detail ?? null,
        parent: f.parent && f.parent !== 'none' ? Number(f.parent) || null : undefined,
      })
    }
    if (record.kind === 'CHAIN') {
      const anchor = String(f.node || f.key || 'general')
      return this.add({
        kind: 'chain_node',
        chain: f.chain === 'planet' ? `planet:${anchor}` : String(f.chain || `chain:${anchor}`),
        node: anchor,
        date: f.date ?? null,
        source: f.source || 'on_action',
        detail: f.status ?? null,
      })
    }
    return null
  }

  /**
   * 存档里的局势/事件链/旗标/变量 → 节点。
   * @param {object} archive extractArchive 的输出
   */
  ingestArchive(archive) {
    const added = []
    const date = archive?.meta?.date ?? null
    for (const item of archive?.situations || []) {
      const anchor = String(item.key || item.id || 'situation')
      const entry = this.add({
        kind: 'situation',
        chain: `situation:${anchor}`,
        node: anchor,
        date,
        source: 'save',
        detail: `progress=${item.progress ?? '?'} stage=${item.stage ?? '?'}`,
      })
      if (entry) added.push(entry)
    }
    for (const chain of archive?.chains || []) {
      const anchor = String(chain.key || chain.id || 'chain')
      const entry = this.add({
        kind: 'save_chain',
        chain: `chain:${anchor}`,
        node: anchor,
        date,
        source: 'save',
        detail: `status=${chain.status ?? '?'} nodes=${(chain.nodes || []).length}`,
      })
      if (entry) added.push(entry)
    }
    for (const flag of archive?.flags || []) {
      if (this.knownFlags.has(flag.key)) continue
      this.knownFlags.add(flag.key)
      const entry = this.add({
        kind: 'flag_set',
        chain: 'flags',
        node: flag.key,
        date,
        source: 'save',
      })
      if (entry) added.push(entry)
      void date
    }
    for (const variable of archive?.variables || []) {
      if (this.knownVars.has(variable.key)) continue
      this.knownVars.add(variable.key)
      const entry = this.add({
        kind: 'variable_set',
        chain: 'variables',
        node: variable.key,
        date,
        source: 'save',
        detail: `value=${variable.value ?? '?'}`,
      })
      if (entry) added.push(entry)
    }
    if (added.length) this.persist()
    return added
  }

  /**
   * 快照差分：同一实体「上次没有、这次有」就是一条新事件。
   * 只做低噪声项（殖民地/科技/传统/飞升/战争/局势），不做资源波动。
   */
  diffSnapshots(prev, next) {
    if (!prev || !next) return []
    const added = []
    const date = next.date ?? null
    const push = (input) => {
      const entry = this.add({ ...input, date, source: 'diff' })
      if (entry) added.push(entry)
    }

    const prevPlanets = new Set((prev.planets || []).map((p) => String(p.name || '')))
    for (const planet of next.planets || []) {
      const name = String(planet.name || '')
      if (!name || prevPlanets.has(name)) continue
      push({ kind: 'planet_colonized', chain: `planet:${name}`, node: name, detail: `ord=${planet.ord}` })
    }

    const prevTechs = new Set((prev.techs || []).map((t) => String(t.key)))
    for (const tech of next.techs || []) {
      if (prevTechs.has(String(tech.key))) continue
      push({ kind: 'tech_researched', chain: 'tech', node: tech.key })
    }

    const prevTraditions = new Set((prev.traditions || []).map((t) => String(t.key)))
    for (const item of next.traditions || []) {
      if (prevTraditions.has(String(item.key))) continue
      push({ kind: 'tradition_picked', chain: 'tradition', node: item.key })
    }

    const prevPerks = new Set((prev.perks || []).map((t) => String(t.key)))
    for (const item of next.perks || []) {
      if (prevPerks.has(String(item.key))) continue
      push({ kind: 'perk_picked', chain: 'ascension', node: item.key })
    }

    const prevWars = new Set((prev.wars || []).map((w) => String(w.name || w.id)))
    for (const war of next.wars || []) {
      const name = String(war.name || war.id)
      if (prevWars.has(name)) continue
      push({ kind: 'war_started', chain: `war:${name}`, node: name })
    }

    const prevSituations = new Set((prev.situations || []).map((s) => String(s.key || s.id)))
    for (const item of next.situations || []) {
      const key = String(item.key || item.id)
      if (prevSituations.has(key)) continue
      push({ kind: 'situation_started', chain: `situation:${key}`, node: key })
    }

    if (added.length) this.persist()
    return added
  }

  list(query = {}) {
    const limit = Math.min(Math.max(Number(query.limit ?? 40), 1), 400)
    let rows = this.entries
    if (query.chain) rows = rows.filter((e) => e.chain === String(query.chain))
    if (query.kind) rows = rows.filter((e) => e.kind === String(query.kind))
    if (query.since) {
      const since = Number(query.since)
      if (Number.isFinite(since)) rows = rows.filter((e) => e.id > since)
    }
    return rows.slice(-limit)
  }

  /**
   * 一条链的全貌：节点按 parent 串起来，并显式标注缺口。
   * @param {string} chain
   */
  chain(chain) {
    const name = String(chain || '')
    const nodes = this.entries.filter((e) => e.chain === name)
    if (!nodes.length) {
      // 允许按裸名字找（planet:地球 / situation:xxx）
      const fuzzy = this.entries.filter((e) => e.chain.endsWith(`:${name}`))
      if (!fuzzy.length) return { ok: false, chain: name, nodes: [], gaps: ['账本里没有这条链'] }
      return this.chain(fuzzy[0].chain)
    }
    const ordered = [...nodes].sort((a, b) => a.id - b.id)
    const gaps = []
    for (let i = 0; i < ordered.length; i += 1) {
      const node = ordered[i]
      if (i === 0) continue
      const prev = ordered[i - 1]
      if (node.parent !== null && node.parent !== prev.id) {
        gaps.push(`节点 ${node.id}（${node.kind} ${node.node ?? ''}）的 parent=${node.parent}，与相邻节点 ${prev.id} 不连续`)
      }
    }
    if (ordered.every((e) => e.source !== 'on_action')) {
      gaps.push('这条链没有实时钩子节点，全部由存档/差分重建：分支选择与中间对话是引擎内部状态，看不到')
    }
    return { ok: true, chain: name, nodes: ordered, gaps }
  }

  brief(limit = 8) {
    const rows = this.entries.slice(-limit)
    if (!rows.length) return '（事件账本还是空的：进游戏过一个月，或跑 stellaris_timeline 前先 stellaris_refresh）'
    return rows
      .map((e) => `${e.date ?? '?'} ${e.kind} ${e.chain}${e.node ? ` → ${e.node}` : ''}（${e.source}）`)
      .join('\n')
  }

  status() {
    return { entries: this.entries.length, seq: this.seq, chains: new Set(this.entries.map((e) => e.chain)).size }
  }
}
