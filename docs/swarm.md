# 群体调度（swarm）

主会话负责判断，组件子会话负责单点规划，执行器串行落地。

## 拓扑

```
主会话 swarm-main（每 mainTickSeconds）
  ├─ 看全局：日期/资源/殖民地/舰队/接触/队列/活跃组件/完成事件
  ├─ 只输出 JSON 指令：pause、unpause、reset、intervals、disabled、enabled
  └─ 不直接操作游戏

组件子会话 swarm-planet:3 / swarm-fleet:3 / …
  ├─ 每 tickSeconds（可按组件覆盖）
  ├─ 上下文：全局摘要 + 本组件详情 + 候选列表 + 上次动作 + 完成事件
  └─ 只输出 ```stellaris-native 步骤，不执行

执行器
  ├─ 严格 FIFO；同一组件有在途步骤时拒绝新指令
  ├─ 队列 >= queuePauseThreshold（默认 10）→ 暂停游戏并排空
  ├─ 低于阈值时按顺序执行，不强行暂停
  ├─ 任一步超时/被拒 → 保持暂停，最多重试 attempts（默认 5）
  └─ 失败不自动重排，交回主会话
```

## 配置

```json
"swarm": {
  "tickSeconds": 60,
  "mainTickSeconds": 180,
  "watchSeconds": 15,
  "megastructureScanSeconds": 300,
  "queuePauseThreshold": 10,
  "attempts": 5,
  "autoUnpause": false,
  "objective": "可选：长期战略目标",
  "components": [
    { "id": "fleet:3", "type": "fleet", "key": 3, "name": "第1舰队", "intervalSeconds": 45 },
    { "id": "planet:3", "type": "planet", "key": 3, "name": "地球", "intervalSeconds": 90 }
  ]
}
```

不写 `components` 时自动发现：每颗殖民地 → `planet:<id>`，每支军事舰队 → `fleet:<id>`。

## 命令

```powershell
.\run.cmd swarm
.\run.cmd swarm --once --plan-only            # 只规划，不执行
.\run.cmd swarm --goal "科研优先工程学" --tick 30 --main-tick 120
```

## 动词约束

子会话只能使用原生桥的 34 个动词（`run.cmd verbs` 可查）。常见 DSL 别名会自动转换：

| 子会话写出 | 自动转成 |
| --- | --- |
| `send_fleet` | `move_fleet` |
| `fleet_stance` | `set_fleet_stance` |
| `add_building` | `build_building` |
| `add_district` | `build_district` |
| `add_perk` | `adopt_ascension_perk` |
| `event` | `resolve_event` |
| `open_ui` | `show_panel` |

组件方法白名单：

- `planet`：`build_building`、`build_district`、`set_district_zone`、`set_job_priority`
- `fleet`：`move_fleet`、`survey`、`set_fleet_stance`、`follow_fleet`、`reinforce_fleet`、`merge_fleets`、`build_outpost`、`build_stations`、`colonize`、`upgrade_fleet`、`build_ship`

星球建造参数会用候选列表校验：`build_building` 必须命中 `buildable[].key` + `zone_id` + `district_type`；`build_district` 必须命中 `districts.buildable[].key`。不合法步骤直接丢弃，不送执行器。

## 完成事件

`watch()` 每 `watchSeconds` 对比世界快照，产出增量事件给主会话/相关组件：

- `research_started` / `research_completed`
- `construction_started` / `construction_completed`
- `ship_completed`
- `fleet_order_completed`
- `colony_established` / `outpost_completed`
- `army_recruitment_started/completed`、`army_count_changed`
- `pop_grown` / `pop_lost`
- `starbase_upgraded`
- `megastructure_started/upgraded/completed/lost`
- 新通知（`notification`）

采矿/研究站不再单独反馈。

巨构每 `megastructureScanSeconds` 扫一次：`get_galaxy_map(jumps=60)` 找 flags 含 `M` 的星系，再读 `get_system.megastructures`。

## 已知边界

- 原生桥是**单连接**：swarm 持有管道时，子会话不能再开 `native_read` 工具；因此子会话 `useTools:false`，全局数据由 prompt 提供；
- 巨构扫描范围是 `jumps=60` 内已知星系；
- 队列 >=10 的暂停/排空逻辑已实现，但当前测试局组件多次判断「无必要操作」，尚未压满 10 条实测。
