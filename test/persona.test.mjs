import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  DEFAULT_PERSONA,
  PRESETS,
  applyPreset,
  mergeImportedPersona,
  normalizePersona,
  parsePersonaImport,
  personaPrompt,
  personaSummary,
} from '../agent/lib/persona.mjs'
import { VoiceLog } from '../agent/lib/voice.mjs'

test('人格：默认值 / 10 个属性 / 归一化 clamp', () => {
  const persona = normalizePersona({ traits: { aggression: 200, caution: -5 } })
  assert.equal(persona.name, '总指挥')
  assert.equal(persona.traits.aggression, 100)
  assert.equal(persona.traits.caution, 0)
  assert.equal(Object.keys(persona.traits).length, 10)
  assert.equal(persona.voice.enabled, true)
  assert.equal(persona.speech.maxChars, 120)
})

test('人格：预设会改属性与文本，但保留导入的组件', () => {
  const withComponent = normalizePersona({
    components: [{ id: 'lore', name: '设定', text: '我来自边境。' }],
  })
  const conqueror = applyPreset(withComponent, 'conqueror')
  assert.equal(conqueror.preset, 'conqueror')
  assert.equal(conqueror.traits.aggression, 88)
  assert.match(conqueror.identity, /碾过银河/)
  assert.equal(conqueror.components.length, 1)
  assert.equal(PRESETS.diplomat.traits.diplomacy, 92)
})

test('人格提示词：包含名字、属性、说话方式与 voice 规则', () => {
  const persona = applyPreset(DEFAULT_PERSONA, 'diplomat')
  const prompt = personaPrompt(persona)
  assert.match(prompt, /你是一个“人”/)
  assert.match(prompt, /织网者/)
  assert.match(prompt, /外交 92\/100/)
  assert.match(prompt, /voice/)
  assert.match(prompt, /TTS/)
  assert.match(prompt, /让对手有台阶下/)
})

test('导入：Character Card V2 映射到人格字段并生成组件', () => {
  const card = JSON.stringify({
    spec: 'chara_card_v2',
    data: {
      name: '灰烬',
      description: '一个从废墟里爬出来的舰队指挥官。',
      personality: '多疑、安静、对背叛零容忍。',
      scenario: '第三次边境战争之后。',
      mes_example: '「我不需要你相信我，只需要你服从。」',
    },
  })
  const imported = parsePersonaImport(card, { filename: 'ash.json' })
  assert.equal(imported.ok, true)
  assert.equal(imported.format, 'chara_card_v2')
  assert.equal(imported.component.name, '灰烬')
  const merged = mergeImportedPersona(DEFAULT_PERSONA, imported)
  assert.equal(merged.name, '灰烬')
  assert.match(merged.identity, /废墟/)
  assert.match(merged.background, /第三次边境战争/)
  assert.ok(merged.components.some((row) => row.name === '灰烬'))
})

test('导入：Markdown/纯文本作为组件，不覆盖现有字段', () => {
  const imported = parsePersonaImport('# 边境口音\n说话带一点矿区口音，喜欢用短句。', { filename: 'accent.md' })
  assert.equal(imported.ok, true)
  assert.equal(imported.format, 'text')
  assert.equal(imported.component.name, '边境口音')
  const merged = mergeImportedPersona(DEFAULT_PERSONA, imported)
  assert.equal(merged.name, DEFAULT_PERSONA.name, '文本组件不改名字')
  assert.equal(merged.components.length, 1)
  assert.match(personaPrompt(merged), /矿区口音/)
})

test('导入：重复组件不会重复添加，摘要只暴露组件元信息', () => {
  const imported = parsePersonaImport('# 口音\n短句。', { filename: 'x.md' })
  let merged = mergeImportedPersona(DEFAULT_PERSONA, imported)
  merged = mergeImportedPersona(merged, imported)
  assert.equal(merged.components.length, 1)
  const summary = personaSummary(merged)
  assert.equal(summary.components[0].text, undefined)
  assert.equal(typeof summary.components[0].chars, 'number')
  assert.equal(typeof summary.promptChars, 'number')
})

test('VoiceLog：push / latest / since 游标 / 落盘', () => {
  const home = mkdtempSync(join(tmpdir(), 'stellaris-voice-'))
  try {
    const log = new VoiceLog({ home })
    const first = log.push({ text: '先看看他们的舰队。', mood: '平静', intent: '观察', turn: 1 })
    const second = log.push({ text: '他们不敢动手。', mood: '轻蔑', turn: 2 })
    assert.ok(first.id && second.id)
    assert.equal(log.latest().text, '他们不敢动手。')
    assert.deepEqual(log.list({ since: first.id }).map((row) => row.id), [second.id])
    assert.equal(log.list({ limit: 1 }).length, 1)
    const file = readFileSync(join(home, 'voice', 'latest.json'), 'utf8')
    assert.match(file, /他们不敢动手/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
