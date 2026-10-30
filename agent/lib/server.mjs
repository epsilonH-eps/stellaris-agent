/**
 * 本地面板 + 直播接口。
 *
 * 只绑 127.0.0.1；配了 token 就要求 Bearer。页面是一个内联单页，
 * 不做构建、不引前端框架——独立软件不该为了一个面板背 npm 依赖。
 *
 * @module stellaris-agent/server
 */
import { createServer } from 'node:http'

import { ensureNativeBridge, findGameProcess, NativePipe } from './native-bridge.mjs'
import { readAll, summarize } from './native-reader.mjs'
import { runSteps } from './native-operator.mjs'
import { Swarm } from './swarm.mjs'
import { discoverDshUrl } from './dsh-discovery.mjs'
import { logFile } from './logger.mjs'
import { readFileSync } from 'node:fs'
import { agentHome } from './config.mjs'
import { loadChains, chainOf } from './event-chains.mjs'
import { join } from 'node:path'

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

async function readBody(req, limit = 256 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.byteLength
    if (size > limit) return null
    chunks.push(chunk)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}

const PAGE = `<!doctype html>
<html lang="zh">
<meta charset="utf-8">
<title>群星参谋</title>
<style>
  :root { color-scheme: dark }
  body { margin: 0; font: 14px/1.5 ui-sans-serif, system-ui; background:#0d1117; color:#c9d1d9 }
  header { padding: 10px 16px; border-bottom: 1px solid #21262d; display:flex; gap:12px; align-items:center }
  main { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; padding: 12px }
  section { background:#11161d; border:1px solid #21262d; border-radius:8px; padding:12px; min-height: 60vh }
  pre { white-space: pre-wrap; word-break: break-word; margin:0; font: 12px/1.55 ui-monospace, Consolas }
  textarea { width:100%; height:70px; background:#0d1117; color:#c9d1d9; border:1px solid #30363d; border-radius:6px; padding:8px }
  button { background:#238636; color:#fff; border:0; border-radius:6px; padding:8px 14px; cursor:pointer }
  button.ghost { background:#21262d }
  .row { display:flex; gap:8px; margin-top:8px }
  .tag { color:#8b949e; font-size:12px }
</style>
<header>
  <strong>群星参谋</strong>
  <span class="tag" id="conn">连接中…</span>
  <button class="ghost" onclick="load()">刷新</button>
</header>
<main>
  <section>
    <h3>战局</h3>
    <pre id="brief">…</pre>
  </section>
  <section>
    <h3>参谋</h3>
    <pre id="log" style="height:40vh;overflow:auto"></pre>
    <textarea id="ask" placeholder="问点什么，或让它做点什么（例如：合金太低了，想办法提上去）"></textarea>
    <div class="row">
      <button onclick="send()">发送</button>
      <button class="ghost" onclick="stream()">接事件流</button>
      <span class="tag" id="usage"></span>
    </div>
  </section>
</main>
<script>
const token = new URLSearchParams(location.search).get('token') || '';
const headers = { 'content-type': 'application/json' };
if (token) headers.authorization = 'Bearer ' + token;
const log = document.getElementById('log');
function add(t) { log.textContent += t + '\\n'; log.scrollTop = log.scrollHeight }
async function load() {
  const r = await fetch('/api/brief', { headers });
  const d = await r.json();
  document.getElementById('brief').textContent = d.brief || d.error || '';
  const s = await (await fetch('/api/status', { headers })).json();
  document.getElementById('conn').textContent = s.userDir ? ('已连接：' + (s.snapshot?.date || '无快照')) : '未连接';
}
async function send() {
  const text = document.getElementById('ask').value.trim();
  if (!text) return;
  document.getElementById('ask').value = '';
  add('你：' + text);
  const r = await fetch('/api/ask', { method:'POST', headers, body: JSON.stringify({ text }) });
  const d = await r.json();
  if (d.text) add('参谋：' + d.text);
  if (d.summary) add('摘要：' + d.summary);
  if (d.usage) document.getElementById('usage').textContent = 'tokens ' + d.usage.totalTokens;
}
function stream() {
  const es = new EventSource('/api/events' + (token ? ('?token=' + encodeURIComponent(token)) : ''));
  es.onmessage = (e) => add('· ' + e.data);
  es.onerror = () => add('（事件流断开）');
}
load(); stream();
</script>`

