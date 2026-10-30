/**
 * 日志增量读取（tail）：只往后读，不重读历史。
 *
 * 为什么不用 fs.watch 就完事：Paradox 的日志是**追加写**，但 Windows 上
 * fs.watch 有合并/丢事件的老毛病；而且游戏重启会截断文件。所以：
 *   - fs.watch 负责「有变化就尽快读」；
 *   - 定时 poll 负责兜底；
 *   - 读的时候看 size：变小 = 文件被截断/轮转 → 偏移归零。
 *
 * 事件：每解析出一条 DSH1 记录就 emit('record', record)。
 *
 * @module dsh-stellaris-bridge/logtail
 */
import { EventEmitter } from 'node:events'
import { closeSync, existsSync, openSync, readSync, statSync, watch } from 'node:fs'
import { parseLine } from './protocol.js'

function readRange(file, start, end) {
  const length = Math.max(0, end - start)
  if (length === 0) return ''
  const buffer = Buffer.allocUnsafe(length)
  const fd = openSync(file, 'r')
  try {
    let read = 0
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, start + read)
      if (n <= 0) break
      read += n
    }
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

export class LogTail extends EventEmitter {
  /**
   * @param {object} options
   * @param {string} options.file
   * @param {number} [options.maxBackfillBytes] 首次读取时最多回看多少
   * @param {number} [options.pollMs]
   */
  constructor(options) {
    super()
    this.file = options.file
    this.maxBackfillBytes = options.maxBackfillBytes ?? 512 * 1024
    this.pollMs = options.pollMs ?? 1500
    this.offset = null
    this.partial = ''
    this.watcher = null
    this.timer = null
    this.reading = false
    this.stats = { lines: 0, records: 0, dropped: 0, reads: 0, resets: 0, lastReadAt: 0, lastError: '' }
  }

  start() {
    this.stop()
    // 首次：从文件尾回看一段，既不会漏掉刚写的那批，也不会把几十兆读进来
    try {
      const stat = statSync(this.file)
      this.offset = Math.max(0, stat.size - this.maxBackfillBytes)
      this.partial = ''
    } catch {
      this.offset = 0
      this.partial = ''
    }
    try {
      this.watcher = watch(this.file, { persistent: false }, () => this._schedule())
    } catch {
      this.watcher = null
    }
    this.timer = setInterval(() => this._schedule(), this.pollMs)
    this.timer.unref?.()
    // 先同步读一次，保证 CLI 启动后立刻 brief/status 就能看到数据
    this.pump()
    this._schedule()
    return this
  }

  stop() {
    if (this.watcher) {
      try {
        this.watcher.close()
      } catch {
        /* ignore */
      }
      this.watcher = null
    }
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  _schedule() {
    if (this.reading) return
    this.reading = true
    setImmediate(() => {
      try {
        this.pump()
      } catch (error) {
        this.stats.lastError = String(error?.message || error)
        this.emit('error', error)
      } finally {
        this.reading = false
      }
    })
  }

  /** 同步读一次（也供测试直接调用）。 */
  pump() {
    if (!existsSync(this.file)) return 0
    const stat = statSync(this.file)
    if (this.offset === null) this.offset = Math.max(0, stat.size - this.maxBackfillBytes)
    if (stat.size < this.offset) {
      // 文件被截断（游戏重启）：从头来，但别把 partial 拼进去
      this.offset = 0
      this.partial = ''
      this.stats.resets += 1
    }
    if (stat.size === this.offset) return 0
    const chunk = readRange(this.file, this.offset, stat.size)
    this.offset = stat.size
    this.stats.reads += 1
    this.stats.lastReadAt = Date.now()
    const text = this.partial + chunk
    const parts = text.split('\n')
    this.partial = parts.pop() ?? ''
    let emitted = 0
    for (const line of parts) {
      this.stats.lines += 1
      const record = parseLine(line)
      if (!record) continue
      this.stats.records += 1
      emitted += 1
      this.emit('record', record)
    }
    return emitted
  }
}

/**
 * 从 error.log 尾部找脚本错误（桥在 ACK 只到 recv 时用来解释原因）。
 * @param {string} file
 * @param {{sinceMs?: number, maxBytes?: number}} [options]
 * @returns {string[]}
 */
export function readRecentErrors(file, options = {}) {
  const maxBytes = options.maxBytes ?? 64 * 1024
  const since = options.sinceMs ?? 0
  if (!existsSync(file)) return []
  let stat
  try {
    stat = statSync(file)
  } catch {
    return []
  }
  const start = Math.max(0, stat.size - maxBytes)
  let text = ''
  try {
    text = readRange(file, start, stat.size)
  } catch {
    return []
  }
  const lines = text.split(/\r?\n/).filter(Boolean)
  const hits = []
  for (const line of lines) {
    // 群星错误行通常带 [HH:MM:SS] 前缀；有 since 时只按「最近的 N 行」近似过滤
    if (/script error|unknown effect|invalid|error/i.test(line)) hits.push(line.trim())
  }
  if (!since) return hits.slice(-20)
  return hits.slice(-40)
}
