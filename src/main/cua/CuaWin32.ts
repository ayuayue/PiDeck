import { Buffer } from "node:buffer";

import { requireKoffi, type Koffi } from "./koffiRuntime";

/**
 * Low-level Win32 bindings for CUA (Computer Use Agent).
 *
 * This module only declares the exact functions and constants needed for
 * screen capture metadata, window enumeration, Z-order analysis, and
 * SendInput-based mouse/keyboard injection.
 *
 * koffi caveats observed during probe1-probe5:
 * - Use `void *` for HWND, `uint32_t` for DWORD, and explicitly declared
 *   structs for RECT/POINT.
 * - INPUT（SendInput）不能用 koffi struct 表达：koffi 不支持 union，顺序堆叠
 *   mi/ki/hi 字段会让 sizeof(INPUT) 变成 ~64 字节而非 Windows 要求的 40 字节，
 *   SendInput 直接 ERROR_INVALID_PARAMETER 返回 0——2026-10-04 实机确认注入
 *   全链路因此静默失效（scroll 恒 sent:0）。修复：INPUT 改为手工打包 Buffer
 *   （40 字节/条，x64/ARM64 布局一致），SendInput 以 `void*` 接收。
 * - `_Out_` annotations are required on pointer output parameters, otherwise
 *   koffi does not write results back into the JS object.
 * - Struct declarations must precede function declarations that reference them.
 * - `LibraryHandle` 的方法是**原生方法**，receiver 必须是句柄对象本身：把句柄
 *   包进 Proxy 直接转发方法会抛 `TypeError: Illegal invocation`（2026-09-30
 *   打包版启动即崩，见 `lazyDll`）。
 *
 * 平台范围（2026-09-29 与 cua 作者对齐）：CUA 能力现阶段仅支持 Windows，
 * macOS/Linux 后补。但本模块会被主进程入口链无条件 import，因此**顶层禁止
 * 任何 koffi 原生调用**（曾因顶层 `koffi.load("user32.dll")` 在 Linux/macOS
 * 启动即崩，表现为「双击无反应」，journal 报 Failed to load shared library），
 * **连静态 `import koffi` 也不行**——koffi 的 JS 包装在模块求值时就同步加载
 * 原生二进制，打包缺对应 arch 的 `@koromix/koffi-*` 可选依赖时（arm64 runner
 * 打的 x64 macOS 包即缺 darwin-x64，issue #313）import 本身抛
 * 「Cannot find the native Koffi module」，整个应用启动即崩。
 * 约定：
 * - win32：经 `./koffiRuntime` 在函数内 createRequire 加载，加载失败降级为
 *   `koffiStub` 并记录原因；首次访问 `user32`/`kernel32` 时才加载 DLL 并绑定；
 * - 其它平台：`koffiStub` 提供可赋值的占位（顶层 `const xxx = user32.func(...)`
 *   能完成初始化），真正调用任何 CUA 操作时抛带平台说明的错误；
 * - 未来补 mac/linux 时：替换 `koffiStub` 为对应平台实现，保持「模块加载零原生调用」
 *   的约定不变（参见 `allocHiddenConsole.ts` 的函数内延迟加载范式）。
 */

const isWindows = process.platform === "win32";

/** win32 上 koffi 加载失败时的原因；null 表示未尝试或加载成功（降级后的报错文案用）。 */
let koffiLoadError: string | null = null;

function unavailable(op: string): never {
	const reason = koffiLoadError ? `koffi native module failed to load (${koffiLoadError})` : "CUA Win32 bindings are only available on Windows";
	throw new Error(`CUA Win32 bindings unavailable: ${reason} (got ${op} on ${process.platform}).`);
}

/** 非 Windows 上的绑定占位：可赋值给顶层 const，真正调用时才抛。 */
function stubFunc(name: string): (...args: unknown[]) => never {
	return (...args: unknown[]) => unavailable(`${name}(${args.length} args)`);
}

/** 无可用 koffi 时的占位：load/struct/proto 只需「返回可赋值的占位」，不触达原生层。 */
const koffiStub = {
	load: (_name: string) => ({ func: (signature: string) => stubFunc(signature) }),
	struct: (name: string) => ({ __koffiStruct: name }),
	proto: (name: string) => ({ __koffiProto: name }),
	sizeof: () => 0,
	address: () => 0,
} as unknown as Koffi;

