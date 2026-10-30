# 群星参谋 · 对接 / 交接文档

> 目标读者：接手开发、换机器继续开发、或要把群星参谋接到别的编排器上的人。
>
> 当前适配：**Stellaris 4.5.2 (9776)**，Windows 10/11，Node 22+。

---

## 1. 它是什么

群星参谋是一个独立的 Windows 程序，做三件事：

1. **读**：通过注入游戏进程的原生桥，实时读取帝国、资源、星球、舰队、外交、事件；
2. **想**：本地 DeepSeek 主控/子会话，或把编排交给 DSH；
3. **写**：把计划编译成 34 个原生动词，逐项执行、读回验证、失败重试。

它**不模拟鼠标键盘**，也**不修改游戏 exe/存档**；原生桥通过命名管道在游戏线程里执行引擎命令。

```
┌────────────────────┐        HTTP/JSON        ┌────────────────────┐
│  WinForms GUI      │ ──────────────────────► │  Node 后端 serve   │
│  StellarisAgent.ps1│                         │  agent/lib/server  │
└────────────────────┘                         └─────────┬──────────┘
                                                         │
                         ┌───────────────────────────────┼──────────────────────────────┐
                         │                               │                              │
                  ┌──────▼──────┐                 ┌──────▼──────┐                ┌──────▼──────┐
                  │ 本地主控     │                 │ DSH 主控     │                │ 原生桥       │
                  │ DeepSeek    │                 │ dsh plugin  │                │ named pipe  │
                  │ swarm.mjs   │                 │ /team       │                │ DLL in game │
                  └─────────────┘                 └─────────────┘                └─────────────┘
```

---

## 2. 仓库地图

```
agent/                    独立应用
  bin/stellaris-agent.mjs CLI 入口
  lib/
    server.mjs            HTTP API / SSE
    swarm.mjs             编排核心（本地/DSH 切换、组件、队列）
    engine.mjs            读档、日志、事件、原生桥门面
    native-bridge.mjs     注入 + 命名管道客户端
    native-verbs.mjs      34 个原生动词
    native-operator.mjs   逐步执行/重试/读回
    dsh-orchestrator.mjs  调 DSH 插件的 HTTP 客户端
    dsh-discovery.mjs     自动探测 DSH 端口
    config.mjs            配置/首次初始化
    logger.mjs            本地文件日志
  gui/StellarisAgent.ps1  WinForms GUI
  native/                 stellaris_bridge.dll + 注入脚本
  runtime/                node.exe（构建时生成，git 忽略）

engine/                   纯读取/编译/执行/存档/事件索引，不依赖 DSH
dsh-stellaris-bridge/     DSH 插件（原 dsh-stellaris-orchestrator）
docs/                     协议、DSH 后端、调度、本文件
scripts/                  构建 EXE / 打包 Node / 安装插件
run.cmd                   CLI 启动器
run-gui.cmd               GUI 启动器
init.cmd                  首次运行初始化
StellarisAgent.exe        构建产物（git 忽略）
```

---

## 3. 从零启动

### 3.1 环境

- Windows 10/11；
- Stellaris **4.5.2**；
- Node 22+（开发）或直接用打包好的 EXE；
- DeepSeek API Key（本地主控）或 DSH（DSH 主控）。

### 3.2 首次初始化

```powershell
cd <repo>
.\init.cmd
```

会创建：

```
%USERPROFILE%\.stellaris-agent\config.json
```

也可以直接启动 EXE，GUI 会自动创建目录和默认配置。

### 3.3 启动游戏

启动 Stellaris，**读档或新开一局**。停在启动器/主菜单时，原生桥能注入，但 `in_game=false`，不能执行操作。

### 3.4 启动程序

```powershell
.\run-gui.cmd
# 或双击 StellarisAgent.exe
```

启动时选择主控：

- **本地主控**：需要 DeepSeek Key；
- **DSH 主控**：需要 DSH 插件已加载，地址可自动检测。

状态栏必须看到：

```
DSH: 已连接
群星: 已连接 2200.01.01
AI: dsh / Key 已配置
```

然后点「自动运行 AI」。

---

## 4. 三层接口

### 4.1 原生桥：命名管道 JSON-RPC

