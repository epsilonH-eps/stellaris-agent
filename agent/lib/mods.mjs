/**
 * 模组清单：原版 + DLC + 本地模组 + 创意工坊模组。
 *
 * 读取来源：
 *  - `<用户目录>/dlc_load.json`：`enabled_mods` / `disabled_dlc`（游戏自己维护）；
 *  - `<用户目录>/mod/*.mod` 与 `<用户目录>/mod/<dir>/descriptor.mod`：本地模组；
 *  - `<库>/steamapps/workshop/content/281990/<id>/descriptor.mod`：工坊模组；
 *  - 安装目录下的 `dlc/`：官方 DLC。
 *
 * 只做"清单 + 事件目录"，不解析模组全部脚本：模组加进游戏的科技/建筑/舰船
 * 由原生桥直接读取，不存在"只认原版"的问题。
 *
 * @module stellaris-agent/mods
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join, normalize } from 'node:path'

function readText(file) {
  try {
    return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return ''
  }
}

/** 解析 Paradox 的 `key="value"` / `key=value` 描述文件（不引第三方解析器）。 */
export function parseDescriptor(file) {
  const text = readText(file)
  const fields = {}
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z0-9_]+)\s*=\s*"?([^"#\r\n]*)"?/.exec(line)
    if (!match) continue
    const [, key, value] = match
    const cleaned = value.trim()
    if (!cleaned || cleaned === '{') continue // `tags = { ... }` 这类块留空
    if (!(key in fields)) fields[key] = cleaned
  }
  return fields
}

/** descriptor 里的 path 可能是绝对路径（工坊），也可能是相对 mod 目录。 */
export function resolveModPath(modDir, rawPath) {
  const text = String(rawPath || '').trim()
  if (!text) return null
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.startsWith('\\\\')) return text
  return join(modDir, text.replace(/^mod[\\/]/i, ''))
}

function keyOf(value) {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .toLowerCase()
}

export function readDlcLoad(userDir) {
  const file = join(userDir || '', 'dlc_load.json')
  if (!userDir || !existsSync(file)) return { file, enabled_mods: [], disabled_dlc: [], found: false }
  try {
    const data = JSON.parse(readText(file) || '{}')
    return {
      file,
      found: true,
      enabled_mods: Array.isArray(data.enabled_mods) ? data.enabled_mods.map(keyOf) : [],
      disabled_dlc: Array.isArray(data.disabled_dlc) ? data.disabled_dlc : [],
    }
  } catch {
    return { file, enabled_mods: [], disabled_dlc: [], found: false, error: 'dlc_load.json 解析失败' }
  }
}

function relKey(userDir, file) {
  if (!userDir || !file) return ''
  return keyOf(String(file).replace(new RegExp(`^${String(userDir).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}[\\\\/]?`, 'i'), ''))
}

function modFromDescriptor({ descriptorFile, modDir, source, enabledKeys, userDir = '', extraKeys = [] }) {
  const fields = parseDescriptor(descriptorFile)
  const modPath = resolveModPath(modDir, fields.path)
  const candidates = [
    relKey(userDir, descriptorFile),
    keyOf(descriptorFile),
    keyOf(modPath || ''),
    ...extraKeys.map(keyOf),
    ...(fields.remote_file_id ? [keyOf(`mod/ugc_281990_${fields.remote_file_id}.mod`), keyOf(fields.remote_file_id)] : []),
    keyOf(fields.name || ''),
  ].filter(Boolean)
  const enabled = candidates.some((candidate) => enabledKeys.has(candidate))
  const fileName = basename(descriptorFile)
  const idBase = fileName.toLowerCase() === 'descriptor.mod' ? basename(modDir) : basename(descriptorFile, '.mod')
  return {
    id: fields.remote_file_id || idBase,
    name: fields.name || idBase,
    version: fields.version || null,
    supportedVersion: fields.supported_version || null,
    tags: fields.tags || null,
    source,
    descriptorFile,
    path: modPath,
    enabled,
    remoteFileId: fields.remote_file_id || null,
  }
}

function listLocalMods(userDir, enabledKeys) {
  const modDir = join(userDir || '', 'mod')
  const out = []
  if (!userDir || !existsSync(modDir)) return out
  let entries = []
  try {
    entries = readdirSync(modDir)
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(modDir, entry)
    let stat
    try {
      stat = statSync(full)
    } catch {
      continue
    }
    if (stat.isFile() && entry.toLowerCase().endsWith('.mod')) {
      out.push(modFromDescriptor({ descriptorFile: full, modDir, source: 'local', enabledKeys, userDir }))
    } else if (stat.isDirectory()) {
      const descriptor = join(full, 'descriptor.mod')
      if (existsSync(descriptor)) out.push(modFromDescriptor({ descriptorFile: descriptor, modDir, source: 'local', enabledKeys, userDir }))
    }
  }
  return out
}

