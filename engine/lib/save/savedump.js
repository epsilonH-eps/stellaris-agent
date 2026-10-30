/**
 * 存档读取：找最新 .sav → 解 zip → 拿 gamestate / meta → 交给 Clausewitz 解析。
 *
 * .sav 本质是个 zip，里面通常有：
 *   meta        小，含版本、日期、玩家名、ironman 等
 *   gamestate   大，整个世界状态
 *
 * 我们没有引入 zip 库（不想给插件塞依赖），用 Windows 自带的
 * System.IO.Compression.ZipFile 解压；解压结果按 mtime 缓存，同一份存档
 * 只解一次、只解析一次。
 *
 * @module dsh-stellaris-bridge/save/savedump
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { listSaves } from '../paths.js'
import { parse } from './clausewitz.js'

const execFileAsync = promisify(execFile)

const gsCache = new Map() // file -> {mtimeMs, root}

export function latestSave(dir) {
  const saves = listSaves(dir, 1)
  return saves[0] ?? null
}

async function unzip(saveFile, destination) {
  const command = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem;',
    `$src = ${JSON.stringify(saveFile)};`,
    `$dst = ${JSON.stringify(destination)};`,
    'if (Test-Path -LiteralPath $dst) { Remove-Item -LiteralPath $dst -Recurse -Force };',
    'New-Item -ItemType Directory -Path $dst -Force | Out-Null;',
    '[System.IO.Compression.ZipFile]::ExtractToDirectory($src, $dst)',
  ].join(' ')
  await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
    timeout: 120000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
}

/**
 * 解压一份存档（带缓存目录）。
 * @param {string} saveFile
 * @param {string} cacheDir
 * @returns {Promise<{dir: string, gamestate: string, meta: string, entries: string[]}>}
 */
export async function extractSave(saveFile, cacheDir) {
  const stat = statSync(saveFile)
  const key = `${stat.mtimeMs}_${stat.size}`
  const destination = join(cacheDir, key)
  const gamestate = join(destination, 'gamestate')
  const meta = join(destination, 'meta')
  if (!existsSync(gamestate)) {
    mkdirSync(cacheDir, { recursive: true })
    await unzip(saveFile, destination)
  }
  const entries = existsSync(destination) ? readdirSync(destination).slice(0, 40) : []
  return { dir: destination, gamestate, meta, entries }
}

export function readMeta(file) {
  if (!existsSync(file)) return {}
  try {
    return parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * 解析 gamestate（按 mtime 缓存）。
 * @param {string} file
 * @returns {object}
 */
export function parseGameState(file) {
  const stat = statSync(file)
  const cached = gsCache.get(file)
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.root
  const text = readFileSync(file, 'utf8')
  const root = parse(text)
  gsCache.set(file, { mtimeMs: stat.mtimeMs, root })
  // 只留最近 2 份，别把内存吃穿
  if (gsCache.size > 2) {
    const first = gsCache.keys().next().value
    gsCache.delete(first)
  }
  return root
}