| 项 | 值 |
| --- | --- |
| 管道 | `\\.\pipe\stellaris_mcp_bridge` |
| 编码 | UTF-8，换行分隔 JSON |
| 协议 | JSON-RPC 2.0：`{"jsonrpc":"2.0","id":1,"method":"get_status","params":{}}` |
| 连接数 | **单连接**；程序内部串行排队 |
| 注入 | `CreateRemoteThread(LoadLibraryW)` 加载 `agent/native/stellaris_bridge.dll` |
| 版本 | DLL 与游戏 4.5.2 绑定，游戏更新后需替换 |

> DLL 上游：Yidhar/stellaris-mcp（MIT），见 `agent/native/NOTICE.md`。

常用方法（完整列表：`.\run.cmd verbs`）：

```
[时间]   set_paused, set_speed
[星球]   build_building, set_district_zone, set_job_priority, build_district
[科研]   select_research
[舰队]   build_ship, build_outpost, build_stations, colonize, move_fleet,
         survey, set_fleet_stance, set_fleet_template_quota, reinforce_fleet,
         follow_fleet, merge_fleets
[传统]   adopt_tradition, adopt_ascension_perk
[经济]   market_trade
[领袖]   hire_leader, assign_leader, assign_councilor, set_council_agenda
[外交]   diplomacy_action, respond_diplomacy, set_defender_war_goal
[事件]   resolve_event, open_alert, open_notification
[界面]   show_panel, focus_planet, focus_fleet
```

读取类方法（与 `native-reader.mjs` 一致）：

```
get_status, get_government, get_research_state, get_traditions,
get_tradition_candidates, get_ascension_candidates, get_leaders,
get_council_candidates, get_fleets, get_military_fleets,
get_civilian_fleets, get_contacts, get_pending_diplomacy, get_wars,
get_active_events, get_alerts, get_notifications, get_market,
get_galaxy_overview, get_galaxy_map, get_ship_designs,
get_defense_scan, get_fleet_tactics,
get_planet_details, get_planet_jobs, get_buildable_buildings,
get_buildable_districts, get_available_district_zones,
get_system, get_buildable_ships, get_buildable_megastructures,
get_diplomacy_options, get_war_goal_candidates
```

**注意**：不要从多个进程/线程同时连管道。程序里的 `NativePipe` 已经对单连接做了串行队列。

### 4.2 程序 HTTP API

默认地址：`http://127.0.0.1:8787`（`serve --port` 可改）。

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/status` | 目录、模组、快照、存档、注入状态 |
| GET | `/api/brief` | 战局简报 |
| GET | `/api/timeline` | 事件时间线 |
| GET | `/api/events` | SSE 事件流 |
| GET | `/api/diagnostics` | 诊断包（不含 Key 明文） |
| GET | `/api/readiness` | DSH / 群星 / Key 三项就绪状态 |
| GET | `/api/dsh/discover` | 扫描 DSH 进程端口并探测插件 |
| POST | `/api/native/connect` | 注入原生桥并返回 inGame/date |
| GET | `/api/native/status` | 原生桥实时状态 |
| GET | `/api/native/read` | 原生桥全量读取 |
| POST | `/api/native/run` | 执行原生步骤，body `{steps, attempts?}` |
| GET | `/api/events/search?q=` | 搜索事件链 |
| GET | `/api/events/chain?id=&depth=` | 查事件后继 |
| POST | `/api/swarm/start` | 启动调度，body `{objective?, once?}` |
| POST | `/api/swarm/stop` | 停止调度 |
| GET | `/api/swarm/status` | 队列/组件/完成情况 |
| GET | `/api/queue` | 旧调度队列 |
| POST | `/api/dispatch` | body `{goal, priority?}` |
| POST | `/api/apply-auto` | body `{actions}` |
| POST | `/api/ask` | body `{text, readOnly?}`；上一轮未完成返回 409 |
| POST | `/api/livechat/ingest` | 直播输入 |
| GET | `/api/livechat/poll` | 轮询直播消息 |
| POST | `/api/livechat/reply` | 回复直播 |
| GET | `/api/livechat/stream` | SSE 直播流 |

示例：

```powershell
$base = 'http://127.0.0.1:8787'
Invoke-RestMethod "$base/api/readiness"
Invoke-RestMethod "$base/api/native/connect" -Method Post
Invoke-RestMethod "$base/api/swarm/start" -Method Post `
  -ContentType 'application/json' -Body '{"objective":""}'
```

错误约定：成功 `{ok:true,...}`；失败带 `{ok:false,error,detail?}`。`error` 是机器可读的短码，`detail` 是给人看的。

### 4.3 DSH 插件 API

