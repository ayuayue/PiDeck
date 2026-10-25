/**
 * 系统级划词取词：模拟一次「复制」，再从剪贴板读回目标应用的选中文本。
 *
 * 为什么模拟复制：Electron/Chromium 没有跨应用的选区读取 API（无障碍 API 需要额外
 * 原生模块与系统授权），而「发 Ctrl/Cmd+C 再读剪贴板」在 Windows / macOS / Linux X11
 * 上对绝大多数应用都成立，是划词翻译类工具的通行做法。
 *
 * 流程与边界（任何一步失败都必须返回结构化 reason，绝不 throw 到 IPC）：
 * 1. 只支持 win32 / darwin / linux(X11)。Linux Wayland 的合成按键送不进原生 Wayland
 *    窗口（xdotool 也没有 Wayland 后端），直接判 unsupported，UI 给安装/切换提示；
 *    Linux 未安装 xdotool 时 execFile 报 ENOENT，同样按 unsupported 结算。
 * 2. 先写唯一哨兵文本再发复制键，轮询剪贴板直到「不是哨兵且非空」——只有这样才能
 *    区分「复制成功」与「目标应用没有选区、剪贴板根本没变」。
 * 3. finally 恢复原剪贴板文本。限制：Electron 只能快照纯文本槽，原剪贴板里的图片/
 *    文件/富文本会被这次模拟复制覆盖（与同类工具同一取舍，无法用现有 API 规避）。
 *
 * 测试注入：clipboard / execFile / 键盘注入 / wait / 平台都在 options 里，
 * tests/systemSelectionReader.test.mjs 用替身跑全部分支（不碰真实剪贴板与外部命令）。
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { clipboard } from "electron";
import { SELECTION_TOOL_TEXT_MAX_CHARS } from "../../shared/types/selectionTool";

export type SystemSelectionFailureReason = "unsupported" | "capture-failed";

/** 取词结果：ok=false 时 reason 直接进 SelectionToolShowPayload（浮窗按它显示提示）。 */
export type SystemSelectionReadResult = { ok: true; text: string } | { ok: false; reason: SystemSelectionFailureReason };

/** 剪贴板最小接口：只用到读写纯文本，测试替身不必伪造整个 Electron.Clipboard。 */
export type SystemSelectionClipboard = {
	readText: () => string;
	writeText: (text: string) => void;
};

export type SystemSelectionExecFile = (file: string, args: readonly string[], options: { timeout: number; windowsHide: boolean }, callback: (error: unknown, stdout: string, stderr: string) => void) => void;

/** win32 键盘注入的最小签名（= src/main/cua/CuaWin32.ts 的 pressKeyCombo）。 */
export type SystemSelectionCopyKeyInjection = (vk: number, modifiers: readonly number[]) => unknown;

export type SystemSelectionReaderOptions = {
	platform?: string;
	/** XDG_SESSION_TYPE（仅 linux 用）：wayland 判不支持。 */
	sessionType?: string;
	clipboard?: SystemSelectionClipboard;
	execFile?: SystemSelectionExecFile;
	injectCopyKey?: SystemSelectionCopyKeyInjection;
	wait?: (ms: number) => Promise<void>;
	pollIntervalMs?: number;
	pollTimeoutMs?: number;
	/** 注入复制键前的等待（默认 SELECTION_COPY_INJECT_DELAY_MS；测试传 0）。 */
	injectDelayMs?: number;
	sentinelId?: string;
};

/** 轮询节奏：50ms × 12 次 ≈ 600ms，覆盖「慢应用复制」又不让快捷键响应显得卡顿。 */
export const SELECTION_POLL_INTERVAL_MS = 50;
export const SELECTION_POLL_TIMEOUT_MS = 600;
/** 外部命令超时：osascript/xdotool 卡住时必须收回控制权，否则快捷键会一直处于捕获中。 */
export const SELECTION_COPY_COMMAND_TIMEOUT_MS = 1500;

/**
 * 注入复制键前的等待：快捷键是 Ctrl/Cmd+Shift+X 这类带修饰键的组合，按下瞬间用户
 * 往往还按着 Ctrl+Shift——此时立刻注入 Ctrl+C 会被目标应用读成 Ctrl+Shift+C
 * （Chrome 的「检查元素」等），复制根本没发生。等一个节拍让物理修饰键松开。
 */
export const SELECTION_COPY_INJECT_DELAY_MS = 80;

