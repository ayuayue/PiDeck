<#
.SYNOPSIS
    Repair PiDeck Windows shortcuts (Start Menu / Desktop / Taskbar pins).

.DESCRIPTION
    Symptom: PiDeck shortcuts show the Windows generic placeholder icon
    (light-blue card with a small blue rectangle) instead of the real logo.
    Root cause: after a portable install (PiDeck.exe dropped in a directory
    without NSIS) or after an NSIS install is uninstalled but shortcuts are
    left behind, the .lnk files can have an empty or stale TargetPath.
    Windows cannot resolve the target, so Explorer / taskbar / Start Menu
    all fall back to the placeholder icon.

    This script:
      1. Locates PiDeck.exe (auto-detect from common install paths and
         the Windows Uninstall registry, or accept -ExePath explicitly).
      2. Scans per-user shortcut locations for .lnk files whose name
         contains "pideck".
      3. Repoints broken shortcuts (empty TargetPath or target that no
         longer exists) at the real PiDeck.exe. Working shortcuts are
         left untouched.
      4. Refreshes the Windows icon cache so Explorer and the taskbar
         pick up the corrected icon.

    Idempotent and per-user: no admin required. All-users locations
    (%PUBLIC%\Start Menu\Programs, %PUBLIC%\Desktop) are included when
    run elevated; otherwise they are reported as skipped.

    By default the script runs in DRY-RUN mode: it reports what would
    change without touching anything. Pass -Do to actually apply the
    fixes.

.PARAMETER ExePath
    Path to PiDeck.exe to use. Skips auto-detection when provided.
    Recommended for portable installs.

.PARAMETER Do
    Actually apply the fixes (default: dry-run, report only). Without
    this flag no shortcut is modified and the icon cache is not rebuilt.

.PARAMETER NoRebuildIconCache
    Fix the shortcuts but do NOT kill explorer / clear the icon cache.
    Useful when the icon is already correct and you only want to repair
    a broken shortcut path. Only meaningful with -Do.

.EXAMPLE
    .\fix-windows-shortcuts.ps1
    DRY-RUN: auto-detect PiDeck.exe, report every broken shortcut that
    would be fixed, but change nothing.

.EXAMPLE
    .\fix-windows-shortcuts.ps1 -Do -ExePath "D:\project\pideck\PiDeck.exe"
    Portable install: apply the fixes against the exact PiDeck.exe.

.NOTES
    Requires PowerShell 5.1+ (Windows 10+ default). Windows 11 ships
    PowerShell 5.1 by default; PowerShell 7+ works as well.
#>

[CmdletBinding()]
param(
    [string]$ExePath,
    [switch]$Do,
    [switch]$NoRebuildIconCache
)

$ErrorActionPreference = 'Stop'
$Shell = New-Object -ComObject WScript.Shell

# Default to dry-run for safety. -Do is the explicit opt-in to write.
# Everything downstream reads this variable, never a -DryRun switch.
$DryRun = -not $Do

# ------------------------------------------------------------------
# Helpers
# ------------------------------------------------------------------

