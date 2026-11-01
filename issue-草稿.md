# 议题：AI 不会派特使、也不会点飞升天赋——原生桥缺对应 RPC

## 现象

开着一局玩了两天，主会话能管星球、舰队、研究、传统、法令，但这两件事从来没动过：

1. **特使（Envoy）从来不派**——不会安排到「提升关系 / 间谍网 / 星系协助」任何任务上，哪怕外交子会话在看关系。
2. **飞升天赋（Ascension Perk）从来不点**——攒到天赋槽也不选，传统树倒是会推。

## 排查

我这边查了 v2 的动作表（`actions --json`，60 条）和读取层：

- 动作表里 `laws` 组只有 `toggle_edict` / `adopt_tradition` / `set_species_rights`，**没有飞升**；
- 读取层 `get_traditions` 的返回里**有** `ascension_perks` 和 `ascension_perk_slots_available`（`context.mjs:124` 已经在用 `world.traditions.ascension_perks`），说明数据能读到；
- v1 的文档（`docs/legacy/INTEGRATION.md`、`docs/legacy/verification.md`）里列过 `adopt_ascension_perk` / `get_ascension_candidates`，v2 重写后这条丢了。

然后扫了 `agent/native/stellaris_bridge.dll` 里的字符串：

**飞升（有命令类，没看到 RPC 入口）**

```
activate_ascension_perk_command     ← 命令类有
ascension_perk / ascension_perks / ascension_perk_slots_available   ← 数据字段有
ascension_posted                     ← 像是执行后的标志
```

但和传统对比：

```
adopt_tradition                      ← 传统：RPC 方法名在
activate_tradition_command           ← 传统：命令类也在
```

即传统是「RPC 名 + 命令类」都有，飞升只有命令类。DLL 里搜不到 `adopt_ascension_perk` / `activate_ascension_perk` 这样的 RPC 名字，所以从 JS 侧发不出去。

**特使（完全没有）**

在 DLL 的全部字符串里搜 `envoy`：**0 条**。既没有 `get_envoys` 也没有 `set_envoy_task` 之类。读取层 `get_contacts` 的返回我也看过，没有特使字段。

## 建议

如果要补，我理解需要动 DLL 一侧（C++），我这边只能从 JS 侧发电：

1. **飞升**：把已经存在的 `activate_ascension_perk_command` 包成一个 RPC，命名对齐传统，比如 `adopt_ascension_perk`，参数 `{ perk_key: string }`；读取侧把 `get_traditions` 里的候选正式暴露成 `ascension_perks_candidates`（现在只有已解锁列表）。JS 侧我可以补动作表 + 子会话提示。
2. **特使**：需要新的读（`get_envoys`：每个特使的 id / 当前任务 / 可用任务）和写（`assign_envoy`：`{ envoy_id, task, target_country_id? }`）。任务枚举按游戏里那几种（`diplomatic_relation` / `espionage` / `galactic_community` / `federation`）来就行。

## 我能帮上的

如果作者愿意给 RPC 端点，我可以把 JS 侧的动作、读取、子会话提示、动作目录文档一起补上并提 PR（我在本地已经把 `adopt_ascension_perk` 的动作条目写好了，等端点确认就能接）。

现在这版我先不硬改：没有端点的话，JS 侧加了也只是发一个必然失败的调用。

---

（附：这台机器上的环境是 Windows 11 + 群星 4.5.2，用 DSH 插件后端跑的主会话，`doctor` 全绿。）
