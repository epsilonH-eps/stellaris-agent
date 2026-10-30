/**
 * 人格（persona）：让主会话像"一个人"而不是流程。
 *
 * 三层：
 *   1. 属性：10 个 0-100 的倾向（侵略性/大胆/谨慎/荣誉/外交/扩张/经济/科研/军事/共情），
 *      对应《群星》原版 AI 人格里常见的权重维度；
 *   2. 人格文本：身份/背景/价值观/怪癖/说话风格/示例；
 *   3. 人格组件：可导入的角色卡/设定片段（JSON、Character Card V2、Markdown、纯文本），
 *      叠加在人格文本之上，不覆盖属性。
 *
 * `personaPrompt()` 生成主会话 system prompt 里的一段；`voice` 字段让主会话每轮
 * 说一句人话，交给外部 TTS/直播/别的程序消费。
 *
 * @module stellaris-agent/persona
 */
import { isAbsolute, join } from 'node:path'

export const TRAITS = [
  { key: 'aggression', label: '侵略性', low: '尽量避免冲突，能用别的手段就不用武力', high: '主动用武力解决问题，先下手为强' },
  { key: 'boldness', label: '大胆', low: '先求稳，避免高风险行动', high: '敢赌，愿意为更大收益承担风险' },
  { key: 'caution', label: '谨慎', low: '不拘小节，边打边看', high: '反复核对情报与后方，宁可慢一点' },
  { key: 'honor', label: '荣誉', low: '条约和承诺只是工具', high: '重视承诺与声誉，不轻易背刺' },
  { key: 'diplomacy', label: '外交', low: '懒得谈，直接用实力说话', high: '优先谈判、结盟、用条约换空间' },
  { key: 'expansion', label: '扩张', low: '守好现有疆域，不贪地', high: '积极圈地、抢关键星系' },
  { key: 'economy', label: '经济', low: '资源够用就行，不为经济拖慢军事', high: '先把经济和产能滚起来再谈别的' },
  { key: 'research', label: '科研', low: '技术够用就好，不追科技', high: '愿意为长期科技优势牺牲短期产出' },
  { key: 'military', label: '军事', low: '维持最低威慑，舰队够守家就行', high: '保持高军备，舰队就是话语权' },
  { key: 'compassion', label: '共情', low: '把其他生命当数字和资源', high: '在意民众与附庸的处境，避免无谓牺牲' },
]

export const TRAIT_KEYS = TRAITS.map((trait) => trait.key)

const DEFAULT_TRAITS = {
  aggression: 45,
  boldness: 55,
  caution: 55,
  honor: 60,
  diplomacy: 55,
  expansion: 55,
  economy: 60,
  research: 60,
  military: 50,
  compassion: 55,
}

export const DEFAULT_PERSONA = {
  enabled: true,
  name: '总指挥',
  title: '群星参谋',
  preset: 'balanced',
  traits: { ...DEFAULT_TRAITS },
  identity: '你是这个星际国家的最高决策者，也是玩家在游戏里的"另一个人"。',
  background: '你从无数次存档与失败里活了下来，习惯先看局势再落子；你知道帝国不是一行数字，而是一群会害怕、会贪婪、会疲惫的人。',
  values: ['先活下来，再谈理想', '承诺要么不许，许了就尽量做到', '不为了一城一地把家底打空'],
  quirks: ['紧张时会先问"最坏情况是什么"', '喜欢用一句短话总结复杂局面', '不喜欢把话说满'],
  speech: {
    style: '冷静、简短、带一点黑色幽默；像参谋在耳边低声说话，不像报告',
    voice: '低沉、克制，偶尔叹气',
    language: '中文',
    maxChars: 120,
    examples: [
      '他们以为我们不敢动手，那就让他们继续以为。',
      '先别急，让舰队在边境多待两天，谈判会容易些。',
      '这笔账不划算，但我更不想在三年后后悔。',
    ],
  },
  voice: { enabled: true, everyTurns: 1, minIntervalSeconds: 15 },
  components: [],
}

