import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { DEFAULT_CONFIG, mergeConfig, defaultConfig, backendOf, migrateLegacyConfig } from '../agent/lib/config.mjs'

test('默认配置包含执行器阈值与 AI 两套后端', () => {
  assert.equal(DEFAULT_CONFIG.executor.pauseWhenQueuedActions, 8)
  assert.equal(DEFAULT_CONFIG.executor.maxAttempts, 3)
  assert.ok(DEFAULT_CONFIG.ai.deepseek)
  assert.ok(DEFAULT_CONFIG.ai.dsh)
  assert.equal(DEFAULT_CONFIG.ai.backend, 'deepseek')
  assert.equal(DEFAULT_CONFIG.units.planets, true)
  assert.equal(DEFAULT_CONFIG.read.eventChainDepth, 6)
})

test('mergeConfig 深合并且不改原对象', () => {
  const base = defaultConfig()
  const merged = mergeConfig(base, { ai: { backend: 'dsh', dsh: { url: 'http://x:1' } }, executor: { maxAttempts: 5 } })
  assert.equal(merged.ai.backend, 'dsh')
  assert.equal(merged.ai.dsh.url, 'http://x:1')
  assert.equal(merged.ai.dsh.autoDiscover, true, '未覆盖的键保留默认值')
  assert.equal(merged.executor.maxAttempts, 5)
  assert.equal(base.ai.backend, 'deepseek', '原对象不应被修改')
})

test('mergeConfig 数组替换而不是拼接', () => {
  const merged = mergeConfig({ list: [1, 2, 3] }, { list: [9] })
  assert.deepEqual(merged.list, [9])
})

test('backendOf 只认 dsh，其余按 deepseek', () => {
  assert.equal(backendOf({ ai: { backend: 'dsh' } }), 'dsh')
  assert.equal(backendOf({ ai: { backend: 'DSH' } }), 'dsh')
  assert.equal(backendOf({ ai: { backend: 'deepseek' } }), 'deepseek')
  assert.equal(backendOf({}), 'deepseek')
})

test('v1 配置迁移：backend/dshUrl/阈值/路径/端口不丢', () => {
  const legacy = {
    stellarisInstallDir: 'E:/games/Stellaris',
    stellarisUserDir: 'D:/docs/Stellaris',
    deepseek: { apiKey: 'sk-x', model: 'deepseek-chat' },
    liveChat: { port: 9000, token: 't', enabled: true },
    swarm: {
      backend: 'dsh',
      dshUrl: 'http://127.0.0.1:52639',
      tickSeconds: 45,
      mainTickSeconds: 90,
      queuePauseThreshold: 12,
      attempts: 4,
      autoUnpause: true,
      objective: '先扩军',
    },
  }
  const migrated = migrateLegacyConfig(legacy)
  assert.equal(migrated.paths.stellarisInstallDir, 'E:/games/Stellaris')
  assert.equal(migrated.paths.stellarisUserDir, 'D:/docs/Stellaris')
  assert.equal(migrated.ai.backend, 'dsh')
  assert.equal(migrated.ai.dsh.url, 'http://127.0.0.1:52639')
  assert.equal(migrated.ai.deepseek.apiKey, 'sk-x')
  assert.equal(migrated.ai.unit.intervalSeconds, 45)
  assert.equal(migrated.ai.main.intervalSeconds, 90)
  assert.equal(migrated.executor.pauseWhenQueuedActions, 12)
  assert.equal(migrated.executor.maxAttempts, 4)
  assert.equal(migrated.executor.autoResume, true)
  assert.equal(migrated.chat.port, 9000)
  assert.equal(migrated.objective, '先扩军')
  // v1 字段仍保留（迁移是叠加，不删用户数据）
  assert.equal(migrated.deepseek.apiKey, 'sk-x')
})

test('v2 配置不再迁移', () => {
  const v2 = { version: 2, ai: { backend: 'deepseek' } }
  assert.equal(migrateLegacyConfig(v2), v2)
})

test('config.example.json 与 DEFAULT_CONFIG 结构一致', () => {
  const example = JSON.parse(readFileSync(new URL('../agent/config.example.json', import.meta.url), 'utf8'))
  const keys = (value) => Object.keys(value).sort()
  assert.deepEqual(keys(example), keys(DEFAULT_CONFIG))
  assert.deepEqual(keys(example.executor), keys(DEFAULT_CONFIG.executor))
  assert.deepEqual(keys(example.ai), keys(DEFAULT_CONFIG.ai))
  assert.deepEqual(keys(example.paths), keys(DEFAULT_CONFIG.paths))
})
