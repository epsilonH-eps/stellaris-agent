/**
 * 配置：单一数据源（DEFAULT_CONFIG），`config.json` 只存覆盖项。
 *
 * 位置：`~/.stellaris-agent/config.json`，可用 STELLARIS_AGENT_HOME 改目录。
 *
 * 设计要点：
 *  - 每次读取都与默认值深合并，旧配置文件不需要迁移；
 *  - `loadConfig()` 不抛异常（坏 JSON 进 `error` 字段），让 `doctor`/GUI 能显示原因；
 *  - 路径解析集中在这里：游戏安装目录 / 用户目录 / 存档目录。
 *
 * @module stellaris-agent/config
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, isAbsolute } from 'node:path'
import { DEFAULT_PERSONA } from './persona.mjs'

function freshPersona() {
  return JSON.parse(JSON.stringify(DEFAULT_PERSONA))
}
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const examplePath = join(here, '..', 'config.example.json')

export const DEFAULT_CONFIG = {
  version: 2,
  paths: {
    stellarisInstallDir: '',
    stellarisUserDir: '',
    saveDir: '',
  },
  bridge: {
    pipeName: 'stellaris_mcp_bridge',
    dllPath: '',
    injectTimeoutMs: 30000,
    requestTimeoutMs: 15000,
    reconnectDelayMs: 500,
    /** 游戏在跑但桥没连上时，自动注入（一次注入后由看护循环自动续上） */
    autoInject: true,
    /** 桥就绪且已进局时，自动启动编排器 */
    autoStartOrchestrator: true,
    /** 看护循环间隔 */
    watchSeconds: 15,
  },
  read: {
    onStart: 'full',
    deep: true,
    includeCivilianFleets: true,
    includeDiplomacyOptions: true,
    maxDiplomacyCountries: 24,
    includeGalaxyMap: true,
    galaxyMapJumps: 60,
    eventChainDepth: 6,
    maxEventChains: 300,
    refreshSeconds: 20,
    watchSeconds: 15,
    megastructureScanSeconds: 300,
  },
  executor: {
    pauseWhenQueuedActions: 8,
    resumeWhenQueuedActionsBelow: 3,
    autoPause: true,
    autoResume: true,
    maxAttempts: 3,
    retryDelayMs: 450,
    verify: true,
    keepJobHistory: 60,
  },
  ai: {
    backend: 'deepseek',
    deepseek: {
      apiKey: '',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      temperature: 0.3,
      maxTokens: 4096,
      timeoutMs: 120000,
      retries: 2,
    },
    dsh: {
      url: 'http://127.0.0.1:49939',
      autoDiscover: true,
      timeoutMs: 600000,
    },
    main: { intervalSeconds: 120, maxActionsPerTurn: 8, historyMessages: 24, activateOnStart: true, reasoningEffort: 'medium' },
    unit: { intervalSeconds: 45, maxActionsPerTurn: 4, attempts: 3, historyMessages: 18, maxConcurrent: 5 },
    event: { maxActionsPerTurn: 3, attempts: 2, historyMessages: 12 },
  },
  units: {
    research: true,
    council: true,
    laws: true,
    economy: true,
    diplomacy: true,
    fleets: true,
    planets: true,
    events: true,
  },
  objective: '',
  chat: { enabled: true, port: 8787, token: '', maxHistory: 500 },
  ui: { followActive: true, followSeconds: 10, autoClose: true, autoCloseSeconds: 5, processName: 'stellaris' },
  dshPlugin: { autoInstall: true, autoReload: false, profileDir: '', restartCommand: '' },
  journal: { enabled: true },
  persona: freshPersona(),
  failures: {
    dir: '', // 留空 = <home>/failures
    maxFiles: 200,
    includeTranscript: true,
    includeWorld: false,
  },
  log: { level: 'info', file: true },
}

export function agentHome() {
  return process.env.STELLARIS_AGENT_HOME || join(homedir(), '.stellaris-agent')
}