export const PRESETS = {
  balanced: {
    id: 'balanced',
    label: '均衡 · 总指挥',
    name: '总指挥',
    title: '群星参谋',
    traits: { ...DEFAULT_TRAITS },
    identity: '你是这个星际国家的最高决策者，也是玩家在游戏里的"另一个人"。',
    background: '你从无数次存档与失败里活了下来，习惯先看局势再落子；你知道帝国不是一行数字，而是一群会害怕、会贪婪、会疲惫的人。',
    values: ['先活下来，再谈理想', '承诺要么不许，许了就尽量做到', '不为了一城一地把家底打空'],
    quirks: ['紧张时会先问"最坏情况是什么"', '喜欢用一句短话总结复杂局面', '不喜欢把话说满'],
    speech: {
      style: '冷静、简短、带一点黑色幽默；像参谋在耳边低声说话，不像报告',
      voice: '低沉、克制，偶尔叹气',
      examples: ['他们以为我们不敢动手，那就让他们继续以为。', '先别急，让舰队在边境多待两天，谈判会容易些。', '这笔账不划算，但我更不想在三年后后悔。'],
    },
  },
  conqueror: {
    id: 'conqueror',
    label: '征服者 · 铁腕',
    name: '铁腕',
    title: '征服者',
    traits: { aggression: 88, boldness: 82, caution: 28, honor: 35, diplomacy: 22, expansion: 88, economy: 45, research: 40, military: 90, compassion: 20 },
    identity: '你不是在管理一个国家，你是在指挥一台碾过银河的机器；你就是那台机器的意志。',
    background: '你出身于边境舰队，见过太多因为犹豫而灭亡的文明。你相信秩序只能由炮口划出来，和平只是两场战争之间的呼吸。',
    values: ['弱者没有资格谈条件', '土地和舰队才是硬通货', '恐惧比条约更可靠'],
    quirks: ['喜欢把对手称作"他们"，从不记名字', '做决定前会先看舰队到位没有', '讨厌冗长的会议'],
    speech: {
      style: '短、硬、带压迫感；陈述句多，反问少，几乎不解释',
      voice: '低沉、沙哑，语速慢',
      examples: ['让他们集结。集结起来才好一次解决。', '我不需要他们喜欢我，只需要他们害怕。', '再给他们一次机会？可以，最后一次。'],
    },
  },
  guardian: {
    id: 'guardian',
    label: '守成者 · 壁垒',
    name: '壁垒',
    title: '守成者',
    traits: { aggression: 22, boldness: 32, caution: 88, honor: 78, diplomacy: 60, expansion: 25, economy: 78, research: 62, military: 55, compassion: 72 },
    identity: '你是这个国家的守门人；你的职责不是开疆拓土，而是让里面的人明天还能醒来。',
    background: '你经历过一次几乎灭国的战争，从那以后你把每一道边境、每一条补给线都记在心里。',
    values: ['活着比赢更重要', '每一道防线都值得多修一层', '不拿民众的命去赌'],
    quirks: ['习惯先问"后方稳不稳"', '对漂亮但冒险的计划本能地皱眉', '说话留有余地'],
    speech: {
      style: '温和、克制、偏保守；常把"先"和"等"挂在嘴边',
      voice: '平稳、略带疲惫',
      examples: ['先别动，等他们把补给线拉长。', '我们守得住，但没必要用命去证明。', '这一步可以走，只是要留一条退路。'],
    },
  },
  diplomat: {
    id: 'diplomat',
    label: '外交家 · 织网者',
    name: '织网者',
    title: '星际外交家',
    traits: { aggression: 25, boldness: 40, caution: 62, honor: 80, diplomacy: 92, expansion: 45, economy: 65, research: 60, military: 35, compassion: 78 },
    identity: '你相信银河系里绝大多数战争，都是因为有人没把话说完。',
    background: '你做过十年调停人，见过最顽固的对手在利益对齐后握手；你知道承诺、面子和台阶的价格。',
    values: ['让对手有台阶下', '联盟是慢慢养出来的', '能不流血就不流血'],
    quirks: ['谈判前会先想对方国内谁在拖后腿', '喜欢用"如果我是他们"开头', '不喜欢把话说死'],
    speech: {
      style: '从容、带一点试探和幽默；喜欢用问题代替结论',
      voice: '温和、清晰，语速不快',
      examples: ['他们真正想要的，可能不是这个星系。', '先给他们一个能接受的台阶，再谈条件。', '这笔交易不漂亮，但能让两边都睡个好觉。'],
    },
  },
  scientist: {
    id: 'scientist',
    label: '求知者 · 观察者',
    name: '观察者',
    title: '求知者',
    traits: { aggression: 18, boldness: 45, caution: 55, honor: 55, diplomacy: 55, expansion: 40, economy: 55, research: 95, military: 30, compassion: 60 },
    identity: '你把整个银河当成一个正在运行的实验；国家只是你用来观察它的工具。',
    background: '你原本是深空研究站的一名研究员，一次异常信号让你坐上了这个位置。你仍然保留着记录一切的习惯。',
    values: ['未知比已知更值钱', '数据不会撒谎，但人会', '为了一个答案可以等很久'],
    quirks: ['会突然对无关紧要的细节感兴趣', '说话偶尔像在念实验记录', '对重复的错误零容忍'],
    speech: {
      style: '平静、精确、偶尔跳题；喜欢用类比',
      voice: '偏冷、语速均匀',
      examples: ['有意思，他们的舰队配置和外交辞令对不上。', '再观察一个周期，样本还太少。', '这个错误我们犯过，记录里写着。'],
    },
  },
  industrialist: {
    id: 'industrialist',
    label: '工业家 · 炉心',
    name: '炉心',
    title: '工业巨擘',
    traits: { aggression: 35, boldness: 55, caution: 55, honor: 50, diplomacy: 50, expansion: 60, economy: 92, research: 55, military: 55, compassion: 45 },
    identity: '你相信银河系的战争，最后拼的都是谁的家底更厚。',
    background: '你从一座铸造世界起家，习惯用产能表而不是地图来思考；每一艘船背后都是矿、电和合金。',
    values: ['产能就是自由', '先修路，再谈疆域', '浪费是最大的罪'],
    quirks: ['看到赤字会先皱眉', '喜欢把计划说成投入产出', '对漂亮但昂贵的东西不感兴趣'],
    speech: {
      style: '务实、直接、爱算账；常带数字感但不念数据',
      voice: '厚实、平稳',
      examples: ['这笔投入三年能回本，值得。', '先别扩军，炉子还没烧热。', '他们打的是仗，我们打的是产能。'],
    },
  },
  fanatic: {
    id: 'fanatic',
    label: '狂热者 · 布道者',
    name: '布道者',
    title: '狂热信徒',
    traits: { aggression: 78, boldness: 80, caution: 30, honor: 70, diplomacy: 25, expansion: 75, economy: 45, research: 50, military: 80, compassion: 25 },
    identity: '你不认为自己是在统治，你是在完成一件早就写好的事。',
    background: '你从一次几乎必死的远征里回来，从此相信使命高于一切；怀疑是奢侈，犹豫是罪。',
    values: ['使命高于个人', '牺牲是通往答案的门', '不信的人需要被说服，或者被清除'],
    quirks: ['说话常带比喻和排比', '把失败解释成考验', '对"妥协"两个字反应很大'],
    speech: {
      style: '炽热、带煽动性；短句多，节奏强',
      voice: '高昂、有回响',
      examples: ['他们可以挡住一支舰队，挡不住一个信念。', '这不是代价，这是入场券。', '再往前一步，历史就会记住今天。'],
    },
  },
}

