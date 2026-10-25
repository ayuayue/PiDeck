import { createRequire } from "node:module";

/**
 * 给当前进程分配「用户看不见」的控制台（win32）。
 *
 * sidecar 路径靠 CREATE_NO_WINDOW 继承，不会走到这里。
 * 无 sidecar 的 electron.exe runner 没有可继承控制台，CreateProcessAsUserW
 * 拉 pwsh 前必须自建一份；直接 AllocConsole 会异步弹出 conhost（闪窗）。
 * 正确做法：先切到私有 Window Station / Desktop，再 AllocConsole——窗口
 * 建在非交互桌面上，永远不会显示（服务进程标准做法）。
 *
 * 建站失败才退回 AllocConsole + SW_HIDE（仍可能闪，只覆盖老环境）。
 */

/** 测试注入的 koffi 子集。 */
export interface HiddenConsoleFfi {
	load(name: string): {
		func(signature: string): (...args: unknown[]) => unknown;
	};
}

const ERROR_ACCESS_DENIED = 5;
const WINSTA_ALL_ACCESS = 0x037f;
const GENERIC_ALL = 0x10000000;
const HIDDEN_STATION = "pideck-hidden";
const HIDDEN_DESKTOP = "default";

function hideVisibleConsole(getConsoleWindow: () => unknown, showWindow: (hWnd: unknown, nCmdShow: number) => unknown): void {
	const hide = () => {
		const hwnd = getConsoleWindow();
		if (hwnd) showWindow(hwnd, 0);
	};
	const spinUntil = Date.now() + 80;
	while (Date.now() < spinUntil) {
		const hwnd = getConsoleWindow();
		if (hwnd) {
			showWindow(hwnd, 0);
			break;
		}
	}
	hide();
	const hideTimer = setInterval(hide, 16);
	setTimeout(() => clearInterval(hideTimer), 2000);
	hideTimer.unref?.();
}

/** 把当前进程切到非交互窗口站。失败返回 false，调用方退回 SW_HIDE。 */
function attachPrivateWindowStation(user32: { func(signature: string): (...args: unknown[]) => unknown }): boolean {
	const createWindowStation = user32.func("void* CreateWindowStationW(str16 lpwinsta, uint32 dwFlags, uint32 dwDesiredAccess, void* lpsa)") as (name: string, flags: number, access: number, sa: number) => unknown;
	const openWindowStation = user32.func("void* OpenWindowStationW(str16 lpszWinSta, int fInherit, uint32 dwDesiredAccess)") as (name: string, inherit: number, access: number) => unknown;
	const setProcessWindowStation = user32.func("int SetProcessWindowStation(void* hWinSta)") as (hWinSta: unknown) => number;
	const createDesktop = user32.func("void* CreateDesktopW(str16 lpszDesktop, void* lpszDevice, void* pDevmode, uint32 dwFlags, uint32 dwDesiredAccess, void* lpsa)") as (name: string, device: number, devmode: number, flags: number, access: number, sa: number) => unknown;
	const setThreadDesktop = user32.func("int SetThreadDesktop(void* hDesktop)") as (hDesktop: unknown) => number;

	let station = createWindowStation(HIDDEN_STATION, 0, WINSTA_ALL_ACCESS, 0);
	if (!station) station = openWindowStation(HIDDEN_STATION, 0, WINSTA_ALL_ACCESS);
	if (!station) return false;
	if (!setProcessWindowStation(station)) return false;
	const desktop = createDesktop(HIDDEN_DESKTOP, 0, 0, 0, GENERIC_ALL, 0);
	if (!desktop) return false;
	return Boolean(setThreadDesktop(desktop));
}

/**
 * 确保当前进程持有控制台，且尽量不弹出可见窗口。
 * @returns 是否已持有可用控制台（继承或新分配）。
 */
export function allocHiddenConsole(platform: NodeJS.Platform = process.platform, ffi?: HiddenConsoleFfi): boolean {
	if (platform !== "win32") return false;
	try {
		const koffi = ffi ?? (createRequire(__filename)("koffi") as HiddenConsoleFfi);
		const kernel32 = koffi.load("kernel32.dll");
		const user32 = koffi.load("user32.dll");
		const getConsoleWindow = kernel32.func("void* GetConsoleWindow(void)") as () => unknown;
		const getConsoleCP = kernel32.func("uint32 GetConsoleCP(void)") as () => number;
		const allocConsole = kernel32.func("int AllocConsole(void)") as () => number;
		const getLastError = kernel32.func("uint32 GetLastError(void)") as () => number;
		const showWindow = user32.func("int ShowWindow(void* hWnd, int nCmdShow)") as (hWnd: unknown, nCmdShow: number) => number;

		// 已有控制台（含 CREATE_NO_WINDOW 无窗口控制台）：不要再 AllocConsole。
		if (getConsoleCP() !== 0) {
			const hwnd = getConsoleWindow();
			if (hwnd) showWindow(hwnd, 0);
			return true;
		}
		if (getConsoleWindow()) {
			showWindow(getConsoleWindow(), 0);
			return true;
		}

		let isolated = false;
		try {
			isolated = attachPrivateWindowStation(user32);
		} catch {
			isolated = false;
		}

		if (allocConsole() === 0) {
			return getLastError() === ERROR_ACCESS_DENIED;
		}
		if (!isolated) {
			hideVisibleConsole(getConsoleWindow, showWindow);
		}
		return true;
	} catch {
		return false;
	}
}
