#requires -Version 5.1
<#
.SYNOPSIS
  群星参谋 v2 · 桌面版（WinForms，不是网页）。

.DESCRIPTION
  启动时拉起 Node 后端（stellaris-agent serve），窗口只通过本地 HTTP 调它：
    战局 / 主会话 / 子会话 / 对话 / 动作 / 读取 / 调度 / 设置
  底部常驻显示：大模型是否连上、游戏是否连上、调度是否在跑。
  「主会话」是一个固定面板；「子会话」用下拉框选择要看的单位/事件，再展示其摘要与完整对话。
  所有会话都在这一个应用窗口内，不额外弹窗。

  自动连接：后端启动后由看护循环负责——游戏在跑就注入，进局就自动接管；
  手动停止调度后有 5 分钟冷静期，不会立刻被拉起来。

.PARAMETER Port
  本地后端端口，默认取 config.chat.port（8787）。

.PARAMETER SelfTest
  只构建窗口并退出（不显示、不启动后端），用于排障/CI。
#>
[CmdletBinding()]
param(
  [int]$Port = 0,
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'
if ($env:STELLARIS_GUI_SELFTEST -eq '1') { $SelfTest = $true }
# ps2exe 打包后参数走 $args，不是 param()；两种都认
if (@($args) -contains '-SelfTest' -or @($args) -contains '/SelfTest') { $SelfTest = $true }
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

# ---------------------------------------------------------------- 环境定位
$exeDir = $null
try { $exeDir = [System.IO.Path]::GetDirectoryName([System.Diagnostics.Process]::GetCurrentProcess().MainModule.FileName) } catch { }
$root = $null
$candidates = @()
if ((Get-Location).Path) { $candidates += (Get-Location).Path; $candidates += (Join-Path (Get-Location).Path 'agent') }
if ($exeDir) { $candidates += $exeDir; $candidates += (Join-Path $exeDir 'agent') }
if ($PSScriptRoot) { $candidates += (Split-Path $PSScriptRoot -Parent); $candidates += $PSScriptRoot }
foreach ($candidate in $candidates) {
  if ($candidate -and (Test-Path (Join-Path $candidate 'bin\stellaris-agent.mjs'))) { $root = $candidate; break }
}
if (-not $root) { $root = (Get-Location).Path }

$node = $env:STELLARIS_AGENT_NODE
if (-not $node) { $cmd = Get-Command node -ErrorAction SilentlyContinue; if ($cmd) { $node = $cmd.Source } }
if (-not $node) { $bundled = Join-Path $root 'runtime\node.exe'; if (Test-Path $bundled) { $node = $bundled } }
if (-not $node) {
  $fallback = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $fallback) { $node = $fallback }
}
if (-not $node -and -not $SelfTest) {
  [System.Windows.Forms.MessageBox]::Show('找不到 node。装 Node 22+，或设置环境变量 STELLARIS_AGENT_NODE。', '群星参谋') | Out-Null
  exit 1
}

$agentHome = if ($env:STELLARIS_AGENT_HOME) { $env:STELLARIS_AGENT_HOME } else { Join-Path $env:USERPROFILE '.stellaris-agent' }
$configFile = Join-Path $agentHome 'config.json'
if (-not (Test-Path $agentHome)) { New-Item -ItemType Directory -Force $agentHome | Out-Null }
if (-not (Test-Path $configFile)) {
  $example = Join-Path $root 'config.example.json'
  if (Test-Path $example) { Copy-Item $example $configFile -Force } else { Set-Content -Path $configFile -Value '{}' -Encoding utf8 }
}
$cfg = $null
try { $cfg = Get-Content $configFile -Raw | ConvertFrom-Json } catch { }
if ($Port -le 0) { $Port = if ($cfg -and $cfg.chat -and $cfg.chat.port) { [int]$cfg.chat.port } else { 8787 } }
$base = "http://127.0.0.1:$Port"
$token = ''
if ($cfg -and $cfg.chat -and $cfg.chat.token) { $token = [string]$cfg.chat.token }
$headers = @{}
if ($token) { $headers['Authorization'] = "Bearer $token" }

function Get-Json($obj) { $obj | ConvertTo-Json -Depth 20 -Compress }

function Invoke-Api {
  param([string]$Path, [string]$Method = 'GET', $Body = $null, [int]$TimeoutSec = 30)
  $request = @{ Uri = "$base$Path"; Method = $Method; Headers = $headers; TimeoutSec = $TimeoutSec }
  if ($null -ne $Body) {
    $request['ContentType'] = 'application/json; charset=utf-8'
    $request['Body'] = [System.Text.Encoding]::UTF8.GetBytes((Get-Json $Body))
  }
  return Invoke-RestMethod @request
}

function Val($value, $fallback = '-') {
  if ($null -eq $value -or $value -eq '') { return [string]$fallback }
  return [string]$value
}

function Format-Time($ms) {
  if (-not $ms) { return '' }
  try { return ([datetime]'1970-01-01').AddMilliseconds([double]$ms).ToLocalTime().ToString('HH:mm:ss') } catch { return '' }
}

function Get-ApiError($err) {
  $detail = $err.ErrorDetails.Message
  if (-not $detail) { return $err.Exception.Message }
  try {
    $obj = $detail | ConvertFrom-Json
    $code = [string]$obj.error
    $msg = ''
    if ($obj.detail -and $obj.detail.message) { $msg = [string]$obj.detail.message }
    elseif ($obj.detail) { $msg = [string]$obj.detail }
    switch ($code) {
      'GAME_NOT_RUNNING' { return '群星没有运行。先启动游戏并读档。' }
      'GAME_NOT_IN_SESSION' { return '游戏还停在主菜单；读档或新开一局。' }
      'INJECT_FAILED' { return '原生桥注入失败：确认游戏是 4.5.x、权限一致、杀软未拦截。' }
      'PIPE_NOT_READY' { return '注入成功但管道没起来；完全重启游戏再试。' }
      'ORCHESTRATOR_NOT_RUNNING' { return '调度器未启动：先在「调度」页点启动。' }
      'MISSING_API_KEY' { return '没有 DeepSeek API Key：设置页填写，或把后端改成 DSH。' }
      'DSH_UNAVAILABLE' { return 'DSH 不可用：确认 DSH 在运行、插件已加载（设置页可安装/重载）。' }
      'UNAUTHORIZED' { return '需要 token：检查 config.chat.token。' }
      default {
        if ($msg) { return "$code：$msg" }
        if ($code) { return $code }
        return [string]$detail
      }
    }
  } catch { return [string]$detail }
}

function Show-Error($title, $err) { [System.Windows.Forms.MessageBox]::Show((Get-ApiError $err), $title) | Out-Null }

function Set-StatusLabel($label, $text, $color) {
  $label.Text = $text
  $label.ForeColor = $color
}

