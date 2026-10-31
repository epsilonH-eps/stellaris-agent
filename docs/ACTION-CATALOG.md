# 动作目录（由代码生成）

> 生成命令：`node tools/gen-actions-doc.mjs`。唯一来源：[`agent/lib/actions.mjs`](../agent/lib/actions.mjs)。
> 不要手改本文件。

共 **60** 个写动作、**44** 个读取方法。

`confidence`：

- `verified`：参数来自上游文档 / 旧版真机验证；
- `inferred`：从 DLL 符号推断，首次使用若参数不符，执行器会把错误回传给子会话，由它改参重试。

## 单位划分

| 单位 | 含义 | 动作数 |
| --- | --- | --- |
| `control` | 时间与执行控制 | 2 |
| `research` | 国家科研 | 2 |
| `council` | 国家内阁 | 6 |
| `laws` | 法令与物种权利 | 3 |
| `economy` | 经济与市场 | 4 |
| `diplomacy` | 外交与战争 | 7 |
| `fleet` | 舰队 | 15 |
| `planet` | 星球 | 17 |
| `event` | 特殊事件 | 6 |

## 时间与执行控制（`control`）

| 动作 | 参数 | 必填 | 说明 | 回读 | 置信 |
| --- | --- | --- | --- | --- | --- |
| `set_paused` | `paused: bool` | `paused` | 暂停/继续游戏（原生 CPauseCommand） | `get_status` | verified |
| `set_speed` | `speed: int` | `speed` | 设置游戏速度 0..4 | `get_status` | verified |

## 国家科研（`research`）

| 动作 | 参数 | 必填 | 说明 | 回读 | 置信 |
| --- | --- | --- | --- | --- | --- |
| `select_research` | `slot: string`<br>`tech_key: string` | `slot`<br>`tech_key` | 选择科研项目（slot: physics/society/engineering） | soft `get_research_state` | verified |
| `cancel_research` | `slot: string` | `slot` | 取消当前科研（slot: physics/society/engineering） | soft `get_research_state` | verified |

## 国家内阁（`council`）

| 动作 | 参数 | 必填 | 说明 | 回读 | 置信 |
| --- | --- | --- | --- | --- | --- |
| `hire_leader` | `candidate_id: int` | `candidate_id` | 从候选池雇佣领袖 | soft `get_leaders` | verified |
| `dismiss_leader` | `leader_id: int` | `leader_id` | 解雇已雇佣领袖 | soft `get_leaders` | verified |
| `assign_leader` | `leader_id: int`<br>`slot_type: string`<br>`target_id: int` | `leader_id`<br>`slot_type`<br>`target_id` | 指派领袖（slot_type: council/fleet/planet/army） | soft `get_leaders` | verified |
| `set_council_agenda` | `agenda_key: string` | `agenda_key` | 选择内阁议程 | soft `get_government` | verified |
| `launch_council_agenda` | `agenda_key: string` | `agenda_key` | 启动/激活内阁议程 | soft `get_government` | verified |
| `select_leader_trait` | `leader_id: int`<br>`trait_key: string` | `leader_id`<br>`trait_key` | 为领袖选择特质（升级时） | soft `get_leaders` | inferred |

## 法令与物种权利（`laws`）

| 动作 | 参数 | 必填 | 说明 | 回读 | 置信 |
| --- | --- | --- | --- | --- | --- |
| `toggle_edict` | `edict_key: string`<br>`enabled: bool` | `edict_key`<br>`enabled` | 开关帝国法令（原生 CToggleEdictCommand） | soft `get_edicts` | verified |
| `adopt_tradition` | `tradition_key: string` | `tradition_key` | 采纳一项传统（key 见 get_traditions 的 available/unlocked） | soft `get_traditions` | verified |
| `set_species_rights` | `species_id: int`<br>`category: string`<br>`right_value: string` | `species_id`<br>`category`<br>`right_value` | 设置物种权利（category 见 available_rights_catalog） | soft `get_species` | verified |

## 经济与市场（`economy`）

