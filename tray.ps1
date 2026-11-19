#Requires -Version 5.1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Port = 3939
$UiUrl = "http://127.0.0.1:$Port/ui"
$McpUrl = "http://127.0.0.1:$Port/mcp"

$createdNew = $false
$mutex = New-Object System.Threading.Mutex($true, "Local\AstraGeminiTrayMutex", [ref]$createdNew)
if (-not $createdNew) {
  Start-Process $UiUrl
  exit 0
}

function Get-OrCreateToken([string]$fileName) {
  $file = Join-Path $Root $fileName
  if (-not (Test-Path $file)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $t = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Set-Content -Path $file -Value $t -Encoding ASCII -NoNewline
    return $t
  }
  return (Get-Content -Path $file -Raw).Trim()
}

$token = Get-OrCreateToken "token.txt"
$joinToken = Get-OrCreateToken "join-token.txt"

$projectsFile = Join-Path $Root "projects.json"
if (-not (Test-Path $projectsFile)) {
  $exampleFile = Join-Path $Root "projects.example.json"
  if (Test-Path $exampleFile) { Copy-Item $exampleFile $projectsFile }
  else { Set-Content -Path $projectsFile -Value "{}" -Encoding UTF8 }
}

function New-StatusIcon([bool]$running) {
  $bmp = New-Object System.Drawing.Bitmap 32, 32
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $bgColor = if ($running) { [System.Drawing.Color]::FromArgb(79, 70, 229) } else { [System.Drawing.Color]::FromArgb(100, 116, 139) }
  $dotColor = if ($running) { [System.Drawing.Color]::FromArgb(34, 197, 94) } else { [System.Drawing.Color]::FromArgb(239, 68, 68) }
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $bgColor), 2, 2, 28, 28)
  $font = New-Object System.Drawing.Font("Segoe UI", 14, [System.Drawing.FontStyle]::Bold)
  $g.DrawString("A", $font, [System.Drawing.Brushes]::White, 7, 4)
  $g.FillEllipse((New-Object System.Drawing.SolidBrush $dotColor), 20, 20, 10, 10)
  $g.DrawEllipse([System.Drawing.Pens]::White, 20, 20, 10, 10)
  $g.Dispose()
  return [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
}

$script:nodeProc = $null
$script:iconRunning = New-StatusIcon $true
$script:iconStopped = New-StatusIcon $false

$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Text = "Astra Gemini"
$notify.Visible = $true

function Start-Bridge {
  if ($script:nodeProc -and -not $script:nodeProc.HasExited) { return }
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "node"
  $psi.Arguments = "src/server.mjs"
  $psi.WorkingDirectory = $Root
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables["HOST"] = "127.0.0.1"
  $psi.EnvironmentVariables["PORT"] = "$Port"
  $psi.EnvironmentVariables["AUTH_MODE"] = "bearer"
  $psi.EnvironmentVariables["ASTRA_TOKEN"] = $token
  $psi.EnvironmentVariables["ASTRA_JOIN_TOKEN"] = $joinToken
  $script:nodeProc = [System.Diagnostics.Process]::Start($psi)
  Update-TrayUi
}

function Stop-Bridge {
  if ($script:nodeProc -and -not $script:nodeProc.HasExited) {
    try { $script:nodeProc.Kill() } catch {}
    try { $script:nodeProc.WaitForExit(3000) } catch {}
  }
  $script:nodeProc = $null
  Update-TrayUi
}

$menu = New-Object System.Windows.Forms.ContextMenuStrip
$itemOpen = $menu.Items.Add("打开 Astra Gemini 控制台")
$itemToggle = $menu.Items.Add("停止服务")
$menu.Items.Add("-") | Out-Null
$itemCopyUrl = $menu.Items.Add("复制本机 MCP 地址")
$itemCopyToken = $menu.Items.Add("复制 Bearer Token")
$itemCopyJoin = $menu.Items.Add("复制入网 Token")
$itemOpenDir = $menu.Items.Add("打开程序目录")
$menu.Items.Add("-") | Out-Null
$itemExit = $menu.Items.Add("退出 Astra Gemini")

function Update-TrayUi {
  $running = ($script:nodeProc -and -not $script:nodeProc.HasExited)
  $notify.Icon = if ($running) { $script:iconRunning } else { $script:iconStopped }
  $notify.Text = if ($running) { "Astra Gemini (运行中 :$Port)" } else { "Astra Gemini (已停止)" }
  $itemToggle.Text = if ($running) { "停止服务" } else { "启动服务" }
}

$itemOpen.Add_Click({ Start-Process $UiUrl })
$itemToggle.Add_Click({
  if ($script:nodeProc -and -not $script:nodeProc.HasExited) { Stop-Bridge } else { Start-Bridge }
})
$itemCopyUrl.Add_Click({
  [System.Windows.Forms.Clipboard]::SetText($McpUrl)
  $notify.ShowBalloonTip(2000, "Astra Gemini", "已复制本机 MCP 地址", [System.Windows.Forms.ToolTipIcon]::Info)
})
$itemCopyToken.Add_Click({
  [System.Windows.Forms.Clipboard]::SetText($token)
  $notify.ShowBalloonTip(2000, "Astra Gemini", "已复制 Bearer Token", [System.Windows.Forms.ToolTipIcon]::Info)
})
$itemCopyJoin.Add_Click({
  [System.Windows.Forms.Clipboard]::SetText($joinToken)
  $notify.ShowBalloonTip(2000, "Astra Gemini", "已复制入网 Token（子节点 wss://<公网地址>/ws/tree 使用）", [System.Windows.Forms.ToolTipIcon]::Info)
})
$itemOpenDir.Add_Click({ Start-Process explorer.exe $Root })
$itemExit.Add_Click({
  Stop-Bridge
  $notify.Visible = $false
  $notify.Dispose()
  [System.Windows.Forms.Application]::Exit()
})

$notify.ContextMenuStrip = $menu
$notify.Add_DoubleClick({ Start-Process $UiUrl })

Start-Bridge
Start-Sleep -Milliseconds 600
$notify.ShowBalloonTip(2500, "Astra Gemini 已启动", "双击托盘图标可随时打开星空双子座控制台。", [System.Windows.Forms.ToolTipIcon]::Info)
Start-Process $UiUrl

try {
  [System.Windows.Forms.Application]::Run()
} finally {
  Stop-Bridge
  $notify.Visible = $false
  $notify.Dispose()
  $mutex.ReleaseMutex()
  $mutex.Dispose()
}
