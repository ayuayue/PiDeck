# Android 模拟器的日常操作：起模拟器、装应用、拿连接链接。
#
#   pwsh -File scripts/android.ps1 up      # 启动 medium_phone 模拟器（已启动则跳过）
#   pwsh -File scripts/android.ps1 app     # 构建 x86_64 包、安装并在模拟器里打开
#   pwsh -File scripts/android.ps1 link    # 把模拟器用的连接链接复制到剪贴板
#   pwsh -File scripts/android.ps1 status  # 看设备、模拟器和端口
param(
    [Parameter(Position = 0)]
    [ValidateSet('up', 'app', 'link', 'status')]
    [string]$Action = 'status'
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$sdk = if ($env:ANDROID_HOME) { $env:ANDROID_HOME } else { Join-Path $env:LOCALAPPDATA 'Android\Sdk' }
$adb = Join-Path $sdk 'platform-tools\adb.exe'
$android = Join-Path $sdk 'android.exe'
$avd = 'medium_phone'
$pkg = 'dev.nsgo.pidecklite'
$activity = 'dev.oneo.nsgo.NsgoActivity'

function Get-Device {
    if (-not (Test-Path $adb)) { return '' }
    $line = & $adb devices 2>$null | Select-String -Pattern '^(\S+)\s+device$'
    if ($line) { return $line.Matches[0].Groups[1].Value }
    return ''
}

function Read-RemoteConfig {
    $home_ = if ($env:PIDECK_LITE_HOME) { $env:PIDECK_LITE_HOME } else { Join-Path $env:APPDATA 'dev.nsgo.pidecklite' }
    $path = Join-Path $home_ 'config.json'
    if (-not (Test-Path $path)) { throw "找不到 $path：先运行一次桌面端，再在 设置 → 远程 里打开服务。" }
    $cfg = Get-Content $path -Raw | ConvertFrom-Json
    $port = if ($cfg.remotePort) { [int]$cfg.remotePort } else { 8787 }
    if (-not $cfg.remoteEnabled) { throw '桌面端的远程服务还没打开：设置 → 远程 → 允许手机连接。' }
    if (-not $cfg.remoteToken) { throw '桌面端还没有访问令牌：在 设置 → 远程 里启用一次即可生成。' }
    return @{ Port = $port; Token = $cfg.remoteToken }
}

switch ($Action) {
    'up' {
        if (Get-Device) { "模拟器已在运行：$(Get-Device)"; break }
        & $android emulator start $avd
        "已启动：$(Get-Device)"
    }
    'app' {
        Push-Location $root
        try {
            & go tool nsgo build -target android_x64 -installers=false
            if ($LASTEXITCODE -ne 0) { throw '构建失败' }
        } finally { Pop-Location }
        $apk = Get-ChildItem (Join-Path $root 'dist\releases') -Filter '*android-x64.apk' -ErrorAction SilentlyContinue |
            Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if (-not $apk) { throw '没有找到 x86_64 的 APK，检查上面的构建输出。' }
        & $adb install -r -t $apk.FullName
        & $adb shell am force-stop $pkg
        & $adb shell am start -n "$pkg/$activity" | Out-Null
        "已安装并打开：$($apk.Name)"
    }
    'link' {
        $cfg = Read-RemoteConfig
        $url = "http://10.0.2.2:$($cfg.Port)/?token=$([uri]::EscapeDataString($cfg.Token))"
        Set-Clipboard -Value $url
        $url
        '已复制。模拟器窗口里点地址栏，按 Ctrl+V 粘贴，再点「连接」。'
    }
    'status' {
        "SDK     $sdk"
        "设备    $(if (Get-Device) { Get-Device } else { '无（先运行 up）' })"
        & $android emulator list 2>$null | Where-Object { $_ -and $_ -notmatch 'JAVA_TOOL' } | ForEach-Object { "AVD     $_" }
        try {
            $cfg = Read-RemoteConfig
            "桌面端  http://10.0.2.2:$($cfg.Port)  令牌已配置"
        } catch {
            "桌面端  $($_.Exception.Message)"
        }
    }
}
