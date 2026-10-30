# 验证矩阵 · 哪些确定、哪些要你在游戏里点一下

> 4.5 的专项静态校验与实测流程见 [`validation-4.5.md`](validation-4.5.md)。

写这个工程时，本机**没有装群星**（`Documents\Paradox Interactive\Stellaris` 不存在，Steam 库也没有 Stellaris）。所以下面的分级是**按证据强度**分的，不是拍脑袋：

- **A 级**：官方 wiki / 官方脚本文档 / 大量模组共同使用，可以当事实；
- **B 级**：社区惯例，版本间稳定，但 4.5 我不能现场跑；
- **C 级**：名字或语义我拿不准，默认**不给你发**，必须显式放行。

> 结论先说：**读取一定可用**（日志 + 存档两条腿，任何一条活着都能用）；**写操作里 core 那批风险很低**；**experimental 那批请在测试档里先点一遍**，别首发就上铁人。

---

## 1. 已确认为事实（A 级）

| 事实 | 证据 | 用在哪 |
| --- | --- | --- |
| 控制台有 `run <file>`，执行一个命令文件 | 群星 wiki·Console commands（`run — Runs the specified file with list of commands`） | 桥的命令注入 |
| `effect = { ... }` 可在控制台执行任意 effect | 同上 | 所有写操作 |
| 存在 `add_building`（星球作用域） | 3.10.4 官方 `game_effects` 导出文档 | `add_building` |
| 存在 `add_resource`（国家作用域，支持 `mult`） | 同上 + 官方变量指南 | `resource` |
| 存在 `add_tradition`、`give_technology`、`add_modifier`、`add_trust`、`end_rivalry`、`set_truce`、`ruin_building`、`set_owner` | 同上 | 对应动作 |
| 存在 `every_owned_planet` / `every_owned_leader` / `every_owned_fleet` / `every_country` 迭代 | 同上 | 导出与寻址 |
| 存在 `export_resource_stockpile_to_variable` / `export_resource_income_to_variable` / `export_trigger_value_to_variable` | 官方《THE GRAND VARIABLES GUIDE》 | 导出数值 |
| 变量可在本地化里用 `[This.my_variable]` 打印 | 同上 | 导出的数值来源 |
| `interface/*.gui` 元素支持 `shortcut`（绑定热键） | 群星 wiki·Interface modding | 模组 B 的面板热键 |
| 模组目录约定：`mod/<id>/` + `mod/<id>.mod` + 内部 `descriptor.mod` | 官方 wiki·Modding | 安装脚本 |

---

## 2. 我按惯例使用、但 4.5 未现场验证（B 级）

| 项 | 风险 | 万一不对会怎样 | 怎么自查 |
| --- | --- | --- | --- |
| `log = "..."` 写进 `logs/game.log` | 低。大量模组用它调试 | 日志里没有 `DSH1` 行 | 开局后看 `logs/game.log` 有没有 `DSH1` |
| `log` 会**求值**本地化命令（`[This.GetName]`、`[This.dsh_tmp]`） | **中**。这是数值能否走日志通道的关键 | 日志里出现原样的 `[This.dsh_tmp]` | 桥会自动检测：`stellaris_brief` 返回 `logLocalisation: false` 时，自动改用存档通道 |
| `every_owned_planet` 的迭代顺序在「导出」与「执行」两次调用间一致 | 中 | 按 `ord` 寻址可能打到隔壁星球 | 用 `capital` 或 `force: false` 的保护；测试档里先跑 `note` 动作核对 |
| `ordered_*` 的默认顺序与 `every_owned_*` 一致 | 中 | 按 `ord` 寻址可能打到隔壁星球 | 先 `note` 验证；错位就用 `capital`/名字 |
| 存档是 zip，内含 `gamestate` 文本 | 低 | 存档解析失败 | `stellaris_save_scan` 会打印 zip 条目 |
| `country_event = { id = ... }` 可在 effect 里触发事件 | 低 | 面板弹不出来 | 模组 B 的事件 id 都是 `dsh_console.*`，`error.log` 会指名 |
| 存档里的 `ironman=yes` 可作为只读判据 | 低 | 误判 | `stellaris_status` 会同时看控制台 ACK 是否一直失败 |

---

## 3. 需要你确认或校准（C 级，默认拒绝执行）

