/**
 * DeepSeek API 客户端（OpenAI 兼容）。
 *
 * 只依赖 Node 22 自带的 fetch，不引 SDK——独立软件不想背一堆依赖。
 *
 * 支持：
 *   - `/chat/completions` 普通与流式（SSE）
 *   - function calling（deepseek-chat）；`deepseek-reasoner` 不保证支持工具，
 *     调用方可以退回「解析 ```stellaris 块」模式
 *   - 429/5xx/网络错误重试（指数退避），超时可中断
 *   - 用量统计（prompt/completion/total，含缓存命中字段如果有）
 *
 * @module stellaris-agent/deepseek
 */

export class DeepSeekError extends Error {
  constructor(message, { status = 0, body = '', retryable = false } = {}) {
    super(message)
    this.name = 'DeepSeekError'
    this.status = status
    this.body = body
    this.retryable = retryable
  }
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504])

function isRetryable(error) {
  if (!error) return false
  if (error instanceof DeepSeekError) return error.retryable
  return true // fetch 的网络错误（DNS/连接重置）都值得重试
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export class DeepSeekClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.baseUrl]
   * @param {string} [options.model]
   * @param {number} [options.timeoutMs]
   * @param {Function} [options.fetchImpl] 测试注入
   * @param {number} [options.retries]
   */
  constructor(options = {}) {
    this.apiKey = String(options.apiKey || '').trim()
    this.baseUrl = String(options.baseUrl || 'https://api.deepseek.com').replace(/\/+$/, '')
    this.model = options.model || 'deepseek-chat'
    this.timeoutMs = Number(options.timeoutMs || 120000)
    this.fetchImpl = options.fetchImpl || globalThis.fetch
    this.retries = Number(options.retries ?? 2)
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 }
  }

  get enabled() {
    return Boolean(this.apiKey)
  }

  _headers() {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    }
  }

  _url(path) {
    return `${this.baseUrl}${path}`
  }

  async _request(path, body, { stream = false } = {}) {
    if (!this.apiKey) throw new DeepSeekError('缺少 DeepSeek API key', { status: 401 })
    let lastError = null
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), this.timeoutMs)
      timer.unref?.()
      try {
        const response = await this.fetchImpl(this._url(path), {
          method: 'POST',
          headers: this._headers(),
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        if (!response.ok) {
          const text = await response.text().catch(() => '')
          const error = new DeepSeekError(
            `DeepSeek ${response.status}: ${text.slice(0, 500)}`,
            { status: response.status, body: text, retryable: RETRYABLE_STATUS.has(response.status) },
          )
          throw error
        }
        return response
      } catch (error) {
        lastError = error
        const retryable = isRetryable(error)
        if (!retryable || attempt === this.retries) break
        await sleep(400 * 2 ** attempt)
      } finally {
        clearTimeout(timer)
      }
    }
    if (lastError instanceof DeepSeekError) throw lastError
    throw new DeepSeekError(`DeepSeek 请求失败：${lastError?.message || lastError}`, { retryable: false })
  }

  _recordUsage(usage) {
    if (!usage) return
    this.usage.calls += 1
    this.usage.promptTokens += Number(usage.prompt_tokens || 0)
    this.usage.completionTokens += Number(usage.completion_tokens || 0)
    this.usage.totalTokens += Number(usage.total_tokens || 0)
  }

  /**
   * 普通（非流式）对话。
   * @param {Array<object>} messages
   * @param {object} [options] {tools, toolChoice, temperature, maxTokens, model}
   * @returns {Promise<{message: object, usage: object|null, model: string}>}
   */
  async chat(messages, options = {}) {
    const body = {
      model: options.model || this.model,
      messages,
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxTokens ?? 4096,
      stream: false,
    }
    if (options.tools?.length) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice || 'auto'
    }
    const response = await this._request('/chat/completions', body)
    const data = await response.json()
    this._recordUsage(data.usage)
    const message = data.choices?.[0]?.message
    if (!message) throw new DeepSeekError('DeepSeek 返回里没有 message', { body: JSON.stringify(data).slice(0, 500) })
    return { message, usage: data.usage || null, model: data.model || body.model }
  }

  /**
   * 流式对话（SSE）。逐段回调，最终返回拼好的 message。
   * @param {Array<object>} messages
   * @param {object} options
   * @param {(delta: {content?: string, reasoning?: string, toolCall?: object}) => void} [onDelta]
   */
  async chatStream(messages, options = {}, onDelta = () => {}) {
    const body = {
      model: options.model || this.model,
      messages,
      temperature: options.temperature ?? 0.4,
      max_tokens: options.maxTokens ?? 4096,
      stream: true,
    }
    if (options.tools?.length) {
      body.tools = options.tools
      body.tool_choice = options.toolChoice || 'auto'
    }
    const response = await this._request('/chat/completions', body, { stream: true })
    if (!response.body) throw new DeepSeekError('流式响应没有 body')

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let content = ''
    let reasoning = ''
    const toolCalls = new Map()
    let usage = null
    let model = body.model

    const handle = (payload) => {
      if (payload === '[DONE]') return
      let data
      try {
        data = JSON.parse(payload)
      } catch {
        return
      }
      if (data.model) model = data.model
      if (data.usage) usage = data.usage
      const choice = data.choices?.[0]
      if (!choice) return
      const delta = choice.delta || {}
      if (delta.content) {
        content += delta.content
        onDelta({ content: delta.content })
      }
      if (delta.reasoning_content) {
        reasoning += delta.reasoning_content
        onDelta({ reasoning: delta.reasoning_content })
      }
      for (const call of delta.tool_calls || []) {
        const index = call.index ?? 0
        const slot = toolCalls.get(index) || { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (call.id) slot.id = call.id
        if (call.function?.name) slot.function.name += call.function.name
        if (call.function?.arguments) slot.function.arguments += call.function.arguments
        toolCalls.set(index, slot)
        onDelta({ toolCall: slot })
      }
    }

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        handle(trimmed.slice(5).trim())
      }
    }
    if (buffer.trim().startsWith('data:')) handle(buffer.trim().slice(5).trim())

    this._recordUsage(usage)
    const message = { role: 'assistant', content }
    if (reasoning) message.reasoning_content = reasoning
    if (toolCalls.size) message.tool_calls = [...toolCalls.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
    return { message, usage, model }
  }
}

/** 把工具定义从「名字+参数 schema+实现」转成 OpenAI 格式。 */
export function toToolSpec(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters || { type: 'object', properties: {}, additionalProperties: false },
    },
  }))
}