# ---------------------------------------------------------------- 启动选择
function Show-BackendDialog {
  $backend = 'deepseek'
  $url = 'http://127.0.0.1:49939'
  # 兼容 v1 配置（swarm.backend / swarm.dshUrl）与 v2（ai.*）
  if ($cfg -and $cfg.ai -and $cfg.ai.backend) { $backend = [string]$cfg.ai.backend }
  elseif ($cfg -and $cfg.swarm -and $cfg.swarm.backend) { $backend = [string]$cfg.swarm.backend }
  if ($cfg -and $cfg.ai -and $cfg.ai.dsh -and $cfg.ai.dsh.url) { $url = [string]$cfg.ai.dsh.url }
  elseif ($cfg -and $cfg.swarm -and $cfg.swarm.dshUrl) { $url = [string]$cfg.swarm.dshUrl }
  $dlg = New-Object System.Windows.Forms.Form
  $dlg.Text = '群星参谋 v2 · 选择主控'
  $dlg.Size = New-Object System.Drawing.Size(600, 380)
  $dlg.StartPosition = 'CenterScreen'
  $dlg.FormBorderStyle = 'FixedDialog'
  $dlg.MaximizeBox = $false

  $title = New-Object System.Windows.Forms.Label
  $title.Text = '这次用谁来思考？'
  $title.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 13, [System.Drawing.FontStyle]::Bold)
  $title.SetBounds(24, 18, 400, 30)
  $dlg.Controls.Add($title)

  $localRadio = New-Object System.Windows.Forms.RadioButton
  $localRadio.Text = 'DeepSeek API（本地 API Key）'
  $localRadio.SetBounds(30, 60, 400, 24)
  $localRadio.Checked = ($backend -ne 'dsh')
  $dlg.Controls.Add($localRadio)

  $dshRadio = New-Object System.Windows.Forms.RadioButton
  $dshRadio.Text = 'DSH 插件（由 DSH 提供模型与子代理）'
  $dshRadio.SetBounds(30, 90, 400, 24)
  $dshRadio.Checked = ($backend -eq 'dsh')
  $dlg.Controls.Add($dshRadio)

  $urlLabel = New-Object System.Windows.Forms.Label
  $urlLabel.Text = 'DSH 地址'
  $urlLabel.SetBounds(30, 126, 80, 22)
  $dlg.Controls.Add($urlLabel)
  $urlBox = New-Object System.Windows.Forms.TextBox
  $urlBox.Text = $url
  $urlBox.SetBounds(110, 124, 320, 24)
  $urlBox.Enabled = ($backend -eq 'dsh')
  $dlg.Controls.Add($urlBox)

  $detect = New-Object System.Windows.Forms.Button
  $detect.Text = '自动检测'
  $detect.SetBounds(440, 122, 100, 26)
  $detect.Enabled = ($backend -eq 'dsh')
  $detect.Add_Click({
    try {
      $bin = Join-Path $root 'bin\stellaris-agent.mjs'
      $raw = (& $node $bin dsh-discover 2>$null) -join "`n"
      $found = $raw | ConvertFrom-Json
      if ($found.ok) { $urlBox.Text = [string]$found.url }
      else { [System.Windows.Forms.MessageBox]::Show('没找到运行中的 DSH 插件；先启动 DSH。', '群星参谋') | Out-Null }
    } catch { }
  })
  $dlg.Controls.Add($detect)

  $keyLabel = New-Object System.Windows.Forms.Label
  $keyLabel.Text = 'DeepSeek Key'
  $keyLabel.SetBounds(30, 166, 90, 22)
  $dlg.Controls.Add($keyLabel)
  $keyBox = New-Object System.Windows.Forms.TextBox
  $keyBox.SetBounds(120, 164, 420, 24)
  $keyBox.UseSystemPasswordChar = $true
  if ($cfg -and $cfg.ai -and $cfg.ai.deepseek -and $cfg.ai.deepseek.apiKey) { $keyBox.Text = [string]$cfg.ai.deepseek.apiKey }
  $dlg.Controls.Add($keyBox)

  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = 'Key 留空 = 保持原值；之后可在「设置」页修改。'
  $hint.ForeColor = [System.Drawing.Color]::Gray
  $hint.SetBounds(30, 196, 520, 22)
  $dlg.Controls.Add($hint)

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = '开始'
  $ok.SetBounds(340, 280, 90, 30)
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $dlg.Controls.Add($ok)
  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = '退出'
  $cancel.SetBounds(440, 280, 90, 30)
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
  $dlg.Controls.Add($cancel)
  $dlg.AcceptButton = $ok
  $dlg.CancelButton = $cancel
  $localRadio.Add_CheckedChanged({ $urlBox.Enabled = $dshRadio.Checked; $detect.Enabled = $dshRadio.Checked })
  $dshRadio.Add_CheckedChanged({ $urlBox.Enabled = $dshRadio.Checked; $detect.Enabled = $dshRadio.Checked })

  if ($dlg.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) { return $null }
  return [pscustomobject]@{
    backend = $(if ($dshRadio.Checked) { 'dsh' } else { 'deepseek' })
    dshUrl  = $urlBox.Text.Trim()
    apiKey  = $keyBox.Text.Trim()
  }
}

function Save-StartupChoice($choice) {
  $patch = @{ ai = @{ backend = $choice.backend; dsh = @{ url = $choice.dshUrl } } }
  if ($choice.apiKey) { $patch.ai.deepseek = @{ apiKey = $choice.apiKey } }
  try { $null = Invoke-Api -Path '/api/settings' -Method POST -Body $patch -TimeoutSec 10 } catch { }
}

# ---------------------------------------------------------------- 窗体
$form = New-Object System.Windows.Forms.Form
$form.Text = '群星参谋 v2 · 4.5'
$form.Size = New-Object System.Drawing.Size(1180, 840)
$form.StartPosition = 'CenterScreen'
$form.MinimumSize = New-Object System.Drawing.Size(960, 660)

$status = New-Object System.Windows.Forms.StatusStrip
$statusLabel = New-Object System.Windows.Forms.ToolStripStatusLabel
$statusLabel.Text = '启动中…'
$statusLabel.Spring = $true
$statusLabel.TextAlign = 'MiddleLeft'
$llmStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$llmStatus.Text = '大模型: ?'
$llmStatus.BorderSides = 'Left'
$gameStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$gameStatus.Text = '游戏: ?'
$gameStatus.BorderSides = 'Left'
$runStatus = New-Object System.Windows.Forms.ToolStripStatusLabel
$runStatus.Text = '调度: ?'
$runStatus.BorderSides = 'Left'
$connectBtn = New-Object System.Windows.Forms.ToolStripButton
$connectBtn.Text = '连接 / 重连'
$status.Items.AddRange(@($statusLabel, $llmStatus, $gameStatus, $runStatus, $connectBtn)) | Out-Null
$form.Controls.Add($status)

$tabs = New-Object System.Windows.Forms.TabControl
$tabs.Dock = 'Fill'
$form.Controls.Add($tabs)

function New-TabPage($text) {
  $page = New-Object System.Windows.Forms.TabPage
  $page.Text = $text
  $tabs.TabPages.Add($page)
  return $page
}

function New-Text($page, $readOnly = $true, $fontName = 'Consolas', $size = 9) {
  $box = New-Object System.Windows.Forms.RichTextBox
  $box.Dock = 'Fill'
  $box.ReadOnly = $readOnly
  $box.Font = New-Object System.Drawing.Font($fontName, $size)
  $box.BackColor = [System.Drawing.Color]::FromArgb(20, 24, 30)
  $box.ForeColor = [System.Drawing.Color]::FromArgb(220, 225, 232)
  $box.WordWrap = $false
  $page.Controls.Add($box)
  return $box
}

function New-BottomPanel($page, $height = 44) {
  $panel = New-Object System.Windows.Forms.Panel
  $panel.Dock = 'Bottom'
  $panel.Height = $height
  $page.Controls.Add($panel)
  return $panel
}

function New-Button($parent, $text, $x, $w = 110, $y = 6) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $text
  $button.SetBounds($x, $y, $w, 28)
  $parent.Controls.Add($button)
  return $button
}

# ---------------------------------------------------------------- 战局
$tabWar = New-TabPage '战局'
$warBox = New-Text $tabWar
$warPanel = New-BottomPanel $tabWar 44
$warRefresh = New-Button $warPanel '刷新' 8
$warRead = New-Button $warPanel '全量读取' 124 110
$warHint = New-Object System.Windows.Forms.Label
$warHint.SetBounds(244, 10, 820, 24)
$warHint.ForeColor = [System.Drawing.Color]::Gray
$warHint.Text = '读取范围：全局/政府/内阁/法令/科研/领袖/物种/外交/战争/事件/局势/每颗星球/每支舰队/模组/存档'
$warPanel.Controls.Add($warHint)

# ---------------------------------------------------------------- 主会话
$tabMain = New-TabPage '主会话'
$mainSplit = New-Object System.Windows.Forms.SplitContainer
$mainSplit.Dock = 'Fill'
$mainSplit.Orientation = 'Horizontal'
$mainSplit.SplitterDistance = 210
$tabMain.Controls.Add($mainSplit)
$mainSummary = New-Text $mainSplit.Panel1
$mainTranscript = New-Text $mainSplit.Panel2
$mainPanel = New-BottomPanel $tabMain 40
$mainRefreshBtn = New-Button $mainPanel '刷新' 8 70
$mainMeta = New-Object System.Windows.Forms.Label
$mainMeta.SetBounds(90, 10, 920, 22)
$mainMeta.ForeColor = [System.Drawing.Color]::Gray
$mainPanel.Controls.Add($mainMeta)

# ---------------------------------------------------------------- 子会话
$tabSub = New-TabPage '子会话'
$subSplit = New-Object System.Windows.Forms.SplitContainer
$subSplit.Dock = 'Fill'
$subSplit.Orientation = 'Horizontal'
$subSplit.SplitterDistance = 210
$tabSub.Controls.Add($subSplit)
$subSummary = New-Text $subSplit.Panel1
$subTranscript = New-Text $subSplit.Panel2
$subTop = New-Object System.Windows.Forms.Panel
$subTop.Dock = 'Top'
$subTop.Height = 46
$tabSub.Controls.Add($subTop)
$subPickLabel = New-Object System.Windows.Forms.Label
$subPickLabel.Text = '选择子会话'
$subPickLabel.SetBounds(8, 13, 80, 22)
$subTop.Controls.Add($subPickLabel)
$subSelect = New-Object System.Windows.Forms.ComboBox
$subSelect.SetBounds(92, 11, 540, 24)
$subSelect.DropDownStyle = 'DropDownList'
$subSelect.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$subTop.Controls.Add($subSelect)
$subRefreshBtn = New-Button $subTop '刷新' 644 70 10
$subFailBtn = New-Button $subTop '失败报告' 724 88 10
$subMeta = New-Object System.Windows.Forms.Label
$subMeta.SetBounds(820, 13, 360, 22)
$subMeta.ForeColor = [System.Drawing.Color]::Gray
$subTop.Controls.Add($subMeta)