| 动作 | 参数 | 必填 | 说明 | 回读 | 置信 |
| --- | --- | --- | --- | --- | --- |
| `market_trade` | `resource: string`<br>`amount: number`<br>`is_buy: bool` | `resource`<br>`amount`<br>`is_buy` | 银河市场买卖资源 | soft `get_status` | verified |
| `set_monthly_trade` | `resource: string`<br>`amount: number`<br>`is_buy: bool` | `resource`<br>`amount`<br>`is_buy` | 设置每月自动买卖 | soft `get_market` | inferred |
| `cancel_monthly_trade` | `order_id: int` | `order_id` | 取消一条每月贸易挂单（order_id 见 get_market.monthly_trades） | soft `get_market` | verified |
| `build_district` | `planet_id: int`<br>`district_key: string` | `planet_id`<br>`district_key` | 建造区划 | soft `get_planet_details` | verified |

## 外交与战争（`diplomacy`）

| 动作 | 参数 | 必填 | 说明 | 回读 | 置信 |
| --- | --- | --- | --- | --- | --- |
| `diplomacy_action` | `country_id: int`<br>`action: string` | `country_id`<br>`action` | 发起外交动作（action 见 get_diplomacy_options.options[].key） | soft `get_pending_diplomacy` | verified |
| `respond_diplomacy` | `proposal: string`<br>`accept: bool` | `proposal`<br>`accept` | 回应待处理外交提议 | soft `get_pending_diplomacy` | verified |
| `set_defender_war_goal` | `war_id: int`<br>`goal_key: string` | `war_id`<br>`goal_key` | 设置防御战争目标 | soft `get_wars` | verified |
| `close_war_goals` | `war_id: int` | `war_id` | 关闭战争目标界面（确认/退出） | soft `get_wars` | inferred |
| `improve_relations` | `country_id: int` | `country_id` | 改善关系 | soft `get_contacts` | inferred |
| `establish_embassy` | `country_id: int` | `country_id` | 建立大使馆 | soft `get_contacts` | inferred |
| `add_system_claim` | `system_id: int` | `system_id` | 宣称星系 | soft `get_galaxy_overview` | inferred |

## 舰队（`fleet`）

| 动作 | 参数 | 必填 | 说明 | 回读 | 置信 |
| --- | --- | --- | --- | --- | --- |
| `move_fleet` | `fleet_id: int`<br>`system_id: int` | `fleet_id`<br>`system_id` | 移动舰队到星系 | soft `get_fleets` | verified |
| `survey` | `fleet_id: int`<br>`system_id: int` | `fleet_id`<br>`system_id` | 调查星系 | soft `get_fleets` | verified |
| `set_fleet_stance` | `fleet_id: int`<br>`stance: string` | `fleet_id`<br>`stance` | 舰队姿态 aggressive/passive/evasive | soft `get_fleets` | verified |
| `follow_fleet` | `fleet_id: int`<br>`target_fleet_id: int` | `fleet_id`<br>`target_fleet_id` | 舰队跟随另一支舰队 | soft `get_fleets` | verified |
| `merge_fleets` | `fleet_ids: array` | `fleet_ids` | 合并舰队（同星系） | soft `get_military_fleets` | verified |
| `reinforce_fleet` | `fleet_id: int` | `fleet_id` | 按模板补员 | soft `get_fleets` | verified |
| `set_fleet_template_quota` | `fleet_id: int`<br>`design_id: int`<br>`target_quota: int` | `fleet_id`<br>`design_id`<br>`target_quota` | 设置舰队模板配额 | soft `get_fleets` | verified |
| `build_ship` | `design_id: int`<br>`system_id: int`<br>`count: int` | `design_id`<br>`system_id` | 在船坞建造舰船（count 默认 1） | soft `get_buildable_ships` | verified |
| `upgrade_fleet` | `fleet_id: int` | `fleet_id` | 升级舰队舰船到最新设计 | soft `get_fleets` | inferred |
| `build_outpost` | `fleet_id: int`<br>`system_id: int`<br>`station_type: string` | `fleet_id`<br>`system_id` | 建造前哨站 | soft `get_system` | verified |
| `build_stations` | `fleet_id: int`<br>`system_id: int` | `fleet_id`<br>`system_id` | 建造采矿/研究站 | soft `get_system` | verified |
| `colonize` | `planet_id: int`<br>`fleet_id: int` | `planet_id`<br>`fleet_id` | 殖民星球 | soft `get_planet_details` | verified |
| `build_megastructure` | `fleet_id: int`<br>`megastructure_key: string` | `fleet_id`<br>`megastructure_key` | 工程船建造巨型结构（候选见 get_buildable_megastructures） | soft `get_buildable_megastructures` | inferred |
| `cancel_fleet_orders` | `fleet_id: int` | `fleet_id` | 取消舰队当前命令 | soft `get_fleets` | inferred |
| `focus_fleet` | `fleet_id: int` | `fleet_id` | 镜头定位舰队（只影响界面） | — | verified |