export function configFile() {
  return join(agentHome(), 'config.json')
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** 深合并：数组直接替换，对象逐键递归；`undefined` 不覆盖。 */
export function mergeConfig(base, patch) {
  if (!isPlainObject(patch)) return base
  const out = Array.isArray(base) ? [...base] : { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeConfig(out[key], value)
    else out[key] = value
  }
  return out
}

/**
 * 旧版（v1）配置迁移：把 `swarm.*` / `deepseek.*` / `liveChat.*` / 顶层路径
 * 映射到 v2 结构。只补缺失键，不覆盖用户已经写好的新字段。
 * 这样老用户的 backend/dshUrl/阈值不会在升级后静默丢失。
 */
export function migrateLegacyConfig(raw = {}) {
  if (!isPlainObject(raw) || Number(raw.version) >= 2) return raw
  const legacy = raw
  const patch = {}
  const set = (path, value) => {
    if (value === undefined || value === null || value === '') return
    const keys = path.split('.')
    let node = patch
    for (const key of keys.slice(0, -1)) {
      node[key] = node[key] || {}
      node = node[key]
    }
    node[keys.at(-1)] = value
  }
  set('paths.stellarisInstallDir', legacy.stellarisInstallDir)
  set('paths.stellarisUserDir', legacy.stellarisUserDir)
  set('paths.saveDir', legacy.saveDir)
  set('ai.backend', legacy.swarm?.backend || legacy.backend)
  set('ai.dsh.url', legacy.swarm?.dshUrl || legacy.dshUrl)
  set('ai.deepseek.apiKey', legacy.deepseek?.apiKey)
  set('ai.deepseek.baseUrl', legacy.deepseek?.baseUrl)
  set('ai.deepseek.model', legacy.deepseek?.model)
  set('ai.deepseek.temperature', legacy.deepseek?.temperature)
  set('ai.deepseek.maxTokens', legacy.deepseek?.maxTokens)
  set('ai.deepseek.timeoutMs', legacy.deepseek?.timeoutMs)
  set('ai.unit.intervalSeconds', legacy.swarm?.tickSeconds)
  set('ai.main.intervalSeconds', legacy.swarm?.mainTickSeconds)
  set('ai.unit.attempts', legacy.swarm?.attempts)
  set('executor.maxAttempts', legacy.swarm?.attempts)
  set('executor.pauseWhenQueuedActions', legacy.swarm?.queuePauseThreshold)
  set('executor.autoResume', legacy.swarm?.autoUnpause)
  set('read.watchSeconds', legacy.swarm?.watchSeconds)
  set('read.megastructureScanSeconds', legacy.swarm?.megastructureScanSeconds)
  set('objective', legacy.swarm?.objective)
  set('chat.enabled', legacy.liveChat?.enabled)
  set('chat.port', legacy.liveChat?.port)
  set('chat.token', legacy.liveChat?.token)
  set('chat.maxHistory', legacy.liveChat?.maxQueue)
  set('journal.enabled', legacy.journal?.enabled)
  return mergeConfig(patch, legacy)
}

export function defaultConfig() {
  return structuredClone(DEFAULT_CONFIG)
}

/**
 * 读取配置。永远返回对象；解析失败时 `error` 有值，调用方自行决定是否阻塞。
 * @returns {{config: object, file: string, error: string|null, created: boolean}}
 */
export function loadConfig() {
  const file = configFile()
  let created = false
  if (!existsSync(file)) {
    mkdirSync(agentHome(), { recursive: true })
    if (existsSync(examplePath)) copyFileSync(examplePath, file)
    else writeFileSync(file, JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n', 'utf8')
    created = true
  }
  let raw = {}
  let error = null
  try {
    raw = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (issue) {
    error = `配置文件不是合法 JSON：${file}（${issue.message}）`
  }
  const config = mergeConfig(DEFAULT_CONFIG, migrateLegacyConfig(raw))
  if (!config.ai?.deepseek?.apiKey && process.env.DEEPSEEK_API_KEY) {
    config.ai.deepseek.apiKey = process.env.DEEPSEEK_API_KEY
  }
  return { config, file, error, created }
}

export function saveConfig(config) {
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  // 只写覆盖项，避免把默认值固化进用户配置；但 paths/ai 等关键项显式保留。
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return file
}

/** 更新配置里的若干路径（GUI/API 用）。 */
export function updateConfig(patch) {
  const { config } = loadConfig()
  const next = mergeConfig(config, patch)
  saveConfig(next)
  return next
}

export function resolvePathSetting(value, fallbackDir = agentHome()) {
  const text = String(value || '').trim()
  if (!text) return ''
  return isAbsolute(text) ? text : join(fallbackDir, text)
}

export function requireApiKey(config) {
  const key = String(config?.ai?.deepseek?.apiKey || '').trim()
  if (!key) {
    throw new Error(
      `没配 DeepSeek API key。编辑 ${configFile()} 的 ai.deepseek.apiKey，或改用 DSH 后端（ai.backend = "dsh"）。`,
    )
  }
  return key
}

export function backendOf(config) {
  return String(config?.ai?.backend || 'deepseek').toLowerCase() === 'dsh' ? 'dsh' : 'deepseek'
}
