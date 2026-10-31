# 架构说明

> 目标读者：要改这个项目、或要把它接到别的编排器上的人。
> 代码即文档：每个模块头部注释都写了"为什么"，这里写"它们怎么拼起来"。

---

## 1. 分层

```
┌──────────────────────────────────────────────────────────────────┐
│ 入口：CLI (agent/lib/cli.mjs)  /  HTTP (agent/lib/server.mjs)      │
│       GUI (agent/gui/StellarisAgent.ps1) 只走 HTTP                 │
└───────────────────────────┬──────────────────────────────────────┘
                            │
                     ┌──────▼──────┐
                     │ App         │  app.mjs：配置 + 生命周期 + 插件
                     └──────┬──────┘
                            │
                     ┌──────▼────────┐
                     │ Orchestrator  │  orchestrator.mjs
                     └──┬───┬───┬────┘
        ┌───────────────┘   │   └────────────────┐
        ▼                   ▼                    ▼
  ┌───────────┐      ┌────────────┐      ┌─────────────┐
  │ World     │      │ MainSession│      │ Executor    │
  │ 轮询+差分  │      │ 决策+派发   │      │ 串行+读回    │
  └─────┬─────┘      └──────┬─────┘      └──────┬──────┘
        │                   │                    │
   ┌────▼────┐         ┌────▼─────────┐    ┌─────▼──────┐
   │ Reader  │         │ UnitSession  │    │ BridgeClient│
   │ 全量读取 │         │ EventSession │    │ 单连接 RPC  │
   └────┬────┘         └──────────────┘    └─────┬──────┘
        │                                        │
   ┌────▼──────────────┐                  ┌──────▼──────────┐
   │ Mods / Events /   │                  │ stellaris_bridge│
   │ Save（本地文件）   │                  │ .dll（游戏内）   │
   └───────────────────┘                  └─────────────────┘
```

**依赖方向单一**：CLI/HTTP → App → Orchestrator → (World/Executor/AI)，底层（bridge/reader/mods/events）不反向依赖上层。

---

## 2. 启动时序

```
App.start()
 ├─ ensureBridge()            连管道；连不上就找进程注入 DLL（一次性）
 ├─ resolvePaths()            安装目录/用户目录/存档目录
 ├─ listMods()                本地 + 工坊 + DLC，读 dlc_load.json
 ├─ EventGraph.build()        事件图（原版+DLC+已启用模组；带缓存）
 ├─ new Reader/World/Executor/ChatHub/Backend
 ├─ world.refresh({deep:true, includeSave:true})
 │    ├─ get_status …
 │    ├─ 每颗殖民地 9 个读取方法
 │    ├─ 每支舰队详情 / 外交选项 / 战争目标
 │    ├─ get_galaxy_map → 巨构扫描
 │    ├─ resolveActiveChains() 已激活事件 + 后续树
 │    └─ readSaveState()       最新 .sav 的 meta
 ├─ in_game? 否则 GAME_NOT_IN_SESSION
 ├─ rebuildUnits()            发现 research/council/laws/economy/diplomacy + fleet:<id> + planet:<id>
 ├─ new MainSession()
 ├─ world.start()             每 read.refreshSeconds 一次轻量读
 ├─ startMainLoop()           每 ai.main.intervalSeconds 一次决策
 └─ 已激活事件 → 事件队列
```

启动是全量读；后续轮询是轻量读，每 `read.deepEveryTicks` 次做一次全量（默认第 0 次算全量，即启动那一次）。

---

## 3. 数据模型

### WorldSnapshot（`reader.readWorld`）

