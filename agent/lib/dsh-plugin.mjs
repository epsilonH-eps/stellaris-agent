/**
 * DSH 插件安装 / 更新 / 重载。
 *
 * 安装做的事（幂等）：
 *  1. 找到 DSH profile（默认 `~/.dsh/profiles/desktop`，可配置/自动扫描）；
 *  2. 把本仓库的 `dsh-stellaris-bridge` 目录**链接**进 `<profile>/node_modules/`
 *     （无权限建 junction 时退回复制）；
 *  3. 在 profile 的 `package.json` 里确保 `dependencies` 与
 *     `dsh.profile.bundles` 都有它（改前留一份备份）。
 *
 * 重载：
 *  - 插件的 `index.js` 是稳定 shim，真正的逻辑在 `lib/handler.mjs`，请求时按
 *    mtime 动态 import —— 所以**改逻辑只需 POST /reload**，不用重启 DSH；
 *  - shim 本身变了才需要重启 DSH。我们不会默认杀你的 DSH：只有配置了
 *    `dshPlugin.restartCommand`（或调用方显式 `allowRestart`）才会执行。
 *
 * @module stellaris-agent/dsh-plugin
 */
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { discoverDsh } from './ai/dsh.mjs'

const execFileAsync = promisify(execFile)

export const PLUGIN_NAME = 'dsh-stellaris-bridge'

export function repoRoot() {
  return fileURLToPath(new URL('../../', import.meta.url))
}

export function pluginSourceDir() {
  return join(repoRoot(), 'dsh-stellaris-bridge')
}

function posix(path) {
  return String(path || '').replace(/\\/g, '/')
}

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    return null
  }
}

/** 找 DSH profile：显式配置 > `~/.dsh/profiles/desktop` > 其它 profile。 */
export function findProfiles({ profileDir = '' } = {}) {
  // 显式指定就只认它，避免"想装到测试目录却把真实 profile 也改了"
  if (profileDir) {
    const file = join(profileDir, 'package.json')
    if (!existsSync(file)) return []
    const pkg = readJson(file)
    return pkg ? [{ dir: profileDir, file, pkg }] : []
  }
  const base = join(homedir(), '.dsh', 'profiles')
  if (!existsSync(base)) return []
  const out = []
  for (const entry of readdirSync(base)) {
    const dir = join(base, entry)
    const file = join(dir, 'package.json')
    if (!existsSync(file)) continue
    const pkg = readJson(file)
    if (!pkg) continue
    out.push({ dir, file, pkg })
  }
  // desktop 优先
  out.sort((a, b) => (basename(b.dir) === 'desktop' ? 1 : 0) - (basename(a.dir) === 'desktop' ? 1 : 0))
  return out
}

function ensureNodeModules(profileDir) {
  const dir = join(profileDir, 'node_modules')
  mkdirSync(dir, { recursive: true })
  return dir
}

function removeIfOurs(target) {
  // 只删 profile/node_modules 底下同名的那一个，绝不递归外部路径
  const name = basename(target)
  if (name !== PLUGIN_NAME) throw new Error(`拒绝删除非插件目录：${target}`)
  if (!/[\\/]node_modules[\\/]/.test(target)) throw new Error(`拒绝删除 node_modules 之外的路径：${target}`)
  rmSync(target, { recursive: true, force: true })
}

function linkPlugin(profileDir, source, { copy = false } = {}) {
  const nodeModules = ensureNodeModules(profileDir)
  const target = join(nodeModules, PLUGIN_NAME)
  let mode = 'link'
  if (existsSync(target) || isLink(target)) {
    const current = isLink(target) ? posix(readlinkSync(target)).replace(/^\\\\\?\\/, '') : null
    if (!copy && current && current.toLowerCase().endsWith(posix(source).toLowerCase())) {
      return { ok: true, target, mode: 'link', unchanged: true }
    }
    removeIfOurs(target)
  }
  if (copy) {
    cpSync(source, target, { recursive: true })
    return { ok: true, target, mode: 'copy' }
  }
  try {
    symlinkSync(source, target, 'junction')
  } catch {
    mode = 'copy'
    cpSync(source, target, { recursive: true })
  }
  return { ok: true, target, mode }
}

function isLink(path) {
  try {
    return lstatSync(path).isSymbolicLink()
  } catch {
    return false
  }
}

function patchProfile(profile, source) {
  const pkg = JSON.parse(JSON.stringify(profile.pkg))
  let changed = false
  const desired = `link:${posix(source)}`
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}
  if (pkg.dependencies[PLUGIN_NAME] !== desired) {
    pkg.dependencies[PLUGIN_NAME] = desired
    changed = true
  }
  pkg.dsh = pkg.dsh && typeof pkg.dsh === 'object' ? pkg.dsh : {}
  pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === 'object' ? pkg.dsh.profile : {}
  const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : []
  if (!bundles.includes(PLUGIN_NAME)) {
    bundles.push(PLUGIN_NAME)
    changed = true
  }
  pkg.dsh.profile.bundles = bundles
  if (!changed) return { ok: true, changed: false, file: profile.file }
  const backup = `${profile.file}.before-stellaris-bridge`
  if (!existsSync(backup)) copyFileSync(profile.file, backup)
  writeFileSync(profile.file, JSON.stringify(pkg, null, 2) + '\n', 'utf8')
  return { ok: true, changed: true, file: profile.file, backup }
}