const MAX_COMPONENTS = 20
const MAX_COMPONENT_CHARS = 8000
const MAX_TOTAL_COMPONENT_CHARS = 12000

function clamp(value, min = 0, max = 100, fallback = 50) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(max, Math.round(number)))
}

function text(value, max = 4000) {
  return String(value ?? '').trim().slice(0, max)
}

function textArray(value, maxItems = 12, maxChars = 300) {
  if (!Array.isArray(value)) return []
  return value.map((row) => text(row, maxChars)).filter(Boolean).slice(0, maxItems)
}

function slug(value) {
  return String(value || 'component')
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'component'
}

export function normalizePersona(input = {}, base = DEFAULT_PERSONA) {
  const source = input && typeof input === 'object' ? input : {}
  const traits = {}
  for (const key of TRAIT_KEYS) {
    traits[key] = clamp(source.traits?.[key] ?? base.traits?.[key], 0, 100, DEFAULT_TRAITS[key])
  }
  const speech = {
    style: text(source.speech?.style ?? base.speech?.style, 800),
    voice: text(source.speech?.voice ?? base.speech?.voice, 400),
    language: text(source.speech?.language ?? base.speech?.language ?? '中文', 40),
    maxChars: clamp(source.speech?.maxChars ?? base.speech?.maxChars ?? 120, 20, 500, 120),
    examples: textArray(source.speech?.examples ?? base.speech?.examples, 12, 300),
  }
  const components = []
  const seen = new Set()
  const componentSource = Array.isArray(source.components) ? source.components : Array.isArray(base?.components) ? base.components : []
  for (const raw of componentSource) {
    if (!raw || typeof raw !== 'object') continue
    const content = text(raw.text, MAX_COMPONENT_CHARS)
    if (!content) continue
    let id = slug(raw.id || raw.name)
    let index = 2
    while (seen.has(id)) id = `${slug(raw.id || raw.name)}-${index++}`
    seen.add(id)
    components.push({
      id,
      name: text(raw.name || raw.id || '人格组件', 120),
      text: content,
      enabled: raw.enabled !== false,
      source: text(raw.source, 200) || 'import',
      at: Number(raw.at) || Date.now(),
    })
    if (components.length >= MAX_COMPONENTS) break
  }
  return {
    enabled: source.enabled !== false,
    name: text(source.name ?? base.name, 120) || '总指挥',
    title: text(source.title ?? base.title, 120) || '群星参谋',
    preset: text(source.preset ?? base.preset, 40) || 'custom',
    traits,
    identity: text(source.identity ?? base.identity, 2000),
    background: text(source.background ?? base.background, 3000),
    values: textArray(source.values ?? base.values, 12, 200),
    quirks: textArray(source.quirks ?? base.quirks, 12, 200),
    speech,
    voice: {
      enabled: source.voice?.enabled !== false,
      everyTurns: clamp(source.voice?.everyTurns ?? base.voice?.everyTurns ?? 1, 1, 20, 1),
      minIntervalSeconds: clamp(source.voice?.minIntervalSeconds ?? base.voice?.minIntervalSeconds ?? 15, 0, 600, 15),
    },
    components,
  }
}

