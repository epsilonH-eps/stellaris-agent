/**
 * 独立版引擎：把「读档 / 快照 / 时间线 / 存盘解析 / 动作编译与注入 / 设计 / 事件 / 日志」
 * 包成一个对象。CLI、面板、编排器都只跟它打交道。
 *
 * 复用 DSH 插件里已经验证过的那套模块（同目录布局下的 lib/），不是复制粘贴：
 *   ../03-dsh-stellaris-bridge/lib/{paths,logtail,state,protocol,actions,compiler,
 *     executor,dsl,injector,timeline,steam,journal,empire/designs,gamedata/events,save/*}
 *
 * 所以独立版和 DSH 版**共用同一份引擎**，行为不会漂。
 *
 * @module stellaris-agent/engine
 */
import { existsSync, watch } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

import { detectLocalMods, listSaves, paths as stellarisPaths, resolveUserDir } from '../../engine/lib/paths.js'
import { LogTail, readRecentErrors } from '../../engine/lib/logtail.js'
import { SnapshotStore } from '../../engine/lib/state.js'
import { normalizeActions } from '../../engine/lib/actions.js'
import { compilePlan } from '../../engine/lib/compiler.js'
import { executeCommands } from '../../engine/lib/executor.js'
import { extractActions } from '../../engine/lib/dsl.js'
import { pressKey } from '../../engine/lib/injector.js'
import { Timeline } from '../../engine/lib/timeline.js'
import { resolveInstallDir } from '../../engine/lib/steam.js'
import { EventIndex } from '../../engine/lib/gamedata/events.js'
import { cloneDesign, createDesign, designStatus, readDesigns } from '../../engine/lib/empire/designs.js'
import { Journal } from '../../engine/lib/journal.js'
import { applyAutopilot } from './autopilot.mjs'
import { latestSave, extractSave, parseGameState, readMeta } from '../../engine/lib/save/savedump.js'
import { DEFAULT_MAPPING, mergeMapping } from '../../engine/lib/save/mapping.js'
import { extractArchive } from '../../engine/lib/save/mapper.js'

function slugPlan() {
  return 's' + Date.now().toString(36)
}

export class Engine {
  constructor({ config, home, log = () => {} }) {
    this.config = config
    this.home = home
    this.log = log
    this.state = new SnapshotStore({ file: join(home, 'snapshot.json') })
    this.timeline = new Timeline({ file: join(home, 'timeline.json') })
    this.journal = new Journal({ dir: join(home, 'journal') })
    this.tail = null
    this.tailDir = ''
    this.eventIndex = null
    this.prevSnapshot = null
    this.lastErrors = []
  }

  get dir() {
    return resolveUserDir(this.config).dir
  }

  init() {
    const resolved = resolveUserDir(this.config)
    this.userDirSource = resolved.source
    this.ensureTail(resolved.dir)
    this.watchSaves(resolved.dir)
    return this
  }

