/**
 * 事件链：把「当前激活的事件」接到静态事件图上，并展开后续。
 *
 * 数据来源两级：
 *  1. 原生桥 `get_active_events`：当前弹窗（window_id / id / 选项 / 是否可选）；
 *  2. 本地事件定义索引（原版 + DLC + 已启用模组）：id → 后继事件。
 *
 * 事件索引构建很贵（几千个文件），所以：
 *  - 缓存在 `<agentHome>/event-index.json`，默认 12 小时内复用；
 *  - 安装目录 / 模组目录 / dlc_load.json 变化时自动失效；
 *  - `force` 时不读缓存。
 *
 * @module stellaris-agent/events
 */
import { existsSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { EventIndex } from '../../engine/lib/gamedata/events.js'

const CACHE_VERSION = 2
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function dirStamp(dirs) {
  return dirs
    .filter((dir) => dir && existsSync(dir))
    .map((dir) => {
      let mtime = 0
      try {
        mtime = Math.floor(statSync(dir).mtimeMs)
      } catch {
        mtime = 0
      }
      return `${dir}@${mtime}`
    })
    .join('|')
}

export class EventGraph {
  constructor({ home, installDir, modEventDirs = [], ttlMs = DEFAULT_TTL_MS, log = () => {} }) {
    this.home = home
    this.installDir = installDir
    this.modEventDirs = modEventDirs
    this.ttlMs = ttlMs
    this.log = log
    this.file = join(home, 'event-index.json')
    this.index = null
    this.builtAt = 0
    this.cacheHit = false
  }

  key() {
    return `${CACHE_VERSION}|${this.installDir || ''}|${dirStamp(this.modEventDirs)}`
  }

  status() {
    return {
      ready: Boolean(this.index?.ready),
      events: this.index?.events.size ?? 0,
      files: this.index?.files.length ?? 0,
      builtAt: this.builtAt || null,
      cacheHit: this.cacheHit,
      installDir: this.installDir || null,
      modEventDirs: this.modEventDirs,
    }
  }

  /** 载入缓存或重建。 */
  build({ force = false } = {}) {
    if (!this.installDir) {
      this.index = null
      return this
    }
    const cached = readJson(this.file)
    const fresh = cached && cached.version === CACHE_VERSION && cached.key === this.key() && Date.now() - (cached.builtAt || 0) < this.ttlMs
    if (!force && fresh && Array.isArray(cached.events)) {
      this.index = hydrateIndex({ installDir: this.installDir, events: cached.events })
      this.builtAt = cached.builtAt
      this.cacheHit = true
      this.log('events.cache.hit', { events: cached.events.length })
      return this
    }
    const started = Date.now()
    const index = new EventIndex({ installDir: this.installDir, extraDirs: this.modEventDirs }).build(true)
    this.index = index
    this.builtAt = Date.now()
    this.cacheHit = false
    this.log('events.index.built', { events: index.events.size, files: index.files.length, ms: this.builtAt - started })
    try {
      mkdirSync(this.home, { recursive: true })
      writeFileSync(
        this.file,
        JSON.stringify({
          version: CACHE_VERSION,
          key: this.key(),
          builtAt: this.builtAt,
          events: [...index.events.values()].map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            file: entry.file,
            titleKey: entry.titleKey,
            hidden: entry.hidden,
            next: [...entry.next],
          })),
        }),
        'utf8',
      )
    } catch (error) {
      this.log('events.cache.write.failed', { error: String(error?.message || error) })
    }
    return this
  }

  info(id) {
    return this.index?.info(String(id)) || null
  }

  title(key) {
    if (!this.index) return null
    try {
      return this.index.title(key)
    } catch {
      return null
    }
  }

  /** 事件 id 的后续树（默认 6 层，节点数上限 200）。 */
  successors(id, depth = 6, limit = 200) {
    const root = this.info(id)
    if (!root) return null
    const seen = new Set([root.id])
    const nodes = []
    const queue = [{ id: root.id, level: 0 }]
    while (queue.length && nodes.length < limit) {
      const current = queue.shift()
      const entry = this.info(current.id)
      if (!entry) continue
      nodes.push({
        id: entry.id,
        level: current.level,
        titleKey: entry.titleKey,
        title: this.title(entry.titleKey),
        hidden: Boolean(entry.hidden),
        next: [...entry.next],
      })
      if (current.level >= depth) continue
      for (const nextId of entry.next) {
        if (seen.has(nextId)) continue
        seen.add(nextId)
        queue.push({ id: nextId, level: current.level + 1 })
      }
    }
    return {
      root: { id: root.id, titleKey: root.titleKey, title: this.title(root.titleKey), kind: root.kind, file: root.file },
      nodes,
      depth,
      truncated: queue.length > 0,
    }
  }

  search(query, limit = 20) {
    return this.index?.search(query, limit) || []
  }
}

function hydrateIndex({ installDir, events }) {
  const index = new EventIndex({ installDir })
  const files = new Set()
  for (const row of events) {
    index.events.set(row.id, {
      id: row.id,
      kind: row.kind,
      file: row.file,
      titleKey: row.titleKey,
      hidden: Boolean(row.hidden),
      next: new Set(row.next || []),
    })
    if (row.file) files.add(row.file)
  }
  index.files = [...files]
  index.builtAt = Date.now()
  return index
}

/**
 * 从当前激活事件里挑出事件 id。
 * 原生桥不同版本字段名可能是 id / event_id / key，全部兜住。
 */
export function eventIdOf(activeEvent) {
  if (!activeEvent || typeof activeEvent !== 'object') return null
  const candidates = [activeEvent.id, activeEvent.event_id, activeEvent.eventId, activeEvent.key, activeEvent.event_key]
  return candidates.map((value) => (value === undefined || value === null ? '' : String(value))).find(Boolean) || null
}

/**
 * 已激活事件 → 带后续的事件链视图。
 * @param {EventGraph} graph
 * @param {Array<object>} activeEvents
 * @param {{depth?:number, max?:number}} [options]
 */
export function resolveActiveChains(graph, activeEvents, { depth = 6, max = 300 } = {}) {
  const list = Array.isArray(activeEvents) ? activeEvents : activeEvents?.events || []
  const out = []
  const unresolved = []
  for (const [index, active] of list.entries()) {
    if (out.length >= max) break
    const id = eventIdOf(active)
    const chain = id && graph ? graph.successors(id, depth) : null
    const row = {
      windowId: active.window_id ?? active.windowId ?? active.id ?? null,
      id: id || null,
      title: active.title || (chain?.root?.title ?? null),
      titleKey: active.title_key || chain?.root?.titleKey || null,
      description: active.description || active.desc || null,
      options: active.options || active.choices || [],
      index,
      chain,
    }
    out.push(row)
    if (id && !chain) unresolved.push(id)
  }
  return { active: out, unresolved, count: out.length }
}
