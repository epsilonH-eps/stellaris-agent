# Stellaris 4.5 模组校验报告

> 目标版本：**4.5.2 "Cygnus"**（`launcher-settings.json` 实测：`Cygnus v4.5.2 (9776)`）。
> 校验对象：`01-stellaris-reader`、`02-stellaris-console`。
> 校验器：[`tools/validate-mods.mjs`](../tools/validate-mods.mjs)。
>
> **这份报告是拿真实安装目录跑出来的**，不是纸面推断：
> `node tools/validate-mods.mjs --game-dir "D:\SteamLibrary\steamapps\common\Stellaris"`

## 1. 当前结果

```text
共 16 项：ERROR 0，WARN 1
```

唯一 WARN 是 6 个 effect 在 4.5 脚本里找不到调用（可能是引擎效果、也可能改名），
它们全部是 `exp`，**默认不会执行**。

## 2. 4.5 实测发现并已修复的问题

这些是「照 3.x 写、在 4.5 会坏」的真问题，校验器 + 安装目录对照抓出来的：

| # | 问题 | 4.5 的真实情况 | 修复 |
| --- | --- | --- | --- |
| 1 | 阅读模组挂了 `on_colony_established` | 4.5 没有这个名字；殖民钩子是 `on_colonization_started`（scope=Planet）和 `on_colonized`（scope=Carrier） | 改用 `on_colonization_started` |
| 2 | 月度导出挂在 `on_monthly_pulse` | 4.5 里它是 **No scope**（和 `on_game_start` 一样），国家事件拿不到 `This` | 改用 `on_monthly_pulse_country`（注释明确 `this = country`） |
| 3 | 人口导出用 `trigger = num_pops` | 4.5 人口重构后，脚本里用的是 **`pop_amount`**，`num_pops` 已不在触发器里 | 改成 `pop_amount`（存档映射同时保留两套字段名） |
| 4 | 事件图片 `picture = GFX_evt_communication` | 4.5 的 sprite 名是 **`GFX_evt_communication_event`** | 全部事件改用新名 |
| 5 | 法令动作用 `activate_edict` / `deactivate_edict` | 4.5 原生事件里用的是 **`add_edict`**；`deactivate_edict` 不存在 | 改成 `add_edict` / `remove_edict`（移除仍标 exp） |
| 7 | `log` 里直接写 `[This.GetName]` | 4.5 的 `log` 会把 `[` 当宏解析，报 `Invalid macro entry`，值变成空 | 按官方 `99_advanced_documentation.txt` 改成 `\\[This.GetName]`（两个反斜杠） |
| 6 | 星球/领袖/舰队寻址用全局变量计数器 | **4.5 移除了 `set_global_variable`**，原来的循环会直接报错 | 改用 4.5 原生 `ordered_owned_planet/leader/fleet/country` + `position`，命中后存 `dsh_hit` 事件目标 |

第 6 条影响最大：它不是「某个动作失效」，而是**所有按序号寻址都会坏**。现在编译器
生成的是：

```
effect = {
  ordered_owned_planet = { position = 17 <动作> save_event_target_as = dsh_hit }
  if = { limit = { exists = event_target:dsh_hit } log = "...done" }
  if = { limit = { NOT = { exists = event_target:dsh_hit } } log = "...fail" }
}
```

不再有任何变量计数；`position` 越界就不会命中，自然回 `fail`。

## 3. 校验器查什么

### 结构层（无需游戏）

`descriptor.mod` / `supported_version=4.5.*` / `thumbnail.png` / 目录白名单 /
花括号与引号 / namespace 与事件 id 唯一 / 本地化语言头、BOM、重复 key、引用覆盖。

### 精确层（`--game-dir`）

- 真实 `common/on_actions/*.txt`：我们挂的每个 on_action 是否存在；
- 真实 `events/*.txt`：namespace 是否撞车；
- `interface/*.gfx`：事件图片 sprite 是否存在（按 4.5 的 `name = "GFX_..."` 写法）；
- 54 个动作的 effect token：在 4.5 脚本里找使用证据；
- 模组里 `export_trigger_value_to_variable` 用的 trigger：在 4.5 里是否存在。

