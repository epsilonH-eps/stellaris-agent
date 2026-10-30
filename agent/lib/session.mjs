/**
 * 会话：一段独立的对话上下文。
 *
 * 独立版没有 DSH 的 session，所以「主会话 / 操作员 / 每一个子任务」都是
 * 这里的 AgentSession。历史会被压缩：保留 system + 最近若干条，
 * 并且不会把 tool 结果切成孤儿（否则 API 会 400）。
 *
 * @module stellaris-agent/session
 */
export class AgentSession {
  constructor({ label = 'main', system = '', maxMessages = 26 } = {}) {
    this.label = label
    this.system = system
    this.maxMessages = maxMessages
    this.history = [] // 不含 system
    this.createdAt = Date.now()
    this.turns = 0
  }

  messages() {
    const list = this.system ? [{ role: 'system', content: this.system }] : []
    return list.concat(this.history)
  }

  push(message) {
    if (!message) return
    this.history.push(message)
    this._compact()
  }

  pushUser(text) {
    this.push({ role: 'user', content: String(text) })
    this.turns += 1
  }

  _compact() {
    while (this.history.length > this.maxMessages) {
      this.history.shift()
      // 别让第一条是 tool（它必须紧跟 assistant 的 tool_calls）
      while (this.history.length && this.history[0]?.role === 'tool') this.history.shift()
    }
  }

  /** 给运维/日志用的一行摘要。 */
  summary() {
    return `${this.label}: ${this.turns} 轮，${this.history.length} 条消息`
  }
}

/** 主会话 + 操作员会话的集合。 */
export class SessionPool {
  constructor() {
    this.sessions = new Map()
  }

  get(label) {
    if (!this.sessions.has(label)) this.sessions.set(label, new AgentSession({ label }))
    return this.sessions.get(label)
  }

  reset(label) {
    this.sessions.delete(label)
  }

  list() {
    return [...this.sessions.values()].map((session) => session.summary())
  }
}
