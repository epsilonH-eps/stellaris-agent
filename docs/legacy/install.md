# 安装 / 卸载 / 发布

## 0. 前置

- 《群星》**4.5**，Windows，游戏至少启动过一次（这样用户目录才存在）。
- 用户目录通常是：
  `%USERPROFILE%\Documents\Paradox Interactive\Stellaris`
  如果开了 OneDrive 文档同步，会在
  `%USERPROFILE%\OneDrive\Documents\Paradox Interactive\Stellaris`。
  桥会自动探测这两处；都不对就手动填 `stellarisUserDir`。
- DSH 桌面版（cordis profile 布局），Node ≥ 22。

---

## 1. 装两个模组

```powershell
cd D:\paradox-dsh-bridge
./tools/install-mods.ps1 -WhatIf     # 先看它会做什么
./tools/install-mods.ps1             # 真装
```

脚本做三件事：

1. 把 `01-stellaris-reader/`、`02-stellaris-console/` **复制**（不是移动）到
   `<用户目录>\mod\dsh_reader\` 与 `...\mod\dsh_console\`；
2. 在 `<用户目录>\mod\` 下写 `dsh_reader.mod`、`dsh_console.mod`（启动器只认这一层）；
3. 打印启动器里应勾选的两个条目名。

> 为什么复制而不是软链：Steam 启动器和创意工坊上传都按真实目录扫描；软链在部分 Windows 配置下会被忽略。重复安装会覆盖，**不会动你的存档**。

手动安装等价结构：

```
Documents\Paradox Interactive\Stellaris\
├─ mod\
│  ├─ dsh_reader.mod          ← 描述文件（name/path/tags/supported_version）
│  ├─ dsh_console.mod
│  ├─ dsh_reader\             ← 模组本体（descriptor.mod 在里面）
│  └─ dsh_console\
└─ logs\                      ← 运行时由游戏生成
```

`dsh_reader.mod` 内容示例：

```
name="DSH Reader"
path="mod/dsh_reader"
tags={ "Utilities" }
supported_version="4.5.*"
```

`path` 用**正斜杠**、相对用户目录，这是启动器的约定。

### 在启动器里启用

1. 打开群星启动器 → **所有已安装的模组**；
2. 勾选 `DSH Reader`、`DSH Console`（两个都行，顺序无所谓）；
3. 启动游戏；读档后在控制台敲 `event dsh_console.10`，能弹出「DSH 面板」就说明装载成功。

### 排序 / 冲突

- 两个模组都只**新增**文件，不改原版文件（没有 `replace_path`），所以和绝大多数模组共存。
- 若你用了改 `on_actions` 的整合包，确保它没有覆盖 `on_monthly_pulse_country`（本模组用 `on_actions` 的**追加**语法，正常不冲突）。

---

## 2. 装 DSH 插件

```powershell
dsh plugin --profile desktop add link:D:\paradox-dsh-bridge\03-dsh-stellaris-bridge
```

等价于在 `~/.dsh/profiles/desktop/package.json` 的 `dependencies` 里加
`"dsh-stellaris-bridge": "link:D:/paradox-dsh-bridge/03-dsh-stellaris-bridge"`，
再 `dsh plugin install`（或让插件管理器重装一次 profile）。

装完**重启 DSH**，然后：

```
stellaris_status
```

正常会看到 `userDir`、`logTail.ok`、`mods.reader/mod` 三项。

### 配置

配置文件：`~/.dsh/stellaris-bridge/config.json`（首次调用工具时自动生成）。

```jsonc
{
  "enabled": true,
  "stellarisUserDir": "",           // 空 = 自动探测
  "gameTitleMatch": "Stellaris",    // 窗口标题包含
  "consoleKey": "`",                // 控制台开关键，US 布局是 ` 或 ~
  "injection": "auto",              // auto | manual
  "ackTimeoutMs": 6000,
  "uiMode": "hotkey",               // hotkey | effect | terminal
  "uiHotkeys": { "ascension": "F5", "traditions": "F4", "technology": "F2" },
  "safety": {
    "allowExperimental": false,
    "maxResourcePerAction": 50000,
    "requireConfirmOver": 3
  },
  "liveChat": { "enabled": true, "token": "", "maxQueue": 200 }
}
```

改完不用重启：工具每次调用都会重读（文件 mtime 变了就热加载）。

---

## 3. 创意工坊发布

一个模组一个工坊条目，两个都要单独传：

1. 用启动器的 **Mod Tools → Upload Mod**（或 `steamcmd` + `workshop_build_item`）；
2. 上传目录指向 `01-stellaris-reader/`（里面已有 `descriptor.mod` 和 `thumbnail.png`）；
3. `supported_version` 保持 `4.5.*`；`tags` 建议 `Utilities`、`Gameplay`；
4. 上传前把 `descriptor.mod` 里的 `path` 去掉（工坊包不需要指向本地目录）。

> 工坊版和本地版**不要同时启用**，会重复注册 `on_action`，导致每月导出两次。桥能容忍（按 `snap` 去重），但没必要。

---

## 4. 卸载

```powershell
./tools/install-mods.ps1 -Uninstall        # 删 mod\dsh_reader、dsh_console 及 .mod
dsh plugin --profile desktop remove dsh-stellaris-bridge
```

配置与缓存留在 `~/.dsh/stellaris-bridge/`，要彻底清就删这个目录。

---

## 5. 常见问题

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `stellaris_status` 说找不到用户目录 | OneDrive 重定向 / 非默认盘 | 手动填 `stellarisUserDir` |
| 日志没有 `DSH1` 行 | 模组没启用 / 不是 4.5 | 启动器里确认两个模组都勾了 |
| 有 `ACK recv` 没 `done` | effect 报错 | 看工具返回的 `errorLog`；多半是 `experimental` 动作 |
| 注入后没反应 | 窗口没焦点 / 控制台键不对 | `stellaris_calibrate_ui` 或改 `consoleKey`，或设 `manual` |
| 铁人档 | 控制台被禁 | 只能读；写操作会返回 `IRONMAN` |
| 中文星球名匹配不到 | 名字里有全角空格/特殊符号 | 用 `ord` 或 `"capital"` 寻址 |
---

## 6. v0.2 的额外配置

`jsonc
{
  "maxLanes": 8,            // 同时允许多少条子会话操作通道
  "liveChat": { "enabled": true, "token": "…" }
}
`

新增的运行时文件都在 ~/.dsh/stellaris-bridge/：

| 文件 | 内容 |
| --- | --- |
| lanes.json | sessionId ↔ lane 绑定表 |
| 	imeline.json | 事件账本（最多 1200 条） |
| snapshot.json | 最近一次快照缓存 |
| cache/ | 解压后的存档（按 mtime 分目录） |

删掉它们不会坏，只会丢历史（lane 会重新分配、账本清空）。

---

## 7. v0.3 的额外配置

```jsonc
{
  "stellarisInstallDir": "",        // 事件定义解析用；空 = 自动探测 Steam 库
  "operator": {                     // 把具体操作转发给一个专门子会话
    "session": "",
    "autoDelegate": false
  }
}
```

新增运行时目录：

| 路径 | 内容 |
| --- | --- |
| `journal/index.json` | 当前局 + 历史局 |
| `journal/<gameId>.jsonl/.md` | 每局日志 |
| `lanes.json` | 子会话通道绑定 |

`stellarisInstallDir` 找不到时，`stellaris_event_info` 会返回 `INSTALL_NOT_FOUND`
并列出探测过的路径；这不会影响读档与操作。

---

## 8. 独立软件（04，不需要 DSH）

```powershell
# 配 key
notepad "$env:USERPROFILE\.stellaris-agent\config.json"   # deepseek.apiKey

# 直接用（run.cmd 会找 node / DSH 自带 node）
.\04-stellaris-agent\run.cmd status
.\04-stellaris-agent\run.cmd selftest
.\04-stellaris-agent\run.cmd ask "看一下现在的局势"

# 本地面板 + 直播接口
.\04-stellaris-agent\run.cmd serve
```

打包成自洽目录：

```powershell
node tools/bundle-agent.mjs     # 生成 dist\stellaris-agent\
dist\stellaris-agent\run.cmd status
```

注意：

- 独立软件与 DSH 插件**二选一运行**，同时开会抢控制台。
- 它有自己的配置与日志目录：`%USERPROFILE%\.stellaris-agent\`（DSH 插件仍在 `~/.dsh/stellaris-bridge/`）。
- `run.cmd` 的 node 查找顺序：`STELLARIS_AGENT_NODE` → PATH → DSH 自带运行时。