/**
 * koffi 运行时解析：只在 win32 上加载（其它平台 CUA 暂无实现，连 require 都不
 * 发起，macOS/Linux 的打包有没有 koffi 二进制都不再影响启动）；win32 上加载
 * 失败也降级为占位——CUA 是实验能力，原生模块缺失不许拖垮整个应用启动。
 */
const koffiLazy: Koffi = (() => {
	if (!isWindows) return koffiStub;
	try {
		return requireKoffi();
	} catch (err) {
		koffiLoadError = err instanceof Error ? err.message : String(err);
		return koffiStub;
	}
})();

/** 取 koffi 指针/句柄地址（CuaEngine 的 HWND 归一化用）；占位平台上同其它绑定，调用时才抛。 */
export function koffiAddress(value: unknown): bigint {
	return koffiLazy.address(value);
}

let cachedUser32: ReturnType<Koffi["load"]> | null = null;
let cachedKernel32: ReturnType<Koffi["load"]> | null = null;

/** 惰性 DLL 句柄：win32 首次访问时加载；其它平台由 koffiStub 提供占位。 */
function dll(name: "user32" | "kernel32"): ReturnType<Koffi["load"]> {
	if (name === "user32") {
		cachedUser32 ??= koffiLazy.load("user32.dll");
		return cachedUser32;
	}
	cachedKernel32 ??= koffiLazy.load("kernel32.dll");
	return cachedKernel32;
}

/**
 * 惰性库句柄代理：win32 首次取属性时才加载 DLL，其它平台由 `koffiStub` 提供占位。
 *
 * 取到的方法必须 bind 回真实句柄再返回——`LibraryHandle` 的方法是原生方法，
 * receiver 必须是句柄对象本身；Proxy 会把 `this` 顶替成代理对象，koffi 随即抛
 * `TypeError: Illegal invocation`。顶层 `user32.func(...)` 全走代理，漏掉这步
 * 就是「模块一加载就崩」（2026-09-30 打包版启动失败：崩溃点看着在入口
 * `require("koffi")`，实际是本模块第一条绑定语句）。
 */
function lazyDll(name: "user32" | "kernel32"): ReturnType<Koffi["load"]> {
	return new Proxy({} as ReturnType<Koffi["load"]>, {
		get: (_target, prop) => {
			const lib = dll(name);
			const value = Reflect.get(lib, prop);
			return typeof value === "function" ? value.bind(lib) : value;
		},
	});
}

export const user32: ReturnType<Koffi["load"]> = lazyDll("user32");
export const kernel32: ReturnType<Koffi["load"]> = lazyDll("kernel32");

// ---------------------------------------------------------------------------
// Structs
// ---------------------------------------------------------------------------

export const POINT = koffiLazy.struct("POINT", {
	x: "long",
	y: "long",
});

export const RECT = koffiLazy.struct("RECT", {
	left: "long",
	top: "long",
	right: "long",
	bottom: "long",
});

/**
 * INPUT struct layout used by SendInput (x64/ARM64: 40 bytes).
 *
 * Windows INPUT = { DWORD type; union { MOUSEINPUT mi; KEYBDINPUT ki; } }。
 * koffi 不支持 union，堆叠声明会让 cbSize 不等于 40 而被 SendInput 全部拒绝
 * （静默返回 0）。因此 INPUT 不走 koffi struct：buildMouseInput /
 * buildKeyboardInput 仍返回命名字段记录（便于单测断言），sendInputs 在边界处
 * 手工打包成 40 字节记录再交给 `void*` 的 SendInput。
 *
 * 布局（偏移相对记录起点）：
 *   type        @0  (4)   INPUT_MOUSE=0 / INPUT_KEYBOARD=1
 *   pad         @4  (4)   对齐 union 到 8 字节
 *   mi.dx       @8  (4)   ki.wVk     @8  (2)
 *   mi.dy       @12 (4)   ki.wScan   @10 (2)
 *   mi.mouseData@16 (4)   ki.dwFlags @12 (4)
 *   mi.dwFlags  @20 (4)   ki.time    @16 (4)
 *   mi.time     @24 (4)   pad        @20 (4)
 *   pad         @28 (4)   ki.dwExtraInfo@24 (8，恒 0)
 *   mi.dwExtraInfo@32 (8，恒 0)
 */
