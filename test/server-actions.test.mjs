import test from 'node:test'
import assert from 'node:assert/strict'

import { startServer } from '../agent/lib/server.mjs'

test('HTTP：/api/actions/history 列出已执行动作与尝试', async () => {
  const job = {
    jobId: 'job-1',
    unit: 'fleet:1',
    source: 'unit',
    ok: false,
    summary: '0/1 成功',
    durationMs: 12,
    createdAt: 1000,
    completedAt: 1012,
    actions: [
      {
        index: 0,
        method: 'move_fleet',
        params: { fleet_id: 1, system_id: 561 },
        status: 'failed',
        ok: false,
        error: 'boom',
        attempts: [{ attempt: 1, ok: false, error: 'boom' }],
      },
    ],
  }
  const app = {
    config: { chat: { port: 0, token: '' }, dshPlugin: { autoInstall: false } },
    startWatcher() {},
    orchestrator: { executor: { history: [job], actionLog: { tail: () => [] } } },
  }
  const server = await startServer({ app, log: () => {} })
  try {
    const response = await fetch(`${server.url}/api/actions/history?limit=10`)
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.ok, true)
    assert.equal(body.total, 1)
    assert.equal(body.actions[0].jobId, 'job-1')
    assert.equal(body.actions[0].method, 'move_fleet')
    assert.equal(body.actions[0].status, 'failed')
    assert.equal(body.actions[0].attempts[0].error, 'boom')
  } finally {
    server.close()
  }
})