| 动作 | 我用的 effect | 不确定点 | 校准方法 |
| --- | --- | --- | --- |
| `add_district` | `add_district = <key>` | 4.x 区划 effect 名可能变（`add_district` / `add_district_slot`） | 测试档 `stellaris_apply` 单发一条，看 `error.log` |
| `add_perk` | `add_ascension_perk = <key>` | 可能要求 `add_ascension_perk` 或 `give_ascension_perk` | 同上 |
| `add_relic` | `add_relic = <key>` | 遗珍 effect 名不确定 | 同上 |
| `add_edict` / `remove_edict` | `activate_edict` / `deactivate_edict` | 4.x 法令系统重做过（`add_edict`？） | 同上 |
| `set_policy` | `set_policy = { policy = <p> option = <o> }` | 可能叫 `set_policy_option` | 同上 |
| `set_designation` | `set_planet_designation = <key>` | 可能叫 `set_designation` | 同上 |
| `leader_trait` | `add_trait = <key>`（领袖作用域） | 领袖特质 effect 可能叫 `add_leader_trait` | 同上 |
| `fleet_stance` | `set_fleet_stance = <s>` | 值域 `aggressive/passive/evasive` | 同上 |
| `send_fleet` | `auto_move_to_planet = { target = <p> }` | 需要 fleet 作用域，寻址未实现 | 同上 |
| `open_ui`（`uiMode=effect`） | `open_view = <v>` | **该效果是否存在我没找到硬证据**；默认走热键 | 默认 `hotkey`，别开 `effect` |
| `raw_effect` | 原样拼接 | 由你负责 | 只在 `allowExperimental` 下 |

**默认行为**：`safety.allowExperimental = false`。上表动作会返回 `EXP_ACTION` 并附上「要么改配置、要么先校准」的说明，而不是静默失败。

---

## 4. 三分钟自检流程（建议第一次都跑）

```text
1. stellaris_selftest
   → 检查用户目录、日志偏移、模组文件、窗口、配置文件；不改档。

2. 进游戏，开测试档（别用铁人），读到出现「DSH」按钮。
   等一个月（让 on_monthly_pulse 跑一次）。

3. stellaris_status
   → snapshot.ageSec 应该在 60 秒内；mods.reader = true。

4. stellaris_refresh { "force_log": true }
   → 让模组 A 立刻导出；返回 logLocalisation 字段。

5. stellaris_brief
   → 看是否读到了你的帝国名、资源、星球列表。

6. stellaris_apply { "dry_run": true, "actions": [ { "note": { "text": "hello" } } ] }
   → 看编译出来的 effect 长什么样。

7. stellaris_apply { "actions": [ { "resource": { "key": "alloys", "amount": 100 } } ] }
   → 游戏里合金 +100，工具返回 ack.done = true。

8. 若第 4 步 logLocalisation = false：
   说明日志里的数值没被本地化求值 —— 不是 bug，是版本行为。
   读数据改用存档通道（stellaris_save_scan），写操作完全不受影响。
```

---

## 5. 我明确**没有**做的事

- 没有写「自动玩」的循环：桥只提供「读 → 建议 → 执行 → 回执」的原子能力，什么时候调用由模型/你决定。
- 没有绕开控制台：群星没有给模组留任何「外部进程改内存」的正路，唯一正路就是 `run` / `effect`。任何声称不用控制台就能写档的方案，要么改内存（会被反作弊/成就判死），要么在骗你。
- 没有伪造 UI 点击：只发键盘事件；改档靠 effect，不靠点按钮。
- 没有内置科技/建筑/传统的**全量表**：这些会随 DLC 变，硬编码必然过期。全量列表从你的存档里读，所以永远和你装的 DLC 一致。
---

## 6. v0.2 新增项的分级

