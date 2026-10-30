# 使用指南 · 群星参谋 v2

> 适用版本：仓库 `main`（v2 重构版），Stellaris 4.5.x，Windows 10/11。
> 当前机器状态（写这份指南时）：DSH 插件 **v2.1 已在固定端口 49939 运行**；应用与游戏未启动。

---

## 1. 一分钟上手

1. 启动《群星》，**读档或新开一局**（停在主菜单也能连，但不能操作）。
2. 双击仓库根目录的 `StellarisAgent.exe`（或运行 `.\run-gui.cmd`）。
3. 首次弹「选择主控」：
   - **DSH 插件**（推荐，地址已填 `http://127.0.0.1:49939`）；
   - 或 **DeepSeek API**（填 Key）。
   点「开始」。
4. 看窗口最底部：
   ```
   大模型: 已连接 (DSH)     游戏: 已连接 2200.01.01     调度: 运行中
   ```
   全绿即可用。
5. 打开「主会话」页看它第一轮判断；「子会话」页下拉选择星球/舰队/科研看细节；「对话」页可以直接跟它说话。

不想每次看到选择框：

```powershell
$env:STELLARIS_GUI_NO_DIALOG='1'
.\StellarisAgent.exe
```

（只对当前终端有效；关掉终端后失效。）

---

## 2. 启动方式

| 方式 | 命令 | 说明 |
| --- | --- | --- |
| 双击 EXE | `StellarisAgent.exe` | 内置 node，最省事 |
| 跳过选择框 | `$env:STELLARIS_GUI_NO_DIALOG='1'; .\StellarisAgent.exe` | 直接用已保存配置 |
| 脚本 | `.\run-gui.cmd` | 同上，走 PowerShell |
| 只开后端 | `.\run.cmd serve --start` | 无窗口，HTTP + 自动调度 |
| 跑一轮 | `.\run.cmd run --once` | 读取→决策一轮→退出 |
| 源码 | `node agent\bin\stellaris-agent.mjs serve` | 开发用 |

关闭窗口会一并结束后端；`serve` 模式用 `Ctrl+C` 停止。

---

## 3. 界面讲解

### 底部状态栏（最重要）

从左到右：

| 显示 | 含义 |
| --- | --- |
| `大模型: 已连接 (DSH)` / `(DeepSeek)` 绿色 | 后端可用；DSH 会真实探测插件健康 |
| `大模型: 未连接 — 原因` 橙红 | Key 未配、DSH 没开、端口不对等 |
| `游戏: 已连接 2200.01.01` 绿色 | 原生桥已连且已进局 |
| `游戏: 已连接（主菜单）` 橙色 | 桥通了，读档后才能操作 |
| `游戏: 未连接 — 游戏未运行 / 桥未注入` | 启动游戏，或等自动注入 |
| `调度: 运行中 / 未启动` | 主会话循环是否在跑 |
| 右侧「连接 / 重连」 | 手动触发一次注入+连接（一般不用点） |

鼠标悬停可看后端地址、桥状态、注入方式、自动开关。

### 页签

**战局**
- 战局简报、最近完成事件；「刷新」「全量读取」。
- 全量读取包括：日期/资源/政府/内阁/法令/科研/领袖/物种/市场/外交/战争/事件/局势/每颗星球/每支舰队/模组/存档 meta。

**主会话**
- 上半：目标、状态、轮次、最近报告/失败原因。
- 下半：完整对话（系统提示 + 每轮输入/回复 + 时间戳）。
- 这里是「总指挥」的思考记录：它看了什么、决定了什么、派了谁。

**子会话**
- 顶部**下拉框**选择会话：`research`、`council`、`laws`、`economy`、`diplomacy`、`fleet:<id>`、`planet:<id>`，以及最近处理过的特殊事件 `event:<windowId>`。
- `●` 正在运行，`○` 空闲；特殊事件处理完保留最近 12 个可回看。
- 下面同样是摘要 + 完整对话。

**对话**
- 人 ⇄ 主会话。左侧 `id`（例如 `player`），右侧输入，回车发送。
- 主会话的回复会出现在这里；外部程序也能收发（见第 7 节）。

**动作**
- 左侧列出 58 个动作（参数、必填项、描述）；选中后右侧自动填模板。
- 右侧是 JSON 数组，点「执行」直接进执行器（串行、读回、失败重试）。

**读取与事件**
- 全量读取、已激活事件链（含后续树）、可控单位、模组清单、执行器状态。

**调度**
- 启动/停止/重启调度、暂停/恢复游戏、查看完整状态。
- 「停止」后有 5 分钟冷静期，不会被自动拉起。

