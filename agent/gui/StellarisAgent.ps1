#requires -Version 5.1
<#
.SYNOPSIS
  群星参谋 · 桌面版（原生 WinForms 窗口，不是网页）。

.DESCRIPTION
  启动时拉起 Node 后端（stellaris-agent serve），窗口通过本地 HTTP 调它：
    战局：实时状态/简报（5 秒自动刷新）
    对话：和 DeepSeek 对话（只读或可写）
    操作：把动作写入「游戏内自动执行队列」，重启/读档后由游戏每月自动执行
  关闭窗口会一并结束后端进程。

.PARAMETER Port
  本地后端端口，默认 8787。

.PARAMETER SelfTest
  只构建窗口并退出（不显示、不启动后端），用于排障。

.EXAMPLE
  .\gui\StellarisAgent.ps1
#>
[CmdletBinding()]
param(
  [int]$Port = 8787,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
if ($env:STELLARIS_GUI_SELFTEST -eq '1') { $SelfTest = $true }
if (@($args) -contains '-SelfTest' -or @($args) -contains '/SelfTest') { $SelfTest = $true }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

$exeDir = $null
try { $exeDir = [System.IO.Path]::GetDirectoryName([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) } catch { }
$root = $null
$candidates = @()
$cwd = (Get-Location).Path
if ($cwd) { $candidates += $cwd; $candidates += (Join-Path $cwd 'agent') }
if ($exeDir) { $candidates += $exeDir; $candidates += (Join-Path $exeDir 'agent') }
if ($PSScriptRoot) { $candidates += (Split-Path $PSScriptRoot -Parent); $candidates += $PSScriptRoot }
foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path (Join-Path $candidate 'bin\stellaris-agent.mjs'))) { $root = $candidate; break }
}
if (-not $root) { $root = $cwd }
$node = $env:STELLARIS_AGENT_NODE
if (-not $node) {
  $cmd = Get-Command node -ErrorAction SilentlyContinue
  if ($cmd) { $node = $cmd.Source }
}
if (-not $node) {
  $bundled = Join-Path $root 'runtime\node.exe'
  if (Test-Path $bundled) { $node = $bundled }
}
if (-not $node) {
  $fallback = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $fallback) { $node = $fallback }
}
if (-not $node -and -not $SelfTest) {
  [System.Windows.Forms.MessageBox]::Show('找不到 node。装 Node 22+，或设置环境变量 STELLARIS_AGENT_NODE。', '群星参谋') | Out-Null
  exit 1
}

$base = "http://127.0.0.1:$Port"
$token = ''
$cfg = $null
$agentHome = if ($env:STELLARIS_AGENT_HOME) { $env:STELLARIS_AGENT_HOME } else { Join-Path $env:USERPROFILE '.stellaris-agent' }
$configFile = Join-Path $agentHome 'config.json'
if (-not (Test-Path $agentHome)) { New-Item -ItemType Directory -Force $agentHome | Out-Null }
if (-not (Test-Path $configFile)) {
  $example = Join-Path $root 'config.example.json'
  if (Test-Path $example) { Copy-Item $example $configFile -Force }
  else { Set-Content -Path $configFile -Value '{}' -Encoding utf8 }
}
if (Test-Path $configFile) {
  try {
    $cfg = Get-Content $configFile -Raw | ConvertFrom-Json
    if ($cfg.liveChat.token) { $token = [string]$cfg.liveChat.token }
  } catch { }
}
$headers = @{}
if ($token) { $headers['Authorization'] = "Bearer $token" }

