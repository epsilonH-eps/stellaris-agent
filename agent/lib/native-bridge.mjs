/**
 * 原生桥：直接和注入到游戏里的 stellaris_bridge.dll 通话（命名管道 JSON-RPC）。
 *
 * 这是「实时、零模拟输入」的正解：
 *   - DLL 由我们注入（LoadLibraryW 远程线程），游戏线程执行命令；
 *   - 不碰键盘、不碰控制台、不改存档、不改 exe；
 *   - 协议：`\\.\pipe\stellaris_mcp_bridge`，每行一个 JSON-RPC 2.0。
 *
 * DLL 来自 MIT 的 Yidhar/stellaris-mcp（见 native/NOTICE.md）。
 * @module stellaris-agent/native-bridge
 */
import net from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const execFileAsync = promisify(execFile)
const PIPE = '\\\\.\\pipe\\stellaris_mcp_bridge'
const POWERSHELL = process.env.SYSTEMROOT
  ? `${process.env.SYSTEMROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe'

export function nativeDllPath() {
  return fileURLToPath(new URL('../native/stellaris_bridge.dll', import.meta.url))
}

export function injectScriptPath() {
  return fileURLToPath(new URL('../native/inject.ps1', import.meta.url))
}

export class NativePipe {
  constructor({ path = PIPE, timeoutMs = 8000 } = {}) {
    this.path = path
    this.timeoutMs = timeoutMs
    this.socket = null
    this.buffer = ''
    this.pending = null
    this.chain = Promise.resolve()
  }

  async open() {
    if (this.socket && !this.socket.destroyed) return
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.path)
      this.socket = socket
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error('native pipe connect timeout'))
      }, 4000)
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.on('data', (chunk) => this.onData(chunk))
      socket.on('close', () => {
        if (this.pending) {
          const { reject } = this.pending
          this.pending = null
          reject(new Error('native pipe closed'))
        }
      })
    })
  }

  onData(chunk) {
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
        continue
      }
      const pending = this.pending
      if (!pending || message.id !== pending.id) continue
      this.pending = null
      clearTimeout(pending.timer)
      if (message.error) {
        const error = new Error(message.error.message || 'native rpc rejected')
        error.code = message.error.code
        pending.reject(error)
      } else {
        pending.resolve(message.result)
      }
    }
  }

  request(method, params = {}) {
    // 一条连接只允许一个在途请求；排队执行，避免响应错配。
    const run = async () => {
      await this.open()
      return new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e9)
        const timer = setTimeout(() => {
          this.pending = null
          reject(new Error(`native ${method} timeout`))
        }, this.timeoutMs)
        this.pending = { id, resolve, reject, timer }
        this.socket.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      })
    }
    const next = this.chain.then(run, run)
    this.chain = next.then(() => undefined, () => undefined)
    return next
  }

  close() {
    this.socket?.destroy()
    this.socket = null
  }
}

export async function findGameProcess() {
  const command = 'Get-Process -Name Stellaris -ErrorAction SilentlyContinue | Select-Object Id,Path | ConvertTo-Json -Compress'
  const { stdout } = await execFileAsync(POWERSHELL, ['-NoProfile', '-Command', command], { windowsHide: true })
  const text = String(stdout || '').trim()
  if (!text) return null
  const parsed = JSON.parse(text)
  const row = Array.isArray(parsed) ? parsed[0] : parsed
  if (!row || !row.Id) return null
  return { pid: Number(row.Id), path: row.Path }
}

async function tryStatus(pipe) {
  try {
    return await pipe.request('get_status')
  } catch {
    return null
  }
}

/**
 * 确保原生桥可用：先试管道；没有就找游戏进程并注入 DLL。
 */
export async function ensureNativeBridge({ dllPath = nativeDllPath(), log = () => {} } = {}) {
  if (!existsSync(dllPath)) return { ok: false, error: 'DLL_NOT_FOUND', dllPath }
  const pipe = new NativePipe()
  const existing = await tryStatus(pipe)
  if (existing) return { ok: true, injected: false, pipe, status: existing }

  const game = await findGameProcess()
  if (!game) {
    pipe.close()
    return { ok: false, error: 'GAME_NOT_RUNNING' }
  }
  log('native.inject', { pid: game.pid })
  let result
  try {
    const { stdout } = await execFileAsync(
      POWERSHELL,
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', injectScriptPath(), '-GamePid', String(game.pid), '-DllPath', dllPath],
      { windowsHide: true, timeout: 30000 },
    )
    result = JSON.parse(String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1))
  } catch (error) {
    pipe.close()
    return { ok: false, error: 'INJECT_FAILED', detail: String(error?.message || error), pid: game.pid }
  }
  if (!result?.ok) {
    pipe.close()
    return { ok: false, error: 'INJECT_FAILED', detail: result, pid: game.pid }
  }
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const status = await tryStatus(pipe)
    if (status) return { ok: true, injected: true, pipe, status, pid: game.pid }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
  pipe.close()
  return { ok: false, error: 'PIPE_NOT_READY', pid: game.pid }
}