# ---------------------------------------------------------------- 对话
$tabChat = New-TabPage '对话'
$chatBox = New-Text $tabChat $true 'Microsoft YaHei UI' 10
$chatPanel = New-BottomPanel $tabChat 78
$whoLabel = New-Object System.Windows.Forms.Label
$whoLabel.Text = 'id'
$whoLabel.SetBounds(8, 12, 18, 22)
$chatPanel.Controls.Add($whoLabel)
$chatWho = New-Object System.Windows.Forms.TextBox
$chatWho.SetBounds(28, 10, 130, 24)
$chatWho.Text = 'player'
$chatPanel.Controls.Add($chatWho)
$chatInput = New-Object System.Windows.Forms.TextBox
$chatInput.SetBounds(166, 10, 720, 24)
$chatInput.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10)
$chatInput.Anchor = 'Top,Left,Right'
$chatPanel.Controls.Add($chatInput)
$chatSend = New-Button $chatPanel '发送' 894 80 8
$chatSend.Anchor = 'Top,Right'
$chatHint = New-Object System.Windows.Forms.Label
$chatHint.Text = '主会话会看到 id + 内容；它的回复出现在这里，也通过 GET /api/chat/poll 暴露给外部。'
$chatHint.ForeColor = [System.Drawing.Color]::Gray
$chatHint.SetBounds(8, 44, 1000, 22)
$chatPanel.Controls.Add($chatHint)

# ---------------------------------------------------------------- 动作
$tabAct = New-TabPage '动作'
$actSplit = New-Object System.Windows.Forms.SplitContainer
$actSplit.Dock = 'Fill'
$actSplit.Orientation = 'Vertical'
$actSplit.SplitterDistance = 460
$tabAct.Controls.Add($actSplit)
$actList = New-Object System.Windows.Forms.ListBox
$actList.Dock = 'Fill'
$actList.Font = New-Object System.Drawing.Font('Consolas', 9)
$actSplit.Panel1.Controls.Add($actList)
$actEditor = New-Object System.Windows.Forms.RichTextBox
$actEditor.Dock = 'Fill'
$actEditor.Font = New-Object System.Drawing.Font('Consolas', 10)
$actEditor.Text = '[{ "method": "set_paused", "params": { "paused": true } }]'
$actSplit.Panel2.Controls.Add($actEditor)
$actPanel = New-BottomPanel $tabAct 44
$actLoad = New-Button $actPanel '列出动作' 8
$actRun = New-Button $actPanel '执行' 124 80
$actResult = New-Object System.Windows.Forms.Label
$actResult.SetBounds(214, 12, 880, 24)
$actResult.ForeColor = [System.Drawing.Color]::Gray
$actPanel.Controls.Add($actResult)

# ---------------------------------------------------------------- 读取 / 事件链
$tabRead = New-TabPage '读取与事件'
$readBox = New-Text $tabRead
$readPanel = New-BottomPanel $tabRead 44
$readFull = New-Button $readPanel '全量读取' 8
$readEvents = New-Button $readPanel '已激活事件链' 124 130
$readUnits = New-Button $readPanel '可控单位' 260 100
$readMods = New-Button $readPanel '模组' 366 70
$readExec = New-Button $readPanel '执行器' 442 80

# ---------------------------------------------------------------- 调度
$tabRun = New-TabPage '调度'
$runBox = New-Text $tabRun
$runPanel = New-BottomPanel $tabRun 82
$objLabel = New-Object System.Windows.Forms.Label
$objLabel.Text = '战略目标'
$objLabel.SetBounds(8, 12, 70, 22)
$runPanel.Controls.Add($objLabel)
$runObjective = New-Object System.Windows.Forms.TextBox
$runObjective.SetBounds(80, 10, 820, 24)
$runObjective.Anchor = 'Top,Left,Right'
$runPanel.Controls.Add($runObjective)
$runStart = New-Button $runPanel '启动调度' 8 90 44
$runStop = New-Button $runPanel '停止' 104 70 44
$runRestart = New-Button $runPanel '重启' 180 70 44
$runPause = New-Button $runPanel '暂停游戏' 256 90 44
$runResume = New-Button $runPanel '恢复游戏' 352 90 44
$runStatusBtn = New-Button $runPanel '刷新状态' 448 90 44

# ---------------------------------------------------------------- 人格
$tabPersona = New-TabPage '人格'

# ---------------------------------------------------------------- 设置
$tabSet = New-TabPage '设置'
$setScroll = New-Object System.Windows.Forms.Panel
$setScroll.Dock = 'Fill'
$setScroll.AutoScroll = $true
$tabSet.Controls.Add($setScroll)

function Add-Label($parent, $text, $x, $y, $w = 170) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $text
  $label.AutoSize = $false
  $label.TextAlign = 'MiddleLeft'
  $label.SetBounds($x, $y, $w, 24)
  $parent.Controls.Add($label)
  return $label
}
function Add-TextBox($parent, $x, $y, $w, $value = '') {
  $box = New-Object System.Windows.Forms.TextBox
  $box.SetBounds($x, $y, $w, 26)
  if ($value) { $box.Text = [string]$value }
  $parent.Controls.Add($box)
  return $box
}
function Add-Hint($parent, $text, $x, $y, $w = 520) {
  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = $text
  $hint.AutoSize = $false
  $hint.ForeColor = [System.Drawing.Color]::Gray
  $hint.SetBounds($x, $y, $w, 22)
  $parent.Controls.Add($hint)
  return $hint
}

# 设置面板内容比窗口高：显式给出滚动范围，避免最后几行被挡住
$setScroll.AutoScrollMinSize = New-Object System.Drawing.Size(0, 750)

[void](Add-Label $setScroll '群星安装目录' 24 24)
$setGame = Add-TextBox $setScroll 200 22 470
$setGameBrowse = New-Button $setScroll '浏览' 680 80 20
$setGameBrowse.Add_Click({
  $fb = New-Object System.Windows.Forms.FolderBrowserDialog
  if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $setGame.Text = $fb.SelectedPath }
})

[void](Add-Label $setScroll '群星用户目录' 24 66)
$setUser = Add-TextBox $setScroll 200 64 470
$setUserBrowse = New-Button $setScroll '浏览' 680 80 62
$setUserBrowse.Add_Click({
  $fb = New-Object System.Windows.Forms.FolderBrowserDialog
  if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $setUser.Text = $fb.SelectedPath }
})

[void](Add-Label $setScroll '存档目录' 24 108)
$setSave = Add-TextBox $setScroll 200 106 470
$setSaveBrowse = New-Button $setScroll '浏览' 680 80 104
$setSaveBrowse.Add_Click({
  $fb = New-Object System.Windows.Forms.FolderBrowserDialog
  if ($fb.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $setSave.Text = $fb.SelectedPath }
})
$setSaveHint = Add-Hint $setScroll '留空 = 用户目录\save games' 200 136 470

# 思考后端单独一行，右侧放说明，避免和下面的 Key 挤在一起
[void](Add-Label $setScroll '思考后端' 24 184)
$setBackend = New-Object System.Windows.Forms.ComboBox
$setBackend.SetBounds(200, 182, 220, 26)
$setBackend.DropDownStyle = 'DropDownList'
[void]$setBackend.Items.Add('deepseek')
[void]$setBackend.Items.Add('dsh')
$setScroll.Controls.Add($setBackend)
[void](Add-Hint $setScroll 'deepseek = 本地 API Key；dsh = DSH 插件' 440 184 420)

[void](Add-Label $setScroll 'DeepSeek Key' 24 226)
$setKey = Add-TextBox $setScroll 200 224 470
$setKey.UseSystemPasswordChar = $true
$setTestLlm = New-Button $setScroll '测试大模型连接' 680 130 220
$setTestLlm.Add_Click({
  try {
    $r = Invoke-Api -Path '/api/readiness?verify=1' -TimeoutSec 40
    $state = if ($r.llm.ok) { '已连接' } else { '未连接' }
    $text = "后端：$($r.llm.backend)`r`n结果：$state`r`n详情：$($r.llm.detail)"
    [System.Windows.Forms.MessageBox]::Show($text, '大模型连接测试') | Out-Null
  } catch { Show-Error '测试失败' $_ }
})
$setKeyHint = Add-Hint $setScroll '留空 = 保持已保存的 Key' 200 252 470

[void](Add-Label $setScroll 'DSH 地址' 24 294)
$setDsh = Add-TextBox $setScroll 200 292 380
$setDshDetect = New-Button $setScroll '自动检测' 590 110 290
$setDshDetect.Add_Click({
  try {
    $found = Invoke-Api -Path '/api/dsh/discover' -TimeoutSec 20
    if ($found.ok) { $setDsh.Text = [string]$found.url } else { [System.Windows.Forms.MessageBox]::Show('没找到运行中的 DSH 插件。', '群星参谋') | Out-Null }
  } catch { Show-Error '检测失败' $_ }
})

# 阈值一行一个，右侧写清含义，避免四个控件挤在一行
[void](Add-Label $setScroll '动作数 > X 暂停' 24 336)
$setPause = Add-TextBox $setScroll 200 334 80
[void](Add-Hint $setScroll '待执行动作达到该数量时，先暂停游戏再执行' 300 336 560)

[void](Add-Label $setScroll 'Y 次重试' 24 378)
$setAttempts = Add-TextBox $setScroll 200 376 80
[void](Add-Hint $setScroll '同一动作执行失败后的重试次数（执行器级）' 300 378 560)

[void](Add-Label $setScroll '主会话间隔(秒)' 24 420)
$setMainInterval = Add-TextBox $setScroll 200 418 80
[void](Add-Hint $setScroll '定时决策间隔；事件/聊天/子会话上报会提前唤醒' 300 420 560)