插件目录：`dsh-stellaris-bridge/`  
服务名：`dsh-stellaris-bridge`  
路由前缀：`/api/stellaris-orchestrator`（历史名字，保留兼容）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/api/stellaris-orchestrator/health` | `{ok,service,hasSubagents,hasParent}` |
| POST | `/api/stellaris-orchestrator/run` | body `{prompt,label?,timeoutMs?}`，普通单会话 |
| POST | `/api/stellaris-orchestrator/team` | 同上，但提示词要求 DSH 用自己的子代理机制组织 |

`/team` 的返回：

```json
{
  "ok": true,
  "text": "```stellaris-native\n[...]\n```",
  "usage": null
}
```

插件内部：

```js
ctx.subagents.startActivation({
  provider: 'spawn',
  label,
  request: { prompt: [{type:'text', text: prompt}], parent: owner },
  signal,
  delivery: 'caller',
})
const result = await activation.result
```

`owner` 优先用 `ctx.agents.currentInitiator()`，其次 `ctx.agents.list()[0]`，都没有时 `ctx.agents.create(...)`。

**只允许 localhost**：非 `127.*`/`::1` 返回 403。

### 4.4 编排契约：`stellaris-native`

DSH/模型最终输出一个代码块：

````markdown
```stellaris-native
[
  {"method":"set_paused","params":{"paused":false}},
  {"method":"move_fleet","params":{"fleet_id":3,"system_id":107}}
]
```
````

`swarm.mjs` 的 `extractNativeSteps()` 会抽出来，交给 `native-operator.mjs` 执行。

主会话的指令不是这个格式，而是：

```json
{"pause": true, "unpause": false, "reset": ["planet:3"], "intervals": {"planet:3": 90}, "disabled": [], "enabled": []}
```

---

## 5. 本地主控 vs DSH 主控

配置：

```json
"swarm": {
  "backend": "local",
  "dshUrl": "http://127.0.0.1:49939"
}
```

`Swarm` 构造函数：

```js
this.runner = backend === 'dsh'
  ? new DSHOrchestrator({ baseUrl: dshUrl })
  : orchestrator
```

本地模式需要 `orchestrator`（DeepSeek 客户端）；DSH 模式即使没有本地 Key 也能启动，但**真正的执行仍然在本地**：

- DSH 只负责“想”和“拆会话”；
- 群星执行器仍由 `native-operator.mjs` 串行执行；
- DSH 不可用时，`/api/swarm/start` 返回 500，错误来自 `/team`。

启动流程：

```
ensureNativeBridge()
  → 检查 in_game
  → discover() 自动发现 planet:<id> / fleet:<id>
  → scanMegastructures()
  → watch()
  → mainTick() / componentTick()
```

`--once` 只跑一轮；`--plan-only` 只生成计划不执行。

---

## 6. 配置

位置：

```
%USERPROFILE%\.stellaris-agent\config.json
```

可用 `STELLARIS_AGENT_HOME` 覆盖整个目录。

关键字段：

| 字段 | 说明 |
| --- | --- |
| `stellarisInstallDir` | 游戏安装目录；留空自动找 Steam 库 |
| `stellarisUserDir` | 用户目录（存档/日志）；留空自动找 Documents/OneDrive/注册表 |
| `deepseek.apiKey` | 仅本地主控需要 |
| `swarm.backend` | `local` / `dsh` |
| `swarm.dshUrl` | DSH Web 地址；可自动检测 |
| `swarm.tickSeconds` | 组件 tick |
| `swarm.mainTickSeconds` | 主会话 tick |
| `swarm.queuePauseThreshold` | 队列达到多少暂停游戏 |
| `swarm.attempts` | 执行失败重试次数，默认 5 |
| `swarm.planOnly` | 只计划不执行 |
| `swarm.autoUnpause` | 队列清空后是否自动继续 |
| `liveChat.*` | 直播接入 |
| `safety.*` | 写操作安全阈值 |

完整默认值见 `agent/config.example.json`。

---

## 7. 构建与打包

```powershell
# 1. 复制 Node 运行时到 agent/runtime/node.exe
.\scripts\bundle-node.ps1

