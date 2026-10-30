/**
 * 原生桥客户端：`\\.\pipe\<pipeName>` 上的 JSON-RPC 2.0（换行分隔）。
 *
 * 约束与对策：
 *  - DLL 侧是**单连接 + 游戏主线程队列**：本进程只保留**一个** `BridgeClient`
 *    实例，所有调用走同一条 promise 链，天然串行；第二个客户端会挤掉/阻塞
 *    第一个（旧版 readiness 每 5 秒另开一条管道就是这么出问题的）。
 *  - 请求必须有超时：DLL 在游戏卡帧时可能不回复，超时后丢弃响应并允许重连。
 *  - 连接断开（游戏重启/注入失效）时下一次请求自动重连一次。
 *
 * @module stellaris-agent/bridge
 */
import net from 'node:net'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const DEFAULT_PIPE = 'stellaris_mcp_bridge'

const POWERSHELL = process.env.SYSTEMROOT
  ? `${process.env.SYSTEMROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe'

export function pipePath(pipeName = DEFAULT_PIPE) {
  return `\\\\.\\pipe\\${pipeName}`
}

export function nativeDllPath() {
  return fileURLToPath(new URL('../native/stellaris_bridge.dll', import.meta.url))
}

export function injectScriptPath() {
  return fileURLToPath(new URL('../native/inject.ps1', import.meta.url))
}

export class BridgeError extends Error {
  constructor(message, { code = 'BRIDGE_ERROR', detail = null } = {}) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
    this.detail = detail
  }
}

export class BridgeClient {
  /**
   * @param {object} options
   * @param {string} [options.pipeName]
   * @param {number} [options.timeoutMs]
   * @param {() => void} [options.log]
   */
  constructor({ pipeName = DEFAULT_PIPE, timeoutMs = 15000, log = () => {} } = {}) {
    this.path = pipePath(pipeName)
    this.pipeName = pipeName
    this.timeoutMs = timeoutMs
    this.log = log
    this.socket = null
    this.buffer = ''
    this.pending = new Map()
    this.chain = Promise.resolve()
    this.nextId = 1
    this.stats = { requests: 0, failures: 0, timeouts: 0, connects: 0, lastError: null, lastAt: 0 }
    this.closed = false
  }

  get connected() {
    return Boolean(this.socket && !this.socket.destroyed)
  }

  _open() {
    if (this.connected) return Promise.resolve()
    if (this.socket) {
      try {
        this.socket.destroy()
      } catch {
        /* ignore */
      }
      this.socket = null
    }
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(this.path)
      this.socket = socket
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new BridgeError(`连接原生桥超时：${this.path}`, { code: 'PIPE_TIMEOUT' }))
      }, 5000)
      timer.unref?.()
      socket.once('connect', () => {
        clearTimeout(timer)
        this.stats.connects += 1
        this.log('bridge.connected', { pipe: this.path })
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        this.stats.lastError = String(error?.message || error)
        reject(new BridgeError(`连接原生桥失败：${error.message}`, { code: 'PIPE_CONNECT', detail: error.message }))
      })
      socket.on('data', (chunk) => this._onData(chunk))
      socket.on('close', () => {
        this.socket = null
        this._rejectAll(new BridgeError('原生桥连接已断开', { code: 'PIPE_CLOSED' }))
      })
    })
  }

  _onData(chunk) {
    this.buffer += chunk.toString('utf8')
    let index
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        this.log('bridge.badJson', { line: line.slice(0, 200) })
        continue
      }
      const slot = this.pending.get(message.id)
      if (!slot) continue
      this.pending.delete(message.id)
      clearTimeout(slot.timer)
      if (message.error) {
        const error = new BridgeError(message.error.message || '原生桥拒绝执行', {
          code: message.error.code || 'RPC_ERROR',
          detail: message.error,
        })
        slot.reject(error)
      } else {
        slot.resolve(message.result)
      }
    }
  }

  _rejectAll(error) {
    for (const [, slot] of this.pending) {
      clearTimeout(slot.timer)
      slot.reject(error)
    }
    this.pending.clear()
  }

  /**
   * 一次 RPC。串行排队，超时拒绝。
   * @param {string} method
   * @param {object} [params]
   * @param {{timeoutMs?: number}} [options]
   */
  request(method, params = {}, options = {}) {
    const run = async () => {
      if (this.closed) throw new BridgeError('原生桥已关闭', { code: 'BRIDGE_CLOSED' })
      await this._open()
      const timeoutMs = Number(options.timeoutMs || this.timeoutMs)
      return new Promise((resolve, reject) => {
        const id = this.nextId++
        const timer = setTimeout(() => {
          this.pending.delete(id)
          this.stats.timeouts += 1
          reject(new BridgeError(`原生桥请求超时：${method}`, { code: 'RPC_TIMEOUT' }))
        }, timeoutMs)
        timer.unref?.()
        this.pending.set(id, { resolve, reject, timer })
        const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'
        try {
          this.socket.write(payload)
          this.stats.requests += 1
          this.stats.lastAt = Date.now()
        } catch (error) {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(new BridgeError(`写入原生桥失败：${error.message}`, { code: 'PIPE_WRITE' }))
        }
      })
    }
    const next = this.chain.then(run, run)
    this.chain = next.then(
      () => undefined,
      () => undefined,
    )
    return next.catch((error) => {
      this.stats.failures += 1
      this.stats.lastError = error?.message || String(error)
      throw error
    })
  }

  close() {
    this.closed = true
    this._rejectAll(new BridgeError('原生桥已关闭', { code: 'BRIDGE_CLOSED' }))
    try {
      this.socket?.destroy()
    } catch {
      /* ignore */
    }
    this.socket = null
  }

  reopen() {
    this.closed = false
    this.buffer = ''
    this.chain = Promise.resolve()
  }
}

/** 共享客户端：整个进程只用一个。 */
let shared = null
export function getSharedBridge(options = {}) {
  if (!shared) shared = new BridgeClient(options)
  return shared
}
export function resetSharedBridge() {
  shared?.close()
  shared = null
}

export async function findGameProcess() {
  const command = 'Get-Process -Name stellaris -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress; exit 0'
  const { stdout } = await execFileAsync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true,
    timeout: 8000,
  })
  const text = String(stdout || '').trim()
  if (!text) return null
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const row = Array.isArray(parsed) ? parsed[0] : parsed
  if (!row || !row.Id) return null
  return { pid: Number(row.Id), path: row.Path || null }
}

/**
 * 注入 DLL（LoadLibraryW 远程线程）。
 * @param {{pid:number, dllPath:string, log?:Function}} options
 */
export async function injectBridge({ pid, dllPath = nativeDllPath(), log = () => {} }) {
  if (!existsSync(dllPath)) return { ok: false, error: 'DLL_NOT_FOUND', dllPath }
  log('bridge.inject', { pid, dllPath })
  try {
    const { stdout } = await execFileAsync(
      POWERSHELL,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', injectScriptPath(), '-GamePid', String(pid), '-DllPath', dllPath],
      { windowsHide: true, timeout: 30000 },
    )
    const text = String(stdout || '').trim()
    const line = text.split(/\r?\n/).filter(Boolean).at(-1) || '{}'
    return JSON.parse(line)
  } catch (error) {
    return { ok: false, error: 'INJECT_FAILED', detail: String(error?.message || error) }
  }
}

/**
 * 确保有一条可用的桥连接：先连管道，连不上就找进程注入。
 * 返回的 client 是进程内共享实例，调用方**不要** close。
 * @param {object} options
 * @param {object} options.config
 * @param {Function} [options.log]
 */
export async function ensureBridge({ config, log = () => {} }) {
  const bridgeConfig = config?.bridge || {}
  const client = getSharedBridge({
    pipeName: bridgeConfig.pipeName || DEFAULT_PIPE,
    timeoutMs: Number(bridgeConfig.requestTimeoutMs) || 15000,
    log,
  })
  if (!client.closed && client.connected) {
    try {
      return { ok: true, injected: false, status: await client.request('get_status'), client }
    } catch {
      /* 落到重建逻辑 */
    }
  }
  client.reopen()

  // 1) 已经注入过：直接能读 get_status
  try {
    const status = await client.request('get_status', {}, { timeoutMs: 4000 })
    return { ok: true, injected: false, status, client }
  } catch {
    /* 继续注入 */
  }

  // 2) 找进程并注入
  let game
  try {
    game = await findGameProcess()
  } catch (error) {
    return { ok: false, error: 'PROCESS_QUERY_FAILED', detail: String(error?.message || error), client }
  }
  if (!game) return { ok: false, error: 'GAME_NOT_RUNNING', client }

  const injected = await injectBridge({ pid: game.pid, dllPath: bridgeConfig.dllPath || nativeDllPath(), log })
  if (!injected?.ok) return { ok: false, error: 'INJECT_FAILED', detail: injected, pid: game.pid, client }

  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    try {
      const status = await client.request('get_status', {}, { timeoutMs: 2000 })
      return { ok: true, injected: true, status, pid: game.pid, client }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
  }
  return { ok: false, error: 'PIPE_NOT_READY', pid: game.pid, client }
}

export const _internals = { execFileAsync }
