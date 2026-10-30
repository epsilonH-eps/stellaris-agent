#requires -Version 5.1
<#
  把 dsh-stellaris-bridge 挂进 DSH profile（幂等）。

  说明：这个脚本只是 `stellaris-agent plugin install` 的薄包装，
  实际逻辑在 agent/lib/dsh-plugin.mjs（Node 实现，便于 GUI/服务端复用）。

  装完/改完插件后：
    - 只改 lib/handler.mjs  → POST /api/stellaris-orchestrator/reload 即可
                              （程序启动时也会自动尝试重载）
    - 改了 index.js（shim） → 需要重启 DSH
#>
param(
  [string]$Profile = '',
  [string]$PluginDir = (Split-Path $PSScriptRoot -Parent)
)

$ErrorActionPreference = 'Stop'
$root = Split-Path $PluginDir -Parent
$bin = Join-Path $root 'agent\bin\stellaris-agent.mjs'

$node = $env:STELLARIS_AGENT_NODE
if (-not $node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
  $bundled = Join-Path $root 'agent\runtime\node.exe'
  if (Test-Path $bundled) { $node = $bundled }
}
if (-not $node) { throw '找不到 node；设置 STELLARIS_AGENT_NODE 或把 node 放进 PATH。' }
if (-not (Test-Path $bin)) { throw "找不到 CLI：$bin" }

$argsList = @($bin, 'plugin', 'install')
if ($Profile) { $argsList += @('--profile', $Profile) }
& $node @argsList
exit $LASTEXITCODE
