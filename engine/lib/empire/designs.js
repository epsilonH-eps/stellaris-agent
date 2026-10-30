/**
 * 自定义帝国设计（创建帝国界面里「已保存的帝国」）。
 *
 * 真实文件结构（Stellaris 3.4+ / 4.x，`user_empire_designs_v3*.txt`）：
 *
 *   "Empire Name"=
 *   {
 *       key="Empire Name"
 *       ship_prefix={ key="MSS" }
 *       species=
 *       {
 *           class="HUM"
 *           portrait="human"
 *           species_name={ key="Human" }
 *           species_plural={ key="Humans" }
 *           species_adjective={ key="Human" }
 *           name_list="HUM1"
 *           gender=not_set
 *           trait="trait_adaptive"
 *           trait="trait_organic"
 *       }
 *       name={ key="Empire Name" }
 *       adjective={ key="Human" }
 *       authority="auth_democratic"
 *       government="gov_moral_democracy"
 *       planet_name={ key="Earth" }
 *       planet_class="pc_continental"
 *       system_name={ key="Sol" }
 *       initializer=""
 *       graphical_culture="mammalian_01"
 *       empire_flag={ icon={...} background={...} colors={ "red" "blue" "null" "null" } }
 *       ruler={ gender=male name={ full_names={ key="..." } } portrait="human" ... leader_class="official" }
 *       spawn_as_fallen=no
 *       ignore_portrait_duplication=no
 *       room="default_room"
 *       spawn_enabled=yes
 *       ethic="ethic_xenophile"
 *       civics={ "civic_a" "civic_b" }
 *       origin="origin_default"
 *   }
 *
 * 旧格式（v2 及更早）是 `empires={ 0={...} }`，这里也兼容读取。
 *
 * 写回策略：
 *   - 克隆现有条目改字段（默认），或按内置 seed 从零创建；
 *   - 先 dry-run 预览；写盘要 confirm，先备份，写完读回自检，失败回滚；
 *   - 顶层键、name/civics/ethic 的块结构都按真实格式生成。
 *
 * @module dsh-stellaris-bridge/empire/designs
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '../save/clausewitz.js'

const CANDIDATES = [
  'user_empire_designs_v3.4.txt',
  'user_empire_designs_v3.txt',
  'user_empire_designs_v2.txt',
  'user_empire_designs.txt',
]

export function designFile(dir) {
  for (const name of CANDIDATES) {
    const file = join(dir, name)
    if (existsSync(file)) return file
  }
  // 兜底：4.x 可能用别的版本后缀，取最新的 user_empire_designs_v*.txt
  try {
    const rows = readdirSync(dir)
      .filter((name) => /^user_empire_designs_v\d+(\.\d+)?\.txt$/i.test(name))
      .map((name) => ({ file: join(dir, name), mtime: statSync(join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    if (rows.length) return rows[0].file
  } catch {
    /* ignore */
  }
  return null
}

function asList(value) {
  if (value === undefined || value === null) return []
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'object') {
    if (value['@values'] !== undefined) {
      const raw = value['@values']
      return (Array.isArray(raw) ? raw : [raw]).map(String)
    }
    return Object.keys(value).filter((key) => !key.startsWith('@'))
  }
  return [String(value)]
}

function text(value) {
  if (value === undefined || value === null) return null
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  if (Array.isArray(value)) return text(value[0])
  if (typeof value === 'object') return text(value.key ?? value.name ?? value.full_names ?? null)
  return null
}

function isEmpireEntry(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)
    && (value.authority || value.government || value.species || value.planet_class))
}

function entriesOf(root) {
  // 旧格式：empires={ 0={...} }
  if (root.empires && typeof root.empires === 'object') {
    const list = []
    for (const [key, value] of Object.entries(root.empires)) {
      if (key.startsWith('@') || !isEmpireEntry(value)) continue
      list.push({ key, entry: value, legacy: true })
    }
    if (list.length) return list
  }
  // 新格式：顶层 "Name"={...}
  const list = []
  for (const [key, value] of Object.entries(root)) {
    if (key.startsWith('@') || key === 'version') continue
    if (!isEmpireEntry(value)) continue
    list.push({ key, entry: value, legacy: false })
  }
  return list
}

