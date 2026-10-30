/**
 * 会话上下文：一段独立的多轮对话（system + messages），带裁剪。
 *
 * 三种后端（DeepSeek / DSH）都只认 `messages` 数组；DSH 由客户端负责拍平。
 *
 * @module stellaris-agent/ai/session
 */
export class AISession {
  constructor({ backend, system = '', maxMessages = 18, label = 'session', log = () => {} }) {
    this.backend = backend
    this.system = system
    this.maxMessages = Math.max(4, Number(maxMessages) || 18)
    this.label = label
    this.log = log
    this.messages = []
    this.turns = 0
    this.lastUsage = null
    this.createdAt = Date.now()
    this.lastAt = 0
    this.lastError = null
  }

  reset(system = this.system) {
    this.system = system
    this.messages = []
    this.turns = 0
    this.lastAt = 0
    this.lastError = null
  }

  push(message) {
    if (!message) return
    this.messages.push({ ts: Date.now(), ...message })
    this.lastAt = Date.now()
    this._trim()
  }

  pushUser(text) {
    const content = String(text || '').trim()
    if (!content) return
    this.push({ role: 'user', content })
    this.turns += 1
  }

  pushAssistant(text) {
    const content = String(text || '').trim()
    if (!content) return
    this.push({ role: 'assistant', content })
  }

  /** 系统侧补充（执行结果/上报），以 user 身份进入，模型更容易当"新信息"处理。 */
  pushObservation(text) {
    this.pushUser(`【系统】${String(text || '').trim()}`)
  }

  _trim() {
    while (this.messages.length > this.maxMessages) this.messages.shift()
    while (this.messages.length && this.messages[0].role !== 'user') this.messages.shift()
  }

  transcript() {
    return this.messages.map((row) => ({ role: row.role, content: row.content }))
  }

  /**
   * 给界面看的快照（内容截断，避免一次把几十 KB 的 JSON 塞进文本框）。
   */
  snapshot({ maxMessages = 200, maxChars = 12000, includeSystem = true } = {}) {
    const messages = this.messages.slice(-Math.max(1, maxMessages)).map((row) => {
      const text = String(row.content ?? '')
      return {
        role: row.role,
        ts: row.ts || null,
        chars: text.length,
        content: text.length > maxChars ? `${text.slice(0, maxChars)}\n…（已截断 ${text.length - maxChars} 字符）` : text,
      }
    })
    return {
      label: this.label,
      system: includeSystem ? this.system : null,
      systemChars: this.system.length,
      messages,
      messageCount: this.messages.length,
      turns: this.turns,
      lastUsage: this.lastUsage,
      createdAt: this.createdAt,
      lastAt: this.lastAt || null,
    }
  }

  /**
   * 问一次模型。回复会写回上下文。
   * @param {{maxTokens?:number, temperature?:number, timeoutMs?:number, team?:boolean}} [options]
   */
  async ask(options = {}) {
    if (!this.backend) throw new Error('没有可用的 AI 后端')
    const reply = await this.backend.complete({
      system: this.system,
      messages: this.transcript(),
      maxTokens: options.maxTokens,
      temperature: options.temperature,
      timeoutMs: options.timeoutMs,
      team: options.team,
      label: this.label,
    })
    this.turns += 1
    this.lastUsage = reply.usage || null
    this.pushAssistant(reply.text)
    this.log('ai.turn', { label: this.label, turns: this.turns, chars: String(reply.text || '').length, backend: reply.backend })
    return reply
  }
}
