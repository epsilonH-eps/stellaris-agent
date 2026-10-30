/**
 * 本地 HTTP 服务：GUI / 外部脚本 / 直播接入都用它。
 *
 * 约定：
 *  - 只绑 127.0.0.1；`chat.token` 非空时要求 `Authorization: Bearer`（或 `?token=`）；
 *  - 成功 `{ok:true,...}`，失败 `{ok:false,error:<短码>,detail?}`；
 *  - 读接口不触发写操作；写动作一律进执行器（串行 + 读回 + 阈值暂停）。
 *
 * 路由分组：
 *   状态      /api/health /api/status /api/brief /api/diagnostics
 *   读取      /api/world /api/world/events /api/mods /api/actions /api/units /api/events/*
 *   执行      /api/execute /api/executor /api/pause /api/resume
 *   编排      /api/orchestrator/{start,stop,restart,objective}
 *   聊天      /api/chat/{in,out,poll,history,stream}
 *   设置      /api/settings /api/plugin/{install,update,reload} /api/dsh/discover
 *
 * @module stellaris-agent/server
 */
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { describeActions } from './actions.mjs'
import { logFile } from './logger.mjs'
import { redactConfig } from './app.mjs'

const VERSION = '2.0.0'

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function fail(res, status, error, detail = null) {
  return json(res, status, detail === null ? { ok: false, error } : { ok: false, error, detail })
}

async function readBody(req, limit = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) return null
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

function compactWorld(world) {
  if (!world) return null
  const copy = { ...world }
  delete copy.systems
  delete copy.designCatalog
  delete copy.discoveries
  copy.colonies = (world.colonies || []).map((colony) => ({
    planet_id: colony.planet_id,
    name: colony.name ?? colony.details?.planet_name ?? null,
    pops: colony.details?.population ?? colony.pops ?? null,
    stability: colony.details?.stability ?? colony.stability ?? null,
    jobs: colony.jobs,
    buildable: {
      buildings: colony.buildableBuildings,
      districts: colony.buildableDistricts,
      zones: colony.districtZones,
      blockers: colony.clearableBlockers,
      decisions: colony.decisions,
      terraforming: colony.terraforming,
    },
    queue: colony.details?.construction_queue ?? null,
  }))
  copy.fleetsDetail = (world.fleetsDetail || []).map((row) => ({ fleet_id: row.fleet_id, kind: row.kind, summary: row.summary, detail: row.detail }))
  return copy
}

const PAGE = `<!doctype html>
<html lang="zh"><meta charset="utf-8"><title>群星参谋</title>
<style>
 :root{color-scheme:dark}body{margin:0;font:14px/1.6 ui-sans-serif,system-ui;background:#0d1117;color:#c9d1d9}
 header{padding:10px 16px;border-bottom:1px solid #21262d;display:flex;gap:12px;align-items:center}
 main{display:grid;grid-template-columns:1.2fr 1fr;gap:12px;padding:12px}
 section{background:#11161d;border:1px solid #21262d;border-radius:8px;padding:12px;min-height:70vh;display:flex;flex-direction:column}
 pre{white-space:pre-wrap;word-break:break-word;margin:0;font:12px/1.55 ui-monospace,Consolas;overflow:auto;flex:1}
 input,button,select{background:#0d1117;color:#c9d1d9;border:1px solid #30363d;border-radius:6px;padding:8px}
 button{background:#238636;color:#fff;border:0;cursor:pointer}
 .row{display:flex;gap:8px;margin-top:8px}.tag{color:#8b949e;font-size:12px}
</style>
<header><strong>群星参谋</strong><span class="tag" id="conn">连接中…</span>
 <button onclick="load()">刷新</button></header>
<main>
 <section><h3>战局</h3><pre id="brief">…</pre></section>
 <section><h3>聊天</h3><pre id="chat" style="max-height:55vh"></pre>
  <div class="row"><input id="who" value="player" style="width:110px" placeholder="id">
   <input id="msg" style="flex:1" placeholder="对参谋说点什么"><button onclick="send()">发送</button></div>
  <div class="row"><span class="tag" id="hint"></span></div>
 </section>
</main>
<script>
const token=new URLSearchParams(location.search).get('token')||'';
const headers={'content-type':'application/json'};if(token)headers.authorization='Bearer '+token;
const chat=document.getElementById('chat');
function add(t){chat.textContent+=t+'\\n';chat.scrollTop=chat.scrollHeight}
async function load(){
 const s=await (await fetch('/api/status',{headers})).json();
 document.getElementById('conn').textContent=(s.running?'运行中':'未启动')+' · '+(s.backend||'')+' · '+(s.paths?.userDir||'无用户目录');
 const b=await (await fetch('/api/brief',{headers})).json();
 document.getElementById('brief').textContent=b.brief||b.error||'';
}
async function send(){
 const text=document.getElementById('msg').value.trim();if(!text)return;
 const id=document.getElementById('who').value.trim()||'player';
 document.getElementById('msg').value='';
 const r=await fetch('/api/chat/in',{method:'POST',headers,body:JSON.stringify({id,text})});
 const d=await r.json();document.getElementById('hint').textContent=d.ok?'已送达，等待主会话':'失败：'+(d.error||'');
}
let since=0;
async function poll(){
 try{
  const d=await (await fetch('/api/chat/poll?since='+since,{headers})).json();
  for(const m of d.messages||[]){add((m.direction==='in'?'你':'参谋')+'：'+m.text);since=Math.max(since,m.seq)}
 }catch{}
 setTimeout(poll,2000);
}
load();poll();setInterval(load,10000);
</script>`

