# HTTP API

默认 `http://127.0.0.1:8787`（`chat.port` 可改）。只绑回环地址。

鉴权：`chat.token` 为空时不校验；非空时需 `Authorization: Bearer <token>` 或 `?token=<token>`。

约定：

- 成功 `{ "ok": true, ... }`；
- 失败 `{ "ok": false, "error": "<短码>", "detail": ... }`；
- 错误码：`UNAUTHORIZED` / `ORCHESTRATOR_NOT_RUNNING` / `GAME_NOT_RUNNING` / `GAME_NOT_IN_SESSION` /
  `MISSING_API_KEY` / `DSH_UNAVAILABLE` / `EXPECTED_ACTIONS` / `VALIDATION` / `NOT_FOUND`。

---

## 状态

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | `{ok,name,version,running}` |
| GET | `/api/status` | 路径、后端、编排器、执行器、单位、事件、模组、存档 |
| GET | `/api/brief` | 人读的一行战局摘要 |
| GET | `/api/diagnostics` | 诊断包（配置已脱敏、日志尾部、插件版本、不支持的方法） |
| GET | `/api/readiness` | **连接状态**：大模型是否连上 + 游戏是否连上；`?verify=1` 真发一次请求验证 Key |
| POST | `/api/connect` | 立即连接（必要时注入）；`{start?:boolean}` 控制是否同时启动调度 |

`/api/readiness` 示例（状态栏用）：

```json
{
  "ok": true,
  "llm": { "ok": true, "backend": "dsh", "label": "DSH", "detail": "DSH http://127.0.0.1:52639", "verified": true },
  "game": { "ok": true, "inGame": true, "date": "2200.01.01", "detail": "原生桥已连接", "injected": false },
  "running": true,
  "autoInject": true,
  "autoStart": true,
  "lastConnect": { "ok": true, "injected": true, "at": 1793351976562 }
}
```

`/api/connect` 返回 `{ok, injected, started, error, readiness}`。

`/api/status` 里的关键字段：

```json
{
  "ok": true,
  "running": true,
  "backend": "deepseek",
  "paths": { "userDir": "…", "installDir": "…", "saveDir": "…" },
  "orchestrator": {
    "objective": "…",
    "bridge": { "connected": true, "injected": false, "stats": {} },
    "backend": { "backend": "deepseek", "model": "deepseek-chat", "ok": true },
    "world": { "date": "2200.01.01", "colonies": 1, "fleets": 4, "activeEvents": 0 },
    "executor": { "queuedActions": 0, "pausedByUs": false, "running": false },
    "main": { "lastTickAt": 0, "turns": 3, "lastDecision": {} },
    "units": [ { "id": "planet:3", "type": "planet", "running": false } ],
    "events": { "graph": {}, "active": 0, "queued": 0 },
    "mods": { "enabled": 0, "total": 37 },
    "save": { "dir": "…", "latest": "2200.01.01.sav" }
  }
}
```

---

## 读取

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/world` | 世界快照（压缩版）；`?full=1` 返回原始全量 |
| GET | `/api/world/events` | 已激活事件链 + 后续 + 事件索引状态 + 警报 |
| GET | `/api/mods` | 模组 / DLC 清单（含启用状态与事件目录） |
| GET | `/api/actions` | 动作表；`?unit=planet` 过滤 |
| GET | `/api/units` | 当前 1:1 单位及状态 |
| GET | `/api/events/search?q=` | 搜事件定义 |
| GET | `/api/events/chain?id=&depth=6` | 某事件的后续树 |
| POST | `/api/refresh` | 立即重读；`{deep:true}` |
| GET | `/api/executor` | 执行器队列/暂停/历史 |

`/api/world/events` 示例：

```json
{
  "ok": true,
  "active": [
    {
      "windowId": 3,
      "id": "distar.100",
      "title": "来自深渊",
      "options": [{ "text": "打开", "enabled": true }],
      "chain": {
        "root": { "id": "distar.100", "title": "来自深渊" },
        "nodes": [
          { "id": "distar.100", "level": 0, "title": "来自深渊" },
          { "id": "distar.105", "level": 1, "title": "回响", "hidden": false }
        ]
      }
    }
  ],
  "unresolved": [],
  "index": { "ready": true, "events": 9859, "files": 171, "cacheHit": true }
}
```

---

## 执行

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/execute` | `{actions:[...], unit?}` → 走执行器并等待结果 |
| POST | `/api/pause` | 暂停游戏 |
| POST | `/api/resume` | 恢复游戏 |

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:8787/api/execute `
  -ContentType 'application/json; charset=utf-8' `
  -Body '{"actions":[{"method":"set_speed","params":{"speed":2}}]}'
