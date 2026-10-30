# 群星参谋 · 独立版（stellaris-agent）

> 不需要 DSH、不需要 Electron。一个 Node 进程 + 一个终端（或一个本地面板）就够：
> 自己读群星存档与日志 → 调 DeepSeek API 思考 → 把决定写回游戏 → 每局记账。

它是第三个部件的**独立软件形态**：和 DSH 插件共用同一套引擎（读档、编译、注入、时间线、设计、日志），
只是前端从「DSH 工具」换成了「CLI + 本地面板 + 自己的多会话编排」。

```
群星 4.5 ──logs/save──► 引擎（03 的 lib）──► 简报/时间线/全量数据
                              ▲                        │
                              │ effect + ACK            ▼
                         注入/回执 ◄──── 编排器 ◄── DeepSeek API
                                              ├─ 主会话（判断/复盘）
                                              ├─ 操作员会话（具体执行）
                                              └─ 每局日志 / 直播弹幕
```

## 桌面版（图形界面，不是网页）

```powershell
.\run-gui.cmd
```

原生 WinForms 窗口，三个页签：

- **战局**：5 秒自动刷新状态与简报；
- **对话**：直接和 DeepSeek 对话（默认只读）；
- **操作**：把动作写入「游戏内自动执行队列」。

数据是实时自动检测的：日志 tail + 存档目录 watch，读档/存档后不用手动 scan。

## 快速开始

```powershell
# 1) 配 key（第一次运行会自动生成配置）
#    编辑 %USERPROFILE%\.stellaris-agent\config.json
#    "deepseek": { "apiKey": "sk-..." }

# 2) 看连接（不需要 key，也不会联网）
.\run.cmd status
.\run.cmd selftest

# 3) 看战局
.\run.cmd brief
.\run.cmd scan            # 解析最新存档，全量数据

# 4) 让它思考并执行
.\run.cmd ask "合金太低了，想办法提到月产 300"
.\run.cmd ask "先别动手，评估一下现在该打谁" --read-only

# 5) 交互式
.\run.cmd chat

# 6) 本地面板 + 直播接口
.\run.cmd serve            # http://127.0.0.1:8787
```

`run.cmd` 会依次找：环境变量 `STELLARIS_AGENT_NODE` → PATH 里的 `node` → DSH 自带的 node。
也可以用 `node bin/stellaris-agent.mjs ...` 直接跑。

## 命令

| 命令 | 作用 | 要 key |
| --- | --- | --- |
| `status` | 用户目录/安装目录/模组/快照/通道/日志 | 否 |
| `brief` | 战局简报（含最近事件） | 否 |
| `refresh [--wait]` | 让阅读模组立刻导出（等价控制台 event dsh_reader.9） | 否 |
| `scan [--force]` | 解析 `.sav`，拿全量数据 | 否 |
| `setup` | 创建阶段：自定义帝国设计 + 安装目录 + 存档开局设置 | 否 |
| `designs [名字]` | 读创建界面里保存的帝国 | 否 |
| `events <id> --depth 2` | 事件后续（本地游戏文件） | 否 |
| `journal [--limit]` | 这一局的日志 | 否 |
| `ask "目标"` | 跑一轮：看→想→做→记账 | **是** |
| `chat` | 交互式，同一会话连续对话 | **是** |
| `serve [--port]` | 本地面板 + 直播 ingest/poll/reply/SSE | **是** |
| `validate [--game-dir]` | 对 4.5 校验两个模组 | 否 |
| `selftest [--online]` | 自检；`--online` 会真调一次 API | 否/是 |

参数：`--read-only`（只读）、`--no-tools`（不用 function calling，走 ```stellaris 块）、
`--steps N`、`--model`、`--offline`（绝不联网）。

## 它怎么思考

0. **动作表**：`list_actions` 列出 54 个动词（作用域/参数/等级），模型先看再动手。
   创建阶段还可以用 `read_designs` / `clone_design` / `create_design` 直接读写自定义帝国文件。
1. **工具调用**（`deepseek-chat`）：模型可以调 `get_brief`、`query_state`、`save_scan`、
   `timeline`、`event_info`、`apply_actions`、`open_ui`、`journal_write`、`delegate`、`chat_poll/say`、`finish`。
2. **动作块回退**：模型也可以直接在回复里写 ```stellaris 块，编排器解析后执行。
3. **操作员子会话**：`delegate` 会把具体执行丢给另一个独立上下文（`SessionPool` 里的 `operator`），
   主会话只收摘要——和 DSH 版「操作代理」是同一个思路，这里完全在进程内。
4. **每局日志**：`~/.stellaris-agent/journal/<gameId>.jsonl|md`，自动记操作/转发，模型可主动写判断。

## 安全

- 默认 `safety.allowExperimental=false`：没有验证过的 effect 不发。
- `--read-only`：模型能看到 `apply_actions`，但调用会被拒绝。
- 铁人档只读（读存档 meta 判断）。
- 写操作只走两条路：控制台 `run`（键盘注入）或 `manual` 模式给你手打；**没有鼠标点击**。
- HTTP 只绑 `127.0.0.1`；配了 token 就要求 Bearer。
- **不要和 DSH 插件同时运行**：两边会抢同一个控制台。用哪个就关掉另一个。

## 和 DSH 插件的关系

| | DSH 插件（03） | 独立版（04） |
| --- | --- | --- |
| 引擎 | 同一套 `lib/` | 复用 03 的 `lib/`（相对路径） |
| 前端 | DSH 工具 | CLI + 本地面板 |
| 模型 | DSH 会话的模型 | 直接调 DeepSeek API |
| 多会话 | DSH 子会话 + lane | 进程内 `SessionPool`（main/operator） |
| 依赖 | DSH 桌面版 | 只要 Node 22+ |

## 测试

```powershell
node --test test/*.test.mjs
```

覆盖：DeepSeek 请求形状/重试/流式/工具调用、编排循环/只读/委托/会话压缩、面板接口与鉴权。

## 边界（和 DSH 版一致，不重复包装）

- 创建帝国界面是游戏开始前的 GUI：没有脚本钩子，也没有控制台。只能读/写设计文件 + 开局后改政体。
- 事件链的「后续」来自本地 `events/*.txt` 的静态引用图；实际分支由触发器决定。
- 铁人档不能写；群星没有给外部进程留别的入口。