| 字段 | 说明 |
| --- | --- |
| `inGame/date/paused/speed` | 来自 `get_status` |
| `status` | `get_status` 原始返回 |
| `resources` | `{ key: {stockpile, net…} }` |
| `government/civics/edicts/traditions/research/leaders/species/market` | 国家域 |
| `contacts/pendingDiplomacy/wars/warGoals/diplomacyOptions` | 外交域 |
| `activeEvents/alerts/notifications/situations` | 事件域 |
| `colonies[]` | 每颗殖民地：`summary` + `details/jobs/armies/buildable*/zones/blockers/decisions/features/terraforming` |
| `fleetsAll[]` / `fleetsDetail[]` | 舰队概览 + 明细 |
| `systems{}` | 相关星系（殖民地/舰队所在 + 带 M 标记的巨构星系） |
| `galaxyMap/megaScan` | 星图 + 巨构 |
| `mods` / `modsDigest` | 模组清单 |
| `eventChains` | `{active:[{windowId,id,title,options,chain:{root,nodes}}], unresolved, index}` |
| `save` | 存档目录 + 最新存档 meta |
| `errors[]` / `unsupported[]` / `stats` | 容错与诊断 |

查询未知形状时全部走"多候选字段"提取（`extractColonies` / `extractFleets`），不同 DLL 版本的字段名差异不会让整次读取失败。

### 触发器（`world.diffWorld`）

差分产出两类：

- `completions`：研究完成、建造完成、殖民地建立、舰队出现/消失、法令/传统变化、巨构发现、通知……
  进主会话上下文做复盘。
- `triggers`：**需要立刻处理**的：`event_window`、`alert:council`、`alert:diplomacy`、`alert:situation`、
  `election_result`（统治者变化）、`diplomacy_proposal`、`war_started`、`situation_started`。
  编排器把它们送进特殊事件队列或对应单位。

---

## 4. 决策协议（两种后端通用）

所有模型回复都要求是**一个 json 代码块**。解析器（`ai/protocol.mjs`）先找 ```json 围栏，再退化到第一个配平 `{...}`；解析失败不抛异常，而是把错误喂回模型重写。

### 主会话

```json
{
  "say": "给玩家的一句话",
  "pause": false,
  "resume": false,
  "spawn": [
    { "unit": "research", "goal": "把物理研究切到 X，因为…" },
    { "unit": "fleet:3", "goal": "回防首都" }
  ],
  "intervals": { "fleet:3": 60 },
  "report": "复盘：判断依据与下一步"
}
```

`spawn[].unit` 必须是当前已知单位；`say` 会进聊天出站队列。

### 子会话（单位 / 特殊事件）

```json
{
  "say": "一句话说明",
  "actions": [
    { "method": "select_research", "params": { "slot": "physics", "tech_key": "tech_lasers_2" } }
  ],
  "done": true,
  "status": "ok | blocked | continue",
  "cause": "多次失败时：最可能原因",
  "suggestion": "给主会话的建议",
  "evidence": "依据的字段/错误原文"
}
```

`actions` 会先过 `validateActions`：

1. 方法必须存在于动作表；
2. 参数名必须完全匹配（多余字段直接拒绝——这是模型幻觉的重灾区）；
3. 类型必须对（int/number/string/bool/array/map）；
4. 单位白名单：`planet` 子会话不能发 `move_fleet`；`event` 额外允许 `set_paused`。

校验失败不会执行，而是把错误清单作为"系统观察"喂回模型，占用一次重试机会。

### 失败分析

用满重试次数后，额外发一轮 `failureAnalysisPrompt`：

```json
{ "cause": "…", "evidence": "…", "suggestion": "…", "retry": [{ "method": "…", "params": {}, "why": "…" }] }
```

`cause/suggestion` 会随报告一起进主会话上下文，并写进 journal。

---

## 5. 执行器语义

`executor.submit({unit, actions})` 返回 `JobResult`：

```ts
{
  jobId, unit, ok, error, failedIndex, summary, durationMs,
  actions: [{ index, method, params, status: 'ok'|'failed'|'skipped',
              attempts: [{attempt, ok, ms, response?, verify?, error?}],
              verify?: {ok, soft, detail} }]
}
```

规则：

1. **严格串行**：DLL 单连接 + 游戏主线程队列，所有 job/action 走同一条链；
2. **阈值暂停**：`queuedActions >= executor.pauseWhenQueuedActions` → 在开始执行前 `set_paused(true)`；
   排空到 `resumeWhenQueuedActionsBelow` 以下且暂停是执行器发起的 → 自动恢复；
3. **读回**：每个动作按 `actions.mjs` 的 `verify` 规格重新读取：
   - `path + equalsParam`：硬校验（如 `set_paused` → `get_status.is_paused`）；
   - `includesParam / excludesParam`：默认 soft（参数语义不完全确定时只记警告）；
4. **Y 次**：单动作最多 `executor.maxAttempts` 次（RPC 级，指数退避）；
5. **失败即止**：某一步失败后整个 job 在该步终止，后续动作 `skipped`，不自动重排；
6. 失败不会卡住队列：job 结束即处理下一个。

子会话在此基础上再做一层"换方案重来"（`ai.unit.attempts`），所以两层重试各司其职：
执行器处理瞬时错误，子会话处理语义错误。

---

## 6. 特殊事件

触发来源：`event_window`（新弹窗）、`alert:*`（按标题/类型分类）、`election_result`（统治者变化）、
`diplomacy_proposal`、`war_started`、`situation_started`。

流程：

```
world.emit('trigger')
  → Orchestrator.handleTrigger
      ├─ 事件类 → enqueueEvent → 单并发事件队列 → EventSession.run()
      │     ├─ 先暂停（若未暂停）
      │     ├─ 上下文：事件窗口 + 选项 + 事件链后续树
      │     ├─ resolve_event / open_alert / set_situation_approach / set_paused
      │     └─ 完成后恢复，并把报告交给主会话
      ├─ 外交请求 → 派给 diplomacy 单位子会话
      └─ 其它 → 记入主会话观察，并安排一次主会话 tick