function Show-BackendDialog {
  $backend = 'local'
  $url = 'http://127.0.0.1:49939'
  if ($cfg -and $cfg.swarm) {
    if ($cfg.swarm.backend) { $backend = [string]$cfg.swarm.backend }
    if ($cfg.swarm.dshUrl) { $url = [string]$cfg.swarm.dshUrl }
  }
  # 选了 DSH 就自动探测已安装插件监听的端口
  if ($backend -eq 'dsh' -and $node -and $root) {
    try {
      $bin = Join-Path $root 'bin\stellaris-agent.mjs'
      $raw = (& $node $bin dsh-discover 2>$null) -join "`n"
      $found = $raw | ConvertFrom-Json
      if ($found.ok -and $found.url) { $url = [string]$found.url }
    } catch { }
  }
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '群星参谋 · 选择主控'
  $dlg.Size = New-Object System.Drawing.Size(560, 400)
  $dlg.StartPosition = 'CenterScreen'
  $dlg.FormBorderStyle = 'FixedDialog'
  $dlg.MaximizeBox = $false
  $dlg.MinimizeBox = $false

  $title = New-Object System.Windows.Forms.Label
  $title.Text = '这次用谁来思考？'
  $title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 13, [System.Drawing.FontStyle]::Bold)
  $title.SetBounds(24, 18, 400, 32)
  $dlg.Controls.Add($title)

  $localRadio = New-Object System.Windows.Forms.RadioButton
  $localRadio.Text = '本地主控（程序自己的主会话 + 组件子会话）'
  $localRadio.SetBounds(30, 62, 410, 24)
  $localRadio.Checked = ($backend -ne 'dsh')
  $dlg.Controls.Add($localRadio)

  $dshRadio = New-Object System.Windows.Forms.RadioButton
  $dshRadio.Text = 'DSH 主控（子会话由 DSH 自己拉起）'
  $dshRadio.SetBounds(30, 92, 410, 24)
  $dshRadio.Checked = ($backend -eq 'dsh')
  $dlg.Controls.Add($dshRadio)

  $urlLabel = New-Object System.Windows.Forms.Label
  $urlLabel.Text = 'DSH 地址'
  $urlLabel.SetBounds(30, 128, 80, 22)
  $dlg.Controls.Add($urlLabel)

  $urlBox = New-Object System.Windows.Forms.TextBox
  $urlBox.Text = $url
  $urlBox.SetBounds(110, 126, 300, 24)
  $urlBox.Enabled = ($backend -eq 'dsh')
  $dlg.Controls.Add($urlBox)

  $urlDetect = New-Object System.Windows.Forms.Button
  $urlDetect.Text = '自动检测'
  $urlDetect.SetBounds(418, 124, 100, 26)
  $urlDetect.Enabled = ($backend -eq 'dsh')
  $urlDetect.Add_Click({
    try {
      $bin = Join-Path $root 'bin\stellaris-agent.mjs'
      $raw = (& $node $bin dsh-discover 2>$null) -join "`n"
      $found = $raw | ConvertFrom-Json
      if ($found.ok -and $found.url) { $urlBox.Text = [string]$found.url }
      else { [System.Windows.Forms.MessageBox]::Show('没有找到运行中的 DSH 插件；先启动 DSH。', '群星参谋') | Out-Null }
    } catch { [System.Windows.Forms.MessageBox]::Show('检测失败：' + $_.Exception.Message, '群星参谋') | Out-Null }
  })
  $dlg.Controls.Add($urlDetect)

  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = '选择会写入 config.json；DSH 模式需要重启 DSH 加载插件。'
  $hint.ForeColor = [System.Drawing.Color]::Gray
  $hint.SetBounds(30, 160, 500, 22)
  $dlg.Controls.Add($hint)

  $keyLabel = New-Object System.Windows.Forms.Label
  $keyLabel.Text = 'DeepSeek Key'
  $keyLabel.SetBounds(30, 196, 90, 22)
  $dlg.Controls.Add($keyLabel)

  $keyBox = New-Object System.Windows.Forms.TextBox
  $keyBox.SetBounds(120, 194, 400, 24)
  $keyBox.UseSystemPasswordChar = $true
  if ($cfg -and $cfg.deepseek -and $cfg.deepseek.apiKey) { $keyBox.Text = [string]$cfg.deepseek.apiKey }
  $dlg.Controls.Add($keyBox)

  $keyHint = New-Object System.Windows.Forms.Label
  $keyHint.Text = '已配置时留空保持不变；之后可在主界面「设置」页修改。'
  $keyHint.ForeColor = [System.Drawing.Color]::Gray
  $keyHint.SetBounds(30, 224, 500, 22)
  $dlg.Controls.Add($keyHint)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = '开始'
  $ok.SetBounds(310, 300, 90, 30)
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $dlg.Controls.Add($ok)
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = '退出'
  $cancel.SetBounds(410, 300, 90, 30)
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $dlg.Controls.Add($cancel)
  $dlg.AcceptButton = $ok
  $dlg.CancelButton = $cancel
  $dshRadio.Add_CheckedChanged({ $urlBox.Enabled = $dshRadio.Checked; $urlDetect.Enabled = $dshRadio.Checked })
  $localRadio.Add_CheckedChanged({ $urlBox.Enabled = $dshRadio.Checked; $urlDetect.Enabled = $dshRadio.Checked })

  if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  $chosen = if ($dshRadio.Checked) { 'dsh' } else { 'local' }
  return [pscustomobject]@{ backend = $chosen; dshUrl = $urlBox.Text.Trim(); apiKey = $keyBox.Text.Trim() }
}

function Save-BackendChoice($choice) {
  $obj = $null
  if (Test-Path $configFile) {
    try { $obj = Get-Content $configFile -Raw | ConvertFrom-Json } catch { $obj = $null }
  }
  if (-not $obj) { $obj = [pscustomobject]@{} }
  if (-not $obj.PSObject.Properties['swarm']) {
    $obj | Add-Member -NotePropertyName swarm -NotePropertyValue ([pscustomobject]@{}) -Force
  }
  $obj.swarm | Add-Member -NotePropertyName backend -NotePropertyValue $choice.backend -Force
  $obj.swarm | Add-Member -NotePropertyName dshUrl -NotePropertyValue $choice.dshUrl -Force
  if ($choice.apiKey) {
    if (-not $obj.PSObject.Properties['deepseek']) { $obj | Add-Member -NotePropertyName deepseek -NotePropertyValue ([pscustomobject]@{}) -Force }
    $obj.deepseek | Add-Member -NotePropertyName apiKey -NotePropertyValue $choice.apiKey -Force
  }
  New-Item -ItemType Directory -Force (Split-Path $configFile -Parent) | Out-Null
  $obj | ConvertTo-Json -Depth 20 | Set-Content $configFile -Encoding utf8
}



