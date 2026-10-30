# 群星参谋 · Stellaris Agent v2

把《群星》(Stellaris 4.5) 的实时状态读出来，交给 **DeepSeek API** 或 **DSH 插件** 推理，再由一个**串行执行器**把决定写回游戏。

> v2 是重写：只保留"原生桥"这一条成熟链路（读 + 写），删掉了旧的"控制台键盘注入 / 日志模组"路径。
> **使用指南见 [`docs/USAGE.md`](docs/USAGE.md)**；架构细节见 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，接口见 [`docs/API.md`](docs/API.md)，动作表见 [`docs/ACTION-CATALOG.md`](docs/ACTION-CATALOG.md)。

---

## 1. 它怎么工作

```
┌──────────────┐   HTTP/JSON   ┌──────────────────────────────────────────────┐
│ WinForms GUI │ ────────────► │  Node 后端 (agent/lib/server.mjs)             │
└──────────────┘               │                                              │
                               │  读取层 reader ── 原生桥 DLL ── 游戏          │
                               │      │                                       │
                               │      ▼                                       │
                               │  world（轮询 + 差分：完成事件 / 特殊事件）     │
                               │      │                                       │
                               │      ▼                                       │
                               │  主会话 ──派发──► 1:1 单位子会话（舰队/星球…） │
                               │      │            特殊事件子会话（选举…）      │
                               │      │                     │                 │
                               │      ▼                     ▼                 │
                               │  执行器（串行 / 读回 / 阈值暂停 / Y 次重试）   │
                               └──────────────────────────────────────────────┘
                                          │              ▲
                                          ▼              │
                                    DeepSeek API 或 DSH 插件
```

一句话：**主会话负责想，子会话负责把想法变成动作，执行器负责动作真的发生并回报。**

界面（单窗口，不弹子窗口）：

- **底部常驻**：`大模型: 已连接 / 未连接（原因）` 与 `游戏: 已连接 2200.01.01 / 未连接（原因）`，颜色区分，悬停看详情；
- **「主会话」页**：主会话的状态摘要 + 完整对话（它在看什么、决定了什么、派发了谁）；
- **「子会话」页**：顶部下拉框选择单位或特殊事件，下面展示该会话的摘要 + 完整对话；
- **自动连接**：程序启动后由看护循环负责——游戏在跑就注入原生桥，进局就自动接管；游戏重启后自动续上。

### 启动时读什么（全量）

- **全局**：日期/暂停/速度/26 项资源/容量/计数；
- **国家**：政府、内阁、国策、法令、传统/飞升、科研（当前 + 候选项）、领袖、物种与权利、市场；
- **外交**：接触国、待处理提议、战争、战争目标、每个国家的外交选项；
- **银河**：概览、星图、每颗殖民地的星系、巨构扫描；
- **每颗殖民地**：详情、岗位、陆军、可建建筑/区划/特区、障碍、决议、地形改造、特征；
- **每支舰队**：详情（含舰船/模板/补员缺口）；
- **模组**：本地 + 创意工坊 + DLC 清单（`dlc_load.json` 判定启用）；
- **已激活事件链**：`get_active_events` → 本地事件图（**原版 + DLC + 已启用模组**）→ 每个事件的**后续树**；
- **存档**：存档目录 + 最新 `.sav` 的 `meta`（日期/版本/玩家/铁人）。

读取失败不会中断整体：单个方法失败进 `errors`，DLL 不认识的方法进 `unsupported` 并在本次运行内不再重试。

### 配置项（节选，完整见 `agent/config.example.json`）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `executor.pauseWhenQueuedActions` | `8` | **待执行动作数 > X 时暂停游戏** |
| `executor.resumeWhenQueuedActionsBelow` | `3` | 排空到该值以下才自动恢复 |
| `executor.maxAttempts` | `3` | 单动作 RPC 级重试次数（Y） |
| `ai.unit.attempts` | `3` | 子会话"换方案重来"的次数（Y） |
| `ai.main.intervalSeconds` | `120` | 主会话定时决策间隔（有事件/聊天/回报会提前唤醒） |
| `ai.backend` | `deepseek` | `deepseek` 或 `dsh` |
| `paths.*` | 空 | 游戏安装目录 / 用户目录 / 存档目录（留空自动探测） |
| `bridge.autoInject` | `true` | 游戏在跑但桥没连上时自动注入（一次注入后自动续上） |
| `bridge.autoStartOrchestrator` | `true` | 桥就绪且已进局时自动启动调度器 |
| `bridge.watchSeconds` | `15` | 看护循环间隔；手动停止后有 5 分钟冷静期 |

