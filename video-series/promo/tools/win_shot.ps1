# win_shot.ps1 - save a window (or screen rect) to a full-resolution PNG on disk.
# Keeps captures out of the agent context, so a shot costs zero tokens.
# NOTE: this machine is 125% DPI. Without declaring DPI awareness, Win32 rects come
# back virtualized (2048x1152 logical) and CopyFromScreen grabs the wrong region.
#
# Usage:
#   powershell -NoProfile -File win_shot.ps1 -Out ref/a.png -ProcName PiDeck
#   powershell -NoProfile -File tools/win_shot.ps1 -Out ref/a.png -Hwnd 1708894 -Foreground -Move -X 320 -Y 180 -W 1920 -H 1080
param(
  [Parameter(Mandatory = $true)][string]$Out,
  [string]$ProcName = "",
  [long]$Hwnd = 0,
  [int]$X = -1,
  [int]$Y = -1,
  [int]$W = -1,
  [int]$H = -1,
  [switch]$Move,
  [switch]$Foreground,
  [switch]$List
)

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Dpi {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
"@
[void][Dpi]::SetProcessDPIAware()

Add-Type @"
using System;
using System.Runtime.InteropServices;
public class W {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern bool MoveWindow(IntPtr h, int x, int y, int w, int ht, bool repaint);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

function Get-Target {
  if ($Hwnd -ne 0) {
    $h = [IntPtr]$Hwnd
    $r = New-Object W+RECT
    if ([W]::GetWindowRect($h, [ref]$r)) {
      return [pscustomobject]@{ H = $h; X = $r.Left; Y = $r.Top; W = $r.Right - $r.Left; H2 = $r.Bottom - $r.Top; Title = "hwnd" }
    }
    return $null
  }
  if ($ProcName -eq "") { return $null }
  foreach ($p in (Get-Process -Name $ProcName -ErrorAction SilentlyContinue)) {
    if ($p.MainWindowHandle -ne 0) {
      $r = New-Object W+RECT
      if ([W]::GetWindowRect($p.MainWindowHandle, [ref]$r)) {
        return [pscustomobject]@{ H = $p.MainWindowHandle; X = $r.Left; Y = $r.Top; W = $r.Right - $r.Left; H2 = $r.Bottom - $r.Top; Title = $p.MainWindowTitle }
      }
    }
  }
  return $null
}

$win = Get-Target
if ($List) {
  if ($win) { Write-Output ("WIN {0} {1},{2} {3}x{4} '{5}'" -f $ProcName, $win.X, $win.Y, $win.W, $win.H2, $win.Title) }
  else { Write-Output "WIN $ProcName NOT-FOUND" }
  exit 0
}

if ($win -and $Foreground) {
  [void][W]::ShowWindow($win.H, 9)   # SW_RESTORE
  [void][W]::SetForegroundWindow($win.H)
  Start-Sleep -Milliseconds 450
  $win = Get-Target
}

# -Move pins the window to an exact 16:9 rect first, so every capture has identical framing.
if ($win -and $Move -and $X -ge 0 -and $Y -ge 0 -and $W -gt 0 -and $H -gt 0) {
  [void][W]::MoveWindow($win.H, $X, $Y, $W, $H, $true)
  Start-Sleep -Milliseconds 700
  $win = Get-Target
}

if ($X -lt 0 -and $win) { $X = $win.X; $Y = $win.Y; $W = $win.W; $H = $win.H2 }
if ($W -le 0 -or $H -le 0) { Write-Error "bad rect $X,$Y $W x $H"; exit 1 }

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($X, $Y, 0, 0, (New-Object System.Drawing.Size($W, $H)))
$g.Dispose()
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output ("OK {0} {1}x{2} at {3},{4}" -f $Out, $W, $H, $X, $Y)
