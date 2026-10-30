import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'

// 先占一个空闲端口再释放，避免和别的服务/并发测试撞端口
const PORT = await new Promise((resolve, reject) => {
  const probe = net.createServer()
  probe.once('error', reject)
  probe.listen(0, '127.0.0.1', () => {
    const assigned = probe.address().port
    probe.close(() => resolve(assigned))
  })
})
process.env.STELLARIS_BRIDGE_PORT = String(PORT)
const { apply, name, version, status, shutdown } = await import('../dsh-stellaris-bridge/index.js')

const BASE = `http://127.0.0.1:${PORT}/api/stellaris-orchestrator`

function fakeRes() {
  return {
    statusCode: 0,
    headers: null,
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(text) {
      this.body = text || ''
    },
  }
}

function fakeReq({ method = 'GET', url = '/', body = null } = {}) {
  const chunks = body ? [Buffer.from(JSON.stringify(body), 'utf8')] : []
  return {
    method,
    url,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

async function call(handler, options) {
  const res = fakeRes()
  await handler(fakeReq(options), res)
  return { status: res.statusCode, body: res.body ? JSON.parse(res.body) : null }
}

function fakeCtx() {
  const ctx = {
    routes: null,
    effects: [],
    logger: { info: () => {} },
    webServer: {
      register(spec) {
        ctx.routes = spec
      },
    },
    subagents: {
      async startActivation({ request } = {}) {
        const prompt = String(request?.prompt?.[0]?.text || '')
        const text = request?.parent && request.parent === ctx.agent ? `主会话说：${prompt}` : '```json\n{"ok":true}\n```'
        return {
          result: Promise.resolve({ output: [{ type: 'text', text }], usage: { total_tokens: 3 } }),
          async dispose() {},
        }
      },
    },
    agents: {
      currentInitiator: () => ({ id: 'owner' }),
      async create({ sessionId }) {
        ctx.createdSessionId = sessionId
        ctx.createCount = (ctx.createCount || 0) + 1
        const messages = []
        const agent = {
          session: { deriveMessages: () => messages.slice() },
          followup({ content }) {
            messages.push({ role: 'user', content })
            messages.push({ role: 'assistant', content: [{ type: 'text', text: `主会话说：${content?.[0]?.text || ''}` }] })
          },
          async whenIdle() {},
          cancel() {},
        }
        ctx.agent = agent
        return { agent, async dispose() {} }
      },
    },
    effect(fn) {
      const disposer = fn()
      ctx.effects.push(disposer)
    },
  }
  return ctx
}

async function waitHealth(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(1000) })
      if (response.ok) return response.json()
    } catch {
      /* 还没起来 */
    }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('固定端口服务未在预期时间内启动')
}

test('插件 shim：注册前缀路由，名字与版本正确', () => {
  const ctx = fakeCtx()
  apply(ctx)
  assert.equal(name, 'dsh-stellaris-bridge')
  assert.equal(version, '2.1.0')
  assert.ok(ctx.routes)
  assert.equal(ctx.routes.kind, 'prefix')
  assert.equal(ctx.routes.path, '/api/stellaris-orchestrator')
})

