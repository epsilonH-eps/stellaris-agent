import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadTraditionNodes } from '../agent/lib/traditions.mjs'

test('传统定义：解析树内节点、前置关系与本地化名称', () => {
  const root = mkdtempSync(join(tmpdir(), 'stellaris-traditions-'))
  try {
    const dir = join(root, 'common', 'traditions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, '00_adaptability.txt'),
      [
        'tr_adaptability_adopt = {',
        '  modifier = { pop_housing_usage_mult = -0.10 }',
        '}',
        'tr_adaptability_recycling = {',
        '  custom_tooltip = tr_adaptability_recycling_desc',
        '}',
        'tr_adaptability_survival_fittest = {',
        '  possible = { has_tradition = tr_adaptability_recycling }',
        '}',
      ].join('\n'),
      'utf8',
    )
    const loc = join(root, 'localisation', 'simp_chinese')
    mkdirSync(loc, { recursive: true })
    writeFileSync(join(loc, 'traditions_l_simp_chinese.yml'), 'l_simp_chinese:\n tr_adaptability_recycling:0 "强化回收"\n', 'utf8')

    const trees = loadTraditionNodes(root)
    const nodes = trees.tradition_adaptability
    assert.equal(nodes.length, 3)
    assert.equal(nodes.find((node) => node.key === 'tr_adaptability_recycling').name, '强化回收')
    assert.deepEqual(nodes.find((node) => node.key === 'tr_adaptability_survival_fittest').requires, ['tr_adaptability_recycling'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
