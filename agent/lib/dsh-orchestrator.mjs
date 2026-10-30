/**
 * DSH 编排后端的本地客户端。
 *
 * 程序仍然自己跑 swarm（组件发现、队列、暂停、完成事件），
 * 只是把「主会话/组件子会话」的思考交给 DSH 插件：
 *   POST http://127.0.0.1:<dsh-web-port>/api/stellaris-orchestrator/run
 *
 * @module stellaris-agent/dsh-orchestrator
 */
export class DSHOrchestrator {
  constructor({ baseUrl = 'http://127.0.0.1:49939', timeoutMs = 600000 } = {}) {
    this.baseUrl = String(baseUrl).replace(/\/+$/, '')
    this.timeoutMs = timeoutMs
  }

  endpoint(path) {
    const base = this.baseUrl.endsWith('/api/stellaris-orchestrator')
      ? this.baseUrl
      : this.baseUrl + '/api/stellaris-orchestrator'
    return base + path
  }

  async health() {
    const response = await fetch(this.endpoint('/health'), {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) throw new Error(`DSH orchestrator health ${response.status}`)
    return response.json()
  }

  async runTeam({ goal, label = '群星-DSH团队', timeoutMs = this.timeoutMs } = {}) {
    return this.post('/team', goal, label, timeoutMs)
  }

  async run({ goal, label = '群星参谋', timeoutMs = this.timeoutMs } = {}) {
    return this.post('/run', goal, label, timeoutMs)
  }

  async post(path, goal, label, timeoutMs) {
    const response = await fetch(this.endpoint(path), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: String(goal || ''), label, timeoutMs }),
      signal: AbortSignal.timeout(Math.max(30_000, Number(timeoutMs) || this.timeoutMs)),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.ok === false) {
      throw new Error(body.error || `DSH orchestrator ${response.status}`)
    }
    return { text: body.text || '', usage: body.usage || null }
  }
}
