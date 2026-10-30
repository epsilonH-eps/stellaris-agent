/**
 * CLI：独立软件的唯一入口。
 *
 * 设计原则：
 *   - 不需要 DSH，不需要 Electron；一个 node 进程 + 一个终端就够；
 *   - 读类命令（status/brief/scan/designs/events/journal）不用 API key；
 *   - 思考类命令（ask/chat/serve）才需要 DeepSeek key；
 *   - `--offline` 永远不联网，方便排障。
 *
 * @module stellaris-agent/cli
 */
import { createInterface } from 'node:readline/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { stdin, stdout } from 'node:process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { agentHome, configFile, loadConfig, requireApiKey } from './config.mjs'
import { DeepSeekClient } from './deepseek.mjs'
import { Engine } from './engine.mjs'
import { Orchestrator } from './orchestrator.mjs'
import { createBus } from './bus.mjs'
import { startServer } from './server.mjs'
import { Scheduler } from './scheduler.mjs'
import { Swarm } from './swarm.mjs'
import { ensureNativeBridge } from './native-bridge.mjs'
import { readAll, summarize } from './native-reader.mjs'
import { runSteps } from './native-operator.mjs'
import { NATIVE_WRITE_ACTIONS, auditAgainstDsl } from './native-actions.mjs'
import { buildChains, saveChains, loadChains, chainOf } from './event-chains.mjs'
import { CATALOGUE } from '../../engine/lib/actions.js'
import { discoverDshUrl } from './dsh-discovery.mjs'
import { createLogger } from './logger.mjs'
import { findGameProcess } from './native-bridge.mjs'
import { listVerbs, runVerb } from './native-verbs.mjs'

const execFileAsync = promisify(execFile)