## 星球（`planet`）

| 动作 | 参数 | 必填 | 说明 | 回读 | 置信 |
| --- | --- | --- | --- | --- | --- |
| `build_building` | `planet_id: int`<br>`slot_index: int`<br>`building_key: string`<br>`district_type: string` | `planet_id`<br>`slot_index`<br>`building_key`<br>`district_type` | 在星球特区建造建筑 | soft `get_planet_details` | verified |
| `upgrade_building` | `planet_id: int`<br>`building_id: int` | `planet_id`<br>`building_id` | 升级建筑 | soft `get_planet_details` | inferred |
| `build_district` | `planet_id: int`<br>`district_key: string` | `planet_id`<br>`district_key` | 建造区划 | soft `get_planet_details` | verified |
| `set_district_zone` | `planet_id: int`<br>`district_id: int`<br>`zone_slot: int`<br>`zone_key: string` | `planet_id`<br>`district_id`<br>`zone_slot`<br>`zone_key` | 设置区划特区 | soft `get_available_district_zones` | verified |
| `set_job_priority` | `planet_id: int`<br>`job_key: string`<br>`prioritized: bool` | `planet_id`<br>`job_key`<br>`prioritized` | 调整岗位优先级 | soft `get_planet_jobs` | verified |
| `set_job_workforce_limit` | `planet_id: int`<br>`job_key: string`<br>`limit: int` | `planet_id`<br>`job_key`<br>`limit` | 设置岗位人力上限 | soft `get_planet_jobs` | inferred |
| `clear_blocker` | `planet_id: int`<br>`blocker_id: int` | `planet_id`<br>`blocker_id` | 清除地块障碍 | soft `get_clearable_blockers` | inferred |
| `enact_planetary_decision` | `planet_id: int`<br>`decision_key: string` | `planet_id`<br>`decision_key` | 执行星球决议 | soft `get_planetary_decisions` | inferred |
| `start_terraforming` | `planet_id: int`<br>`target_class: string` | `planet_id`<br>`target_class` | 开始地形改造 | soft `get_terraforming_options` | inferred |
| `cancel_terraforming` | `planet_id: int` | `planet_id` | 取消地形改造 | soft `get_planet_details` | inferred |
| `set_planet_army_settings` | `planet_id: int`<br>`settings: map` | `planet_id`<br>`settings` | 设置星球陆军招募设置（settings 见 get_planet_armies） | soft `get_planet_armies` | inferred |
| `recruit_planet_army` | `planet_id: int`<br>`army_key: string` | `planet_id`<br>`army_key` | 招募陆军 | soft `get_planet_armies` | inferred |
| `disband_planet_army` | `planet_id: int`<br>`army_id: int` | `planet_id`<br>`army_id` | 解散星球陆军 | soft `get_planet_armies` | inferred |
| `move_army_to_orbit` | `planet_id: int`<br>`army_id: int` | `planet_id`<br>`army_id` | 陆军进入轨道 | soft `get_planet_armies` | inferred |
| `land_armies` | `fleet_id: int`<br>`planet_id: int` | `fleet_id`<br>`planet_id` | 陆军登陆 | soft `get_planet_armies` | inferred |
| `cancel_construction` | `planet_id: int`<br>`index: int` | `planet_id`<br>`index` | 取消建造队列中的某一项 | soft `get_planet_details` | inferred |
| `focus_planet` | `planet_id: int` | `planet_id` | 镜头定位星球（只影响界面） | — | verified |

