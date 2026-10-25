# 会话垃圾文件 watchdog：.pi/sessions 出现新文件时，立刻抓取当前 node/pi/PiDeck
# 进程树（PID + 父 PID + 完整命令行）写入日志，用于定位是谁在并发 spawn pi。
#
# 用法（保持窗口开着即可，Ctrl+C 停止）：
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\watch-session-spawn.ps1
# 日志输出到 scripts\watch-session-spawn.log

$ErrorActionPreference = "SilentlyContinue"
$sessionDir = Join-Path $PSScriptRoot ".." ".pi\sessions"
$sessionDir = (Resolve-Path $sessionDir).Path
$logFile = Join-Path $PSScriptRoot "watch-session-spawn.log"

Write-Host "[watch] watching $sessionDir"
Write-Host "[watch] log -> $logFile"

$known = @{}
Get-ChildItem $sessionDir -Filter *.jsonl | ForEach-Object { $known[$_.FullName] = $true }

while ($true) {
    Start-Sleep -Seconds 2
    $current = Get-ChildItem $sessionDir -Filter *.jsonl
    foreach ($f in $current) {
        if (-not $known.ContainsKey($f.FullName)) {
            $known[$f.FullName] = $true
            $ts = Get-Date -Format "yyyy-MM-dd HH:mm:ss.fff"
            $header = "===== $ts NEW SESSION FILE: $($f.Name) ====="
            Write-Host $header
            Add-Content -Path $logFile -Value $header -Encoding UTF8

            # 抓全部 node/pi 相关进程：命令行 + 父进程链
            $procs = Get-CimInstance Win32_Process | Where-Object {
                $_.Name -match "node|cmd|powershell|pwsh|PiDeck" -or $_.CommandLine -match "\bpi\b"
            }
            foreach ($p in $procs) {
                $cmd = $p.CommandLine
                if ($null -eq $cmd) { $cmd = "" }
                $line = "PID={0} PPID={1} NAME={2} CMD={3}" -f $p.ProcessId, $p.ParentProcessId, $p.Name, $cmd
                Add-Content -Path $logFile -Value $line -Encoding UTF8
            }
            Add-Content -Path $logFile -Value "" -Encoding UTF8
        }
    }
}