| 项 | 级别 | 依据 / 风险 | 怎么验 |
| --- | --- | --- | --- |
| on_colony_established 钩子 | B | 社区常用、作用域是 planet；4.5 未现场跑 | 建一块殖民地，logs/game.log 应出现 EVENT|kind=colony_established |
| 日志里的 EVENT/CHAIN 行 | B | 依赖 log 与本地化求值；不求值时 
ode 是占位符 | stellaris_timeline 看节点 
ode 是不是星球名 |
| 存档里的 situation / event_chain | B- | 4.x schema 可能换了键名；mapper 读不到会 warnings | stellaris_save_scan 看 situations/chains 是否非空 |
| 快照差分重建事件 | A | 纯桥侧逻辑，不依赖游戏 | stellaris_timeline 里 source=diff 的节点 |
| lane 命名空间 / 全局锁 | A | 纯桥侧逻辑 | 两个会话同时 apply，看 cmd 是不是 l1-… / l2-… |
| dsh_console.40..47 面板 | A | 只是事件窗口 + 静态本地化 | 控制台 event dsh_console.40 |
| stellaris_dispatch | B | 依赖 DSH gents 服务与 ollowup 语义（与 wechat-wake 同一套路） | 绑一条 lane，派一个 
ote 目标，看子会话是否回话并被代执行 |

### 仍然抓不到的东西（不伪装）

- 原版事件里的**分支选择**与**对话文本**：引擎内部状态，脚本与存档都没有可读字段；
- 未挂钩子的 on_action 点（战争爆发、科技完成…）：只能靠存档差分，**时间精度是「月」**；
- 铁人档：只能读。

这些都会出现在 stellaris_chain 的 gaps 里，而不是被悄悄忽略。

---

## 7. v0.3 新增项的分级

| 项 | 级别 | 依据 / 风险 | 怎么验 |
| --- | --- | --- | --- |
| `force_add_civic` / `force_remove_civic` / `set_origin` | A | 3.10.4 官方 effects 导出里有这三个 | 测试档单发一条，看 `error.log` |
| 读 `user_empire_designs_v3.txt` | B | 4.5 的键名可能微调；读不到会返回空列表而不是崩 | `stellaris_setup` 看 designs.count |
| 写设计文件（克隆） | C | 格式细节随版本变；只用克隆+备份+自检，默认 dry-run | 先 dry-run 看 preview，再 confirm 写，进创建界面确认能选 |
| 事件定义索引 | B | 块扫描不依赖完整语法；DLC 目录结构可能不同 | `stellaris_event_info` 查一个你知道的事件 id |
| 事件后继 | B | 是「文件里出现过的引用集合」，不是唯一路径 | 对照实际走一遍事件链 |
| 每局日志 / gameId | A | 纯桥侧逻辑 | 换一个帝国读档，看 journal 是否开新文件 |
| operator 转发 | B | 依赖 agents 服务与子会话：followup 的行为与 wechat-wake 同一套路 | 绑一个子会话，`auto_delegate` 后跑一条 note 动作 |

---

## 8. v0.4 独立软件

| 项 | 级别 | 说明 |
| --- | --- | --- |
| DeepSeek 客户端（请求/重试/流式/工具） | A（对 mock 测过） | 真实 API 行为需你 `selftest --online` 确认 |
| 编排循环 / 只读 / delegate / 会话压缩 | A（单测覆盖） | 纯进程内逻辑 |
| 本地面板与直播接口 | A（单测覆盖） | 只绑回环；token 可选 |
| 打包后的 dist 运行 | B | 已在本机跑通 `status`；换机器需 Node 22+ |
| 独立版写游戏 | 同 03 | 仍然走 effect + ACK；铁人只读 |

---

## 9. v0.5 动作层扩容

- 动作从 25 个扩到 **54 个**（core 26 / exp 27 / raw 1），见 [`actions.md`](actions.md)。
- 新增的 effect 名按「官方 effects 导出里出现过」优先；没见过的（区划、飞升、遗珍、法令、政策、舰队删除、建站等）全部标 `exp`，默认不发。
- 新增了**矩阵测试**：每个动词用自带 sample 走完「校验 + 编译」，任何一条缺参数/生成非法脚本都会让测试挂。
- 仍然不做：舰船设计器、外交谈判条款、联邦投票、市场订单、贸易路线、事件选项点击——这些是 UI/规则流程，没有稳定 effect 入口。

---

## 10. v0.6 创建阶段（真实格式）

| 项 | 级别 | 说明 |
| --- | --- | --- |
| 读取 `user_empire_designs_v3*.txt` | A- | 已按真实 v3.4 样本（顶层 `"Name"={...}`、`name={key=...}`、`civics={ "a" "b" }`）实现并测过 |
| 克隆 / 从零创建设计 | B | 结构按真实样本生成，写前 dry-run、写时备份、写后读回自检；**仍需你在创建界面确认能选** |
| 开局后改政体（force_add_civic 等） | A | 与之前一致 |