## 特殊事件（`event`）

| 动作 | 参数 | 必填 | 说明 | 回读 | 置信 |
| --- | --- | --- | --- | --- | --- |
| `resolve_event` | `window_id: int`<br>`option_index: int` | `window_id`<br>`option_index` | 选择事件选项并关闭窗口 | soft `get_active_events` | verified |
| `open_alert` | `alert_id: int` | `alert_id` | 打开警报对应的界面 | — | verified |
| `open_notification` | `index: int` | `index` | 打开通知 | — | verified |
| `set_situation_approach` | `situation_id: int`<br>`approach_index: int` | `situation_id`<br>`approach_index` | 调整局势应对方式 | soft `get_situation_log` | verified |
| `show_panel` | `panel: string` | `panel` | 打开界面面板 | — | verified |
| `set_paused` | `paused: bool` | `paused` | 暂停/继续游戏（原生 CPauseCommand） | `get_status` | verified |

## 读取方法

| 方法 | 作用域 | 参数 |
| --- | --- | --- |
| `get_status` | global | — |
| `get_outliner` | global | — |
| `get_sectors` | global | — |
| `get_government` | global | — |
| `get_civics` | global | — |
| `get_edicts` | global | — |
| `get_traditions` | global | — |
| `get_research_state` | global | — |
| `get_leaders` | global | — |
| `get_market` | global | — |
| `get_contacts` | global | — |
| `get_pending_diplomacy` | global | — |
| `get_wars` | global | — |
| `get_war_goal_candidates` | war | `war_id` |
| `get_active_events` | global | — |
| `get_alerts` | global | — |
| `get_notifications` | global | — |
| `get_situation_log` | global | — |
| `get_galaxy_overview` | global | — |
| `get_galaxy_map` | global | — |
| `get_fleets` | global | — |
| `get_military_fleets` | global | — |
| `get_civilian_fleets` | global | — |
| `get_armies` | global | — |
| `get_ship_designs` | global | — |
| `get_ship_design_catalog` | global | — |
| `get_discoveries` | global | — |
| `get_species` | global | — |
| `get_planet_details` | planet | `planet_id` |
| `get_planet_jobs` | planet | `planet_id` |
| `get_planet_armies` | planet | `planet_id` |
| `get_buildable_buildings` | planet | `planet_id` |
| `get_buildable_districts` | planet | `planet_id` |
| `get_available_district_zones` | planet | `planet_id` |
| `get_clearable_blockers` | planet | `planet_id` |
| `get_planetary_decisions` | planet | `planet_id` |
| `get_planetary_features` | planet | `planet_id` |
| `get_terraforming_options` | planet | `planet_id` |
| `get_buildable_megastructures` | fleet | `fleet_id` |
| `get_buildable_ships` | system | `system_id` |
| `get_fleets` | fleet | `fleet_id` |
| `get_system` | system | `system_id` |
| `get_diplomacy_options` | country | `country_id` |

## 执行语义

1. 动作先进执行器的 FIFO 队列，**严格串行**下发（DLL 单连接）；
2. 待执行动作数 ≥ `executor.pauseWhenQueuedActions`（X）时先暂停游戏；
3. 每个动作执行后按 `回读` 列重新读取校验；`soft` 校验失败只记警告，硬校验失败视为本次失败；
4. 单动作最多尝试 `executor.maxAttempts`（Y）次；仍失败则整个任务在该步终止，后续动作标记 `skipped`；
5. 子会话拿到失败详情后换参数重来；用满自己的重试次数后，额外做一次失败分析并上报主会话；
6. 队列排空到 `executor.resumeWhenQueuedActionsBelow` 以下，且暂停是执行器发起的，才会自动恢复。