# 2. 生成 StellarisAgent.exe（下载 ps2exe 到 build-tools，产物在根目录）
.\scripts\build-exe.ps1
```

EXE、`agent/runtime/`、`build-tools/` 都在 `.gitignore` 中，不进仓库。

DSH 插件安装：

```powershell
.\scripts\install-dsh-plugin.ps1
```

安装后**完全退出 DSH 再启动**。profile 里会有：

```
dependencies.dsh-stellaris-bridge = link:<repo>/dsh-stellaris-bridge
dsh.profile.bundles += dsh-stellaris-bridge
```

---

## 8. 换机器开发检查清单

1. `git clone` / 复制仓库；
2. `.\init.cmd` 或直接启动 EXE；
3. 设置页填：
   - 群星安装目录；
   - 群星用户目录（自动找不到时手选）；
   - DeepSeek Key（本地主控）或 DSH 地址（DSH 主控）；
4. 启动游戏并进局；
5. 启动 DSH（如果使用 DSH 主控），确认插件：
   ```powershell
   .\run.cmd dsh-discover
   ```
6. 自检：
   ```powershell
   .\run.cmd doctor
   ```
   期望：
   ```json
   "game": {"bridge": true, "inGame": true, "date": "..."},
   "dsh": {"ok": true, "service": "dsh-stellaris-bridge"},
   "apiKey": true
   ```
7. GUI 点「连接群星」，再点「自动运行 AI」。

---

## 9. 排错表

| 现象 | 短码/原因 | 处理 |
| --- | --- | --- |
| 连接群星 503 | `GAME_NOT_RUNNING` | 启动游戏并读档 |
| 自动运行 500 | `GAME_NOT_IN_SESSION` | 还在主菜单，读档/新开局 |
| 连接群星 503 | `INJECT_FAILED` | 版本/权限/杀软；确认 4.5.2 |
| 连接群星 503 | `PIPE_NOT_READY` | 重启游戏 |
| 连接群星 503 | `DLL_NOT_FOUND` | 检查 `agent/native/stellaris_bridge.dll` |
| 自动运行 503 | 本地无 Key | 设置页填 Key |
| 自动运行 500 | DSH `/team` 失败 | 查 `dsh.reachable`、DSH 日志 |
| `DSH: 未连接` | `DSH_NOT_FOUND` | `dsh-discover`；重启 DSH |
| 日志无 `swarm.start.request` | 旧后端占 8787 | 杀掉旧 `node serve`，重启 EXE |
| 用户目录 null | 文档被 OneDrive/别的盘接管 | 设置页手选用户目录 |
| 模组缺失 | 未装 DSH Reader/Console | 可选；原生桥不需要 |

诊断：

```powershell
.\run.cmd doctor
.\run.cmd dsh-discover
.\run.cmd native-status
```

GUI：设置 → **导出诊断日志** → `%USERPROFILE%\.stellaris-agent\diagnostics-*.json`。

日志：

```
%USERPROFILE%\.stellaris-agent\logs\agent.log
%USERPROFILE%\.stellaris-agent\logs\backend.out.log
%USERPROFILE%\.stellaris-agent\logs\backend.err.log
```

---

## 10. 已知限制 / TODO

- 仅 Windows；
- DLL 与 4.5.2 绑定，游戏小版本更新就可能失效；
- 原生管道单连接，不能同时开两个程序；
- 模组（Reader/Console）完全可选，不装时 `snapshot` 为 null；
- DSH 插件路由仍叫 `/api/stellaris-orchestrator`，改名会破坏旧客户端；
- `planOnly` 模式下 `activity` 的 `[]` 是正常现象，不是失败；
- 目前没有单元测试，CI 只做 `node --check` / JSON 解析；
- API Key 以明文存本地 config，不要提交。

---

## 11. 改哪里

| 需求 | 文件 |
| --- | --- |
| 加原生动词 | `agent/lib/native-verbs.mjs` |
| 改进执行/重试 | `agent/lib/native-operator.mjs` |
| 改编排循环 | `agent/lib/swarm.mjs` |
| 加 HTTP 接口 | `agent/lib/server.mjs` |
| 改 DSH 提示/接口 | `dsh-stellaris-bridge/index.js` |
| 改 GUI | `agent/gui/StellarisAgent.ps1` |
| 改配置默认值 | `agent/config.example.json` |
| 改事件/存档解析 | `engine/lib/` |
| 构建/安装 | `scripts/` |

---

## 12. 安全边界

- 仅单机/私人存档使用；
- 不提供联机、反作弊绕过；
- API Key 只写本地 config，诊断文件只输出 `apiKeyConfigured` 布尔值；
- 原生桥只监听本地命名管道，不开放网络端口。
