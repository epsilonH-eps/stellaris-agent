/**
 * 动作 DSL 解析：把模型回复里的 ```stellaris 块变成动作数组。
 *
 * 支持三种写法（协议 §4）：
 *   1. JSON：            [ { "resource": { "key": "alloys", "amount": 500 } } ]
 *   2. YAML 行内：       - resource: { key: alloys, amount: 500 }
 *   3. YAML 块：         - add_building:
 *                            planet: 地球
 *                            building: building_alloy_foundry
 *
 * 解析器刻意「宽进严出」：格式错的地方收集成 errors 返回，不抛异常——
 * 模型写歪一格不应该让整轮崩掉，桥可以把 errors 原样回给模型让它重写。
 *
 * @module dsh-stellaris-bridge/dsl
 */

const FENCE = /```(stellaris(?:-plan|-actions)?)\s*\n([\s\S]*?)```/gi

export const FENCE_LANGS = ['stellaris', 'stellaris-plan', 'stellaris-actions']

/** 扫出所有围栏块。 */
export function extractBlocks(text) {
  const blocks = []
  const source = String(text ?? '')
  FENCE.lastIndex = 0
  let match
  while ((match = FENCE.exec(source)) !== null) {
    blocks.push({ lang: match[1].toLowerCase(), body: match[2], index: match.index })
  }
  return blocks
}

function stripComment(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) return line.slice(0, i)
  }
  return line
}

/** 按分隔符切，但尊重引号与花括号/方括号嵌套。 */
export function splitTopLevel(text, delimiter = ',') {
  const out = []
  let depth = 0
  let quote = ''
  let buffer = ''
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote) {
      buffer += ch
      if (ch === quote && text[i - 1] !== '\\') quote = ''
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buffer += ch
      continue
    }
    if (ch === '{' || ch === '[') depth += 1
    if (ch === '}' || ch === ']') depth -= 1
    if (ch === delimiter && depth === 0) {
      out.push(buffer.trim())
      buffer = ''
      continue
    }
    buffer += ch
  }
  if (buffer.trim()) out.push(buffer.trim())
  return out
}

export function unquote(text) {
  const value = String(text ?? '').trim()
  if (value.length >= 2) {
    const first = value[0]
    const last = value[value.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1).replace(/\\(["'\\])/g, '$1')
    }
  }
  return value
}

function coerce(raw) {
  const text = unquote(raw)
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^-?\d+(\.\d+)?$/.test(text)) return Number(text)
  if (text.startsWith('{') && text.endsWith('}')) return parseInlineMap(text)
  if (text.startsWith('[') && text.endsWith(']')) {
    const inner = text.slice(1, -1).trim()
    if (!inner) return []
    return splitTopLevel(inner).map(coerce)
  }
  return text
}

/** 解析 `{ key: value, key: value }`（花括号可省）。 */
export function parseInlineMap(text) {
  const inner = String(text ?? '').trim().replace(/^\{/, '').replace(/\}$/, '')
  const map = {}
  for (const pair of splitTopLevel(inner)) {
    if (!pair) continue
    const colon = pair.indexOf(':')
    if (colon === -1) continue
    const key = unquote(pair.slice(0, colon)).trim()
    if (!key) continue
    map[key] = coerce(pair.slice(colon + 1))
  }
  return map
}

/**
 * 解析一个块的主体。
 * @returns {{actions: Array<object>, errors: string[]}}
 */
export function parseBlock(body) {
  const actions = []
  const errors = []
  const text = String(body ?? '').trim()
  if (!text) return { actions, errors }

  if (text.startsWith('[') || text.startsWith('{')) {
    try {
      const parsed = JSON.parse(text)
      const list = Array.isArray(parsed) ? parsed : [parsed]
      for (const item of list) {
        if (item && typeof item === 'object' && !Array.isArray(item)) actions.push(item)
        else errors.push(`不是对象：${JSON.stringify(item)}`)
      }
      return { actions, errors }
    } catch (error) {
      errors.push(`JSON 解析失败：${error.message}`)
      return { actions, errors }
    }
  }

  let current = null
  let currentKey = ''
  const flush = () => {
    if (!current) return
    if (!currentKey) {
      errors.push(`动作缺少动词：${JSON.stringify(current)}`)
      current = null
      return
    }
    actions.push(current)
    current = null
    currentKey = ''
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).replace(/\s+$/, '')
    const trimmed = line.trim()
    if (!trimmed || trimmed === '---') continue

    if (trimmed.startsWith('-')) {
      flush()
      const rest = trimmed.slice(1).trim()
      if (!rest) {
        errors.push('空列表项')
        continue
      }
      const colon = rest.indexOf(':')
      if (colon === -1) {
        errors.push(`行内缺少 ':'：${rest}`)
        continue
      }
      const verb = unquote(rest.slice(0, colon)).trim()
      const tail = rest.slice(colon + 1).trim()
      current = { [verb]: {} }
      currentKey = verb
      if (tail) {
        if (tail.startsWith('{')) current[verb] = parseInlineMap(tail)
        else if (tail.startsWith('[')) current[verb] = coerce(tail)
        else current[verb] = coerce(tail)
      }
      continue
    }

    if (!current) {
      // 允许省略开头的 '-'：verb: {...}
      const colon = trimmed.indexOf(':')
      if (colon > 0) {
        const verb = unquote(trimmed.slice(0, colon)).trim()
        const tail = trimmed.slice(colon + 1).trim()
        current = { [verb]: {} }
        currentKey = verb
        if (tail) current[verb] = tail.startsWith('{') ? parseInlineMap(tail) : coerce(tail)
        continue
      }
      errors.push(`无法识别：${trimmed}`)
      continue
    }

    // 缩进键值：属于当前动作的参数
    const colon = trimmed.indexOf(':')
    if (colon === -1) {
      errors.push(`参数行缺少 ':'：${trimmed}`)
      continue
    }
    const key = unquote(trimmed.slice(0, colon)).trim()
    const value = trimmed.slice(colon + 1).trim()
    if (!current[currentKey] || typeof current[currentKey] !== 'object' || Array.isArray(current[currentKey])) {
      current[currentKey] = {}
    }
    current[currentKey][key] = value ? coerce(value) : {}
  }
  flush()
  return { actions, errors }
}

/**
 * 从一段回复里抽出所有动作。
 * @param {string} text 模型回复原文
 * @returns {{actions: Array<object>, errors: string[], blocks: number}}
 */
export function extractActions(text) {
  const blocks = extractBlocks(text)
  const actions = []
  const errors = []
  for (const [index, block] of blocks.entries()) {
    const parsed = parseBlock(block.body)
    for (const action of parsed.actions) actions.push(action)
    for (const error of parsed.errors) errors.push(`块#${index + 1}: ${error}`)
  }
  return { actions, errors, blocks: blocks.length }
}

export const _internals = { coerce, stripComment }
