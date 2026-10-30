/**
 * CLI：读类命令不需要 API Key；写类命令一律走执行器。
 *
 *   stellaris-agent status                目录/桥/AI/插件
 *   stellaris-agent read [--quick]        全量读取（含模组、事件链、存档 meta）
 *   stellaris-agent actions [--unit x]    动作列表（Y 条）
 *   stellaris-agent units                 可控单位清单
 *   stellaris-agent events active|search|chain
 *   stellaris-agent mods                  已启用模组
 *   stellaris-agent execute '<json>'      直接执行动作
 *   stellaris-agent call <method> [json]  原始 RPC（排障）
 *   stellaris-agent run [--once]          启动编排（主会话+子会话+执行器）
 *   stellaris-agent serve [--port]        本地 HTTP
 *   stellaris-agent plugin install|update|reload|status
 *   stellaris-agent doctor                自检
 *
 * @module stellaris-agent/cli
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stdout } from 'node:process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { App } from './app.mjs'
import { agentHome, configFile } from './config.mjs'
import { startServer } from './server.mjs'
import { ensureBridge, findGameProcess } from './bridge.mjs'
import { Reader } from './reader.mjs'
import { EventGraph } from './events.mjs'
import { listMods } from './mods.mjs'
import { discoverDsh } from './ai/dsh.mjs'
import { checkBackend, createBackend } from './ai/backend.mjs'
import { describeActions, validateActions } from './actions.mjs'
import { discoverUnits } from './context.mjs'
import { installPlugin, pluginVersions, reloadDsh } from './dsh-plugin.mjs'
import { FailureStore } from './failures.mjs'
import { createLogger } from './logger.mjs'

const execFileAsync = promisify(execFile)

const HELP = `群星参谋 v2

用法：
  stellaris-agent status                 连接/AI/插件/路径
  stellaris-agent read [--quick] [--out f]  全量读取（默认含存档 meta）
  stellaris-agent actions [--unit planet]    列出动作（操控器动作表）
  stellaris-agent units                   发现可控单位（1:1 子会话对象）
  stellaris-agent events active           已激活事件链（含后续）
  stellaris-agent events index [--force]  重建事件索引（原版+DLC+模组，不需要游戏）
  stellaris-agent events search <q>       搜事件
  stellaris-agent events chain <id>       看某事件后续
  stellaris-agent mods                    已启用模组（本地/工坊/DLC）
  stellaris-agent connect                立即连接（必要时注入）并按配置接管
  stellaris-agent sessions               会话列表（主会话 + 子会话）
  stellaris-agent session <id>           某个会话的完整对话
  stellaris-agent failures [--limit 20]  最近失败的子会话报告
  stellaris-agent failure <id> [--markdown]  看一份失败报告（默认 latest）
  stellaris-agent ask "问题"             直接和主会话智能体对话（同步返回）
  stellaris-agent execute '<json>' [--unit x]  执行动作
  stellaris-agent call <method> [json]   原始 RPC
  stellaris-agent run [--objective "..."] [--once]
  stellaris-agent serve [--port 8787]
  stellaris-agent pause | resume
  stellaris-agent plugin install|update|reload|status [--profile <dir>]
  stellaris-agent dsh-discover
  stellaris-agent doctor
  stellaris-agent selftest

配置：${configFile()}
`

function parse(argv) {
  const args = [...argv]
  const command = args.shift() || 'help'
  const positional = []
  const flags = {}
  while (args.length) {
    const token = args.shift()
    if (token.startsWith('--')) {
      const key = token.slice(2)
      const next = args[0]
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next
        args.shift()
      } else {
        flags[key] = true
      }
    } else {
      positional.push(token)
    }
  }
  return { command, positional, flags }
}

function out(text = '') {
  stdout.write(String(text) + '\n')
}

function pretty(value) {
  return JSON.stringify(value, null, 2)
}

/** 只读一次世界（不启动编排器、不需要 API Key）。 */
async function readOnce(app, { deep = true, includeSave = true } = {}) {
  const bridgeResult = await ensureBridge({ config: app.config, log: app.log })
  if (!bridgeResult.ok) {
    const error = new Error(`原生桥不可用：${bridgeResult.error}`)
    error.code = bridgeResult.error
    error.detail = bridgeResult.detail
    throw error
  }
  const paths = app.paths
  const mods = listMods({ userDir: paths.userDir || '', installDir: paths.installDir || '' })
  const graph = new EventGraph({
    home: app.home,
    installDir: paths.installDir || '',
    modEventDirs: mods.eventDirs,
    log: app.log,
  }).build()
  const reader = new Reader({ bridge: bridgeResult.client, config: app.config, home: app.home, log: app.log, paths })
  const world = await reader.readWorld({ deep, includeSave, eventGraph: graph, paths })
  return { world, graph, mods, bridge: bridgeResult }
}