function Save-AgentSettings($key, $dshUrl, $gamePath, $userPath) {
  $obj = $null
  if (Test-Path $configFile) {
    try { $obj = Get-Content $configFile -Raw | ConvertFrom-Json } catch { $obj = $null }
  }
  if (-not $obj) { $obj = [pscustomobject]@{} }
  if (-not $obj.PSObject.Properties['deepseek']) { $obj | Add-Member -NotePropertyName deepseek -NotePropertyValue ([pscustomobject]@{}) -Force }
  if (-not $obj.PSObject.Properties['swarm']) { $obj | Add-Member -NotePropertyName swarm -NotePropertyValue ([pscustomobject]@{}) -Force }
  $obj.deepseek | Add-Member -NotePropertyName apiKey -NotePropertyValue $key -Force
  $obj.swarm | Add-Member -NotePropertyName dshUrl -NotePropertyValue $dshUrl -Force
  if ($gamePath) { $obj | Add-Member -NotePropertyName stellarisInstallDir -NotePropertyValue $gamePath -Force }
  if ($userPath) { $obj | Add-Member -NotePropertyName stellarisUserDir -NotePropertyValue $userPath -Force }
  New-Item -ItemType Directory -Force (Split-Path $configFile -Parent) | Out-Null
  $obj | ConvertTo-Json -Depth 20 | Set-Content $configFile -Encoding utf8
}

function Save-DeepSeekKey($key) {
  $obj = $null
  if (Test-Path $configFile) {
    try { $obj = Get-Content $configFile -Raw | ConvertFrom-Json } catch { $obj = $null }
  }
  if (-not $obj) { $obj = [pscustomobject]@{} }
  if (-not $obj.PSObject.Properties['deepseek']) { $obj | Add-Member -NotePropertyName deepseek -NotePropertyValue ([pscustomobject]@{}) -Force }
  $obj.deepseek | Add-Member -NotePropertyName apiKey -NotePropertyValue $key -Force
  New-Item -ItemType Directory -Force (Split-Path $configFile -Parent) | Out-Null
  $obj | ConvertTo-Json -Depth 20 | Set-Content $configFile -Encoding utf8
}

$choice = if ($SelfTest) { [pscustomobject]@{ backend = 'local'; dshUrl = 'http://127.0.0.1:49939'; apiKey = '' } } else { Show-BackendDialog }
if (-not $choice) { exit 0 }
if (-not $SelfTest) { Save-BackendChoice $choice }
$script:backend = $choice.backend
$script:dshUrl = $choice.dshUrl

