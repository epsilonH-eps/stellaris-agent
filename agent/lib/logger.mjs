/**
 * 文件日志：写到 <agentHome>/logs/agent.log，同时可选控制台。
 * GUI/EXE 的后端是隐藏进程，出错时必须落盘，否则用户拿不到诊断信息。
 */
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { agentHome } from './config.mjs'

export function createLogger(name = 'agent') {
  const dir = join(agentHome(), 'logs')
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    /* 目录不可写时退回仅控制台 */
  }
  const file = join(dir, 'agent.log')
  return (line, data = undefined) => {
    const text = `${new Date().toISOString()} [${name}] ${line}${data === undefined ? '' : ' ' + JSON.stringify(data)}`
    try {
      appendFileSync(file, text + '\n', 'utf8')
    } catch {
      /* 忽略 */
    }
    if (process.env.STELLARIS_AGENT_DEBUG) {
      try {
        process.stderr.write(text + '\n')
      } catch {
        /* 忽略 */
      }
    }
  }
}

export function logFile() {
  return join(agentHome(), 'logs', 'agent.log')
}
