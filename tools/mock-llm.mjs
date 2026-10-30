/**
 * 假大模型（开发/自测用，**不联网**）。
 *
 *   node tools/mock-llm.mjs [port]
 *
 * 实现 OpenAI 兼容的 POST /chat/completions，根据 system prompt 判断
 * 这是主会话 / 单位子会话 / 特殊事件，返回固定但合法的 JSON 决策。
 * 用来在没有 API Key、没有 DSH 的情况下跑通决策与执行链路。
 */
import { createServer } from 'node:http'

const port = Number(process.argv[2] || 9911)
const failUnit = process.env.MOCK_UNIT_FAIL === '1'

function decide(system, userText) {
  if (/特殊事件处理会话/.test(system)) {
    return { say: '处理测试事件', actions: [{ method: 'resolve_event', params: { window_id: 5, option_index: 0 } }], status: 'continue' }
  }
  if (/1:1 操作员子会话/.test(system)) {
    if (/失败分析/.test(userText)) {
      return { cause: '测试失败：动作校验不通过', evidence: '模型给了不存在的动作名', suggestion: '检查 tech_key / 动作名后重试' }
    }
    if (/执行器结果：成功/.test(userText)) return { say: '已按计划完成', actions: [], status: 'ok' }
    if (failUnit) {
      return { say: '故意失败', actions: [{ method: 'definitely_not_an_action', params: {} }], status: 'continue' }
    }
    return { say: '切换物理研究', actions: [{ method: 'select_research', params: { slot: 'physics', tech_key: 'tech_lasers_1' } }], status: 'continue' }
  }
  if (/总指挥/.test(system)) {
    // 主会话：已经有人回报成功时不再重复派发，避免测试里死循环
    if (/"status"\s*:\s*"ok"/.test(userText)) return { say: '收到，继续观察', spawn: [] }
    return { say: '测试接管：先把物理研究切到激光', spawn: [{ unit: 'research', goal: '把物理研究切换到 tech_lasers_1' }] }
  }
  return { say: '无需操作', actions: [], status: 'ok' }
}

const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url?.startsWith('/chat/completions')) {
    res.writeHead(404, { 'content-type': 'application/json' })
    return res.end('{"error":"not found"}')
  }
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  let body = {}
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    res.writeHead(400)
    return res.end('{"error":"bad json"}')
  }
  const messages = Array.isArray(body.messages) ? body.messages : []
  const system = String(messages.find((message) => message.role === 'system')?.content || '')
  const userText = messages
    .filter((message) => message.role === 'user')
    .map((message) => String(message.content || ''))
    .join('\n')
  const reply = decide(system, userText)
  const role = /特殊事件/.test(system) ? 'event' : /1:1 操作员子会话/.test(system) ? 'unit' : /总指挥/.test(system) ? 'main' : 'other'
  console.log(`[llm] ${role} -> ${reply.actions?.[0]?.method || reply.spawn?.[0]?.unit || reply.status}`)
  const payload = {
    id: 'mock-' + Date.now().toString(36),
    object: 'chat.completion',
    model: body.model || 'mock',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: '```json\n' + JSON.stringify(reply) + '\n```' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify(payload))
})

server.listen(port, '127.0.0.1', () => console.log(`[mock-llm] listening http://127.0.0.1:${port}`))
