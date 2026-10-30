/**
 * 主会话的"人话"输出（voice）：每轮/隔轮一句，供外部 TTS、直播、OB 程序消费。
 *
 * 存储：
 *   <home>/voice/YYYY-MM-DD.jsonl   追加日志
 *   <home>/voice/latest.json        最近一条
 *
 * 接口：
 *   list({since, limit})  since 是上一次拿到的 id（游标）
 *
 * @module stellaris-agent/voice
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function dayStamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function clip(value, max) {
  const text = String(value ?? '').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

export class VoiceLog {
  constructor({ home, max = 500, log = () => {} } = {}) {
    this.home = home
    this.dir = join(home, 'voice')
    this.max = Math.max(20, Number(max) || 500)
    this.log = log
    this.rows = []
    this.seq = 0
    this._load()
  }

  _load() {
    try {
      const file = join(this.dir, `${dayStamp()}.jsonl`)
      if (!existsSync(file)) return
      const lines = readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
      for (const line of lines.slice(-this.max)) {
        try {
          this.rows.push(JSON.parse(line))
        } catch {
          /* 跳过坏行 */
        }
      }
    } catch {
      /* 没有历史 */
    }
  }

  /**
   * @param {{text:string, mood?:string, intent?:string, turn?:number, reason?:string, actions?:string[], at?:number}} input
   */
  push(input = {}) {
    const text = clip(input.text, 500)
    if (!text) return null
    const at = Number(input.at) || Date.now()
    const id = `v-${at}-${++this.seq}`
    const entry = {
      id,
      at,
      atIso: new Date(at).toISOString(),
      text,
      mood: clip(input.mood, 40) || null,
      intent: clip(input.intent, 200) || null,
      turn: Number(input.turn) || null,
      reason: clip(input.reason, 80) || null,
      actions: Array.isArray(input.actions) ? input.actions.slice(0, 12) : [],
    }
    this.rows.push(entry)
    if (this.rows.length > this.max) this.rows = this.rows.slice(-this.max)
    try {
      mkdirSync(this.dir, { recursive: true })
      appendFileSync(join(this.dir, `${dayStamp(new Date(at))}.jsonl`), `${JSON.stringify(entry)}\n`, 'utf8')
      writeFileSync(join(this.dir, 'latest.json'), `${JSON.stringify(entry, null, 2)}\n`, 'utf8')
    } catch (error) {
      this.log('voice.write.failed', { error: String(error?.message || error) })
    }
    this.log('voice.push', { id, chars: text.length, mood: entry.mood })
    return entry
  }

  latest() {
    return this.rows.at(-1) || null
  }

  /**
   * @param {{since?:string, limit?:number}} [options]
   */
  list({ since = '', limit = 50 } = {}) {
    const size = Math.max(1, Math.min(this.max, Number(limit) || 50))
    let rows = this.rows
    if (since) {
      const index = rows.findIndex((row) => row.id === since)
      if (index >= 0) rows = rows.slice(index + 1)
      else {
        const stamp = Number(String(since).split('-')[1])
        if (Number.isFinite(stamp)) rows = rows.filter((row) => row.at > stamp)
      }
    }
    return rows.slice(-size)
  }
}