export const INPUT_SIZE = 40;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const INPUT_MOUSE = 0;
export const INPUT_KEYBOARD = 1;

export const MOUSEEVENTF_MOVE = 0x0001;
export const MOUSEEVENTF_LEFTDOWN = 0x0002;
export const MOUSEEVENTF_LEFTUP = 0x0004;
export const MOUSEEVENTF_RIGHTDOWN = 0x0008;
export const MOUSEEVENTF_RIGHTUP = 0x0010;
export const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
export const MOUSEEVENTF_MIDDLEUP = 0x0040;
export const MOUSEEVENTF_ABSOLUTE = 0x8000;
export const MOUSEEVENTF_VIRTUALDESK = 0x4000;

export const KEYEVENTF_EXTENDEDKEY = 0x0001;
export const KEYEVENTF_KEYUP = 0x0002;
export const KEYEVENTF_SCANCODE = 0x0008;
export const KEYEVENTF_UNICODE = 0x0004;

export const SW_SHOWNORMAL = 1;
export const SW_SHOWMINIMIZED = 2;
export const SW_SHOWMAXIMIZED = 3;
export const SW_RESTORE = 9;

export const HWND_TOPMOST = -1;
export const HWND_NOTOPMOST = -2;

export const SWP_FRAMECHANGED = 0x0020;
export const SWP_NOMOVE = 0x0002;
export const SWP_NOSIZE = 0x0001;
export const SWP_NOACTIVATE = 0x0010;
export const SWP_SHOWWINDOW = 0x0040;

// ---------------------------------------------------------------------------
// Function bindings
// ---------------------------------------------------------------------------

export const GetSystemMetrics = user32.func("int GetSystemMetrics(int nIndex)");
export const GetCursorPos = user32.func("bool GetCursorPos(_Out_ POINT *p)");
export const SetCursorPos = user32.func("bool SetCursorPos(int x, int y)");

export const SendInput = user32.func("uint32_t SendInput(uint32_t cInputs, void *pInputs, int32_t cbSize)");

export const GetForegroundWindow = user32.func("void *GetForegroundWindow()");
export const SetForegroundWindow = user32.func("bool SetForegroundWindow(void *hWnd)");
export const ShowWindow = user32.func("bool ShowWindow(void *hWnd, int nCmdShow)");
export const ShowWindowAsync = user32.func("bool ShowWindowAsync(void *hWnd, int nCmdShow)");
export const SetWindowPos = user32.func("bool SetWindowPos(void *hWnd, void *hWndInsertAfter, int x, int y, int cx, int cy, uint32_t uFlags)");
export const IsWindow = user32.func("bool IsWindow(void *hWnd)");
export const IsWindowVisible = user32.func("bool IsWindowVisible(void *hWnd)");
export const GetWindowRect = user32.func("bool GetWindowRect(void *hWnd, _Out_ RECT *p)");
export const GetWindowTextLengthW = user32.func("int GetWindowTextLengthW(void *hWnd)");
export const GetWindowTextW = user32.func("int GetWindowTextW(void *hWnd, _Out_ wchar_t *lpString, int nMaxCount)");
export const GetWindowThreadProcessId = user32.func("uint32_t GetWindowThreadProcessId(void *hWnd, _Out_ uint32_t *p)");

export const GetCurrentThreadId = kernel32.func("uint32_t GetCurrentThreadId()");

// EnumWindows callback prototype: return false to stop enumeration.
const EnumWindowsProc = koffiLazy.proto("bool EnumWindowsProc(void *hWnd, intptr_t lParam)");
export const EnumWindows = user32.func("bool EnumWindows(EnumWindowsProc *lpEnumFunc, intptr_t lParam)");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type WindowInfo = {
	hwnd: number;
	title: string;
	pid: number;
	rect: { x: number; y: number; width: number; height: number };
	isVisible: boolean;
	isForeground: boolean;
	isTopmost: boolean;
	zIndex: number;
};