[void](Add-Label $setScroll '看护间隔(秒)' 24 462)
$setWatch = Add-TextBox $setScroll 200 460 80
[void](Add-Hint $setScroll '自动注入桥 / 自动接管游戏的检查间隔' 300 462 560)

[void](Add-Label $setScroll '自动连接' 24 512)
$setAutoInject = New-Object System.Windows.Forms.CheckBox
$setAutoInject.Text = '游戏在跑时自动注入原生桥（一次注入后自动续上）'
$setAutoInject.SetBounds(200, 508, 600, 26)
$setScroll.Controls.Add($setAutoInject)
$setAutoStart = New-Object System.Windows.Forms.CheckBox
$setAutoStart.Text = '进局后自动启动调度器'
$setAutoStart.SetBounds(200, 540, 600, 26)
$setScroll.Controls.Add($setAutoStart)

$setPluginLabel = Add-Label $setScroll 'DSH 插件' 24 588 170
$setPluginInfo = Add-Label $setScroll '' 200 588 560
$setPluginInfo.ForeColor = [System.Drawing.Color]::Gray
$setInstall = New-Button $setScroll '安装/更新插件' 200 140 620
$setReload = New-Button $setScroll '重载 DSH（热）' 350 140 620
$setRestart = New-Button $setScroll '重启 DSH（危险）' 500 170 620
$setRestart.Add_Click({
  $confirm = [System.Windows.Forms.MessageBox]::Show('重启 DSH 会中断当前的 DSH 会话。确定继续？', '群星参谋', 'YesNo', 'Warning')
  if ($confirm -ne [System.Windows.Forms.DialogResult]::Yes) { return }
  try {
    $r = Invoke-Api -Path '/api/plugin/reload' -Method POST -Body @{ allowRestart = $true } -TimeoutSec 90
    [System.Windows.Forms.MessageBox]::Show(($r | ConvertTo-Json -Depth 6), '重载结果') | Out-Null
  } catch { Show-Error '重载失败' $_ }
})

$setSaveBtn = New-Button $setScroll '保存设置' 200 130 668
$setDiag = New-Button $setScroll '导出诊断' 340 130 668
$setStatusLabel = Add-Label $setScroll '' 24 708 900

# ---------------------------------------------------------------- 会话格式化
function Format-Session($s) {
  $sb = New-Object System.Text.StringBuilder
  [void]$sb.AppendLine("会话：$(Val $s.label)（$(Val $s.id)）  kind=$(Val $s.kind)")
  [void]$sb.AppendLine("状态：$(Val $s.status)   运行：$(Val $s.running 'false')   轮次：$(Val $s.turns 0)   消息：$(Val $s.messageCount 0)")
  [void]$sb.AppendLine("目标：$(Val $s.objective $(Val $s.goal '-'))")
  if ($s.lastReport) {
    [void]$sb.AppendLine("上次报告：$(Val $s.lastReport.status)  $(Val $s.lastReport.say '')")
    if ($s.lastReport.cause) { [void]$sb.AppendLine("失败原因：$($s.lastReport.cause)") }
    if ($s.lastReport.suggestion) { [void]$sb.AppendLine("建议：$($s.lastReport.suggestion)") }
    if ($null -ne $s.lastReport.attempts) { [void]$sb.AppendLine("尝试次数：$($s.lastReport.attempts)") }
    if ($s.lastReport.exported) { [void]$sb.AppendLine("失败报告：$($s.lastReport.exported.file)") }
  }
  if ($s.lastDecision) { [void]$sb.AppendLine("上次决策：$(Val $s.lastDecision.say '(无)')") }
  if ($s.lastError) { [void]$sb.AppendLine("错误：$(Val $s.lastError)") }
  [void]$sb.AppendLine('')
  [void]$sb.AppendLine("=== 系统提示（$(Val $s.systemChars 0) 字符）===")
  [void]$sb.AppendLine([string]$s.system)
  foreach ($m in @($s.messages)) {
    if ($null -eq $m) { continue }
    $who = switch ($m.role) { 'assistant' { 'AI' } 'user' { '输入' } default { [string]$m.role } }
    [void]$sb.AppendLine('')
    [void]$sb.AppendLine("----- [$who $(Format-Time $m.ts)] ($(Val $m.chars 0) 字符) -----")
    [void]$sb.AppendLine([string]$m.content)
  }
  return $sb.ToString()
}

# ---------------------------------------------------------------- 人格
$personaTop = New-Object System.Windows.Forms.Panel
$personaTop.Dock = 'Top'
$personaTop.Height = 46
$tabPersona.Controls.Add($personaTop)
$personaPresetLabel = New-Object System.Windows.Forms.Label
$personaPresetLabel.Text = '预设'
$personaPresetLabel.SetBounds(10, 13, 36, 22)
$personaTop.Controls.Add($personaPresetLabel)
$personaPreset = New-Object System.Windows.Forms.ComboBox
$personaPreset.SetBounds(48, 11, 210, 24)
$personaPreset.DropDownStyle = 'DropDownList'
$personaTop.Controls.Add($personaPreset)
$personaApplyPreset = New-Button $personaTop '应用预设' 266 88 10
$personaImportBtn = New-Button $personaTop '导入组件文件' 360 106 10
$personaPasteBtn = New-Button $personaTop '粘贴导入' 472 88 10
$personaSave = New-Button $personaTop '保存并应用' 566 106 10
$personaPreviewBtn = New-Button $personaTop '预览提示词' 678 100 10
$personaStatus = New-Object System.Windows.Forms.Label
$personaStatus.SetBounds(786, 13, 380, 22)
$personaStatus.ForeColor = [System.Drawing.Color]::Gray
$personaTop.Controls.Add($personaStatus)

$personaLeft = New-Object System.Windows.Forms.GroupBox
$personaLeft.Text = 'AI 属性（0-100，拖动滑动条）'
$personaLeft.SetBounds(12, 56, 430, 566)
$tabPersona.Controls.Add($personaLeft)
$script:traitBars = @{}
$script:traitVals = @{}
$traitDefs = @(
  @{ key = 'aggression'; label = '侵略性' },
  @{ key = 'boldness'; label = '大胆' },
  @{ key = 'caution'; label = '谨慎' },
  @{ key = 'honor'; label = '荣誉' },
  @{ key = 'diplomacy'; label = '外交' },
  @{ key = 'expansion'; label = '扩张' },
  @{ key = 'economy'; label = '经济' },
  @{ key = 'research'; label = '科研' },
  @{ key = 'military'; label = '军事' },
  @{ key = 'compassion'; label = '共情' }
)
$traitY = 30
foreach ($trait in $traitDefs) {
  [void](Add-Label $personaLeft $trait.label 12 $traitY 88)
  $bar = New-Object System.Windows.Forms.TrackBar
  $bar.SetBounds(100, ($traitY - 6), 270, 36)
  $bar.Minimum = 0
  $bar.Maximum = 100
  $bar.TickFrequency = 10
  $bar.SmallChange = 5
  $bar.LargeChange = 10
  $bar.Value = 50
  $personaLeft.Controls.Add($bar)
  $val = Add-Label $personaLeft '50' 378 $traitY 32
  $val.TextAlign = 'MiddleRight'
  $script:traitBars[$trait.key] = $bar
  $script:traitVals[$trait.key] = $val
  $key = $trait.key
  $bar.Add_ValueChanged({
    param($sender, $eventArgs)
    if (-not $script:personaLoading) {
      $script:traitVals[$key].Text = [string]$sender.Value
      $script:personaDirty = $true
    }
  }.GetNewClosure())
  $traitY += 50
}
$personaLeftHint = New-Object System.Windows.Forms.Label
$personaLeftHint.Text = '这些数值会直接写进主会话人格提示词；越极端，决策越有倾向。'
$personaLeftHint.ForeColor = [System.Drawing.Color]::Gray
$personaLeftHint.SetBounds(12, 528, 400, 22)
$personaLeft.Controls.Add($personaLeftHint)

$personaRight = New-Object System.Windows.Forms.GroupBox
$personaRight.Text = '人格设定 / 人格组件'
$personaRight.SetBounds(454, 56, 720, 566)
$tabPersona.Controls.Add($personaRight)

[void](Add-Label $personaRight '名字' 12 28 52)
$personaName = Add-TextBox $personaRight 66 26 200
[void](Add-Label $personaRight '头衔' 286 28 44)
$personaTitle = Add-TextBox $personaRight 332 26 240

[void](Add-Label $personaRight '身份' 12 64 52)
$personaIdentity = Add-TextBox $personaRight 66 62 610
$personaIdentity.Multiline = $true
$personaIdentity.Height = 44
$personaIdentity.ScrollBars = 'Vertical'

[void](Add-Label $personaRight '来路' 12 116 52)
$personaBackground = Add-TextBox $personaRight 66 114 610
$personaBackground.Multiline = $true
$personaBackground.Height = 54
$personaBackground.ScrollBars = 'Vertical'

[void](Add-Label $personaRight '在意的事' 12 176 60)
$personaValues = Add-TextBox $personaRight 66 174 610
$personaValues.Multiline = $true
$personaValues.Height = 44
$personaValues.ScrollBars = 'Vertical'

