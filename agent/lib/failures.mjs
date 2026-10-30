/**
 * 子会话失败报告导出。
 *
 * 目标：任何一个单位/事件子会话最终失败（blocked / error），都把"为什么失败"
 * 落成两份文件，方便人看、也方便别的程序读：
 *
 *   <home>/failures/<时间>-<单位>-<状态>.json   完整现场（执行器逐次尝试、会话、世界摘要）
 *   <home>/failures/<时间>-<单位>-<状态>.md     人读版（结论 + 失败动作表 + 最近对话）
 *   <home>/failures/latest.json / latest.md     最近一次，方便直接打开
 *
 * 不含 API Key、token、完整配置；只保留排障需要的字段。
 *
 * @module stellaris-agent/failures
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'

function pad(value, width = 2) {
  return String(value).padStart(width, '0')
}

function stampOf(date) {
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
    '-',
    pad(date.getMilliseconds(), 3),
  ].join('')
}

function slugOf(value) {
  return String(value || 'unit')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unit'
}

function clipText(value, max = 4000) {
  const text = String(value ?? '')
  return text.length > max ? `${text.slice(0, max)}…（截断 ${text.length - max} 字符）` : text
}

function clipJson(value, max = 4000) {
  try {
    const text = JSON.stringify(value ?? null)
    if (!text || text.length <= max) return value ?? null
    return { truncated: true, chars: text.length, preview: text.slice(0, max) }
  } catch {
    return null
  }
}

function rowSummary(row) {
  return {
    index: row.index ?? null,
    method: row.method || null,
    status: row.status || null,
    error: row.error || null,
    params: clipJson(row.params ?? null, 1500),
    verify: row.verify || null,
    attempts: (row.attempts || []).map((attempt) => ({
      attempt: attempt.attempt ?? null,
      error: attempt.error || null,
      code: attempt.code || null,
      verify: attempt.verify || null,
      ms: attempt.ms ?? null,
    })),
  }
}

function executorSummary(result) {
  if (!result) return null
  return {
    ok: Boolean(result.ok),
    summary: result.summary || null,
    error: result.error || null,
    failedIndex: result.failedIndex ?? null,
    jobId: result.jobId || result.id || null,
    actions: (result.actions || []).map(rowSummary),
  }
}

function worldSummary(world) {
  if (!world) return null
  return {
    date: world.date || null,
    paused: world.paused ?? null,
    speed: world.speed ?? null,
    colonies: Array.isArray(world.colonies) ? world.colonies.length : null,
    fleets: Array.isArray(world.fleetsAll) ? world.fleetsAll.length : null,
    activeEvents: Array.isArray(world.activeEvents) ? world.activeEvents.length : null,
    wars: Array.isArray(world.wars?.wars) ? world.wars.wars.length : null,
  }
}

function sessionSummary(session) {
  if (!session) return null
  return {
    label: session.session?.label || session.label || null,
    turns: session.session?.turns ?? session.turns ?? null,
    createdAt: session.session?.createdAt ?? session.createdAt ?? null,
    messages: (session.session?.messages || session.messages || []).slice(-60).map((message) => ({
      role: message.role || null,
      ts: message.ts || null,
      content: clipText(message.content, 6000),
    })),
  }
}

function markdownOf(payload) {
  const lines = [
    `# 子会话失败报告 · ${payload.unit}`,
    '',
    `- 时间：${payload.at}`,
    `- 单位：${payload.unit}（${payload.unitType || 'unit'}${payload.name ? ` · ${payload.name}` : ''}）`,
    `- 目标：${payload.goal || '（无）'}`,
    `- 状态：${payload.status}`,
    `- 尝试：${payload.attempts ?? 0} 次`,
    `- 耗时：${payload.ms ?? 0} ms`,
    `- 原因：${payload.cause || '（模型未给出）'}`,
    `- 建议：${payload.suggestion || '（模型未给出）'}`,
    `- 证据：${payload.evidence || '（模型未给出）'}`,
    '',
    '## 结论',
    '',
    payload.say || '（无）',
    '',
  ]

  if (payload.executor) {
    const ex = payload.executor
    lines.push('## 执行器', '')
    lines.push(`- ok：${ex.ok}`)
    lines.push(`- 摘要：${ex.summary || '（无）'}`)
    if (ex.error) lines.push(`- 错误：${ex.error}`)
    if (ex.failedIndex !== null) lines.push(`- 失败步骤：#${Number(ex.failedIndex) + 1}`)
    lines.push('', '| # | 方法 | 状态 | 错误 | 尝试 |', '| --- | --- | --- | --- | --- |')
    for (const row of ex.actions || []) {
      const error = String(row.error || '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ')
      lines.push(`| ${Number(row.index ?? 0) + 1} | ${row.method || ''} | ${row.status || ''} | ${error || '—'} | ${(row.attempts || []).length} |`)
    }
    for (const row of ex.actions || []) {
      if (!row.attempts?.length) continue
      lines.push('', `### #${Number(row.index ?? 0) + 1} ${row.method || ''} 的逐次尝试`, '')
      for (const attempt of row.attempts) {
        lines.push(`- 第 ${attempt.attempt ?? '?'} 次：${attempt.error || '成功'}${attempt.code ? ` [${attempt.code}]` : ''}`)
        if (attempt.verify) lines.push(`  - 读回：ok=${attempt.verify.ok} soft=${attempt.verify.soft ?? false} ${attempt.verify.detail || ''}`)
      }
    }
    lines.push('')
  }

  if (payload.session?.messages?.length) {
    lines.push('## 最近对话', '')
    for (const message of payload.session.messages.slice(-24)) {
      const who = message.role === 'assistant' ? '模型' : message.role === 'user' ? '输入' : message.role
      lines.push(`### ${who}`, '', message.content || '（空）', '')
    }
  }

  if (payload.world) {
    lines.push('## 世界摘要', '')
    lines.push('```json', JSON.stringify(payload.world, null, 2), '```', '')
  }

  lines.push('## 文件', '', `- JSON：${payload.file || ''}`, `- Markdown：${payload.markdownFile || ''}`, '')
  return lines.join('\n')
}

export class FailureStore {
  /**
   * @param {{home:string, config?:object, log?:Function}} options
   */
  constructor({ home, config = {}, log = () => {} }) {
    this.home = home
    this.log = log
    const settings = config?.failures || {}
    const dir = String(settings.dir || '').trim()
    this.dir = dir ? (isAbsolute(dir) ? dir : join(home, dir)) : join(home, 'failures')
    this.maxFiles = Math.max(1, Number(settings.maxFiles ?? 200))
    this.includeTranscript = settings.includeTranscript !== false
    this.includeWorld = settings.includeWorld === true
  }

  ensureDir() {
    mkdirSync(this.dir, { recursive: true })
    return this.dir
  }

  /**
   * 记录一次失败。`report.status === 'ok'` 会被忽略。
   * @param {object} report 子会话报告
   * @param {{session?:object, world?:object, source?:string}} [context]
   * @returns {{id:string,file:string,markdownFile:string,at:string,unit:string,status:string}|null}
   */
  record(report, { session = null, world = null, source = null } = {}) {
    if (!report || report.status === 'ok') return null
    const at = new Date(report.at || Date.now())
    const id = `${stampOf(at)}-${slugOf(report.unit)}-${slugOf(report.status || 'failed')}`
    const file = join(this.dir, `${id}.json`)
    const markdownFile = join(this.dir, `${id}.md`)
    const payload = {
      schema: 1,
      id,
      at: at.toISOString(),
      kind: 'unit-failure',
      source: source || null,
      unit: report.unit || 'unknown',
      unitType: report.unitType || session?.unit?.type || null,
      name: report.name || session?.unit?.name || null,
      goal: report.goal || session?.goal || '',
      status: report.status || 'failed',
      attempts: report.attempts ?? null,
      ms: report.ms ?? null,
      say: report.say || '',
      cause: report.cause || '',
      suggestion: report.suggestion || '',
      evidence: report.evidence || '',
      actions: report.actions || [],
      executor: executorSummary(report.result),
      session: this.includeTranscript ? sessionSummary(session) : null,
      world: this.includeWorld ? worldSummary(world) : null,
      file,
      markdownFile,
    }
    try {
      this.ensureDir()
      writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      writeFileSync(markdownFile, `${markdownOf(payload)}\n`, 'utf8')
      writeFileSync(join(this.dir, 'latest.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      copyFileSync(markdownFile, join(this.dir, 'latest.md'))
      this.prune()
      this.log('failures.exported', { id, unit: payload.unit, status: payload.status, file })
      return { id, file, markdownFile, at: payload.at, unit: payload.unit, status: payload.status }
    } catch (error) {
      this.log('failures.export.failed', { unit: payload.unit, error: String(error?.message || error) })
      return null
    }
  }

  /** 最近的失败报告（按修改时间倒序）。 */
  list({ limit = 50 } = {}) {
    const files = this._jsonFiles()
      .filter((name) => name !== 'latest.json')
      .map((name) => {
        const file = join(this.dir, name)
        return { name, file, mtime: statSync(file).mtimeMs }
      })
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, Math.max(1, Number(limit) || 50))
    return files.map(({ file, name }) => {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8'))
        return {
          id: data.id || name.replace(/\.json$/, ''),
          at: data.at || null,
          unit: data.unit || null,
          unitType: data.unitType || null,
          status: data.status || null,
          cause: data.cause || '',
          attempts: data.attempts ?? null,
          file,
          markdownFile: data.markdownFile || file.replace(/\.json$/, '.md'),
        }
      } catch {
        return { id: name.replace(/\.json$/, ''), file, markdownFile: file.replace(/\.json$/, '.md') }
      }
    })
  }

  latest() {
    return this.read('latest')
  }

  /** 读一份报告（id 只允许文件名，防目录穿越）。 */
  read(id) {
    const clean = String(id || '').trim()
    if (!/^[a-zA-Z0-9._-]+$/.test(clean)) return null
    const file = resolve(this.dir, clean.endsWith('.json') ? clean : `${clean}.json`)
    if (!file.startsWith(resolve(this.dir) + sep)) return null
    if (!existsSync(file)) return null
    try {
      return JSON.parse(readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }

  readMarkdown(id) {
    const clean = String(id || '').trim()
    if (!/^[a-zA-Z0-9._-]+$/.test(clean)) return null
    const file = resolve(this.dir, clean.endsWith('.md') ? clean : `${clean}.md`)
    if (!file.startsWith(resolve(this.dir) + sep)) return null
    if (!existsSync(file)) return null
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }

  _jsonFiles() {
    try {
      return readdirSync(this.dir).filter((name) => name.endsWith('.json'))
    } catch {
      return []
    }
  }

  prune() {
    const files = this._jsonFiles()
      .filter((name) => name !== 'latest.json')
      .map((name) => ({ name, file: join(this.dir, name), mtime: statSync(join(this.dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const row of files.slice(this.maxFiles)) {
      try {
        unlinkSync(row.file)
        unlinkSync(row.file.replace(/\.json$/, '.md'))
      } catch {
        /* 删不掉不影响新报告 */
      }
    }
  }
}
