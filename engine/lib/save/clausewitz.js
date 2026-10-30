/**
 * Clausewitz 文本解析器（群星存档 gamestate 用的格式）。
 *
 * 语法极简：
 *   key = "quoted string"
 *   key = bare_word        （日期 2201.3.11、枚举、数字都走这条）
 *   key = { ... }          （嵌套对象 / 列表）
 *   # 注释
 *
 * 重要特性：**同一个 key 可以出现多次**（事件列表、建筑槽都是这样）。
 * 所以重复 key 解析成数组，而不是覆盖——覆盖会悄悄丢数据。
 *
 * 解析结果是普通 JS 对象（值可能是 string/number/boolean/object/array）。
 * 50MB 的存档能扛，但别在热路径上反复解析（savedump 会按 mtime 缓存）。
 *
 * @module dsh-stellaris-bridge/save/clausewitz
 */

const PUNCT = new Set(['{', '}', '=', '<', '>'])

export function tokenize(text) {
  const tokens = []
  const source = String(text ?? '')
  let i = 0
  const n = source.length
  while (i < n) {
    const ch = source[i]
    if (ch === '\uFEFF' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') {
      i += 1
      continue
    }
    if (ch === '#') {
      while (i < n && source[i] !== '\n') i += 1
      continue
    }
    if (PUNCT.has(ch)) {
      tokens.push({ type: 'punct', value: ch })
      i += 1
      continue
    }
    if (ch === '"') {
      i += 1
      let value = ''
      while (i < n) {
        const c = source[i]
        if (c === '\\' && i + 1 < n) {
          value += source[i + 1]
          i += 2
          continue
        }
        if (c === '"') {
          i += 1
          break
        }
        value += c
        i += 1
      }
      tokens.push({ type: 'string', value })
      continue
    }
    let start = i
    while (i < n && !/[\s{}=<>#"]/.test(source[i])) i += 1
    let value = source.slice(start, i)
    if (value === '') {
      i += 1
      continue
    }
    tokens.push({ type: 'ident', value })
  }
  return tokens
}

function coerce(token) {
  if (!token) return null
  if (token.type === 'string') return token.value
  const text = token.value
  if (/^-?\d+$/.test(text)) return Number(text)
  if (/^-?\d+\.\d+$/.test(text)) return Number(text)
  if (text === 'yes') return true
  if (text === 'no') return false
  if (text === 'none' || text === 'null') return null
  return text
}

/**
 * 解析。重复 key 自动变数组。
 * @param {string} text
 * @returns {object} 根对象
 */
export function parse(text) {
  const tokens = tokenize(text)
  const root = {}
  const stack = [root]
  let pendingKey = null
  let i = 0

  const current = () => stack[stack.length - 1]

  const assign = (key, value) => {
    const target = current()
    if (target === null || typeof target !== 'object') return
    if (Object.prototype.hasOwnProperty.call(target, key)) {
      if (Array.isArray(target[key])) target[key].push(value)
      else target[key] = [target[key], value]
    } else {
      target[key] = value
    }
  }

  while (i < tokens.length) {
    const token = tokens[i]
    if (token.type === 'punct') {
      if (token.value === '{') {
        const obj = {}
        if (pendingKey !== null) {
          assign(pendingKey, obj)
          pendingKey = null
        } else {
          // 列表里的匿名对象（如 `={ a b }`）：直接挂到当前对象的 @list
          const target = current()
          if (!target.__anon) target.__anon = []
          target.__anon.push(obj)
        }
        stack.push(obj)
        i += 1
        continue
      }
      if (token.value === '}') {
        if (stack.length > 1) stack.pop()
        pendingKey = null
        i += 1
        continue
      }
      if (token.value === '=') {
        i += 1
        continue
      }
      // < > 是运算符，存档里少见
      i += 1
      continue
    }

    // ident / string
    const next = tokens[i + 1]
    if (next && next.type === 'punct' && next.value === '=') {
      pendingKey = token.value
      i += 2
      // key = { ... } 由下一轮的 '{' 处理；key = value 在这里处理
      if (i < tokens.length) {
        const valueToken = tokens[i]
        if (valueToken.type === 'punct' && valueToken.value === '{') continue
        if (valueToken.type === 'punct' && valueToken.value === '}') {
          pendingKey = null
          continue
        }
        assign(pendingKey, coerce(valueToken))
        pendingKey = null
        i += 1
      }
      continue
    }

    // 裸值（列表元素）
    if (pendingKey !== null) {
      assign(pendingKey, coerce(token))
      pendingKey = null
    } else {
      assign('@values', coerce(token))
    }
    i += 1
  }

  return root
}

/** 路径取值：`a.b[0].c`；取不到返回 undefined。 */
export function get(root, path) {
  if (!path) return undefined
  const parts = String(path).replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean)
  let node = root
  for (const part of parts) {
    if (node === null || node === undefined) return undefined
    node = node[part]
  }
  return node
}

/** 取第一个有值的候选路径。 */
export function pick(root, paths) {
  for (const path of paths || []) {
    const value = get(root, path)
    if (value !== undefined && value !== null && value !== '') return value
  }
  return undefined
}

/** 深度优先收集某个 key 的所有值（用于 building / technology 这类重复 key）。 */
export function collect(root, key, limit = 5000) {
  const out = []
  const walk = (node, depth) => {
    if (out.length >= limit || depth > 24 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1)
      return
    }
    for (const [k, v] of Object.entries(node)) {
      if (k === key) {
        if (Array.isArray(v)) out.push(...v.map(String))
        else out.push(String(v))
        continue
      }
      walk(v, depth + 1)
    }
  }
  walk(root, 0)
  return out
}

/** 把 `{ 0={...} 1={...} }` 这种以 id 为键的对象转成数组。 */
export function idMapToArray(node) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node
  return Object.entries(node)
    .filter(([key]) => /^\d+$/.test(key))
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([id, value]) => (value && typeof value === 'object' ? { __id: Number(id), ...value } : { __id: Number(id), value }))
}

/** 解析 gamestate 里的日期 `2201.3.11` → `2201.03.11`。 */
export function normalizeDate(value) {
  const match = /^(\d{3,4})\.(\d{1,2})\.(\d{1,2})$/.exec(String(value ?? '').trim())
  if (!match) return null
  return `${match[1]}.${match[2].padStart(2, '0')}.${match[3].padStart(2, '0')}`
}

export const _internals = { coerce }
