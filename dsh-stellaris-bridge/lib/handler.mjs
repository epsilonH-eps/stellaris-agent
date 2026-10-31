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
import { randomUUID, createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'

export const version = '2.0.0'

const TEAM_PREFIX = [
  '你是 DSH 主会话。请使用 DSH 自己的子代理/委派机制来组织工作：',
  '需要并行或分工时，由你在 DSH 内部拉起子会话，不要依赖外部程序替你拆会话。',
  '最终只输出一个 ```json 代码块。',
  '',
].join('\n')

const DSH_MODEL = 'deepseek-flash' // DSH 里显示为 DeepSeek V4.1 Flash

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
  let mainWorkspace = null
  let workspaceRegistered = false
  let mainTitle = null
  let titleRenamed = false
  let lastWorkerError = null
  const workers = new Map()

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
    mainWorkspace,
    workspaceRegistered,
    mainTitle,
    titleRenamed,
    workers: [...workers.values()].map((entry) => ({ key: entry.key, sessionId: entry.sessionId })),
    workerCount: workers.size,
    lastWorkerError,
    hasDefaultModel: Boolean(defaultModelService()),
    lastMainError,
  })

  function roleOf(message) {
    return message?.role ?? message?.message?.role ?? null
  }

  function decodeToken(value) {
    if (!value) return null
    try {
      return Buffer.from(value, 'base64url').toString('utf8') || null
    } catch {
      return null
    }
  }

  async function renameMainTitle(agent, title) {
    try {
      const titleService = typeof ctx.get === 'function' ? ctx.get('sessionTitle') : null
      const session = agent?.session || agent?.handle?.session
      if (!titleService?.rename || !session || !title) return false
      await titleService.rename(session, title)
      titleRenamed = true
      return true
    } catch (error) {
      console.warn(`[stellaris-bridge] 设置会话标题失败：${String(error?.message || error)}`)
      return false
    }
  }

  /**
   * 主会话专用：在 DSH 里新建一个真正的 session，并复用同一个 Agent。
   * 这样主会话在 DSH 里是一条独立会话，而不是每次 run 都临时 spawn 一个一次性激活。
   */
  const ensureMainSession = async ({ sessionId = null, workspace = null, saveName = null, reasoningEffort = null } = {}) => {
    const desiredWorkspace = workspace || conversationCwd()
    const desiredTitle = saveName || '群星参谋 · 主会话'
    if (mainAgent && (!sessionId || mainSessionId === sessionId) && mainWorkspace === desiredWorkspace) {
      if (mainTitle !== desiredTitle) {
        await renameMainTitle(mainAgent, desiredTitle)
        mainTitle = desiredTitle
      }
      return { agent: mainAgent, sessionId: mainSessionId }
    }
    const desired = sessionId || `stellaris-main-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
    if (mainAgent && (mainSessionId !== desired || mainWorkspace !== desiredWorkspace)) {
      await disposeWorkers()
      try {
        await mainHandle?.dispose?.()
      } catch {
        /* 切存档/切工作区 */
      }
      mainHandle = null
      mainAgent = null
      mainSessionId = null
      mainCreatedAt = 0
    }
    if (typeof ctx.agents?.create !== 'function') throw new Error('DSH 没有 agents.create，无法新建主会话 session')
    mainSessionId = desired
    try {
      mkdirSync(desiredWorkspace, { recursive: true })
    } catch {
      /* 目录不可写时让 DSH 自己报错 */
    }
    // 把这个目录注册成 DSH 的独立 Workspace（有 workspaceRegistry 时）
    try {
      const registry = typeof ctx.get === 'function' ? ctx.get('workspaceRegistry') : null
      const project = await registry?.create?.(desiredWorkspace, '群星参谋')
      workspaceRegistered = Boolean(project)
    } catch {
      /* workspace 注册失败不影响 session 创建 */
    }
    let agentOptions = null
    // 主会话推理强度可选；模型路由跟随 DSH 默认选择。
    try {
      const selection = defaultModelService()?.currentSelection?.()
      if (selection?.provider && selection?.model) {
        agentOptions = { provider: selection.provider, model: DSH_MODEL }
        if (reasoningEffort) agentOptions.reasoningEffort = String(reasoningEffort)
        else if (selection.reasoningEffort) agentOptions.reasoningEffort = selection.reasoningEffort
      } else if (reasoningEffort) {
        agentOptions = { provider: 'deepseek-official', model: DSH_MODEL, reasoningEffort: String(reasoningEffort) }
      }
    } catch {
      agentOptions = reasoningEffort ? { reasoningEffort: String(reasoningEffort) } : null
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
    // 同一个存档已有 DSH session 时 resume；没有就按 saveKey 派生的 id 新建
    if (typeof ctx.agents?.resume === 'function') {
      try {
        mainHandle = await ctx.agents.resume({
          resumeSessionId: mainSessionId,
          ...(agentOptions ? { agentOptions } : {}),
        })
      } catch {
        mainHandle = null
      }
    }
    if (!mainHandle) {
      mainHandle = await ctx.agents.create({
        sessionId: mainSessionId,
        meta: { cwd: desiredWorkspace, title: desiredTitle },
        ...(agentOptions ? { agentOptions } : {}),
      })
    }
    mainAgent = mainHandle?.agent || mainHandle
    if (!mainAgent || typeof mainAgent.followup !== 'function') throw new Error('agents.create 没有返回可用的 Agent')
    mainCreatedAt = Date.now()
    mainWorkspace = desiredWorkspace
    mainTitle = desiredTitle
    titleRenamed = await renameMainTitle(mainAgent, desiredTitle)
    return { agent: mainAgent, sessionId: mainSessionId }
  }

  function messageText(message) {
    const content = message?.content ?? message?.message?.content
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
      .filter((block) => block && block.type === 'text')
      .map((block) => block.text || '')
      .join('')
  }

  async function followupInSession(agent, prompt, timeoutMs = 600000) {
    if (!agent || typeof agent.followup !== 'function') throw new Error('DSH Agent 不支持 followup')
    const before = (agent.session?.deriveMessages?.() || []).length
    await agent.followup({
      content: [{ type: 'text', text: String(prompt || '') }],
      source: { kind: 'user' },
    })
    if (typeof agent.whenIdle === 'function') {
      let timer = null
      await Promise.race([
        agent.whenIdle(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('DSH followup 超时')), Math.max(30000, Number(timeoutMs) || 600000))
        }),
      ]).finally(() => clearTimeout(timer))
    }
    const messages = agent.session?.deriveMessages?.() || []
    const fresh = messages.slice(before)
    const assistant = [...fresh].reverse().find((message) => message?.role === 'assistant' || message?.message?.role === 'assistant')
    const text = messageText(assistant)
    if (!text.trim()) throw new Error('DSH followup 没有返回 assistant 文本')
    return text
  }

  async function runActivation(prompt, { label = '群星参谋', parent = null, timeoutMs = 600000, childId = null, delivery = 'caller', keepActivation = false, reasoningEffort = null } = {}) {
    if (typeof ctx.subagents?.startActivation !== 'function') throw new Error('这台 DSH 没有 subagents 服务')
    const owner = parent || (await ensureParent())
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(30000, Number(timeoutMs) || 600000))
    let activation = null
    const startedAt = Date.now()
    try {
      activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: String(label).slice(0, 80),
        request: {
          prompt: [{ type: 'text', text: String(prompt || '') }],
          parent: owner,
          ...(reasoningEffort ? { agentOptions: {
            provider: mainRoute?.provider || 'deepseek-official',
            model: mainRoute?.model || DSH_MODEL,
            reasoningEffort: String(reasoningEffort),
          } } : {}),
        },
        ...(childId ? { childId } : {}),
        signal: controller.signal,
        delivery,
      })
      const result = await activation.result
      const output = Array.isArray(result?.output) ? result.output : []
      const text = output
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('')
      if (keepActivation) return { text, usage: result?.usage || null, ms: Date.now() - startedAt, childId: activation.childId || null, activation, keepActivation: true }
      return { text, usage: result?.usage || null, ms: Date.now() - startedAt, childId: activation.childId || null }
    } finally {
      clearTimeout(timer)
      if (!keepActivation) {
        try {
          await activation?.dispose?.()
        } catch {
          /* 已结束 */
        }
      }
    }
  }

  function workerSessionId(label) {
    return `stellaris-unit-${createHash('sha1').update(String(label || 'worker')).digest('hex').slice(0, 12)}`
  }

  function appendUser(agent, text) {
    if (!text || !agent?.session?.append) return
    try {
      agent.session.append('user/message', {
        content: [{ type: 'text', text: String(text) }],
        source: { kind: 'user' },
      }, { surfaceOp: 'append' })
    } catch {
      /* 会话只读时不阻塞返回 */
    }
  }

  function appendAssistant(agent, text) {
    if (!text || !agent?.session?.append) return
    try {
      agent.session.append('assistant/message', {
        turn: 0,
        step: 0,
        message: { role: 'assistant', content: [{ type: 'text', text: String(text) }] },
      }, { surfaceOp: 'append' })
    } catch {
      /* 会话只读时不阻塞返回 */
    }
  }

  async function ensureWorkerSession(label) {
    const key = String(label || 'worker')
    const workspace = mainWorkspace || conversationCwd()
    const cached = workers.get(key)
    if (cached?.agent && cached.workspace === workspace) return cached
    if (cached) {
      try {
        await cached.handle?.dispose?.()
      } catch {
        /* 旧 worker */
      }
      workers.delete(key)
    }
    const sessionId = workerSessionId(key)
    let handle = null
    if (typeof ctx.agents?.resume === 'function') {
      try {
        handle = await ctx.agents.resume({ resumeSessionId: sessionId })
      } catch {
        handle = null
      }
    }
    if (!handle) {
      if (typeof ctx.agents?.create !== 'function') throw new Error('DSH 没有 agents.create，无法创建 worker session')
      try {
        mkdirSync(workspace, { recursive: true })
      } catch {
        /* ignore */
      }
      // 对象子会话挂到当前 DSH 主会话下面，而不是新建一棵根会话树。
      const parentAgent = mainAgent || null
      const childOptions = {
        ...(mainRoute?.provider ? { provider: mainRoute.provider } : {}),
        model: mainRoute?.model || DSH_MODEL,
        reasoningEffort: 'off',
      }
      handle = await ctx.agents.create({
        sessionId,
        ...(parentAgent ? { parentAgent } : {}),
        ...(childOptions ? { agentOptions: childOptions } : {}),
        meta: { cwd: workspace, title: key },
      })
    }
    const agent = handle?.agent || handle
    if (!agent || typeof agent.followup !== 'function') throw new Error('worker session 没有返回可用的 Agent')
    const entry = { key, sessionId, workspace, handle, agent }
    workers.set(key, entry)
    await renameMainTitle(agent, key)
    return entry
  }

  async function disposeWorkers() {
    for (const entry of workers.values()) {
      try {
        await entry.handle?.dispose?.()
      } catch {
        /* ignore */
      }
    }
    workers.clear()
  }

  async function sendToWorker(worker, prompt, timeoutMs = 600000) {
    if (typeof ctx.subagents?.sendMessage !== 'function') throw new Error('DSH 没有 sendMessage')
    const sender = await ensureParent()
    const child = ctx.agents?.get?.(worker.sessionId) || (await ctx.agents.resume({ resumeSessionId: worker.sessionId }))?.agent
    if (!child) throw new Error('worker session 不是 live 状态')
    const before = (child.session?.deriveMessages?.() || []).length
    await ctx.subagents.sendMessage(sender, worker.sessionId, [{ type: 'text', text: String(prompt || '') }], {
      signal: AbortSignal.timeout(Math.max(30000, Number(timeoutMs) || 600000)),
    })
    await child.whenIdle?.()
    const messages = child.session?.deriveMessages?.() || []
    const assistant = [...messages.slice(before)].reverse().find((message) => message?.role === 'assistant')
    const text = messageText(assistant)
    if (!text.trim()) throw new Error('worker session 没有返回 assistant 文本')
    return text
  }

  const runMainSession = async (prompt, { timeoutMs = 600000, sessionId = null, workspace = null, saveName = null, reasoningEffort = null } = {}) => {
    const { agent } = await ensureMainSession({ sessionId, workspace, saveName, reasoningEffort })
    const startedAt = Date.now()
    // activation 的 assistant 文本同时写回主会话日志，保证 DSH 主会话里能看到完整对话。
    appendUser(agent, prompt)
    const result = await runActivation(prompt, { label: '群星参谋主会话', parent: agent, timeoutMs, delivery: 'parent', reasoningEffort })
    appendAssistant(agent, result.text)
    return { ...result, ms: Date.now() - startedAt, sessionId: mainSessionId, session: true, reused: true }
  }

  /**
   * @param {string} prompt
   * @param {{label?:string, timeoutMs?:number, team?:boolean}} [options]
   */
  const run = async (prompt, { label = '群星参谋', timeoutMs = 600000, team = false, sessionId = null, saveKey = null, workspace = null, saveName = null, reasoningEffort = null } = {}) => {
    const rawLabel = String(label || '')
    const mainMatch = /^main[:|]([A-Za-z0-9._-]+)(?:#([^#]*))?(?:#([^#]*))?(?:#([^#]*))?$/.exec(rawLabel)
    const labeledSession = mainMatch?.[1] || null
    const labeledWorkspace = decodeToken(mainMatch?.[2])
    const labeledSaveName = decodeToken(mainMatch?.[3])
    const labeledEffort = decodeToken(mainMatch?.[4])
    const isMain = rawLabel === 'main' || Boolean(labeledSession) || /主会话/.test(rawLabel)
    if (isMain) {
      try {
        return await runMainSession(prompt, {
          timeoutMs,
          sessionId: sessionId || labeledSession,
          workspace: workspace || labeledWorkspace,
          saveName: saveName || labeledSaveName,
          reasoningEffort: reasoningEffort || labeledEffort,
        })
      } catch (error) {
        lastMainError = String(error?.message || error)
        console.warn(`[stellaris-bridge] 主会话 session 失败，回退到一次性激活：${lastMainError}`)
      }
    }
    if (typeof ctx.subagents?.startActivation !== 'function') {
      throw new Error('这台 DSH 没有 subagents 服务')
    }
    const text = String(prompt || '')
    const finalPrompt = team ? TEAM_PREFIX + text : text
    const startedAt = Date.now()
    // 对象子会话：每个单位/事件一个固定的 worker session，后续复用，
    // 不再每次 run 都 spawn 一个新的子会话。
    let worker = null
    const remembered = workers.get(label)
    if (remembered?.sessionId) {
      try {
        const body = await sendToWorker(remembered, finalPrompt, timeoutMs)
        return {
          text: body,
          usage: null,
          ms: Date.now() - startedAt,
          team,
          label,
          sessionId: remembered.sessionId,
          session: true,
          reused: true,
        }
      } catch (error) {
        lastWorkerError = String(error?.message || error)
        try {
          await remembered.activation?.dispose?.()
        } catch {
          /* ignore */
        }
        workers.delete(label)
      }
    }
    try {
      const result = await runActivation(finalPrompt, {
        label,
        parent: await ensureParent(),
        timeoutMs,
        keepActivation: true,
        reasoningEffort: 'off',
      })
      if (result.childId) workers.set(label, { key: label, sessionId: result.childId, activation: result.activation })
      return {
        ...result,
        team,
        label,
        sessionId: result.childId || null,
        session: true,
        reused: false,
      }
    } catch (error) {
      lastWorkerError = String(error?.message || error)
      console.warn(`[stellaris-bridge] worker activation 失败，回退当前会话：${lastWorkerError}`)
    }
    const owner = await ensureParent()
    const result = await runActivation(finalPrompt, { label, parent: owner, timeoutMs, reasoningEffort: 'off' })
    return { ...result, team, label, sessionId: result.childId || null, fallback: 'activation' }
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
      disposeWorkers().catch(() => {})
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
