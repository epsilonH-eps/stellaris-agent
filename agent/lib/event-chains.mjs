/**
 * 事件链索引：把游戏 + 所有 mod 的事件文件一次性解析成图，缓存在本地。
 *
 * 用法：
 *   - 开局前/配置政体时跑一次 `events-index`；
 *   - 遇到事件时 `events-chain <event_id>` 直接查后继，不用现场读几万个文件；
 *   - 图是数据驱动的，mod 事件也会被扫进来（EventIndex 扫 eventDirs）。
 *
 * @module stellaris-agent/event-chains
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join, dirname as pathDirname } from 'node:path'
import { dirname } from 'node:path'
import { EventIndex } from '../../engine/lib/gamedata/events.js'

export function modEventDirs(installDir) {
  const out = []
  const add = (dir) => {
    try { if (dir && statSync(dir).isDirectory()) out.push(dir) } catch {}
  }
  const userMods = join(process.env.USERPROFILE || '', 'Documents', 'Paradox Interactive', 'Stellaris', 'mod')
  try {
    for (const entry of readdirSync(userMods)) add(join(userMods, entry, 'events'))
  } catch {}
  const workshop = join(pathDirname(pathDirname(installDir)), 'workshop', 'content', '281990')
  try {
    for (const entry of readdirSync(workshop)) add(join(workshop, entry, 'events'))
  } catch {}
  return out
}

export function buildEventIndex(installDir, extraDirs = modEventDirs(installDir)) {
  const index = new EventIndex({ installDir, extraDirs }).build(true)
  return index
}

export function exportEvents(index) {
  return [...index.events.values()].map((entry) => ({
    id: entry.id,
    kind: entry.kind,
    titleKey: entry.titleKey,
    hidden: entry.hidden,
    file: entry.file,
    next: entry.next,
  }))
}

export function buildChains(installDir) {
  const index = buildEventIndex(installDir, modEventDirs(installDir))
  const events = exportEvents(index)
  const incoming = new Map()
  for (const event of events) incoming.set(event.id, 0)
  for (const event of events) {
    for (const next of event.next) incoming.set(next, (incoming.get(next) || 0) + 1)
  }
  const roots = events.filter((event) => (incoming.get(event.id) || 0) === 0).map((event) => event.id)
  const terminals = events.filter((event) => event.next.length === 0).map((event) => event.id)
  return {
    builtAt: new Date().toISOString(),
    installDir,
    count: events.length,
    roots,
    terminals,
    stats: {
      roots: roots.length,
      terminals: terminals.length,
      withNext: events.filter((event) => event.next.length > 0).length,
      hidden: events.filter((event) => event.hidden).length,
    },
    events,
  }
}

export function loadChains(file) {
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

export function saveChains(file, data) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(data), 'utf8')
  return file
}

/** 给一个事件 id，返回它的后继树（默认 4 层，防止大图爆炸）。 */
export function chainOf(data, id, depth = 4, limit = 200) {
  const byId = new Map(data.events.map((event) => [event.id, event]))
  const root = byId.get(id)
  if (!root) return null
  const seen = new Set()
  const out = []
  const queue = [{ id, level: 0 }]
  while (queue.length && out.length < limit) {
    const current = queue.shift()
    const event = byId.get(current.id)
    if (!event || seen.has(event.id)) continue
    seen.add(event.id)
    out.push({ id: event.id, kind: event.kind, titleKey: event.titleKey, hidden: event.hidden, level: current.level, next: event.next })
    if (current.level >= depth) continue
    for (const next of event.next) if (!seen.has(next)) queue.push({ id: next, level: current.level + 1 })
  }
  return { root: { id: root.id, kind: root.kind, titleKey: root.titleKey, file: root.file }, nodes: out }
}
