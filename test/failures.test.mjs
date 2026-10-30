import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { FailureStore } from '../agent/lib/failures.mjs'
import { Orchestrator } from '../agent/lib/orchestrator.mjs'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'stellaris-failures-'))
}

function report(overrides = {}) {
  return {
    unit: 'research',
    unitType: 'research',
    name: '科研',
    status: 'blocked',
    say: '切不了科研',
    cause: 'select_research 返回 UNKNOWN_TECH',
    suggestion: '先确认 tech key 是否存在',
    evidence: 'get_research_state.options 里没有 tech_lasers_9',
    attempts: 3,
    actions: ['select_research'],
    at: Date.now(),
    ms: 1200,
    goal: '研究激光',
    result: {
      ok: false,
      summary: '0/1 成功',
      error: 'select_research 失败',
      failedIndex: 0,
      actions: [
        {
          index: 0,
          method: 'select_research',
          status: 'failed',
          error: 'UNKNOWN_TECH',
          params: { slot: 'physics', tech_key: 'tech_lasers_9' },
          verify: { ok: false, soft: false, detail: '科研没有变化' },
          attempts: [
            { attempt: 1, error: 'UNKNOWN_TECH', code: 'UNKNOWN_TECH' },
            { attempt: 2, error: 'UNKNOWN_TECH', code: 'UNKNOWN_TECH' },
          ],
        },
      ],
    },
    ...overrides,
  }
}

function session(overrides = {}) {
  return {
    unit: { type: 'research', name: '科研' },
    goal: '研究激光',
    session: {
      label: 'unit:research',
      turns: 2,
      createdAt: Date.now(),
      messages: [
        { role: 'user', ts: Date.now(), content: '目标：研究激光' },
        { role: 'assistant', ts: Date.now(), content: '{"say":"切科研","actions":[]}' },
      ],
    },
    ...overrides,
  }
}

test('失败报告：导出 JSON + Markdown + latest', () => {
  const home = tempDir()
  try {
    const store = new FailureStore({ home })
    const exported = store.record(report(), { session: session(), world: { date: '2200.01.01', colonies: [], fleetsAll: [] } })
    assert.ok(exported)
    assert.ok(existsSync(exported.file))
    assert.ok(existsSync(exported.markdownFile))
    assert.ok(existsSync(join(home, 'failures', 'latest.json')))
    assert.ok(existsSync(join(home, 'failures', 'latest.md')))

    const data = JSON.parse(readFileSync(exported.file, 'utf8'))
    assert.equal(data.unit, 'research')
    assert.equal(data.status, 'blocked')
    assert.equal(data.cause, 'select_research 返回 UNKNOWN_TECH')
    assert.equal(data.executor.failedIndex, 0)
    assert.equal(data.executor.actions[0].method, 'select_research')
    assert.equal(data.executor.actions[0].attempts.length, 2)
    assert.equal(data.session.messages.length, 2)

    const markdown = readFileSync(exported.markdownFile, 'utf8')
    assert.match(markdown, /子会话失败报告/)
    assert.match(markdown, /select_research/)
    assert.match(markdown, /UNKNOWN_TECH/)
    assert.match(markdown, /研究激光/)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('失败报告：成功的报告不导出', () => {
  const home = tempDir()
  try {
    const store = new FailureStore({ home })
    assert.equal(store.record(report({ status: 'ok' })), null)
    assert.equal(store.list().length, 0)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('失败报告：列表 / 读取 / 目录穿越防护', () => {
  const home = tempDir()
  try {
    const store = new FailureStore({ home })
    const first = store.record(report({ at: Date.now() - 5000, unit: 'planet:3' }))
    const second = store.record(report({ at: Date.now(), unit: 'research' }))
    assert.ok(first && second)
    const rows = store.list()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].unit, 'research')
    assert.equal(store.read(second.id).unit, 'research')
    assert.match(store.readMarkdown(second.id), /科研/)
    assert.equal(store.read('../config'), null)
    assert.equal(store.read('..\\config'), null)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('失败报告：maxFiles 只保留最新 N 份', () => {
  const home = tempDir()
  try {
    const store = new FailureStore({ home, config: { failures: { maxFiles: 3 } } })
    const exported = []
    for (let index = 0; index < 6; index += 1) {
      exported.push(store.record(report({ at: Date.now() + index * 1000, unit: `unit-${index}` })))
    }
    assert.equal(store.list().length, 3)
    for (const row of exported.slice(0, 3)) assert.equal(existsSync(row.file), false)
    for (const row of exported.slice(3)) assert.equal(existsSync(row.file), true)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('失败报告：可关掉对话/世界，控制文件大小', () => {
  const home = tempDir()
  try {
    const store = new FailureStore({ home, config: { failures: { includeTranscript: false, includeWorld: true } } })
    const exported = store.record(report(), { session: session(), world: { date: '2200.01.02', colonies: [{ id: 1 }] } })
    const data = store.read(exported.id)
    assert.equal(data.session, null)
    assert.equal(data.world.date, '2200.01.02')
    assert.equal(data.world.colonies, 1)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('编排器：子会话失败时自动导出，并挂到 report.exported', () => {
  const home = tempDir()
  try {
    const orch = new Orchestrator({ config: { failures: { dir: join(home, 'failures') } }, home, log: () => {} })
    const failing = report({ unit: 'research', at: Date.now() })
    orch.onUnitReport(failing, session())
    assert.ok(failing.exported)
    assert.ok(existsSync(failing.exported.file))
    const data = JSON.parse(readFileSync(failing.exported.file, 'utf8'))
    assert.equal(data.unit, 'research')
    assert.equal(data.cause, 'select_research 返回 UNKNOWN_TECH')
    const status = orch.status()
    assert.equal(status.failures.dir, join(home, 'failures'))
    assert.equal(status.failures.last.unit, 'research')
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
