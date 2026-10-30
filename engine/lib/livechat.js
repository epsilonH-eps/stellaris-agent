/**
 * 直播间接口：把弹幕收进来，把回复送出去。
 *
 * 定位：桥不自己去连 B 站/抖音（那需要登录、需要平台 SDK、还很容易被风控），
 * 它只提供一个**本机 HTTP 接口**。任何推流工具/脚本/OBS 插件把弹幕 POST
 * 进来，桥就能让模型看见；模型想说话就 `livechat_say`，外部工具从
 * `/stream`（SSE）或 `/poll` 取走。
 *
 * 队列是纯内存的，重启即清空——弹幕本来就不该持久化。
 *
 * @module dsh-stellaris-bridge/livechat
 */
let counter = 0

function nextId(prefix) {
  counter += 1
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`
}

export class LiveChat {
  constructor(options = {}) {
    this.maxQueue = Number(options.maxQueue ?? 200)
    this.allowSay = options.allowSay !== false
    this.messages = []
    this.replies = []
    this.listeners = new Set()
    this.lastDanmakuAt = 0
    this.stats = { received: 0, sent: 0, dropped: 0 }
  }

  _emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        /* 单个订阅者坏了不影响别人 */
      }
    }
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  trim() {
    while (this.messages.length > this.maxQueue) {
      this.messages.shift()
      this.stats.dropped += 1
    }
    while (this.replies.length > this.maxQueue) this.replies.shift()
  }

  ingest(input) {
    const text = String(input?.text ?? '').trim()
    if (!text) return { ok: false, error: 'text 为空' }
    const message = {
      id: nextId('d'),
      seq: this.stats.received + 1,
      user: String(input?.user ?? '匿名').slice(0, 60),
      text: text.slice(0, 500),
      platform: String(input?.platform ?? 'unknown').slice(0, 20),
      at: Number(input?.ts) || Date.now(),
    }
    this.stats.received += 1
    this.lastDanmakuAt = Date.now()
    this.messages.push(message)
    this.trim()
    this._emit({ type: 'danmaku', message })
    return { ok: true, message }
  }

  poll(sinceSeq = 0) {
    const since = Number(sinceSeq) || 0
    const messages = this.messages.filter((m) => m.seq > since)
    return { messages, lastSeq: this.stats.received, stats: { ...this.stats } }
  }

  say(text, to) {
    if (!this.allowSay) return { ok: false, error: 'liveChat.allowSay = false' }
    const body = String(text ?? '').trim()
    if (!body) return { ok: false, error: 'text 为空' }
    const reply = {
      id: nextId('r'),
      seq: this.stats.sent + 1,
      text: body.slice(0, 500),
      to: to ? String(to).slice(0, 60) : null,
      at: Date.now(),
    }
    this.stats.sent += 1
    this.replies.push(reply)
    this.trim()
    this._emit({ type: 'reply', reply })
    return { ok: true, reply }
  }

  status() {
    return {
      enabled: true,
      received: this.stats.received,
      sent: this.stats.sent,
      dropped: this.stats.dropped,
      lastDanmakuAt: this.lastDanmakuAt || null,
      pendingReplies: this.replies.length,
    }
  }
}