$server = $null
function Start-Backend {
  $bin = Join-Path $root 'bin\stellaris-agent.mjs'
  $logDir = Join-Path $agentHome 'logs'
    New-Item -ItemType Directory -Force $logDir | Out-Null
    $script:server = Start-Process -FilePath $node -ArgumentList @($bin, 'serve', '--port', "$Port") -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') -RedirectStandardError (Join-Path $logDir 'backend.err.log')
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    try {
      $null = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 2
      return $true
    } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

$form = New-Object System.Windows.Forms.Form
$form.Text = '群星参谋 · 4.5 · 主控=' + $script:backend
$form.Size = New-Object System.Drawing.Size(1040, 760)
$form.StartPosition = 'CenterScreen'
$form.MinimumSize = New-Object System.Drawing.Size(820, 560)

$status = New-Object System.Windows.Forms.StatusStrip
$statusLabel = New-Object System.Windows.Forms.ToolStripStatusLabel
$statusLabel.Text = '未连接'
$statusLabel.Spring = $true
$dshStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$dshStatus.Text = 'DSH: ?'
$gameStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$gameStatus.Text = '群星: ?'
$aiStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$aiStatus.Text = 'AI: ?'
$connectGameBtn = New-Object System.Windows.Forms.ToolStripButton
$connectGameBtn.Text = '连接群星'
$startAiBtn = New-Object System.Windows.Forms.ToolStripButton
$startAiBtn.Text = '▶ 自动运行 AI'
$stopAiBtn = New-Object System.Windows.Forms.ToolStripButton
$stopAiBtn.Text = '■ 停止 AI'
$status.Items.AddRange(@($statusLabel, $dshStatus, $gameStatus, $aiStatus, $connectGameBtn, $startAiBtn, $stopAiBtn)) | Out-Null
$form.Controls.Add($status)

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'
$form.Controls.Add($tabs)
$tabs.BringToFront()

# ---------------------------------------------------------------- 战局
$tabWar = New-Object System.Windows.Forms.TabPage
$tabWar.Text = '战局'
$warBox = New-Object System.Windows.Forms.RichTextBox
$warBox.Dock = 'Fill'
$warBox.ReadOnly = $true
$warBox.Font = New-Object System.Drawing.Font('Consolas', 10)
$warBox.BackColor = [System.Drawing.Color]::FromArgb(20, 24, 30)
$warBox.ForeColor = [System.Drawing.Color]::FromArgb(220, 225, 232)
$warPanel = New-Object System.Windows.Forms.Panel
$warPanel.Dock = 'Bottom'
$warPanel.Height = 40
$warRefresh = New-Object System.Windows.Forms.Button
$warRefresh.Text = '立即刷新'
$warRefresh.Width = 100
$warRefresh.Dock = 'Left'
$warPanel.Controls.Add($warRefresh)
$tabWar.Controls.Add($warBox)
$tabWar.Controls.Add($warPanel)
$warBox.BringToFront()
$tabs.TabPages.Add($tabWar)

# ---------------------------------------------------------------- 对话
$tabChat = New-Object System.Windows.Forms.TabPage
$tabChat.Text = '对话'
$chatBox = New-Object System.Windows.Forms.RichTextBox
$chatBox.Dock = 'Fill'
$chatBox.ReadOnly = $true
$chatBox.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$chatPanel = New-Object System.Windows.Forms.Panel
$chatPanel.Dock = 'Bottom'
$chatPanel.Height = 78
$chatInput = New-Object System.Windows.Forms.TextBox
$chatInput.Dock = 'Top'
$chatInput.Height = 30
$chatInput.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$chatButtons = New-Object System.Windows.Forms.Panel
$chatButtons.Dock = 'Bottom'
$chatButtons.Height = 36
$chatSend = New-Object System.Windows.Forms.Button
$chatSend.Text = '发送'
$chatSend.Width = 90
$chatSend.Dock = 'Left'
$chatReadOnly = New-Object System.Windows.Forms.CheckBox
$chatReadOnly.Text = '只读（不写游戏）'
$chatReadOnly.Checked = $true
$chatReadOnly.Dock = 'Left'
$chatReadOnly.Width = 150
$chatButtons.Controls.Add($chatSend)
$chatButtons.Controls.Add($chatReadOnly)
$chatPanel.Controls.Add($chatInput)
$chatPanel.Controls.Add($chatButtons)
$tabChat.Controls.Add($chatBox)
$tabChat.Controls.Add($chatPanel)
$chatBox.BringToFront()
$tabs.TabPages.Add($tabChat)

# ---------------------------------------------------------------- 操作
$tabOps = New-Object System.Windows.Forms.TabPage
$tabOps.Text = '操作（自动队列）'
$opsHint = New-Object System.Windows.Forms.Label
$opsHint.Dock = 'Top'
$opsHint.Height = 52
$opsHint.Text = '把动作写成 JSON 数组（同 stellaris 动作块）。点「写入自动队列」后，' +
  '游戏需要重启或读档才会加载；之后每月自动执行一次，不需要任何按键。'
$opsBox = New-Object System.Windows.Forms.RichTextBox
$opsBox.Dock = 'Fill'
$opsBox.Font = New-Object System.Drawing.Font('Consolas', 10)
$opsBox.Text = @'
[
  { "note": { "text": "hello from desktop" } }
]
'@
$opsPanel = New-Object System.Windows.Forms.Panel
$opsPanel.Dock = 'Bottom'
$opsPanel.Height = 70
$opsApply = New-Object System.Windows.Forms.Button
$opsApply.Text = '写入自动队列'
$opsApply.Width = 130
$opsApply.Dock = 'Left'
$opsResult = New-Object System.Windows.Forms.Label
$opsResult.Dock = 'Fill'
$opsResult.Text = ''
$opsPanel.Controls.Add($opsApply)
$opsPanel.Controls.Add($opsResult)
$tabOps.Controls.Add($opsBox)
$tabOps.Controls.Add($opsHint)
$tabOps.Controls.Add($opsPanel)
$opsBox.BringToFront()
$tabs.TabPages.Add($tabOps)

# ---------------------------------------------------------------- 原生
$tabNative = New-Object System.Windows.Forms.TabPage
$tabNative.Text = '原生桥'
$nativeBox = New-Object System.Windows.Forms.RichTextBox
$nativeBox.Dock = 'Fill'
$nativeBox.ReadOnly = $true
$nativeBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$nativePanel = New-Object System.Windows.Forms.Panel
$nativePanel.Dock = 'Bottom'
$nativePanel.Height = 40
$nativeStatusBtn = New-Object System.Windows.Forms.Button
$nativeStatusBtn.Text = '实时状态'
$nativeStatusBtn.Width = 100
$nativeStatusBtn.Dock = 'Left'
$nativeReadBtn = New-Object System.Windows.Forms.Button
$nativeReadBtn.Text = '全量读取'
$nativeReadBtn.Width = 100
$nativeReadBtn.Dock = 'Left'
$nativePanel.Controls.Add($nativeStatusBtn)
$nativePanel.Controls.Add($nativeReadBtn)
$tabNative.Controls.Add($nativeBox)
$tabNative.Controls.Add($nativePanel)
$nativeBox.BringToFront()
$tabs.TabPages.Add($tabNative)

# ---------------------------------------------------------------- 事件链
$tabEvents = New-Object System.Windows.Forms.TabPage
$tabEvents.Text = '事件链'
$eventBox = New-Object System.Windows.Forms.RichTextBox
$eventBox.Dock = 'Fill'
$eventBox.ReadOnly = $true
$eventBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$eventPanel = New-Object System.Windows.Forms.Panel
$eventPanel.Dock = 'Bottom'
$eventPanel.Height = 72
$eventQuery = New-Object System.Windows.Forms.TextBox
$eventQuery.Dock = 'Top'
$eventQuery.Height = 28
$eventButtons = New-Object System.Windows.Forms.Panel
$eventButtons.Dock = 'Bottom'
$eventButtons.Height = 34
$eventSearchBtn = New-Object System.Windows.Forms.Button
$eventSearchBtn.Text = '搜索'
$eventSearchBtn.Width = 80
$eventSearchBtn.Dock = 'Left'
$eventChainBtn = New-Object System.Windows.Forms.Button
$eventChainBtn.Text = '查链（输入事件 id）'
$eventChainBtn.Width = 160
$eventChainBtn.Dock = 'Left'
$eventButtons.Controls.Add($eventSearchBtn)
$eventButtons.Controls.Add($eventChainBtn)
$eventPanel.Controls.Add($eventQuery)
$eventPanel.Controls.Add($eventButtons)
$tabEvents.Controls.Add($eventBox)
$tabEvents.Controls.Add($eventPanel)
$eventBox.BringToFront()
$tabs.TabPages.Add($tabEvents)

# ---------------------------------------------------------------- 群体调度
$tabSwarm = New-Object System.Windows.Forms.TabPage
$tabSwarm.Text = '群体调度'
$swarmBox = New-Object System.Windows.Forms.RichTextBox
$swarmBox.Dock = 'Fill'
$swarmBox.ReadOnly = $true
$swarmBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$swarmPanel = New-Object System.Windows.Forms.Panel
$swarmPanel.Dock = 'Bottom'
$swarmPanel.Height = 80
$swarmBackend = New-Object System.Windows.Forms.Label
$swarmBackend.Dock = 'Top'
$swarmBackend.Height = 24
$swarmBackend.Text = '主控：' + $script:backend + '    ' + $script:dshUrl
$swarmObjective = New-Object System.Windows.Forms.TextBox
$swarmObjective.Dock = 'Top'
$swarmObjective.Height = 26
$swarmObjective.Text = ''
$swarmButtons = New-Object System.Windows.Forms.Panel
$swarmButtons.Dock = 'Bottom'
$swarmButtons.Height = 30
$swarmStart = New-Object System.Windows.Forms.Button
$swarmStart.Text = '启动调度'
$swarmStart.Width = 90
$swarmStart.Dock = 'Left'
$swarmStop = New-Object System.Windows.Forms.Button
$swarmStop.Text = '停止'
$swarmStop.Width = 70
$swarmStop.Dock = 'Left'
$swarmRefresh = New-Object System.Windows.Forms.Button
$swarmRefresh.Text = '刷新状态'
$swarmRefresh.Width = 90
$swarmRefresh.Dock = 'Left'
$swarmButtons.Controls.Add($swarmStart)
$swarmButtons.Controls.Add($swarmStop)
$swarmButtons.Controls.Add($swarmRefresh)
$swarmPanel.Controls.Add($swarmBackend)
$swarmPanel.Controls.Add($swarmObjective)
$swarmPanel.Controls.Add($swarmButtons)
$tabSwarm.Controls.Add($swarmBox)
$tabSwarm.Controls.Add($swarmPanel)
$swarmBox.BringToFront()
$tabs.TabPages.Add($tabSwarm)


# ---------------------------------------------------------------- 设置
$tabSettings = New-Object System.Windows.Forms.TabPage
$tabSettings.Text = '设置'
$settingsPanel = New-Object System.Windows.Forms.Panel
$settingsPanel.Dock = 'Top'
$settingsPanel.Height = 290

$settingsLabel = New-Object System.Windows.Forms.Label
$settingsLabel.Text = 'DeepSeek API Key'
$settingsLabel.SetBounds(20, 18, 120, 22)
$settingsPanel.Controls.Add($settingsLabel)
$settingsKey = New-Object System.Windows.Forms.TextBox
$settingsKey.SetBounds(150, 16, 420, 24)
$settingsKey.UseSystemPasswordChar = $true
if ($cfg -and $cfg.deepseek -and $cfg.deepseek.apiKey) { $settingsKey.Text = [string]$cfg.deepseek.apiKey }
$settingsPanel.Controls.Add($settingsKey)
$settingsShow = New-Object System.Windows.Forms.CheckBox
$settingsShow.Text = '显示'
$settingsShow.SetBounds(580, 16, 60, 24)
$settingsShow.Add_CheckedChanged({ $settingsKey.UseSystemPasswordChar = -not $settingsShow.Checked })
$settingsPanel.Controls.Add($settingsShow)

$settingsGameLabel = New-Object System.Windows.Forms.Label
$settingsGameLabel.Text = '群星安装目录'
$settingsGameLabel.SetBounds(20, 58, 120, 22)
$settingsPanel.Controls.Add($settingsGameLabel)
$settingsGame = New-Object System.Windows.Forms.TextBox
$settingsGame.SetBounds(150, 56, 420, 24)
if ($cfg -and $cfg.stellarisInstallDir) { $settingsGame.Text = [string]$cfg.stellarisInstallDir }
$settingsPanel.Controls.Add($settingsGame)
$settingsBrowse = New-Object System.Windows.Forms.Button
$settingsBrowse.Text = '浏览'
$settingsBrowse.SetBounds(580, 54, 60, 26)
$settingsBrowse.Add_Click({
  $fb = New-Object System.Windows.Forms.FolderBrowserDialog
  if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $settingsGame.Text = $fb.SelectedPath }
})
$settingsPanel.Controls.Add($settingsBrowse)