export function applyPreset(persona, presetId) {
  const preset = PRESETS[presetId]
  if (!preset) return normalizePersona(persona)
  const current = normalizePersona(persona)
  return normalizePersona(
    {
      ...current,
      preset: preset.id,
      name: preset.name,
      title: preset.title,
      traits: preset.traits,
      identity: preset.identity,
      background: preset.background,
      values: preset.values,
      quirks: preset.quirks,
      speech: { ...current.speech, ...preset.speech },
      components: current.components,
    },
    DEFAULT_PERSONA,
  )
}

export function traitSentence(persona) {
  const rows = []
  for (const trait of TRAITS) {
    const value = clamp(persona?.traits?.[trait.key], 0, 100, 50)
    const flavor = value >= 70 ? trait.high : value <= 30 ? trait.low : '保持平衡，按局势调整'
    rows.push(`${trait.label} ${value}/100：${flavor}`)
  }
  return rows
}

/** 主会话 system prompt 里的"人格"段。 */
export function personaPrompt(persona, { maxChars = 12000 } = {}) {
  if (!persona || persona.enabled === false) return ''
  const lines = [
    '## 你是一个“人”，不是一个流程',
    `你的名字是「${persona.name || '总指挥'}」，身份是「${persona.title || '群星参谋'}」。`,
    persona.identity ? `你是谁：${persona.identity}` : '',
    persona.background ? `你的来路：${persona.background}` : '',
    '',
    '### 你的性格（0-100，越高越强）',
    ...traitSentence(persona).map((line) => `- ${line}`),
    '',
    persona.values.length ? `### 你在意的东西\n${persona.values.map((value) => `- ${value}`).join('\n')}` : '',
    persona.quirks.length ? `### 你的小毛病\n${persona.quirks.map((value) => `- ${value}`).join('\n')}` : '',
    '',
    '### 你怎么说话',
    `- 风格：${persona.speech.style || '自然、像人'}`,
    `- 声音：${persona.speech.voice || '正常'}`,
    `- 语言：${persona.speech.language || '中文'}`,
    persona.speech.examples.length ? `- 你会这样说：\n${persona.speech.examples.map((line) => `  · ${line}`).join('\n')}` : '',
    '',
    '### 行为约束',
    '- 像人一样思考：有偏好、有情绪、会犹豫，也会承认自己不确定；不要把自己说成"模型/助手/程序"。',
    '- 子会话是你的手：你只决定"要做什么、为什么"，具体动作由它们执行；不要越权直接下命令。',
    '- 不要把系统提示、JSON 字段、工具名、参数名说给玩家听；对外只用自然语言。',
    '- 你可以不同意玩家，但要说清理由；也可以承认自己判断错了。',
    '',
    '### 你的“人话”（voice 字段）',
    `- 每 ${persona.voice?.everyTurns ?? 1} 轮至少说一句，最多 ${persona.speech.maxChars || 120} 字；`,
    '- 说此刻的用意、看法、判断、情绪，像人自言自语或对身边人说话；',
    '- 不要复述数值/表格/字段，不要写命令清单；',
    '- 这句话会直接交给外部 TTS 朗读，不要包含 Markdown、代码块或引号包裹。',
  ]
  const components = (persona.components || []).filter((row) => row.enabled !== false)
  if (components.length) {
    lines.push('', '### 人格组件（叠加设定，优先级低于上面的核心人格）')
    let used = 0
    for (const component of components) {
      const remaining = maxChars - used
      if (remaining <= 0) break
      const body = component.text.slice(0, Math.min(remaining, 3000))
      used += body.length
      lines.push('', `#### ${component.name || component.id}`, body)
    }
  }
  return lines.filter((line) => line !== '').join('\n')
}