const HELP = `群星参谋 · 独立版

用法：
  stellaris-agent status                 连接/模组/快照/目录
  stellaris-agent brief [--budget 5000]  战局简报
  stellaris-agent refresh [--wait 2500]  让阅读模组立刻导出一份（等价控制台 event dsh_reader.9）
  stellaris-agent scan [--force]         解析最新存档（全量数据）
  stellaris-agent setup                  创建阶段：设计文件 + 安装目录
  stellaris-agent designs [名字]         读创建界面里的自定义帝国
  stellaris-agent events <事件id> [--depth 2]   事件后续
  stellaris-agent journal [--limit 40]   这一局的日志
  stellaris-agent ask "目标" [--read-only] [--no-tools] [--steps N]
  stellaris-agent chat [--read-only]     交互式
  stellaris-agent serve [--port 8787]    本地面板 + 直播接口
  stellaris-agent validate [--game-dir D] 对 4.5 校验两个模组
  stellaris-agent selftest [--online]    自检（--online 会真调一次 API）

常用参数：
  --read-only     只读：不执行任何写操作
  --no-tools      不用 function calling，走三反引号 stellaris 块
  --offline       完全不联网（读类命令默认就不联网）
  --config <file> 用另一份配置

配置文件：${configFile()}
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
  stdout.write(text + '\n')
}

function pretty(value) {
  return JSON.stringify(value, null, 2)
}

export async function run(argv) {
  const { command, positional, flags } = parse(argv)
  if (command === 'help' || flags.help) {
    out(HELP)
    return 0
  }

  const { config } = loadConfig()
  if (flags.model) config.deepseek = { ...(config.deepseek || {}), model: String(flags.model) }
  if (flags.port) config.liveChat = { ...(config.liveChat || {}), port: Number(flags.port) }
  if (flags.readonly || flags['read-only']) config.__readOnly = true

  mkdirSync(agentHome(), { recursive: true })
  const log = createLogger(command)
  log('command.start', { command, args: positional })
  const engine = new Engine({ config, home: agentHome(), log }).init()

  const needsApi = ['ask', 'chat', 'swarm'].includes(command) || (command === 'selftest' && Boolean(flags.online))
  let client = null
  let orchestrator = null
  const bus = config.liveChat?.enabled === false ? null : createBus(config.liveChat)
  if (needsApi) {
    if (flags.offline) {
      out('--offline 下不能使用思考类命令')
      return 2
    }
    const apiKey = requireApiKey(config)
    client = new DeepSeekClient({
      apiKey,
      baseUrl: config.deepseek?.baseUrl,
      model: config.deepseek?.model,
      timeoutMs: config.deepseek?.timeoutMs,
    })
    orchestrator = new Orchestrator({ client, engine, config, log, bus })
  }

  try {
    switch (command) {
      case 'swarm': {
        const swarmConfig = {
          ...config,
          swarm: {
            ...(config.swarm || {}),
            ...(flags.tick ? { tickSeconds: Number(flags.tick) } : {}),
            ...(flags['main-tick'] ? { mainTickSeconds: Number(flags['main-tick']) } : {}),
            ...(flags.queue ? { queuePauseThreshold: Number(flags.queue) } : {}),
            planOnly: Boolean(flags['plan-only']),
            ...(flags.goal ? { objective: String(flags.goal) } : {}),
            ...(flags.backend ? { backend: String(flags.backend) } : {}),
            ...(flags['dsh-url'] ? { dshUrl: String(flags['dsh-url']) } : {}),
          },
        }
        if ((swarmConfig.swarm.backend === 'dsh') && !flags['dsh-url']) {
          try {
            const found = await discoverDshUrl()
            if (found.ok) swarmConfig.swarm.dshUrl = found.url
          } catch {}
        }
        const swarm = new Swarm({ engine, orchestrator, config: swarmConfig, log })
        const started = await swarm.start({ once: Boolean(flags.once) })
        if (!started.ok) { out(pretty(started)); return 1 }
        out(pretty(started))
        out(pretty(swarm.status()))
        if (flags.once) { swarm.stop(); return 0 }
        await new Promise((resolve) => {
          const stop = () => { swarm.stop(); resolve() }
          process.on('SIGINT', stop)
          process.on('SIGTERM', stop)
        })
        return 0
      }
      case 'verbs': {
        const groups = new Map()
        for (const verb of listVerbs()) {
          if (!groups.has(verb.category)) groups.set(verb.category, [])
          groups.get(verb.category).push(verb)
        }
        for (const [category, rows] of groups) {
          out(`[${category}]`)
          for (const row of rows) out(`  ${row.verb}(${row.params.join(', ')})  ${row.help}`)
        }
        out('')
        out(`共 ${listVerbs().length} 个原生动词`)
        return 0
      }
      case 'do': {
        const verb = positional.shift()
        if (!verb) { out('用法：do <动词> <json参数>  或  do <动词> --file x.json'); return 2 }
        let params = {}
        if (flags.file) params = JSON.parse(readFileSync(String(flags.file), 'utf8'))
        else if (positional.length) params = JSON.parse(positional.join(' '))
        const bridge = await ensureNativeBridge({ log })
        if (!bridge.ok) { out(pretty(bridge)); return 1 }
        try {
          const result = await runVerb(bridge.pipe, verb, params, { attempts: Number(flags.attempts ?? 5), log })
          out(pretty(result))
          return result.ok ? 0 : 1
        } finally {
          bridge.pipe.close()
        }
      }
      case 'native-actions': {
        const groups = new Map()
        for (const row of NATIVE_WRITE_ACTIONS) {
          if (!groups.has(row.category)) groups.set(row.category, [])
          groups.get(row.category).push(row)
        }
        for (const [category, rows] of groups) {
          out(`[${category}]`)
          for (const row of rows) out(`  ${row.method}(${row.params.join(', ')})`)
        }
        out('')
        out(`共 ${NATIVE_WRITE_ACTIONS.length} 个原生写动作`)
        return 0
      }
      case 'native-audit': {
        const audit = auditAgainstDsl(CATALOGUE)
        out(pretty({
          nativeWriteCount: audit.nativeWriteCount,
          nativeReadCount: audit.nativeReadCount,
          coveredByDsl: audit.covered,
          gaps: audit.gaps.map((row) => ({ method: row.method, category: row.category, params: row.params })),
          dslOnlyCount: audit.dslOnly.length,
        }))
        return 0
      }
      case 'events-index': {
        const installDir = String(flags['game-dir'] || config.stellarisInstallDir || '')
        if (!installDir) { out('需要 --game-dir 或 config.stellarisInstallDir'); return 2 }
        const data = buildChains(installDir)
        const file = join(agentHome(), 'event-chains.json')
        saveChains(file, data)
        out(pretty({ installDir, events: data.count, ...data.stats, file, sizeKB: Math.round(JSON.stringify(data).length / 1024) }))
        return 0
      }
      case 'events-chain': {
        const id = positional.shift()
        if (!id) { out('用法：events-chain <event_id>'); return 2 }
        const data = loadChains(join(agentHome(), 'event-chains.json'))
        if (!data) { out('先跑 events-index'); return 2 }
        out(pretty(chainOf(data, id, Number(flags.depth ?? 4))))
        return 0
      }
      case 'events-search': {
        const query = positional.join(' ')
        if (!query) { out('用法：events-search <关键词>'); return 2 }
        const data = loadChains(join(agentHome(), 'event-chains.json'))
        if (!data) { out('先跑 events-index'); return 2 }
        const lower = query.toLowerCase()
        const hits = data.events.filter((event) => String(event.id).toLowerCase().includes(lower) || String(event.titleKey || '').toLowerCase().includes(lower)).slice(0, 30)
        out(pretty({ query, hits }))
        return 0
      }
      case 'native-read': {
        const bridge = await ensureNativeBridge({ log })
        if (!bridge.ok) { out(pretty(bridge)); return 1 }
        try {
          const data = await readAll(bridge.pipe, { log, deep: !flags.shallow })
          const target = flags.out ? String(flags.out) : join(agentHome(), 'native-read.json')
          writeFileSync(target, JSON.stringify(data, null, 2), 'utf8')
          out(summarize(data))
          out('')
          out(`完整数据：${target}（${(JSON.stringify(data).length / 1024).toFixed(0)} KB）`)
          return 0
        } finally {
          bridge.pipe.close()
        }
      }
      case 'native-run': {
        const file = positional.shift()
        if (!file) { out('用法：native-run <steps.json>'); return 2 }
        const payload = JSON.parse(readFileSync(file, 'utf8'))
        const steps = Array.isArray(payload) ? payload : payload.steps
        const bridge = await ensureNativeBridge({ log })
        if (!bridge.ok) { out(pretty(bridge)); return 1 }
        try {
          const result = await runSteps(bridge.pipe, steps, {
            attempts: Number(flags.attempts ?? 5),
            log,
            pause: flags.nopause ? false : true,
          })
          out(pretty(result))
          return result.ok ? 0 : 1
        } finally {
          bridge.pipe.close()
        }
      }
      case 'native-status': {
        const bridge = await ensureNativeBridge({ log })
        if (!bridge.ok) { out(pretty(bridge)); return 1 }
        const s = bridge.status
        out(pretty({
          injectedNow: bridge.injected,
          date: s.date?.formatted,
          paused: s.is_paused,
          inGame: s.in_game,
          capital: s.outliner?.sectors_summary?.capital_system,
          colonies: s.outliner?.sectors_summary?.total_colonies,
          pops: s.outliner?.sectors_summary?.total_pops,
          fleets: s.fleets,
          resources: Object.fromEntries(Object.entries(s.resources || {}).slice(0, 6).map(([k, v]) => [k, { stock: v.stockpile, income: v.income, net: v.net }])),
        }))
        bridge.pipe.close()
        return 0
      }
      case 'native-call': {
        const method = positional.shift()
        if (!method) { out('用法：native-call <method> [json]'); return 2 }
        const params = positional.length ? JSON.parse(positional.join(' ')) : {}
        const bridge = await ensureNativeBridge({ log })
        if (!bridge.ok) { out(pretty(bridge)); return 1 }
        try {
          const result = await bridge.pipe.request(method, params)
          out(pretty(result))
          return 0
        } finally {
          bridge.pipe.close()
        }
      }
      case 'doctor': {
        const game = await findGameProcess()
        let injection = null
        if (game) {
          const bridge = await ensureNativeBridge({ log })
          injection = bridge.ok
            ? { ok: true, injected: bridge.injected, date: bridge.status?.date?.formatted || null, inGame: Boolean(bridge.status?.in_game) }
            : { ok: false, error: bridge.error, detail: bridge.detail || null }
          try { bridge.pipe?.close() } catch {}
        }
        const dsh = await discoverDshUrl()
        out(pretty({
          home: agentHome(),
          config: configFile(),
          installDir: engine.status().installDir,
          apiKey: Boolean(String(config.deepseek?.apiKey || '').trim()),
          game,
          injection,
          dsh,
        }))
        return 0
      }
      case 'dsh-discover': {
        out(pretty(await discoverDshUrl()))
        return 0
      }
      case 'init': {
        const file = configFile()
        out(pretty({ ok: true, home: agentHome(), config: file, hint: '已生成默认配置；在 GUI 或 config.json 填 deepseek.apiKey' }))
        return 0
      }
      case 'status': {
        out(pretty(engine.status()))
        return 0
      }
      case 'brief': {
        out(engine.brief(Number(flags.budget ?? 6000)))
        return 0
      }
      case 'refresh': {
        if (flags.manual) config.injection = 'manual'
        const result = await engine.refresh(Number(flags.wait ?? 2500))
        out(pretty(result))
        return result.ok ? 0 : 1
      }
      case 'scan': {
        const result = await engine.saveScan(Boolean(flags.force))
        if (!result.ok) {
          out(pretty(result))
          return 1
        }
        out(pretty({ ok: true, cached: result.cached, meta: result.archive.meta, stats: result.archive.stats, warnings: result.archive.warnings }))
        return 0
      }
      case 'setup': {
        const designs = engine.designs()
        out(pretty({
          userDir: engine.dir,
          installDir: engine.status().installDir,
          designs: designs.ok ? { file: designs.file, count: designs.count, list: designs.designs } : designs,
          saveSetup: engine.state.saveData?.meta ?? null,
        }))
        return 0
      }
      case 'designs': {
        const read = engine.designs()
        if (!read.ok) {
          out(pretty(read))
          return 1
        }
        const query = (positional[0] || '').toLowerCase()
        const list = query ? read.designs.filter((d) => String(d.name || '').toLowerCase().includes(query)) : read.designs
        out(pretty({ file: read.file, count: list.length, designs: list }))
        return 0
      }
      case 'events': {
        const id = positional[0]
        if (!id) {
          out('用法：stellaris-agent events <事件id> [--depth 2]')
          return 2
        }
        out(pretty(engine.eventInfo(id, Number(flags.depth ?? 1))))
        return 0
      }
      case 'journal': {
        out(pretty(engine.journalRead(Number(flags.limit ?? 40))))
        return 0
      }
      case 'ask': {
        const goal = positional.join(' ').trim()
        if (!goal) {
          out('用法：stellaris-agent ask "目标"')
          return 2
        }
        const result = await orchestrator.run({
          goal,
          allowWrite: !config.__readOnly,
          useTools: flags['no-tools'] ? false : undefined,
          maxSteps: Number(flags.steps ?? config.deepseek?.maxSteps ?? 8),
          onEvent: (event) => {
            if (event.type === 'tool') out(`  · 工具 ${event.name}`)
            else if (event.type === 'actions') out(`  · 动作 ${event.text}`)
          },
        })
        if (result.text) out('\n' + result.text)
        out(`\n— ${result.steps} 步 · ${result.usage.totalTokens} tokens${result.applied.length ? ' · ' + result.applied.join('；') : ''}`)
        return result.ok ? 0 : 1
      }
      case 'chat': {
        const rl = createInterface({ input: stdin, output: stdout })
        out('群星参谋已就绪。输入 /status /brief /scan /quit；其它内容当作目标。')
        while (true) {
          let line
          try {
            line = (await rl.question('\n> ')).trim()
          } catch {
            break
          }
          if (!line) continue
          if (line === '/quit' || line === '/exit') break
          if (line === '/status') {
            out(pretty(engine.status()))
            continue
          }
          if (line === '/brief') {
            out(engine.brief(6000))
            continue
          }
          if (line === '/scan') {
            const scanned = await engine.saveScan(false)
            out(pretty(scanned.ok ? { ok: true, stats: scanned.archive.stats } : scanned))
            continue
          }
          const result = await orchestrator.run({
            goal: line,
            allowWrite: !config.__readOnly,
            useTools: flags['no-tools'] ? false : undefined,
            onEvent: (event) => {
              if (event.type === 'tool') out(`  · 工具 ${event.name}`)
            },
          })
          if (result.text) out('\n' + result.text)
          out(`— ${result.usage.totalTokens} tokens`)
        }
        rl.close()
        return 0
      }
      case 'serve': {
        const handle = await startServer({ config, orchestrator, engine, bus, log: out })
        out(`已启动：${handle.url}${config.liveChat?.token ? '（需要 token）' : ''}`)
        out('Ctrl+C 退出。')
        await new Promise((resolve) => {
          process.once('SIGINT', resolve)
          process.once('SIGTERM', resolve)
        })
        handle.close()
        return 0
      }
      case 'validate': {
        const script = new URL('../../tools/validate-mods.mjs', import.meta.url)
        const argv = [script.pathname.replace(/^\//, '')]
        if (flags['game-dir']) argv.push('--game-dir', String(flags['game-dir']))
        try {
          const { stdout } = await execFileAsync(process.execPath, argv, { timeout: 120000, windowsHide: true })
          out(stdout.trim())
          return 0
        } catch (error) {
          if (error?.stdout) out(String(error.stdout).trim())
          else out(String(error?.message || error))
          return 1
        }
      }
      case 'selftest': {
        const checks = []
        const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail })
        add('node >= 22', Number(process.versions.node.split('.')[0]) >= 22, process.versions.node)
        add('config file', true, configFile())
        add('api key', Boolean(config.deepseek?.apiKey), config.deepseek?.apiKey ? '已配置' : '未配置（ask/chat/serve 需要）')
        add('user dir', Boolean(engine.dir), engine.dir || '未找到')
        add('install dir', Boolean(engine.status().installDir), engine.status().installDir || '未找到（事件工具不可用）')
        add('mods', engine.status().mods.reader && engine.status().mods.console, JSON.stringify(engine.status().mods))
        add('snapshot', Boolean(engine.state.current.id), engine.state.current.id || '还没有（进游戏过一个月）')
        const designs = engine.designs()
        checks.push({ name: 'designs', ok: designs.ok, detail: designs.ok ? `${designs.count} 份` : (designs.error || '无'), optional: true })
        if (flags.online && client) {
          try {
            const reply = await client.chat([{ role: 'user', content: '回复 ok 两个字母' }], { maxTokens: 16 })
            add('deepseek api', Boolean(reply.message?.content), reply.model)
          } catch (error) {
            add('deepseek api', false, String(error?.message || error).slice(0, 200))
          }
        }
        for (const check of checks) out(`${check.ok ? '✔' : '✖'} ${check.name}${check.detail ? ' — ' + check.detail : ''}`)
        return checks.every((check) => check.ok || check.optional) ? 0 : 1
      }
      default:
        out(`未知命令：${command}\n`)
        out(HELP)
        return 2
    }
  } finally {
    engine.close()
  }
}
