/**
 * 插件真正的逻辑（**改这里不用重启 DSH**，POST /reload 即生效）。
 *
 * 职责只有一个：把一段 prompt 交给 DSH 自己 spawn 一个激活，拿回文本。
 * 不解析游戏数据、不做动作校验——那些在 stellaris-agent 主程序里。
 *
 * `/team` 只是在 prompt 前加一段"用 DSH 自己的子代理机制组织工作"的要求。
 *
 * @module dsh-stellaris-bridge/handler
 */
import { randomUUID } from 'node:crypto'

export const version = '2.0.0'

const TEAM_PREFIX = [
  '你是 DSH 主会话。请使用 DSH 自己的子代理/委派机制来组织工作：',
  '需要并行或分工时，由你在 DSH 内部拉起子会话，不要依赖外部程序替你拆会话。',
  '最终只输出一个 ```json 代码块。',
  '',
].join('\n')

function conversationCwd() {
  return process.env.STELLARIS_DSH_CWD || process.cwd()
}

export async function createHandler(ctx) {
  let parent = null
  let owned = null
  let mainHandle = null
  let mainAgent = null
  let mainSessionId = null
  let mainCreatedAt = 0
  let lastMainError = null
  let mainRoute = null

  const ensureParent = async () => {
    if (parent) return parent
    try {
      parent = ctx.agents?.currentInitiator?.() || null
    } catch {
      parent = null
    }
    if (!parent) {
      try {
        parent = (ctx.agents?.list?.() || [])[0] || null
      } catch {
        parent = null
      }
    }
    if (!parent) {
      if (typeof ctx.agents?.create !== 'function') throw new Error('没有可用的 DSH 会话，也没有 agents.create')
      const handle = await ctx.agents.create({
        sessionId: 'stellaris-bridge-' + randomUUID(),
        meta: { cwd: conversationCwd() },
      })
      owned = handle
      parent = handle?.agent || null
    }
    if (!parent) throw new Error('没有可用的 DSH 父会话')
    return parent
  }

  function defaultModelService() {
    try {
      return typeof ctx.get === 'function' ? ctx.get('agentDefaultModel') : null
    } catch {
      return null
    }
  }

  const health = async () => ({
    ok: typeof ctx.subagents?.startActivation === 'function',
    service: 'dsh-stellaris-bridge',
    handler: 'lib/handler.mjs',
    hasParent: Boolean(parent),
    mainSessionId,
    mainSessionReady: Boolean(mainAgent),
    mainSessionCreatedAt: mainCreatedAt || null,
    mainSessionStatus: mainAgent?.status || null,
    mainSessionMessages: mainAgent?.session?.deriveMessages?.().length || 0,
    mainSessionRoles: mainAgent?.session?.deriveMessages?.().map((message) => roleOf(message)) || [],
    mainRoute,
    hasDefaultModel: Boolean(defaultModelService()),
    lastMainError,
  })

  function roleOf(message) {
    return message?.role ?? message?.message?.role ?? null
  }

  /**
   * 主会话专用：在 DSH 里新建一个真正的 session，并复用同一个 Agent。
   * 这样主会话在 DSH 里是一条独立会话，而不是每次 run 都临时 spawn 一个一次性激活。
   */
  const ensureMainSession = async () => {
    if (mainAgent) return { agent: mainAgent, sessionId: mainSessionId }
    if (typeof ctx.agents?.create !== 'function') throw new Error('DSH 没有 agents.create，无法新建主会话 session')
    mainSessionId = `stellaris-main-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    let agentOptions = null
    try {
      const selection = defaultModelService()?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        agentOptions = { provider: selection.provider, model: selection.model }
        if (selection.reasoningEffort) agentOptions.reasoningEffort = selection.reasoningEffort
      }
    } catch {
      agentOptions = null
    }
    if (!agentOptions) {
      try {
        const owner = ctx.agents?.currentInitiator?.() || (ctx.agents?.list?.() || [])[0] || null
        const route = owner?.session?.requestHeader?.()?.config
        if (route?.provider && route?.model) {
          agentOptions = { provider: route.provider, model: route.model }
          if (route.reasoningEffort) agentOptions.reasoningEffort = route.reasoningEffort
        }
      } catch {
        agentOptions = null
      }
    }
    mainRoute = agentOptions
    mainHandle = await ctx.agents.create({
      sessionId: mainSessionId,
      meta: { cwd: conversationCwd(), title: '群星参谋 · 主会话' },
      ...(agentOptions ? { agentOptions } : {}),
    })
    mainAgent = mainHandle?.agent || mainHandle
    if (!mainAgent || typeof mainAgent.followup !== 'function') throw new Error('agents.create 没有返回可用的 Agent')
    mainCreatedAt = Date.now()
    try {
      const session = mainAgent.session
      session?.append?.('plugin:stellaris/main-session', {
        sessionId: mainSessionId,
        label: '群星参谋主会话',
        createdAt: mainCreatedAt,
      })
    } catch {
      /* 只是标记，失败不影响 */
    }
    return { agent: mainAgent, sessionId: mainSessionId }
  }

  const runMainSession = async (prompt, { timeoutMs = 600000 } = {}) => {
    const { agent } = await ensureMainSession()
    if (typeof ctx.subagents?.startActivation !== 'function') throw new Error('这台 DSH 没有 subagents 服务')
    const startedAt = Date.now()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(30000, Number(timeoutMs) || 600000))
    let activation = null
    try {
      activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: '群星主会话',
        request: {
          prompt: [{ type: 'text', text: String(prompt || '') }],
          parent: agent,
        },
        signal: controller.signal,
        delivery: 'caller',
      })
      const result = await activation.result
      const output = Array.isArray(result?.output) ? result.output : []
      const text = output
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('')
      return {
        text,
        usage: result?.usage || null,
        ms: Date.now() - startedAt,
        sessionId: mainSessionId,
        session: true,
      }
    } finally {
      clearTimeout(timer)
      try {
        await activation?.dispose?.()
      } catch {
        /* 已结束 */
      }
    }
  }

  /**
   * @param {string} prompt
   * @param {{label?:string, timeoutMs?:number, team?:boolean}} [options]
   */
  const run = async (prompt, { label = '群星参谋', timeoutMs = 600000, team = false } = {}) => {
    // 主会话：在 DSH 里新建并复用一个真正的 session（它自己就是一个 Agent）
    if (label === 'main' || /主会话/.test(String(label))) {
      try {
        return await runMainSession(prompt, { timeoutMs })
      } catch (error) {
        lastMainError = String(error?.message || error)
        console.warn(`[stellaris-bridge] 主会话 session 失败，回退到一次性激活：${lastMainError}`)
      }
    }
    if (typeof ctx.subagents?.startActivation !== 'function') {
      throw new Error('这台 DSH 没有 subagents 服务')
    }
    const owner = await ensureParent()
    const text = String(prompt || '')
    const finalPrompt = team ? TEAM_PREFIX + text : text
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(30000, Number(timeoutMs) || 600000))
    let activation = null
    const startedAt = Date.now()
    try {
      activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: String(label).slice(0, 80),
        request: {
          prompt: [{ type: 'text', text: finalPrompt }],
          parent: owner,
        },
        signal: controller.signal,
        delivery: 'caller',
      })
      const result = await activation.result
      const output = Array.isArray(result?.output) ? result.output : []
      const body = output
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('')
      return {
        text: body,
        usage: result?.usage || null,
        ms: Date.now() - startedAt,
        team,
        label,
      }
    } finally {
      clearTimeout(timer)
      try {
        await activation?.dispose?.()
      } catch {
        /* 已结束 */
      }
    }
  }

  return {
    version,
    health,
    run,
    session: () => ({
      sessionId: mainSessionId,
      ready: Boolean(mainAgent),
      createdAt: mainCreatedAt || null,
      label: '群星参谋主会话',
    }),
    dispose() {
      try {
        mainHandle?.dispose?.()
      } catch {
        /* 收摊 */
      }
      mainHandle = null
      mainAgent = null
      mainSessionId = null
      mainCreatedAt = 0
      try {
        owned?.dispose?.()
      } catch {
        /* 收摊 */
      }
      owned = null
      parent = null
    },
  }
}
