# 协议契约 · DSH ⇄ Stellaris v1

> 本文件是三个部件的**唯一契约**。改协议先改这里，再改代码。
> 版本号出现在每条记录里（`DSH1`），不兼容变更必须升到 `DSH2`。

---

## 0. 两个方向、四种通道

| 通道 | 方向 | 载体 | 用途 |
| --- | --- | --- | --- |
| L | 游戏 → 桥 | `logs/game.log` 里的 DSH1 行 | 实时快照、ACK、脚本错误 |
| S | 游戏 → 桥 | `save games/*.sav`（zip 内 `gamestate`） | 全量归档（科技/传统/飞升/建筑…） |
| C | 桥 → 游戏 | `<用户目录>/dsh_q_<id>.txt` + 控制台 `run` | 动作执行 |
| H | 外部 → 桥 | HTTP `/api/dsh-stellaris/*` | 直播弹幕、面板状态 |

> 独立软件（`04-stellaris-agent`）是 L/S/C/H 四个通道的另一个消费端，协议完全不变；它只是把「谁在调模型」从 DSH 换成了自己。

L、S 只读；C 会改档；H 只在回环地址上开。

---

## 1. 通道 L：日志上行

### 1.1 行格式

```
DSH1|<seq>|<KIND>|<key>=<value>|<key>=<value>|...
```

- `DSH1` 是魔数。桥只认 `DSH1|` 之后的字节，日志前缀（`[HH:MM:SS][...]`）一律忽略。
- `seq`：游戏侧序号。阅读模组的全量导出**统一填 0**（一批记录本来就有序），桥按文件顺序处理；留给将来增量通道用（那时必须递增）。
- `KIND`：见 1.2。
- 值里不允许出现 `|`。模组侧应避免把带 `|` 的字符串塞进值；桥解析时把**第一个** `|` 之后按 `|` 切，键值只切**第一个** `=`（所以值里可以有 `=`）。
- 编码：UTF-8，无 BOM。中文名允许出现。

### 1.2 记录类型

| KIND | 粒度 | 关键字段 | 说明 |
| --- | --- | --- | --- |
| `BEGIN` | 每次导出 1 条 | `snap`, `date`, `version`, `mode` | `mode=delta` 表示增量 |
| `END` | 每次导出 1 条 | `snap`, `count`, `ms` | `count` = 本次记录数 |
| `META` | 1 条 | `date`, `ironman`, `dlcs` | `ironman=1` 时桥拒绝写操作 |
| `EMPIRE` | 1 条 | `name`, `authority`, `government`, `civics`(逗号分隔), `ethics`, `ruler`, `capital`, `empire_id` | |
| `RESOURCE` | 每种 1 条 | `key`, `stock`, `income` | `key ∈ energy/minerals/food/alloys/consumer_goods/unity/influence/...` |
| `EDICT` | 每条 1 条 | `key`, `active` | 帝国法令 |
| `LAW` | 每条 1 条 | `key`, `option` | 政策（法律） |
| `MODIFIER` | 每条 1 条 | `key`, `scope`, `days_left`, `stacks` | 国家/星球修正 |
| `PLANET` | 每颗殖民地 1 条 | `ord`, `name`, `class`, `size`, `designation`, `pops`, `stability`, `crime`, `housing`, `amenities`, `owner`, `sector`, `governor`, `megastructure` | `ord` 由桥按记录出现顺序分配（= `every_owned_planet` 迭代序的 **0 基序号**），**动作寻址靠它** |
| `BUILDING` | 每座 1 条 | `planet_ord`, `key`, `slot`, `ruined` | |
| `DISTRICT` | 每类 1 条 | `planet_ord`, `key`, `built`, `max` | |
| `LEADER` | 每位 1 条 | `id`, `name`, `class`, `level`, `traits`, `assignment`, `planet_ord` | `assignment` 可为 `governor/admiral/general/scientist/none` |
| `TECH` | 已研究每项 1 条 | `key`, `tier`, `area` | 全量科技只有存档通道有；日志通道给汇总 |
| `TECH_POOL` | 1 条 | `current`, `alternatives`, `progress` | 当前研究 |
| `TRADITION` | 每项 1 条 | `tree`, `key` | |
| `PERK` | 每项 1 条 | `key`, `tier` | 飞升 |
| `RELIC` | 每件 1 条 | `key`, `active` | 遗珍 |
| `FLEET` | 每支 1 条 | `id`, `name`, `ships`, `strength`, `location`, `stance`, `order` | |
| `DIPLO` | 每国 1 条 | `country`, `opinion`, `trust`, `attitude`, `treaties` | |
| `TREATY` | 每份 1 条 | `with`, `type`, `since` | |
| `WAR` | 每场 1 条 | `name`, `enemies`, `allies`, `warscore`, `goal` | |
| `SITUATION` | 每个 1 条 | `key`, `progress`, `stage` | 局势/危机 |
| `EVENT` | 每个叙事节拍 1 条 | `kind`, `chain`, `node`, `date`, `source`, `actor?`, `target?` | 事件链节点（实时钩子/差分） |
| `CHAIN` | 每个链节点 1 条 | `chain`, `node`, `parent`, `status`, `source` | 链结构，桥据此挂 parent |
| `FLAG` | 每面 1 条 | `key`, `date` | 存档里的国家旗标（链进度标记） |
| `VARIABLE` | 每个 1 条 | `key`, `value` | 存档里的国家变量（数值） |
| `ACK` | 每条命令 2~3 条 | `cmd`, `phase`(`recv`/`done`/`fail`), `ts` | 见 3.3 |
| `ERROR` | 可选 | `cmd`, `code`, `detail` | 模组 B 主动报错 |
| `NOTE` | 可选 | `text` | 自由文本（调试） |

