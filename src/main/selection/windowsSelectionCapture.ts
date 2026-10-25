/**
 * Windows 原生划词捕获（免快捷键/免复制）：
 * - 轮询鼠标左键 + 位移/双击手势（PowerShell 进程内做，避免给主进程挂低级钩子）；
 * - 手势成立后用 UI Automation 沿鼠标点父链找 TextPattern 选区，直接读文本；
 * - 不读写剪贴板，不模拟按键；进程按 systemSelectionEnabled 启停。
 *
 * 这是 Magpie Windows 后端（WH_MOUSE_LL + UIAutomationCore）的轻量落地方案：
 * 不需要额外 DLL（UIAutomationClient 是系统自带 .NET 程序集），代价是 PowerShell
 * 常驻进程与 40ms 轮询。UIA 读不到时由 ClipboardSelectionWatcher 兜底。
 */
import { spawn, type ChildProcess } from "node:child_process";

export type WindowsSelectionCaptureLogger = {
	info: (message: string, detail?: Record<string, unknown>) => void;
	warn: (message: string, detail?: Record<string, unknown>) => void;
};

export type WindowsSelectionCaptureDeps = {
	onSelection: (input: { text: string; x: number; y: number }) => void;
	logger?: WindowsSelectionCaptureLogger;
};

/** 交给 PowerShell 的脚本：只输出 NDJSON，调试信息一律走 stderr。 */
export const WINDOWS_SELECTION_SCRIPT = String.raw`
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class PideckNative {
    [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int vKey);
    [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hWnd, uint flags);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
}
"@
$ownerPid = 0
if ($env:PIDECK_SELECTION_OWNER_PID) { $ownerPid = [int]$env:PIDECK_SELECTION_OWNER_PID }
$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
function Read-SelectedTextAt([int]$x, [int]$y) {
    try {
        $point = [System.Windows.Point]::new([double]$x, [double]$y)
        $element = [System.Windows.Automation.AutomationElement]::FromPoint($point)
        $depth = 0
        while ($null -ne $element -and $depth -lt 24) {
            try {
                $pattern = $element.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                $parts = @()
                foreach ($range in $pattern.GetSelection()) {
                    $value = $range.GetText(-1)
                    if ($value) { $parts += $value }
                }
                $text = ($parts -join "").Trim()
                if ($text) { return $text }
            } catch { }
            try { $element = $walker.GetParent($element) } catch { break }
            $depth++
        }
    } catch { }
    try {
        $focused = [System.Windows.Automation.AutomationElement]::FocusedElement
        $depth = 0
        while ($null -ne $focused -and $depth -lt 24) {
            try {
                $pattern = $focused.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
                $parts = @()
                foreach ($range in $pattern.GetSelection()) {
                    $value = $range.GetText(-1)
                    if ($value) { $parts += $value }
                }
                $text = ($parts -join "").Trim()
                if ($text) { return $text }
            } catch { }
            try { $focused = $walker.GetParent($focused) } catch { break }
            $depth++
        }
    } catch { }
    return ""
}
[Console]::Out.WriteLine('{"type":"ready"}')
[Console]::Out.Flush()
$wasDown = $false
$startX = 0
$startY = 0
$endX = 0
$endY = 0
$lastClickAt = 0
$lastClickX = 0
$lastClickY = 0
while ($true) {
    $down = ([PideckNative]::GetAsyncKeyState(0x01) -band 0x8000) -ne 0
    $point = New-Object PideckNative+POINT
    [void][PideckNative]::GetCursorPos([ref]$point)
    if ($down -and -not $wasDown) {
        $wasDown = $true
        $startX = $point.X
        $startY = $point.Y
    } elseif (-not $down -and $wasDown) {
        $wasDown = $false
        $endX = $point.X
        $endY = $point.Y
        $now = [Environment]::TickCount
        $moved = ([Math]::Abs($endX - $startX) + [Math]::Abs($endY - $startY)) -gt 6
        $double = $lastClickAt -gt 0 -and (($now - $lastClickAt) -le 400) -and (([Math]::Abs($endX - $lastClickX) + [Math]::Abs($endY - $lastClickY)) -lt 12)
        if ($moved -or $double) {
            $hwnd = [PideckNative]::GetForegroundWindow()
            $foregroundPid = 0
            [void][PideckNative]::GetWindowThreadProcessId($hwnd, [ref]$foregroundPid)
            $hitPoint = New-Object PideckNative+POINT
            $hitPoint.X = $endX
            $hitPoint.Y = $endY
            $rootHwnd = [PideckNative]::GetAncestor([PideckNative]::WindowFromPoint($hitPoint), 2)
            $rootPid = 0
            [void][PideckNative]::GetWindowThreadProcessId($rootHwnd, [ref]$rootPid)
            if ($foregroundPid -ne $ownerPid -and $rootPid -ne $ownerPid) {
                Start-Sleep -Milliseconds 30
                $text = Read-SelectedTextAt $endX $endY
                if (-not $text) { $text = Read-SelectedTextAt $startX $startY }
                if ($text) {
                    if ($text.Length -gt 20000) { $text = $text.Substring(0, 20000) }
                    $payload = @{ text = $text; x = $endX; y = $endY } | ConvertTo-Json -Compress
                    [Console]::Out.WriteLine($payload)
                    [Console]::Out.Flush()
                }
            }
        }
        $lastClickAt = $now
        $lastClickX = $endX
        $lastClickY = $endY
    }
    Start-Sleep -Milliseconds 40
}
`;

