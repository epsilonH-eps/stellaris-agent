# 编排后端：本地 / DSH

程序默认用本地编排（`lib/swarm.mjs`：主会话 + 组件子会话 + 执行器）。
把 `swarm.backend` 改成 `dsh` 后，**思考层**交给 DSH，游戏执行仍由本地程序负责。

## 两种模式

| | local（默认） | dsh |
| --- | --- | --- |
| 主会话 | 程序里的 `swarm-main` | DSH agent |
| 组件子会话 | 程序按 `planet:<id>`/`fleet:<id>` 起 | **DSH 自己的子代理机制** |
| 游戏执行 | 本地原生桥 | 本地原生桥（不变） |
| 队列/暂停/完成事件 | 本地 | 本地（不变） |

## DSH 插件

目录：`D:\stellaris-agent\dsh-stellaris-bridge`

- `index.js`：注册 `/api/stellaris-orchestrator/*`
  - `GET /health`
  - `POST /run`：起一个 DSH 子会话
  - `POST /team`：起 DSH 主会话，提示它**用 DSH 自己的子代理/委派逻辑**组织工作
- 通过 `ctx.subagents.startActivation({ provider: 'spawn' })` 拉起会话，`run.result` 取输出；
- 已挂进 profile：`dsh-stellaris-bridge`（dependency + bundle + junction）。

安装脚本：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File D:\stellaris-agent\dsh-stellaris-bridge\install.ps1
```

**装完/改完插件要重启 DSH 才生效**（当前会话不会热加载 host 插件）。

## 程序侧

`agent/lib/dsh-orchestrator.mjs` 是 HTTP 客户端。
`agent/lib/swarm.mjs`：

```js
this.runner = settings.backend === 'dsh'
  ? new DSHOrchestrator({ baseUrl: settings.dshUrl })
  : orchestrator
```

- `local`：原逻辑完全不变；
- `dsh`：
  - 不再逐个组件起本地子会话；
  - 每 `tickSeconds` 调一次 `/team`，把全局状态、组件列表、完成事件交给 DSH；
  - DSH 在自己的进程内组织子会话，返回 stellaris-native 步骤；
  - 本地 `normalizeSteps` → 队列 → 执行器/暂停/验证，和本地模式一致。

## 配置

```json
"swarm": {
  "backend": "dsh",
  "dshUrl": "http://127.0.0.1:49939",
  "tickSeconds": 60,
  "queuePauseThreshold": 10
}
```

`dshUrl` 不用手填死：设置页点「自动检测」，或启动时选择 DSH，程序会扫描 DSH 进程监听端口并探测 `dsh-stellaris-bridge` 插件；也可以命令行：

```powershell
.\run.cmd dsh-discover
```

## 命令

```powershell
D:\stellaris-agent\run.cmd swarm --once --plan-only --backend local
D:\stellaris-agent\run.cmd swarm --backend dsh --dsh-url http://127.0.0.1:49939
```

## 注意

- DSH 模式只替换“谁思考/谁拆子会话”，执行器仍是本地串行队列，不会两个进程同时操作游戏；
- DSH 子会话默认不能直接调用游戏原生桥；它们输出步骤，由本地执行；
- 本地模式不依赖 DSH，插件没装/DSH 没开也不影响。
