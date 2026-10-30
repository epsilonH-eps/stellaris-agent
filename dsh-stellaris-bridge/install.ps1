#requires -Version 5.1
<#
  把 dsh-stellaris-bridge 挂进 DSH profile。
  只改 profile 的 package.json + 建一个 node_modules junction；
  不重启当前 DSH，下次启动时加载。
#>
param(
  [string]$Profile = "$env:USERPROFILE\.dsh\profiles\desktop",
  [string]$PluginDir = "D:\stellaris-agent\dsh-stellaris-bridge"
)
$ErrorActionPreference = 'Stop'
$pkgFile = Join-Path $Profile 'package.json'
if (-not (Test-Path $pkgFile)) { throw "profile package.json 不存在：$pkgFile" }
if (-not (Test-Path (Join-Path $PluginDir 'index.js'))) { throw "插件目录不对：$PluginDir" }

$backup = "$pkgFile.before-stellaris-bridge"
if (-not (Test-Path $backup)) { Copy-Item $pkgFile $backup }

$pkg = Get-Content $pkgFile -Raw | ConvertFrom-Json
if (-not $pkg.dependencies) { $pkg.dependencies = [pscustomobject]@{} }
$pkg.dependencies | Add-Member -NotePropertyName 'dsh-stellaris-bridge' -NotePropertyValue ("link:" + $PluginDir.Replace('\','/')) -Force
if (-not $pkg.dsh) { $pkg.dsh = [pscustomobject]@{ profile = [pscustomobject]@{ bundles = @() } } }
if (-not $pkg.dsh.profile) { $pkg.dsh.profile = [pscustomobject]@{ bundles = @() } }
$bundles = @($pkg.dsh.profile.bundles)
if ($bundles -notcontains 'dsh-stellaris-bridge') { $bundles += 'dsh-stellaris-bridge' }
$pkg.dsh.profile.bundles = $bundles
$pkg | ConvertTo-Json -Depth 20 | Set-Content $pkgFile -Encoding utf8

$link = Join-Path $Profile 'node_modules\dsh-stellaris-bridge'
if (Test-Path $link) { Remove-Item $link -Force -Recurse }
New-Item -ItemType Junction -Path $link -Target $PluginDir | Out-Null

Write-Host '已挂载：'
Write-Host "  dependency: link:$PluginDir"
Write-Host "  bundle:     dsh-stellaris-bridge"
Write-Host "  junction:   $link"
Write-Host '重启 DSH 后生效；路由：/api/stellaris-bridge/health'