/** 只建事件索引（不需要游戏在跑）。 */
function graphOnly(app, { force = false } = {}) {
  const paths = app.paths
  const mods = listMods({ userDir: paths.userDir || '', installDir: paths.installDir || '' })
  const graph = new EventGraph({
    home: app.home,
    installDir: paths.installDir || '',
    modEventDirs: mods.eventDirs,
    log: app.log,
  }).build({ force })
  return { graph, mods, paths }
}

export async function run(argv) {
  const { command, positional, flags } = parse(argv)
  if (command === 'help' || flags.help) {
    out(HELP)
    return 0
  }

  const app = new App({ home: agentHome(), log: createLogger(command) })
  if (flags.config) {
    out('提示：配置文件位置由 STELLARIS_AGENT_HOME 决定，--config 已废弃。')
  }
  if (flags.port) app.config.chat.port = Number(flags.port)
  if (app.configError) {
    out(app.configError)
    return 1
  }
  mkdirSync(agentHome(), { recursive: true })

  try {
    switch (command) {
      case 'init': {
        out(pretty({ ok: true, home: agentHome(), config: configFile(), hint: '在设置页或 config.json 填 ai.deepseek.apiKey' }))
        return 0
      }
      case 'status': {
        out(pretty(app.status()))
        return 0
      }
      case 'brief': {
        out(app.brief())
        return 0
      }
      case 'read': {
        const { world, graph, mods } = await readOnce(app, { deep: !flags.quick, includeSave: !flags['no-save'] })
        if (flags.out) {
          writeFileSync(String(flags.out), JSON.stringify({ world, mods }, null, 2), 'utf8')
          out(`已写入 ${flags.out}`)
        }
        out(
          pretty({
            date: world.date,
            inGame: world.inGame,
            paused: world.paused,
            colonies: world.colonies.length,
            fleets: world.fleetsAll.length,
            activeEvents: world.activeEvents.length,
            eventChains: world.eventChains?.active?.length ?? 0,
            eventIndex: graph.status(),
            mods: { total: mods.total, enabled: mods.enabled },
            save: world.save?.latest?.name || null,
            calls: world.stats?.calls,
            failed: world.errors?.length,
            unsupported: world.unsupported,
            ms: world.readMs,
          }),
        )
        return 0
      }
      case 'actions': {
        const rows = describeActions({ unit: flags.unit || null })
        if (flags.json) {
          out(pretty(rows))
          return 0
        }
        const groups = new Map()
        for (const row of rows) {
          if (!groups.has(row.unit)) groups.set(row.unit, [])
          groups.get(row.unit).push(row)
        }
        for (const [unit, group] of groups) {
          out(`[${unit}]`)
          for (const row of group) {
            const params = row.params.map((param) => `${param.name}${param.required ? '' : '?'}:${param.type}`).join(', ')
            out(`  ${row.method}(${params})${row.confidence === 'inferred' ? ' *' : ''}  ${row.desc}`)
          }
        }
        out('')
        out(`共 ${rows.length} 个动作（* = 参数为推断，首次失败会自动回报）`)
        return 0
      }
      case 'units': {
        const { world } = await readOnce(app, { deep: false, includeSave: false })
        out(pretty(discoverUnits(world, app.config.units)))
        return 0
      }
      case 'events': {
        const sub = positional[0] || 'active'
        if (sub === 'index') {
          const { graph, mods } = graphOnly(app, { force: Boolean(flags.force) })
          out(pretty({ ok: graph.status().ready, index: graph.status(), mods: { enabled: mods.enabled, dirs: mods.eventDirs } }))
          return graph.status().ready ? 0 : 1
        }
        if (sub === 'search') {
          const { graph } = graphOnly(app)
          out(pretty(graph.search(positional.slice(1).join(' '), 30)))
          return 0
        }
        if (sub === 'chain') {
          const id = positional[1]
          if (!id) {
            out('用法：events chain <event_id> [--depth 6]')
            return 2
          }
          const { graph } = graphOnly(app)
          const chain = graph.successors(id, Number(flags.depth ?? 6))
          if (!chain) {
            out(`没有这个事件：${id}`)
            return 1
          }
          out(pretty(chain))
          return 0
        }
        const { world } = await readOnce(app, { deep: true, includeSave: false })
        out(pretty(world.eventChains))
        return 0
      }
      case 'mods': {
        out(pretty(listMods({ userDir: app.paths.userDir || '', installDir: app.paths.installDir || '' })))
        return 0
      }
      case 'connect': {
        const result = await app.connect({ start: flags.start === true ? true : null })
        out(pretty(result))
        if (flags.watch) {
          app.startWatcher()
          out('看护中（自动注入/自动接管），Ctrl+C 退出。')
          await new Promise((resolve) => {
            process.once('SIGINT', resolve)
            process.once('SIGTERM', resolve)
          })
          await app.stop({ resume: true })
        }
        return result.ok ? 0 : 1
      }
      case 'sessions': {
        if (!app.orchestrator) {
          out('编排器未启动：先 `serve` / `run` / `connect`。')
          return 1
        }
        const rows = app.orchestrator.sessions()
        for (const row of rows) {
          const mark = row.running ? '●' : '○'
          out(
            `${mark} ${String(row.id).padEnd(18)} ${String(row.kind).padEnd(6)} ${String(row.status).padEnd(8)} turns=${String(row.turns).padEnd(3)} msgs=${String(row.messageCount).padEnd(3)} ${row.say || row.error || ''}`,
          )
        }
        out('')
        out(`共 ${rows.length} 个会话（main + 单位 + 特殊事件）`)
        return 0
      }
      case 'session': {
        const id = positional[0] || 'main'
        if (!app.orchestrator) {
          out('编排器未启动：先 `serve` / `run` / `connect`。')
          return 1
        }
        const detail = app.orchestrator.sessionDetail(id)
        if (!detail) {
          out(`没有这个会话：${id}`)
          return 1
        }
        out(`# ${detail.label}（${detail.id}）状态=${detail.status} turns=${detail.turns} 消息=${detail.messageCount}`)
        out(`# 目标：${detail.objective || detail.goal || '-'}`)
        if (detail.lastReport?.cause) out(`# 上次失败原因：${detail.lastReport.cause}`)
        out(`# 系统提示（${detail.systemChars} 字符）`)
        out(String(detail.system || '').slice(0, 1500))
        for (const message of detail.messages) {
          const who = message.role === 'assistant' ? 'AI' : message.role === 'user' ? '输入' : message.role
          out('')
          out(`[${who}]`)
          out(message.content)
        }
        return 0
      }
      case 'failures': {
        const store = new FailureStore({ home: app.home, config: app.config, log: app.log })
        const rows = store.list({ limit: Number(flags.limit) || 20 })
        out(pretty({ dir: store.dir, failures: rows }))
        return 0
      }
      case 'failure': {
        const store = new FailureStore({ home: app.home, config: app.config, log: app.log })
        const id = positional[0] || 'latest'
        if (flags.markdown) {
          const text = store.readMarkdown(id)
          if (!text) {
            out(`未找到失败报告：${id}（目录 ${store.dir}）`)
            return 1
          }
          out(text)
          return 0
        }
        const failure = store.read(id)
        if (!failure) {
          out(`未找到失败报告：${id}（目录 ${store.dir}）`)
          return 1
        }
        out(pretty(failure))
        return 0
      }
      case 'ask': {
        const text = positional.join(' ').trim()
        if (!text) {
          out('用法：ask "<内容>" [--id player] [--timeout 120000]')
          return 2
        }
        await app.start({ objective: app.config.objective })
        const result = await app.orchestrator.main.ask({
          id: String(flags.id || 'cli'),
          text,
          timeoutMs: Number(flags.timeout || 120000),
        })
        out(pretty(result))
        await app.stop({ resume: true })
        return result.ok ? 0 : 1
      }
      case 'execute': {
        const payload = flags.file ? JSON.parse(readFileSync(String(flags.file), 'utf8')) : JSON.parse(positional.join(' ') || '[]')
        const actions = Array.isArray(payload) ? payload : payload.actions
        const validated = validateActions(actions)
        if (!validated.ok) {
          out(pretty({ ok: false, error: 'VALIDATION', errors: validated.errors }))
          return 1
        }
        await app.start({ objective: app.config.objective })
        const result = await app.orchestrator.execute(actions, { unit: String(flags.unit || 'cli') })
        out(pretty(result))
        await app.stop({ resume: false })
        return result.ok ? 0 : 1
      }
      case 'call': {
        const method = positional[0]
        if (!method) {
          out('用法：call <method> [json]')
          return 2
        }
        const params = positional.length > 1 ? JSON.parse(positional.slice(1).join(' ')) : {}
        const bridge = await ensureBridge({ config: app.config, log: app.log })
        if (!bridge.ok) {
          out(pretty(bridge))
          return 1
        }
        out(pretty(await bridge.client.request(method, params)))
        return 0
      }
      case 'pause':
      case 'resume': {
        await app.start({ objective: app.config.objective })
        const result = command === 'pause' ? await app.orchestrator.pause() : await app.orchestrator.resume()
        out(pretty(result))
        await app.stop({ resume: false })
        return 0
      }
      case 'run': {
        const objective = flags.objective ? String(flags.objective) : app.config.objective
        const status = await app.start({ objective })
        out(pretty({ ok: true, world: status.orchestrator?.world, backend: status.orchestrator?.backend }))
        if (flags.once) {
          const result = await app.orchestrator.main?.tick({ reason: 'cli-once' })
          out(pretty(result))
          await app.stop({ resume: false })
          return result?.ok ? 0 : 1
        }
        out('Ctrl+C 退出。')
        await new Promise((resolve) => {
          const stop = () => resolve()
          process.once('SIGINT', stop)
          process.once('SIGTERM', stop)
        })
        await app.stop({ resume: true })
        return 0
      }
      case 'serve': {
        if (flags.port) app.config.chat.port = Number(flags.port)
        const handle = await startServer({ app, log: (line, data) => {
          out(data === undefined ? String(line) : `${line} ${JSON.stringify(data)}`)
        } })
        out(`已启动：${handle.url}${app.config.chat.token ? '（需要 token）' : ''}`)
        if (flags.start) {
          try {
            await app.start({ objective: app.config.objective })
            out('编排器已启动。')
          } catch (error) {
            out(`编排器启动失败：${error.message}`)
          }
        }
        await new Promise((resolve) => {
          process.once('SIGINT', resolve)
          process.once('SIGTERM', resolve)
        })
        await app.stop({ resume: true })
        handle.close()
        return 0
      }
      case 'plugin': {
        const sub = positional[0] || 'status'
        if (sub === 'install') {
          const result = installPlugin({ profileDir: String(flags.profile || app.config.dshPlugin.profileDir || ''), copy: Boolean(flags.copy), log: app.log })
          out(pretty(result))
          return result.ok ? 0 : 1
        }
        if (sub === 'update') {
          out(pretty(await app.updatePlugin({ allowRestart: Boolean(flags.restart) })))
          return 0
        }
        if (sub === 'reload') {
          out(pretty(await reloadDsh({ config: app.config, log: app.log, allowRestart: Boolean(flags.restart) })))
          return 0
        }
        out(pretty({ ok: true, ...pluginVersions(), profiles: pluginVersions() }))
        return 0
      }
      case 'dsh-discover': {
        out(pretty(await discoverDsh({ configuredUrl: app.config.ai.dsh.url })))
        return 0
      }
      case 'doctor': {
        const game = await findGameProcess().catch((error) => ({ error: String(error?.message || error) }))
        const bridge = await ensureBridge({ config: app.config, log: app.log })
        const backend = createBackend({ config: app.config, log: app.log })
        const backendInfo = await checkBackend(backend)
        const dsh = await discoverDsh({ configuredUrl: app.config.ai.dsh.url })
        out(
          pretty({
            home: agentHome(),
            config: configFile(),
            paths: app.paths,
            game,
            bridge: bridge.ok
              ? { ok: true, injected: bridge.injected, date: bridge.status?.date?.formatted || bridge.status?.date || null, inGame: Boolean(bridge.status?.in_game), stats: bridge.client?.stats }
              : { ok: false, error: bridge.error, detail: bridge.detail || null },
            backend: backendInfo,
            dsh,
            plugin: pluginVersions(),
            save: app.paths.saveDir,
          }),
        )
        return 0
      }
      case 'selftest': {
        const checks = []
        const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })
        add('node >= 22', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node)
        add('config file', true, configFile())
        add('user dir', Boolean(app.paths.userDir), app.paths.userDir || '未找到')
        add('install dir', Boolean(app.paths.installDir), app.paths.installDir || '未找到')
        add('save dir', Boolean(app.paths.saveDir), app.paths.saveDir || '未找到')
        add('backend configured', app.backendKind() === 'dsh' ? Boolean(app.config.ai.dsh.url) : Boolean(app.config.ai.deepseek.apiKey), app.backendKind())
        const plugin = pluginVersions()
        add('plugin source', Boolean(plugin.version), `${plugin.dir} v${plugin.version}`)
        if (flags.online) {
          const backend = createBackend({ config: app.config, log: app.log })
          const info = await checkBackend(backend)
          add('backend reachable', info.ok, info.error || info.backend)
        }
        for (const check of checks) out(`${check.ok ? '✔' : '✖'} ${check.name}${check.detail ? ' — ' + check.detail : ''}`)
        return checks.every((check) => check.ok) ? 0 : 1
      }
      default:
        out(`未知命令：${command}\n`)
        out(HELP)
        return 2
    }
  } catch (error) {
    out(`错误：${error?.message || error}`)
    if (error?.detail) out(pretty(error.detail))
    return error?.code === 'GAME_NOT_RUNNING' ? 1 : 1
  }
}

export const _internals = { readOnce, parse, execFileAsync, join }