```

返回 `JobResult`（见 `docs/ARCHITECTURE.md` §5）。动作校验失败返回 422 + `errors[]`。
编排器未启动时返回 409 `ORCHESTRATOR_NOT_RUNNING`。

---

## 编排

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/orchestrator/start` | `{objective?}`；全量读取 + 主会话循环 |
| POST | `/api/orchestrator/stop` | `{resume?:true, suppressAuto?:true}` 停止（默认恢复游戏，并给自动接管 5 分钟冷静期） |
| POST | `/api/orchestrator/restart` | 重启（设置变更后用） |
| POST | `/api/orchestrator/objective` | `{objective}` 更新战略目标 |

---

## 会话（界面用）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/sessions` | 会话列表：主会话置顶，其后是 1:1 单位与最近的特殊事件 |
| GET | `/api/sessions/<id>` | 单个会话详情：`system` + 带时间戳的 `messages` + 最近报告/决策 |

`GET /api/sessions` 摘要项：

```json
{
  "ok": true,
  "sessions": [
    { "id": "main", "kind": "main", "label": "主会话", "status": "ok", "running": false,
      "turns": 3, "messageCount": 9, "updatedAt": 1793351976562, "say": "先补合金" },
    { "id": "planet:3", "kind": "unit", "type": "planet", "label": "planet · 地球",
      "status": "ok", "running": false, "turns": 5, "messageCount": 12, "goal": "把合金提上去" },
    { "id": "event:9", "kind": "event", "label": "特殊事件 · 总统换届", "status": "ok",
      "windowId": 9, "endedAt": 1793351980000 }
  ]
}
```

`GET /api/sessions/planet:3`（id 需 URL 编码）：

```json
{
  "ok": true,
  "session": {
    "id": "planet:3",
    "kind": "unit",
    "label": "planet · 地球",
    "status": "ok",
    "system": "……",
    "systemChars": 3210,
    "messages": [
      { "role": "user", "ts": 1793351976000, "chars": 8123, "content": "……" },
      { "role": "assistant", "ts": 1793351979000, "chars": 240, "content": "……" }
    ],
    "lastReport": { "status": "ok", "say": "建好了", "cause": "", "suggestion": "", "attempts": 1 },
    "lastResult": { "ok": true, "summary": "1/1 成功", "actions": [] }
  }
}
```

特殊事件会话处理完会保留在列表里（`endedAt` 有值），直到被新的顶掉（最多 12 个）。

---

## 聊天（人 ⇄ 主会话）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/chat/in` | **人说话**：`{id, text}`（`name`/`meta` 可选） |
| POST | `/api/chat/out` | 外部程序代发一条出站消息：`{text, id?}` |
| GET | `/api/chat/poll?since=` | 拉取新消息（`since` = 上一条 `seq`） |
| GET | `/api/chat/out?since=` | 同 poll（兼容用） |
| GET | `/api/chat/history?limit=` | 最近历史 |
| GET | `/api/chat/stream` | SSE：`event: chat`，`{direction:'in'|'out', id, text, seq}` |

入站示例：

```json
POST /api/chat/in
{ "id": "player:heyik", "text": "合金太低了，想办法提上去" }
```

出站消息的 `id` 表示"谁在说"：`main`（主会话）、`system`（系统提示）、`unit`（子会话上报）。

---

## 设置与插件

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/settings` | 当前配置（Key 脱敏为 `apiKeyConfigured` / `apiKeyHint`） |
| POST | `/api/settings` | 局部更新（与 config.json 同构）；运行中会自动重启编排器 |
| POST | `/api/plugin/install` | 安装/更新 DSH 插件（`{copy?}`） |
| POST | `/api/plugin/update` | 安装 + 尝试热重载（`{allowRestart?}`） |
| POST | `/api/plugin/reload` | 只热重载（`{allowRestart?}`；仅允许在配置了 `restartCommand` 时才重启 DSH） |
| GET | `/api/dsh/discover` | 扫进程端口 + 探测插件 |

设置示例：

```json
POST /api/settings
{
  "paths": { "stellarisInstallDir": "E:/SteamLibrary/steamapps/common/Stellaris",
             "stellarisUserDir": "D:/Users/me/Documents/Paradox Interactive/Stellaris",
             "saveDir": "" },
  "ai": {
    "backend": "dsh",
    "deepseek": { "apiKey": "" },
    "dsh": { "url": "http://127.0.0.1:52639" },
    "main": { "intervalSeconds": 120 }
  },
  "executor": { "pauseWhenQueuedActions": 8, "maxAttempts": 3 }
}
```

`ai.deepseek.apiKey` 传空字符串表示"保持原值"（GUI 的掩码输入依赖这个语义）。
