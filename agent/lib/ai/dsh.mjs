/**
 * DSH 后端：把"思考"交给 DSH 插件，再由插件用 DSH 自己的子代理机制跑一次会话。
 *
 * 为什么插件只回文本：两种后端必须行为一致（回复里放 JSON 块），
 * 所以这里把 system + 多轮消息**拍平**成一段 prompt，插件返回纯文本。
 *
 * 路由（dsh-stellaris-bridge）：
 *   GET  /api/stellaris-orchestrator/health
 *   POST /api/stellaris-orchestrator/run   {prompt,label,timeoutMs} -> {text,usage}
 *   POST /api/stellaris-orchestrator/team  {prompt,label,timeoutMs}
 *   POST /api/stellaris-orchestrator/reload -> 重新加载插件内的 handler（热更新）
 *
 * 端口不是固定的：`discover()` 先扫 DSH 进程监听的端口，再逐个探测插件健康检查。
 *
 * @module stellaris-agent/ai/dsh
 */
import { execFile } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const ROUTE = '/api/stellaris-orchestrator'

const POWERSHELL = process.env.SYSTEMROOT
  ? `${process.env.SYSTEMROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe'

/** 最近一次成功发现的 DSH 地址（DSH 重启后端口会变，缓存只是加速）。 */
function cachePath() {
  return join(process.env.STELLARIS_AGENT_HOME || join(homedir(), '.stellaris-agent'), 'dsh-url.json')
}

export function readCachedDshUrl() {
  try {
    const data = JSON.parse(readFileSync(cachePath(), 'utf8'))
    if (data.url && Date.now() - (data.at || 0) < 7 * 24 * 3600 * 1000) return data.url
  } catch {
    /* 没有缓存 */
  }
  return null
}

function writeCachedDshUrl(url) {
  try {
    const file = cachePath()
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, JSON.stringify({ url, at: Date.now() }, null, 2), 'utf8')
  } catch {
    /* 缓存写不进去不影响主流程 */
  }
}

function posix(path) {
  return String(path || '').replace(/\\/g, '/')
}

/** 把多轮消息拍平成一段文本（DSH 侧一次激活）。 */
export function flattenPrompt(system, messages) {
  const parts = []
  if (system) parts.push(`# 系统指令\n${system}`)
  for (const message of messages || []) {
    const role = message.role === 'assistant' ? '你的上一轮回复' : message.role === 'tool' ? '执行结果' : '用户/主会话'
    parts.push(`# ${role}\n${message.content}`)
  }
  parts.push('# 请直接输出要求的 JSON，不要输出多余解释。')
  return parts.join('\n\n')
}

/** 进程 → 监听端口。找不到 Get-NetTCPConnection 时返回空。 */
async function candidatePorts() {
  const script = `
$procs = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match 'deepseek|dsh' } | Select-Object -ExpandProperty Id)
if ($procs.Count -eq 0) { '[]' ; exit 0 }
if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { '[]' ; exit 0 }
@(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
  Where-Object { $procs -contains $_.OwningProcess } |
  Select-Object -ExpandProperty LocalPort -Unique) | ConvertTo-Json -Compress
`.trim()
  try {
    const { stdout } = await execFileAsync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true,
      timeout: 8000,
    })
    const text = String(stdout || '').trim()
    if (!text) return []
    const parsed = JSON.parse(text)
    return (Array.isArray(parsed) ? parsed : [parsed]).map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65536)
  } catch {
    return []
  }
}

/** netstat 里的本机监听端口（不依赖进程名，DSH 改名/权限差异也能找到）。 */
async function listeningPorts() {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { windowsHide: true, timeout: 8000 })
    const ports = new Set()
    for (const line of String(stdout || '').split(/\r?\n/)) {
      const match = /^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+\d+/i.exec(line)
      if (!match) continue
      const portMatch = /:(\d+)$/.exec(match[1])
      if (!portMatch) continue
      const port = Number(portMatch[1])
      if (Number.isInteger(port) && port > 1024 && port < 65536) ports.add(port)
    }
    return [...ports]
  } catch {
    return []
  }
}