[void](Add-Label $personaRight '小毛病' 12 226 60)
$personaQuirks = Add-TextBox $personaRight 66 224 610
$personaQuirks.Multiline = $true
$personaQuirks.Height = 44
$personaQuirks.ScrollBars = 'Vertical'

[void](Add-Label $personaRight '说话风格' 12 276 60)
$personaStyle = Add-TextBox $personaRight 66 274 610
$personaStyle.Multiline = $true
$personaStyle.Height = 40
$personaStyle.ScrollBars = 'Vertical'

[void](Add-Label $personaRight '嗓音' 12 322 52)
$personaVoiceDesc = Add-TextBox $personaRight 66 320 250
[void](Add-Label $personaRight '单句字数' 330 322 70)
$personaMaxChars = New-Object System.Windows.Forms.NumericUpDown
$personaMaxChars.SetBounds(404, 320, 70, 24)
$personaMaxChars.Minimum = 20
$personaMaxChars.Maximum = 500
$personaMaxChars.Value = 120
$personaRight.Controls.Add($personaMaxChars)

$personaVoiceEnabled = New-Object System.Windows.Forms.CheckBox
$personaVoiceEnabled.Text = '启用“人话”（voice）'
$personaVoiceEnabled.SetBounds(66, 352, 170, 22)
$personaRight.Controls.Add($personaVoiceEnabled)
[void](Add-Label $personaRight '每 N 轮' 244 352 54)
$personaEvery = New-Object System.Windows.Forms.NumericUpDown
$personaEvery.SetBounds(302, 350, 54, 24)
$personaEvery.Minimum = 1
$personaEvery.Maximum = 20
$personaEvery.Value = 1
$personaRight.Controls.Add($personaEvery)
[void](Add-Label $personaRight '最短间隔(秒)' 366 352 86)
$personaMin = New-Object System.Windows.Forms.NumericUpDown
$personaMin.SetBounds(456, 350, 70, 24)
$personaMin.Minimum = 0
$personaMin.Maximum = 600
$personaMin.Value = 15
$personaRight.Controls.Add($personaMin)

[void](Add-Label $personaRight '示例句子' 12 384 60)
$personaExamples = Add-TextBox $personaRight 66 382 610
$personaExamples.Multiline = $true
$personaExamples.Height = 44
$personaExamples.ScrollBars = 'Vertical'

[void](Add-Label $personaRight '人格组件' 12 436 60)
$personaComponents = New-Object System.Windows.Forms.ListBox
$personaComponents.SetBounds(66, 434, 500, 84)
$personaComponents.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9)
$personaRight.Controls.Add($personaComponents)
$personaRemoveComponent = New-Button $personaRight '移除' 578 60 434
$personaImportInline = New-Button $personaRight '导入' 578 60 464
$personaPasteInline = New-Button $personaRight '粘贴' 578 60 494

$personaHint = New-Object System.Windows.Forms.Label
$personaHint.Text = '数值是“倾向”，不是硬规则；人格组件支持 Character Card V2 / JSON / Markdown / 纯文本。主会话每轮会输出 voice（人话），外部程序可轮询 /api/voice。'
$personaHint.ForeColor = [System.Drawing.Color]::Gray
$personaHint.SetBounds(12, 528, 700, 30)
$personaRight.Controls.Add($personaHint)

$script:personaLoading = $false
$script:personaDirty = $false
$script:personaPresetIds = @()
$script:personaComponentIds = @()

function Set-PersonaDraft($persona) {
  $script:personaLoading = $true
  try {
    foreach ($key in $script:traitBars.Keys) {
      $value = 50
      if ($null -ne $persona.traits -and $null -ne $persona.traits.$key) { $value = [int]$persona.traits.$key }
      $script:traitBars[$key].Value = [Math]::Max(0, [Math]::Min(100, $value))
      $script:traitVals[$key].Text = [string]$script:traitBars[$key].Value
    }
    $personaName.Text = [string]$persona.name
    $personaTitle.Text = [string]$persona.title
    $personaIdentity.Text = [string]$persona.identity
    $personaBackground.Text = [string]$persona.background
    $personaValues.Text = (@($persona.values) -join "`r`n")
    $personaQuirks.Text = (@($persona.quirks) -join "`r`n")
    $personaStyle.Text = [string]$persona.speech.style
    $personaVoiceDesc.Text = [string]$persona.speech.voice
    $personaMaxChars.Value = [Math]::Max(20, [Math]::Min(500, [int]$persona.speech.maxChars))
    $personaExamples.Text = (@($persona.speech.examples) -join "`r`n")
    $personaVoiceEnabled.Checked = ($persona.voice.enabled -ne $false)
    $personaEvery.Value = [Math]::Max(1, [Math]::Min(20, [int]$persona.voice.everyTurns))
    $personaMin.Value = [Math]::Max(0, [Math]::Min(600, [int]$persona.voice.minIntervalSeconds))
    $personaComponents.Items.Clear()
    $script:personaComponentIds = @()
    foreach ($component in @($persona.components)) {
      [void]$personaComponents.Items.Add("$($component.name) · $($component.chars) 字")
      $script:personaComponentIds += [string]$component.id
    }
    if ($script:personaPresetIds.Count -gt 0) {
      $index = [Array]::IndexOf($script:personaPresetIds, [string]$persona.preset)
      if ($index -ge 0) { $personaPreset.SelectedIndex = $index }
    }
    $script:personaDirty = $false
  } finally {
    $script:personaLoading = $false
  }
}