---

## 2. 快速开始

### 用 EXE

1. 启动群星并**读档或新开一局**；
2. 双击 `StellarisAgent.exe`；
3. 选择主控：DeepSeek API 或 DSH 插件；
4. 进主窗口 →「启动并读取」。

状态栏应显示 `群星: 已连接 2200.01.01`、`AI: … 就绪`；随后主会话开始按间隔决策。

### 从源码

```powershell
# 需要 Node 22+
.\run.cmd status           # 路径 / 桥 / 后端 / 插件
.\run.cmd read             # 全量读取（不需要 Key，不写游戏）
.\run.cmd actions          # 动作表（58 个写动作）
.\run.cmd events index     # 重建事件索引（原版+DLC+模组，不需要游戏）
.\run.cmd serve            # 本地 HTTP + 面板（http://127.0.0.1:8787）
.\run-gui.cmd              # 桌面窗口
```

首次运行会生成 `%USERPROFILE%\.stellaris-agent\config.json`；旧版（v1）配置会在读取时**自动迁移**（`swarm.*` → `ai.*`，路径、后端、阈值都不丢）。

### 构建 EXE

```powershell
.\scripts\bundle-node.ps1   # 复制 node.exe 到 agent/runtime
.\scripts\build-exe.ps1     # 用 ps2exe 生成根目录 StellarisAgent.exe
```

---

## 3. 两种思考后端