$settingsUserLabel = New-Object System.Windows.Forms.Label
$settingsUserLabel.Text = '群星用户目录'
$settingsUserLabel.SetBounds(20, 98, 120, 22)
$settingsPanel.Controls.Add($settingsUserLabel)
$settingsUser = New-Object System.Windows.Forms.TextBox
$settingsUser.SetBounds(150, 96, 420, 24)
if ($cfg -and $cfg.stellarisUserDir) { $settingsUser.Text = [string]$cfg.stellarisUserDir }
$settingsPanel.Controls.Add($settingsUser)
$settingsUserBrowse = New-Object System.Windows.Forms.Button
$settingsUserBrowse.Text = '浏览'
$settingsUserBrowse.SetBounds(580, 94, 60, 26)
$settingsUserBrowse.Add_Click({
  $fb = New-Object System.Windows.Forms.FolderBrowserDialog
  if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $settingsUser.Text = $fb.SelectedPath }
})
$settingsPanel.Controls.Add($settingsUserBrowse)

$settingsDshLabel = New-Object System.Windows.Forms.Label
$settingsDshLabel.Text = 'DSH 地址'
$settingsDshLabel.SetBounds(20, 138, 120, 22)
$settingsPanel.Controls.Add($settingsDshLabel)
$settingsDsh = New-Object System.Windows.Forms.TextBox
$settingsDsh.SetBounds(150, 136, 300, 24)
if ($cfg -and $cfg.swarm -and $cfg.swarm.dshUrl) { $settingsDsh.Text = [string]$cfg.swarm.dshUrl }
$settingsPanel.Controls.Add($settingsDsh)
$settingsDshDetect = New-Object System.Windows.Forms.Button
$settingsDshDetect.Text = '自动检测'
$settingsDshDetect.SetBounds(460, 134, 100, 26)
$settingsDshDetect.Add_Click({
  try {
    $bin = Join-Path $root 'bin\stellaris-agent.mjs'
    $raw = (& $node $bin dsh-discover 2>$null) -join "`n"
    $found = $raw | ConvertFrom-Json
    if ($found.ok) { $settingsDsh.Text = [string]$found.url }
    else { [System.Windows.Forms.MessageBox]::Show('没有找到运行中的 DSH 插件。', '群星参谋') | Out-Null }
  } catch { }
})
$settingsPanel.Controls.Add($settingsDshDetect)

