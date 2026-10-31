import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ActionLog } from '../agent/lib/action-log.mjs'

test('动作日志：job 落盘后可按时间顺序读回', () => {
  const home = mkdtempSync(join(tmpdir(), 'stellaris-action-log-'))
  try {
    const log = new ActionLog({ home, maxLines: 100 })
    log.append({ jobId: 'job-1', unit: 'fleet:1', actions: [{ method: 'move_fleet', status: 'ok' }] })
    log.append({ jobId: 'job-2', unit: 'economy', actions: [{ method: 'market_trade', status: 'failed' }] })
    const rows = log.tail(10)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].jobId, 'job-1')
    assert.equal(rows[1].jobId, 'job-2')
    assert.equal(rows[1].actions[0].status, 'failed')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