/**
 * Enumerate top-level windows in Z-order (front to back).
 * By default only visible windows are returned; pass includeInvisible=true to
 * also list hidden ones (the isVisible field then tells them apart).
 */
export function enumerateWindows(includeInvisible = false): WindowInfo[] {
	const windows: WindowInfo[] = [];
	const fg = GetForegroundWindow();

	EnumWindows((hwndPtr: unknown, _lParam: number) => {
		if (!hwndPtr) return true;
		const hwnd = Number(koffiLazy.address(hwndPtr));

		// koffi 返回 int32（Win32 BOOL），必须归一化成真正的 boolean——
		// isVisible 字段要出 MCP JSON 契约，`1 === true` 为假曾让
		// includeInvisible=false 的默认列表也带着 isVisible:1 的窗口。
		const visible = IsWindowVisible(hwndPtr) !== 0;
		if (!includeInvisible && !visible) return true;

		const rect: { left: number; top: number; right: number; bottom: number } = { left: 0, top: 0, right: 0, bottom: 0 };
		if (!GetWindowRect(hwndPtr, rect)) return true;

		const width = rect.right - rect.left;
		const height = rect.bottom - rect.top;
		if (width <= 0 || height <= 0) return true;

		const pidBuf = [0] as [number];
		GetWindowThreadProcessId(hwndPtr, pidBuf);
		const pid = pidBuf[0];

		const titleLength = GetWindowTextLengthW(hwndPtr);
		let title = "";
		if (titleLength > 0) {
			// wchar_t buffer; each char is 2 bytes.
			const buffer = Buffer.alloc((titleLength + 1) * 2);
			GetWindowTextW(hwndPtr, buffer, titleLength + 1);
			title = buffer.toString("utf16le").replace(/\0/g, "");
		}

		const exStyle = GetWindowLongPtrW(hwndPtr, GWL_EXSTYLE);
		const isTopmost = (exStyle & WS_EX_TOPMOST) !== 0;

		windows.push({
			hwnd,
			title,
			pid,
			rect: { x: rect.left, y: rect.top, width, height },
			isVisible: visible,
			isForeground: hwnd === Number(koffiLazy.address(fg)),
			isTopmost,
			zIndex: windows.length,
		});

		return true;
	}, 0n);

	return windows;
}

const GWL_EXSTYLE = -20;
const WS_EX_TOPMOST = 0x00000008;

// GetWindowLongPtrW binding for 64-bit (returns LONG_PTR).
export const GetWindowLongPtrW = user32.func("intptr_t GetWindowLongPtrW(void *hWnd, int nIndex)");

/**
 * Convert a screen pixel coordinate to the normalized 0..65535 range required
 * by SendInput with MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK.
 */
export function normalizeAbsoluteCoordinate(x: number, y: number, screenWidth: number, screenHeight: number, originX = 0, originY = 0): { x: number; y: number } {
	if (screenWidth <= 0 || screenHeight <= 0) {
		throw new Error("Invalid screen dimensions");
	}
	// Windows maps 0..65535 across the whole virtual desktop (origin included),
	// not just the primary monitor — see MOUSEEVENTF_VIRTUALDESK.
	const nx = Math.round(((x - originX) * 65535) / (screenWidth - 1));
	const ny = Math.round(((y - originY) * 65535) / (screenHeight - 1));
	return { x: clamp(nx, 0, 65535), y: clamp(ny, 0, 65535) };
}

function clamp(value: number, min: number, max: number): number {
	return Math.max(min, Math.min(max, value));
}

/**
 * Build a mouse INPUT struct for SendInput absolute coordinate injection.
 */
export function buildMouseInput(x: number, y: number, flags: number): Record<string, number> {
	return {
		type: INPUT_MOUSE,
		mi_dx: x,
		mi_dy: y,
		mi_mouseData: 0,
		mi_dwFlags: flags,
		mi_time: 0,
		mi_dwExtraInfo: 0,
		ki_wVk: 0,
		ki_wScan: 0,
		ki_dwFlags: 0,
		ki_time: 0,
		ki_dwExtraInfo: 0,
		hi_uMsg: 0,
		hi_wParamL: 0,
		hi_wParamH: 0,
	};
}

/**
 * Build a keyboard INPUT struct for SendInput.
 */
