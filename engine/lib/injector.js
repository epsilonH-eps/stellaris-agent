/**
 * 键盘注入：把一行控制台命令「打」进群星。
 *
 * 约束（协议 §3.2、README §2）：
 *   - 只用键盘事件（SendInput），不移动鼠标、不点任何控件；
 *   - 真正改档的是游戏解释器执行 effect，不是这里的按键；
 *   - 找不到窗口 / 前台抢不到时明确失败，绝不「盲打」。
 *
 * 这一层只负责「输入」，不负责写文件、不等 ACK（那是 executor）。
 *
 * @module dsh-stellaris-bridge/injector
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export const SCRIPT = fileURLToPath(new URL('../tools/sendkeys.ps1', import.meta.url))

let cachedShell = null

function shell() {
  if (cachedShell) return cachedShell
  const candidates = ['pwsh.exe', 'powershell.exe']
  cachedShell = candidates[0]
  return cachedShell
}

async function runPs(args, timeoutMs = 15000) {
  if (process.platform !== 'win32') {
    throw Object.assign(new Error('键盘注入只在 Windows 上可用'), { code: 'NOT_SUPPORTED' })
  }
  if (!existsSync(SCRIPT)) {
    throw Object.assign(new Error(`缺少输入助手：${SCRIPT}`), { code: 'NO_HELPER' })
  }
  const tryOne = async (exe) => {
    const { stdout } = await execFileAsync(
      exe,
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, ...args],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
    )
    return String(stdout || '').trim()
  }
  let output = ''
  try {
    output = await tryOne(shell())
  } catch (error) {
    if (String(error?.message || '').includes('ENOENT')) {
      cachedShell = 'powershell.exe'
      output = await tryOne(cachedShell)
    } else {
      // 助手在「没找到窗口」这类情况下会用非 0 退出码，但仍然输出 JSON；
      // 这不算进程错误，按结果处理。
      const stdout = String(error?.stdout || '').trim()
      if (stdout.startsWith('{')) output = stdout
      else throw error
    }
  }
  const line = output.split(/\r?\n/).filter(Boolean).pop() || '{}'
  try {
    return JSON.parse(line)
  } catch {
    throw Object.assign(new Error(`输入助手返回了非 JSON：${line.slice(0, 200)}`), { code: 'BAD_HELPER_OUTPUT' })
  }
}

export async function listWindows() {
  const result = await runPs(['-Action', 'list'])
  return Array.isArray(result.windows) ? result.windows : []
}

export async function focusWindow(match) {
  return runPs(['-Action', 'focus', '-Match', match])
}

export async function typeText(text, enter = false) {
  const args = ['-Action', 'type', '-Text', String(text)]
  if (enter) args.push('-Enter')
  return runPs(args)
}

export async function tapKey(vk) {
  return runPs(['-Action', 'key', '-Vk', String(vk)])
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)))
}

/**
 * 在群星控制台里执行一行命令（开控制台 → 输入 → 回车 → 关控制台）。
 * @param {object} config
 * @param {string} line 例如 `run dsh_q_123_0.txt`
 * @returns {Promise<{ok: boolean, focused: boolean, typed?: boolean, error?: string}>}
 */
export async function sendConsoleLine(config, line) {
  const title = String(config.gameTitleMatch || 'Stellaris')
  const key = String(config.consoleKey || '`')

  const focus = await focusWindow(title)
  if (!focus.ok) {
    return { ok: false, focused: false, error: `找不到/切不到窗口：${title}` }
  }
  await sleep(220)
  // 开控制台
  await typeText(key, false)
  await sleep(320)
  // 打命令
  await typeText(line, true)
  await sleep(280)
  // 关控制台（再按一次同一个键）
  await typeText(key, false)
  return { ok: true, focused: true, typed: true }
}

const VK_NAMED = {
  enter: 0x0d,
  esc: 0x1b,
  escape: 0x1b,
  space: 0x20,
  tab: 0x09,
  backspace: 0x08,
}

/** "F5" / "enter" / "A" → 虚拟键码；认不出返回 0。 */
export function vkFor(key) {
  const text = String(key ?? '').trim()
  if (!text) return 0
  const lower = text.toLowerCase()
  if (VK_NAMED[lower] !== undefined) return VK_NAMED[lower]
  const fn = /^f(\d{1,2})$/i.exec(text)
  if (fn) {
    const index = Number(fn[1])
    if (index >= 1 && index <= 12) return 0x6f + index
  }
  if (/^[a-z]$/i.test(text)) return text.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(text)) return text.charCodeAt(0)
  return 0
}

/** 按一个「人类会按的键」（F 键/字母/回车），用于打开界面。 */
export async function pressKey(config, key) {
  const vk = vkFor(key)
  if (!vk) return { ok: false, error: `不认识的按键：${key}` }
  const focus = await focusWindow(String(config.gameTitleMatch || 'Stellaris'))
  if (!focus.ok) return { ok: false, error: '窗口切不到前台' }
  await sleep(180)
  await tapKey(vk)
  return { ok: true, vk }
}