function Get-PersonaDraft {
  $traits = @{}
  foreach ($key in $script:traitBars.Keys) { $traits[$key] = [int]$script:traitBars[$key].Value }
  return @{
    name = $personaName.Text.Trim()
    title = $personaTitle.Text.Trim()
    preset = 'custom'
    traits = $traits
    identity = $personaIdentity.Text.Trim()
    background = $personaBackground.Text.Trim()
    values = @($personaValues.Text -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
    quirks = @($personaQuirks.Text -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
    speech = @{
      style = $personaStyle.Text.Trim()
      voice = $personaVoiceDesc.Text.Trim()
      language = '中文'
      maxChars = [int]$personaMaxChars.Value
      examples = @($personaExamples.Text -split "`r?`n" | Where-Object { $_.Trim() } | ForEach-Object { $_.Trim() })
    }
    voice = @{
      enabled = [bool]$personaVoiceEnabled.Checked
      everyTurns = [int]$personaEvery.Value
      minIntervalSeconds = [int]$personaMin.Value
    }
  }
}

function Refresh-Persona {
  try {
    $r = Invoke-Api -Path '/api/persona' -TimeoutSec 15
    if ($script:personaPresetIds.Count -eq 0) {
      $personaPreset.Items.Clear()
      $script:personaPresetIds = @()
      foreach ($preset in @($r.presets)) {
        [void]$personaPreset.Items.Add([string]$preset.label)
        $script:personaPresetIds += [string]$preset.id
      }
    }
    Set-PersonaDraft $r.persona
    $personaStatus.Text = "已加载 · $(Get-Date -Format HH:mm:ss)"
  } catch {
    $personaStatus.Text = "未连接后端：$($_.Exception.Message)"
  }
}

function Save-Persona {
  try {
    $draft = Get-PersonaDraft
    $r = Invoke-Api -Path '/api/persona' -Method POST -Body @{ persona = $draft } -TimeoutSec 20
    Set-PersonaDraft $r.persona
    $personaStatus.Text = "已保存并应用 · $(Get-Date -Format HH:mm:ss)"
  } catch { Show-Error '保存人格失败' $_ }
}

function Import-PersonaText([string]$text, [string]$name) {
  if (-not $text -or -not $text.Trim()) { return }
  try {
    $r = Invoke-Api -Path '/api/persona/import' -Method POST -Body @{ text = $text; filename = $name } -TimeoutSec 30
    Refresh-Persona
    $label = if ($r.component) { $r.component.name } else { '组件' }
    [System.Windows.Forms.MessageBox]::Show("已导入：$label（$($r.format)）", '人格组件') | Out-Null
  } catch { Show-Error '导入人格组件失败' $_ }
}

function Import-PersonaFile {
  $dlg = New-Object System.Windows.Forms.OpenFileDialog
  $dlg.Title = '选择人格组件（Character Card V2 / JSON / Markdown / 文本）'
  $dlg.Filter = '人格组件 (*.json;*.md;*.txt)|*.json;*.md;*.txt|所有文件 (*.*)|*.*'
  if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
    try {
      $text = [System.IO.File]::ReadAllText($dlg.FileName, [System.Text.Encoding]::UTF8)
      Import-PersonaText $text ([System.IO.Path]::GetFileName($dlg.FileName))
    } catch { Show-Error '读取人格组件失败' $_ }
  }
}

function Import-PersonaClipboard {
  try {
    $text = [System.Windows.Forms.Clipboard]::GetText()
    if (-not $text -or -not $text.Trim()) {
      [System.Windows.Forms.MessageBox]::Show('剪贴板里没有文本。', '粘贴导入') | Out-Null
      return
    }
    Import-PersonaText $text 'clipboard.txt'
  } catch { Show-Error '粘贴导入失败' $_ }
}

# ---------------------------------------------------------------- 状态刷新
$script:subRows = @()
$script:subSig = ''
$script:chatSince = 0

function Update-Readiness {
  try {
    $r = Invoke-Api -Path '/api/readiness' -TimeoutSec 10
    if ($r.llm.ok) {
      Set-StatusLabel $llmStatus ("大模型: 已连接 (" + $r.llm.label + ")") ([System.Drawing.Color]::Green)
    } else {
      Set-StatusLabel $llmStatus ("大模型: 未连接 — " + $r.llm.detail) ([System.Drawing.Color]::OrangeRed)
    }
    $llmStatus.ToolTipText = "后端：$($r.llm.backend)`r`n详情：$($r.llm.detail)"
    if ($r.game.ok -and $r.game.inGame) {
      Set-StatusLabel $gameStatus ("游戏: 已连接 " + (Val $r.game.date)) ([System.Drawing.Color]::Green)
    } elseif ($r.game.ok) {
      Set-StatusLabel $gameStatus '游戏: 已连接（主菜单）' ([System.Drawing.Color]::Orange)
    } else {
      Set-StatusLabel $gameStatus ("游戏: 未连接 — " + $r.game.detail) ([System.Drawing.Color]::OrangeRed)
    }
    $gameStatus.ToolTipText = "桥：$($r.game.detail)`r`n注入：$($r.game.injected)`r`nPID：$(Val $r.game.pid)`r`n自动注入：$($r.autoInject) / 自动接管：$($r.autoStart)"
    if ($r.running) {
      Set-StatusLabel $runStatus '调度: 运行中' ([System.Drawing.Color]::Green)
    } else {
      Set-StatusLabel $runStatus '调度: 未启动' ([System.Drawing.Color]::Gray)
    }
    if ($r.lastConnect) {
      $inject = if ($r.lastConnect.injected) { '本次已注入' } else { '复用已注入' }
      $statusLabel.Text = "$inject · $(Get-Date -Format HH:mm:ss)"
    }
    return $r
  } catch {
    Set-StatusLabel $llmStatus '大模型: 后端不可用' ([System.Drawing.Color]::Gray)
    Set-StatusLabel $gameStatus '游戏: 后端不可用' ([System.Drawing.Color]::Gray)
    Set-StatusLabel $runStatus '调度: ?' ([System.Drawing.Color]::Gray)
    $statusLabel.Text = "后端不可用：$($_.Exception.Message)"
    return $null
  }
}

function Update-Counters {
  try {
    $s = Invoke-Api -Path '/api/status' -TimeoutSec 10
    $o = $s.orchestrator
    if ($s.running -and $o) {
      $world = $o.world
      $statusLabel.Text = "已接管：$(Val $world.date)｜殖民地 $(Val $world.colonies 0)｜舰队 $(Val $world.fleets 0)｜事件 $(Val $world.activeEvents 0)｜队列 $(Val $o.executor.queuedActions 0)｜单位 $($o.units.Count)"
      $runBox.Text = ($o | ConvertTo-Json -Depth 8)
    }
  } catch { }
}

function Update-SessionBoxes($summaryBox, $transcriptBox, $session) {
  $text = Format-Session $session
  $lines = $text.Split("`n")
  $summary = ($lines[0..([Math]::Min(8, $lines.Count - 1))] -join "`r`n")
  if ($summaryBox.Text -ne $summary) { $summaryBox.Text = $summary }
  if ($transcriptBox.Text -ne $text) {
    $atBottom = $transcriptBox.SelectionStart -ge ($transcriptBox.TextLength - 50)
    $transcriptBox.Text = $text
    if ($atBottom) {
      $transcriptBox.SelectionStart = $transcriptBox.TextLength
      $transcriptBox.ScrollToCaret()
    }
  }
}

function Refresh-MainView {
  if ($tabs.SelectedTab -ne $tabMain) { return }
  try {
    $r = Invoke-Api -Path '/api/sessions/main' -TimeoutSec 10
    Update-SessionBoxes $mainSummary $mainTranscript $r.session
    $mainMeta.Text = "状态=$(Val $r.session.status)  轮次=$(Val $r.session.turns 0)  消息=$(Val $r.session.messageCount 0)  更新 $(Get-Date -Format HH:mm:ss)"
  } catch {
    $mainMeta.Text = "读取失败：$($_.Exception.Message)"
  }
}

function Refresh-SubList {
  try {
    $r = Invoke-Api -Path '/api/sessions' -TimeoutSec 10
    $rows = @($r.sessions | Where-Object { $_.kind -ne 'main' })
    $sig = ($rows | ForEach-Object { "$($_.id)|$($_.status)|$($_.turns)|$($_.running)|$($_.label)" }) -join ';'
    if ($sig -eq $script:subSig -and $subSelect.Items.Count -eq $rows.Count) { return }
    $selectedId = $null
    if ($subSelect.SelectedIndex -ge 0 -and $subSelect.SelectedIndex -lt $script:subRows.Count) {
      $selectedId = $script:subRows[$subSelect.SelectedIndex].id
    }
    $script:subSig = $sig
    $script:subRows = @()
    $subSelect.BeginUpdate()
    $subSelect.Items.Clear()
    foreach ($row in $rows) {
      $mark = if ($row.running) { '●' } else { '○' }
      [void]$subSelect.Items.Add("$mark $(Val $row.label) [$((Val $row.status))] $((Val $row.turns 0))轮")
      $script:subRows += $row
    }
    $subSelect.EndUpdate()
    if ($script:subRows.Count -eq 0) {
      $subSelect.SelectedIndex = -1
      return
    }
    $index = 0
    if ($selectedId) {
      for ($i = 0; $i -lt $script:subRows.Count; $i++) {
        if ($script:subRows[$i].id -eq $selectedId) { $index = $i; break }
      }
    }
    $subSelect.SelectedIndex = $index
  } catch { }
}

function Refresh-SubView {
  if ($tabs.SelectedTab -ne $tabSub) { return }
  if ($subSelect.SelectedIndex -lt 0 -or $subSelect.SelectedIndex -ge $script:subRows.Count) {
    $subSummary.Text = '还没有子会话。启动调度后，每个可操控单位（星球/舰队/科研/内阁/法令/经济/外交）都会有一个 1:1 子会话，突发的特殊事件也会临时出现。'
    $subTranscript.Text = ''
    $subMeta.Text = ''
    return
  }
  try {
    $row = $script:subRows[$subSelect.SelectedIndex]
    $r = Invoke-Api -Path ('/api/sessions/' + [uri]::EscapeDataString($row.id)) -TimeoutSec 10
    Update-SessionBoxes $subSummary $subTranscript $r.session
    $subMeta.Text = "id=$(Val $row.id)  状态=$(Val $r.session.status)  轮次=$(Val $r.session.turns 0)  更新 $(Get-Date -Format HH:mm:ss)"
  } catch {
    $subMeta.Text = "读取失败：$($_.Exception.Message)"
  }
}

function Update-Chat {
  try {
    $r = Invoke-Api -Path "/api/chat/poll?since=$script:chatSince" -TimeoutSec 8
    foreach ($m in @($r.messages)) {
      if (-not $m) { continue }
      $who = if ($m.direction -eq 'in') { "你($($m.id))" } else { "参谋($($m.id))" }
      $chatBox.AppendText("$who：$($m.text)`r`n")
      $script:chatSince = [int]$m.seq
    }
  } catch { }
}

function Load-Settings {
  try {
    $r = Invoke-Api -Path '/api/settings' -TimeoutSec 8
    $c = $r.config
    $setGame.Text = [string]$c.paths.stellarisInstallDir
    $setUser.Text = [string]$c.paths.stellarisUserDir
    $setSave.Text = [string]$c.paths.saveDir
    $setBackend.SelectedItem = [string]$c.ai.backend
    if ($null -eq $setBackend.SelectedItem) { $setBackend.SelectedIndex = 0 }
    $setKey.Text = ''
    if ($c.ai.deepseek.apiKeyConfigured) { $setKeyHint.Text = "已配置（$($c.ai.deepseek.apiKeyHint)），留空保持不变" } else { $setKeyHint.Text = '未配置' }
    $setDsh.Text = [string]$c.ai.dsh.url
    $setPause.Text = [string]$c.executor.pauseWhenQueuedActions
    $setAttempts.Text = [string]$c.executor.maxAttempts
    $setMainInterval.Text = [string]$c.ai.main.intervalSeconds
    $setWatch.Text = [string]$c.bridge.watchSeconds
    $setAutoInject.Checked = [bool]$c.bridge.autoInject
    $setAutoStart.Checked = [bool]$c.bridge.autoStartOrchestrator
    $setPluginInfo.Text = "配置结构 v$($c.version) · $($r.configFile)"
    $setStatusLabel.Text = "配置文件：$($r.configFile)"
  } catch { }
}

# ---------------------------------------------------------------- 后端
$script:server = $null
function Start-Backend {
  $bin = Join-Path $root 'bin\stellaris-agent.mjs'
  try {
    Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -match 'stellaris-agent' -and $_.CommandLine -match '\b serve\b' -and $_.CommandLine -match "port $Port\b" } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 300
  } catch { }
  $logDir = Join-Path $agentHome 'logs'
  New-Item -ItemType Directory -Force $logDir | Out-Null
  $script:server = Start-Process -FilePath $node -ArgumentList @($bin, 'serve', '--port', "$Port") -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $logDir 'backend.out.log') -RedirectStandardError (Join-Path $logDir 'backend.err.log')
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    try { $null = Invoke-RestMethod -Uri "$base/api/health" -TimeoutSec 2; return $true } catch { Start-Sleep -Milliseconds 500 }
  }
  return $false
}