**人格**
- 顶部：预设下拉 + 「应用预设」、导入组件文件 / 粘贴导入、保存并应用、预览提示词。
- 左侧：**10 条滑动条**（侵略性 / 大胆 / 谨慎 / 荣誉 / 外交 / 扩张 / 经济 / 科研 / 军事 / 共情），0-100，直接写进主会话人格提示词。
- 右侧：名字、头衔、身份、来路、在意的事、小毛病、说话风格、嗓音、单句字数、示例句子；voice 开关 / 每 N 轮 / 最短间隔。
- 人格组件：支持 Character Card V2、普通 JSON、Markdown、纯文本；导入后保留原文，可多份叠加、可移除。
- 「保存并应用」会立刻重建主会话 system prompt，不用重启调度。

**设置**
- 见第 6 节。

---

## 4. 标准工作流

```
启动游戏 → 读档
   ↓
启动程序（自动注入桥、自动启动调度）
   ↓
主会话读全量状态 → 判断 → 派发单位子会话
   ↓
子会话出动作 → 执行器执行（读回校验、失败重试）
   ↓
子会话回报 → 主会话复盘 → 下一轮
   ↓
你随时可以在「对话」里插话，或在「子会话」里看细节
```

调度节奏：

- 主会话每 `ai.main.intervalSeconds`（默认 120 秒）醒一次；
- 有事件/聊天/子会话回报会提前唤醒；
- 世界状态每 `read.refreshSeconds`（默认 20 秒）轻量刷新，定期全量刷新；
- 事件弹窗、选举/换届、外交请求、战争、警报会拉起**特殊事件子会话**优先处理。

---

## 5. 一次注入，之后自动

- 后端启动后每 `bridge.watchSeconds`（默认 15 秒）检查一次，启动瞬间也检查；
- 游戏在跑但桥没注入 → 自动注入；
- 已进局 → 自动启动调度；
- 游戏重启 → 自动重新注入；
- 程序重启 → 管道还在就直接复用；
- 手动「停止」→ 5 分钟内不自动拉起。

设置页两个开关：

- `游戏在跑时自动注入原生桥`
- `进局后自动启动调度器`

---

## 6. 设置页

| 区域 | 说明 |
| --- | --- |
| 群星安装目录 | 留空自动探测；装在别的盘用「浏览」 |
| 群星用户目录 | 存档/模组/日志所在；留空自动探测 |
| 存档目录 | 留空 = 用户目录下 `save games` |
| 思考后端 | `deepseek` / `dsh` |
| DeepSeek Key | 留空 = 保持已保存的 Key |
| 测试大模型连接 | 真发一次 1 token 请求，验证 Key/DSH 是否真能用 |
| DSH 地址 | 默认固定 `http://127.0.0.1:49939`，可「自动检测」 |
| 动作数 > X 暂停 | 待执行动作达到 X 时先暂停游戏 |
| Y 次重试 | 单动作失败重试次数 |
| 主会话间隔(秒) | 自动决策间隔 |
| 看护间隔(秒) | 自动注入/自动接管检查间隔 |
| 自动连接 | 两个开关 |
| DSH 插件 | 安装/更新、热重载、重启 DSH（危险，需确认） |
| 保存设置 | 保存后运行中的调度会自动重启 |

---

## 7. 人机聊天（GUI 或外部程序）

GUI 直接用「对话」页。外部程序（直播、脚本、别的 UI）：

```powershell
# 人说话：id + 内容
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/chat/in `
  -ContentType 'application/json; charset=utf-8' `
  -Body '{"id":"player:heyik","text":"合金太低了，想办法提上去"}'

# 主会话说的话（since 是游标）
Invoke-RestMethod 'http://127.0.0.1:8787/api/chat/poll?since=0'

# 外部代发一条出站消息
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/chat/out `
  -ContentType 'application/json; charset=utf-8' -Body '{"text":"收到","id":"obs"}'

# SSE 实时流
curl.exe -N http://127.0.0.1:8787/api/chat/stream
```

出站消息带 `id`：`main`（主会话）、`system`（系统提示）、`unit`（子会话上报）。

### 主会话的「人话」输出（voice）

主会话每轮（或按设置的「每 N 轮」）会输出一句 `voice`：此刻的用意、看法、判断、情绪，
**不是** JSON/参数/报告。它同时出现在：

- 聊天出站：`GET /api/chat/poll` / SSE，`kind = "voice"`；
- 专门的语音接口：

```powershell
# 最近一句
Invoke-RestMethod http://127.0.0.1:8787/api/voice/latest