/**
 * 安装/更新插件（幂等）。
 * @param {{profileDir?:string, copy?:boolean, log?:Function}} [options]
 */
export function installPlugin({ profileDir = '', copy = false, log = () => {} } = {}) {
  const source = pluginSourceDir()
  if (!existsSync(join(source, 'index.js'))) {
    return { ok: false, error: 'PLUGIN_SOURCE_MISSING', source }
  }
  const profiles = findProfiles({ profileDir })
  if (!profiles.length) {
    return { ok: false, error: 'NO_DSH_PROFILE', hint: '先启动一次 DSH，或指定 dshPlugin.profileDir', tried: profileDir || join(homedir(), '.dsh', 'profiles') }
  }
  const results = []
  for (const profile of profiles) {
    try {
      const link = linkPlugin(profile.dir, source, { copy })
      const patch = patchProfile(profile, source)
      results.push({ profile: profile.dir, link, patch, ok: true })
      log('dsh.plugin.installed', { profile: profile.dir, mode: link.mode, changed: patch.changed })
    } catch (error) {
      results.push({ profile: profile.dir, ok: false, error: String(error?.message || error) })
      log('dsh.plugin.install.failed', { profile: profile.dir, error: String(error?.message || error) })
    }
  }
  const ok = results.some((row) => row.ok)
  return { ok, source, profiles: results, restartRequired: true }
}

/**
 * 让运行中的 DSH 重新加载插件逻辑（热重载，不重启进程）。
 * 只有插件 shim 变更时才需要重启 DSH。
 */
export async function reloadDsh({ config = null, log = () => {}, allowRestart = false } = {}) {
  const configured = String(config?.ai?.dsh?.url || '')
  const found = await discoverDsh({ configuredUrl: configured })
  if (!found.ok) return { ok: false, error: 'DSH_NOT_RUNNING', tried: found.tried, restartRequired: true }
  const url = found.url
  let hot = { ok: false }
  try {
    const response = await fetch(`${url}/api/stellaris-orchestrator/reload`, {
      method: 'POST',
      signal: AbortSignal.timeout(15000),
    })
    const body = await response.json().catch(() => ({}))
    hot = { ok: response.ok && body.ok !== false, status: response.status, body }
  } catch (error) {
    hot = { ok: false, error: String(error?.message || error) }
  }
  log('dsh.plugin.reload', { url, hot: hot.ok })

  if (hot.ok) {
    return { ok: true, method: 'hot', url, version: hot.body?.version || null, service: hot.body?.service || null }
  }

  const command = String(config?.dshPlugin?.restartCommand || '').trim()
  if (!command || !(allowRestart || config?.dshPlugin?.autoReload === true)) {
    return {
      ok: false,
      method: 'restart-required',
      url,
      hot,
      restartRequired: true,
      hint: '插件 shim 变更需要重启 DSH；设置 dshPlugin.restartCommand 后可自动重启，或手动重启 DSH。',
    }
  }
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { windowsHide: true, timeout: 60000 })
    return { ok: true, method: 'restart', url, command }
  } catch (error) {
    return { ok: false, method: 'restart-failed', url, command, error: String(error?.message || error) }
  }
}

/**
 * 启动时的"更新 + 重载"。
 * @returns {Promise<{ok:boolean, install:object, reload?:object, messages:string[]}>}
 */
export async function updateAndReloadPlugin({ config = null, log = () => {}, profileDir = '', allowRestart = false } = {}) {
  const messages = []
  const install = installPlugin({ profileDir: profileDir || config?.dshPlugin?.profileDir || '', log })
  messages.push(install.ok ? `插件已更新（${install.profiles.filter((row) => row.ok).length} 个 profile）` : `插件安装失败：${install.error}`)
  let reload = null
  if (install.ok) {
    reload = await reloadDsh({ config, log, allowRestart })
    if (reload.ok) messages.push(reload.method === 'hot' ? 'DSH 已热重载插件逻辑' : 'DSH 已按配置重启')
    else if (reload.restartRequired) messages.push('插件已就位，但需要重启 DSH 才能加载新 shim')
    else messages.push(`DSH 重载失败：${reload.error || reload.hot?.error || '未知错误'}`)
  }
  return { ok: install.ok && Boolean(reload?.ok), install, reload, messages }
}

/** 读取插件自身的版本（shim 与 handler 分版本，便于诊断）。 */
export function pluginVersions() {
  const dir = pluginSourceDir()
  const pkg = readJson(join(dir, 'package.json'))
  return { name: PLUGIN_NAME, version: pkg?.version || null, dir, shim: join(dir, 'index.js'), handler: join(dir, 'lib', 'handler.mjs') }
}
