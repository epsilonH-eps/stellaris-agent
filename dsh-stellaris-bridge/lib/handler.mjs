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

  const health = async () => ({
    ok: typeof ctx.subagents?.startActivation === 'function',
    service: 'dsh-stellaris-bridge',
    handler: 'lib/handler.mjs',
    hasParent: Boolean(parent),
  })

  /**
   * @param {string} prompt
   * @param {{label?:string, timeoutMs?:number, team?:boolean}} [options]
   */
  const run = async (prompt, { label = '群星参谋', timeoutMs = 600000, team = false } = {}) => {
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
    dispose() {
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
