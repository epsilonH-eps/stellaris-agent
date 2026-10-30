/**
 * 每局日志（journal）：一局游戏一个文件，主会话可以往里记东西。
 *
 * 为什么放在桥里而不是让模型自己写文件：
 *   - 「这一局」的识别需要帝国名 + 首次日期，模型不一定知道；
 *   - 每条操作/分发的回执应该自动落进去，不靠模型记得写；
 *   - 日志要能按局切分，而不是所有档混在一个 md 里。
 *
 * 存储：
 *   ~/.dsh/stellaris-bridge/journal/index.json    当前局 + 历史局
 *   ~/.dsh/stellaris-bridge/journal/<gameId>.jsonl 机器可读
 *   ~/.dsh/stellaris-bridge/journal/<gameId>.md    人可读（追加）
 *
 * gameId = slug(帝国名) + '-' + 首次观察到的游戏日期；帝国名变了但存档没换
 * （比如改政体重命名）不会开新局——以存档文件 + 帝国名为准。
 *
 * @module dsh-stellaris-bridge/journal
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function slug(text) {
  const value = String(text || '').trim()
  if (!value) return 'unknown'
  return value
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 48)
}

export class Journal {
  constructor({ dir }) {
    this.dir = dir
    this.indexFile = join(dir, 'index.json')
    this.index = { current: null, games: [] }
    this.load()
  }

  load() {
    if (!this.dir) return
    try {
      if (!existsSync(this.indexFile)) return
      const raw = JSON.parse(readFileSync(this.indexFile, 'utf8').replace(/^\uFEFF/, ''))
      if (raw && typeof raw === 'object') {
        this.index = { current: raw.current ?? null, games: Array.isArray(raw.games) ? raw.games : [] }
      }
    } catch {
      /* 坏了就重开 */
    }
  }

  persist() {
    if (!this.dir) return
    try {
      mkdirSync(this.dir, { recursive: true })
      writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2), 'utf8')
    } catch {
      /* ignore */
    }
  }

  get gameId() {
    return this.index.current?.gameId ?? null
  }

  /**
   * 确定「当前这一局」。存档文件或帝国名变了就开新局。
   * @param {{empireName?: string|null, date?: string|null, saveFile?: string|null}} info
   */
  ensureGame(info = {}) {
    const empire = String(info.empireName || '').trim() || 'unknown'
    const saveFile = info.saveFile || null
    const current = this.index.current
    // 先读到「unknown」不算一局：等帝国名出来再定，避免留一堆 unknown-* 文件
    if (current && current.empire === 'unknown' && empire !== 'unknown') {
      const gameId = `${slug(empire)}-${slug(info.date || current.firstDate || 'start')}`
      const upgraded = { ...current, gameId, empire, firstDate: current.firstDate || info.date || null, saveFile: saveFile || current.saveFile }
      this.index.current = upgraded
      this.index.games = this.index.games.map((g) => (g.gameId === current.gameId ? upgraded : g))
      this.persist()
      return upgraded
    }
    if (current && current.empire === empire && (!saveFile || !current.saveFile || current.saveFile === saveFile)) {
      return current
    }
    if (current && current.empire === empire && saveFile && current.saveFile !== saveFile && current.date) {
      // 同帝国换了存档：可能是读旧档，别急着开新局；只在帝国名不同时才算新局
      current.saveFile = saveFile
      this.persist()
      return current
    }
    const gameId = `${slug(empire)}-${slug(info.date || 'start')}`
    const record = {
      gameId,
      empire,
      firstDate: info.date || null,
      saveFile,
      startedAt: Date.now(),
    }
    this.index.current = record
    this.index.games = [...this.index.games.filter((g) => g.gameId !== gameId), record].slice(-50)
    this.persist()
    this.append({ kind: 'session_start', text: `新的一局：${empire}（${info.date || '日期未知'}）` })
    return record
  }

  files() {
    if (!this.gameId) return null
    return {
      jsonl: join(this.dir, `${this.gameId}.jsonl`),
      md: join(this.dir, `${this.gameId}.md`),
    }
  }

  append(entry = {}) {
    const files = this.files()
    if (!files) return { ok: false, error: '还没有识别出「这一局」' }
    const row = {
      ts: new Date().toISOString(),
      date: entry.date ?? null,
      kind: String(entry.kind || 'note'),
      text: String(entry.text ?? '').slice(0, 2000),
      tags: Array.isArray(entry.tags) ? entry.tags.slice(0, 8) : [],
      meta: entry.meta ?? null,
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(files.jsonl, JSON.stringify(row) + '\n', 'utf8')
      const stamp = row.date || row.ts.slice(0, 16).replace('T', ' ')
      appendFileSync(files.md, `- ${stamp} · **${row.kind}** · ${row.text}\n`, 'utf8')
      return { ok: true, row, files }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  read(limit = 40) {
    const files = this.files()
    if (!files || !existsSync(files.jsonl)) return { ok: false, code: 'NO_JOURNAL', error: '这一局还没有日志' }
    const lines = readFileSync(files.jsonl, 'utf8').split(/\r?\n/).filter(Boolean)
    const entries = []
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        /* 坏行跳过 */
      }
    }
    return { ok: true, gameId: this.gameId, file: files.jsonl, entries }
  }

  status() {
    return {
      gameId: this.gameId,
      empire: this.index.current?.empire ?? null,
      firstDate: this.index.current?.firstDate ?? null,
      games: this.index.games.length,
      dir: this.dir,
    }
  }
}
