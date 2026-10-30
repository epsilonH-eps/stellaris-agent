/**
 * Steam / 游戏安装目录探测。
 *
 * 为什么需要：要给出「事件链后续信息」，光靠存档不够——事件的下一环写在
 * 游戏的 `events/*.txt` 里。这属于游戏安装目录，不在用户目录。
 *
 * 探测顺序：
 *   1. 配置里的 `stellarisInstallDir`
 *   2. 常见 Steam 根目录下的 `steamapps/common/Stellaris`
 *   3. `libraryfolders.vdf` 里登记的其它库
 *
 * 找不到就返回 null，上层降级（事件信息工具返回明确提示，而不是崩）。
 *
 * @module dsh-stellaris-bridge/steam
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const COMMON_STEAM_ROOTS = [
  'C:\\Program Files (x86)\\Steam',
  'C:\\Program Files\\Steam',
  'D:\\Steam',
  'D:\\SteamLibrary',
  'E:\\Steam',
  'E:\\SteamLibrary',
  'F:\\SteamLibrary',
]

function looksLikeStellaris(dir) {
  if (!dir || !existsSync(dir)) return false
  return existsSync(join(dir, 'events')) || existsSync(join(dir, 'common')) || existsSync(join(dir, 'Stellaris.exe'))
}

/** 解析 libraryfolders.vdf，拿到所有库根目录。 */
export function steamLibraries(steamRoot) {
  const vdf = join(steamRoot, 'steamapps', 'libraryfolders.vdf')
  if (!existsSync(vdf)) return []
  const roots = []
  try {
    const text = readFileSync(vdf, 'utf8')
    // 只认 path "..." 行；不引第三方 vdf 解析器
    for (const match of text.matchAll(/"path"\s+"([^"]+)"/g)) {
      roots.push(match[1].replace(/\\\\/g, '\\'))
    }
  } catch {
    /* ignore */
  }
  return roots
}

/**
 * @param {object} config
 * @returns {{dir: string|null, source: string, tried: string[]}}
 */
export function resolveInstallDir(config) {
  const tried = []
  const configured = String(config?.stellarisInstallDir || '').trim()
  if (configured) {
    tried.push(configured)
    if (looksLikeStellaris(configured)) return { dir: configured, source: 'config', tried }
  }
  for (const root of COMMON_STEAM_ROOTS) {
    if (!existsSync(root)) continue
    const direct = join(root, 'steamapps', 'common', 'Stellaris')
    tried.push(direct)
    if (looksLikeStellaris(direct)) return { dir: direct, source: 'steam-common', tried }
    for (const library of steamLibraries(root)) {
      const candidate = join(library, 'steamapps', 'common', 'Stellaris')
      tried.push(candidate)
      if (looksLikeStellaris(candidate)) return { dir: candidate, source: 'libraryfolders', tried }
    }
  }
  return { dir: null, source: 'not-found', tried }
}

/** 收集事件定义可能所在的目录（本体 + DLC）。 */
export function eventDirs(installDir) {
  const dirs = []
  const add = (dir) => {
    if (dir && existsSync(dir) && statSync(dir).isDirectory()) dirs.push(dir)
  }
  add(join(installDir, 'events'))
  const dlcRoot = join(installDir, 'dlc')
  if (existsSync(dlcRoot)) {
    for (const entry of readdirSync(dlcRoot)) {
      add(join(dlcRoot, entry, 'events'))
    }
  }
  return dirs
}
