/**
 * 每个存档一个主会话：
 *   - 存档身份 `saveIdentity()` → saveKey / sessionId；
 *   - 本地主会话历史 `<home>/main-sessions/<saveKey>.json`；
 *   - DSH session id 由 saveKey 决定（`stellaris-main-<hash>`），重启后仍能 resume。
 *
 * @module stellaris-agent/main-sessions
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export class MainSessionStore {
  constructor({ home, log = () => {} } = {}) {
    this.home = home
    this.dir = join(home, 'main-sessions')
    this.log = log
  }

  ensureDir() {
    mkdirSync(this.dir, { recursive: true })
    return this.dir
  }

  _file(key) {
    return join(this.dir, `${String(key || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '_')}.json`)
  }

  load(key) {
    try {
      const file = this._file(key)
      if (!existsSync(file)) return null
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (!data || typeof data !== 'object') return null
      return data
    } catch (error) {
      this.log('main-sessions.load.failed', { key, error: String(error?.message || error) })
      return null
    }
  }

  save(key, state) {
    try {
      this.ensureDir()
      const file = this._file(key)
      writeFileSync(file, `${JSON.stringify({ ...state, key, updatedAt: Date.now() }, null, 2)}\n`, 'utf8')
      return file
    } catch (error) {
      this.log('main-sessions.save.failed', { key, error: String(error?.message || error) })
      return null
    }
  }

  list() {
    try {
      return readdirSync(this.dir)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
          try {
            return JSON.parse(readFileSync(join(this.dir, name), 'utf8'))
          } catch {
            return null
          }
        })
        .filter(Boolean)
    } catch {
      return []
    }
  }
}
