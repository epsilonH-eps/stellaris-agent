/**
 * dsh-stellaris-bridge
 *
 * 给「群星参谋」程序提供一个 DSH 侧编排后端：
 *   POST /api/stellaris-orchestrator/run
 *     { prompt, label?, timeoutMs? }
 *     → ctx.subagents.startActivation({ provider: 'spawn', ... })
 *     → 等 run.result，把文本返回
 *
 * 这样程序可以把主会话/组件子会话切换成 DSH 的 agent 结构，
 * 本地编排（lib/swarm.mjs）保持不变，只换“谁来思考”。
 *
 * 路由只绑本机；DSH 的 webServer 本身负责监听地址。
 */
import { randomUUID } from 'node:crypto'

export const name = 'dsh-stellaris-bridge'

export const inject = ['webServer', 'subagents', 'agents']

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readBody(req, limit = 2 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

export function apply(ctx) {
  let parent = null
  let owned = null

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
      if (typeof ctx.agents?.create !== 'function') {
        throw new Error('没有可用的 DSH 会话，也没有 agents.create')
      }
      const handle = await ctx.agents.create({
        sessionId: 'stellaris-bridge-' + randomUUID(),
        meta: { cwd: process.cwd() },
      })
      owned = handle
      parent = handle?.agent || null
    }
    if (!parent) throw new Error('没有可用的 DSH 父会话')
    return parent
  }

  const run = async (prompt, { label = '群星参谋', timeoutMs = 600000 } = {}) => {
    if (typeof ctx.subagents?.startActivation !== 'function') {
      throw new Error('这台 DSH 没有 subagents 服务')
    }
    const owner = await ensureParent()
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), Math.max(30_000, Number(timeoutMs) || 600000))
    let activation = null
    try {
      activation = await ctx.subagents.startActivation({
        provider: 'spawn',
        label: String(label).slice(0, 80),
        request: {
          prompt: [{ type: 'text', text: String(prompt || '') }],
          parent: owner,
        },
        signal: controller.signal,
        delivery: 'caller',
      })
      const result = await activation.result
      const text = (result?.output || [])
        .filter((block) => block && block.type === 'text')
        .map((block) => block.text)
        .join('')
      return { text, usage: result?.usage || null }
    } finally {
      clearTimeout(timer)
      try {
        await activation?.dispose?.()
      } catch {
        /* 已经结束 */
      }
    }
  }

  const handler = async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1')
      const remote = req.socket?.remoteAddress || ''
      if (remote && !/^(127\.|::1|::ffff:127\.)/.test(remote)) {
        return sendJson(res, 403, { ok: false, error: 'localhost only' })
      }

      if (req.method === 'GET' && /\/health\/?$/.test(url.pathname)) {
        return sendJson(res, 200, {
          ok: true,
          service: name,
          hasSubagents: typeof ctx.subagents?.startActivation === 'function',
          hasParent: Boolean(parent),
        })
      }

      if (req.method === 'POST' && /\/(run|team)\/?$/.test(url.pathname)) {
        const isTeam = /\/team\/?$/.test(url.pathname)
        const body = await readBody(req)
        if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
          return sendJson(res, 400, { ok: false, error: 'expected { prompt }' })
        }
        const prompt = isTeam
          ? '你是 DSH 主会话。请使用 DSH 自己的子代理/委派机制来组织工作：需要并行或分工时，由你在 DSH 内部拉起子会话，不要依赖外部程序替你拆会话。最终只输出一个 \`\`\`stellaris-native JSON 数组。\n\n' + body.prompt
          : body.prompt
        const result = await run(prompt, {
          label: body.label || (isTeam ? '群星-DSH团队' : '群星参谋'),
          timeoutMs: body.timeoutMs,
        })
        return sendJson(res, 200, { ok: true, ...result })
      }

      return sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      return sendJson(res, 500, { ok: false, error: String(error?.message || error) })
    }
  }

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: '/api/stellaris-orchestrator',
        handler,
      }),
    'stellaris-bridge: /api/stellaris-orchestrator',
  )

  ctx.effect(
    () => () => {
      try {
        owned?.dispose?.()
      } catch {
        /* 收摊 */
      }
    },
    'stellaris-bridge: dispose parent',
  )
}