function normalize(item, index) {
  const entry = item.entry
  const species = entry.species && typeof entry.species === 'object' ? entry.species : {}
  return {
    index,
    key: item.key,
    legacy: item.legacy,
    name: text(entry.name) ?? text(entry.key) ?? item.key,
    adjective: text(entry.adjective),
    authority: text(entry.authority),
    government: text(entry.government),
    origin: text(entry.origin),
    civics: asList(entry.civics),
    ethics: asList(entry.ethic ?? entry.ethics ?? entry.ethos),
    speciesName: text(species.species_name),
    speciesClass: text(species.class),
    portrait: text(species.portrait),
    traits: asList(species.trait),
    planetName: text(entry.planet_name),
    planetClass: text(entry.planet_class),
    systemName: text(entry.system_name),
    shipPrefix: text(entry.ship_prefix),
    ruler: text(entry.ruler?.name),
    flag: entry.empire_flag ?? null,
  }
}

export function readDesigns(dir) {
  const file = designFile(dir)
  if (!file) {
    return { ok: false, code: 'NO_DESIGNS', error: '没有 user_empire_designs 文件：还没在创建界面存过自定义帝国？', file: null }
  }
  const root = parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
  const list = entriesOf(root)
  return {
    ok: true,
    file,
    version: text(root.version) ?? null,
    format: list[0]?.legacy ? 'legacy-empires' : 'v3-name-keys',
    designs: list.map(normalize),
    count: list.length,
  }
}

// ---------------------------------------------------------------- 序列化

function keyToken(key) {
  return /^[A-Za-z0-9_.\-]+$/.test(String(key)) ? String(key) : `"${String(key).replace(/"/g, '\\"')}"`
}

/** 序列化回 Clausewitz（按真实设计文件的写法）。 */
export function serialize(value, indent = 0) {
  const pad = '\t'.repeat(indent)
  if (value === null || value === undefined) return `${pad}none`
  if (typeof value === 'boolean') return `${pad}${value ? 'yes' : 'no'}`
  if (typeof value === 'number') return `${pad}${value}`
  if (typeof value === 'string') {
    return /^[A-Za-z0-9_.\-]+$/.test(value) ? `${pad}${value}` : `${pad}"${value.replace(/"/g, '\\"')}"`
  }
  if (Array.isArray(value)) return value.map((item) => serialize(item, indent)).join('\n')
  const lines = []
  for (const [key, item] of Object.entries(value)) {
    if (key === '@values') {
      for (const raw of Array.isArray(item) ? item : [item]) {
        lines.push(`${pad}${typeof raw === 'string' && !/^[A-Za-z0-9_.\-]+$/.test(raw) ? `"${raw.replace(/"/g, '\\"')}"` : raw}`)
      }
      continue
    }
    const name = keyToken(key)
    if (Array.isArray(item)) {
      for (const element of item) {
        if (element && typeof element === 'object') {
          lines.push(`${pad}${name}={\n${serialize(element, indent + 1)}\n${pad}}`)
        } else {
          lines.push(`${pad}${name}=${serialize(element, 0).trim()}`)
        }
      }
      continue
    }
    if (item && typeof item === 'object' && Object.keys(item).length) {
      lines.push(`${pad}${name}={\n${serialize(item, indent + 1)}\n${pad}}`)
      continue
    }
    if (item === null || item === undefined) {
      lines.push(`${pad}${name}=none`)
      continue
    }
    lines.push(`${pad}${name}=${serialize(item, 0).trim()}`)
  }
  return lines.join('\n')
}

// ---------------------------------------------------------------- 字段写入

function strBlock(value) {
  return { key: String(value) }
}

