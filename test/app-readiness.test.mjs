import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { App } from '../agent/lib/app.mjs'
import { DEFAULT_CONFIG } from '../agent/lib/config.mjs'

function withTempHome(run) {
  const home = mkdtempSync(join(tmpdir(), 'stellaris-app-'))
  const previous = process.env.STELLARIS_AGENT_HOME
  process.env.STELLARIS_AGENT_HOME = home
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG))
  config.ai.deepseek.apiKey = ''
  config.bridge.autoInject = false
  config.bridge.autoStartOrchestrator = false
  writeFileSync(join(home, 'config.json'), JSON.stringify(config, null, 2), 'utf8')
  return Promise.resolve()
    .then(() => run(home))
    .finally(() => {
      if (previous === undefined) delete process.env.STELLARIS_AGENT_HOME
      else process.env.STELLARIS_AGENT_HOME = previous
      rmSync(home, { recursive: true, force: true })
    })
}

test('App.readiness：DeepSeek 未配 Key → 大模型未连接；游戏不在 → 游戏未连接', async () => {
  await withTempHome(async (home) => {
    const app = new App({ home, log: () => {} })
    const readiness = await app.readiness({ force: true })
    assert.equal(readiness.llm.backend, 'deepseek')
    assert.equal(readiness.llm.ok, false)
    assert.match(readiness.llm.detail, /API Key/)
    assert.equal(typeof readiness.game.ok, 'boolean')
    assert.equal(readiness.game.running, false)
    assert.equal(readiness.autoInject, false)
    assert.equal(readiness.autoStart, false)
    app.stopWatcher()
  })
})

test('App.readiness：验证模式在没 Key 时不会联网，也不会抛异常', async () => {
  await withTempHome(async (home) => {
    const app = new App({ home, log: () => {} })
    const readiness = await app.readiness({ force: true, verifyLlm: true })
    assert.equal(readiness.llm.ok, false)
    assert.equal(readiness.llm.verified, null)
    app.stopWatcher()
  })
})

test('App：看护循环在 autoInject/autoStart 都关闭时不做任何事', async () => {
  await withTempHome(async (home) => {
    const app = new App({ home, log: () => {} })
    await app.tickWatcher()
    assert.equal(app.running, false)
    assert.equal(app.lastConnect, null)
    app.stopWatcher()
  })
})

test('App.status：暴露 readiness/lastConnect/watcher 字段', async () => {
  await withTempHome(async (home) => {
    const app = new App({ home, log: () => {} })
    await app.readiness({ force: true })
    const status = app.status()
    assert.ok('readiness' in status)
    assert.ok('lastConnect' in status)
    assert.equal(status.watcher.running, false)
    assert.equal(status.watcher.seconds, 15)
    app.stopWatcher()
  })
})