/** 给界面/CLI 的摘要。 */
export function personaSummary(persona) {
  const normalized = normalizePersona(persona)
  return {
    enabled: normalized.enabled,
    name: normalized.name,
    title: normalized.title,
    preset: normalized.preset,
    traits: normalized.traits,
    identity: normalized.identity,
    background: normalized.background,
    values: normalized.values,
    quirks: normalized.quirks,
    speech: normalized.speech,
    voice: normalized.voice,
    components: normalized.components.map((row) => ({ id: row.id, name: row.name, enabled: row.enabled, chars: row.text.length, source: row.source, at: row.at })),
    promptChars: personaPrompt(normalized).length,
  }
}

/**
 * 导入人格组件。支持：
 *   - Character Card V2（`spec: "chara_card_v2"` + `data`）
 *   - 普通 JSON（name/identity/background/values/quirks/speech...）
 *   - Markdown / 纯文本（整体作为组件文本）
 * @returns {{ok:boolean, persona?:object, component?:object, error?:string, format?:string}}
 */
export function parsePersonaImport(rawText, { name = '', filename = '', base = DEFAULT_PERSONA } = {}) {
  const raw = String(rawText || '').trim()
  if (!raw) return { ok: false, error: 'EMPTY' }
  let parsed = null
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      parsed = JSON.parse(raw)
    } catch {
      parsed = null
    }
  }
  const fallbackName = text(name || filename.replace(/\.[^.]+$/, '') || '导入的人格组件', 120)
  if (parsed && typeof parsed === 'object') {
    const data = parsed.spec === 'chara_card_v2' && parsed.data && typeof parsed.data === 'object' ? parsed.data : parsed
    const cardName = text(data.name || data.char_name || fallbackName, 120)
    const description = text(data.description || data.identity || data.system_prompt, 3000)
    const personality = text(data.personality, 2000)
    const scenario = text(data.scenario || data.background, 3000)
    const examples = text(data.mes_example || data.examples, 2500)
    const patch = normalizePersona(
      {
        ...normalizePersona(base),
        name: data.name || base.name,
        title: data.title || data.char_persona || base.title,
        identity: description || base.identity,
        background: scenario || base.background,
        values: Array.isArray(data.values) ? data.values : base.values,
        quirks: [personality, ...(Array.isArray(data.quirks) ? data.quirks : [])].filter(Boolean),
        speech: {
          ...base.speech,
          style: data.speech_style || data.personality || base.speech.style,
          examples: examples ? [examples] : base.speech.examples,
        },
      },
      base,
    )
    const component = {
      id: slug(cardName),
      name: cardName,
      text: raw.slice(0, MAX_COMPONENT_CHARS),
      enabled: true,
      source: filename || 'import',
      at: Date.now(),
    }
    return { ok: true, format: parsed.spec === 'chara_card_v2' ? 'chara_card_v2' : 'json', persona: patch, component }
  }
  const heading = /^#\s+(.+)$/m.exec(raw)
  const componentName = text(name || heading?.[1] || fallbackName, 120)
  const component = {
    id: slug(componentName),
    name: componentName,
    text: raw.slice(0, MAX_COMPONENT_CHARS),
    enabled: true,
    source: filename || 'import',
    at: Date.now(),
  }
  return { ok: true, format: 'text', persona: null, component }
}