# 轮询（since 用上次的 id）
$v = Invoke-RestMethod 'http://127.0.0.1:8787/api/voice?since='
$v.voices | ForEach-Object { $_.text }
```

返回示例：

```json
{
  "id": "v-1793375259718-1",
  "text": "他们以为我们不敢动手，那就让他们继续以为。",
  "mood": "冷静",
  "intent": "试探并推进科研",
  "turn": 3,
  "actions": ["research"]
}
```

外部 TTS/直播只要读 `text`（可选 `mood` 选音色）。文件落在
`%USERPROFILE%\.stellaris-agent\voice\`（按天 JSONL + `latest.json`）。

控制频率：人格页「启用“人话”」、每 N 轮、最短间隔（秒）；直接对话 `ask` 会强制说一句。

### 直接问主会话（同步接口）

`/api/chat/in` 是"留言，等下一轮"；想立刻拿到主会话的回答，用 `/api/main/ask`：

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/main/ask `
  -ContentType 'application/json; charset=utf-8' `
  -Body '{"id":"player:heyik","text":"现在该做什么？"}'
```

返回：

```json
{
  "ok": true,
  "say": "先把物理研究切到激光，同时补合金。",
  "spawned": ["research"],
  "paused": false,
  "resumed": false,
  "ms": 4200
}
```

- `say` 会同时出现在 GUI 的「对话」页；
- `spawned` 里的单位会真正派发执行；
- 正在跑定时决策时最多等 30 秒，超时返回 `BUSY`；
- 命令行等价写法：

```powershell
.\run.cmd ask "现在该做什么？"
```

查看主会话状态（不触发模型）：

```powershell
Invoke-RestMethod http://127.0.0.1:8787/api/main
```

---

## 8. 动作与执行器

### GUI

「动作」页选一个动作 → 编辑 JSON → 执行。例如：

```json
[
  { "method": "set_speed", "params": { "speed": 2 } },
  { "method": "focus_planet", "params": { "planet_id": 3 } }
]
```

### 命令行

```powershell
.\run.cmd execute '[{"method":"set_speed","params":{"speed":2}}]'
.\run.cmd actions --unit planet
```

### 规则

- 所有写操作只走执行器：严格串行、逐项读回、失败重试；
- 待执行动作数 ≥ X 时先暂停游戏，排空后自动恢复；
- 单动作最多 Y 次；仍失败则任务在该步终止，后续动作标记 `skipped`；
- 动作表里标 `*` 的参数是推断值，首次失败会回报给子会话改参重试。

### 失败原因自动导出

