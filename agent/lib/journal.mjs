/**
 * 一局一档的轻量日志：决策、上报、执行结果、聊天。
 *
 * 比 engine/lib/journal.js 简单（那个绑定存档/帝国解析），这里只保证
 * "出问题能倒查"：JSONL 追加 + 按天切文件。
 *
 * @module stellaris-agent/journal
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

function dayKey(date = new Date()) {
  return date.toISOString().slice(0, 10)
}

export class AgentJournal {
  constructor({ dir, enabled = true }) {
    this.dir = dir
    this.enabled = enabled !== false
  }

  file(date = new Date()) {
    return join(this.dir, `${dayKey(date)}.jsonl`)
  }

  append(entry = {}) {
    if (!this.enabled || !this.dir) return { ok: false, error: 'DISABLED' }
    const row = {
      ts: new Date().toISOString(),
      kind: String(entry.kind || 'note'),
      unit: entry.unit ?? null,
      text: String(entry.text ?? '').slice(0, 4000),
      meta: entry.meta ?? null,
    }
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(this.file(), JSON.stringify(row) + '\n', 'utf8')
      return { ok: true, row }
    } catch (error) {
      return { ok: false, error: String(error?.message || error) }
    }
  }

  read({ date = null, limit = 100 } = {}) {
    const file = date ? join(this.dir, `${date}.jsonl`) : this.latestFile()
    if (!file || !existsSync(file)) return { ok: false, error: 'NO_JOURNAL', entries: [] }
    const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    const entries = []
    for (const line of lines.slice(-Math.max(1, limit))) {
      try {
        entries.push(JSON.parse(line))
      } catch {
        /* 坏行跳过 */
      }
    }
    return { ok: true, file, entries }
  }

  latestFile() {
    try {
      const files = readdirSync(this.dir)
        .filter((name) => name.endsWith('.jsonl'))
        .sort()
      return files.length ? join(this.dir, files[files.length - 1]) : null
    } catch {
      return null
    }
  }

  status() {
    return { dir: this.dir, enabled: this.enabled, file: this.latestFile() }
  }
}
