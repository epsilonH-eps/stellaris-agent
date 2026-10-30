# 动作目录（54 个动词）

> 由 `tools/gen-actions-doc.mjs` 从 `03-dsh-stellaris-bridge/lib/actions.js` 生成。
> 加动作 = 在 CATALOGUE 里加一条（含 sample），然后重跑脚本。

共 **54** 个动词：core 50 / exp 3 / raw 1。

- `core`：高置信，默认允许
- `exp`：需在游戏内验证；默认拒绝，`allowExperimental: true` 才执行
- `raw`：原样脚本；需 `allowRawEffect: true`

## 通用约定

- 星球参数 `planet` 可以是名字、`ord` 数字或 `capital`；按序号寻址受快照新鲜度保护。
- 外交类动作的 `country` 来自存档通道解析出的国家列表（先 `stellaris_save_scan`）。
- 每条命令都带 ACK；执行结果里能看到 `recv/done/fail`。
- 没有鼠标点击，也没有「替玩家点 UI」：写操作都是游戏自己的 `effect`。

## 国家（默认作用域）

| 动词 | 等级 | 参数 | 说明 |
| --- | --- | --- | --- |
| `resource` | core | `key: resource`，`amount: number` | 加/扣资源。key 见资源表；amount 可负。 |
| `add_modifier` | core | `key: key`，`days: number?`，`scope: scope?`，`planet: planet?` | 加修正；days 省略 = 永久；scope=planet 时作用到目标星球。 |
| `remove_modifier` | core | `key: key`，`scope: scope?`，`planet: planet?` | 移除修正。 |
| `give_tech` | core | `tech: key` | 直接给科技。 |
| `add_tradition` | core | `tradition: key` | 加传统。 |
| `add_perk` | core | `perk: key` | 加飞升（effect 名待验证）。 |
| `add_relic` | core | `relic: key` | 加遗珍（effect 名待验证）。 |
| `add_edict` | core | `key: key` | 激活法令（4.5 用 add_edict）。 |
| `set_policy` | core | `policy: key`，`option: key` | 改政策。 |
| `force_add_civic` | core | `civic: key` | 无视限制加国策。 |
| `force_remove_civic` | core | `civic: key` | 无视限制移除国策。 |
| `set_ai_personality` | core | `personality: key` | 设置国家的 AI 人格（引擎效果，4.5 文档字符串确认；对 AI 托管/接管时生效）。 |
| `set_origin` | core | `origin: key` | 设置起源（不补触发开局效果）。 |
| `set_empire_name` | exp | `name: text` | 改帝国名（effect 参数是 loc key，不是任意文本；用前先确认）。 |
| `set_country_flag` | core | `key: key` | 设国家旗标（脚本/事件用）。 |
| `clear_country_flag` | core | `key: key` | 清国家旗标。 |
| `clear_resources` | exp | — | 清空国家资源（危险）。 |
| `event` | core | `id: key` | 触发一个国家事件（万能后门）。 |
| `note` | core | `text: text` | 只写日志，不改档。 |
| `raw_effect` | raw | `script: text` | 原样拼进 effect（需 allowRawEffect）。 |

## 星球（需要 planet 参数，自动寻址）

| 动词 | 等级 | 参数 | 说明 |
| --- | --- | --- | --- |
| `add_building` | core | `planet: planet`，`building: key` | 开始建造一座建筑。 |
| `ruin_building` | core | `planet: planet`，`building: key` | 把某座建筑打成废墟。 |
| `remove_building` | core | `planet: planet`，`building: key` | 拆除指定建筑（4.5 的 effect 是 remove_building）。 |
| `remove_all_buildings` | core | `planet: planet` | 移除全部建筑（危险）。 |
| `repair_buildings` | core | `planet: planet` | 修复全部废墟建筑。 |
| `downgrade_buildings` | core | `planet: planet` | 降级建筑。 |
| `add_district` | core | `planet: planet`，`district: key` | 加区划。 |
| `set_designation` | core | `planet: planet`，`designation: key` | 改星球定位（4.5 的 effect 是 set_colony_type）。 |
| `set_planet_name` | core | `planet: planet`，`name: text` | 改星球名。 |
| `add_planet_devastation` | core | `planet: planet`，`amount: number` | 加荒废度（0-100）。 |
| `clear_blockers` | core | `planet: planet` | 清除全部地块障碍。 |
| `add_deposit` | core | `planet: planet`，`deposit: key` | 加资源矿藏。 |
| `reroll_deposits` | core | `planet: planet` | 重掷矿藏。 |
| `create_mining_station` | core | `planet: planet` | 在目标星球轨道建采矿站（需要玩家拥有）。 |
| `create_research_station` | core | `planet: planet` | 在目标星球轨道建研究站。 |

## 领袖（按名字/id 匹配，迭代寻址）

| 动词 | 等级 | 参数 | 说明 |
| --- | --- | --- | --- |
| `leader_trait` | core | `leader: leader`，`trait: key` | 给领袖加特质。 |
| `leader_skill` | core | `leader: leader`，`level: number` | 设置领袖等级（1-10）。 |
| `leader_experience` | core | `leader: leader`，`amount: number` | 加领袖经验。 |
| `leader_immortal` | core | `leader: leader`，`immortal: bool?` | 设置/取消不朽。 |
| `leader_freeze_age` | core | `leader: leader`，`freeze: bool?` | 冻结/解冻领袖年龄。 |

## 舰队（按名字/id 匹配）

| 动词 | 等级 | 参数 | 说明 |
| --- | --- | --- | --- |
| `fleet_stance` | core | `fleet: fleet`，`stance: stance` | 舰队姿态：aggressive/passive/evasive。 |
| `fleet_aggro` | core | `fleet: fleet`，`range: number` | 设置交战范围。 |
| `fleet_mission` | core | `fleet: fleet`，`mission: key` | 设置舰队任务（观察站等）。 |
| `fleet_repair` | core | `fleet: fleet`，`percent: number` | 按比例修复舰船（0-1）。 |
| `send_fleet` | core | `fleet: fleet`，`planet: planet` | 让舰队自动前往某星球。 |
| `fleet_delete` | exp | `fleet: fleet` | 删除舰队（危险）。 |

## 外交目标国家（需要存档通道提供国家列表）

| 动词 | 等级 | 参数 | 说明 |
| --- | --- | --- | --- |
| `add_trust` | core | `country: country`，`amount: number` | 加信任。 |
| `add_threat` | core | `country: country`，`amount: number` | 加威胁感（会让对方更敌视你）。 |
| `end_rivalry` | core | `country: country` | 结束竞争关系。 |
| `set_truce` | core | `country: country`，`type: type?` | 强制停战（war/liberation/alliance/…）。 |
| `end_truce` | core | `country: country` | 结束停战。 |
| `join_war` | core | `country: country` | 加入目标国家这一侧的战争。 |
| `set_closed_borders` | core | `country: country`，`status: bool?` | 开/关边界。 |

## 不走 effect（由 UI 层处理）

| 动词 | 等级 | 参数 | 说明 |
| --- | --- | --- | --- |
| `open_ui` | core | `view: enum` | 打开界面（由 UI 层处理，不走 effect）。 |

## 不在表里的操作

群星有上千个 effect，本表只收「玩家常用操作对应得上、且能安全包一层」的部分。
不在表里的，用 `raw_effect`（需显式放行）或先加一条定义。
舰船设计器、外交谈判条款、联邦投票、市场订单、贸易路线、事件选项点击这些属于 UI/规则流程，
没有稳定的 effect 入口，**不做**——不是遗漏，是引擎边界。