子会话最终失败（重试用完仍 `blocked`，或运行异常 `error`）时，会**自动**在
`%USERPROFILE%\.stellaris-agent\failures\` 下生成：

```
20261030-232556-090-research-blocked.json   完整现场
20261030-232556-090-research-blocked.md     人读版
latest.json / latest.md                     最近一次
```

内容包括：单位/目标/状态/尝试次数、模型给出的原因/建议/证据、执行器每一步的错误码与逐次尝试、
读回结果、该会话最近对话、可选的世界摘要。

查看方式：

- GUI「子会话」页右上角「失败报告」按钮，直接打开 failures 目录；摘要里也会显示本次报告路径；
- `GET /api/failures`、`GET /api/failures/<id>`、`GET /api/failures/<id>/markdown`；
- 命令行：

```powershell
.\run.cmd failures                 # 最近 20 份
.\run.cmd failure latest           # 最近一份 JSON
.\run.cmd failure latest --markdown
```

配置项（`config.json`）：

```json
{ "failures": { "dir": "", "maxFiles": 200, "includeTranscript": true, "includeWorld": false } }
```

`maxFiles` 会按时间自动清理旧报告；`includeWorld` 默认关闭以控制体积。

---

## 9. 命令行速查

```powershell
.\run.cmd status                 # 路径 / 桥 / 后端 / 插件
.\run.cmd doctor                 # 自检：游戏/桥/DSH/Key/存档
.\run.cmd read [--quick]         # 全量读取（不需要 Key，不写游戏）
.\run.cmd actions [--unit planet] [--json]
.\run.cmd units                  # 可控单位
.\run.cmd events active          # 已激活事件链 + 后续
.\run.cmd events index           # 重建事件索引（原版+DLC+模组）
.\run.cmd events search <关键词>
.\run.cmd events chain <event_id>
.\run.cmd mods                   # 模组 / DLC
.\run.cmd connect [--start] [--watch]
.\run.cmd sessions               # 会话列表
.\run.cmd session main           # 某个会话的完整对话
.\run.cmd failures               # 最近失败的子会话报告
.\run.cmd failure latest         # 看一份失败报告（--markdown 看人读版）
.\run.cmd persona                # 查看人格/属性/组件
.\run.cmd persona preset conqueror
.\run.cmd persona import .\ash-card.json
.\run.cmd voice --limit 10       # 主会话最近说的“人话”
.\run.cmd execute '<json>'
.\run.cmd call get_status        # 原始 RPC（排障）
.\run.cmd pause | resume
.\run.cmd serve --port 8787 [--start]
.\run.cmd run [--once] [--objective "先扩军"]
.\run.cmd plugin install|update|reload|status
.\run.cmd dsh-discover
.\run.cmd selftest [--online]
```

---

## 10. 文件与日志

| 内容 | 路径 |
| --- | --- |
| 配置 | `%USERPROFILE%\.stellaris-agent\config.json` |
| 运行日志 | `%USERPROFILE%\.stellaris-agent\logs\agent.log` |
| 后端 stdout/err | 同目录 `backend.out.log` / `backend.err.log` |
| 事件索引缓存 | 同目录 `event-index.json` |
| DSH 端口缓存 | 同目录 `dsh-url.json` |
| 决策/上报日志 | 同目录 `journal\YYYY-MM-DD.jsonl` |
| 失败报告 | 同目录 `failures\*.json` / `*.md`（`latest.md` 最近一份） |
| 主会话人话 | 同目录 `voice\YYYY-MM-DD.jsonl` / `latest.json` |
| 诊断包 | 设置页「导出诊断」→ `diagnostics-*.json` |

---

## 11. DSH 插件（固定端口）

- 插件版本 **v2.1**，固定监听 `127.0.0.1:49939`（可用 `STELLARIS_BRIDGE_PORT` 覆盖）；
- 同时保留 DSH Web 路由做兼容，旧配置也能用；
- 程序启动时会自动安装/更新插件并尝试热重载；
- **只有插件壳 `index.js` 变了才需要重启 DSH**，改 `lib/handler.mjs` 用 `.\run.cmd plugin reload` 热更新即可；
- 端口被别的程序占用时：插件记录错误并退回 DSH 路由，不会让 DSH 起不来。

验证：

```powershell
Invoke-RestMethod http://127.0.0.1:49939/api/stellaris-orchestrator/health
# 期望：ok=True, version=2.1.0, port=49939, portFixed=True

.\run.cmd dsh-discover
# 期望：{"ok":true,"url":"http://127.0.0.1:49939",...}
```

---

## 12. 常见问题

| 现象 | 处理 |
| --- | --- |
| `游戏: 未连接 — 游戏未运行` | 启动游戏；确认程序与游戏权限一致（别一个管理员一个普通） |
| `游戏在运行，桥未注入` | 等 15 秒自动注入，或点「连接 / 重连」；确认游戏是 4.5.x、杀软没拦 |
| 注入失败 | 程序与游戏同权限；确认 `agent/native/stellaris_bridge.dll` 存在；游戏大版本更新需换 DLL |
| `大模型: 未连接 — 未配置 API Key` | 设置页填 Key，或后端改 `dsh` |
| `DSH 未连接` | 启动 DSH；设置页「安装/更新插件」+「重载 DSH」；壳变了需重启 DSH 一次 |
| 调度一直「未启动」 | 游戏在主菜单不会自动启动，读档即可；或去「调度」页手动启动 |
| 动作一直失败 | 看「子会话」页的失败原因/建议；`inferred` 参数可能要按你的 DLL 调 |
| 端口 8787 被占 | 设置页改 `chat.port`，或关掉旧的 `node serve` |
| 想倒查它干了什么 | 「主会话」「子会话」+ `journal` + `logs/agent.log` |
| 设置保存失败 | 确认 `%USERPROFILE%\.stellaris-agent\config.json` 可写（不要放在只读目录/被占用） |

---

## 13. 暂停、停止与退出

- **暂停游戏**：调度页「暂停游戏」；执行器在动作数超阈值时也会自动暂停。
- **停止调度**：调度页「停止」——停止后 5 分钟内不会被自动拉起。
- **退出程序**：直接关窗口；后端会一起结束，并把游戏恢复（如果暂停是执行器发起的）。
- **只停后端**：`serve` 模式 `Ctrl+C`；GUI 模式关窗口。

---

## 14. 边界

- 仅 Windows；原生 DLL 与游戏版本绑定（当前 4.5.2 / 9776）；
- 原生桥是单连接，程序内部已串行，**不要再开第二个客户端**；
- 铁人档只读，程序会在状态里标出；
- 动作表里 `inferred` 参数需要在真机确认，失败会走「回报 → 分析 → 主会话决策」；
- 模型质量决定判断好坏；程序只保证协议、边界与失败可见。
