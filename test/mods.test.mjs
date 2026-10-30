import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { listMods, parseDescriptor, readDlcLoad, modsDigest } from '../agent/lib/mods.mjs'

function tempRoot() {
  return mkdtempSync(join(tmpdir(), 'stellaris-mods-'))
}

test('parseDescriptor 读 name/version/supported_version/path', () => {
  const root = tempRoot()
  try {
    const file = join(root, 'x.mod')
    writeFileSync(
      file,
      ['version="1.2.3"', 'tags={', '\t"Gameplay"', '}', 'name="Test Mod"', 'supported_version="4.5.*"', 'path="mod/test_mod"'].join('\n'),
      'utf8',
    )
    const fields = parseDescriptor(file)
    assert.equal(fields.name, 'Test Mod')
    assert.equal(fields.version, '1.2.3')
    assert.equal(fields.supported_version, '4.5.*')
    assert.equal(fields.path, 'mod/test_mod')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listMods：本地模组 + dlc_load 启用判定 + DLC', () => {
  const root = tempRoot()
  try {
    const userDir = join(root, 'user')
    const installDir = join(root, 'game')
    mkdirSync(join(userDir, 'mod'), { recursive: true })
    mkdirSync(join(installDir, 'dlc', 'dlc_megacorp'), { recursive: true })
    writeFileSync(
      join(userDir, 'mod', 'test_mod.mod'),
      ['name="Test Mod"', 'version="1.0"', 'supported_version="4.5.*"', 'path="mod/test_mod"'].join('\n'),
      'utf8',
    )
    writeFileSync(join(userDir, 'mod', 'disabled.mod'), ['name="Off Mod"', 'path="mod/off"'].join('\n'), 'utf8')
    writeFileSync(join(userDir, 'dlc_load.json'), JSON.stringify({ enabled_mods: ['mod/test_mod.mod'], disabled_dlc: [] }), 'utf8')
    writeFileSync(join(installDir, 'dlc', 'dlc_megacorp', 'descriptor.mod'), 'name="Megacorp"\nversion="4.5"', 'utf8')

    const mods = listMods({ userDir, installDir })
    assert.equal(mods.total, 2)
    assert.equal(mods.enabled, 1)
    const enabled = mods.mods.find((mod) => mod.enabled)
    assert.equal(enabled.name, 'Test Mod')
    assert.equal(enabled.source, 'local')
    assert.equal(enabled.id, 'test_mod')
    assert.equal(mods.dlcs.length, 1)
    assert.equal(mods.dlcs[0].name, 'Megacorp')
    assert.equal(mods.dlcs[0].enabled, true)
    const digest = modsDigest(mods)
    assert.equal(digest.enabled, 1)
    assert.equal(digest.mods[0].name, 'Test Mod')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('listMods：没有 dlc_load 时全部视为未启用，不崩', () => {
  const root = tempRoot()
  try {
    const userDir = join(root, 'user')
    mkdirSync(join(userDir, 'mod'), { recursive: true })
    writeFileSync(join(userDir, 'mod', 'a.mod'), 'name="A"', 'utf8')
    const mods = listMods({ userDir, installDir: join(root, 'missing') })
    assert.equal(mods.dlcLoad.found, false)
    assert.equal(mods.total, 1)
    assert.equal(mods.enabled, 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readDlcLoad 容错坏 JSON', () => {
  const root = tempRoot()
  try {
    writeFileSync(join(root, 'dlc_load.json'), '{oops', 'utf8')
    const data = readDlcLoad(root)
    assert.equal(data.found, false)
    assert.deepEqual(data.enabled_mods, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('创意工坊模组：从 installDir 推导 281990 目录并按 ugc id 匹配启用', () => {
  const root = tempRoot()
  try {
    const userDir = join(root, 'user')
    const installDir = join(root, 'lib', 'steamapps', 'common', 'Stellaris')
    const workshop = join(root, 'lib', 'steamapps', 'workshop', 'content', '281990', '123456')
    mkdirSync(workshop, { recursive: true })
    mkdirSync(join(userDir, 'mod'), { recursive: true })
    writeFileSync(join(workshop, 'descriptor.mod'), 'name="Workshop Mod"\nremote_file_id="123456"', 'utf8')
    writeFileSync(join(userDir, 'dlc_load.json'), JSON.stringify({ enabled_mods: ['mod/ugc_281990_123456.mod'] }), 'utf8')
    const mods = listMods({ userDir, installDir })
    const found = mods.mods.find((mod) => mod.source === 'workshop')
    assert.ok(found)
    assert.equal(found.name, 'Workshop Mod')
    assert.equal(found.enabled, true)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