function applyPatch(entry, set) {
  if (set.adjective !== undefined) entry.adjective = strBlock(set.adjective)
  if (set.authority !== undefined) entry.authority = String(set.authority)
  if (set.government !== undefined) entry.government = String(set.government)
  if (set.origin !== undefined) entry.origin = String(set.origin)
  if (set.planetName !== undefined) entry.planet_name = strBlock(set.planetName)
  if (set.planetClass !== undefined) entry.planet_class = String(set.planetClass)
  if (set.systemName !== undefined) entry.system_name = strBlock(set.systemName)
  if (set.shipPrefix !== undefined) entry.ship_prefix = strBlock(set.shipPrefix)
  if (set.civics !== undefined) entry.civics = { '@values': set.civics.map(String) }
  if (set.ethics !== undefined) {
    const ethics = set.ethics.map(String)
    entry.ethic = ethics.length === 1 ? ethics[0] : ethics
  }
  if (set.name_list !== undefined) {
    entry.species = entry.species || {}
    entry.species.name_list = String(set.name_list)
  }
  if (set.species !== undefined) {
    entry.species = entry.species || {}
    entry.species.species_name = strBlock(set.species)
    entry.species.species_plural = strBlock(set.speciesPlural || set.species)
    entry.species.species_adjective = strBlock(set.speciesAdjective || set.adjective || set.species)
  }
  if (set.speciesClass !== undefined) {
    entry.species = entry.species || {}
    entry.species.class = String(set.speciesClass)
  }
  if (set.portrait !== undefined) {
    entry.species = entry.species || {}
    entry.species.portrait = String(set.portrait)
    if (entry.ruler && typeof entry.ruler === 'object') entry.ruler.portrait = String(set.portrait)
  }
  if (set.traits !== undefined) {
    entry.species = entry.species || {}
    const traits = set.traits.map(String)
    entry.species.trait = traits.length === 1 ? traits[0] : traits
  }
  if (set.rulerName !== undefined && entry.ruler && typeof entry.ruler === 'object') {
    entry.ruler.name = { full_names: strBlock(set.rulerName) }
  }
}

/** 内置 seed：按真实 v3.4 结构，给「从零创建」用。 */
export function seedEntry(spec = {}) {
  const name = String(spec.name || '新帝国')
  const species = String(spec.species || name)
  const adjective = String(spec.adjective || species)
  const planet = String(spec.planetName || '家园')
  const system = String(spec.systemName || '太阳系')
  const ruler = String(spec.rulerName || '第一执政')
  const portrait = String(spec.portrait || 'human')
  const speciesClass = String(spec.speciesClass || 'HUM')
  const graphical = String(spec.graphicalCulture || 'mammalian_01')
  const ethics = Array.isArray(spec.ethics) && spec.ethics.length ? spec.ethics.map(String) : ['ethic_xenophile', 'ethic_materialist']
  const civics = Array.isArray(spec.civics) && spec.civics.length ? spec.civics.map(String) : ['civic_beacon_of_liberty']
  const traits = Array.isArray(spec.traits) && spec.traits.length ? spec.traits.map(String) : ['trait_adaptive', 'trait_organic']
  return {
    key: name,
    ship_prefix: strBlock(spec.shipPrefix || 'ISS'),
    species: {
      class: speciesClass,
      portrait,
      species_name: strBlock(species),
      species_plural: strBlock(spec.speciesPlural || `${species}s`),
      species_adjective: strBlock(spec.speciesAdjective || adjective),
      name_list: String(spec.name_list || 'HUM1'),
      gender: 'not_set',
      trait: traits.length === 1 ? traits[0] : traits,
    },
    name: strBlock(name),
    adjective: strBlock(adjective),
    authority: String(spec.authority || 'auth_democratic'),
    government: String(spec.government || 'gov_moral_democracy'),
    planet_name: strBlock(planet),
    planet_class: String(spec.planetClass || 'pc_continental'),
    system_name: strBlock(system),
    initializer: '',
    graphical_culture: graphical,
    city_graphical_culture: String(spec.cityGraphicalCulture || graphical),
    empire_flag: {
      icon: { category: 'spherical', file: 'flag_spherical_1.dds' },
      background: { category: 'backgrounds', file: 'circle.dds' },
      colors: { '@values': ['red', 'blue', 'null', 'null'] },
    },
    ruler: {
      gender: 'male',
      name: { full_names: strBlock(ruler) },
      portrait,
      texture: 0,
      attachment: 0,
      clothes: 0,
      leader_class: 'official',
    },
    spawn_as_fallen: false,
    ignore_portrait_duplication: false,
    room: 'default_room',
    spawn_enabled: true,
    ethic: ethics.length === 1 ? ethics[0] : ethics,
    civics: { '@values': civics },
    origin: String(spec.origin || 'origin_default'),
  }
}

// ---------------------------------------------------------------- 写盘

function buildRoot(read, entries, newKey, newEntry) {
  if (!entries.length || entries[0].legacy) {
    return { ...read.root, empires: { ...(read.root.empires || {}), [newKey]: newEntry } }
  }
  return { ...read.root, [newKey]: newEntry }
}

function loadRoot(file) {
  return parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
}

