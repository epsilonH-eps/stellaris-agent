# Stellaris native bridge provenance

Upstream: https://github.com/Yidhar/stellaris-mcp (MIT; `LICENSE-stellaris-mcp` retained here).

Pinned upstream source: `6cc8e82013f88d7ef51d906f3cdfa44054b7a250` / `v0.5.1`.

## 本仓库实际携带的二进制

| 项 | 值 |
| --- | --- |
| 文件 | `agent/native/stellaris_bridge.dll` |
| 大小 | 1 766 912 字节 |
| SHA-256 | `f0feb0e36157c94734675e7585b565d87d93ad310c03147d414d408202fa1dd9` |

> **注意（v2 更正）**：此前的记录写了三个哈希（官方 DLL、`cyberfish-0.1`、`cyberfish-0.6.1`），
> 它们都**不匹配**仓库里这个文件；当时引用的 `cyberfish-0.1.patch` / `cyberfish-0.6.1.patch`
> 也从未进入仓库。上面的哈希是本次实测值，请以它为准。
>
> 若你要重新构建：从 pinned 上游 commit 出发，按下面的变更说明打补丁，
> 构建后把新哈希写回本文件，并同时提交补丁与构建脚本（当前仓库不含补丁文件）。

上游原始 DLL 的 SHA-256 记录为 `33397bfb804c299ca289c358808abee64f1cd146478229de8170b2f984cc302d`
（仅供比对，不随本仓库发布）。

## 本地扩展（相对 pinned 上游）

- 民用领袖通过 ship handle 查找，不再假设 fleet/ship handle 相同；包含 `ship_id` / `leader_id`；
- 使用当前版本的 `CFleetBuildOrbitalStationCommand` 下发系统级采矿/研究站命令，走原生校验与 session 队列；
- Pin MinHook v1.3.4，依赖浅拉取；
- 原生 backbuffer 证据、镜头/面板呈现；
- 受约束的军事模板与补员；完整代际的对外国家句柄；
- 正常外交提议/回应；合法的传统/飞升候选；
- 主要战争状态与防御战争目标；专门的"宣战确认"信息路径；
- 议会任命走原生 `AddToCouncil`，只审计三个原版职位类别（修正生成 SDK 里被交换的议会数据库/空对象全局）；
- 防御扫描只暴露玩家情报等级足够的外国舰队（foreign ≠ 敌对）；
- 战术扩展：同星系合流（引擎深拷贝舰队引用数组）、合法候选查询、真实海军规模与 UI 格式军力（Q15）。

自定义 dispatcher 仍挂在游戏原有的主线程 `TaskQueue` 上；**不覆盖游戏可执行文件，也不绕过资源/命令校验**。

## 运行时与构建

- 运行时产物原本位于 `.local/native-bridge/runtime/cyberfish-0.6.1/`（`.local/` 被 git 忽略）；
- 构建：Visual Studio 2022 Build Tools 17.14.42，x64 Release，CMake 4.4.4；
- 桥的日志/设置留在项目运行时目录，不写游戏目录。

## 许可边界

- `agent/native/LICENSE-stellaris-mcp`：上游 MIT 许可，随二进制保留；
- 上游提到 `native/research` 下的只读身份/研究辅助代码使用 **GPL-3.0-only**（基于 OGAS）。
  **本仓库不包含该目录**，因此不构成 GPL 代码的分发；若你把它加回来，请单独保留其 GPL 许可与来源说明，
  不要用本文件的 MIT 声明覆盖它。