export class WindowsSelectionCapture {
	private child: ChildProcess | null = null;
	private enabled = false;
	private disposed = false;
	private buffer = "";

	constructor(private readonly deps: WindowsSelectionCaptureDeps) {}

	setEnabled(enabled: boolean): void {
		if (this.disposed) return;
		if (enabled) this.start();
		else this.stop();
	}

	start(): void {
		if (this.disposed || this.enabled || process.platform !== "win32") return;
		this.enabled = true;
		this.buffer = "";
		try {
			const encoded = Buffer.from(WINDOWS_SELECTION_SCRIPT, "utf16le").toString("base64");
			const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
				windowsHide: true,
				stdio: ["ignore", "pipe", "pipe"],
				env: { ...process.env, PIDECK_SELECTION_OWNER_PID: String(process.pid) },
			});
			this.child = child;
			child.stdout?.setEncoding("utf8");
			child.stdout?.on("data", (chunk: string) => this.consume(chunk));
			child.stderr?.setEncoding("utf8");
			child.stderr?.on("data", (chunk: string) => {
				const text = String(chunk).trim();
				if (text) this.deps.logger?.warn("Windows selection helper stderr", { text: text.slice(0, 500) });
			});
			child.on("error", (error) => {
				if (this.child !== child) return;
				this.deps.logger?.warn("Windows selection helper failed to start", { error: String(error) });
				this.child = null;
				this.enabled = false;
			});
			child.on("exit", (code, signal) => {
				// stop() 后马上重启时，旧进程的 exit 不能把新 child 清掉。
				if (this.child !== child) return;
				if (!this.disposed && this.enabled) this.deps.logger?.warn("Windows selection helper exited", { code, signal });
				this.child = null;
				this.enabled = false;
			});
			this.deps.logger?.info("Windows selection helper started");
		} catch (error) {
			this.deps.logger?.warn("Windows selection helper spawn failed", { error: String(error) });
			this.enabled = false;
			this.child = null;
		}
	}

	stop(): void {
		this.enabled = false;
		const child = this.child;
		this.child = null;
		if (!child) return;
		try {
			child.kill();
		} catch {
			// 退出路径：PowerShell 已经不在时 ignore。
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.stop();
	}

	private consume(chunk: string): void {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		for (const line of lines) this.handleLine(line.trim());
	}

	private handleLine(line: string): void {
		if (!line) return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			return;
		}
		if (!isRecord(parsed)) return;
		if (parsed.type === "ready") {
			this.deps.logger?.info("Windows selection helper ready");
			return;
		}
		const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
		if (!text) return;
		const x = typeof parsed.x === "number" && Number.isFinite(parsed.x) ? parsed.x : 0;
		const y = typeof parsed.y === "number" && Number.isFinite(parsed.y) ? parsed.y : 0;
		this.deps.onSelection({ text, x, y });
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