export const MACOS_COPY_COMMAND: { command: string; args: readonly string[] } = {
	command: "osascript",
	args: ["-e", 'tell application "System Events" to keystroke "c" using command down'],
};

export const X11_COPY_COMMAND: { command: string; args: readonly string[] } = {
	command: "xdotool",
	args: ["key", "--clearmodifiers", "ctrl+c"],
};

export type SystemSelectionPlan = { supported: true; strategy: "win32-keys" } | { supported: true; strategy: "command"; command: string; args: readonly string[] } | { supported: false; reason: "unsupported" };

/**
 * 平台 → 取词方案（纯函数，可单测）。
 *
 * Linux 只认 X11：Wayland 下任何合成按键都无法可靠送达原生 Wayland 应用，
 * 与其让用户按了快捷键毫无反应，不如提前给出明确提示。
 */
export function resolveSystemSelectionPlan(input: { platform: string; sessionType?: string }): SystemSelectionPlan {
	if (input.platform === "win32") return { supported: true, strategy: "win32-keys" };
	if (input.platform === "darwin") return { supported: true, strategy: "command", ...MACOS_COPY_COMMAND };
	if (input.platform === "linux") {
		const sessionType = (input.sessionType ?? "").trim().toLowerCase();
		if (sessionType === "wayland") return { supported: false, reason: "unsupported" };
		return { supported: true, strategy: "command", ...X11_COPY_COMMAND };
	}
	return { supported: false, reason: "unsupported" };
}

const SENTINEL_PREFIX = "pideck-selection-probe:";

/** 唯一哨兵文本：带随机 id，保证不会与用户恰好复制到的内容相同。 */
export function createSelectionSentinel(id: string = randomUUID()): string {
	return `${SENTINEL_PREFIX}${id}`;
}

/**
 * 剪贴板文本 → 可用的选区文本（纯函数）。
 * 返回 null 表示「这次读到的还不是选区」：仍是哨兵（复制没发生）或只有空白。
 */
export function normalizeClipboardSelection(text: string, sentinel: string): string | null {
	if (!text || text === sentinel) return null;
	// NUL 会被部分应用写进剪贴板，原样传给侧车会污染指令；按上限截断避免整篇文档塞进一次性调用。
	const cleaned = text.replace(/\u0000/g, "").trim();
	if (!cleaned) return null;
	return cleaned.length > SELECTION_TOOL_TEXT_MAX_CHARS ? cleaned.slice(0, SELECTION_TOOL_TEXT_MAX_CHARS) : cleaned;
}

/** 外部命令错误码（node 的 ErrnoException.code；用 Reflect 读取，不信任 error 的结构）。 */
function readErrorCode(error: unknown): string | null {
	if (typeof error !== "object" || error === null) return null;
	const code = Reflect.get(error, "code");
	return typeof code === "string" ? code : null;
}

/**
 * 复制键注入失败分类（纯函数）：
 * - ENOENT = 依赖命令不存在（Linux 未装 xdotool）→ unsupported，UI 给安装提示；
 * - 其余（EACCES / 辅助功能未授权 / 超时 / koffi 原生模块缺失）→ capture-failed 可重试。
 */
export function classifySystemSelectionTriggerError(error: unknown): SystemSelectionFailureReason {
	return readErrorCode(error) === "ENOENT" ? "unsupported" : "capture-failed";
}

/** win32 虚拟键码：VK_CONTROL + 'C'（CuaWin32.VK_MAP 只有修饰键与命名键，字母键在这里补）。 */
const WIN32_CONTROL_VK = 0x11;
const WIN32_C_VK = 0x43;

const defaultExecFile: SystemSelectionExecFile = (file, args, options, callback) => {
	execFile(file, [...args], options, (error, stdout, stderr) => callback(error, stdout, stderr));
};

/** 读剪贴板纯文本；被其它进程占用时 readText 会抛（Windows 剪贴板锁），按空串继续轮询。 */
function readClipboardText(source: SystemSelectionClipboard): string {
	try {
		return source.readText() ?? "";
	} catch {
		return "";
	}
}

/** 恢复原剪贴板文本：恢复失败不影响已捕获的结果，只留空的文本槽（不抛错）。 */
function restoreClipboardText(source: SystemSelectionClipboard, originalText: string): void {
	try {
		source.writeText(originalText);
	} catch {
		// 剪贴板被占用时无法恢复；此时最坏结果是用户剪贴板为空，不阻断取词链路。
	}
}

