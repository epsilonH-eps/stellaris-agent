/**
 * 生成 docs/ACTIONS.md（动作目录）。
 *
 *   node tools/gen-actions-doc.mjs
 *
 * 唯一来源是 agent/lib/actions.mjs，所以文档不会和代码漂移。
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ACTIONS, UNIT_TYPES, READ_METHODS, actionsForUnit } from '../agent/lib/actions.mjs'

const lines = []
lines.push('# 动作目录（由代码生成）')
lines.push('')
lines.push('> 生成命令：`node tools/gen-actions-doc.mjs`。唯一来源：[`agent/lib/actions.mjs`](../agent/lib/actions.mjs)。')
lines.push('> 不要手改本文件。')
lines.push('')
lines.push(`共 **${ACTIONS.length}** 个写动作、**${READ_METHODS.length}** 个读取方法。`)
lines.push('')
lines.push('`confidence`：')
lines.push('')
lines.push('- `verified`：参数来自上游文档 / 旧版真机验证；')
lines.push('- `inferred`：从 DLL 符号推断，首次使用若参数不符，执行器会把错误回传给子会话，由它改参重试。')
lines.push('')
lines.push('## 单位划分')
lines.push('')
lines.push('| 单位 | 含义 | 动作数 |')
lines.push('| --- | --- | --- |')
for (const [type, meta] of Object.entries(UNIT_TYPES)) {
  lines.push(`| \`${type}\` | ${meta.label} | ${actionsForUnit(type).length} |`)
}
lines.push('')

for (const [type, meta] of Object.entries(UNIT_TYPES)) {
  lines.push(`## ${meta.label}（\`${type}\`）`)
  lines.push('')
  lines.push('| 动作 | 参数 | 必填 | 说明 | 回读 | 置信 |')
  lines.push('| --- | --- | --- | --- | --- | --- |')
  for (const action of actionsForUnit(type)) {
    const params = Object.entries(action.params)
      .map(([name, kind]) => `\`${name}: ${kind}\``)
      .join('<br>')
    const required = (action.required || []).map((name) => `\`${name}\``).join('<br>') || '—'
    const verify = action.verify
      ? `${action.verify.soft ? 'soft ' : ''}\`${action.verify.read}\``
      : '—'
    lines.push(`| \`${action.method}\` | ${params || '—'} | ${required} | ${action.desc} | ${verify} | ${action.confidence} |`)
  }
  lines.push('')
}

lines.push('## 读取方法')
lines.push('')
lines.push('| 方法 | 作用域 | 参数 |')
lines.push('| --- | --- | --- |')
const seen = new Set()
for (const row of READ_METHODS) {
  const key = `${row.method}:${row.scope}`
  if (seen.has(key)) continue
  seen.add(key)
  lines.push(`| \`${row.method}\` | ${row.scope} | ${row.param ? `\`${row.param}\`` : '—'} |`)
}
lines.push('')
lines.push('## 执行语义')
lines.push('')
lines.push('1. 动作先进执行器的 FIFO 队列，**严格串行**下发（DLL 单连接）；')
lines.push('2. 待执行动作数 ≥ `executor.pauseWhenQueuedActions`（X）时先暂停游戏；')
lines.push('3. 每个动作执行后按 `回读` 列重新读取校验；`soft` 校验失败只记警告，硬校验失败视为本次失败；')
lines.push('4. 单动作最多尝试 `executor.maxAttempts`（Y）次；仍失败则整个任务在该步终止，后续动作标记 `skipped`；')
lines.push('5. 子会话拿到失败详情后换参数重来；用满自己的重试次数后，额外做一次失败分析并上报主会话；')
lines.push('6. 队列排空到 `executor.resumeWhenQueuedActionsBelow` 以下，且暂停是执行器发起的，才会自动恢复。')
lines.push('')

const out = fileURLToPath(new URL('../docs/ACTION-CATALOG.md', import.meta.url))
writeFileSync(out, lines.join('\n'), 'utf8')
console.log(`wrote ${out} (${lines.length} lines)`)
