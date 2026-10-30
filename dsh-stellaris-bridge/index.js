/**
 * dsh-stellaris-bridge —— 固定端口版（v2.1）。
 *
 * 为什么要自己的端口：DSH 的 Web 端口每次启动都可能变（52639 → 52554 → …），
 * 程序这边就得一直"猜端口"。插件现在在 **127.0.0.1:49939** 上自建一个 HTTP 服务，
 * 端口固定，程序只需要连这一个地址。
 *
 * 同时保留原来注册到 DSH webServer 的 `/api/stellaris-orchestrator/*` 路由：
 * 旧配置/旧客户端仍可用；固定端口是主入口，DSH 路由是兼容备用。
 *
 * 结构：
 *   index.js  稳定 shim（**改它需要重启一次 DSH**）
 *   lib/handler.mjs  真正的逻辑（POST /reload 热更新，不用重启 DSH）
 *
 * 端口：
 *   - 默认 49939；
 *   - 可用环境变量 STELLARIS_BRIDGE_PORT 覆盖；
 *   - 被别的程序占用时记录错误并保留 DSH 路由，不阻塞 DSH 启动。
 *
 * @module dsh-stellaris-bridge
 */
import { createServer } from 'node:http'

export const name = 'dsh-stellaris-bridge'
export const version = '2.1.0'

const DEFAULT_PORT = 49939
const ROUTE_PREFIX = '/api/stellaris-orchestrator'
const HANDLER_FILE = new URL('./lib/handler.mjs', import.meta.url)

export const inject = ['webServer', 'subagents', 'agents']

let ctxRef = null
let impl = null
let implVersion = null
let implLoadedAt = 0
let implError = null

let httpServer = null
let httpPort = null
let httpError = null
let httpExternal = false

function desiredPort() {
  const raw = Number(process.env.STELLARIS_BRIDGE_PORT)
  return Number.isInteger(raw) && raw > 0 && raw < 65536 ? raw : DEFAULT_PORT
}

function logLine(ctx, line) {
  try {
    if (ctx?.logger?.info) ctx.logger.info(line)
    else console.log(line)
  } catch {
    /* 日志失败不影响服务 */
  }
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  })
  res.end(text)
}