# Whether the current PowerShell process runs elevated. All-users
# shortcut locations require admin; the per-user ones do not.
function Test-Admin {
    $id = [Security.Principal.WindowsIdentity]::GetCurrent()
    $p  = New-Object Security.Principal.WindowsPrincipal($id)
    return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

# Find PiDeck.exe: explicit -ExePath > well-known install dirs > the
# Windows Uninstall registry (NSIS writes InstallLocation on install).
function Find-PiDeckExe {
    if ($ExePath) {
        if (Test-Path $ExePath) { return (Resolve-Path $ExePath).Path }
        Write-Warning "ExePath not found: $ExePath"
        return $null
    }

    $candidates = @(
        # Per-user NSIS default (electron-builder default installDir)
        (Join-Path $env:LOCALAPPDATA 'Programs\PiDeck\PiDeck.exe'),
        # Legacy app name; matches older packaged versions
        (Join-Path $env:LOCALAPPDATA 'Programs\pi-desktop\PiDeck.exe'),
        # All-users install locations (some users install elevated)
        (Join-Path $env:ProgramFiles 'PiDeck\PiDeck.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'PiDeck\PiDeck.exe')
    )

    # Registry: read InstallLocation from every Uninstall entry that
    # advertises "PiDeck" in DisplayName. This covers NSIS installs
    # that landed in a non-default directory.
    $hives = @(
        'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall',
        'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall'
    )
    foreach ($hive in $hives) {
        Get-ChildItem $hive -ErrorAction SilentlyContinue | ForEach-Object {
            $pkg = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
            if ($pkg.DisplayName -match 'pideck' -and $pkg.InstallLocation) {
                $candidates += (Join-Path $pkg.InstallLocation 'PiDeck.exe')
            }
        }
    }

    foreach ($c in $candidates) {
        if ($c -and (Test-Path $c)) { return (Resolve-Path $c).Path }
    }
    return $null
}

# Collect every .lnk whose filename mentions "pideck".
#   - Per-user locations are always scanned.
#   - All-users locations are only scanned when elevated; otherwise
#     we skip them to avoid permission errors.
function Get-PiDeckShortcuts {
    $perUser = @(
        (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
        "$env:USERPROFILE\Desktop",
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\TaskBar'),
        (Join-Path $env:APPDATA 'Microsoft\Internet Explorer\Quick Launch\User Pinned\StartMenu')
    )
    $allUsers = @(
        (Join-Path $env:PUBLIC 'Microsoft\Windows\Start Menu\Programs'),
        (Join-Path $env:PUBLIC 'Desktop')
    )

    $locations = @($perUser)
    if (Test-Admin) { $locations += $allUsers }

    $results = @()
    foreach ($dir in $locations) {
        if (-not (Test-Path $dir)) { continue }
        Get-ChildItem $dir -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
            if ($_.Name -imatch 'pideck') { $results += $_.FullName }
        }
    }
    return $results
}

# Classify a shortcut as ok / empty / stale.
function Get-ShortcutStatus {
    param($lnkPath)
    $s      = $Shell.CreateShortcut($lnkPath)
    $target = $s.TargetPath
    if (-not $target)                { return @{ Status = 'empty'; Target = '' } }
    if (-not (Test-Path $target))    { return @{ Status = 'stale'; Target = $target } }
    return @{ Status = 'ok';    Target = $target }
}

# Rewrite a shortcut to point at a valid PiDeck.exe. IconLocation is
# set to "exe,0" so Explorer pulls the icon straight from the exe's
# embedded resources rather than depending on the shell icon cache.
function Fix-Shortcut {
    param($lnkPath, $targetExe, [switch]$DryRun)

    $workDir = Split-Path $targetExe -Parent
    $s       = $Shell.CreateShortcut($lnkPath)
    $old     = $s.TargetPath

    if ($DryRun) {
        Write-Host "      [dry-run] would repoint to $targetExe (was: '$old')"
        return
    }

    $s.TargetPath       = $targetExe
    $s.WorkingDirectory = $workDir
    $s.IconLocation     = "$targetExe,0"
    $s.Description      = 'PiDeck'
    $s.Save()
    Write-Host "      fixed -> $targetExe (was: '$old')"
}

# Kill Explorer, drop per-user icon cache, restart Explorer. Explorer
# rebuilds its icon cache lazily on next shell request.
function Rebuild-IconCache {
    Write-Host ''
    Write-Host 'Refreshing Windows icon cache...'

    taskkill /f /im explorer.exe 2>$null | Out-Null
    Start-Sleep -Seconds 1

    $cachePatterns = @(
        (Join-Path $env:LocalAppData 'IconCache.db'),
        (Join-Path $env:LocalAppData 'Microsoft\Windows\Explorer\iconcache*')
    )
    foreach ($p in $cachePatterns) {
        Get-ChildItem $p -ErrorAction SilentlyContinue | ForEach-Object {
            try {
                Remove-Item $_.FullName -Force -ErrorAction Stop
                Write-Host "  removed $($_.FullName)"
            } catch {
                Write-Host "  kept    $($_.FullName): $($_.Exception.Message)"
            }
        }
    }

    Start-Process explorer.exe
    Write-Host 'Explorer restarted.'
}

# ------------------------------------------------------------------
# Main
# ------------------------------------------------------------------

Write-Host 'PiDeck Windows shortcut fixer'
Write-Host ('  Date: ' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
if ($DryRun) {
    Write-Host '  Mode: DRY-RUN (add -Do to actually apply changes)'
} else {
    Write-Host '  Mode: APPLY'
}
Write-Host ''

$exe = Find-PiDeckExe
Write-Host "PiDeck.exe: $(if ($exe) { $exe } else { 'NOT FOUND' })"
Write-Host ''

$shortcuts = @(Get-PiDeckShortcuts)
Write-Host "PiDeck shortcuts found: $($shortcuts.Count)"

if ($shortcuts.Count -eq 0) {
    Write-Host '  No PiDeck shortcuts found. Create one manually if you want one:'
    Write-Host '    right-click PiDeck.exe -> Send to -> Desktop (create shortcut)'
    exit 0
}

$fixed = 0; $alreadyOk = 0; $skipped = 0
foreach ($lnk in $shortcuts) {
    $status = Get-ShortcutStatus $lnk
    Write-Host "  $lnk"
    switch ($status.Status) {
        'ok' {
            Write-Host "      ok -> $($status.Target)"
            $alreadyOk++
        }
        'empty' {
            if ($exe) { Fix-Shortcut $lnk $exe -DryRun:$DryRun; $fixed++ }
            else       { Write-Host '      skip: target empty and no PiDeck.exe detected'; $skipped++ }
        }
        'stale' {
            if ($exe) { Fix-Shortcut $lnk $exe -DryRun:$DryRun; $fixed++ }
            else       { Write-Host "      skip: target missing ($($status.Target)) and no PiDeck.exe detected"; $skipped++ }
        }
    }
}

Write-Host ''
if ($DryRun) {
    Write-Host ('Summary (DRY-RUN): {0} would-be-fixed, {1} ok, {2} skipped (nothing was changed)' -f $fixed, $alreadyOk, $skipped)
} else {
    Write-Host ('Summary: {0} fixed, {1} ok, {2} skipped' -f $fixed, $alreadyOk, $skipped)
}

# Exit 1 only when we actually had broken shortcuts we could not repair.
# If all shortcuts were already ok, a missing auto-detected exe is not an error.
# In dry-run mode a broken shortcut is reported but not an error, since
# nothing was attempted. Only -Do with $skipped > 0 counts as failure.
if ($skipped -gt 0 -and -not $DryRun) {
    Write-Host ''
    Write-Host "Could not fix $skipped shortcut(s). PiDeck.exe not auto-detected. Re-run with:"
    Write-Host '  .\fix-windows-shortcuts.ps1 -Do -ExePath "C:\path\to\PiDeck.exe"'
    exit 1
}

# Only refresh the icon cache when we actually changed shortcuts.
# DryRun and NoRebuildIconCache both bypass this step.
if ($fixed -gt 0 -and -not $DryRun -and -not $NoRebuildIconCache) {
    Rebuild-IconCache
}

exit 0
