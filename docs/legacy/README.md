# 旧文档（v1 / 模组时代）

这些文件描述的是 v1 的实现（日志模组 `DSH1` 协议、控制台 `run` + 键盘注入、
`04-stellaris-agent` 独立版、`05-stellaris-autopilot` 自动队列），**v2 已经删除这些链路**。

保留它们只为两件事：

1. 历史背景：为什么后来选择原生桥（DLL 注入 + 命名管道）而不是控制台注入；
2. 4.5 适配知识：`validation-4.5.md` 里对 `ordered_owned_*`、`add_edict`、`pop_amount`
   等 4.5 变更的实测记录仍然有效。

当前实现请看：

- [`../ARCHITECTURE.md`](../ARCHITECTURE.md)
- [`../API.md`](../API.md)
- [`../ACTION-CATALOG.md`](../ACTION-CATALOG.md)
