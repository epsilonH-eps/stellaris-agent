/**
 * 编排器：一轮「看 → 想 → 做 → 记账」。
 *
 * 支持两种模型行为：
 *   1. function calling（deepseek-chat）：模型调工具，工具结果以 role=tool 回去；
 *   2. 纯文本 + ```stellaris 块：没工具时解析块并执行。
 *
 * 操作员（operator）是**另一个 AgentSession**：主会话把目标扔过去，它只做最小
 * 必要动作，返回摘要。这样主会话的上下文里不会出现一堆 ACK 细节。
 *
 * @module stellaris-agent/orchestrator
 */
import { extractActions } from '../../engine/lib/dsl.js'
import { toToolSpec } from './deepseek.mjs'
import { createTools } from './tools.mjs'
import { AgentSession, SessionPool } from './session.mjs'
import { systemPrompt } from './prompt.mjs'

function parseArgs(raw) {
  if (!raw) return {}
  if (typeof raw === 'object') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export class Orchestrator {
  /**
   * @param {object} deps {client, engine, config, log, bus, sessions}
   */
  constructor({ client, engine, config, log = () => {}, bus = null, sessions = new SessionPool() }) {
    this.client = client
    this.engine = engine
    this.config = config
    this.log = log
    this.bus = bus
    this.sessions = sessions
    this.lastUsage = null
  }

  _session(label, role, system) {
    const session = this.sessions.get(label)
    if (!session.system) session.system = system
    if (role === 'operator' && !session.operator) session.operator = true
    return session
  }

  /**
   * 跑一轮。
   * @param {object} params
   * @param {string} params.goal 玩家/主会话给的目标
   * @param {string} [params.label] 会话名（main / operator / worker-x）
   * @param {'main'|'operator'} [params.role]
   * @param {boolean} [params.allowWrite] 允许写游戏
   * @param {boolean} [params.useTools]
   * @param {number} [params.maxSteps]
   * @param {(chunk:{type:string, text?:string, name?:string}) => void} [params.onEvent]
   */
  async run({
    goal,
    label = 'main',
    role = 'main',
    allowWrite = true,
    useTools = this.config.deepseek?.useTools !== false,
    maxSteps = this.config.deepseek?.maxSteps ?? 8,
    onEvent = () => {},
  }) {
    const config = this.config
    const session = this._session(label, role, systemPrompt({ mode: role }))
    session.pushUser(goal)

    const tools = createTools({
      engine: this.engine,
      bus: this.bus,
      allowDelegate: role === 'main' && config.operator?.enabled !== false,
      allowWrite,
      delegate: role === 'main'
        ? (subGoal) => this.run({
          goal: subGoal,
          label: 'operator',
          role: 'operator',
          allowWrite,
          maxSteps: config.operator?.maxSteps ?? 4,
          onEvent,
        })
        : null,
    })
    const specs = useTools ? toToolSpec(tools) : []
    const byName = new Map(tools.map((tool) => [tool.name, tool]))
    const model = role === 'operator' && config.operator?.model ? config.operator.model : config.deepseek?.model

    const texts = []
    const applied = []
    let finished = false
    let finishSummary = ''
    let steps = 0
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 }

    for (; steps < maxSteps; steps += 1) {
      let result
      try {
        result = await this.client.chat(session.messages(), {
          tools: specs,
          model,
          temperature: config.deepseek?.temperature ?? 0.4,
          maxTokens: config.deepseek?.maxTokens ?? 4096,
        })
      } catch (error) {
        onEvent({ type: 'error', text: String(error?.message || error) })
        return { ok: false, error: String(error?.message || error), steps, text: texts.join('\n'), applied }
      }
      const message = result.message || {}
      usage.promptTokens += Number(result.usage?.prompt_tokens || 0)
      usage.completionTokens += Number(result.usage?.completion_tokens || 0)
      usage.totalTokens += Number(result.usage?.total_tokens || 0)

      const content = String(message.content || '')
      const calls = Array.isArray(message.tool_calls) ? message.tool_calls : []
      session.push({
        role: 'assistant',
        content,
        ...(calls.length ? { tool_calls: calls } : {}),
      })
      if (content.trim()) {
        texts.push(content.trim())
        onEvent({ type: 'text', text: content.trim() })
      }

      if (calls.length) {
        for (const call of calls) {
          const name = call.function?.name || ''
          const args = parseArgs(call.function?.arguments)
          const tool = byName.get(name)
          onEvent({ type: 'tool', name })
          let payload
          if (!tool) {
            payload = { error: `没有这个工具：${name}` }
          } else if (!allowWrite && (name === 'apply_actions' || name === 'clone_design' || name === 'native_act')) {
            payload = { error: '当前是只读模式，不能执行写操作' }
          } else {
            try {
              payload = await tool.run(args)
            } catch (error) {
              payload = { error: String(error?.message || error) }
            }
          }
          if (name === 'finish') {
            finished = true
            finishSummary = payload?.summary || ''
          }
          if (name === 'apply_actions' && payload?.summary) applied.push(payload.summary)
          session.push({
            role: 'tool',
            tool_call_id: call.id || `call_${steps}`,
            content: JSON.stringify(payload ?? {}).slice(0, 12000),
          })
        }
        if (finished) break
        continue
      }

      // 没有工具调用：允许模型用 ```stellaris 块直接下动作
      const parsed = extractActions(content)
      if (allowWrite && parsed.actions.length) {
        const outcome = await this.engine.apply(parsed.actions)
        applied.push(outcome.summary || outcome.error || '')
        session.push({
          role: 'user',
          content: `[系统] 上一轮动作执行结果：${JSON.stringify({
            ok: outcome.ok,
            summary: outcome.summary,
            errors: outcome.errors || outcome.compileErrors,
          }).slice(0, 4000)}`,
        })
        onEvent({ type: 'actions', text: outcome.summary || '' })
        continue
      }
      break
    }

    const text = texts.join('\n\n')
    const summary = finishSummary || text.split('\n').slice(-3).join('\n')
    if (config.journal?.enabled !== false && applied.length) {
      try {
        this.engine.journalWrite(`本轮：${goal.slice(0, 120)} → ${applied.join('；').slice(0, 400)}`, 'turn')
      } catch {
        /* 日志失败不影响主流程 */
      }
    }
    this.lastUsage = usage
    return {
      ok: true,
      finished,
      summary,
      text,
      steps: steps + 1,
      applied,
      usage,
      session: session.summary(),
    }
  }
}

export { AgentSession, SessionPool }