/**
 * @param {object} options
 * @param {import('./app.mjs').App} options.app
 * @param {Function} [options.log]
 */
export function startServer({ app, log = () => {} }) {
  const port = Number(app.config?.chat?.port ?? 8787)
  const token = String(app.config?.chat?.token || '')
  const authorized = (req, url) => {
    if (!token) return true
    const header = String(req.headers.authorization || '')
    return header === `Bearer ${token}` || url.searchParams.get('token') === token
  }

  const sseClients = new Set()
  const broadcast = (event, payload) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`
    for (const res of sseClients) {
      try {
        res.write(frame)
      } catch {
        sseClients.delete(res)
      }
    }
  }

  const requireOrchestrator = () => {
    if (!app.orchestrator?.running) {
      const error = new Error('调度器未启动')
      error.code = 'ORCHESTRATOR_NOT_RUNNING'
      throw error
    }
    return app.orchestrator
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!authorized(req, url)) return fail(res, 401, 'UNAUTHORIZED')
    const path = url.pathname
    const method = req.method || 'GET'
    try {
      // ---------------------------------------------------------------- 页面
      if (method === 'GET' && path === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        return res.end(PAGE)
      }
      if (method === 'GET' && path === '/api/health') {
        return json(res, 200, { ok: true, name: 'stellaris-agent', version: VERSION, running: app.running })
      }
      if (method === 'GET' && path === '/api/status') return json(res, 200, { ok: true, ...app.status() })
      if (method === 'GET' && path === '/api/brief') return json(res, 200, { ok: true, brief: app.brief() })
      if (method === 'GET' && path === '/api/readiness') {
        return json(res, 200, { ok: true, ...(await app.readiness({ verifyLlm: url.searchParams.get('verify') === '1' })) })
      }
      if (method === 'POST' && path === '/api/connect') {
        const body = await readBody(req)
        return json(res, 200, { ok: true, ...(await app.connect({ start: body?.start })) })
      }

      // ---------------------------------------------------------------- 会话
      if (method === 'GET' && path === '/api/sessions') {
        const orchestrator = app.orchestrator
        return json(res, 200, { ok: true, sessions: orchestrator?.sessions() || [] })
      }
      if (method === 'GET' && path.startsWith('/api/sessions/')) {
        const orchestrator = app.orchestrator
        const id = decodeURIComponent(path.slice('/api/sessions/'.length))
        const session = orchestrator?.sessionDetail(id) || null
        if (!session) return fail(res, 404, 'SESSION_NOT_FOUND', id)
        return json(res, 200, { ok: true, session })
      }

      if (method === 'GET' && path === '/api/diagnostics') {
        let tail = ''
        try {
          tail = readFileSync(logFile(), 'utf8').split(/\r?\n/).slice(-200).join('\n')
        } catch {
          /* 没有日志 */
        }
        const orchestrator = app.orchestrator
        return json(res, 200, {
          ok: true,
          time: new Date().toISOString(),
          version: VERSION,
          node: process.version,
          platform: process.platform,
          home: app.home,
          configFile: app.configFile,
          config: redactConfig(app.config),
          paths: app.paths,
          plugin: app.status().plugin,
          dsh: app.orchestrator?.backend?.describe?.() || { backend: app.backendKind() },
          probe: app._probeBackend
            ? {
                class: app._probeBackend.constructor?.name || null,
                url: app._probeBackend.baseUrl || null,
                autoDiscover: app._probeBackend.autoDiscover ?? null,
                lastHealth: app._probeBackend.lastHealth || null,
              }
            : null,
          readinessCache: app._readiness || null,
          bridge: orchestrator?.status().bridge || null,
          world: orchestrator?.world?.status() || null,
          executor: orchestrator?.executor?.status() || null,
          unsupportedMethods: orchestrator?.reader?.unsupported ? [...orchestrator.reader.unsupported] : [],
          lastError: app.lastError,
          logTail: tail,
          logFile: logFile(),
        })
      }

      // ---------------------------------------------------------------- 读取
      if (method === 'GET' && path === '/api/world') {
        const orchestrator = requireOrchestrator()
        const world = orchestrator.world?.current
        if (!world) return fail(res, 503, 'NO_WORLD')
        return json(res, 200, { ok: true, world: url.searchParams.get('full') === '1' ? world : compactWorld(world) })
      }
      if (method === 'GET' && path === '/api/world/events') {
        const orchestrator = requireOrchestrator()
        const world = orchestrator.world?.current
        return json(res, 200, {
          ok: true,
          active: world?.eventChains?.active || [],
          unresolved: world?.eventChains?.unresolved || [],
          index: orchestrator.eventGraph?.status() || null,
          alerts: world?.alerts || [],
        })
      }
      if (method === 'GET' && path === '/api/mods') {
        const orchestrator = app.orchestrator
        return json(res, 200, { ok: true, mods: orchestrator?.mods || null })
      }
      if (method === 'GET' && path === '/api/actions') {
        return json(res, 200, { ok: true, actions: describeActions({ unit: url.searchParams.get('unit') || null }) })
      }
      if (method === 'GET' && path === '/api/units') {
        const orchestrator = app.orchestrator
        if (!orchestrator) return json(res, 200, { ok: true, units: [] })
        return json(res, 200, { ok: true, units: orchestrator.status().units })
      }
      if (method === 'GET' && path === '/api/events/search') {
        const orchestrator = requireOrchestrator()
        const query = String(url.searchParams.get('q') || '')
        if (!query) return fail(res, 400, 'MISSING_QUERY')
        return json(res, 200, { ok: true, hits: orchestrator.eventGraph?.search(query, 30) || [] })
      }
      if (method === 'GET' && path === '/api/events/chain') {
        const orchestrator = requireOrchestrator()
        const id = String(url.searchParams.get('id') || '')
        if (!id) return fail(res, 400, 'MISSING_ID')
        const depth = Number(url.searchParams.get('depth') || 6)
        const chain = orchestrator.eventGraph?.successors(id, Math.min(12, Math.max(1, depth))) || null
        if (!chain) return fail(res, 404, 'EVENT_NOT_FOUND', id)
        return json(res, 200, { ok: true, chain })
      }

      // ---------------------------------------------------------------- 执行
      if (method === 'POST' && path === '/api/execute') {
        const body = await readBody(req)
        if (!body || !Array.isArray(body.actions)) return fail(res, 400, 'EXPECTED_ACTIONS')
        const orchestrator = requireOrchestrator()
        const result = await orchestrator.execute(body.actions, { unit: body.unit || 'api', source: 'api' })
        return json(res, result.ok ? 200 : 422, result)
      }
      if (method === 'GET' && path === '/api/executor') {
        const orchestrator = app.orchestrator
        return json(res, 200, { ok: true, executor: orchestrator?.executor?.status() || null })
      }
      if (method === 'POST' && path === '/api/pause') return json(res, 200, await requireOrchestrator().pause())
      if (method === 'POST' && path === '/api/resume') return json(res, 200, await requireOrchestrator().resume())
      if (method === 'POST' && path === '/api/refresh') {
        const body = await readBody(req)
        const orchestrator = requireOrchestrator()
        const world = await orchestrator.refreshWorld({ deep: body?.deep !== false })
        return json(res, 200, { ok: true, world: world ? compactWorld(world) : null })
      }

      // ---------------------------------------------------------------- 编排
      if (method === 'POST' && path === '/api/orchestrator/start') {
        const body = await readBody(req)
        const status = await app.start({ objective: body?.objective ?? app.config.objective ?? '' })
        return json(res, 200, { ok: true, status })
      }
      if (method === 'POST' && path === '/api/orchestrator/stop') {
        const body = await readBody(req)
        return json(res, 200, await app.stop({ resume: body?.resume !== false, suppressAuto: body?.suppressAuto !== false }))
      }
      if (method === 'POST' && path === '/api/orchestrator/restart') {
        const body = await readBody(req)
        return json(res, 200, await app.restart({ objective: body?.objective ?? app.config.objective ?? '' }))
      }
      if (method === 'POST' && path === '/api/orchestrator/objective') {
        const body = await readBody(req)
        if (typeof body?.objective !== 'string') return fail(res, 400, 'EXPECTED_OBJECTIVE')
        return json(res, 200, requireOrchestrator().setObjective(body.objective))
      }

      // ---------------------------------------------------------------- 主会话直连
      if (method === 'GET' && path === '/api/main') {
        const orchestrator = app.orchestrator
        if (!orchestrator?.main) return fail(res, 409, 'ORCHESTRATOR_NOT_RUNNING')
        return json(res, 200, { ok: true, main: orchestrator.main.status(), session: orchestrator.main.summary() })
      }
      if (method === 'POST' && path === '/api/main/ask') {
        const body = await readBody(req)
        if (!body || typeof body.text !== 'string' || !body.text.trim()) return fail(res, 400, 'EXPECTED_TEXT')
        const orchestrator = requireOrchestrator()
        if (!orchestrator.main) return fail(res, 503, 'MAIN_NOT_READY')
        const result = await orchestrator.main.ask({
          id: body.id || 'human',
          text: body.text,
          timeoutMs: Number(body.timeoutMs) || 120000,
        })
        const status = result.ok ? 200 : result.error === 'BUSY' ? 409 : result.error === 'EMPTY_TEXT' ? 400 : 422
        return json(res, status, result)
      }

      // ---------------------------------------------------------------- 聊天
      if (method === 'POST' && path === '/api/chat/in') {
        const body = await readBody(req)
        const orchestrator = requireOrchestrator()
        const result = orchestrator.chat.inbound({ id: body?.id ?? 'player', text: body?.text, name: body?.name ?? null, meta: body?.meta ?? null })
        if (!result.ok) return fail(res, 400, result.error)
        orchestrator.scheduleMain('chat', 500)
        return json(res, 200, { ok: true, message: result.message })
      }
      if (method === 'POST' && path === '/api/chat/out') {
        const body = await readBody(req)
        const orchestrator = requireOrchestrator()
        const result = orchestrator.chat.outbound({ text: body?.text, id: body?.id ?? 'external', kind: body?.kind || 'say' })
        if (!result.ok) return fail(res, 400, result.error)
        return json(res, 200, { ok: true, message: result.message })
      }
      if (method === 'GET' && (path === '/api/chat/poll' || path === '/api/chat/out')) {
        const orchestrator = app.orchestrator
        if (!orchestrator?.chat) {
          // 编排器没启动时轮询返回空，避免 GUI 每 2 秒撞一次 409
          return json(res, 200, { ok: true, messages: [], next: Number(url.searchParams.get('since') || 0), last: 0 })
        }
        return json(res, 200, { ok: true, ...orchestrator.chat.poll({ since: Number(url.searchParams.get('since') || 0), limit: Number(url.searchParams.get('limit') || 200) }) })
      }
      if (method === 'GET' && path === '/api/chat/history') {
        const orchestrator = app.orchestrator
        if (!orchestrator?.chat) return json(res, 200, { ok: true, messages: [] })
        return json(res, 200, { ok: true, messages: orchestrator.chat.history({ limit: Number(url.searchParams.get('limit') || 100) }) })
      }
      if (method === 'GET' && (path === '/api/chat/stream' || path === '/api/stream')) {
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        })
        res.write('event: hello\ndata: {"ok":true}\n\n')
        sseClients.add(res)
        const ping = setInterval(() => {
          try {
            res.write(': ping\n\n')
          } catch {
            sseClients.delete(res)
          }
        }, 15000)
        ping.unref?.()
        req.on('close', () => {
          clearInterval(ping)
          sseClients.delete(res)
        })
        return undefined
      }

      // ---------------------------------------------------------------- 设置 / 插件
      if (method === 'GET' && path === '/api/settings') {
        return json(res, 200, { ok: true, config: redactConfig(app.config), configFile: app.configFile, configError: app.configError, paths: app.paths })
      }
      if ((method === 'POST' || method === 'PUT') && path === '/api/settings') {
        const body = await readBody(req)
        if (!body || typeof body !== 'object') return fail(res, 400, 'EXPECTED_OBJECT')
        const result = await app.applySettings(body)
        return json(res, 200, result)
      }
      if (method === 'POST' && path === '/api/plugin/install') {
        const body = await readBody(req)
        return json(res, 200, { ok: true, ...(await app.installPlugin({ copy: body?.copy === true })) })
      }
      if (method === 'POST' && path === '/api/plugin/update') {
        const body = await readBody(req)
        const result = await app.updatePlugin({ allowRestart: body?.allowRestart === true })
        return json(res, 200, { ok: result.ok, ...result })
      }
      if (method === 'POST' && path === '/api/plugin/reload') {
        const body = await readBody(req)
        const result = await app.reloadPlugin({ allowRestart: body?.allowRestart === true })
        return json(res, 200, { ok: result.ok, ...result })
      }
      if (method === 'GET' && path === '/api/dsh/discover') {
        return json(res, 200, { ok: true, ...(await app.discoverDsh()) })
      }

      return fail(res, 404, 'NOT_FOUND', path)
    } catch (error) {
      const code = error?.code || 'INTERNAL'
      const status = code === 'ORCHESTRATOR_NOT_RUNNING' ? 409 : code === 'GAME_NOT_IN_SESSION' || code === 'GAME_NOT_RUNNING' ? 503 : 500
      log('http.error', { path, code, error: String(error?.message || error) })
      return fail(res, status, code, { message: String(error?.message || error), detail: error?.detail || null })
    }
  })

  // 聊天/世界事件推给 SSE 客户端（编排器可能在 serve 之后才启动，所以惰性挂载）
  let attachedChat = null
  const attachIfNeeded = () => {
    const chat = app.orchestrator?.chat
    if (!chat || chat === attachedChat) return
    attachedChat = chat
    chat.on('in', (row) => broadcast('chat', { direction: 'in', ...row }))
    chat.on('out', (row) => broadcast('chat', { direction: 'out', ...row }))
  }
  const attachTimer = setInterval(attachIfNeeded, 2000)
  attachTimer.unref?.()

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address()?.port ?? port
      const address = `http://127.0.0.1:${actual}`
      log(`面板：${address}`)
      attachIfNeeded()
      // 一次注入后自动续上：游戏在跑就保证桥可用，进局就自动接管
      app.startWatcher()
      // 每次启动：更新并热重载 DSH 插件（不杀 DSH）
      if (app.config?.dshPlugin?.autoInstall !== false) {
        app
          .updatePlugin({ allowRestart: false })
          .then((result) => {
            for (const message of result.messages || []) log(`[dsh-plugin] ${message}`)
          })
          .catch((error) => log('[dsh-plugin] 更新失败', { error: String(error?.message || error) }))
      }
      resolve({ server, url: address, close: () => server.close() })
    })
  })
}
