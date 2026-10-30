/**
 * DSH 插件固定端口自测桩（**不启动 DSH**）。
 *
 *   node tools/dsh-plugin-harness.mjs [port]
 *
 * 用假 ctx 调 `dsh-stellaris-bridge` 的 apply()，让它按真实逻辑在固定端口上监听；
 * /run、/team 返回固定文本。用来验证程序是否真的连到固定端口，
 * 而不用重启 DSH。测完记得 Ctrl+C。
 */
import { apply, shutdown, status, version } from '../dsh-stellaris-bridge/index.js'

const port = Number(process.argv[2] || 49939)
process.env.STELLARIS_BRIDGE_PORT = String(port)

const ctx = {
  logger: { info: (line) => console.log(line) },
  webServer: { register: () => () => {} },
  effect: (fn) => {
    fn()
  },
  agents: { currentInitiator: () => ({ id: 'harness-owner' }) },
  subagents: {
    async startActivation({ request } = {}) {
      const text = String(request?.prompt?.[0]?.text || '')
      let reply
      if (/特殊事件处理会话/.test(text)) {
        reply = { say: 'harness：处理事件', actions: [{ method: 'resolve_event', params: { window_id: 5, option_index: 0 } }], status: 'continue' }
      } else if (/1:1 操作员子会话/.test(text)) {
        reply = /执行器结果：成功/.test(text)
          ? { say: 'harness：完成', actions: [], status: 'ok' }
          : { say: 'harness：切科研', actions: [{ method: 'select_research', params: { slot: 'physics', tech_key: 'tech_lasers_1' } }], status: 'continue' }
      } else if (/总指挥/.test(text)) {
        reply = /"status"\s*:\s*"ok"/.test(text)
          ? { say: 'harness：收到', spawn: [] }
          : { say: 'harness：主会话', spawn: [{ unit: 'research', goal: 'harness 目标' }] }
      } else {
        reply = { say: 'harness ok', actions: [], status: 'ok' }
      }
      return {
        result: Promise.resolve({
          output: [{ type: 'text', text: '```json\n' + JSON.stringify(reply) + '\n```' }],
          usage: { total_tokens: 10 },
        }),
        async dispose() {},
      }
    },
  },
}

apply(ctx)
console.log(`[harness] plugin ${version} expected on 127.0.0.1:${port}`)
console.log(`[harness] status: ${JSON.stringify(status())}`)

const stop = async () => {
  await shutdown()
  process.exit(0)
}
process.once('SIGINT', stop)
process.once('SIGTERM', stop)
setInterval(() => {}, 1 << 30)