两种后端**完全同构**：都只返回文本，程序从文本里的 ```json 代码块解析指令。所以换后端不影响任何编排逻辑。

| | DeepSeek API | DSH 插件 |
| --- | --- | --- |
| 配置 | 设置页填 Key | 设置页填 DSH 地址（可自动检测） |
| 谁在思考 | 程序直连 `api.deepseek.com` | DSH 内的子代理会话 |
| 需要 DSH 运行 | 否 | 是 |
| 子会话拆分 | 程序自己做（1:1 单位） | 同左；DSH 只负责"想" |

DSH 插件（`dsh-stellaris-bridge`）是**固定端口 + 稳定 shim + 热重载 handler**：

- **固定端口 `127.0.0.1:49939`**（可用 `STELLARIS_BRIDGE_PORT` 覆盖）：插件自己在 DSH 进程内起一个 HTTP 服务，程序只连这一个地址，不再随 DSH Web 端口漂移；
- 同时保留 DSH Web 的 `/api/stellaris-orchestrator/*` 路由做兼容，旧配置仍能用；
- `index.js` 只做路由与转发，几乎不再变；
- 真正逻辑在 `lib/handler.mjs`，按 mtime 动态 import；
- `POST /api/stellaris-orchestrator/reload` 即可热更新，**不用重启 DSH**；
- 程序每次启动都会"安装/更新插件 + 尝试热重载"；只有 shim 本身变了才需要重启 DSH（可选配置 `dshPlugin.restartCommand` 或在设置页手动点"重启 DSH"，默认不杀你的会话）。

安装/更新也可以单独执行：

```powershell
.\run.cmd plugin install     # 幂等：junction + profile package.json
.\run.cmd plugin reload      # 热重载插件逻辑
.\run.cmd dsh-discover       # 先试 49939，再回退 DSH Web 端口
```

---

## 4. 会话与执行

- **主会话**：看全局摘要、最近完成事件、子会话上报、玩家聊天；输出 `{say, pause, resume, spawn[], intervals{}}`。它不直接点游戏。
- **1:1 单位子会话**：每个可操控对象一个，独立上下文：`research`、`council`、`laws`、`economy`、`diplomacy`、`fleet:<id>`、`planet:<id>`。
- **特殊事件子会话**：事件弹窗、警报、选举/换届、外交请求等突发情况；处理完把结论交回主会话。

子会话的执行闭环：

```
看上下文 → 出动作 → 校验（方法/参数/单位白名单）
   ↑                    │
   └── 失败详情 ─── 执行器（串行、读回、Y 次）
                        │
                 Y 次仍失败 → 再问一次"可能原因" → 上报主会话
```

失败不会自动重排：任务在失败那一步终止，后续动作标记 `skipped`，避免半截计划。

---

## 5. 人机聊天接口

主会话与人是双向的：

```powershell
# 人说话：只需要 id + 内容
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/chat/in `
  -ContentType 'application/json; charset=utf-8' `
  -Body '{"id":"player:heyik","text":"合金太低了，想办法提上去"}'

# 主会话说的话（轮询，since 是游标）
Invoke-RestMethod 'http://127.0.0.1:8787/api/chat/poll?since=0'
# 或 SSE：GET /api/chat/stream
```

出站消息也带 `id`（`main` / `system` / `unit`），方便直播/多端分流。完整接口见 [`docs/API.md`](docs/API.md)。

---

## 6. 设置页

- 群星安装目录 / 用户目录 / 存档目录（留空 = 自动探测）；
- 思考后端 + DeepSeek Key + DSH 地址（自动检测）；
- **测试大模型连接**（真发一次 1 token 请求，验证 Key/DSH 是否真能用）；
- 动作数阈值 X、重试次数 Y、主会话间隔、看护间隔；
- **自动连接**：`游戏在跑时自动注入`、`进局后自动启动调度器` 两个开关；
- **安装/更新 DSH 插件**、**重载 DSH**（热）、"重启 DSH"（危险，需确认）；
- 导出诊断（不含 Key 明文）。

---

## 7. CLI

| 命令 | 作用 | 需要 Key |
| --- | --- | --- |
| `status` | 路径 / 桥 / 后端 / 插件 | 否 |
| `read [--quick] [--out f]` | 全量读取（含模组、事件链、存档 meta） | 否 |
| `actions [--unit planet] [--json]` | 动作表 | 否 |
| `units` | 发现可控单位 | 否 |
| `events active\|index\|search\|chain` | 事件链（含后续） | 否 |
| `mods` | 已启用模组 | 否 |
| `connect [--start] [--watch]` | 立即连接（必要时注入）并按配置接管 | 否 |
| `sessions` | 会话列表（主会话 + 子会话） | 否 |
| `session <id>` | 某个会话的完整对话 | 否 |
| `execute '<json>'` | 执行动作（走执行器） | 否 |
| `call <method> [json]` | 原始 RPC（排障） | 否 |
| `run [--once] [--objective ...]` | 启动完整编排 | 是* |
| `serve [--port] [--start]` | 本地 HTTP | 否 |
| `pause` / `resume` | 暂停 / 恢复游戏 | 否 |
| `plugin install\|update\|reload\|status` | DSH 插件 | 否 |
| `doctor` / `selftest` | 自检 | 否 |

\* DSH 后端下不需要 DeepSeek Key。

---

## 8. 目录

```
agent/
  bin/stellaris-agent.mjs   CLI 入口
  lib/
    app.mjs                 应用装配（配置 + 编排器 + 插件）
    config.mjs              默认值 / 迁移 / 保存
    bridge.mjs              原生桥客户端（单连接、串行、自动重连）
    actions.mjs             动作目录（58 写 / 43 读）
    executor.mjs            串行执行器（阈值暂停、读回、Y 次重试）
    reader.mjs              全量读取
    mods.mjs                模组/DLC 清单
    events.mjs              事件图 + 已激活事件链（含后续）
    save.mjs                存档目录 + meta
    world.mjs               轮询 + 差分（完成事件 / 特殊事件）
    chat.mjs                人机聊天总线
    context.mjs             上下文裁剪 + 单位发现
    orchestrator.mjs        编排器（生命周期、派发、事件队列）
    ai/                     后端（deepseek/dsh）、主会话、单位/事件子会话、协议、提示词
    dsh-plugin.mjs          插件安装 / 更新 / 热重载
    server.mjs              HTTP API + SSE
    gui/StellarisAgent.ps1  WinForms 界面
  native/                   stellaris_bridge.dll + 注入器
dsh-stellaris-bridge/       DSH 插件（shim + handler）
engine/lib/                 仅保留：路径探测 / Steam / 事件索引 / Clausewitz 解析
test/                       node:test（80 项）
tools/gen-actions-doc.mjs   生成 docs/ACTION-CATALOG.md
docs/                       ARCHITECTURE / API / ACTIONS / legacy
```

---

## 9. 已知边界

- 仅 Windows；DLL 与游戏版本绑定（当前适配 4.5.2 / 9776）；
- 原生桥单连接：程序内部已串行，**不要再开第二个客户端**；
- 铁人档只读：程序会在状态里标出 `ironman`，执行器不额外拦截（原生侧也会拒绝）；
- 动作表里标 `inferred` 的参数来自 DLL 符号推断，首次使用可能失败——失败会走"回报 → 分析 → 主会话决策"的闭环；
- 主会话/子会话的质量取决于模型；程序只保证协议、边界与失败可见。

## License

MIT。原生桥 DLL 的上游来源与许可见 [`agent/native/NOTICE.md`](agent/native/NOTICE.md)。
