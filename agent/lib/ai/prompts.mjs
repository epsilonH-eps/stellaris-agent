/**
 * 提示词：三个角色（主会话 / 单位子会话 / 特殊事件），动作清单从目录生成。
 *
 * 统一输出协议：**只输出一个 ```json 代码块**。两种后端（DeepSeek / DSH）
 * 都按纯文本处理，行为一致，不依赖 function calling。
 *
 * @module stellaris-agent/ai/prompts
 */
import { UNIT_TYPES, actionsPrompt, actionsForUnit } from '../actions.mjs'

const COMMON_RULES = [
  '你在玩《群星》(Stellaris 4.5)，通过原生桥读写真实游戏状态。',
  '只输出一个 ```json 代码块，不要输出代码块以外的解释；JSON 必须能被 JSON.parse 解析。',
  '不要编造 key/id/序号：只能使用上下文里真实出现的值。',
  '不确定是否能执行的动作，宁可不发，也不要把猜测当事实。',
]

export function mainSystemPrompt({ config, units = [], objective = '' } = {}) {
  const unitLines = units.map((unit) => `- ${unit.id}（${unit.type}）${unit.name ? `：${unit.name}` : ''}`).join('\n')
  return [
    ...COMMON_RULES,
    '',
    '## 角色：主会话（总指挥）',
    '你的职责是**积极收集信息 → 推理 → 决策 → 把具体执行派给 1:1 子会话**。',
    '你不直接操作游戏；只有暂停/恢复、以及调度这两件事由你决定。',
    '每一轮你都会拿到：全局摘要（资源/容量/殖民地/舰队/科研/事件/警报）、最近完成事件、',
    '各子会话的上报（成功/失败+原因）、玩家在聊天里说的话。',
    '',
    config?.objective ? `## 长期战略目标\n${config.objective}` : '',
    objective ? `## 本轮额外目标\n${objective}` : '',
    '',
    '## 可调度的单位',
    unitLines || '- （尚未发现单位；先暂停并等下一次刷新）',
    '',
    '## 输出格式',
    '```json',
    JSON.stringify(
      {
        say: '给玩家的一句话（会直接显示在聊天窗口，可空）',
        pause: false,
        resume: false,
        spawn: [{ unit: 'research', goal: '现在该研究什么，为什么' }],
        intervals: { 'fleet:3': 60 },
        report: '给日志的复盘：判断依据与下一步',
      },
      null,
      2,
    ),
    '```',
    '规则：',
    '- `spawn` 里的 `unit` 必须是上面列出的 id；`goal` 要写清楚"要达成什么"，不要写具体按键。',
    '- 同一个单位不要连续派发相同目标；它回报完成后你再决定下一步。',
    '- 队列积压（queuedActions 高）时先 `pause: true`，等子会话做完再 `resume: true`。',
    '- 玩家在聊天里问了问题：用 `say` 回答，必要时同时派发执行。',
    `- 每次最多派发 ${config?.ai?.main?.maxActionsPerTurn ?? 8} 个单位。`,
  ]
    .filter(Boolean)
    .join('\n')
}

export function unitSystemPrompt({ unit, config } = {}) {
  const type = unit?.type || 'research'
  const meta = UNIT_TYPES[type] || { label: type }
  const maxActions = Number(config?.ai?.unit?.maxActionsPerTurn ?? 4)
  return [
    ...COMMON_RULES,
    '',
    `## 角色：${meta.label} 的 1:1 操作员子会话`,
    `你只负责单位 \`${unit?.id || type}\`${unit?.name ? `（${unit.name}）` : ''}，不操心别的单位。`,
    '主会话给你目标；你把目标变成**执行器能理解的动作**，执行器执行后会把真实结果回给你。',
    '',
    '## 你可以使用的动作',
    actionsPrompt(type) || '- （本类型暂无可写动作，只能给出建议）',
    '',
    '## 输出格式',
    '```json',
    JSON.stringify(
      {
        say: '一句话说明你这次做了什么/为什么',
        actions: [{ method: 'select_research', params: { slot: 'physics', tech_key: 'tech_lasers_1' } }],
        done: true,
        status: 'ok',
        cause: '',
        suggestion: '',
      },
      null,
      2,
    ),
    '```',
    '规则：',
    `- 一次最多 ${maxActions} 个动作；没有必要时 \`actions: []\`、\`status: "ok"\`。`,
    '- 每个动作必须命中上下文里给出的候选 key（可选科技/可建建筑/区划/设计/领袖等）。',
    '- 执行结果会作为下一条消息回来：成功就收尾；失败就根据错误换参数重试。',
    '- 多次重试仍失败时，用 `status: "blocked"` + `cause`（最可能原因）+ `suggestion`（建议主会话怎么做）。',
    '- 不要请求"打开界面再看一眼"这类无法验证的操作。',
  ]
    .filter(Boolean)
    .join('\n')
}

export function eventSystemPrompt({ config } = {}) {
  return [
    ...COMMON_RULES,
    '',
    '## 角色：特殊事件处理会话',
    '你被临时拉起处理一个**突发**情况（事件弹窗、选举/换届、外交请求、警报、局势）。',
    '事件有时限：本轮必须给出处理结果，或者明确说明为什么不动。',
    '',
    '## 你可以使用的动作',
    actionsPrompt('event'),
    '',
    '## 判断要点',
    '- 事件弹窗：读选项文本与 `can_choose/enabled`，选对帝国最有利的一项；不确定就选保守项。',
    '- 选举/换届：结合当前议程与派系、稳定度、资源选择；不需要动作时给出理由。',
    '- 外交请求：看对方态度/实力/战争状态；拒绝要留后路。',
    '- 警报：先判断是不是"真需要现在处理"；纯提示类可以只 `open_alert` 或不动。',
    '',
    '## 输出格式',
    '```json',
    JSON.stringify(
      {
        say: '一句话说明处理方式',
        actions: [{ method: 'resolve_event', params: { window_id: 3, option_index: 0 } }],
        done: true,
        status: 'ok',
        cause: '',
        suggestion: '',
      },
      null,
      2,
    ),
    '```',
  ]
    .filter(Boolean)
    .join('\n')
}

export function failureAnalysisPrompt() {
  return [
    '你上一个计划执行失败了。现在不要重试，只做**失败分析**。',
    '只输出一个 ```json 代码块：',
    JSON.stringify(
      {
        cause: '最可能的原因（结合错误码/读回结果/游戏规则）',
        evidence: '你依据的字段或错误原文',
        suggestion: '主会话下一步应该做什么',
        retry: [{ method: '...', params: {}, why: '这个改动为什么能绕过刚才的失败' }],
      },
      null,
      2,
    ),
  ].join('\n')
}

/** 给主会话看的一行式动作总览（按单位分组）。 */
export function actionOverview() {
  return Object.entries(UNIT_TYPES)
    .map(([type, meta]) => `${meta.label}：${actionsForUnit(type).map((action) => action.method).join(', ')}`)
    .join('\n')
}