function workshopRoot(installDir) {
  if (!installDir) return null
  // <lib>/steamapps/common/Stellaris -> <lib>/steamapps/workshop/content/281990
  const parts = normalize(installDir).split(/[\\/]/)
  const index = parts.findIndex((part) => part.toLowerCase() === 'steamapps')
  if (index < 0) return null
  return join(parts.slice(0, index + 1).join('\\'), 'workshop', 'content', '281990')
}

function listWorkshopMods(installDir, enabledKeys, userDir) {
  const root = workshopRoot(installDir)
  if (!root || !existsSync(root)) return []
  let entries = []
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return entries
    .map((id) => {
      const dir = join(root, id)
      const descriptor = join(dir, 'descriptor.mod')
      if (!existsSync(descriptor)) return null
      return {
        ...modFromDescriptor({
          descriptorFile: descriptor,
          modDir: dir,
          source: 'workshop',
          enabledKeys,
          userDir,
          extraKeys: [`mod/ugc_281990_${id}.mod`, `ugc_281990_${id}.mod`, id],
        }),
        id,
        workshopId: id,
      }
    })
    .filter(Boolean)
}

function listDlcs(installDir, disabled) {
  if (!installDir) return []
  const root = join(installDir, 'dlc')
  if (!existsSync(root)) return []
  let entries = []
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  return entries
    .map((entry) => {
      const dir = join(root, entry)
      const descriptor = join(dir, 'descriptor.mod')
      const fields = existsSync(descriptor) ? parseDescriptor(descriptor) : {}
      const name = fields.name || entry
      const disabledKey = entry.toLowerCase()
      return {
        id: entry,
        name,
        version: fields.version || null,
        enabled: !disabled.includes(disabledKey) && !disabled.includes(name.toLowerCase()),
      }
    })
    .filter(Boolean)
}

/**
 * @param {{userDir?:string, installDir?:string}} options
 */
export function listMods({ userDir = '', installDir = '' } = {}) {
  const dlcLoad = readDlcLoad(userDir)
  const enabledKeys = new Set(dlcLoad.enabled_mods)
  const local = listLocalMods(userDir, enabledKeys)
  const workshop = listWorkshopMods(installDir, enabledKeys, userDir)
  // 工坊模组通常在 mod/ 里有一份 .mod 存根，去重时保留"有真实路径"的那份
  const byId = new Map()
  for (const mod of [...local, ...workshop]) {
    const key = String(mod.remoteFileId || mod.id || mod.name)
    const existing = byId.get(key)
    if (!existing) {
      byId.set(key, mod)
      continue
    }
    byId.set(key, {
      ...existing,
      ...Object.fromEntries(Object.entries(mod).filter(([, value]) => value !== null && value !== '' && value !== undefined)),
      path: existing.path || mod.path,
      enabled: existing.enabled || mod.enabled,
      descriptorFile: existing.descriptorFile || mod.descriptorFile,
    })
  }
  const mods = [...byId.values()]
  // 没出现在 dlc_load.json 里的模组：本地默认视为"装了但没启用"，工坊同理。
  const dlcs = listDlcs(installDir, dlcLoad.disabled_dlc)
  const active = mods.filter((mod) => mod.enabled)
  return {
    readAt: new Date().toISOString(),
    dlcLoad,
    userDir: userDir || null,
    installDir: installDir || null,
    total: mods.length,
    enabled: active.length,
    mods,
    dlcs,
    enabledMods: active,
    /** 送进事件索引的目录 */
    eventDirs: active
      .map((mod) => (mod.path ? join(mod.path, 'events') : dirnameJoin(mod.descriptorFile, 'events')))
      .filter((dir) => dir && existsSync(dir)),
  }
}

function dirnameJoin(file, child) {
  const dir = String(file || '').replace(/[\\/][^\\/]+$/, '')
  return dir ? join(dir, child) : ''
}

/** 给模型看的紧凑清单。 */
export function modsDigest(mods) {
  if (!mods) return null
  return {
    total: mods.total,
    enabled: mods.enabled,
    mods: (mods.enabledMods || []).map((mod) => ({
      name: mod.name,
      version: mod.version,
      supported: mod.supportedVersion,
      source: mod.source,
    })),
    dlcs: (mods.dlcs || []).filter((dlc) => dlc.enabled).map((dlc) => dlc.name),
  }
}
