/**
 * 工具集：模型能调用的「手」。
 *
 * 每个工具的 run() 返回 JSON 可序列化对象；orchestrator 把它塞回
 * `role: "tool"` 消息。返回值有长度上限，避免一次 save_scan 把上下文撑爆。
 *
 * @module stellaris-agent/tools
 */

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { catalogueForModel } from '../../engine/lib/actions.js'
import { ensureNativeBridge } from './native-bridge.mjs'
import { readAll, summarize } from './native-reader.mjs'
import { runVerb, listVerbs } from './native-verbs.mjs'

const execFileAsync = promisify(execFile)

function clamp(value, max = 12000) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  if (text.length <= max) return value
  return { truncated: true, chars: text.length, preview: text.slice(0, max) }
}

const QUERY_WHAT = ['planet', 'resources', 'leaders', 'techs', 'traditions', 'perks', 'relics', 'fleets', 'diplo', 'situations']

/**
 * @param {object} deps {engine, bus, allowDelegate, delegate}
 */
export function createTools({ engine, bus, allowDelegate = false, delegate = null, allowWrite = false } = {}) {
  const tools = [
    {
      name: 'get_brief',
      description: '拿当前战局简报（日期/帝国/资源/殖民地/最近事件）。每轮开头先看它。',
      parameters: {
        type: 'object',
        properties: { budget: { type: 'number', description: '大约多少字符，默认 5000' } },
        additionalProperties: false,
      },
      async run(args) {
        return { brief: engine.brief(Number(args?.budget ?? 5000)), status: clamp(engine.status(), 4000) }
      },
    },
    {
      name: 'refresh_state',
      description: '让阅读模组立刻导出一份实时快照（会开一次控制台）。快照旧了先跑它。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() {
        return engine.refresh()
      },
    },
    {
      name: 'save_scan',
      description: '解析最新存档，补全日志拿不到的全量数据（科技/传统/飞升/建筑/领袖/外交/局势）。',
      parameters: {
        type: 'object',
        properties: { force: { type: 'boolean' } },
        additionalProperties: false,
      },
      async run(args) {
        const result = await engine.saveScan(Boolean(args?.force))
        if (!result.ok) return result
        const archive = result.archive
        return {
          ok: true,
          cached: result.cached,
          meta: archive.meta,
          stats: archive.stats,
          empire: archive.empire,
          warnings: archive.warnings.slice(0, 6),
        }
      },
    },
    {
      name: 'query_state',
      description: '按类别查快照/存档：星球、资源、领袖、科技、传统、飞升、遗珍、舰队、外交、局势。',
      parameters: {
        type: 'object',
        properties: {
          what: { type: 'string', enum: QUERY_WHAT },
          name: { type: 'string', description: '星球名 / 关键词（可选）' },
        },
        required: ['what'],
        additionalProperties: false,
      },
      async run(args) {
        return clamp(engine.query(args?.what, args?.name), 10000)
      },
    },
    {
      name: 'timeline',
      description: '看事件账本（可按链过滤），返回节点与缺口。',
      parameters: {
        type: 'object',
        properties: {
          chain: { type: 'string' },
          limit: { type: 'number' },
        },
        additionalProperties: false,
      },
      async run(args) {
        return { entries: engine.timeline.list({ chain: args?.chain, limit: args?.limit ?? 30 }), status: engine.timeline.status() }
      },
    },
    {
      name: 'event_info',
      description: '查一个事件的后续（从本地游戏文件解析），depth 可展开 1~3 层。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, depth: { type: 'number' } },
        required: ['id'],
        additionalProperties: false,
      },
      async run(args) {
        return engine.eventInfo(String(args?.id || ''), Number(args?.depth ?? 1))
      },
    },
    {
      name: 'validate_mods',
      description: '对 4.5 校验两个模组：结构 +（给了 game_dir 时）精确核对 on_action/effect。',
      parameters: {
        type: 'object',
        properties: { game_dir: { type: 'string', description: '群星安装目录（可省）' } },
        additionalProperties: false,
      },
      async run(args) {
        const script = new URL('../../tools/validate-mods.mjs', import.meta.url)
        const argv = [script.pathname.replace(/^\//, ''), '--json']
        if (args?.game_dir) argv.push('--game-dir', String(args.game_dir))
        try {
          const { stdout } = await execFileAsync(process.execPath, argv, { timeout: 120000, windowsHide: true })
          return JSON.parse(stdout)
        } catch (error) {
          const stdout = String(error?.stdout || '')
          if (stdout.trim().startsWith('{')) return JSON.parse(stdout)
          return { ok: false, error: String(error?.message || error) }
        }
      },
    },
    {
      name: 'list_actions',
      description: '列出可执行动作：动词、作用域、参数、等级。不确定怎么下手时先看它。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['core', 'exp', 'raw'] },
        },
        additionalProperties: false,
      },
      async run(args) {
        let rows = catalogueForModel()
        if (args?.level) rows = rows.filter((row) => row.level === args.level)
        return { count: rows.length, actions: rows }
      },
    },
    {
      name: 'native_verbs',
      description: '列出原生桥支持的全部 34 个动作（参数、分类、是否有读回验证）。',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      async run() { return { verbs: listVerbs() } },
    },
    {
      name: 'native_read',
      description: '实时全量读取：状态/政府/科研/传统/领袖/舰队/外交/战争/事件/市场/银河 + 每颗星球与舰队细节。',
      parameters: { type: 'object', properties: { deep: { type: 'boolean' } }, additionalProperties: false },
      async run(args) {
        const bridge = await ensureNativeBridge({})
        if (!bridge.ok) return bridge
        try {
          const data = await readAll(bridge.pipe, { deep: args?.deep !== false })
          return { summary: summarize(data), status: clamp(data.methods?.get_status, 6000), errors: data.errors }
        } finally { bridge.pipe.close() }
      },
    },
    {
      name: 'native_act',
      description: '执行一个原生动词（一次一项，读回验证通过才算完成，最多重试 5 次）。先用 native_verbs 查参数。',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', description: '动词名，如 build_building / select_research / move_fleet' },
          params: { type: 'object', additionalProperties: true },
        },
        required: ['method'],
        additionalProperties: false,
      },
      async run(args) {
        if (!allowWrite) return { error: '当前是只读模式，不能执行原生写动作' }
        const bridge = await ensureNativeBridge({})
        if (!bridge.ok) return bridge
        try {
          return await runVerb(bridge.pipe, String(args.method), args.params || {}, { attempts: 5 })
        } finally { bridge.pipe.close() }
      },
    },
    {
      name: 'apply_actions',
      description:
        '把一组动作直接执行到游戏里（会等 ACK）。动作格式与 ```stellaris 块相同：'
        + '[{ "resource": { "key": "alloys", "amount": 500 } }]。宁可小步，不要一次发十条。',
      parameters: {
        type: 'object',
        properties: {
          actions: { type: 'array', items: { type: 'object', additionalProperties: true } },
          dry_run: { type: 'boolean', description: '只编译不执行' },
        },
        required: ['actions'],
        additionalProperties: false,
      },
      async run(args) {
        return engine.apply(args?.actions || [], { dryRun: Boolean(args?.dry_run) })
      },
    },
    {
      name: 'open_ui',
      description: '打开界面：ascension / traditions / technology / government / leaders / fleets / diplomacy / relics / policies / planets。',
      parameters: {
        type: 'object',
        properties: { view: { type: 'string' } },
        required: ['view'],
        additionalProperties: false,
      },
      async run(args) {
        return engine.openUI(String(args?.view || ''))
      },
    },
    {
      name: 'read_designs',
      description: '读创建界面里保存的自定义帝国（政体/思潮/国策/起源）。创建阶段用。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string' } },
        additionalProperties: false,
      },
      async run(args) {
        const read = engine.designs()
        if (!read.ok) return read
        const query = String(args?.name || '').toLowerCase()
        const designs = query ? read.designs.filter((item) => String(item.name || '').toLowerCase().includes(query)) : read.designs
        return { ok: true, file: read.file, count: designs.length, designs }
      },
    },
    {
      name: 'clone_design',
      description:
        '克隆一份已保存的帝国设计并改字段（默认 dry-run；写盘要确认）。'
        + 'set 里可用 authority/government/origin/civics[]/traits[]/species/planetName。',
      parameters: {
        type: 'object',
        properties: {
          source: { type: 'string' },
          name: { type: 'string' },
          set: { type: 'object', additionalProperties: true },
          dry_run: { type: 'boolean' },
        },
        required: ['source', 'name'],
        additionalProperties: false,
      },
      async run(args) {
        return engine.cloneDesign({
          sourceName: args?.source,
          name: args?.name,
          set: args?.set || {},
          dryRun: args?.dry_run !== false,
          confirm: args?.dry_run === false,
        })
      },
    },
    {
      name: 'create_design',
      description: '从零创建一份创建界面里的自定义帝国（不需要模板）。默认 dry-run；写盘要 dry_run:false。',
      parameters: {
        type: 'object',
        properties: {
          spec: { type: 'object', additionalProperties: true },
          dry_run: { type: 'boolean' },
          overwrite: { type: 'boolean' },
        },
        required: ['spec'],
        additionalProperties: false,
      },
      async run(args) {
        return engine.createDesign({
          spec: args?.spec || {},
          dryRun: args?.dry_run !== false,
          confirm: args?.dry_run === false,
          overwrite: args?.overwrite === true,
        })
      },
    },
    {
      name: 'journal_write',
      description: '给这一局写一条日志：结论、下一步、失败教训。',
      parameters: {
        type: 'object',
        properties: { note: { type: 'string' }, kind: { type: 'string' } },
        required: ['note'],
        additionalProperties: false,
      },
      async run(args) {
        return engine.journalWrite(String(args?.note || ''), String(args?.kind || 'note'))
      },
    },
    {
      name: 'finish',
      description: '本轮结束：给玩家一句话总结（做了什么/为什么/下一步）。',
      parameters: {
        type: 'object',
        properties: { summary: { type: 'string' } },
        required: ['summary'],
        additionalProperties: false,
      },
      async run(args) {
        return { done: true, summary: String(args?.summary || '') }
      },
    },
  ]

  if (bus) {
    tools.push(
      {
        name: 'chat_poll',
        description: '取直播间新弹幕。',
        parameters: {
          type: 'object',
          properties: { since: { type: 'number' } },
          additionalProperties: false,
        },
        async run(args) {
          return bus.poll(Number(args?.since ?? 0))
        },
      },
      {
        name: 'chat_say',
        description: '往直播间说一句话。',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string' } },
          required: ['text'],
          additionalProperties: false,
        },
        async run(args) {
          return bus.say(String(args?.text || ''))
        },
      },
    )
  }

  if (allowDelegate && delegate) {
    tools.push({
      name: 'delegate',
      description:
        '把具体执行交给「操作员」子会话：它独立上下文、只做最小必要动作，返回摘要。'
        + '主会话自己保留判断与复盘，不占上下文。',
      parameters: {
        type: 'object',
        properties: { goal: { type: 'string', description: '要操作员达成的目标' } },
        required: ['goal'],
        additionalProperties: false,
      },
      async run(args) {
        return delegate(String(args?.goal || ''))
      },
    })
  }

  return tools
}
