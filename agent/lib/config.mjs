/**
 * 独立版配置：一个 JSON 文件，不依赖 DSH。
 *
 * 位置：`~/.stellaris-agent/config.json`（可用 STELLARIS_AGENT_HOME 改目录）。
 * 首次运行会把仓库里的 config.example.json 拷过去，你只需要填 API key。
 *
 * @module stellaris-agent/config
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const examplePath = join(here, '..', 'config.example.json')

export function agentHome() {
  return process.env.STELLARIS_AGENT_HOME || join(homedir(), '.stellaris-agent')
}

export function configFile() {
  return join(agentHome(), 'config.json')
}

export function loadConfig() {
  const file = configFile()
  if (!existsSync(file)) {
    mkdirSync(agentHome(), { recursive: true })
    if (existsSync(examplePath)) copyFileSync(examplePath, file)
    else writeFileSync(file, JSON.stringify({}, null, 2), 'utf8')
  }
  let config = {}
  try {
    config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  } catch (error) {
    throw new Error(`配置文件不是合法 JSON：${file}（${error.message}）`)
  }
  // API key 也允许走环境变量，方便 CI/临时用
  if (!config.deepseek?.apiKey && process.env.DEEPSEEK_API_KEY) {
    config.deepseek = { ...(config.deepseek || {}), apiKey: process.env.DEEPSEEK_API_KEY }
  }
  return { config, file }
}

export function saveConfig(config) {
  const file = configFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(config, null, 2) + '\n', 'utf8')
  return file
}

export function requireApiKey(config) {
  const key = String(config.deepseek?.apiKey || '').trim()
  if (!key) {
    throw new Error(
      `没配 DeepSeek API key。编辑 ${configFile()}，把 deepseek.apiKey 填上（或在环境变量里设 DEEPSEEK_API_KEY）。`,
    )
  }
  return key
}