# ---------------------------------------------------------------- 事件绑定
$warRefresh.Add_Click({ Update-Readiness; Update-Counters; Update-Chat })
$warRead.Add_Click({
  try {
    $r = Invoke-Api -Path '/api/refresh' -Method POST -Body @{ deep = $true } -TimeoutSec 180
    $warBox.Text = "已重新读取：$($r.world.readMs)ms"
  } catch { Show-Error '读取失败' $_ }
})

$connectBtn.Add_Click({
  try {
    $r = Invoke-Api -Path '/api/connect' -Method POST -Body @{ start = $null } -TimeoutSec 120
    Update-Readiness
    if (-not $r.ok) { [System.Windows.Forms.MessageBox]::Show((Val $r.error '连接失败') + "`r`n" + (Val $r.detail ''), '连接群星') | Out-Null }
  } catch { Show-Error '连接失败' $_ }
})

$personaSave.Add_Click({ Save-Persona })
$personaApplyPreset.Add_Click({
  try {
    $index = $personaPreset.SelectedIndex
    if ($index -lt 0 -or $index -ge $script:personaPresetIds.Count) { return }
    $r = Invoke-Api -Path '/api/persona/preset' -Method POST -Body @{ id = $script:personaPresetIds[$index] } -TimeoutSec 20
    Set-PersonaDraft $r.persona
    $personaStatus.Text = "已应用预设：$($personaPreset.Text)"
  } catch { Show-Error '应用人格预设失败' $_ }
})
$personaImportBtn.Add_Click({ Import-PersonaFile })
$personaImportInline.Add_Click({ Import-PersonaFile })
$personaPasteBtn.Add_Click({ Import-PersonaClipboard })
$personaPasteInline.Add_Click({ Import-PersonaClipboard })
$personaPreviewBtn.Add_Click({
  try {
    $r = Invoke-Api -Path '/api/persona' -TimeoutSec 15
    $text = [string]$r.prompt
    if ($text.Length -gt 6000) { $text = $text.Substring(0, 6000) + "`r`n…（已截断）" }
    [System.Windows.Forms.MessageBox]::Show($text, '人格提示词预览') | Out-Null
  } catch { Show-Error '读取人格提示词失败' $_ }
})
$personaRemoveComponent.Add_Click({
  try {
    $index = $personaComponents.SelectedIndex
    if ($index -lt 0 -or $index -ge $script:personaComponentIds.Count) { return }
    $null = Invoke-Api -Path '/api/persona/component/remove' -Method POST -Body @{ id = $script:personaComponentIds[$index] } -TimeoutSec 20
    Refresh-Persona
    $personaStatus.Text = '已移除人格组件'
  } catch { Show-Error '移除人格组件失败' $_ }
})
$tabs.Add_SelectedIndexChanged({
  if ($tabs.SelectedTab -eq $tabPersona) { Refresh-Persona }
})

$subFailBtn.Add_Click({
  try {
    $dir = Join-Path $agentHome 'failures'
    if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Force $dir | Out-Null }
    Start-Process explorer.exe $dir
  } catch { Show-Error '打开失败报告目录失败' $_ }
})

$chatSend.Add_Click({
  $text = $chatInput.Text.Trim()
  if (-not $text) { return }
  $id = $chatWho.Text.Trim()
  if (-not $id) { $id = 'player' }
  $chatInput.Text = ''
  try { $null = Invoke-Api -Path '/api/chat/in' -Method POST -Body @{ id = $id; text = $text } -TimeoutSec 15; Update-Chat }
  catch { Show-Error '发送失败' $_ }
})
$chatInput.Add_KeyDown({
  param($sender, $e)
  if ($e.KeyCode -eq [System.Windows.Forms.Keys]::Enter) { $chatSend.PerformClick(); $e.SuppressKeyPress = $true }
})

$actLoad.Add_Click({
  try {
    $r = Invoke-Api -Path '/api/actions' -TimeoutSec 10
    $actList.Items.Clear()
    foreach ($a in $r.actions) {
      $params = ($a.params | ForEach-Object { "$($_.name)$(if ($_.required) { '' } else { '?' }):$($_.type)" }) -join ', '
      [void]$actList.Items.Add("$($a.method)($params)")
    }
    $actResult.Text = "共 $($r.actions.Count) 个动作"
  } catch { Show-Error '读取动作失败' $_ }
})
$actList.Add_SelectedIndexChanged({
  if ($actList.SelectedItem -eq $null) { return }
  $method = ([string]$actList.SelectedItem).Split('(')[0]
  $actEditor.Text = "[{ `"method`": `"$method`", `"params`": {} }]"
})
$actRun.Add_Click({
  try {
    $actions = $actEditor.Text | ConvertFrom-Json
    $r = Invoke-Api -Path '/api/execute' -Method POST -Body @{ actions = @($actions) } -TimeoutSec 120
    $actResult.Text = "结果：$($r.ok) $($r.summary)"
    $actEditor.Text = ($r | ConvertTo-Json -Depth 8)
  } catch { Show-Error '执行失败' $_ }
})

$readFull.Add_Click({
  try { $r = Invoke-Api -Path '/api/world?full=1' -TimeoutSec 120; $readBox.Text = ($r.world | ConvertTo-Json -Depth 6) }
  catch { Show-Error '读取失败' $_ }
})
$readEvents.Add_Click({
  try { $r = Invoke-Api -Path '/api/world/events' -TimeoutSec 30; $readBox.Text = ($r | ConvertTo-Json -Depth 10) }
  catch { Show-Error '读取事件失败' $_ }
})
$readUnits.Add_Click({
  try { $r = Invoke-Api -Path '/api/units' -TimeoutSec 30; $readBox.Text = ($r | ConvertTo-Json -Depth 8) }
  catch { Show-Error '读取单位失败' $_ }
})
$readMods.Add_Click({
  try { $r = Invoke-Api -Path '/api/mods' -TimeoutSec 30; $readBox.Text = ($r | ConvertTo-Json -Depth 8) }
  catch { Show-Error '读取模组失败' $_ }
})
$readExec.Add_Click({
  try { $r = Invoke-Api -Path '/api/executor' -TimeoutSec 30; $readBox.Text = ($r | ConvertTo-Json -Depth 8) }
  catch { Show-Error '读取执行器失败' $_ }
})

$runStart.Add_Click({
  try {
    $r = Invoke-Api -Path '/api/orchestrator/start' -Method POST -Body @{ objective = $runObjective.Text.Trim() } -TimeoutSec 180
    $runBox.Text = ($r.status | ConvertTo-Json -Depth 8)
    Update-Readiness
  } catch { Show-Error '启动调度失败' $_ }
})
$runStop.Add_Click({
  try {
    $r = Invoke-Api -Path '/api/orchestrator/stop' -Method POST -Body @{ resume = $true } -TimeoutSec 60
    $runBox.Text = ($r | ConvertTo-Json -Depth 6)
    Update-Readiness
  } catch { Show-Error '停止失败' $_ }
})
$runRestart.Add_Click({
  try {
    $r = Invoke-Api -Path '/api/orchestrator/restart' -Method POST -Body @{ objective = $runObjective.Text.Trim() } -TimeoutSec 240
    $runBox.Text = ($r | ConvertTo-Json -Depth 6)
    Update-Readiness
  } catch { Show-Error '重启失败' $_ }
})
$runPause.Add_Click({ try { $r = Invoke-Api -Path '/api/pause' -Method POST -TimeoutSec 30; $runBox.Text = ($r | ConvertTo-Json) } catch { Show-Error '暂停失败' $_ } })
$runResume.Add_Click({ try { $r = Invoke-Api -Path '/api/resume' -Method POST -TimeoutSec 30; $runBox.Text = ($r | ConvertTo-Json) } catch { Show-Error '恢复失败' $_ } })
$runStatusBtn.Add_Click({
  try { $r = Invoke-Api -Path '/api/status' -TimeoutSec 20; $runBox.Text = ($r.orchestrator | ConvertTo-Json -Depth 8) } catch { Show-Error '读取失败' $_ }
})

$mainRefreshBtn.Add_Click({ Refresh-MainView })
$subRefreshBtn.Add_Click({ Refresh-SubList; Refresh-SubView })
$subSelect.Add_SelectedIndexChanged({ Refresh-SubView })

