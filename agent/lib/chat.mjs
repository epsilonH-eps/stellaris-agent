/**
 * 人机聊天总线：一个入口（人说的）一个出口（主会话说的）。
 *
 * 入站：`inbound({id, text})` —— 只要求 id + text，其余字段原样保留。
 * 出站：`outbound({text, id})` —— 主会话每轮把要说的话塞进来。
 *
 * 消费方有三种：HTTP 轮询、SSE 流、GUI 直接调用；三者共享同一份带 seq 的历史，
 * `since` 是游标，断线重连不会重放全量。
 *
 * @module stellaris-agent/chat
 */
import { EventEmitter } from 'node:events'

export class ChatHub extends EventEmitter {
  constructor({ config, log = () => {} } = {}) {
    super()
    this.log = log
    this.maxHistory = Math.max(20, Number(config?.chat?.maxHistory ?? 500))
    this.messages = []
    this.seq = 0
    this.pendingIn = []
    this.lastOutAt = 0
  }

  _push(message) {
    this.seq += 1
    const row = { seq: this.seq, ts: Date.now(), ...message }
    this.messages.push(row)
    if (this.messages.length > this.maxHistory) this.messages = this.messages.slice(-this.maxHistory)
    return row
  }

  /**
   * 人说的话。
   * @param {{id:string|number, text:string, name?:string, meta?:object}} input
   */
  inbound({ id, text, name = null, meta = null } = {}) {
    const speaker = String(id ?? '').trim()
    const body = String(text ?? '').trim()
    if (!speaker) return { ok: false, error: 'MISSING_ID' }
    if (!body) return { ok: false, error: 'EMPTY_TEXT' }
    if (!this.pendingIn.some((row) => row.id === speaker)) {
      // 只记"有新输入"的标记，历史里仍然逐条保留
    }
    const row = this._push({ direction: 'in', id: speaker, name, text: body, kind: 'chat', meta })
    this.pendingIn.push(row)
    if (this.pendingIn.length > 100) this.pendingIn = this.pendingIn.slice(-100)
    this.log('chat.in', { id: speaker, chars: body.length })
    this.emit('in', row)
    return { ok: true, message: row }
  }

  /**
   * 主会话要说的话。
   * @param {{text:string, id?:string, kind?:string, replyTo?:number, meta?:object}} output
   */
  outbound({ text, id = 'main', kind = 'say', replyTo = null, meta = null } = {}) {
    const body = String(text ?? '').trim()
    if (!body) return { ok: false, error: 'EMPTY_TEXT' }
    const row = this._push({ direction: 'out', id: String(id), text: body, kind, replyTo, meta })
    this.lastOutAt = row.ts
    this.log('chat.out', { id, chars: body.length, kind })
    this.emit('out', row)
    return { ok: true, message: row }
  }

  /** 有没有还没被主会话处理的人话。 */
  hasPending() {
    return this.pendingIn.length > 0
  }

  /** 取走待处理的人话（主会话一轮消费一次）。 */
  takePending() {
    const rows = this.pendingIn.slice()
    this.pendingIn = []
    return rows
  }

  /** 轮询：返回 seq > since 的消息。 */
  poll({ since = 0, limit = 200 } = {}) {
    const from = Number(since) || 0
    const rows = this.messages.filter((row) => row.seq > from).slice(-Math.max(1, Number(limit) || 200))
    return {
      messages: rows,
      next: rows.length ? rows[rows.length - 1].seq : from,
      last: this.seq,
    }
  }

  history({ limit = 100 } = {}) {
    return this.messages.slice(-Math.max(1, Number(limit) || 100))
  }

  /** 给提示词用：最近一轮人话 + 主会话自己的话。 */
  transcript({ limit = 12 } = {}) {
    return this.messages.slice(-limit).map((row) => ({
      role: row.direction === 'in' ? 'human' : 'main',
      id: row.id,
      text: row.text,
      ts: row.ts,
    }))
  }

  status() {
    return {
      total: this.seq,
      inbound: this.messages.filter((row) => row.direction === 'in').length,
      outbound: this.messages.filter((row) => row.direction === 'out').length,
      pending: this.pendingIn.length,
      lastOutAt: this.lastOutAt || null,
    }
  }
}