## 4. 仍未确认的 6 个 effect（全部 exp，默认拒发）

| 动词 | 4.5 里的写法 | 说明 |
| --- | --- | --- |
| `remove_edict` | `remove_edict` | 4.5 脚本里没有调用，可能在引擎里存在 |
| `set_empire_name` | `set_empire_name` | 参数是 loc key，不是任意文本 |
| `remove_last_building` | `remove_last_built_building` | 引擎效果，原版没用到 |
| `repair_buildings` | `repair_all_buildings` | 同上 |
| `set_designation` | `set_planet_designation` | 4.5 可能改名 |
| `set_planet_name` | `set_planet_name` | 引擎效果，原版没用到 |

验证方式：测试档里逐个 `allow_experimental: true` 单发，看 `error.log`；
如果报 `unknown effect`，把行贴给我，改 `actions.js` 一条即可。

## 5. 已验证的 4.5 事实（来自安装目录）

- `run` 控制台 / `effect = {...}` 仍是唯一外部写入口（铁人除外）；
- `log = "..."`、`export_trigger_value_to_variable`、`export_resource_stockpile_to_variable`、
  `export_resource_income_to_variable` 都存在；
- `every_owned_planet/leader/fleet`、`every_country`、`capital_scope` 都存在；
- `add_resource`、`give_technology`、`add_tradition`、`add_building`、`set_policy`、
  `force_add_civic`、`set_origin`、`add_district` 都能在 4.5 脚本里找到使用处；
- `on_game_start_country`、`on_monthly_pulse_country` 存在且注释为 `this = country`；
- `on_colonization_started` 存在且 scope=Planet；
- `GFX_evt_communication_event` 存在。

## 6. 还剩什么要在游戏里确认

1. **`ordered_*` 的默认顺序**是否与导出时 `every_owned_planet` 的顺序一致（本报告的核心假设）；
2. 事件窗口与本地化显示；
3. 6 个 exp effect 的真实名字；
4. ACK：注入 `run dsh_q_*.txt` 后 `game.log` 是否出现 `DSH1|...|ACK|...|done`。

三步实测流程仍按下面走（测试档、非铁人）：

```text
1. 读档 → 等一个月 → 看 game.log 有没有 DSH1|BEGIN / PLANET / END
2. 控制台 event dsh_console.10 → 面板能弹
3. stellaris_apply note → resource → open_ui → 再逐个试 exp
```

任何一步报错，把 `logs/error.log` 里对应的那一行贴回来即可。


---

## 7. 怎么触发 refresh（第 4 步）

`stellaris_refresh` 是 DSH 插件里的一个**工具**，不是 exe。它做的事只有一件：
让游戏执行 `event dsh_reader.9`。所以有三种等价做法：

### A. 游戏控制台（最直接，推荐）

1. 进游戏（读档后）；
2. 按 `~`（有些键盘布局是 `^`）打开控制台；
3. 输入 `event dsh_reader.9`，回车；
4. 打开 `logs/game.log`，应该看到新的 `DSH1|0|BEGIN...`。

### B. 独立软件（不需要 API key）

```powershell
.\04-stellaris-agent\run.cmd refresh
```

自动模式会切前台、开控制台、输入命令；如果系统禁止模拟输入（本机就是这种情况），用：

```powershell
.\04-stellaris-agent\run.cmd refresh --manual
```

它会把命令文件写好，并打印一行 `run dsh_q_xxx.txt`，你把这行手敲进控制台即可。

### C. DSH 工具

需要先把插件装进 DSH profile（当前没有装，且装完要重启 DSH），然后在本会话里说「刷新一下群星」，
模型会调用 `stellaris_refresh`。

> 注意：模组脚本改动后**必须重启游戏**才会重新加载；热重启不行。