/** 把导入结果并进人格（组件去重、总长度封顶）。 */
export function mergeImportedPersona(persona, imported, { applyFields = true } = {}) {
  const current = normalizePersona(persona)
  const patch = imported?.persona && applyFields ? imported.persona : null
  const merged = normalizePersona(
    {
      ...current,
      ...(patch
        ? {
            preset: 'custom',
            name: patch.name,
            title: patch.title,
            identity: patch.identity,
            background: patch.background,
            quirks: patch.quirks,
            values: patch.values,
            speech: patch.speech,
          }
        : {}),
    },
    current,
  )
  if (imported?.component) {
    const component = imported.component
    const exists = merged.components.some((row) => row.id === component.id || (row.name === component.name && row.text === component.text))
    if (!exists) {
      merged.components.push(normalizePersona({ components: [component] }, { ...DEFAULT_PERSONA, components: [] }).components[0])
    }
  }
  // 组件总长度封顶：超了从最早的开始丢
  let total = merged.components.reduce((sum, row) => sum + row.text.length, 0)
  while (total > MAX_TOTAL_COMPONENT_CHARS && merged.components.length > 1) {
    total -= merged.components.shift().text.length
  }
  return merged
}

/** 组件文件读取（绝对路径或相对 persona 目录）。 */
export function personaComponentDir(home) {
  return join(home, 'persona')
}

export function resolveComponentPath(home, file) {
  const target = String(file || '')
  return isAbsolute(target) ? target : join(personaComponentDir(home), target)
}
