#Requires -Version 5.1
$ErrorActionPreference = "Stop"

Write-Host "=== Astra Gemini (星空双子座) v0.1.0 一键初始化 ===" -ForegroundColor Cyan

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Error "未检测到 Node.js (>= 25)，请先安装 Node.js 后重试。"
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Error "未检测到 Git for Windows，请先安装 Git 后重试。"
}

Write-Host "环境已就绪：Node $(node -v) | $(git --version)" -ForegroundColor Green

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location $root

$projectsFile = Join-Path $root "projects.json"
if (-not (Test-Path $projectsFile)) {
  Copy-Item (Join-Path $root "projects.example.json") $projectsFile
  Write-Host "已生成 projects.json（启动后可直接在网页控制台里可视化编辑）" -ForegroundColor Yellow
}

$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
foreach ($name in @("token.txt", "join-token.txt", "admin-key.txt", "mcp-path.txt")) {
  $tokenFile = Join-Path $root $name
  if (-not (Test-Path $tokenFile)) {
    $bytes = New-Object byte[] 32
    [System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
    $token = ($bytes | ForEach-Object { $_.ToString("x2") }) -join ""
    Set-Content -Path $tokenFile -Value $token -Encoding ASCII -NoNewline
    Write-Host "已生成随机 Token 并保存到 $name" -ForegroundColor Green
  }
  icacls $tokenFile /inheritance:r /grant:r "*${currentSid}:F" | Out-Null
}

Write-Host "正在运行内置自动化自检（含三层树状 WebSocket 组网测试）..." -ForegroundColor Cyan
node --test test/bridge.test.mjs

try {
  $desktop = [Environment]::GetFolderPath("Desktop")
  $lnkPath = Join-Path $desktop "Astra Gemini.lnk"
  $wsh = New-Object -ComObject WScript.Shell
  $sc = $wsh.CreateShortcut($lnkPath)
  $sc.TargetPath = "wscript.exe"
  $sc.Arguments = """$(Join-Path $root 'Start-AstraGemini.vbs')"""
  $sc.WorkingDirectory = $root
  $sc.Description = "启动 Astra Gemini (星空双子座) 托盘与本地控制台"
  $sc.Save()
  Write-Host "已在桌面创建快捷方式：Astra Gemini" -ForegroundColor Green
} catch {
  Write-Host "创建桌面快捷方式跳过（可直接双击目录里的 Start-AstraGemini.vbs）" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "安装完成！直接双击桌面「Astra Gemini」或本目录的「Start-AstraGemini.vbs」即可启动。" -ForegroundColor Green