export function buildKeyboardInput(vk: number, scan: number, flags: number): Record<string, number> {
	return {
		type: INPUT_KEYBOARD,
		mi_dx: 0,
		mi_dy: 0,
		mi_mouseData: 0,
		mi_dwFlags: 0,
		mi_time: 0,
		mi_dwExtraInfo: 0,
		ki_wVk: vk,
		ki_wScan: scan,
		ki_dwFlags: flags,
		ki_time: 0,
		ki_dwExtraInfo: 0,
		hi_uMsg: 0,
		hi_wParamL: 0,
		hi_wParamH: 0,
	};
}

/**
 * 把命名字段记录打包成 SendInput 要求的 40 字节 INPUT 记录串。
 * 负数滚轮 delta 以 DWORD 写入（Windows 按有符号解释）。
 */
function packInputs(inputs: Record<string, number>[]): Buffer {
	const buffer = Buffer.alloc(inputs.length * INPUT_SIZE);
	inputs.forEach((input, index) => {
		const off = index * INPUT_SIZE;
		buffer.writeUInt32LE(input.type >>> 0, off);
		if (input.type === INPUT_MOUSE) {
			buffer.writeInt32LE(input.mi_dx | 0, off + 8);
			buffer.writeInt32LE(input.mi_dy | 0, off + 12);
			buffer.writeUInt32LE((input.mi_mouseData ?? 0) >>> 0, off + 16);
			buffer.writeUInt32LE((input.mi_dwFlags ?? 0) >>> 0, off + 20);
			// time @24、dwExtraInfo @32 恒 0
		} else if (input.type === INPUT_KEYBOARD) {
			buffer.writeUInt16LE((input.ki_wVk ?? 0) & 0xffff, off + 8);
			buffer.writeUInt16LE((input.ki_wScan ?? 0) & 0xffff, off + 10);
			buffer.writeUInt32LE((input.ki_dwFlags ?? 0) >>> 0, off + 12);
			// time @16、dwExtraInfo @24 恒 0
		}
	});
	return buffer;
}

/**
 * Send a sequence of INPUT records via SendInput.
 * 静默部分注入（此前永远返回 0）会伪装成成功——不足额即抛出，让失败显式化。
 */
export function sendInputs(inputs: Record<string, number>[]): number {
	if (inputs.length === 0) return 0;
	const sent = SendInput(inputs.length, packInputs(inputs), INPUT_SIZE);
	if (sent !== inputs.length) {
		throw new Error(`SendInput injected ${sent}/${inputs.length} events`);
	}
	return sent;
}

/**
 * Convenience: move the cursor to an absolute screen pixel coordinate.
 */
export function moveMouseAbsolute(x: number, y: number, screenWidth: number, screenHeight: number, originX = 0, originY = 0): number {
	const norm = normalizeAbsoluteCoordinate(x, y, screenWidth, screenHeight, originX, originY);
	return sendInputs([buildMouseInput(norm.x, norm.y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)]);
}

/**
 * Convenience: click at an absolute screen pixel coordinate.
 */
export function clickAt(x: number, y: number, button: "left" | "right" | "middle", screenWidth: number, screenHeight: number, originX = 0, originY = 0): number {
	const norm = normalizeAbsoluteCoordinate(x, y, screenWidth, screenHeight, originX, originY);
	const flagsDown = button === "left" ? MOUSEEVENTF_LEFTDOWN : button === "right" ? MOUSEEVENTF_RIGHTDOWN : MOUSEEVENTF_MIDDLEDOWN;
	const flagsUp = button === "left" ? MOUSEEVENTF_LEFTUP : button === "right" ? MOUSEEVENTF_RIGHTUP : MOUSEEVENTF_MIDDLEUP;
	return sendInputs([buildMouseInput(norm.x, norm.y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK), buildMouseInput(0, 0, flagsDown), buildMouseInput(0, 0, flagsUp)]);
}

// ---------------------------------------------------------------------------
// Keyboard helpers
// ---------------------------------------------------------------------------

