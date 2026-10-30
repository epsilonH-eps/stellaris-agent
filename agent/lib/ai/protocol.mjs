/**
 * 决策协议：把模型回复解析成结构化的"指令"。
 *
 * 解析必须**永不抛异常**：模型写歪一格不该让整轮崩掉。
 * 解析失败会把错误交回调用方，由调用方把错误喂回模型重写。
 *
 * @module stellaris-agent/ai/protocol
 */

/** 从文本里取第一个 ```json 块；没有就退化成第一个配平的 `{...}`。 */
export function extractJsonBlock(text) {
  const source = String(text ?? '')
  const fence = /```(?:json)?\s*\n([\s\S]*?)```/i.exec(source)
  const candidates = []
  if (fence) candidates.push(fence[1])
  const trimmed = source.trim()
  if (trimmed.startsWith('{')) candidates.push(trimmed)
  const start = source.indexOf('{')
  if (start >= 0) {
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < source.length; i += 1) {
      const ch = source[i]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === '{') depth += 1
      else if (ch === '}') {
        depth -= 1
        if (depth === 0) {
          candidates.push(source.slice(start, i + 1))
          break
        }
      }
    }
  }
  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate), raw: candidate }
    } catch {
      /* 试下一个 */
    }
  }
  return { ok: false, value: null, error: '回复里没有可解析的 JSON 块' }
}

function asString(value, fallback = '') {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)
}

/**
 * 主会话决策。
 * @returns {{ok:boolean, value:object|null, error:string|null}}
 */
export function parseMainDecision(text) {
  const parsed = extractJsonBlock(text)
  if (!parsed.ok) return { ok: false, value: null, error: parsed.error }
  const raw = parsed.value && typeof parsed.value === 'object' ? parsed.value : {}
  const spawn = Array.isArray(raw.spawn)
    ? raw.spawn
        .map((row) => {
          if (typeof row === 'string') return { unit: row, goal: '' }
          if (!row || typeof row !== 'object') return null
          const unit = asString(row.unit || row.id || row.unitId).trim()
          if (!unit) return null
          return { unit, goal: asString(row.goal || row.objective || row.task).slice(0, 1200) }
        })
        .filter(Boolean)
    : []
  const intervals = {}
  if (raw.intervals && typeof raw.intervals === 'object') {
    for (const [unit, seconds] of Object.entries(raw.intervals)) {
      const value = Number(seconds)
      if (Number.isFinite(value) && value >= 5) intervals[unit] = value
    }
  }
  return {
    ok: true,
    error: null,
    value: {
      say: asString(raw.say || raw.message || raw.reply).trim(),
      report: asString(raw.report || raw.analysis).trim(),
      pause: raw.pause === true,
      resume: raw.resume === true,
      spawn,
      intervals,
    },
  }
}

/**
 * 子会话（单位/事件）决策。
 * `actions` 只做形状检查；语义校验在 session 里用 actions.validateActions 做。
 */
export function parseUnitDecision(text) {
  const parsed = extractJsonBlock(text)
  if (!parsed.ok) return { ok: false, value: null, error: parsed.error }
  const raw = parsed.value && typeof parsed.value === 'object' ? parsed.value : {}
  const actions = Array.isArray(raw.actions)
    ? raw.actions
        .map((row) => {
          if (!row || typeof row !== 'object') return null
          const method = asString(row.method || row.action || row.verb).trim()
          if (!method) return null
          const params = row.params && typeof row.params === 'object' ? row.params : {}
          return { method, params }
        })
        .filter(Boolean)
    : []
  const status = ['ok', 'blocked', 'continue', 'idle'].includes(String(raw.status))
    ? String(raw.status)
    : actions.length
      ? 'continue'
      : 'ok'
  return {
    ok: true,
    error: null,
    value: {
      say: asString(raw.say || raw.message).trim(),
      done: raw.done !== false,
      status,
      cause: asString(raw.cause || raw.reason).trim(),
      suggestion: asString(raw.suggestion || raw.next).trim(),
      evidence: asString(raw.evidence).trim(),
      actions,
    },
  }
}

/** 失败分析结果。 */
export function parseAnalysis(text) {
  const parsed = extractJsonBlock(text)
  if (!parsed.ok) return { ok: false, value: null, error: parsed.error }
  const raw = parsed.value && typeof parsed.value === 'object' ? parsed.value : {}
  return {
    ok: true,
    value: {
      cause: asString(raw.cause || raw.reason).trim(),
      evidence: asString(raw.evidence).trim(),
      suggestion: asString(raw.suggestion || raw.next).trim(),
      retry: Array.isArray(raw.retry) ? raw.retry.filter((row) => row && typeof row === 'object' && row.method) : [],
    },
  }
}
