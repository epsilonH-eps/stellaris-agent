/**
 * 执行器：把编译好的命令落成 `dsh_q_<id>.txt`，注入一行 `run ...`，等 ACK。
 *
 * 一个「方案」= 一个文件 + 一次控制台交互。为什么不每条命令开一次控制台：
 * 开关控制台本身有 ~300ms 的动画/焦点开销，十条命令就是三秒多，期间游戏
 * 还在跑（可能过月）。一次性 `run` 更接近玩家手打一整个宏。
 *
 * @module dsh-stellaris-bridge/executor
 */
import { readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readRecentErrors } from './logtail.js'
import { sendConsoleLine, sleep } from './injector.js'

const KEEP_FILES = 50

export function queueId(planId) {
  return `${Date.now().toString(36)}_${planId}`
}

export function queueFile(dir, id) {
  return join(dir, `dsh_q_${id}.txt`)
}

/** 写命令文件；顺手清掉太老的。 */
export function writeQueueFile(dir, id, commands) {
  const file = queueFile(dir, id)
  const text = commands.map((command) => command.line).join('\n') + '\n'
  writeFileSync(file, text, 'utf8')
  pruneQueue(dir)
  return file
}

export function pruneQueue(dir) {
  try {
    const files = readdirSync(dir)
      .filter((name) => /^dsh_q_.*\.txt$/i.test(name))
      .map((name) => ({ name, file: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const entry of files.slice(KEEP_FILES)) {
      try {
        unlinkSync(entry.file)
      } catch {
        /* 被游戏占用就下次再说 */
      }
    }
  } catch {
    /* 目录读不了就算了 */
  }
}

/**
 * 真正跑一个方案。
 * @param {object} params
 * @param {object} params.config
 * @param {string} params.queueDir
 * @param {object} params.state SnapshotStore
 * @param {Array<object>} params.commands compilePlan 的输出
 * @param {string} params.planId
 * @param {boolean} [params.dryRun]
 * @returns {Promise<object>}
 */
export async function executeCommands({ config, queueDir, state, commands, planId, dryRun = false }) {
  const id = queueId(planId)
  const runLine = `run dsh_q_${id}.txt`
  const base = {
    planId,
    queueId: id,
    file: dryRun ? null : queueFile(queueDir, id),
    runLine,
    injected: false,
    injectionError: '',
    results: [],
    errorLog: [],
  }

  if (dryRun) {
    return {
      ...base,
      mode: 'dry-run',
      commands: commands.map((command) => ({ cmd: command.cmd, verb: command.verb, line: command.line })),
    }
  }

  const file = writeQueueFile(queueDir, id, commands)
  base.file = file

  if (String(config.injection || 'auto') === 'manual') {
    return {
      ...base,
      mode: 'manual',
      hint: `切到群星，按 ${config.consoleKey || '`'} 打开控制台，输入：${runLine}，回车，再按一次关闭。`,
    }
  }

  // 注入
  const sent = await sendConsoleLine(config, runLine)
  base.injected = Boolean(sent.ok)
  base.injectionError = sent.error || ''
  if (!sent.ok) {
    return {
      ...base,
      mode: 'auto',
      failed: 'INJECT_FAILED',
      results: commands.map((command) => ({ cmd: command.cmd, verb: command.verb, status: 'inject-failed' })),
      errorLog: readRecentErrors(join(queueDir, 'logs', 'error.log')),
    }
  }

  // 等 ACK：整批并发等，超时用 config.ackTimeoutMs
  const timeout = Number(config.ackTimeoutMs || 6000)
  const settled = await Promise.all(
    commands.map(async (command) => {
      const ack = await waitAck(state, command.cmd, timeout)
      return {
        cmd: command.cmd,
        verb: command.verb,
        params: command.params,
        status: ack.done ? 'ok' : ack.fail ? 'failed' : ack.recv ? 'partial' : 'no-ack',
        ack,
      }
    }),
  )

  await sleep(Number(config.injectGapMs || 1200))
  base.results = settled
  const needsErrors = settled.some((item) => item.status !== 'ok')
  if (needsErrors) {
    base.errorLog = readRecentErrors(join(queueDir, 'logs', 'error.log'), { sinceMs: Date.now() - 15000 })
  }
  return { ...base, mode: 'auto' }
}

function waitAck(state, cmd, timeoutMs) {
  return new Promise((resolve) => {
    const check = () => {
      const entry = state.ack(cmd)
      return entry
    }
    const start = check()
    if (start.done) return resolve({ recv: true, done: true, fail: false })
    const timer = setTimeout(() => {
      const entry = check()
      resolve({ recv: entry.recv, done: entry.done, fail: Boolean(entry.fail), timedOut: true })
    }, timeoutMs)
    timer.unref?.()
    const onAck = ({ cmd: acked }) => {
      if (acked !== cmd) return
      const entry = check()
      // 收到 done 或 fail 就收工；只收到 recv 时继续等到超时（用来区分 partial）
      if (entry.done || entry.fail) {
        clearTimeout(timer)
        state.off('ack', onAck)
        resolve({ recv: true, done: entry.done, fail: Boolean(entry.fail), timedOut: false })
      }
    }
    state.on('ack', onAck)
  })
}
