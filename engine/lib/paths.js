/**
 * 路径探测：群星用户目录、日志、存档、模组目录、命令队列。
 *
 * 群星在 Windows 上的用户目录有三个常见位置：
 *   1. %USERPROFILE%\Documents\Paradox Interactive\Stellaris
 *   2. %USERPROFILE%\OneDrive\Documents\...（OneDrive 接管了「文档」）
 *   3. 自定义（用户手动配置）
 *
 * 我们不去读注册表 KnownFolder——那需要额外依赖，而且在沙箱里可能被拒；
 * 直接把三种都试一遍，哪个像就用哪个。
 *
 * @module dsh-stellaris-bridge/paths
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

function documentsFolder() {
  try {
    const out = execFileSync('reg', ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Personal'], { encoding: 'utf8', windowsHide: true })
    const match = /Personal\s+REG_\w+\s+(.+)$/m.exec(out)
    if (!match) return null
    return match[1].trim().replace(/%([^%]+)%/g, (_, key) => process.env[key] || '')
  } catch {
    return null
  }
}

export function userDirCandidates() {
  const home = homedir()
  const list = [
    join(home, 'Documents', 'Paradox Interactive', 'Stellaris'),
    join(home, 'OneDrive', 'Documents', 'Paradox Interactive', 'Stellaris'),
    join(home, 'OneDrive', '文档', 'Paradox Interactive', 'Stellaris'),
  ]
  if (process.env.OneDrive) {
    list.push(join(process.env.OneDrive, 'Documents', 'Paradox Interactive', 'Stellaris'))
    list.push(join(process.env.OneDrive, '文档', 'Paradox Interactive', 'Stellaris'))
  }
  if (process.env.UserProfile || process.env.USERPROFILE) {
    list.push(join(process.env.UserProfile || process.env.USERPROFILE, 'Documents', 'Paradox Interactive', 'Stellaris'))
  }
  const docs = documentsFolder()
  if (docs) list.push(join(docs, 'Paradox Interactive', 'Stellaris'))
  return [...new Set(list)]
}

/** 一个目录「像不像」群星用户目录：至少有 logs/ 或 save games/ 或 mod/ 之一。 */
export function looksLikeStellarisDir(dir) {
  if (!dir || !existsSync(dir)) return false
  return ['logs', 'save games', 'mod', 'settings.txt'].some((name) => existsSync(join(dir, name)))
}

/**
 * 决定用哪个用户目录。
 * @param {object} config
 * @returns {{dir: string|null, source: string, tried: string[]}}
 */
export function resolveUserDir(config) {
  const tried = []
  const configured = String(config?.stellarisUserDir || '').trim()
  if (configured) {
    tried.push(configured)
    if (looksLikeStellarisDir(configured)) return { dir: configured, source: 'config', tried }
    // 配置了但目录不存在：仍然返回它，让上层给出「配置错了」而不是「找不到」
    if (existsSync(configured)) return { dir: configured, source: 'config-partial', tried }
    return { dir: null, source: 'config-invalid', tried }
  }
  for (const candidate of userDirCandidates()) {
    tried.push(candidate)
    if (looksLikeStellarisDir(candidate)) return { dir: candidate, source: 'auto', tried }
  }
  return { dir: null, source: 'not-found', tried }
}

export function paths(dir) {
  const logs = join(dir, 'logs')
  return {
    dir,
    logs,
    gameLog: join(logs, 'game.log'),
    errorLog: join(logs, 'error.log'),
    saves: join(dir, 'save games'),
    modDir: join(dir, 'mod'),
    /** 命令队列就放在用户目录根：控制台 `run dsh_q_*.txt` 的相对路径最稳 */
    queueDir: dir,
    configTail: join(dir, 'dsh_bridge_tail.json'),
  }
}

/** 最新的若干存档（按 mtime 倒序）。4.x 的存档会放在每个帝国一个子目录里，所以要递归。 */
export function listSaves(dir, limit = 5) {
  const savesDir = paths(dir).saves
  if (!existsSync(savesDir)) return []
  const rows = []
  const scan = (folder, depth) => {
    let entries
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
  scan(savesDir, 0)
  rows.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return rows.slice(0, limit)
}

/** 模组是否装在用户目录（只看本地副本；工坊版在 steamapps 里，另有判定）。 */
export function detectLocalMods(dir) {
  const modDir = paths(dir).modDir
  const has = (id) => existsSync(join(modDir, id)) || existsSync(join(modDir, `${id}.mod`))
  return {
    reader: has('dsh_reader'),
    console: has('dsh_console'),
    modDirExists: existsSync(modDir),
  }
}