/**
 * @param {object} deps {config, orchestrator, engine, bus, log}
 */
export function startServer({ config, orchestrator, engine, bus, scheduler = null, log = () => {} }) {
  const port = Number(config.liveChat?.port ?? 8787)
  const token = String(config.liveChat?.token || '')
  const clients = new Set()
  const broadcast = (text) => {
    for (const res of clients) {
      try {
        res.write(`data: ${text}\n\n`)
      } catch {
        clients.delete(res)
      }
    }
  }
  const authorized = (req, url) => {
    if (!token) return true
    const header = String(req.headers.authorization || '')
    return header === `Bearer ${token}` || url.searchParams.get('token') === token
  }

  let busy = false

  let swarm = null
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!authorized(req, url)) return json(res, 401, { error: 'unauthorized' })

    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      return res.end(PAGE)
    }
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true, name: 'stellaris-agent' })
    if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, engine.status())
    if (req.method === 'GET' && url.pathname === '/api/brief') {
      return json(res, 200, { brief: engine.brief(6000) })
    }
    if (req.method === 'GET' && url.pathname === '/api/timeline') {
      return json(res, 200, { entries: engine.timeline.list({ limit: 30 }), status: engine.timeline.status() })
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      })
      res.write('data: 事件流已连接\n\n')
      clients.add(res)
      const ping = setInterval(() => res.write(': ping\n\n'), 15000)
      ping.unref?.()
      req.on('close', () => {
        clearInterval(ping)
        clients.delete(res)
      })
      return undefined
    }
    if (req.method === 'GET' && url.pathname === '/api/diagnostics') {
      const status = engine.status()
      let tail = ''
      try { tail = readFileSync(logFile(), 'utf8').split(/\r?\n/).slice(-200).join('\n') } catch {}
      const dshUrl = String(config.swarm?.dshUrl || '').replace(/\/+$/, '')
      let dsh = { url: dshUrl, reachable: false, service: null, error: null }
      if (dshUrl) {
        try {
          const response = await fetch(dshUrl + '/api/stellaris-orchestrator/health', { signal: AbortSignal.timeout(2500) })
          const body = await response.json().catch(() => ({}))
          dsh.reachable = Boolean(response.ok && body.ok !== false)
          dsh.service = body.service || null
          if (!dsh.reachable) dsh.error = body.error || ('HTTP ' + response.status)
        } catch (error) {
          dsh.error = String(error?.message || error)
        }
      }
      const game = await findGameProcess().catch(() => null)
      if (game) {
        const pipe = new NativePipe({ timeoutMs: 1500 })
        try {
          const status = await pipe.request('get_status')
          game.bridge = true
          game.inGame = Boolean(status.in_game)
          game.date = status.date?.formatted || null
        } catch (error) {
          game.bridge = false
          game.inGame = false
          game.error = String(error?.message || error)
        } finally { pipe.close() }
      }
      return json(res, 200, {
        time: new Date().toISOString(),
        game,
        dsh,
        node: process.version,
        platform: process.platform,
        config: {
          backend: config.swarm?.backend || 'local',
          dshUrl: config.swarm?.dshUrl || null,
          apiKeyConfigured: Boolean(String(config.deepseek?.apiKey || '').trim()),
          installDir: status.installDir,
          userDir: status.userDir,
        },
        status,
        readiness: null,
        logTail: tail,
        logFile: logFile(),
      })
    }
    if (req.method === 'POST' && url.pathname === '/api/swarm/start') {
      log('swarm.start.request', { backend: config.swarm?.backend || 'local', dshUrl: config.swarm?.dshUrl || null })
      const body = await readBody(req)
      if (!orchestrator && (config.swarm?.backend || 'local') !== 'dsh') { log('swarm.start.no-key'); return json(res, 503, { error: '未配置 DeepSeek API Key；请先在「设置」页保存 Key' }) }
      if (swarm) return json(res, 200, { ok: true, already: true, status: swarm.status() })
      try {
        const config = { ...config, swarm: { ...(config.swarm || {}), ...(body?.objective ? { objective: String(body.objective) } : {}) } }
        swarm = new Swarm({ engine, orchestrator, config, log })
        const started = await swarm.start({ once: Boolean(body?.once) })
        if (!started.ok) { log('swarm.start.failed', started); swarm = null; return json(res, 500, started) }
        return json(res, 200, { ok: true, started, status: swarm.status() })
      } catch (error) {
        log('swarm.start.error', { error: String(error?.message || error) })
        swarm = null
        return json(res, 500, { ok: false, error: String(error?.message || error) })
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/swarm/stop') {
      try { swarm?.stop() } catch {}
      swarm = null
      return json(res, 200, { ok: true })
    }
    if (req.method === 'GET' && url.pathname === '/api/swarm/status') {
      return json(res, 200, swarm ? swarm.status() : { running: false })
    }
    if (req.method === 'GET' && url.pathname === '/api/dsh/discover') {
      return json(res, 200, await discoverDshUrl())
    }
    if (req.method === 'POST' && url.pathname === '/api/native/connect') {
      const bridge = await ensureNativeBridge({ log })
      if (!bridge.ok) return json(res, 503, bridge)
      try {
        return json(res, 200, {
          ok: true,
          inGame: Boolean(bridge.status?.in_game),
          date: bridge.status?.date?.formatted || null,
          injected: Boolean(bridge.injected),
        })
      } finally {
        bridge.pipe.close()
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/readiness') {
      const dshUrl = String(config.swarm?.dshUrl || 'http://127.0.0.1:49939').replace(/\/+$/, '')
      const result = {
        backend: config.swarm?.backend || 'local',
        ai: { configured: Boolean(String(config.deepseek?.apiKey || '').trim()) },
        dsh: { url: dshUrl, reachable: false, error: null },
        game: { running: false, bridge: false, inGame: false, date: null, error: null },
      }
      try {
        const response = await fetch(dshUrl + '/api/stellaris-orchestrator/health', { signal: AbortSignal.timeout(2500) })
        const body = await response.json().catch(() => ({}))
        result.dsh.reachable = Boolean(response.ok && body.ok !== false)
        if (!result.dsh.reachable) result.dsh.error = body.error || ('HTTP ' + response.status)
      } catch (error) {
        result.dsh.error = String(error?.message || error)
      }
      if (!result.dsh.reachable) {
        try {
          const detected = await discoverDshUrl({ timeoutMs: 800 })
          if (detected.ok) {
            result.dsh.detectedUrl = detected.url
            result.dsh.reachable = true
            result.dsh.error = null
          }
        } catch {}
      }
      try {
        const game = await findGameProcess()
        result.game.running = Boolean(game)
        if (game) {
          const pipe = new NativePipe({ timeoutMs: 2500 })
          try {
            const status = await pipe.request('get_status')
            result.game.bridge = true
            result.game.inGame = Boolean(status.in_game)
            result.game.date = status.date?.formatted || null
          } catch (error) {
            result.game.error = String(error?.message || error)
          } finally {
            pipe.close()
          }
        }
      } catch (error) {
        result.game.error = String(error?.message || error)
      }
      return json(res, 200, result)
    }
    if (req.method === 'GET' && url.pathname === '/api/native/status') {
      const bridge = await ensureNativeBridge({ log })
      if (!bridge.ok) return json(res, 503, bridge)
      try { return json(res, 200, bridge.status) } finally { bridge.pipe.close() }
    }
    if (req.method === 'GET' && url.pathname === '/api/native/read') {
      const bridge = await ensureNativeBridge({ log })
      if (!bridge.ok) return json(res, 503, bridge)
      try {
        const data = await readAll(bridge.pipe, { log })
        return json(res, 200, { summary: summarize(data), data })
      } finally { bridge.pipe.close() }
    }
    if (req.method === 'POST' && url.pathname === '/api/native/run') {
      const body = await readBody(req)
      if (!body || !Array.isArray(body.steps)) return json(res, 400, { error: 'expected { steps }' })
      const bridge = await ensureNativeBridge({ log })
      if (!bridge.ok) return json(res, 503, bridge)
      try {
        return json(res, 200, await runSteps(bridge.pipe, body.steps, { attempts: body.attempts ?? 5, log }))
      } finally { bridge.pipe.close() }
    }
    if (req.method === 'GET' && url.pathname === '/api/events/search') {
      const data = loadChains(join(agentHome(), 'event-chains.json'))
      if (!data) return json(res, 404, { error: '先跑 events-index' })
      const q = String(url.searchParams.get('q') || '').toLowerCase()
      const hits = data.events.filter((e) => String(e.id).toLowerCase().includes(q) || String(e.titleKey || '').toLowerCase().includes(q)).slice(0, 30)
      return json(res, 200, { hits })
    }
    if (req.method === 'GET' && url.pathname === '/api/events/chain') {
      const data = loadChains(join(agentHome(), 'event-chains.json'))
      if (!data) return json(res, 404, { error: '先跑 events-index' })
      return json(res, 200, chainOf(data, String(url.searchParams.get('id') || ''), Number(url.searchParams.get('depth') || 4)))
    }
    if (req.method === 'GET' && url.pathname === '/api/queue') {
      return json(res, 200, scheduler ? scheduler.status() : { running: false, current: null, queued: [], history: [] })
    }
    if (req.method === 'POST' && url.pathname === '/api/dispatch') {
      const body = await readBody(req)
      if (!body || typeof body.goal !== 'string') return json(res, 400, { error: 'expected { goal }' })
      if (!scheduler) return json(res, 503, { error: 'scheduler 未启动（需要 API key）' })
      return json(res, 200, scheduler.dispatch(body.goal, { priority: body.priority }))
    }
    if (req.method === 'POST' && url.pathname === '/api/apply-auto') {
      const body = await readBody(req)
      if (!body || !Array.isArray(body.actions)) return json(res, 400, { error: 'expected { actions: [...] }' })
      try {
        return json(res, 200, engine.applyAuto(body.actions))
      } catch (error) {
        return json(res, 500, { error: String(error?.message || error) })
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      if (!orchestrator) return json(res, 503, { error: '未配置 DeepSeek API Key；请先在「设置」页保存 Key' })
      const body = await readBody(req)
      if (!body || typeof body.text !== 'string') return json(res, 400, { error: 'expected { text }' })
      if (busy) return json(res, 409, { error: '上一轮还没跑完' })
      busy = true
      try {
        const result = await orchestrator.run({
          goal: body.text,
          allowWrite: body.readOnly !== true,
          onEvent: (event) => {
            if (event.type === 'text') broadcast(String(event.text).slice(0, 400))
            else if (event.type === 'tool') broadcast(`调用工具 ${event.name}`)
          },
        })
        return json(res, 200, result)
      } catch (error) {
        return json(res, 500, { error: String(error?.message || error) })
      } finally {
        busy = false
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/livechat/ingest') {
      const body = await readBody(req)
      if (!body?.text) return json(res, 400, { error: 'expected { text }' })
      return json(res, 200, bus.ingest(body))
    }
    if (req.method === 'GET' && url.pathname === '/api/livechat/poll') {
      return json(res, 200, bus.poll(Number(url.searchParams.get('since') || 0)))
    }
    if (req.method === 'POST' && url.pathname === '/api/livechat/reply') {
      const body = await readBody(req)
      if (!body?.text) return json(res, 400, { error: 'expected { text }' })
      return json(res, 200, bus.say(body.text))
    }
    if (req.method === 'GET' && url.pathname === '/api/livechat/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' })
      res.write('event: hello\ndata: {}\n\n')
      const unsubscribe = bus.subscribe((event) => {
        const name = event.type === 'danmaku' ? 'danmaku' : 'reply'
        res.write(`event: ${name}\ndata: ${JSON.stringify(event.message || event.reply)}\n\n`)
      })
      req.on('close', unsubscribe)
      return undefined
    }
    return json(res, 404, { error: 'not found' })
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const actual = server.address()?.port ?? port
      const address = `http://127.0.0.1:${actual}`
      log(`面板：${address}`)
      resolve({ server, url: address, close: () => server.close() })
    })
  })
}