$settingsSave = New-Object System.Windows.Forms.Button
$settingsSave.Text = '保存设置并重启后端'
$settingsSave.SetBounds(150, 180, 180, 30)
$settingsDiag = New-Object System.Windows.Forms.Button
$settingsDiag.Text = '导出诊断日志'
$settingsDiag.SetBounds(350, 180, 140, 30)
$settingsPanel.Controls.Add($settingsDiag)
$settingsPanel.Controls.Add($settingsSave)
$settingsStatus = New-Object System.Windows.Forms.Label
$settingsStatus.SetBounds(20, 228, 620, 40)
$settingsStatus.ForeColor = [System.Drawing.Color]::Gray
$settingsStatus.Text = 'Key / 群星目录 / DSH 地址保存后自动重启后端。'
$settingsPanel.Controls.Add($settingsStatus)
$tabSettings.Controls.Add($settingsPanel)
$tabs.TabPages.Add($tabSettings)

# ---------------------------------------------------------------- 数据刷新
function Update-War {
  try {
    $s = Invoke-RestMethod -Uri "$base/api/status" -Headers $headers -TimeoutSec 5
    $b = Invoke-RestMethod -Uri "$base/api/brief" -Headers $headers -TimeoutSec 8
    $snap = if ($s.snapshot.date) { "$($s.snapshot.date)（$($s.snapshot.ageSec)s 前）" } else { '无快照' }
    $mods = if ($s.mods.reader -and $s.mods.console) { '模组 OK' } else { '原生桥模式（模组可选）' }
    $script:statusLabel.Text = "用户目录：$($s.userDir) ｜ 快照：$snap ｜ $mods ｜ 注入：$($s.injection)"
    $warBox.Text = [string]$b.brief
  } catch {
    $script:statusLabel.Text = "后端不可用：$($_.Exception.Message)"
  }
}

