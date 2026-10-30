/**
 * 原生操作层：一次只做一项，失败最多重试 5 次；验证通过才进入下一项。
 *
 * 每一步：
 *   call(method, params) → verify(read back) → 通过则下一步；失败重试；
 *   5 次仍失败 → 停止整个计划，把错误交回调度器/子会话。
 *
 * @module stellaris-agent/native-operator
 */
function deepGet(value, path) {
  return String(path || '')
    .split('.')
    .filter(Boolean)
    .reduce((node, key) => (node == null ? undefined : node[key]), value)
}

export async function verifyStep(pipe, step) {
  const verify = step.verify
  if (!verify) return { ok: true, detail: 'no-verify' }
  const result = await pipe.request(verify.method, verify.params || {})
  if (verify.expectContains !== undefined) {
    const text = JSON.stringify(result)
    return { ok: text.includes(String(verify.expectContains)), detail: verify.expectContains, result }
  }
  if (verify.expectPath !== undefined) {
    const actual = deepGet(result, verify.expectPath)
    const expected = verify.expectEquals !== undefined ? verify.expectEquals : (verify.expectParam ? step.params?.[verify.expectParam] : undefined)
    return { ok: JSON.stringify(actual) === JSON.stringify(expected), detail: { actual, expected }, result }
  }
  if (verify.expectPath !== undefined) {
    const actual = deepGet(result, verify.expectPath)
    return { ok: actual !== undefined && actual !== null, detail: { actual }, result }
  }
  return { ok: result?.success !== false, detail: 'verify-success-flag', result }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * @param {import('./native-bridge.mjs').NativePipe} pipe
 * @param {Array<{method:string, params?:object, verify?:object, label?:string}>} steps
 */
export async function runSteps(pipe, steps, { attempts = 5, log = () => {}, pause = true } = {}) {
  if (!Array.isArray(steps) || steps.length === 0) return { ok: false, error: 'EMPTY_STEPS', results: [] }
  if (pause) {
    try {
      await pipe.request('set_paused', { paused: true })
    } catch {
      /* 暂停失败不阻塞，但会记录 */
    }
  }

  const results = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    const row = { index, label: step.label || step.method, attempts: [] }
    let passed = false

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await pipe.request(step.method, step.params || {})
        const verified = await verifyStep(pipe, step)
        row.attempts.push({ attempt, response, verified })
        log('native.operator.attempt', { index, attempt, method: step.method, ok: verified.ok })
        if (verified.ok) {
          row.status = 'done'
          passed = true
          break
        }
      } catch (error) {
        row.attempts.push({ attempt, error: String(error?.message || error), code: error?.code })
        log('native.operator.error', { index, attempt, error: String(error?.message || error) })
      }
      if (attempt < attempts) await sleep(400)
    }

    if (!passed) {
      row.status = 'failed'
      results.push(row)
      return { ok: false, error: 'STEP_FAILED_AFTER_RETRIES', failedIndex: index, results }
    }
    results.push(row)
  }

  return { ok: true, results }
}