test('固定端口：health / version / run 全链路（不依赖 DSH Web 端口）', async () => {
  apply(fakeCtx())
  const health = await waitHealth()
  assert.equal(health.ok, true)
  assert.equal(health.service, 'dsh-stellaris-bridge')
  assert.equal(health.version, '2.1.0')
  assert.equal(health.handlerVersion, '2.0.0')
  assert.equal(health.port, PORT)
  assert.equal(health.portFixed, true)
  assert.equal(health.hasSubagents, true)

  const versionInfo = await fetch(`${BASE}/version`).then((response) => response.json())
  assert.equal(versionInfo.ok, true)
  assert.equal(versionInfo.port, PORT)
  assert.equal(versionInfo.portFixed, true)

  const run = await fetch(`${BASE}/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: '你好', label: 'test' }),
  }).then((response) => response.json())
  assert.equal(run.ok, true)
  assert.match(run.text, /"ok":true/)
  assert.equal(run.port, PORT)

  const reload = await fetch(`${BASE}/reload`, { method: 'POST' }).then((response) => response.json())
  assert.equal(reload.ok, true)
  assert.equal(reload.port, PORT)
})

test('主会话：label=main 新建一个 DSH session 并复用', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const first = await call(ctx.routes.handler, {
    method: 'POST',
    url: '/api/stellaris-orchestrator/run',
    body: { prompt: '第一轮', label: 'main' },
  })
  assert.equal(first.status, 200)
  assert.equal(first.body.ok, true)
  assert.equal(first.body.session, true)
  assert.match(first.body.text, /主会话说：第一轮/)
  assert.ok(first.body.sessionId)
  assert.equal(ctx.createCount, 1)

  const second = await call(ctx.routes.handler, {
    method: 'POST',
    url: '/api/stellaris-orchestrator/run',
    body: { prompt: '第二轮', label: 'main' },
  })
  assert.equal(second.body.sessionId, first.body.sessionId, '同一个主会话应复用 DSH session')
  assert.equal(ctx.createCount, 1, '不应重复创建 session')

  const health = await call(ctx.routes.handler, { method: 'GET', url: '/api/stellaris-orchestrator/health' })
  assert.equal(health.body.mainSessionReady, true)
  assert.equal(health.body.mainSessionId, first.body.sessionId)
})

test('DSH 路由兼容：health / run / reload 仍然可用', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const handler = ctx.routes.handler

  const health = await call(handler, { method: 'GET', url: '/api/stellaris-orchestrator/health' })
  assert.equal(health.status, 200)
  assert.equal(health.body.ok, true)
  assert.equal(health.body.handlerVersion, '2.0.0')

  const run = await call(handler, {
    method: 'POST',
    url: '/api/stellaris-orchestrator/run',
    body: { prompt: '你好', label: 'test' },
  })
  assert.equal(run.status, 200)
  assert.equal(run.body.ok, true)
  assert.match(run.body.text, /"ok":true/)

  const missing = await call(handler, {
    method: 'POST',
    url: '/api/stellaris-orchestrator/run',
    body: { prompt: '   ' },
  })
  assert.equal(missing.status, 400)

  const reload = await call(handler, { method: 'POST', url: '/api/stellaris-orchestrator/reload' })
  assert.equal(reload.status, 200)
  assert.equal(reload.body.ok, true)
  assert.equal(reload.body.version, '2.0.0')

  const notFound = await call(handler, { method: 'GET', url: '/api/stellaris-orchestrator/nope' })
  assert.equal(notFound.status, 404)
})

test('非本机请求被拒', async () => {
  const ctx = fakeCtx()
  apply(ctx)
  const res = fakeRes()
  const req = { ...fakeReq(), socket: { remoteAddress: '10.0.0.7' } }
  await ctx.routes.handler(req, res)
  assert.equal(res.statusCode, 403)
  assert.equal(JSON.parse(res.body).ok, false)
})

test('/team 会在 prompt 前加"用 DSH 子代理"指令', async () => {
  const ctx = fakeCtx()
  let captured = ''
  ctx.subagents.startActivation = async ({ request }) => {
    captured = request.prompt[0].text
    return { result: Promise.resolve({ output: [{ type: 'text', text: 'ok' }] }), async dispose() {} }
  }
  apply(ctx)
  const result = await call(ctx.routes.handler, {
    method: 'POST',
    url: '/api/stellaris-orchestrator/team',
    body: { prompt: '原始任务' },
  })
  assert.equal(result.status, 200)
  assert.match(captured, /DSH 主会话/)
  assert.match(captured, /原始任务/)
})

test('status 报告固定端口', () => {
  const info = status()
  assert.equal(info.portFixed, true)
  assert.equal(info.port, PORT)
})

after(async () => {
  await shutdown()
})
