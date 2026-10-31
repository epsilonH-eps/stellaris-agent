/**
 * 传统树节点定义（原版 + 模组）。
 *
 * 原生 `get_traditions` 只返回每棵树的 unlocked_count 和已解锁的 *_adopt 节点，
 * 不返回树内后续节点的 key；这里从 `common/traditions/*.txt` 解析节点与前置关系，
 * 再合并本地化名称，供 laws 子会话选取真实 key。
 *
 * @module stellaris-agent/traditions
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

const cache = new Map()

function extractBlock(text, openIndex) {
  let depth = 0
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index]
    if (char === '{') depth += 1
    else if (char === '}') {
      depth -= 1
      if (depth === 0) return text.slice(openIndex + 1, index)
    }
  }
  return text.slice(openIndex + 1)
}

function treeKeyOfFile(file) {
  const name = basename(file).replace(/\.txt$/i, '').replace(/^\d+_/, '')
  return `tradition_${name.replace(/[^a-zA-Z0-9_]/g, '_')}`
}

function parseFile(file) {
  const text = readFileSync(file, 'utf8').replace(/\r\n/g, '\n')
  const treeKey = treeKeyOfFile(file)
  const nodes = []
  const re = /^([A-Za-z0-9_]+)\s*=\s*\{/gm
  let match
  while ((match = re.exec(text))) {
    const key = match[1]
    if (!key.startsWith('tr_')) continue
    const body = extractBlock(text, re.lastIndex - 1)
    const requires = [...body.matchAll(/has_tradition\s*=\s*([A-Za-z0-9_]+)/g)].map((row) => row[1])
    nodes.push({ key, tree_key: treeKey, requires: [...new Set(requires)], is_adopt: key.endsWith('_adopt') })
  }
  return { treeKey, nodes }
}

function localizationNames(installDir) {
  const names = new Map()
  const file = join(installDir, 'localisation', 'simp_chinese', 'traditions_l_simp_chinese.yml')
  if (!existsSync(file)) return names
  try {
    const text = readFileSync(file, 'utf8')
    for (const match of text.matchAll(/^\s*(tr_[A-Za-z0-9_]+):\d*\s+"(.*?)"/gm)) {
      names.set(match[1], match[2].replace(/\$[^$]+\$/g, '').trim())
    }
    // 有些 key 的本地化名在通用的 traditions 文件里
    for (const extra of ['traditions_l_simp_chinese.yml', 'tradition_l_simp_chinese.yml']) {
      const other = join(installDir, 'localisation', 'simp_chinese', extra)
      if (!existsSync(other)) continue
      const body = readFileSync(other, 'utf8')
      for (const match of body.matchAll(/^\s*(tr_[A-Za-z0-9_]+):\d*\s+"(.*?)"/gm)) {
        if (!names.has(match[1])) names.set(match[1], match[2].replace(/\$[^$]+\$/g, '').trim())
      }
    }
  } catch {
    /* 本地化失败就用 key */
  }
  return names
}

export function loadTraditionNodes(installDir, { modDirs = [] } = {}) {
  if (!installDir) return {}
  const dirs = [join(installDir, 'common', 'traditions'), ...modDirs.map((dir) => join(dir, 'common', 'traditions'))]
  const files = []
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    try {
      for (const name of readdirSync(dir)) {
        if (name.toLowerCase().endsWith('.txt')) files.push(join(dir, name))
      }
    } catch {
      /* 跳过坏目录 */
    }
  }
  if (!files.length) return {}
  const stamp = files.map((file) => `${file}:${statSync(file).mtimeMs}`).join('|')
  const cached = cache.get(installDir)
  if (cached && cached.stamp === stamp) return cached.data

  const names = localizationNames(installDir)
  const trees = {}
  for (const file of files) {
    try {
      const parsed = parseFile(file)
      const bucket = trees[parsed.treeKey] || (trees[parsed.treeKey] = [])
      for (const node of parsed.nodes) {
        if (bucket.some((row) => row.key === node.key)) continue
        bucket.push({ ...node, name: names.get(node.key) || node.key })
      }
    } catch {
      /* 坏文件忽略 */
    }
  }
  // 用 adopt 节点校正 tree_key（文件名不规范时）
  for (const [treeKey, nodes] of Object.entries(trees)) {
    const adopt = nodes.find((node) => node.is_adopt)
    if (!adopt) continue
    const derived = adopt.key.replace(/_adopt$/, '')
    if (derived !== treeKey && derived.startsWith('tr_')) {
      const target = `tradition_${derived.slice(3)}`
      if (!trees[target]) {
        trees[target] = nodes.map((node) => ({ ...node, tree_key: target }))
        delete trees[treeKey]
      }
    }
  }
  cache.set(installDir, { stamp, data: trees })
  return trees
}
