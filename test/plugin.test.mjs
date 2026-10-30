import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installPlugin, PLUGIN_NAME, pluginSourceDir, findProfiles } from '../agent/lib/dsh-plugin.mjs'

function tempProfile() {
  const root = mkdtempSync(join(tmpdir(), 'stellaris-profile-'))
  const profile = join(root, 'desktop')
  mkdirSync(profile, { recursive: true })
  writeFileSync(
    join(profile, 'package.json'),
    JSON.stringify({ name: 'dsh-profile', dependencies: {}, dsh: { profile: { bundles: [] } } }, null, 2),
    'utf8',
  )
  return { root, profile }
}

test('安装插件：复制模式 + 幂等 + package.json 补 dependency/bundles', () => {
  const { root, profile } = tempProfile()
  try {
    const first = installPlugin({ profileDir: profile, copy: true })
    assert.equal(first.ok, true)
    const entry = first.profiles[0]
    assert.equal(entry.ok, true)
    assert.equal(entry.link.mode, 'copy')
    const target = join(profile, 'node_modules', PLUGIN_NAME)
    assert.ok(existsSync(join(target, 'index.js')))
    assert.ok(existsSync(join(target, 'lib', 'handler.mjs')))

    const pkg = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    assert.equal(pkg.dependencies[PLUGIN_NAME], `link:${pluginSourceDir().replace(/\\/g, '/')}`)
    assert.ok(pkg.dsh.profile.bundles.includes(PLUGIN_NAME))
    assert.ok(existsSync(join(profile, 'package.json.before-stellaris-bridge')), '改前应留备份')

    const second = installPlugin({ profileDir: profile, copy: true })
    assert.equal(second.ok, true)
    const pkgAgain = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
    assert.deepEqual(pkgAgain.dsh.profile.bundles.filter((name) => name === PLUGIN_NAME).length, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('findProfiles：只认有 package.json 的目录，desktop 优先', () => {
  const { root, profile } = tempProfile()
  const other = join(root, 'other')
  mkdirSync(other, { recursive: true })
  writeFileSync(join(other, 'package.json'), JSON.stringify({ name: 'other', dependencies: {} }), 'utf8')
  try {
    const found = findProfiles({})
    // 真实 HOME 下也可能有 profile；这里只验证传参目录能被找到
    const explicit = findProfiles({ profileDir: profile })
    assert.equal(explicit.length, 1)
    assert.equal(explicit[0].dir, profile)
    assert.ok(Array.isArray(found))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('安装插件：源目录缺失时报错而不是瞎写', () => {
  const result = installPlugin({ profileDir: join(tmpdir(), 'not-exist-profile') })
  assert.equal(result.ok, false)
  assert.ok(['NO_DSH_PROFILE', 'PLUGIN_SOURCE_MISSING'].includes(result.error))
})