async function readBody(req, limit = 2 * 1024 * 1024) {
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

async function loadImpl(force = false) {
  if (impl && !force) return impl
  if (!ctxRef) throw new Error('插件尚未 apply')
  const target = new URL(HANDLER_FILE)
  target.searchParams.set('v', String(Date.now()))
  const mod = await import(target.href)
  if (typeof mod.createHandler !== 'function') throw new Error('handler.mjs 没有导出 createHandler')
  impl = await mod.createHandler(ctxRef)
  implVersion = mod.version || 'unknown'
  implLoadedAt = Date.now()
  implError = null
  return impl
}

function localOnly(req) {
  const remote = req.socket?.remoteAddress || ''
  if (!remote) return true
  return /^(127\.|::1|::ffff:127\.|::ffff:::1)/.test(remote)
}

/** 固定端口和 DSH 路由共用同一个处理器。 */
async function handle(req, res) {
  try {
    if (!localOnly(req)) return sendJson(res, 403, { ok: false, error: 'localhost only' })
    const url = new URL(req.url, 'http://127.0.0.1')
    const path = url.pathname.replace(ROUTE_PREFIX, '') || '/'

    if (req.method === 'GET' && /^\/health\/?$/.test(path)) {
      let current = null
      try {
        current = await loadImpl()
      } catch (error) {
        implError = String(error?.message || error)
      }
      const detail = {
        ok: Boolean(current),
        service: name,
        version,
        handlerVersion: implVersion,
        loadedAt: implLoadedAt || null,
        port: httpPort || desiredPort(),
        portFixed: true,
        portExternal: httpExternal,
        portError: httpError,
        hasSubagents: typeof ctxRef?.subagents?.startActivation === 'function',
        ...(current ? await current.health() : { error: implError }),
      }
      return sendJson(res, 200, detail)
    }

    if (req.method === 'GET' && /^\/version\/?$/.test(path)) {
      return sendJson(res, 200, {
        ok: true,
        service: name,
        version,
        handlerVersion: implVersion,
        port: httpPort || desiredPort(),
        portFixed: true,
        loadedAt: implLoadedAt || null,
      })
    }

    if (req.method === 'POST' && /^\/reload\/?$/.test(path)) {
      try {
        impl = null
        const current = await loadImpl(true)
        return sendJson(res, 200, { ok: true, service: name, version: implVersion, port: httpPort || desiredPort(), health: await current.health() })
      } catch (error) {
        implError = String(error?.message || error)
        return sendJson(res, 500, { ok: false, service: name, error: implError })
      }
    }

    if (req.method === 'POST' && /^\/(run|team)\/?$/.test(path)) {
      const body = await readBody(req)
      if (!body || typeof body.prompt !== 'string' || !body.prompt.trim()) {
        return sendJson(res, 400, { ok: false, error: 'expected { prompt }' })
      }
      const team = /^\/team/.test(path)
      const current = await loadImpl()
      const result = await current.run(body.prompt, {
        label: body.label || (team ? '群星-DSH团队' : '群星参谋'),
        timeoutMs: body.timeoutMs,
        team,
      })
      return sendJson(res, 200, { ok: true, service: name, port: httpPort || desiredPort(), ...result })
    }

    return sendJson(res, 404, { ok: false, error: 'not found', path })
  } catch (error) {
    implError = String(error?.message || error)
    return sendJson(res, 500, { ok: false, error: implError })
  }
}

/** 固定端口服务：只起一次；端口被占时探测是不是已经在跑的桥。 */
function startFixedServer(ctx) {
  if (httpServer) return
  const port = desiredPort()
  const server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      try {
        sendJson(res, 500, { ok: false, error: String(error?.message || error) })
      } catch {
        /* 响应已结束 */
      }
    })
  })
  server.unref?.()
  server.once('error', async (error) => {
    httpError = String(error?.message || error)
    httpServer = null
    if (error?.code === 'EADDRINUSE') {
      try {
        const response = await fetch(`http://127.0.0.1:${port}${ROUTE_PREFIX}/health`, { signal: AbortSignal.timeout(1500) })
        if (response.ok) {
          httpExternal = true
          httpPort = port
          logLine(ctx, `[stellaris-bridge] 端口 ${port} 已有桥实例在跑，复用该端口`)
          return
        }
      } catch {
        /* 不是我们的服务 */
      }
      logLine(ctx, `[stellaris-bridge] 端口 ${port} 被占用，固定端口不可用；DSH 路由仍可用`)
      return
    }
    logLine(ctx, `[stellaris-bridge] 固定端口启动失败：${httpError}`)
  })
  server.listen(port, '127.0.0.1', () => {
    httpPort = server.address()?.port || port
    httpError = null
    httpExternal = false
    logLine(ctx, `[stellaris-bridge] 固定端口：http://127.0.0.1:${httpPort}${ROUTE_PREFIX}`)
  })
  httpServer = server
}

export function apply(ctx) {
  ctxRef = ctx
  // 重新 apply（DSH 重载插件）时丢弃旧 handler，避免指向旧 ctx
  impl = null
  implVersion = null
  implLoadedAt = 0

  startFixedServer(ctx)

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        handler: handle,
      }),
    'stellaris-bridge: /api/stellaris-orchestrator（兼容 DSH 路由）',
  )

  ctx.effect(
    () => () => {
      try {
        impl?.dispose?.()
      } catch {
        /* 收摊 */
      }
    },
    'stellaris-bridge: dispose handler',
  )
}

export function status() {
  return {
    name,
    version,
    handlerVersion: implVersion,
    loadedAt: implLoadedAt || null,
    port: httpPort || desiredPort(),
    portFixed: true,
    portExternal: httpExternal,
    portError: httpError,
    error: implError,
  }
}

/** 测试/退出用：关掉固定端口服务。 */
export function shutdown() {
  return new Promise((resolve) => {
    if (!httpServer) return resolve()
    const server = httpServer
    httpServer = null
    httpPort = null
    server.close(() => resolve())
  })
}
