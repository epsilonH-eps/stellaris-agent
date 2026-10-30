#requires -Version 5.1
<#
  把 Node 运行时复制进 agent/runtime/node.exe，生成的 EXE 就不依赖用户装 Node。
  优先 STELLARIS_AGENT_NODE，其次 PATH，最后 DSH 自带 runtime。
#>
param(
  [string]$NodePath = $env:STELLARIS_AGENT_NODE
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$targetDir = Join-Path $root 'agent\runtime'
$target = Join-Path $targetDir 'node.exe'

if (-not $NodePath) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $NodePath = $cmd.Source }
}
if (-not $NodePath) {
  $fallback = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $fallback) { $NodePath = $fallback }
}
if (-not $NodePath -or -not (Test-Path $NodePath)) { throw '找不到 node.exe；设置 STELLARIS_AGENT_NODE 或把 node 放进 PATH。' }

New-Item -ItemType Directory -Force $targetDir | Out-Null
Copy-Item $NodePath $target -Force
Write-Host "已复制 Node 运行时：$target"
