/**
 * DeepSeek 后端（API Key 方式，OpenAI 兼容 `/chat/completions`）。
 *
 * 与 DSH 后端的**唯一契约**：`complete({system, messages}) -> {text, usage, model}`。
 * 不用 function calling：两种后端行为必须一致，所以统一走"回复里放 JSON 块"。
 *
 * @module stellaris-agent/ai/deepseek
 */
export class DeepSeekError extends Error {
  constructor(message, { status = 0, body = '', retryable = false, code = 'DEEPSEEK_ERROR' } = {}) {
    super(message)
    this.name = 'DeepSeekError'
    this.status = status
    this.body = body
    this.retryable = retryable
    this.code = code
  }
}

const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504])
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class DeepSeekBackend {
  constructor({ config, log = () => {}, fetchImpl = null } = {}) {
    const settings = config?.ai?.deepseek || {}
    this.config = config
    this.log = log
    this.apiKey = String(settings.apiKey || '').trim()
    this.baseUrl = String(settings.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
    this.model = settings.model || 'deepseek-chat'
    this.timeoutMs = Number(settings.timeoutMs || 120000)
    this.retries = Number(settings.retries ?? 2)
    this.fetchImpl = fetchImpl || globalThis.fetch
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 }
    this.lastError = null
  }

  get name() {
    return 'deepseek'
  }

  get available() {
    return Boolean(this.apiKey)
  }

  describe() {
    return { backend: 'deepseek', model: this.model, baseUrl: this.baseUrl, configured: this.available, usage: this.usage }
  }

  async health() {
    if (!this.available) return { ok: false, backend: 'deepseek', error: 'MISSING_API_KEY' }
    return { ok: true, backend: 'deepseek', model: this.model }
  }

  _recordUsage(usage) {
    if (!usage) return
    this.usage.calls += 1
    this.usage.promptTokens += Number(usage.prompt_tokens || 0)
    this.usage.completionTokens += Number(usage.completion_tokens || 0)
    this.usage.totalTokens += Number(usage.total_tokens || 0)
  }

  async _post(body) {
    let lastError = null
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      timer.unref?.()
      try {
        const response = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.apiKey}` },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          throw new DeepSeekError(`DeepSeek ${response.status}: ${text.slice(0, 400)}`, {
            status: response.status,
            body: text,
            retryable: RETRYABLE.has(response.status),
          })
        }
        return response
      } catch (error) {
        lastError = error
        const retryable = error instanceof DeepSeekError ? error.retryable : true
        if (!retryable || attempt === this.retries) break
        await sleep(500 * 2 ** attempt)
      } finally {
        clearTimeout(timer)
      }
    }
    this.lastError = String(lastError?.message || lastError)
    if (lastError instanceof DeepSeekError) throw lastError
    throw new DeepSeekError(`DeepSeek 请求失败：${lastError?.message || lastError}`, { retryable: false, code: 'NETWORK' })
  }

  /**
   * @param {{system:string, messages:Array<{role:string,content:string}>, maxTokens?:number, temperature?:number, label?:string}} request
   */
  async complete({ system, messages, maxTokens = null, temperature = null } = {}) {
    if (!this.available) throw new DeepSeekError('缺少 DeepSeek API Key（设置页填写，或改用 DSH 后端）', { code: 'MISSING_API_KEY' })
    const body = {
      model: this.model,
      messages: [...(system ? [{ role: 'system', content: system }] : []), ...(messages || [])],
      temperature: Number(temperature ?? this.config?.ai?.deepseek?.temperature ?? 0.3),
      max_tokens: Number(maxTokens ?? this.config?.ai?.deepseek?.maxTokens ?? 4096),
      stream: false,
    }
    const response = await this._post(body)
    const data = await response.json()
    this._recordUsage(data.usage)
    const message = data.choices?.[0]?.message
    if (!message) throw new DeepSeekError('DeepSeek 返回里没有 message', { code: 'BAD_RESPONSE', body: JSON.stringify(data).slice(0, 400) })
    return {
      text: String(message.content || ''),
      usage: data.usage || null,
      model: data.model || body.model,
      backend: 'deepseek',
    }
  }
}