  /** 实时检测：存档目录一有变化就自动解析（读档/存档后不用手动 scan）。 */
  watchSaves(dir) {
    if (!dir) return
    const saves = stellarisPaths(dir).saves
    if (!existsSync(saves)) return
    let timer = null
    try {
      this.saveWatcher = watch(saves, { recursive: true, persistent: false }, () => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          this.saveScan(true).catch(() => {})
        }, 2000)
        timer.unref?.()
      })
    } catch {
      /* 某些文件系统不支持 recursive，忽略 */
    }
  }

  applyAuto(actions) {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
    return applyAutopilot({
      state: this.state,
      config: this.config,
      actions,
      repoRoot,
      userDir: this.dir,
      seqFile: join(this.home, 'autopilot.json'),
    })
  }

  ensureTail(dir) {
    if (this.tail && this.tailDir === dir) return this.tail
    if (this.tail) {
      this.tail.stop()
      this.tail = null
    }
    if (!dir) return null
    const p = stellarisPaths(dir)
    if (!existsSync(p.logs)) return null
    this.tail = new LogTail({
      file: p.gameLog,
      maxBackfillBytes: this.config.log?.maxBackfillBytes ?? 524288,
      pollMs: this.config.log?.pollMs ?? 1500,
    })
    this.tail.on('record', (record) => {
      try {
        this.state.apply(record)
        if (record.kind === 'EVENT' || record.kind === 'CHAIN') this.timeline.ingestRecord(record)
        if (record.kind === 'END') {
          this.timeline.diffSnapshots(this.prevSnapshot, this.state.current)
          this.prevSnapshot = JSON.parse(JSON.stringify(this.state.current))
          this.ensureGame()
        }
      } catch (error) {
        this.log(`读取记录失败：${String(error?.message || error)}`)
      }
    })
    this.tail.on('error', (error) => this.log(`日志读取失败：${String(error?.message || error)}`))
    this.tail.start()
    this.tailDir = dir
    return this.tail
  }

  ensureGame() {
    if (this.config.journal?.enabled === false) return null
    return this.journal.ensureGame({
      empireName: this.state.current.empire?.name,
      date: this.state.current.date,
      saveFile: this.state.saveData?.meta?.file,
    })
  }

  close() {
    if (this.tail) this.tail.stop()
    if (this.saveWatcher) this.saveWatcher.close()
    this.tail = null
    this.saveWatcher = null
  }

  // ---------------------------------------------------------------- 读
  status() {
    const dir = this.dir
    const detected = dir ? detectLocalMods(dir) : { reader: false, console: false, modDirExists: false }
    const mods = { ...detected, optional: true, native: true }
    const install = resolveInstallDir(this.config)
    return {
      userDir: dir,
      userDirSource: this.userDirSource,
      installDir: install.dir,
      mods,
      injection: this.config.injection,
      snapshot: {
        id: this.state.current.id,
        date: this.state.current.date,
        ageSec: this.state.ageSec,
        partial: this.state.current.partial,
        planets: this.state.current.planets.length,
        resources: Object.keys(this.state.current.resources).length,
        logLocalisation: this.state.logLocalisation,
      },
      saves: dir ? listSaves(dir, 3).map((s) => ({ name: s.name, ageSec: Math.round((Date.now() - s.mtimeMs) / 1000) })) : [],
      saveData: this.state.saveData ? { stats: this.state.saveData.stats, date: this.state.saveData.meta?.date } : null,
      timeline: this.timeline.status(),
      journal: this.journal.status(),
      designs: dir ? designStatus(dir) : { available: false },
      logTail: this.tail ? { ...this.tail.stats } : null,
    }
  }

  brief(budget = 6000) {
    const parts = [this.state.brief(budget)]
    const recent = this.timeline.brief(8)
    if (recent) parts.push('\n## 最近事件\n' + recent)
    return parts.join('\n')
  }

  query(what, name) {
    const list = {
      leaders: this.state.current.leaders.length ? this.state.current.leaders : this.state.saveData?.leaders || [],
      fleets: this.state.current.fleets.length ? this.state.current.fleets : this.state.saveData?.fleets || [],
      techs: this.state.current.techs.length ? this.state.current.techs : this.state.saveData?.techs || [],
      traditions: this.state.current.traditions.length ? this.state.current.traditions : this.state.saveData?.traditions || [],
      perks: this.state.current.perks.length ? this.state.current.perks : this.state.saveData?.perks || [],
      relics: this.state.current.relics.length ? this.state.current.relics : this.state.saveData?.relics || [],
      diplo: this.state.saveData?.diplo || this.state.current.diplo,
      situations: this.state.saveData?.situations || this.state.current.situations,
    }
    if (what === 'resources') return { resources: this.state.current.resources, saveResources: this.state.saveData?.resources }
    if (what === 'planet') {
      if (!name) return { planets: this.state.current.planets }
      const found = this.state.findPlanet(name)
      return found ? { planet: found.planet, index: found.index } : { error: `找不到星球：${name}` }
    }
    const rows = list[what]
    if (!rows) return { error: `不支持的查询：${what}` }
    const query = String(name || '').toLowerCase()
    const filtered = query
      ? rows.filter((row) => JSON.stringify(row).toLowerCase().includes(query))
      : rows
    return { [what]: filtered }
  }

  async refresh(waitMs = 2500) {
    const dir = this.dir
    if (!dir) return { ok: false, error: '找不到群星用户目录' }
    const before = this.state.current.startedAt
    const commands = [{ cmd: `r${Date.now().toString(36)}`, line: 'effect = { country_event = { id = dsh_reader.9 days = 0 } }' }]
    const result = await executeCommands({
      config: this.config,
      queueDir: stellarisPaths(dir).queueDir,
      state: this.state,
      commands,
      planId: slugPlan(),
    })
    await new Promise((resolve) => setTimeout(resolve, waitMs))
    return { ok: this.state.current.startedAt > before, refreshed: this.state.current.startedAt > before, injection: result }
  }

  async saveScan(force = false) {
    const dir = this.dir
    if (!dir) return { ok: false, error: '找不到群星用户目录' }
    const latest = latestSave(dir)
    if (!latest) return { ok: false, error: 'save games/ 里没有 .sav' }
    if (!force && this.state.saveData?.meta?.file === latest.file && this.state.saveData?.meta?.mtimeMs === latest.mtimeMs) {
      return { ok: true, cached: true, archive: this.state.saveData }
    }
    const extracted = await extractSave(latest.file, join(this.home, 'cache'))
    const meta = readMeta(extracted.meta)
    const gamestate = parseGameState(extracted.gamestate)
    const archive = extractArchive({
      gamestate,
      meta,
      mapping: mergeMapping(DEFAULT_MAPPING, null),
    })
    archive.meta.file = latest.file
    archive.meta.mtimeMs = latest.mtimeMs
    this.state.saveData = archive
    try {
      this.timeline.ingestArchive(archive)
    } catch {
      /* 容错 */
    }
    if (this.state.current.planets.length === 0 && archive.planets.length) {
      this.state.current.planets = archive.planets.map((planet) => ({ ...planet, source: 'save' }))
      this.state.current.endedAt = Date.now()
    }
    this.ensureGame()
    return { ok: true, cached: false, archive }
  }

  // ---------------------------------------------------------------- 写
  async apply(actions, options = {}) {
    const dir = this.dir
    if (!dir) return { ok: false, error: '找不到群星用户目录' }
    const safety = this.config.safety || {}
    const normalized = normalizeActions(actions, {
      allowExperimental: Boolean(options.allowExperimental ?? safety.allowExperimental),
      allowRawEffect: Boolean(options.allowRawEffect ?? safety.allowRawEffect),
      maxResourcePerAction: safety.maxResourcePerAction,
    })
    if (!normalized.ok) return { ok: false, code: 'VALIDATION', errors: normalized.errors }
    if (this.state.saveData?.meta?.ironman) return { ok: false, code: 'IRONMAN', error: '铁人档：只读' }
    if (normalized.actions.length > Number(safety.maxActionsPerTurn ?? 8)) {
      return { ok: false, code: 'TOO_MANY', error: `一次最多 ${safety.maxActionsPerTurn} 条动作` }
    }
    const planId = slugPlan()
    const uiActions = normalized.actions.filter((item) => item.verb === 'open_ui')
    const executable = normalized.actions.filter((item) => item.verb !== 'open_ui')
    const uiResults = []
    for (const item of uiActions) uiResults.push({ view: item.params.view, result: await this.openUI(item.params.view) })
    if (executable.length === 0) {
      const summary = uiResults.map((row) => `open_ui:${row.view}:${row.result.ok ? 'ok' : 'fail'}`).join(' ')
      return { ok: uiResults.every((row) => row.result.ok), planId, summary, ui: uiResults, results: [] }
    }
    const compiled = compilePlan(executable, {
      state: this.state,
      config: this.config,
      planId,
      lane: 0,
      force: Boolean(options.force),
    })
    if (!compiled.commands.length) return { ok: false, code: 'COMPILE', errors: compiled.errors }
    const result = await executeCommands({
      config: this.config,
      queueDir: stellarisPaths(dir).queueDir,
      state: this.state,
      commands: compiled.commands,
      planId,
      dryRun: Boolean(options.dryRun),
    })
    const summary = result.results.map((item) => `${item.verb}:${item.status}`).join(' ')
    if (!options.dryRun) {
      this.journal.append({
        kind: 'plan',
        date: this.state.current.date,
        text: `apply ${summary}`,
        meta: { planId, verbs: compiled.commands.map((c) => c.verb) },
      })
    }
    return {
      ok: result.results.every((item) => item.status === 'ok') || result.mode !== 'auto',
      planId,
      mode: result.mode,
      summary,
      results: result.results,
      errorLog: result.errorLog,
      compileErrors: compiled.errors,
      dryRun: Boolean(options.dryRun),
    }
  }

  applyReply(text, options = {}) {
    const extracted = extractActions(text)
    if (!extracted.actions.length) {
      return Promise.resolve({ ok: false, code: 'NO_ACTION', error: '回复里没有 ```stellaris 动作块', parsed: extracted })
    }
    return this.apply(extracted.actions, options)
  }

  async openUI(view) {
    const mode = String(this.config.uiMode || 'hotkey')
    if (mode === 'hotkey') {
      const key = this.config.uiHotkeys?.[view]
      if (!key) return { ok: false, error: `没有为 ${view} 配热键` }
      const result = await pressKey(this.config, key)
      return { ok: result.ok, mode, view, key, result }
    }
    // terminal / effect 模式：走模组 B 的入口
    const cmd = `ui${Date.now().toString(36)}`
    const line = mode === 'effect'
      ? `effect = { set_global_variable = { name = dsh_ui_effect value = 1 } dsh_console_ui_${view}_direct = yes log = "DSH1|0|ACK|cmd=${cmd}|phase=done" }`
      : `effect = { dsh_console_ui_${view}_notice = yes log = "DSH1|0|ACK|cmd=${cmd}|phase=done" }`
    const result = await executeCommands({
      config: this.config,
      queueDir: stellarisPaths(this.dir).queueDir,
      state: this.state,
      commands: [{ cmd, line }],
      planId: cmd,
    })
    return { ok: result.results.every((item) => item.status === 'ok'), mode, view, results: result.results }
  }

  // ---------------------------------------------------------------- 创建阶段 / 事件
  designs() {
    const dir = this.dir
    if (!dir) return { ok: false, error: '找不到群星用户目录' }
    return readDesigns(dir)
  }

  cloneDesign(params) {
    const dir = this.dir
    if (!dir) return { ok: false, error: '找不到群星用户目录' }
    return cloneDesign({ dir, ...params })
  }

  createDesign(params) {
    const dir = this.dir
    if (!dir) return { ok: false, error: '找不到群星用户目录' }
    return createDesign({ dir, ...params })
  }

  events(force = false) {
    if (!this.eventIndex || force || this.eventIndex.installDir !== resolveInstallDir(this.config).dir) {
      const resolved = resolveInstallDir(this.config)
      this.eventIndex = new EventIndex({ installDir: resolved.dir }).build(force)
    }
    return this.eventIndex
  }

  eventInfo(id, depth = 1) {
    const install = resolveInstallDir(this.config)
    if (!install.dir) return { ok: false, code: 'INSTALL_NOT_FOUND', error: '找不到群星安装目录（config.stellarisInstallDir）' }
    const index = this.events()
    if (!index.ready) return { ok: false, code: 'INDEX_EMPTY', error: '没找到事件定义' }
    const walk = (eventId, level, seen = new Set()) => {
      if (seen.has(eventId) || level > depth) return null
      seen.add(eventId)
      const info = index.successorsOf(eventId)
      if (!info) return { id: eventId, missing: true }
      return {
        id: info.id,
        title: index.title(info.titleKey),
        hidden: info.hidden,
        next: info.next.map((child) => walk(child.id, level + 1, seen)),
      }
    }
    const result = walk(id, 1)
    if (!result || result.missing) return { ok: false, code: 'NOT_FOUND', error: `没有这个事件：${id}` }
    return { ok: true, event: result }
  }

  eventSearch(query, limit = 20) {
    const index = this.events()
    if (!index.ready) return { ok: false, code: 'INSTALL_NOT_FOUND', error: '找不到事件定义（配置 stellarisInstallDir）' }
    return {
      ok: true,
      hits: index.search(query, limit).map((hit) => ({ ...hit, title: index.title(hit.titleKey) })),
    }
  }

  // ---------------------------------------------------------------- 日志 / 直播
  journalWrite(note, kind = 'note', tags = []) {
    return this.journal.append({ kind, text: note, tags, date: this.state.current.date })
  }

  journalRead(limit = 40) {
    return this.journal.read(limit)
  }

  recentErrors() {
    const dir = this.dir
    if (!dir) return []
    return readRecentErrors(join(stellarisPaths(dir).logs, 'error.log'), { sinceMs: Date.now() - 60000 })
  }
}