function runCopyCommand(exec: SystemSelectionExecFile, command: string, args: readonly string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		try {
			exec(command, args, { timeout: SELECTION_COPY_COMMAND_TIMEOUT_MS, windowsHide: true }, (error) => {
				if (error) reject(error);
				else resolve();
			});
		} catch (error) {
			// execFile 自身同步抛（非法参数/环境异常）也要进同一条分类链路。
			reject(error);
		}
	});
}

/**
 * 发送复制键。win32 走 CUA 的 SendInput 键盘注入：模块内**惰性** import，
 * CuaWin32 顶层禁止任何 koffi 原生调用（见该文件注释），打包缺原生二进制时这里会抛，
 * 由调用方按 capture-failed 结算，不影响主进程启动。
 */
async function injectCopyKeys(options: SystemSelectionReaderOptions): Promise<void> {
	const inject = options.injectCopyKey;
	if (inject) {
		inject(WIN32_C_VK, [WIN32_CONTROL_VK]);
		return;
	}
	const cua = await import("../cua/CuaWin32");
	cua.pressKeyCombo(WIN32_C_VK, [WIN32_CONTROL_VK]);
}

async function triggerCopy(plan: Extract<SystemSelectionPlan, { supported: true }>, options: SystemSelectionReaderOptions): Promise<void> {
	if (plan.strategy === "command") {
		await runCopyCommand(options.execFile ?? defaultExecFile, plan.command, plan.args);
		return;
	}
	await injectCopyKeys(options);
}

/**
 * 轮询直到剪贴板出现选区文本；超时返回 null（= 目标应用没有选区/复制没生效）。
 * 用 node:timers/promises 而不是全局 setTimeout：生产模块在单测 vm 沙箱里被加载时
 * 不能依赖宿主全局计时器（AGENTS.md 测试标准第 4 条）。
 */
async function waitForClipboardSelection(input: { clipboard: SystemSelectionClipboard; sentinel: string; wait: (ms: number) => Promise<void>; pollIntervalMs: number; pollTimeoutMs: number }): Promise<string | null> {
	const deadline = Date.now() + Math.max(0, input.pollTimeoutMs);
	for (;;) {
		const captured = normalizeClipboardSelection(readClipboardText(input.clipboard), input.sentinel);
		if (captured) return captured;
		if (Date.now() >= deadline) return null;
		await input.wait(input.pollIntervalMs);
	}
}

/**
 * 读取系统级划词（任意应用里的选中文本）。永不抛：平台不支持/权限不足/没有选区
 * 都返回 { ok:false, reason }，由浮窗显示对应提示。
 */
export async function readSystemSelection(options: SystemSelectionReaderOptions = {}): Promise<SystemSelectionReadResult> {
	const plan = resolveSystemSelectionPlan({
		platform: options.platform ?? process.platform,
		sessionType: options.sessionType ?? process.env.XDG_SESSION_TYPE,
	});
	if (!plan.supported) return { ok: false, reason: plan.reason };

	const clipboardSource = options.clipboard ?? clipboard;
	const originalText = readClipboardText(clipboardSource);
	const sentinel = createSelectionSentinel(options.sentinelId);
	const wait = options.wait ?? ((ms: number) => delay(ms));
	try {
		clipboardSource.writeText(sentinel);
	} catch {
		// 哨兵都写不进去（剪贴板被锁死）时无法判断选区，直接按取词失败返回。
		return { ok: false, reason: "capture-failed" };
	}
	try {
		const injectDelay = options.injectDelayMs ?? SELECTION_COPY_INJECT_DELAY_MS;
		if (injectDelay > 0) await wait(injectDelay);
		try {
			await triggerCopy(plan, options);
		} catch (error) {
			return { ok: false, reason: classifySystemSelectionTriggerError(error) };
		}
		const text = await waitForClipboardSelection({
			clipboard: clipboardSource,
			sentinel,
			wait,
			pollIntervalMs: options.pollIntervalMs ?? SELECTION_POLL_INTERVAL_MS,
			pollTimeoutMs: options.pollTimeoutMs ?? SELECTION_POLL_TIMEOUT_MS,
		});
		if (text === null) return { ok: false, reason: "capture-failed" };
		return { ok: true, text };
	} catch {
		// 兜底（等待/轮询自身抛错，如计时器异常）：同样结算成取词失败，绝不把裸异常抛出主进程。
		return { ok: false, reason: "capture-failed" };
	} finally {
		// 无论成功失败都还原用户剪贴板：划词是高频动作，不能每次都悄悄清掉用户复制内容。
		restoreClipboardText(clipboardSource, originalText);
	}
}
