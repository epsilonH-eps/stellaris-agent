# 群星参谋 · Stellaris Agent

把《群星》(Stellaris 4.5) 的实时数据读出来，交给 DeepSeek 或 DSH 推理，再通过原生桥把操作执行回游戏。

- **实时读取**：原生桥直接读游戏状态（帝国/资源/星球/舰队/外交/事件），不依赖控制台；
- **实时操作**：34 个原生动词，逐项执行、读回验证、失败最多重试 5 次；
- **主控可切换**：本地主会话 + 组件子会话，或交给 DSH 自己的子代理机制；
- **GUI**：原生 WinForms 窗口，启动时选择主控并填写 API Key；
- **可打包 EXE**：内置 Node 运行时，双击即用。

> 当前适配 Stellaris **4.5.2 (9776)**。原生 DLL 绑定游戏版本，游戏更新后需要替换 `agent/native/stellaris_bridge.dll`。

---

## 目录

```
engine/                 读取/编译/执行/存档/事件索引
agent/                  独立应用
  bin/                  CLI
  lib/                  调度、原生桥、推理、队列
  gui/                  WinForms 界面
  native/               原生 DLL + 注入器
  runtime/              node.exe（构建时生成，git 忽略）
dsh-stellaris-bridge/   DSH 插件（DSH 主控模式）
docs/                   协议、动作、DSH 后端、调度说明
scripts/                构建 / 打包 / 安装脚本
run.cmd                 CLI 启动器
run-gui.cmd             GUI 启动器
init.cmd                首次运行：生成配置目录与 config.json
StellarisAgent.exe      构建产物（git 忽略）
```

## 首次运行 / 初始化

首次启动会自动创建：

```
C:\Users\<你>\.stellaris-agent\config.json
```

如果目录不存在，GUI 会先建目录并从 `agent/config.example.json` 生成默认配置；即使还没填 API Key，也能先进入主界面，在「设置」页填写。

命令行也可以手动初始化：

```powershell
.\init.cmd
```

## 快速开始

### 直接用 EXE

1. 双击 `StellarisAgent.exe`（或桌面快捷方式）；
2. 选择主控：
   - **本地主控**：程序自己的主会话 + 组件子会话；
   - **DSH 主控**：DSH 插件负责拉起子会话；
3. 填 DeepSeek API Key；
4. 进入主窗口：战局 / 对话 / 操作 / 原生桥 / 事件链 / 群体调度 / 设置。

API Key、群星安装目录、DSH 地址都在「设置」页修改，保存后自动重启后端。

- **群星安装目录**：留空会自动在常见 Steam 库查找；装在别的盘时点「浏览」选中 `Stellaris` 目录；
- **群星用户目录**：留空会自动找 `Documents`/`OneDrive\Documents`/`OneDrive\文档`，并读取 Windows 的「文档」已知文件夹（文档被 OneDrive 或别的盘接管时也能找到）；找不到时点「浏览」选 `Paradox Interactive\Stellaris`；
- **DSH 地址**：点「自动检测」会扫描 DSH 进程正在监听的端口，并探测 `dsh-stellaris-bridge` 插件；启动选择主控时也会自动检测一次。

如果状态栏显示 `群星: 运行中（桥未连）`，点状态栏的 **「连接群星」**；原生桥会注入游戏进程。注入成功但显示“还在主菜单”时，读档或新开一局即可。

## 出错了怎么给日志

- GUI：设置 → **导出诊断日志**，会生成 `%USERPROFILE%\.stellaris-agent\diagnostics-*.json`；
- 命令行：`.\run.cmd doctor`；
- 运行日志：`%USERPROFILE%\.stellaris-agent\logs\agent.log`（后端 stdout/err 在同目录的 `backend.*.log`）。

诊断文件不含 API Key 明文，只有“是否已配置”。

### 从源码

```powershell
# 需要 Node 22+
.\run.cmd status
.\run.cmd native-status
.\run.cmd swarm
.\run-gui.cmd
```

### 构建 EXE

```powershell
.\scripts\build-exe.ps1
```

会先把 `node.exe` 复制到 `agent/runtime/`，再用 ps2exe 把 GUI 编译成根目录的 `StellarisAgent.exe`。

## 原生桥

`agent/native/stellaris_bridge.dll` 由注入器加载进游戏进程，通过命名管道提供 JSON-RPC：

```
Windows 程序 → \\.\pipe\stellaris_mcp_bridge → 游戏线程执行引擎命令
```

常用命令：

```powershell
.\run.cmd native-status          # 实时状态
.\run.cmd native-read            # 全量读取
.\run.cmd verbs                  # 34 个原生动词
.\run.cmd do move_fleet '{"fleet_id":3,"system_id":107}'
.\run.cmd swarm --backend local  # 本地编排
.\run.cmd swarm --backend dsh    # DSH 编排
```

## DSH 插件

`dsh-stellaris-bridge/` 是 DSH 侧编排后端：

- `GET /api/stellaris-orchestrator/health`
- `POST /api/stellaris-orchestrator/run`
- `POST /api/stellaris-orchestrator/team`：让 DSH 用自己的子代理机制组织工作

安装：

```powershell
.\scripts\install-dsh-plugin.ps1
```

安装后需要**重启 DSH** 才会加载插件。

## 配置

配置在 `C:\Users\admin\.stellaris-agent\config.json`（不随仓库走）：

```json
{
  "deepseek": { "apiKey": "sk-..." },
  "swarm": {
    "backend": "local",
    "dshUrl": "http://127.0.0.1:49939",
    "tickSeconds": 60,
    "mainTickSeconds": 180,
    "queuePauseThreshold": 10
  }
}
```

## 说明

- 原生桥模式**不需要模组**；状态栏里没有 `DSH Reader`/`DSH Console` 时只显示「原生桥模式（模组可选）」，不是故障；
- 原生桥是**版本绑定**的，4.5.2 之外不保证可用；
- 执行器严格串行；队列达到阈值会暂停游戏，操作阻塞时保持暂停；
- 本地模式不依赖 DSH；DSH 模式只替换“谁思考/谁拆会话”，游戏执行仍由本地程序负责。

## License

MIT。原生桥 DLL 的上游来源与许可见 `agent/native/NOTICE.md`。
