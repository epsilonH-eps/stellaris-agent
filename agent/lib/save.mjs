/**
 * 存档位置与存档元信息。
 *
 * 原生桥给的是**实时**状态，存档只用于：
 *  - 确认存档目录可读（设置页要能选）；
 *  - 读 `meta`（日期/版本/玩家/铁人）做交叉校验；
 *  - 判断是否铁人档（铁人不允许写）。
 *
 * 只解 zip 里的 `meta`（几 KB），不碰 `gamestate`（几十 MB）。
 * 用系统自带的 System.IO.Compression，不引第三方 zip 库。
 *
 * @module stellaris-agent/save
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { parse } from '../../engine/lib/save/clausewitz.js'

const execFileAsync = promisify(execFile)

const POWERSHELL = process.env.SYSTEMROOT
  ? `${process.env.SYSTEMROOT}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
  : 'powershell.exe'

const META_SCRIPT = `
$ErrorActionPreference = 'Stop'
# PowerShell 5.1 默认按控制台代码页输出，中文会被 Node 当成 UTF-8 读成乱码
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
Add-Type -AssemblyName System.IO.Compression.FileSystem
$src = $env:SAV_FILE
$zip = [System.IO.Compression.ZipFile]::OpenRead($src)
try {
  $entry = $zip.GetEntry('meta')
  if (-not $entry) { '{"ok":false,"error":"no_meta"}' ; exit 0 }
  $reader = New-Object System.IO.StreamReader($entry.Open(), [System.Text.Encoding]::UTF8)
  try { $text = $reader.ReadToEnd() } finally { $reader.Close() }
  @{ ok = $true; meta = $text } | ConvertTo-Json -Compress -Depth 4
} finally { $zip.Dispose() }
`.trim()

/** 存档目录：显式配置 > 用户目录下的 `save games`。 */
export function resolveSaveDir({ config, userDir }) {
  const configured = String(config?.paths?.saveDir || '').trim()
  if (configured) return { dir: configured, source: 'config', exists: existsSync(configured) }
  if (userDir) {
    const dir = join(userDir, 'save games')
    return { dir, source: 'userDir', exists: existsSync(dir) }
  }
  return { dir: null, source: 'not-found', exists: false }
}

/** 最近 N 个存档（4.x 每个帝国一个子目录，递归两层）。 */
export function listSaves(dir, limit = 10) {  if (!dir || !existsSync(dir)) return []
  const rows = []
  const scan = (folder, depth) => {
    let entries = []
    try {
      entries = readdirSync(folder)
    } catch {
      return
    }
    for (const entry of entries) {
      const file = join(folder, entry)
      let stat
      try {
        stat = statSync(file)
      } catch {
        continue
      }
      if (stat.isDirectory()) {
        if (depth < 2) scan(file, depth + 1)
        continue
      }
      if (!entry.toLowerCase().endsWith('.sav')) continue
      rows.push({ file, name: entry, size: stat.size, mtimeMs: stat.mtimeMs })
    }
  }
  scan(dir, 0)
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return rows.slice(0, limit)
}

export function latestSave(dir) {
  return listSaves(dir, 1)[0] || null
}

/**
 * 存档身份：同一个帝国目录（4.x 的 `save games/<folder>/`）下的所有 autosave/manual
 * 视为**同一个存档**，对应同一个主会话。
 * @param {{latest?:object, meta?:object, dir?:string}|null} state
 */
export function resolveSaveFile(state) {
  const latest = state?.latest
  if (state?.file) return state.file
  if (typeof latest === 'string' && state?.dir) return join(state.dir, latest)
  if (latest?.file) return latest.file
  return null
}

export function saveIdentity(state) {
  const latest = state?.latest || null
  const file = resolveSaveFile(state)
  const meta = state?.meta || (latest && typeof latest === 'object' ? latest.meta : null) || {}
  const folder = file ? basename(dirname(file)) : ''
  // v9：主会话必须用 minimal preset 创建，才能不带工具
  const seed = `${folder || file || 'unknown'}|v9`
  const key = createHash('sha1').update(seed).digest('hex').slice(0, 16)
  return {
    key,
    sessionId: `stellaris-main-${key}`,
    folder: folder || null,
    name: meta?.name || (file ? basename(file) : null),
    date: meta?.date || latest?.date || null,
    version: meta?.version || null,
    file,
    ironman: Boolean(meta?.ironman === true || meta?.ironman === 'yes' || meta?.ironman === 1 || latest?.ironman),
  }
}

/**
 * 读 zip 里的 `meta`（缓存按 mtime+size）。
 * @returns {Promise<{ok:boolean, file?:string, mtimeMs?:number, meta?:object, error?:string}>}
 */
export async function readSaveMeta(saveFile, { cacheFile = null, log = () => {} } = {}) {
  if (!saveFile || !existsSync(saveFile)) return { ok: false, error: 'SAVE_NOT_FOUND' }
  let stat
  try {
    stat = statSync(saveFile)
  } catch {
    return { ok: false, error: 'SAVE_NOT_FOUND' }
  }
  const cacheKey = `v2|${saveFile}|${stat.mtimeMs}|${stat.size}`
  if (cacheFile && existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, 'utf8'))
      if (cached.key === cacheKey && cached.meta) {
        return { ok: true, file: saveFile, mtimeMs: stat.mtimeMs, meta: cached.meta, cached: true }
      }
    } catch {
      /* 缓存坏了就重读 */
    }
  }
  try {
    const { stdout } = await execFileAsync(POWERSHELL, ['-NoProfile', '-NonInteractive', '-Command', META_SCRIPT], {
      windowsHide: true,
      timeout: 20000,
      env: { ...process.env, SAV_FILE: saveFile },
      maxBuffer: 4 * 1024 * 1024,
    })
    const text = String(stdout || '').trim().split(/\r?\n/).filter(Boolean).at(-1) || '{}'
    const payload = JSON.parse(text)
    if (!payload.ok) return { ok: false, error: payload.error || 'META_UNREADABLE', file: saveFile }
    let meta = {}
    try {
      meta = parse(String(payload.meta || ''))
    } catch {
      meta = { raw: String(payload.meta || '').slice(0, 4000) }
    }
    if (cacheFile) {
      try {
        mkdirSync(join(cacheFile, '..'), { recursive: true })
        writeFileSync(cacheFile, JSON.stringify({ key: cacheKey, meta }, null, 2), 'utf8')
      } catch {
        /* ignore */
      }
    }
    log('save.meta', { file: saveFile, date: meta?.date ?? null })
    return {
      ok: true,
      file: saveFile,
      mtimeMs: stat.mtimeMs,
      meta,
      ironman: Boolean(meta?.ironman === true || meta?.ironman === 'yes' || meta?.ironman === 1),
      date: meta?.date ?? null,
      version: meta?.version ?? null,
      name: meta?.name ?? null,
      player: meta?.player_name ?? meta?.player ?? null,
    }
  } catch (error) {
    return { ok: false, error: 'META_READ_FAILED', detail: String(error?.message || error), file: saveFile }
  }
}

/**
 * 一次性读当前存档环境（目录 + 最新存档 + meta）。
 */
export async function readSaveState({ config, userDir, cacheDir, log = () => {} }) {
  const resolved = resolveSaveDir({ config, userDir })
  const saves = listSaves(resolved.dir, 5)
  const latest = saves[0] || null
  if (!latest) return { ...resolved, saves, latest: null, meta: null }
  const meta = await readSaveMeta(latest.file, {
    cacheFile: cacheDir ? join(cacheDir, 'save-meta.json') : null,
    log,
  })
  return { ...resolved, saves, latest, meta }
}
