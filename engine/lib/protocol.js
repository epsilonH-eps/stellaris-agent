/**
 * 协议解析：DSH1 日志行 ⇄ 对象。
 *
 * 行格式（docs/protocol.md §1）：
 *   DSH1|<seq>|<KIND>|<k>=<v>|<k>=<v>...
 * 日志前缀（[12:00:00][effect.cpp:1]: ）由游戏加，这里一律忽略：
 * 只在行里找第一个 "DSH1|"。
 *
 * 容错原则：一行坏了只坏一行，绝不抛异常给上层。
 *
 * @module dsh-stellaris-bridge/protocol
 */

export const MAGIC = 'DSH1'

export const KINDS = new Set([
  'BEGIN', 'END', 'META', 'EMPIRE', 'RESOURCE', 'EDICT', 'LAW', 'MODIFIER',
  'PLANET', 'BUILDING', 'DISTRICT', 'LEADER', 'TECH', 'TECH_POOL', 'TRADITION',
  'PERK', 'RELIC', 'FLEET', 'DIPLO', 'TREATY', 'WAR', 'SITUATION',
  'EVENT', 'CHAIN', 'FLAG', 'VARIABLE',
  'ACK', 'ERROR', 'NOTE',
])

/** 判断一个值是不是「没被本地化求值」的占位符，比如 "[This.GetName]"。 */
export function isUnevaluated(value) {
  if (typeof value !== 'string') return false
  const text = value.trim()
  return text.length > 2 && text.startsWith('[') && text.endsWith(']') && text.includes('.')
}

export function toNumber(value, fallback = 0) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value !== 'string') return fallback
  const cleaned = value.replace(/[%％,，\s]/g, '').replace(/^\+/, '')
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function toBool(value) {
  if (typeof value === 'boolean') return value
  const text = String(value ?? '').trim().toLowerCase()
  return text === '1' || text === 'yes' || text === 'true' || text === 'y'
}

/**
 * 解析一行日志。
 * @param {string} line 原始日志行
 * @returns {{seq: number, kind: string, fields: Record<string,string>, raw: string, dirty: string[]}|null}
 */
export function parseLine(line) {
  if (typeof line !== 'string') return null
  const start = line.indexOf(`${MAGIC}|`)
  if (start === -1) return null
  const body = line.slice(start + MAGIC.length + 1).replace(/\r$/, '')
  const parts = body.split('|')
  if (parts.length < 2) return null
  const seq = Number.parseInt(parts[0], 10)
  const kind = String(parts[1] || '').trim().toUpperCase()
  if (!KINDS.has(kind)) return null
  const fields = {}
  const dirty = []
  for (const token of parts.slice(2)) {
    if (!token) continue
    const eq = token.indexOf('=')
    if (eq <= 0) continue
    const key = token.slice(0, eq).trim()
    let value = token.slice(eq + 1)
    if (isUnevaluated(value)) dirty.push(key)
    // 名字里万一带了 '|'：这里已经被切开，标记脏字段，别当成新字段
    fields[key] = value
  }
  return {
    seq: Number.isFinite(seq) ? seq : 0,
    kind,
    fields,
    raw: line.slice(start),
    dirty,
  }
}

/** 从一段文本里抽出所有记录（用于读日志块/测试）。 */
export function parseLines(text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const record = parseLine(line)
    if (record) out.push(record)
  }
  return out
}

/** ACK 专用：把一条 ACK 记录折成 {cmd, phase}。 */
export function parseAck(record) {
  if (!record || record.kind !== 'ACK') return null
  const cmd = String(record.fields.cmd || '').trim()
  const phase = String(record.fields.phase || '').trim().toLowerCase()
  if (!cmd || (phase !== 'recv' && phase !== 'done')) return null
  return { cmd, phase }
}

/** 生成一条上行的文本（仅测试/工具用；模组侧是手写的字符串）。 */
export function encodeRecord(seq, kind, fields) {
  const tokens = Object.entries(fields || {}).map(([key, value]) => `${key}=${value}`)
  return [MAGIC, String(seq), kind, ...tokens].join('|')
}
