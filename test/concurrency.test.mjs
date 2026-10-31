import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Orchestrator } from '../agent/lib/orchestrator.mjs'

test('并发槽位：默认最多 5 个单位/事件子会话同时跑', async () => {
  const home = mkdtempSync(join(tmpdir(), 'stellaris-concurrency-'))
  try {
    const orch = new Orchestrator({ config: { ai: { unit: { maxConcurrent: 5 } } }, home, log: () => {} })
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 12 }, async () => {
      const release = await orch.acquireUnitSlot()
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 15))
      active -= 1
      release()
    })
    await Promise.all(tasks)
    assert.equal(peak, 5)
    assert.equal(orch.unitActive, 0)
    assert.equal(orch.unitWaiters.length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