/** Common virtual-key codes. */
export const VK_MAP: Record<string, number> = {
	enter: 0x0d,
	tab: 0x09,
	escape: 0x1b,
	backspace: 0x08,
	delete: 0x2e,
	space: 0x20,
	left: 0x25,
	up: 0x26,
	right: 0x27,
	down: 0x28,
	home: 0x24,
	end: 0x23,
	pageup: 0x21,
	pagedown: 0x22,
	shift: 0x10,
	ctrl: 0x11,
	alt: 0x12,
	win: 0x5b,
};

/** Modifier virtual-key codes in order. */
const MODIFIER_KEYS = [0x11, 0x12, 0x10, 0x5b]; // ctrl, alt, shift, win

/**
 * Press a key combination (e.g. Ctrl+C).
 * @param vk Virtual-key code of the main key.
 * @param modifiers Array of modifier vk codes.
 */
export function pressKeyCombo(vk: number, modifiers: number[] = []): number {
	const inputs: Record<string, number>[] = [];
	// Press modifiers down.
	for (const mod of modifiers) {
		inputs.push(buildKeyboardInput(mod, 0, 0));
	}
	// Press main key down + up.
	inputs.push(buildKeyboardInput(vk, 0, 0));
	inputs.push(buildKeyboardInput(vk, 0, KEYEVENTF_KEYUP));
	// Release modifiers in reverse order.
	for (let i = modifiers.length - 1; i >= 0; i--) {
		inputs.push(buildKeyboardInput(modifiers[i], 0, KEYEVENTF_KEYUP));
	}
	return sendInputs(inputs);
}

/**
 * Build the SendInput sequence for a Unicode string.
 *
 * KEYEVENTF_UNICODE accepts one UTF-16 code unit per INPUT — astral-plane
 * characters (emoji, CJK ext-B, code points > U+FFFF) must be split into a
 * high/low surrogate pair. Passing the raw code point truncates `wScan` to
 * 16 bits and injects the wrong character (koffi/Win32 narrow silently).
 */
export function buildUnicodeInputs(text: string): Record<string, number>[] {
	const inputs: Record<string, number>[] = [];
	for (const char of text) {
		const code = char.codePointAt(0);
		if (code === undefined) continue;
		if (code > 0xffff) {
			const shifted = code - 0x10000;
			const high = 0xd800 + (shifted >> 10);
			const low = 0xdc00 + (shifted & 0x3ff);
			inputs.push(buildKeyboardInput(0, high, KEYEVENTF_UNICODE));
			inputs.push(buildKeyboardInput(0, high, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
			inputs.push(buildKeyboardInput(0, low, KEYEVENTF_UNICODE));
			inputs.push(buildKeyboardInput(0, low, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
		} else {
			// down
			inputs.push(buildKeyboardInput(0, code, KEYEVENTF_UNICODE));
			// up
			inputs.push(buildKeyboardInput(0, code, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP));
		}
	}
	return inputs;
}

/**
 * Type a Unicode string character by character using SendInput.
 * Uses KEYEVENTF_UNICODE for full Unicode support.
 */
export function typeUnicode(text: string): number {
	return sendInputs(buildUnicodeInputs(text));
}

// ---------------------------------------------------------------------------
// Scroll helper
// ---------------------------------------------------------------------------

export const MOUSEEVENTF_WHEEL = 0x0800;
export const MOUSEEVENTF_HWHEEL = 0x1000;

/**
 * Scroll the mouse wheel at an absolute screen coordinate.
 * @param deltaY Positive = scroll down, negative = scroll up (Windows convention).
 */
export function scrollAt(x: number, y: number, deltaY: number, deltaX: number, screenWidth: number, screenHeight: number, originX = 0, originY = 0): number {
	const norm = normalizeAbsoluteCoordinate(x, y, screenWidth, screenHeight, originX, originY);
	const inputs: Record<string, number>[] = [buildMouseInput(norm.x, norm.y, MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK)];
	if (deltaY !== 0) {
		const wheelInput = buildMouseInput(0, 0, MOUSEEVENTF_WHEEL);
		wheelInput.mi_mouseData = deltaY;
		inputs.push(wheelInput);
	}
	if (deltaX !== 0) {
		const hwheelInput = buildMouseInput(0, 0, MOUSEEVENTF_HWHEEL);
		hwheelInput.mi_mouseData = deltaX;
		inputs.push(hwheelInput);
	}
	return sendInputs(inputs);
}