$setInstall.Add_Click({
  try { $r = Invoke-Api -Path '/api/plugin/install' -Method POST -TimeoutSec 120; [System.Windows.Forms.MessageBox]::Show(($r | ConvertTo-Json -Depth 6), '安装结果') | Out-Null }
  catch { Show-Error '安装失败' $_ }
})
$setReload.Add_Click({
  try { $r = Invoke-Api -Path '/api/plugin/reload' -Method POST -Body @{ allowRestart = $false } -TimeoutSec 60; [System.Windows.Forms.MessageBox]::Show(($r | ConvertTo-Json -Depth 6), '重载结果') | Out-Null }
  catch { Show-Error '重载失败' $_ }
})
$setDiag.Add_Click({
  try {
    $r = Invoke-Api -Path '/api/diagnostics' -TimeoutSec 30
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $file = Join-Path $agentHome "diagnostics-$stamp.json"
    $r | ConvertTo-Json -Depth 20 | Set-Content $file -Encoding utf8
    [System.Windows.Forms.MessageBox]::Show("诊断已导出：$file", '群星参谋') | Out-Null
    Start-Process explorer.exe -ArgumentList ('/select,' + $file) | Out-Null
  } catch { Show-Error '导出失败' $_ }
})
$setSaveBtn.Add_Click({
  $pauseValue = 8
  $attemptValue = 3
  $intervalValue = 120
  $watchValue = 15
  [int]::TryParse($setPause.Text, [ref]$pauseValue) | Out-Null
  [int]::TryParse($setAttempts.Text, [ref]$attemptValue) | Out-Null
  [int]::TryParse($setMainInterval.Text, [ref]$intervalValue) | Out-Null
  [int]::TryParse($setWatch.Text, [ref]$watchValue) | Out-Null
  $patch = @{
    paths    = @{ stellarisInstallDir = $setGame.Text.Trim(); stellarisUserDir = $setUser.Text.Trim(); saveDir = $setSave.Text.Trim() }
    ai       = @{
      backend  = [string]$setBackend.SelectedItem
      deepseek = @{ apiKey = $setKey.Text.Trim() }
      dsh      = @{ url = $setDsh.Text.Trim() }
      main     = @{ intervalSeconds = $intervalValue }
    }
    executor = @{ pauseWhenQueuedActions = $pauseValue; maxAttempts = $attemptValue }
    bridge   = @{ autoInject = [bool]$setAutoInject.Checked; autoStartOrchestrator = [bool]$setAutoStart.Checked; watchSeconds = $watchValue }
  }
  try {
    $r = Invoke-Api -Path '/api/settings' -Method POST -Body $patch -TimeoutSec 120
    $restartOk = '否'
    if ($r.restart -and $r.restart.ok) { $restartOk = '是' }
    $setStatusLabel.Text = "已保存：$($r.saved)（调度器重启：$restartOk）"
    Load-Settings
    Update-Readiness
  } catch { Show-Error '保存失败' $_ }
})

# ---------------------------------------------------------------- 启动
# STELLARIS_GUI_NO_DIALOG=1：直接用已保存配置启动（不弹"选择主控"）
$noDialog = ($env:STELLARIS_GUI_NO_DIALOG -eq '1')
$choice = if ($SelfTest -or $noDialog) {
  $savedBackend = 'deepseek'
  $savedDsh = 'http://127.0.0.1:49939'
  if ($cfg -and $cfg.ai -and $cfg.ai.backend) { $savedBackend = [string]$cfg.ai.backend }
  elseif ($cfg -and $cfg.swarm -and $cfg.swarm.backend) { $savedBackend = [string]$cfg.swarm.backend }
  if ($cfg -and $cfg.ai -and $cfg.ai.dsh -and $cfg.ai.dsh.url) { $savedDsh = [string]$cfg.ai.dsh.url }
  elseif ($cfg -and $cfg.swarm -and $cfg.swarm.dshUrl) { $savedDsh = [string]$cfg.swarm.dshUrl }
  [pscustomobject]@{ backend = $savedBackend; dshUrl = $savedDsh; apiKey = '' }
} else {
  Show-BackendDialog
}
if (-not $choice) { exit 0 }

if ($SelfTest) {
  # 顺带跑一遍纯函数，避免"能建窗口但格式化一调用就崩"
  $sample = [pscustomobject]@{
    id = 'main'; kind = 'main'; label = '主会话'; status = 'ok'; running = $false
    turns = 2; messageCount = 2; system = 'sys'; systemChars = 3; objective = 'obj'
    messages = @(
      [pscustomobject]@{ role = 'user'; content = 'hi'; ts = 0; chars = 2 },
      [pscustomobject]@{ role = 'assistant'; content = 'yo'; ts = 0; chars = 2 }
    )
    lastReport = $null; lastDecision = $null
  }
  $rendered = Format-Session $sample
  if (-not $rendered.Contains('主会话')) { throw 'Format-Session 输出异常' }
  if ((Val $null 'fallback') -ne 'fallback') { throw 'Val 输出异常' }
  # 单窗口布局：必须有主会话/子会话两个页签，且子会话是下拉框
  $tabNames = @($tabs.TabPages | ForEach-Object { $_.Text })
  foreach ($need in @('战局', '主会话', '子会话', '人格', '设置')) {
    if (-not ($tabNames -contains $need)) { throw "缺少页签：$need（实际 $($tabNames -join ',')）" }
  }
  if ($tabNames -contains '会话') { throw '不应再有旧的「会话」页签' }
  if ($subSelect.GetType().Name -ne 'ComboBox') { throw '子会话选择器不是下拉框' }
  if ($personaComponents.GetType().Name -ne 'ListBox') { throw '人格组件不是列表' }
  if ($script:traitBars.Count -ne 10) { throw "AI 属性滑动条数量不对：$($script:traitBars.Count)" }
  foreach ($bar in $script:traitBars.Values) {
    if ($bar.Minimum -ne 0 -or $bar.Maximum -ne 100) { throw 'AI 属性滑动条范围不是 0-100' }
  }
  $samplePersona = @{
    name = '自检'; title = '测试'; preset = 'custom'
    traits = @{ aggression = 77; boldness = 50; caution = 50; honor = 50; diplomacy = 50; expansion = 50; economy = 50; research = 50; military = 50; compassion = 50 }
    identity = '身份'; background = '来路'; values = @('价值'); quirks = @('怪癖')
    speech = @{ style = '风格'; voice = '嗓音'; maxChars = 100; examples = @('示例') }
    voice = @{ enabled = $true; everyTurns = 1; minIntervalSeconds = 15 }
    components = @(@{ id = 'c1'; name = '组件'; chars = 12 })
  }
  Set-PersonaDraft ([pscustomobject]$samplePersona)
  if ($script:traitBars['aggression'].Value -ne 77) { throw '人格滑动条未按数值渲染' }
  if (-not $personaName.Text.Contains('自检')) { throw '人格文本框未按数值渲染' }
  # 两个会话面板各渲染一次（不依赖后端）
  Update-SessionBoxes $subSummary $subTranscript $sample
  if (-not $subSummary.Text.Contains('主会话')) { throw '子会话摘要面板渲染失败' }
  if (-not $subTranscript.Text.Contains('hi')) { throw '子会话对话面板渲染失败' }
  Update-SessionBoxes $mainSummary $mainTranscript $sample
  if (-not $mainTranscript.Text.Contains('yo')) { throw '主会话对话面板渲染失败' }
  # 没有后端时刷新应走 catch，不得抛异常
  Refresh-MainView
  Refresh-SubList
  # 设置页排版：关键行之间必须留出间距，底部不能被挡
  if ($setBackend.Bottom + 8 -gt $setKey.Top) { throw '「思考后端」与「DeepSeek Key」间距不足' }
  if ($setPause.Bottom + 8 -gt $setAttempts.Top) { throw '阈值行之间间距不足' }
  if ($setAttempts.Bottom + 8 -gt $setMainInterval.Top) { throw '阈值行之间间距不足（2）' }
  if ($setScroll.AutoScrollMinSize.Height -lt $setStatusLabel.Bottom) { throw '设置页滚动高度不足，底部会被挡住' }
  $form.Dispose()
  Write-Output 'GUI selftest OK'
  exit 0
}

if (-not (Start-Backend)) {
  [System.Windows.Forms.MessageBox]::Show('后端启动失败：检查 Node、端口占用与 config.json。', '群星参谋') | Out-Null
  if ($script:server) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue }
  exit 1
}

if ($noDialog) {
  # 用的是已保存配置，不要再用"启动选择"覆盖它
} else {
  Save-StartupChoice $choice
}
Load-Settings

$script:timer = New-Object System.Windows.Forms.Timer
$script:timer.Interval = 5000
$script:timer.Add_Tick({ Update-Readiness; Update-Counters })
$script:chatTimer = New-Object System.Windows.Forms.Timer
$script:chatTimer.Interval = 2000
$script:chatTimer.Add_Tick({ Update-Chat })
$script:sessTimer = New-Object System.Windows.Forms.Timer
$script:sessTimer.Interval = 2000
$script:sessTimer.Add_Tick({ Refresh-MainView; Refresh-SubList; Refresh-SubView })

$form.Add_Shown({
  Update-Readiness
  Update-Counters
  Update-Chat
  Refresh-MainView
  Refresh-SubList
  Refresh-SubView
  $script:timer.Start()
  $script:chatTimer.Start()
  $script:sessTimer.Start()
})
$form.Add_FormClosed({
  if ($script:timer) { $script:timer.Stop() }
  if ($script:chatTimer) { $script:chatTimer.Stop() }
  if ($script:sessTimer) { $script:sessTimer.Stop() }
  if ($script:server) { Stop-Process -Id $script:server.Id -Force -ErrorAction SilentlyContinue }
})

[void]$form.ShowDialog()
