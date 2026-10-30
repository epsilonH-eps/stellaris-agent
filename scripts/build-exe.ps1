#requires -Version 5.1
<#
  构建 StellarisAgent.exe：
    1. scripts/bundle-node.ps1 把 node.exe 放进 agent/runtime
    2. 下载/复用 ps2exe，把 agent/gui/StellarisAgent.ps1 编译成根目录 EXE
  产物：repo\StellarisAgent.exe（已在 .gitignore 中）
#>
param(
  [string]$Version = '1.0.1.0'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'bundle-node.ps1')

$build = Join-Path $root 'build-tools'
New-Item -ItemType Directory -Force $build | Out-Null
$zip = Join-Path $build 'ps2exe.zip'
$moduleDir = Join-Path $build 'PS2EXE-master\Module\ps2exe.psd1'
if (-not (Test-Path $moduleDir)) {
  Invoke-WebRequest -Uri 'https://github.com/MScholtes/PS2EXE/archive/refs/heads/master.zip' -OutFile $zip -TimeoutSec 60
  Expand-Archive $zip -DestinationPath $build -Force
}
if (-not (Test-Path $moduleDir)) { throw 'ps2exe 下载/解压失败' }

Import-Module $moduleDir -Force
$input = Join-Path $root 'agent\gui\StellarisAgent.ps1'
$output = Join-Path $root 'StellarisAgent.exe'
Invoke-PS2EXE -InputFile $input -OutputFile $output -NoConsole -STA -Title '群星参谋' -Product 'Stellaris Agent' -Version $Version
Write-Host "已生成：$output"