function commit({ file, root, newKey, newName, confirm, dryRun, expect }) {
  const output = serialize(root, 0) + '\n'
  const verifyRoot = parse(output)
  const verifyEntry = entriesOf(verifyRoot).find((item) => item.key === newKey)?.entry
  if (!verifyEntry) return { ok: false, code: 'VERIFY_FAILED', error: '序列化后读回找不到新条目，未写盘' }
  if (expect?.authority && text(verifyEntry.authority) !== expect.authority) {
    return { ok: false, code: 'VERIFY_FAILED', error: '读回的 authority 与预期不一致，未写盘' }
  }
  if (dryRun) {
    return { ok: true, mode: 'dry-run', file, newKey, name: newName, preview: output.length > 5000 ? output.slice(0, 5000) + '\n…' : output }
  }
  if (confirm !== true) return { ok: false, code: 'NEED_CONFIRM', error: '写设计文件需要 confirm: true（会先备份）', newKey }
  const backup = existsSync(file) ? `${file}.bak-${Date.now()}` : null
  if (backup) copyFileSync(file, backup)
  try {
    writeFileSync(file, output, 'utf8')
  } catch (error) {
    try {
      copyFileSync(backup, file)
    } catch {
      /* ignore */
    }
    return { ok: false, code: 'WRITE_FAILED', error: String(error?.message || error), backup }
  }
  return {
    ok: true,
    mode: 'written',
    file,
    backup,
    newKey,
    name: newName,
    hint: '打开创建帝国界面 →「已保存的帝国」，刷新/重进一次就能看到。',
  }
}

/**
 * 克隆现有设计。
 * @param {object} params {dir, sourceName, sourceIndex, name, set, dryRun, confirm}
 */
export function cloneDesign(params) {
  const read = readDesigns(params.dir)
  if (!read.ok) return read
  const file = read.file
  const root = loadRoot(file)
  const entries = entriesOf(root)
  if (!entries.length) return { ok: false, code: 'EMPTY_DESIGNS', error: '设计文件里没有可克隆的帝国' }
  const source = params.sourceIndex !== undefined
    ? entries[Number(params.sourceIndex)]
    : entries.find((item) => (text(item.entry.name) ?? item.key) === String(params.sourceName || ''))
  if (!source) {
    return {
      ok: false,
      code: 'NO_SOURCE',
      error: `找不到模板帝国：${params.sourceName ?? params.sourceIndex}`,
      available: entries.map((item, index) => ({ index, name: text(item.entry.name) ?? item.key })),
    }
  }
  const name = String(params.name || '').trim()
  if (!name) return { ok: false, code: 'BAD_PARAM', error: '缺少新设计名' }
  const clone = JSON.parse(JSON.stringify(source.entry))
  clone.key = name
  clone.name = strBlock(name)
  applyPatch(clone, params.set || {})
  const nextRoot = buildRoot({ root }, entries, name, clone)
  return commit({
    file,
    root: nextRoot,
    newKey: name,
    newName: name,
    confirm: params.confirm,
    dryRun: params.dryRun,
    expect: { authority: clone.authority },
  })
}

/**
 * 从零创建一份设计。
 * @param {object} params {dir, spec, dryRun, confirm, overwrite}
 */
export function createDesign(params) {
  const read = readDesigns(params.dir)
  if (!read.ok && read.code !== 'NO_DESIGNS') return read
  const file = read.ok ? read.file : join(params.dir, 'user_empire_designs_v3.4.txt')
  const spec = params.spec || {}
  const name = String(spec.name || '').trim()
  if (!name) return { ok: false, code: 'BAD_PARAM', error: '缺少帝国名（spec.name）' }
  const root = read.ok ? loadRoot(file) : { version: '4.5.0' }
  const entries = read.ok ? entriesOf(root) : []
  const exists = entries.find((item) => (text(item.entry.name) ?? item.key) === name)
  if (exists && !params.overwrite) {
    return { ok: false, code: 'EXISTS', error: `已经有同名设计「${name}」；要覆盖传 overwrite: true` }
  }
  const entry = seedEntry({ ...spec, name })
  applyPatch(entry, spec)
  const nextRoot = buildRoot({ root }, entries, name, entry)
  return commit({
    file,
    root: nextRoot,
    newKey: name,
    newName: name,
    confirm: params.confirm,
    dryRun: params.dryRun,
    expect: { authority: entry.authority },
  })
}

export function designStatus(dir) {
  const file = designFile(dir)
  if (!file) return { available: false, file: null, count: 0 }
  try {
    const read = readDesigns(dir)
    return { available: true, file, count: read.count || 0, format: read.format }
  } catch {
    return { available: true, file, count: 0 }
  }
}