function Update-Health {
  try {
    $r = Invoke-RestMethod -Uri "$base/api/readiness" -Headers $headers -TimeoutSec 8
    if ($r.dsh.reachable) { $dshStatus.Text = 'DSH: 已连接'; $dshStatus.ForeColor = [System.Drawing.Color]::Green }
    else { $dshStatus.Text = 'DSH: 未连接'; $dshStatus.ForeColor = [System.Drawing.Color]::Gray }
    if ($r.game.bridge) { $gameStatus.Text = '群星: 已连接 ' + $r.game.date; $gameStatus.ForeColor = [System.Drawing.Color]::Green }
    elseif ($r.game.running) { $gameStatus.Text = '群星: 运行中（桥未连）'; $gameStatus.ForeColor = [System.Drawing.Color]::Orange }
    else { $gameStatus.Text = '群星: 未运行'; $gameStatus.ForeColor = [System.Drawing.Color]::Gray }
    $aiStatus.Text = 'AI: ' + $r.backend + ' / Key ' + $(if ($r.ai.configured) { '已配置' } else { '未配置' })
  } catch {
    $dshStatus.Text = 'DSH: ?'; $gameStatus.Text = '群星: ?'; $aiStatus.Text = 'AI: 后端不可用'
  }
}


function Get-ApiFailure($err) {
  $detail = $err.ErrorDetails.Message
  if ($detail) {
    try {
      $obj = $detail | ConvertFrom-Json
      if ($obj.error) { $detail = [string]$obj.error }
      elseif ($obj.message) { $detail = [string]$obj.message }
    } catch { }
  } else { $detail = $err.Exception.Message }
  switch ($detail) {
    'GAME_NOT_RUNNING' { return '群星没有运行。先启动游戏并读档/新开一局，再点「连接群星」。' }
    'INJECT_FAILED' { return '原生桥注入失败：确认游戏是 4.5.2、程序与游戏权限一致、杀软未拦截。' }
    'PIPE_NOT_READY' { return '注入成功但管道没起来；完全重启游戏后再试。' }
    'DLL_NOT_FOUND' { return '找不到 stellaris_bridge.dll，检查 agent/native 目录。' }
    default { return [string]$detail }
  }
}

$connectGameBtn.Add_Click({
  try {
    $r = Invoke-RestMethod -Uri "$base/api/native/connect" -Method Post -Headers $headers -TimeoutSec 30
    if (-not $r.inGame) {
      [System.Windows.Forms.MessageBox]::Show('原生桥已注入，但游戏还在主菜单；请读档或新开一局。', '群星参谋') | Out-Null
    }
    Update-Health
  } catch {
    [System.Windows.Forms.MessageBox]::Show("连接群星失败：$((Get-ApiFailure $_))", '群星参谋') | Out-Null
  }
})

$startAiBtn.Add_Click({
  try {
    $body = @{ objective = '' } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$base/api/swarm/start" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60
    if ($swarmBox) { $swarmBox.Text = ($r | ConvertTo-Json -Depth 8) }
    Update-Health
  } catch {
    [System.Windows.Forms.MessageBox]::Show("启动 AI 失败：$((Get-ApiFailure $_))", '群星参谋') | Out-Null
  }
})
$stopAiBtn.Add_Click({
  try { $null = Invoke-RestMethod -Uri "$base/api/swarm/stop" -Method Post -Headers $headers -TimeoutSec 10; Update-Health } catch { }
})

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 5000
$script:timer.Add_Tick({ Update-War; Update-Health })
$warRefresh.Add_Click({ Update-War; Update-Health })

$chatSend.Add_Click({
  $text = $chatInput.Text.Trim()
  if (-not $text) { return }
  $chatInput.Text = ''
  $chatBox.AppendText("`r`n你：$text`r`n")
  $chatSend.Enabled = $false
  $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
  try {
    $body = @{ text = $text; readOnly = [bool]$chatReadOnly.Checked } | ConvertTo-Json -Depth 5
    $resp = Invoke-RestMethod -Uri "$base/api/ask" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 180
    if ($resp.text) { $chatBox.AppendText("参谋：$($resp.text)`r`n") }
    if ($resp.summary) { $chatBox.AppendText("[摘要] $($resp.summary)`r`n") }
    if ($resp.usage) { $chatBox.AppendText("— $($resp.usage.totalTokens) tokens`r`n") }
    if ($resp.error) { $chatBox.AppendText("[错误] $($resp.error)`r`n") }
  } catch {
    $chatBox.AppendText("[错误] $($_.Exception.Message)`r`n")
  } finally {
    $chatSend.Enabled = $true
    $form.Cursor = [System.Windows.Forms.Cursors]::Default
  }
})

$opsApply.Add_Click({
  try {
    $actions = $opsBox.Text | ConvertFrom-Json
    $list = @($actions)
    $body = @{ actions = $list } | ConvertTo-Json -Depth 10
    $resp = Invoke-RestMethod -Uri "$base/api/apply-auto" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 30
    if ($resp.ok) {
      $opsResult.Text = "已写入 v$($resp.seq)：$($resp.hint)"
    } else {
      $opsResult.Text = "失败：$($resp.error) $($resp.code)"
    }
  } catch {
    $opsResult.Text = "失败：$($_.Exception.Message)"
  }
})

