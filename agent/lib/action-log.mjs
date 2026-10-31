/**
 * 执行动作的磁盘日志：每次 job 完成后追加一行 JSON，供 GUI/外部接口查询。
 * 只保留最近 maxLines 条；文件过大时先截断再追加。
 *
 * @module stellaris-agent/action-log
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

export class ActionLog {
  constructor({ home, maxLines = 5000, maxBytes = 4 * 1024 * 1024, log = () => {} } = {}) {
    this.home = home || null
    this.file = home ? join(home, 'actions.jsonl') : null
    this.maxLines = Math.max(50, Number(maxLines) || 5000)
    this.maxBytes = Math.max(64 * 1024, Number(maxBytes) || 4 * 1024 * 1024)
    this.log = log
  }

  append(job) {
    if (!this.file || !job) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      if (existsSync(this.file) && statSync(this.file).size > this.maxBytes) this._trimFile()
      appendFileSync(this.file, `${JSON.stringify(job)}\n`, 'utf8')
    } catch (error) {
      this.log('executor.actionLog.failed', { error: String(error?.message || error) })
    }
  }

  _trimFile() {
    try {
      const lines = readFileSync(this.file, 'utf8').split(/\r?\n/).filter(Boolean)
      writeFileSync(this.file, `${lines.slice(-Math.floor(this.maxLines / 2)).join('\n')}\n`, 'utf8')
    } catch {
      /* 下次写入再试 */
    }
  }

  tail(limit = 200) {
    if (!this.file || !existsSync(this.file)) return []
    try {
      const lines = readFileSync(this.file, 'utf8').split(/\r?\n/).filter(Boolean)
      return lines.slice(-Math.max(1, Number(limit) || 200)).map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean)
    } catch {
      return []
    }
  }
}
