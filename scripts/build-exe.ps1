#requires -Version 5.1
<#
  构建 StellarisAgent.exe：
    1. scripts/bundle-node.ps1 把 node.exe 放进 agent/runtime
    2. 找 ps2exe（已装模块 > PSGallery 安装 > GitHub 压缩包），把 GUI 编译成根目录 EXE
  产物：repo\StellarisAgent.exe（已在 .gitignore 中）

  备注：PS2EXE 的 GitHub 仓库已 404，优先用 PSGallery。
#>
param(
  [string]$Version = '2.0.0.0'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
& (Join-Path $PSScriptRoot 'bundle-node.ps1')

$build = Join-Path $root 'build-tools'
New-Item -ItemType Directory -Force $build | Out-Null

function Find-Ps2ExeModule {
  $installed = Get-Module -ListAvailable ps2exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($installed) { return $installed.Path }
  $cached = Get-ChildItem -Path $build -Directory -Filter 'PS2EXE-*' -ErrorAction SilentlyContinue |
    ForEach-Object { Join-Path $_.FullName 'Module\ps2exe.psd1' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
  return $cached
}

$moduleDir = Find-Ps2ExeModule
if (-not $moduleDir) {
  Write-Host 'ps2exe 未安装，尝试从 PSGallery 安装…'
  try {
    if (-not (Get-PackageProvider -Name NuGet -ErrorAction SilentlyContinue)) {
      Install-PackageProvider -Name NuGet -MinimumVersion 2.8.5.201 -Force -Scope CurrentUser | Out-Null
    }
    Install-Module -Name ps2exe -Scope CurrentUser -Force -AllowClobber -Confirm:$false -ErrorAction Stop
    $moduleDir = Find-Ps2ExeModule
  } catch {
    Write-Host "PSGallery 安装失败：$($_.Exception.Message)"
  }
}
if (-not $moduleDir) {
  $zip = Join-Path $build 'ps2exe.zip'
  foreach ($url in @(
      'https://codeload.github.com/MScholtes/PS2EXE/zip/refs/heads/master',
      'https://codeload.github.com/MScholtes/PS2EXE/zip/refs/heads/main'
    )) {
    try {
      Write-Host "下载 ps2exe：$url"
      Invoke-WebRequest -Uri $url -OutFile $zip -TimeoutSec 90 -UseBasicParsing
      Expand-Archive $zip -DestinationPath $build -Force
      $moduleDir = Find-Ps2ExeModule
      if ($moduleDir) { break }
    } catch {
      Write-Host "失败：$($_.Exception.Message)"
    }
  }
}
if (-not $moduleDir) {
  throw '找不到 ps2exe。请手动安装：Install-Module ps2exe -Scope CurrentUser'
}

Write-Host "使用 ps2exe：$moduleDir"
Import-Module $moduleDir -Force
$input = Join-Path $root 'agent\gui\StellarisAgent.ps1'
$output = Join-Path $root 'StellarisAgent.exe'
Invoke-PS2EXE -InputFile $input -OutputFile $output -NoConsole -STA -RequireAdmin -Title '群星参谋' -Product 'Stellaris Agent' -Version $Version
Write-Host "已生成：$output"