> 字段只增不改。新字段一律追加在行尾，老桥忽略未知键。

### 1.3 示例

```
[21:04:11][effect.cpp:812]: DSH1|1|BEGIN|snap=20261029T210411|date=2201.03.11|version=4.5.0|mode=full
[21:04:11][effect.cpp:812]: DSH1|2|RESOURCE|key=alloys|stock=1832|income=94.5
[21:04:11][effect.cpp:812]: DSH1|3|PLANET|ord=0|name=地球|class=pc_continental|size=18|designation=col_capital|pops=42|stability=78|crime=3
[21:04:11][effect.cpp:812]: DSH1|9|END|snap=20261029T210411|count=7|ms=41
```

### 1.4 桥的容错

- `seq` 在阅读模组的全量导出里恒为 0；桥按文件顺序处理，不依赖它。
- `PLANET` 记录不写 `ord`，桥按出现顺序从 0 编号（与 `every_owned_planet` 迭代序一致）。
- 没收到 `END` 的快照标记为 `partial`，可用但会在 `stellaris_status` 里提示。
- 日志轮转：桥按 inode/大小变化重置偏移；只向后读，不重读历史。

---

## 2. 通道 S：存档归档

桥直接读取 `<用户目录>/save games/` 下最新的 `.sav`（zip，内含 `gamestate` 与 `meta`）。

- 用途：**补全日志通道拿不到的全量列表**（全部已研究科技、传统、飞升、遗珍、建筑、区划、领袖特质、外交条约全文）。
- 解析是**容错 + 可扩展**的：默认映射见 `03-dsh-stellaris-bridge/lib/save/mapping.js`，用户可在 `~/.dsh/stellaris-bridge/mapping.json` 覆盖任意路径。
- 输出结构与日志通道**同名同义**（`EMPIRE`/`PLANET`/`TECH`…），只是多一个 `source: "save"` 字段。

> 群星脚本没有「枚举全部科技」的效果，只有 `has_technology = <key>` 这类点查询。所以「读取所有数据」在产品层面就等于「日志给实时 + 存档给全量」，任何声称只靠模组就能全量导出的方案都是不成立的。

---

## 2.1 创建阶段（游戏开始前）

创建界面不在脚本生命周期里（没有国家、没有控制台、没有 on_action），所以这一阶段
**不进 DSH1 协议**，由桥直接读文件：

| 数据 | 文件 | 说明 |
| --- | --- | --- |
| 已保存的自定义帝国 | `<用户目录>/user_empire_designs_v3.txt` | 政体/思潮/国策/起源/物种/母星名 |
| 开局设置 | 存档的 `meta` | 星系大小/难度/铁人；开局前没有 |

写回时桥按**真实 v3 结构**（顶层 `"Name"={...}`，`name`/`civics` 是块）克隆或从零创建，先 dry-run，写盘要确认，先备份再读回自检。创建界面刷新后即可选。

**事件定义图**（事件 → 后继事件）也由桥在本地解析游戏安装目录得到，属于桥的派生数据，
不新增协议记录类型；`stellaris_event_info` 直接返回。

---

## 3. 通道 C：命令下行

### 3.1 文件