async function probeHealth(url, timeoutMs) {
  try {
    const response = await fetch(`${url}${ROUTE}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!response.ok) return null
    const body = await response.json().catch(() => ({}))
    if (body?.ok || /stellaris/i.test(String(body?.service || ''))) {
      return { url, service: body.service || null }
    }
  } catch {
    /* 不是 DSH 或连不上 */
  }
  return null
}

/**
 * 找 DSH 插件。顺序：配置 URL → 环境变量 → 上次成功的缓存 → 进程端口/常见端口 →
 * netstat 的所有本机监听端口（DSH 每次重启端口会变，最后一步兜底）。
 * @returns {Promise<{ok:boolean, url?:string, service?:string, tried:string[], error?:string}>}
 */
export async function discoverDsh({ configuredUrl = '', timeoutMs = 1500 } = {}) {
  const tried = []
  const seen = new Set()
  const result = async (url, timeout = timeoutMs) => {
    const clean = String(url || '').replace(/\/+$/, '')
    if (!clean || seen.has(clean) || !/^https?:\/\//.test(clean)) return null
    seen.add(clean)
    tried.push(clean)
    return probeHealth(clean, timeout)
  }

  // 1) 配置 / 环境变量 / 插件固定端口 / 上次成功的地址
  const fixedPortSetting = Number(process.env.STELLARIS_BRIDGE_PORT)
  const fixedPort = Number.isInteger(fixedPortSetting) && fixedPortSetting > 0 ? fixedPortSetting : 49939
  const fixedUrl = `http://127.0.0.1:${fixedPort}`
  for (const url of [configuredUrl, process.env.DSH_URL, fixedUrl, readCachedDshUrl()]) {
    const hit = await result(url)
    if (hit) {
      writeCachedDshUrl(hit.url)
      return { ok: true, url: hit.url, service: hit.service, tried }
    }
  }

  // 2) 进程监听端口 + 常见端口
  const primary = new Set()
  for (const port of await candidatePorts()) primary.add(port)
  for (const port of [49939, 49943, 49940, 52639, 8788]) primary.add(port)
  for (const port of primary) {
    const hit = await result(`http://127.0.0.1:${port}`)
    if (hit) {
      writeCachedDshUrl(hit.url)
      return { ok: true, url: hit.url, service: hit.service, tried }
    }
  }

  // 3) netstat 全量监听端口：并发 10 个，单个 700ms
  const ports = await listeningPorts()
  for (let index = 0; index < ports.length; index += 10) {
    const batch = ports.slice(index, index + 10)
    const hits = await Promise.all(batch.map((port) => result(`http://127.0.0.1:${port}`, 700)))
    const hit = hits.find(Boolean)
    if (hit) {
      writeCachedDshUrl(hit.url)
      return { ok: true, url: hit.url, service: hit.service, tried }
    }
  }

  return { ok: false, error: 'DSH_NOT_FOUND', tried }
}

export class DshBackend {
  constructor({ config, log = () => {}, fetchImpl = null } = {}) {
    const settings = config?.ai?.dsh || {}
    this.config = config
    this.log = log
    this.baseUrl = String(settings.url || '').replace(/\/+$/, '')
    // 配置里的地址（通常是固定端口 49939）每次健康检查都优先试一遍：
    // DSH 重启后插件会重新出现在固定端口，程序能自动切回去。
    this.preferredUrl = this.baseUrl
    this.autoDiscover = settings.autoDiscover !== false
    this.timeoutMs = Number(settings.timeoutMs || 600000)
    this.fetchImpl = fetchImpl || globalThis.fetch
    this.usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0, calls: 0 }
    this.lastError = null
    this.lastHealth = null
    this.discovered = null
    this.lastDiscoverAt = 0
    this.mainSession = null
  }

  /** 主会话跟着存档走：把当前存档的 DSH session id 带给插件。 */
  setMainSession({ sessionId = null, saveKey = null, saveFolder = null, saveName = null } = {}) {
    this.mainSession = sessionId ? { sessionId, saveKey, saveFolder, saveName } : null
    return this.mainSession
  }

  get name() {
    return 'dsh'
  }

  get available() {
    return Boolean(this.baseUrl)
  }

  describe() {
    return {
      backend: 'dsh',
      url: this.baseUrl,
      autoDiscover: this.autoDiscover,
      configured: Boolean(this.baseUrl),
      lastHealth: this.lastHealth,
      usage: this.usage,
      mainSession: this.mainSession,
    }
  }

  async resolveUrl({ force = false } = {}) {
    if (!force && this.discovered && Date.now() - this.discovered.at < 60000) return this.discovered.url
    if (this.baseUrl) {
      try {
        const health = await this.health()
        if (health.ok) {
          this.discovered = { url: this.baseUrl, at: Date.now() }
          return this.baseUrl
        }
      } catch {
        /* 继续自动发现 */
      }
    }
    if (this.autoDiscover) {
      const found = await discoverDsh({ configuredUrl: '', log: this.log })
      if (found.ok) {
        this.baseUrl = found.url
        this.discovered = { url: found.url, at: Date.now() }
        this.log('dsh.discovered', { url: found.url, service: found.service })
        return found.url
      }
    }
    throw new Error('找不到运行中的 DSH（插件未加载，或 DSH 没启动）')
  }

  async health({ url = null } = {}) {
    const explicit = Boolean(url)
    const target = url || this.baseUrl
    if (!target) return { ok: false, backend: 'dsh', error: 'NO_URL' }

    const attempt = async (candidate) => {
      try {
        const response = await this.fetchImpl(`${candidate}${ROUTE}/health`, { signal: AbortSignal.timeout(3000) })
        const body = await response.json().catch(() => ({}))
        const ok = response.ok && body.ok !== false
        return { ok, backend: 'dsh', url: candidate, ...body }
      } catch (error) {
        return { ok: false, backend: 'dsh', url: candidate, error: String(error?.message || error) }
      }
    }

    // 优先试配置里的固定端口，再试上次成功/发现到的地址
    const targets = explicit
      ? [target]
      : [...new Set([this.preferredUrl, this.baseUrl].filter(Boolean))]
    let result = { ok: false, backend: 'dsh', url: targets[0] || target, error: 'NO_URL' }
    for (const candidate of targets) {
      result = await attempt(candidate)
      if (result.ok) break
    }
    if (result.ok && result.url && result.url !== this.baseUrl) {
      this.baseUrl = result.url
      this.discovered = { url: result.url, at: Date.now() }
    }
    // DSH 每次重启端口可能变：配置里的地址失效时自动扫一遍（15 秒退避，避免频繁起 PowerShell）
    const canDiscover = this.autoDiscover && !explicit && !result.ok && Date.now() - (this.lastDiscoverAt || 0) > 15000
    if (canDiscover) {
      this.lastDiscoverAt = Date.now()
      try {
        const found = await discoverDsh({ configuredUrl: '' })
        if (found.ok && found.url && found.url !== this.baseUrl) {
          const retry = await attempt(found.url)
          if (retry.ok) {
            result = { ...retry, discovered: true, previousUrl: this.baseUrl }
            this.baseUrl = found.url
            this.discovered = { url: found.url, at: Date.now() }
            this.log('dsh.rediscovered', { from: this.preferredUrl || null, to: found.url })
          }
        }
      } catch {
        /* 发现失败就保留原始错误 */
      }
    }

    this.lastHealth = {
      ok: Boolean(result.ok),
      at: Date.now(),
      url: result.url || target,
      service: result.service || null,
      hasSubagents: Boolean(result.hasSubagents),
      error: result.ok ? null : result.error || null,
    }
    return result
  }

  async _post(path, body, timeoutMs = this.timeoutMs) {
    const url = await this.resolveUrl()
    const response = await this.fetchImpl(`${url}${ROUTE}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Math.max(30000, Number(timeoutMs) || this.timeoutMs)),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || `DSH ${path} HTTP ${response.status}`)
    }
    return payload
  }

  /**
   * @param {{system:string, messages:Array<{role:string,content:string}>, label?:string, maxTokens?:number, timeoutMs?:number, team?:boolean}} request
   */
  async complete({ system, messages, label = '群星参谋', timeoutMs = null, team = false } = {}) {
    const prompt = flattenPrompt(system, messages)
    try {
      const mainLabel = label === 'main' && this.mainSession?.sessionId ? `main:${this.mainSession.sessionId}` : label
      const payload = await this._post(team ? '/team' : '/run', {
        prompt,
        label: mainLabel,
        timeoutMs: Number(timeoutMs || this.timeoutMs),
        ...(label === 'main' && this.mainSession
          ? {
              sessionId: this.mainSession.sessionId,
              saveKey: this.mainSession.saveKey,
              saveFolder: this.mainSession.saveFolder,
              saveName: this.mainSession.saveName,
            }
          : {}),
      }, timeoutMs || this.timeoutMs)
      const usage = payload.usage || null
      if (usage) {
        this.usage.calls += 1
        this.usage.totalTokens += Number(usage.total_tokens || 0)
      }
      return { text: String(payload.text || ''), usage, model: 'dsh', backend: 'dsh' }
    } catch (error) {
      this.lastError = String(error?.message || error)
      throw error
    }
  }

  /** 让插件重新加载自己的 handler（热更新，不用重启 DSH）。 */
  async reload() {
    const url = await this.resolveUrl()
    try {
      const response = await this.fetchImpl(`${url}${ROUTE}/reload`, { method: 'POST', signal: AbortSignal.timeout(15000) })
      const body = await response.json().catch(() => ({}))
      return { ok: response.ok && body.ok !== false, url, ...body }
    } catch (error) {
      return { ok: false, url, error: String(error?.message || error) }
    }
  }
}

export const _internals = { candidatePorts, posix }