```

事件会话是**临时**的（`event:<windowId>`），处理完即销毁；主会话的 1:1 单位会话是**常驻**的（保留上下文）。

---

## 7. DSH 插件设计

```
dsh-stellaris-bridge/
  index.js          shim：固定端口 49939 + 注册 DSH 路由 + 按需 import handler
  lib/handler.mjs   真正逻辑：ctx.subagents.startActivation({provider:'spawn'}) → 文本
```

**固定端口**：DSH 自己的 Web 端口每次启动都可能变，所以插件在 DSH 进程内再起一个
`http.createServer`，监听 `127.0.0.1:49939`（`STELLARIS_BRIDGE_PORT` 可覆盖）。
程序只需要连这个固定地址；同时保留 DSH Web 的 `/api/stellaris-orchestrator/*` 路由兼容旧客户端。

- 端口被占用时先探测是不是已有桥实例：是则复用，否则记录 `portError` 并保留 DSH 路由，不阻塞 DSH 启动；
- shim 只依赖 DSH 的 `webServer/subagents/agents` 三个服务；逻辑变了不用重启 DSH；
- `POST /reload` 丢弃缓存、带 `?v=<ts>` 重新 import，返回新版本号与固定端口；
- 只允许本机（`127.*` / `::1` / `::ffff:127.*`）；
- 插件与程序之间的契约只有 `{prompt,label,timeoutMs} → {text,usage}`，没有第二套协议。

安装（`agent/lib/dsh-plugin.mjs`）是幂等的：junction（无权限时退回复制）+ profile `package.json`
的 `dependencies` / `dsh.profile.bundles`，改前备份 `.before-stellaris-bridge`。

---

## 8. 配置

完整默认值在 [`agent/config.example.json`](../agent/config.example.json)，代码里的单一来源是
`agent/lib/config.mjs` 的 `DEFAULT_CONFIG`（有测试保证两者结构一致）。

旧版（v1）配置在 `loadConfig()` 时自动迁移：

| v1 | v2 |
| --- | --- |
| `swarm.backend` | `ai.backend` |
| `swarm.dshUrl` | `ai.dsh.url` |
| `swarm.tickSeconds` | `ai.unit.intervalSeconds` |
| `swarm.mainTickSeconds` | `ai.main.intervalSeconds` |
| `swarm.queuePauseThreshold` | `executor.pauseWhenQueuedActions` |
| `swarm.attempts` | `executor.maxAttempts` + `ai.unit.attempts` |
| `deepseek.*` | `ai.deepseek.*` |
| `liveChat.*` | `chat.*` |
| 顶层 `stellarisInstallDir/stellarisUserDir` | `paths.*` |

---

## 9. 扩展点

| 想加什么 | 改哪里 |
| --- | --- |
| 新动作 | `agent/lib/actions.mjs` 的 `ACTIONS`（含 params/required/verify），再跑 `node tools/gen-actions-doc.mjs` |
| 新单位类型 | `UNIT_TYPES` + `context.unitContext` + `context.discoverUnits` +（可选）`prompts` |
| 新读取字段 | `actions.mjs` 的 `READ_METHODS` + `reader.readWorld` |
| 新差分/触发器 | `world.diffWorld` |
| 新聊天通道 | 复用 `chat.inbound/outbound`，在 `server.mjs` 加路由或订阅 SSE |
| 新思考后端 | 实现 `complete({system,messages}) -> {text,usage}`，在 `ai/backend.mjs` 注册 |
| 新事件分类 | `world.diffWorld` 里 `alert:*` 的分类正则 |

---

## 10. 会话展示与自动连接

### 会话快照

每个会话（`MainSession` / `UnitSession` / `EventSession`）都实现了：

- `summary()`：列表用的轻量摘要（id / kind / label / status / running / turns / messageCount / updatedAt / usage / 最近报告）；
- `snapshot()`：详情用（system + 带时间戳的 messages + 最近报告 / 决策 / 执行结果）。

`AISession` 保存 `{role, content, ts}` 并做窗口裁剪；`snapshot()` 默认每条消息截断到 12000 字符，
避免把主会话那份巨大的 JSON 上下文整个塞进界面。

编排器暴露：

```
orchestrator.sessions()          -> [summary...]（主会话置顶，其余按运行中 / 更新时间排序）
orchestrator.sessionDetail(id)   -> snapshot（main / 单位 id / event:<windowId>）
```

特殊事件会话结束后不会立刻消失：最近 12 个保留快照，仍可在「子会话」下拉框里回看。
界面是**单窗口**：主会话一个固定面板；子会话用下拉框选，再展示摘要 + 完整对话；不额外弹窗。

HTTP：`GET /api/sessions` 与 `GET /api/sessions/<id>`（见 [API.md](API.md)）。

### 失败报告导出

`orchestrator.onUnitReport(report, session)` 在 `report.status !== 'ok'` 时调用
`FailureStore.record()`，把失败现场写到 `<home>/failures/`：

- `<时间>-<单位>-<状态>.json`：完整结构（执行器逐行状态/错误码/逐次尝试/读回、会话消息、世界摘要、模型结论）；
- `<时间>-<单位>-<状态>.md`：人读版；
- `latest.json` / `latest.md`：最近一次；
- 超过 `failures.maxFiles` 按时间清理；`includeTranscript` / `includeWorld` 控制体积；
- 不写 API Key / token / 完整配置；
- 导出成功后把 `{id,file,markdownFile}` 挂到 `report.exported`，会话快照和聊天出站都能看到；
- 运行异常（`dispatch` / 事件会话抛错）也会合成一条 `status=error` 报告再导出。

HTTP：`GET /api/failures`、`/api/failures/<id>`、`/api/failures/<id>/markdown`；
界面「子会话」页右上角「失败报告」直接打开目录；CLI `failures` / `failure <id>`。

### 每存档一个主会话

- `save.mjs` 的 `saveIdentity()` 用 `save games/<帝国目录>`（同目录 autosave/manual 视为同一存档）生成稳定 `saveKey`，并派生 `stellaris-main-<saveKey>`；
- `MainSessionStore` 把每个存档的主会话 transcript 存在 `<home>/main-sessions/<saveKey>.json`；
- 编排器启动时 `switchMainSave(world.save)`；`startSaveWatch()` 每 30 秒重新读存档目录，发现 `saveKey` 变化就：
  1. 持久化旧主会话；
  2. 清空旧单位/事件会话；
  3. 载入新存档的 transcript，重建 `MainSession`；
  4. 把新 `sessionId` 与独立工作区 `<home>/workspace` 通过 `DshBackend.setMainSession()` 带给插件；
- DSH 插件按 `sessionId` 先 `agents.resume()`，没有就 `agents.create()`；`meta.cwd` 指向
  `<home>/workspace`，`meta.title` 用存档 `meta.name`（帝国名），并用
  `workspaceRegistry.create()` 注册成 DSH 项目“群星参谋”；同一个存档的 autosave 不会换主会话。

### 轻量刷新与 deep 字段

`World.refresh()` 默认每 6 次做一次 deep 读取；中间的轻量读取只读摘要，会丢掉
`fleetSystems`、`galaxyMap`、殖民地 `details`、传统节点等 deep 字段。`mergeDeepContext()`
会在轻量刷新时保留这些字段（并按 `planet_id`/`fleet_id` 合并），否则舰队会看到
`fleetSystems=null`、星球会看到 `capacity`/区划为空。`ai.unit.maxConcurrent`（默认 5）
限制单位/事件子会话并发，避免 DSH 的 `active child limit: 8`。

### 人格与 voice

- `agent/lib/persona.mjs`：10 个 0-100 属性、7 个预设、`normalizePersona`、`personaPrompt`，
  以及 Character Card V2 / JSON / Markdown 导入（`parsePersonaImport` + `mergeImportedPersona`）；
- 主会话 system prompt 由 `mainSystemPrompt({config.persona})` 注入人格段与“人话”规则；
- 模型输出的 `voice/mood/intent` 经 `parseMainDecision` 归一化后，由 `MainSession._emitVoice`
  按 `persona.voice.everyTurns` / `minIntervalSeconds` 节流；
- 输出三路：`VoiceLog`（`<home>/voice/` 按天 JSONL + `latest.json`）、聊天出站 `kind=voice`、
  `onVoice` 回调；HTTP `GET /api/voice` 支持 `since` 游标，供 TTS/直播轮询；
- `POST /api/persona` 保存并调用 `main.applyPersona()` 立即重建 system prompt，不重启调度。

### 自动连接（看护循环）

`App.startWatcher()` 每 `bridge.watchSeconds` 检查一次：

```
编排器在跑？          -> 只刷新 readiness，不做别的
桥能 get_status？      -> 能：直接用；不能：找游戏进程
游戏进程在？          -> 在：按 autoInject 注入；不在：等下一轮
已进局且 autoStart？   -> 自动 start()（全量读取 + 主会话循环）
```

要点：

- 注入复用 `inject.ps1` 的 `already_loaded` 检查，游戏重启后会再次注入；
- 手动「停止」写入 `autoStartSuppressedAt`，5 分钟内不会被看护循环拉起；
- readiness 缓存 4 秒、游戏进程查询缓存 10 秒，状态栏 5 秒轮询不会造成负担；
- 「大模型连接」：DSH 打一次 `/health`；DeepSeek 默认只看 Key 是否配置，`?verify=1` 才真发一次 1 token 请求。

---

## 11. 测试与校验

```powershell
npm test                      # 124 项 node:test
node tools/gen-actions-doc.mjs
powershell -File agent/gui/StellarisAgent.ps1 -SelfTest   # 只构建窗口
.\run.cmd doctor              # 真机：桥/后端/插件/路径
```

测试覆盖：动作表一致性、执行器（串行/重试/读回/阈值暂停）、协议解析、聊天游标、读取容错、
世界差分、子会话重试与失败分析、失败报告导出/清理、模组启用判定、事件图（原版+模组+后续+缓存）、
插件安装幂等、配置迁移、App readiness/看护循环。

### 没有游戏时怎么跑全链路

仓库自带两个开发用假件（只在临时 HOME + 独立 pipeName 下用，不碰存档）：

```powershell
node tools/fake-bridge.mjs stellaris_mcp_e2e   # 同名命名管道，返回结构化假状态
node tools/mock-llm.mjs 9911                   # OpenAI 兼容的假模型，按角色返回 JSON 决策
```

把临时配置里的 `bridge.pipeName` 指到 `stellaris_mcp_e2e`、`ai.deepseek.baseUrl` 指到
`http://127.0.0.1:9911`，再 `serve` + `POST /api/orchestrator/start`，即可验证：
全量读取 → 主会话派发 → 子会话出动作 → 执行器读回 → 特殊事件处理 → 会话展示。
