/**
 * 自动执行队列：把动作写进 `05-stellaris-autopilot` 的脚本，由游戏每月自己执行。
 *
 * 这是「不用模拟输入、也不用手动敲控制台」时唯一可行的执行路径：
 *   DSH 生成 effect → 写模组脚本 → 游戏启动时加载 → on_monthly_pulse_country 消费。
 *
 * 代价：新决策要**重启/读档**后才生效。GUI 必须明确提示这一点。
 *
 * 版本号机制：每次应用生成 `dsh_auto_v<N>` 国家旗标，队列里先检查旗标不存在才执行，
 * 所以同一个决策只会跑一次，不会每月重复。
 *
 * @module stellaris-agent/autopilot
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { normalizeActions } from '../../engine/lib/actions.js'
import { compilePlan } from '../../engine/lib/compiler.js'

const REPO_MOD = '05-stellaris-autopilot'
const INSTALLED_ID = 'dsh_autopilot'

function readSeq(file) {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'))
    return Number(raw.seq) || 0
  } catch {
    return 0
  }
}

function writeSeq(file, seq) {
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify({ seq, updatedAt: Date.now() }, null, 2), 'utf8')
}

function stripEffect(line) {
  return line.replace(/^effect = \{\s*/, '').replace(/\s*\}$/, '')
}

/**
 * @param {object} params
 * @param {object} params.state SnapshotStore
 * @param {object} params.config
 * @param {Array<object>} params.actions
 * @param {string} params.repoRoot 仓库根
 * @param {string|null} params.userDir 群星用户目录
 * @param {string} params.seqFile
 */
export function applyAutopilot({ state, config, actions, repoRoot, userDir, seqFile }) {
  const normalized = normalizeActions(actions, {
    allowExperimental: Boolean(config.safety?.allowExperimental),
    allowRawEffect: Boolean(config.safety?.allowRawEffect),
    maxResourcePerAction: config.safety?.maxResourcePerAction,
  })
  if (!normalized.ok) return { ok: false, code: 'VALIDATION', errors: normalized.errors }

  const plan = compilePlan(normalized.actions, {
    state,
    config,
    planId: 'auto' + Date.now().toString(36),
    lane: 0,
    force: true,
  })
  if (!plan.commands.length) return { ok: false, code: 'COMPILE', errors: plan.errors }

  const seq = readSeq(seqFile) + 1
  const flag = `dsh_auto_v${seq}`
  const bodies = plan.commands.map((command) => '        ' + stripEffect(command.line))

  const content = [
    '# ============================================================================',
    '# 由 DSH 自动生成，手工修改会被覆盖。',
    `# 生成时间：${new Date().toISOString()}  动作数：${bodies.length}  版本：${flag}`,
    '# 游戏每月执行一次，执行后设置国家旗标，避免重复。',
    '# ============================================================================',
    '',
    'dsh_auto_run = {',
    `\tif = {`,
    `\t\tlimit = { NOT = { has_country_flag = ${flag} } }`,
    `\t\tset_country_flag = ${flag}`,
    ...bodies.map((line) => '\t\t' + line.trim()),
    `\t}`,
    '}',
    '',
  ].join('\n')

  const targets = [join(repoRoot, REPO_MOD, 'common', 'scripted_effects', 'dsh_auto_queue.txt')]
  if (userDir) {
    // userDir 本身就是 .../Stellaris，所以直接拼 mod
    targets.push(join(userDir, 'mod', INSTALLED_ID, 'common', 'scripted_effects', 'dsh_auto_queue.txt'))
  }

  const written = []
  for (const file of targets) {
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, content, 'utf8')
      written.push(file)
    } catch {
      /* 目标不可写就跳过（例如只读的工坊目录） */
    }
  }
  if (!written.length) return { ok: false, code: 'WRITE_FAILED', error: '队列文件写不进去' }

  writeSeq(seqFile, seq)
  return {
    ok: true,
    seq,
    flag,
    actions: plan.commands.map((command) => ({ verb: command.verb, cmd: command.cmd })),
    files: written,
    hint: '已写入自动队列。重启游戏（或读档）后，游戏每月会自动执行一次；不需要任何按键。',
    compileErrors: plan.errors,
  }
}