桥写 `<用户目录>/dsh_q_<id>.txt`，`id` = `<epoch_ms>_<counter>`。文件内容：**每行一条控制台命令**，UTF-8 无 BOM，CRLF 或 LF 均可（建议 LF）。

```
effect = { add_resource = { alloys = 500 } log = "DSH1|101|ACK|cmd=a17|phase=recv|ts=... " }
```

- 一行必须是一条完整命令；`effect = { ... }` 内部**不能换行**（换行会被当成下一条命令）。
- 桥保证单行长度 < 6000 字符；超长动作会被拆分或拒绝。
- 文件保留最近 50 份，其余自动清理。

### 3.2 触发

桥通过 Windows `SendInput` 键盘事件让游戏窗口获得焦点，按 `consoleKey`（默认 `` ` ``，可在配置里改成 `~` 或 `^`），输入：

```
run dsh_q_<id>.txt
```

回车，再按一次 `consoleKey` 关闭控制台。**没有鼠标事件、没有 UI 点击。**

`injection = "manual"` 时跳过键盘，只在工具返回里给出这一行，玩家自己粘贴。

### 3.3 ACK 协议

每条命令在 effect 体**开头**与**结尾**各写一条日志：

```
log = "DSH1|<seq>|ACK|cmd=a17|phase=recv|ts=<epoch>"
log = "DSH1|<seq>|ACK|cmd=a17|phase=done|ts=<epoch>"
```

- 桥在 `ackTimeoutMs`（默认 6000）内收 `recv` → 认为命令被游戏读到；收 `done` → 成功。
- 只收 `recv` 不收 `done`：effect 中途报错。桥会去 `error.log` 找同一时间窗的 `script error`，把原文附在结果里。
- 两条都没有：注入失败（窗口没焦点/控制台没开/ironman）。桥返回 `INJECT_FAILED` 并建议改用 `manual`。

> `log` 的字符串是**字面量**，不依赖本地化求值；这也是为什么 ACK 用 `log` 而不是 `custom_tooltip` 之类。

### 3.4 命令编号

`cmd` 由桥生成：`l<lane>-<planId>-<index>`，例如 `l2-p3-0`（通道 2、方案 p3、第 0 条）。

- `lane = 0` 表示「未绑定子会话的临时通道」；
- 一个「方案」= 一组命令 + 一个 `planId`，便于整体回执与重放；
- **多通道**：`l2-` 与 `l3-` 的 ACK 永不串台；桥用全局锁保证「同一时刻只有一次控制台交互」。

### 3.5 通道（lane）与子会话

桥维护一张 `sessionId ↔ lane` 表（`~/.dsh/stellaris-bridge/lanes.json`）：

- 子会话调 `stellaris_lane_bind` 认领一条 lane；
- 之后它的 `stellaris_apply` / `stellaris_apply_reply` 自动带 `l<lane>-` 前缀；
- `stellaris_dispatch` 可以把目标派给该子会话，桥用它的 lane 代执行。

群星侧没有会话概念，所以 lane 完全在桥内实现；模组 B 只提供每条通道的面板
（`dsh_console.40..47`）与 `dsh_console_lane_<N>_ping` 自检。

---

## 4. 通道 H：动作 DSL（模型 ↔ 桥）

### 4.1 在回复里写

````markdown
```stellaris
- resource: { key: alloys, amount: 500 }
- add_building: { planet: "地球", building: building_alloy_foundry }
- open_ui: { view: ascension }
```
````

规则：

- 围栏语言标记必须是 `stellaris`（也接受 `stellaris-plan`）。
- 块内是 YAML 风格的列表：`- <verb>: { k: v, k: v }`，或 JSON 数组（两种都认）。
- `planet` 可以是**名字**（模糊匹配）、`ord` 数字、或 `"capital"`。
- 引号可省；含空格/中文的值建议加引号。
- 一个回复里可以有多个块，桥按出现顺序合并执行。

### 4.2 动词表

完整表（54 个动词，含作用域/参数/等级）在 [`docs/actions.md`](actions.md)，由代码里的
`CATALOGUE` 生成。协议只约定「动词 + 参数」的形状，不复制那份表，避免两处漂移。

等级语义：

| 等级 | 含义 |
| --- | --- |
| `core` | 高置信，默认允许 |
| `exp` | 需游戏内验证；默认拒绝，`allowExperimental: true` 才执行 |
| `raw` | 原样脚本；需 `allowRawEffect: true` |

### 4.3 星球寻址

`planet` 解析顺序：

1. `"capital"` → `capital_scope = { ... }`（不循环，最稳）。
2. `ord` 数字或快照里能唯一匹配的名字 → 编译成**迭代寻址**：

```
effect = {
  set_variable = { name = dsh_scan value = 0 }
  every_owned_planet = {
    if = { limit = { check_variable = { which = dsh_scan value = 17 } }
      <动作>
      log = "DSH1|...|ACK|cmd=...|phase=done"
    }
    change_variable = { which = dsh_scan value = 1 }
  }
}
```

`ord` 与模组 A 导出时的 `every_owned_planet` 顺序一致；执行侧用 4.5 的
`ordered_owned_planet = { position = N ... }` 命中第 N 个，并把对象存成 `dsh_hit` 事件目标，
再用 `exists = event_target:dsh_hit` 写 done/fail（4.5 已移除全局变量）。

**代价**：导出与执行之间若新增殖民地，序号可能错位。桥在快照超过 `stalePlanetMs`（默认 10 分钟）时
拒绝按 `ord` 寻址，除非 `force: true`；拿不准就用 `capital` 或星球名。

### 4.4 开界面

- `uiMode = "hotkey"`（默认）：按配置里 `uiHotkeys` 的映射发送**键盘热键**（例如 `ascension: "F5"`）。首次使用请用 `stellaris_calibrate_ui` 校准一次。
- `uiMode = "effect"`：发 `effect = { open_view = <view> }`。该效果在部分版本/部分视图可用，属 `exp`，默认不开。
- `uiMode = "terminal"`：只让模组 B 弹出游戏内「DSH 面板」并高亮对应条目（最保险，零注入风险）。

---

## 5. 错误码

| 码 | 含义 | 桥的建议动作 |
| --- | --- | --- |
| `NOT_CONNECTED` | 找不到用户目录 / 没开游戏 | 检查 `stellarisUserDir` |
| `MOD_MISSING` | 模组 A/B 未装载 | 装模组并重启游戏 |
| `IRONMAN` | 存档为铁人 | 只能读 |
| `STALE_SNAPSHOT` | 快照过旧 | `stellaris_refresh` |
| `UNKNOWN_PLANET` | 名字匹配不到 | 先 `stellaris_brief` 看列表 |
| `EXP_ACTION` | 动作是 experimental 且未放行 | 加 `allow_experimental: true` |
| `INJECT_FAILED` | 键盘注入后无 ACK | 改 `manual` 或检查 `consoleKey` |
| `ACK_TIMEOUT` | 只收到 recv | 看返回的 `errorLog` 原文 |
| `SCRIPT_ERROR` | 游戏脚本报错 | 按 `errorLog` 修动作 |
| `LIMIT_EXCEEDED` | 超过安全阈值 | 调小数量或改 `safety` || `NO_SESSION` | dispatch 找不到会话 / 会话没绑 lane | 先 `stellaris_lane_bind` |
| `BUSY` | 同一子会话上一次分发未结束 | 等它回完再派 |
| `LANE` | lane 被占 / 没有空闲 | `stellaris_lane_list` 看占用 |

---

## 6. HTTP 接口（通道 H）

全部只允许 `127.0.0.1 / ::1`，且除 `/health` 外都要求 `Authorization: Bearer <liveChat.token>`（未配置 token 时禁用写接口）。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/dsh-stellaris/health` | 版本、快照年龄、模组、开关 |
| `POST` | `/api/dsh-stellaris/livechat/ingest` | `{ user, text, platform?, ts? }` 投一条弹幕 |
| `GET` | `/api/dsh-stellaris/livechat/poll?since=<id>` | 拉取新弹幕与已发回复 |
| `POST` | `/api/dsh-stellaris/livechat/reply` | `{ text, to? }` 桥要发出去的回复 |
| `GET` | `/api/dsh-stellaris/livechat/stream` | SSE：`event: danmaku` / `event: reply` |
| `GET` | `/api/dsh-stellaris/status` | 给面板用的完整状态 |

---

## 7. 兼容性

- 群星侧：4.5（`supported_version = "4.5.*"`）。3.x 的脚本效果大多兼容，但 4.x 的星球/建筑字段有变化，见 `docs/verification.md`。
- DSH 侧：`engines.dsh >= 0.1.7-rc.1`，Node ≥ 22。
- 协议：`DSH1`。新增字段不算破坏；删除/改义必须 `DSH2`。
