# agent/ 应用层

> 这里是 v2 的实现。整体说明看根目录 [`../README.md`](../README.md)，
> 设计细节看 [`../docs/ARCHITECTURE.md`](../docs/ARCHITECTURE.md)。

## 目录

```
bin/stellaris-agent.mjs   CLI 入口（只做 run(process.argv)）
lib/
  app.mjs                 应用装配：配置 + 编排器 + 插件安装/重载
  cli.mjs                 命令实现
  server.mjs              HTTP API + SSE
  config.mjs              DEFAULT_CONFIG / 迁移 / 保存 / 路径
  bridge.mjs              原生桥客户端（单连接、串行、超时、自动重连、注入）
  actions.mjs             动作目录（58 写 / 43 读 + 单位白名单 + 校验 + 回读规格）
  executor.mjs            串行执行器（阈值暂停 / 读回 / Y 次重试 / 失败即止）
  reader.mjs              全量读取（全局 + 每星球 + 每舰队 + 外交 + 银河）
  mods.mjs                模组 / DLC 清单（本地 + 工坊 + dlc_load.json）
  events.mjs              事件图（原版+DLC+模组，带缓存）+ 已激活事件链后续
  save.mjs                存档目录 + 最新 .sav 的 meta（只读 zip 里的 meta）
  world.mjs               轮询 + 差分（完成事件 / 特殊事件触发器）
  chat.mjs                人机聊天总线（in/out/poll/SSE）
  context.mjs             上下文裁剪 + 单位发现
  orchestrator.mjs        编排器（生命周期、派发、事件队列、恢复游戏）
  dsh-plugin.mjs          DSH 插件安装 / 更新 / 热重载
  journal.mjs             按天 JSONL 运行日志
  logger.mjs              文件日志（agent.log）
  ai/
    backend.mjs           后端工厂 + 可用性检查
    deepseek.mjs          API Key 后端
    dsh.mjs               DSH 后端（含端口自动发现、热重载）
    prompts.mjs           三个角色（主/单位/事件）的系统提示词
    protocol.mjs          决策 JSON 解析与规范化
    session.mjs           多轮上下文（带裁剪）
    worker.mjs            单位 / 特殊事件子会话（执行闭环 + 失败分析）
    main.mjs              主会话（收集 → 决策 → 派发）
gui/StellarisAgent.ps1    WinForms 界面（只通过 HTTP 调后端）
native/                   stellaris_bridge.dll + inject.ps1
```

## 常用命令

```powershell
node bin/stellaris-agent.mjs status
node bin/stellaris-agent.mjs read --quick
node bin/stellaris-agent.mjs actions
node bin/stellaris-agent.mjs events index
node bin/stellaris-agent.mjs serve --port 8787
node bin/stellaris-agent.mjs run --once
```

## 约定

1. **写操作只有一条路**：`Executor.submit` → 原生桥。不要在别处直接 `bridge.request('build_*')`。
2. **动作先查表**：新动作加在 `actions.mjs`，并跑 `node tools/gen-actions-doc.mjs`。
3. **AI 只输出 JSON**：两种后端行为一致，不依赖 function calling。
4. **失败要可见**：任何 catch 都要么重抛、要么写进 `errors[]`/journal，不要静默 `catch {}`。
