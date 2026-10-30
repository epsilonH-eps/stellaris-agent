/**
 * 后端选择：把「DeepSeek API Key」与「DSH 插件」收敛到同一个接口。
 *
 *   createBackend({config}) -> {name, available, describe(), health(), complete({system,messages})}
 *
 * 两种后端都只输出文本；结构化协议在 ai/protocol.mjs 里解析。
 * 这样主会话/子会话的代码完全不需要知道"是谁在思考"。
 *
 * @module stellaris-agent/ai/backend
 */
import { backendOf } from '../config.mjs'
import { DeepSeekBackend } from './deepseek.mjs'
import { DshBackend, discoverDsh } from './dsh.mjs'

export { DeepSeekBackend, DshBackend, discoverDsh }

export function createBackend({ config, log = () => {}, fetchImpl = null } = {}) {
  const kind = backendOf(config)
  return kind === 'dsh' ? new DshBackend({ config, log, fetchImpl }) : new DeepSeekBackend({ config, log, fetchImpl })
}

/**
 * 启动时确认后端可用；不可用时给出**可操作**的原因，而不是一个布尔。
 */
export async function checkBackend(backend) {
  if (!backend) return { ok: false, error: 'NO_BACKEND' }
  if (backend.name === 'deepseek') {
    if (!backend.available) {
      return { ok: false, error: 'MISSING_API_KEY', hint: '在设置页填 DeepSeek API Key，或把 ai.backend 改成 dsh' }
    }
    return { ok: true, ...backend.describe() }
  }
  const health = await backend.health()
  if (health.ok) {
    return {
      ok: true,
      ...backend.describe(),
      service: health.service || null,
      hasSubagents: Boolean(health.hasSubagents),
      url: health.url || backend.baseUrl,
    }
  }
  return {
    ok: false,
    error: 'DSH_UNAVAILABLE',
    hint: '确认 DSH 正在运行且已加载 dsh-stellaris-bridge 插件（设置页可"安装/更新插件"并"重载"）',
    detail: health.error || health,
    url: backend.baseUrl || null,
  }
}
