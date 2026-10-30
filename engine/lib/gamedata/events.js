/**
 * 事件定义索引：从游戏安装目录的 `events/*.txt` 里抽出
 *   事件 id → 标题 loc key、是否隐藏、后继事件（option/immediate 里触发的）
 * 再按需从 `localisation/**` 取中英文标题。
 *
 * 这不是完整的脚本解析器（那需要一个 4.5 版的语法树），而是**块扫描**：
 * 找到 `xxx_event = {` 起块，按花括号配平取整块，再在块内找 id / title /
 * 后继事件引用。对「后续信息」这个用途来说，块扫描比全量解析更稳：
 * 脚本里那些 `@变量`、`>`、`!=` 不会让整份文件解析失败。
 *
 * 群星的事件后继是**动态**的：实际下一环取决于选项与触发器。
 * 这里给的是「文件里出现过的引用集合」，标注清楚，不假装是唯一路径。
 *
 * @module dsh-stellaris-bridge/gamedata/events
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { eventDirs } from '../steam.js'

const EVENT_REF = /(country_event|planet_event|fleet_event|pop_event|system_event|first_contact_event|observation_event|espionage_operation_event)\s*=\s*\{\s*id\s*=\s*([A-Za-z0-9_.\-]+)/g
const BLOCK_START = /^\s*([a-z_]+_event)\s*=\s*\{/
const ID_LINE = /^\s*id\s*=\s*([A-Za-z0-9_.\-]+)/
const TITLE_LINE = /^\s*title\s*=\s*([A-Za-z0-9_.\-]+)/
const HIDE_LINE = /^\s*hide_window\s*=\s*yes/

function listEventFiles(dir, depth = 0, ext = /\.txt$/i) {
  const out = []
  if (depth > 2) return out
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isDirectory()) out.push(...listEventFiles(full, depth + 1, ext))
    else if (ext.test(entry)) out.push(full)
  }
  return out
}

function stripLine(line) {
  const hash = line.indexOf('#')
  return hash >= 0 ? line.slice(0, hash) : line
}

/** 从某一行开始按花括号配平取出整块。 */
function takeBlock(lines, start) {
  let depth = 0
  const block = []
  for (let i = start; i < lines.length; i += 1) {
    const line = stripLine(lines[i])
    block.push(line)
    for (const ch of line) {
      if (ch === '{') depth += 1
      else if (ch === '}') depth -= 1
    }
    if (depth <= 0) break
  }
  return block
}

export class EventIndex {
  constructor({ installDir, extraDirs = [] } = {}) {
    this.installDir = installDir
    this.extraDirs = extraDirs || null
    this.events = new Map()
    this.files = []
    this.builtAt = 0
    this.locCache = new Map()
    this.locLoaded = false
  }

  get ready() {
    return this.events.size > 0
  }

  build(force = false) {
    if (this.ready && !force) return this
    this.events.clear()
    this.files = []
    if (!this.installDir) return this
    for (const dir of [...eventDirs(this.installDir), ...this.extraDirs]) {
      for (const file of listEventFiles(dir)) {
        this.files.push(file)
        this._scanFile(file)
      }
    }
    this.builtAt = Date.now()
    return this
  }

  _scanFile(file) {
    let text
    try {
      text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    } catch {
      return
    }
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i += 1) {
      const match = BLOCK_START.exec(lines[i])
      if (!match) continue
      const block = takeBlock(lines, i)
      const entry = {
        id: null,
        kind: match[1],
        file,
        titleKey: null,
        hidden: false,
        next: new Set(),
      }
      for (const line of block) {
        if (entry.id === null) {
          const idMatch = ID_LINE.exec(line)
          if (idMatch) entry.id = idMatch[1]
        }
        if (!entry.titleKey) {
          const titleMatch = TITLE_LINE.exec(line)
          if (titleMatch) entry.titleKey = titleMatch[1]
        }
        if (HIDE_LINE.test(line)) entry.hidden = true
        for (const ref of line.matchAll(EVENT_REF)) entry.next.add(ref[2])
      }
      if (entry.id) {
        entry.next = [...entry.next].filter((id) => id !== entry.id)
        this.events.set(entry.id, entry)
      }
      i += block.length - 1
    }
  }

  info(id) {
    return this.events.get(String(id)) || null
  }

  /** 事件链节点里凡是像事件 id 的，给出它的后继。 */
  successorsOf(id) {
    const entry = this.info(id)
    if (!entry) return null
    return {
      id: entry.id,
      titleKey: entry.titleKey,
      hidden: entry.hidden,
      next: entry.next.map((nextId) => ({
        id: nextId,
        titleKey: this.info(nextId)?.titleKey ?? null,
      })),
      file: entry.file,
    }
  }

  search(query, limit = 20) {
    const text = String(query || '').toLowerCase()
    if (!text) return []
    const hits = []
    for (const [id, entry] of this.events) {
      if (id.toLowerCase().includes(text) || String(entry.titleKey || '').toLowerCase().includes(text)) {
        hits.push({ id, titleKey: entry.titleKey, hidden: entry.hidden, file: entry.file })
        if (hits.length >= limit) break
      }
    }
    return hits
  }

  /** 惰性加载本地化：key → { en, zh }。 */
  _loadLoc() {
    if (this.locLoaded || !this.installDir) return
    this.locLoaded = true
    const dirs = [join(this.installDir, 'localisation')]
    const dlcRoot = join(this.installDir, 'dlc')
    if (existsSync(dlcRoot)) {
      try {
        for (const entry of readdirSync(dlcRoot)) dirs.push(join(dlcRoot, entry, 'localisation'))
      } catch {
        /* ignore */
      }
    }
    for (const dir of dirs) {
      if (!existsSync(dir)) continue
      for (const file of listEventFiles(dir, 0, /\.yml$/i)) {
        let text
        try {
          text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
        } catch {
          continue
        }
        const lang = /_zh|simp_chinese/i.test(file) ? 'zh' : /_en|english/i.test(file) ? 'en' : null
        if (!lang) continue
        for (const line of text.split(/\r?\n/)) {
          const match = /^\s*([A-Za-z0-9_.\-]+):\d*\s+"(.*)"\s*$/.exec(line)
          if (!match) continue
          const [, key, value] = match
          const slot = this.locCache.get(key) || {}
          slot[lang] = value
          this.locCache.set(key, slot)
        }
      }
    }
  }

  title(key) {
    if (!key) return null
    this._loadLoc()
    const slot = this.locCache.get(key)
    if (!slot) return null
    return slot.zh || slot.en || null
  }

  status() {
    return {
      installDir: this.installDir,
      eventFiles: this.files.length,
      events: this.events.size,
      builtAt: this.builtAt || null,
      locKeys: this.locCache.size,
    }
  }
}