$nativeStatusBtn.Add_Click({
  try {
    $r = Invoke-RestMethod -Uri "$base/api/native/status" -Headers $headers -TimeoutSec 15
    $nativeBox.Text = ($r | ConvertTo-Json -Depth 8)
  } catch { $nativeBox.Text = "原生桥不可用：$($_.Exception.Message)" }
})
$nativeReadBtn.Add_Click({
  try {
    $r = Invoke-RestMethod -Uri "$base/api/native/read" -Headers $headers -TimeoutSec 60
    $nativeBox.Text = [string]$r.summary
  } catch { $nativeBox.Text = "读取失败：$($_.Exception.Message)" }
})
$eventSearchBtn.Add_Click({
  try {
    $q = [uri]::EscapeDataString($eventQuery.Text.Trim())
    $r = Invoke-RestMethod -Uri "$base/api/events/search?q=$q" -Headers $headers -TimeoutSec 10
    $lines = foreach ($h in $r.hits) { "$($h.id)  「$($h.titleKey)」  $($h.kind)  next=$($h.next.Count)" }
    $eventBox.Text = ($lines -join "`r`n")
  } catch { $eventBox.Text = "搜索失败：$($_.Exception.Message)" }
})
$eventChainBtn.Add_Click({
  try {
    $id = [uri]::EscapeDataString($eventQuery.Text.Trim())
    $r = Invoke-RestMethod -Uri "$base/api/events/chain?id=$id&depth=4" -Headers $headers -TimeoutSec 10
    if (-not $r) { $eventBox.Text = '没有这个事件'; return }
    $lines = foreach ($n in $r.nodes) { ('  ' * [int]$n.level) + "$($n.id)  「$($n.titleKey)」  $($n.kind)" }
    $eventBox.Text = "根：$($r.root.id)  $($r.root.file)`r`n" + ($lines -join "`r`n")
  } catch { $eventBox.Text = "查链失败：$($_.Exception.Message)" }
})

$swarmStart.Add_Click({
  try {
    $body = @{ objective = $swarmObjective.Text.Trim() } | ConvertTo-Json
    $r = Invoke-RestMethod -Uri "$base/api/swarm/start" -Method Post -Headers $headers -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 60
    $swarmBox.Text = ($r | ConvertTo-Json -Depth 8)
  } catch { $swarmBox.Text = "启动失败：$($_.Exception.Message)" }
})
$swarmStop.Add_Click({
  try { $null = Invoke-RestMethod -Uri "$base/api/swarm/stop" -Method Post -Headers $headers -TimeoutSec 10; $swarmBox.Text = '已停止' } catch { $swarmBox.Text = "停止失败：$($_.Exception.Message)" }
})
$swarmRefresh.Add_Click({
  try { $r = Invoke-RestMethod -Uri "$base/api/swarm/status" -Headers $headers -TimeoutSec 10; $swarmBox.Text = ($r | ConvertTo-Json -Depth 8) } catch { $swarmBox.Text = "读取失败：$($_.Exception.Message)" }
})


$settingsDiag.Add_Click({
  try {
    $r = Invoke-RestMethod -Uri "$base/api/diagnostics" -Headers $headers -TimeoutSec 15
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $file = Join-Path $agentHome ("diagnostics-$stamp.json")
    $r | ConvertTo-Json -Depth 20 | Set-Content $file -Encoding utf8
    [System.Windows.Forms.MessageBox]::Show("诊断已导出：$file", '群星参谋') | Out-Null
    Start-Process explorer.exe -ArgumentList ('/select,' + $file) | Out-Null
  } catch {
    [System.Windows.Forms.MessageBox]::Show("导出失败：$($_.Exception.Message)", '群星参谋') | Out-Null
  }
})

$settingsSave.Add_Click({
  $key = $settingsKey.Text.Trim()
  $dshUrl = $settingsDsh.Text.Trim()
  $gamePath = $settingsGame.Text.Trim()
  $userPath = $settingsUser.Text.Trim()
  if (-not $key) { $settingsStatus.Text = 'Key 不能为空'; return }
  try {
    Save-AgentSettings $key $dshUrl $gamePath $userPath
    $settingsStatus.Text = '已保存，正在重启后端...'
    if ($script:server) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 600
    if (Start-Backend) { $settingsStatus.Text = '已保存，后端已重启' }
    else { $settingsStatus.Text = '已保存，但后端重启失败；检查端口/配置' }
  } catch { $settingsStatus.Text = '保存失败：' + $_.Exception.Message }
})

if ($SelfTest) {
  $form.Dispose()
  Write-Output 'GUI selftest OK'
  exit 0
}

$ok = Start-Backend
if (-not $ok) {
  [System.Windows.Forms.MessageBox]::Show('后端启动失败：检查 config.json 的 API key 与端口占用。', '群星参谋') | Out-Null
  if ($server) { Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue }
  $form.Dispose()
  exit 1
}

$form.Add_Shown({ $script:timer.Start(); Update-War; Update-Health })
$form.Add_FormClosed({
  $script:timer.Stop()
  if ($script:server) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue }
})

[void]$form.ShowDialog()
