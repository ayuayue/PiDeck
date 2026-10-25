/**
 * 系统级划词的「复制即触发」剪贴板监听。
 *
 * 用户反馈（2026-10）：全局划词不应只在按快捷键后弹窗，而是像应用内划词一样
 * 选中并复制文字就自动出现；快捷键保留为兜底。这里只做轮询策略，Electron 的
 * clipboard / 窗口焦点由装配层注入，因此可脱离 Electron 单测。
 *
 * 边界：
 * - 启动/开启时以当前剪贴板为基线，已有内容不会在开关打开瞬间触发；
 * - 自己的窗口有焦点时（主窗口/浮窗）不触发——应用内复制由应用内划词处理，
 *   浮窗自己的「复制」也不会再弹一个浮窗；
 * - 取词链路模拟复制期间由 service 调 suppressFor()，哨兵/恢复内容不触发；
 * - 只处理纯文本；空白/过短忽略，超长按系统浮窗上限截断；
 * - 同一段文本重复复制无法被剪贴板文本比对识别（Electron 不暴露序列号），
 *   这是与同类工具一致的取舍。
 */
import { SELECTION_TOOL_TEXT_MAX_CHARS } from "../../shared/types/selectionTool";

export const CLIPBOARD_SELECTION_POLL_INTERVAL_MS = 250;
export const CLIPBOARD_SELECTION_MIN_CHARS = 2;

export type ClipboardSelectionCandidateInput = {
	currentText: string;
	lastText: string;
	ownWindowFocused: boolean;
	suppressed: boolean;
	minChars?: number;
	maxChars?: number;
};

export type ClipboardSelectionCandidate = {
	/** 下一次比对的基线（无论是否触发都要更新，避免焦点/抑制期间的内容事后补弹）。 */
	nextLastText: string;
	/** 非空 = 应弹出浮窗的文本。 */
	triggerText: string | null;
};

/** 剪贴板文本归一化（与 systemSelectionReader 同口径：去 NUL、trim）。 */
export function normalizeClipboardText(text: string): string {
	return text.replace(/\u0000/g, "").trim();
}

/** 纯策略：一次轮询是否应触发浮窗。 */
export function resolveClipboardSelectionCandidate(input: ClipboardSelectionCandidateInput): ClipboardSelectionCandidate {
	const normalized = normalizeClipboardText(input.currentText);
	if (normalized === input.lastText) return { nextLastText: input.lastText, triggerText: null };
	const minChars = Math.max(1, input.minChars ?? CLIPBOARD_SELECTION_MIN_CHARS);
	const maxChars = Math.max(1, input.maxChars ?? SELECTION_TOOL_TEXT_MAX_CHARS);
	if (input.suppressed || input.ownWindowFocused || normalized.length < minChars) {
		return { nextLastText: normalized, triggerText: null };
	}
	return { nextLastText: normalized, triggerText: normalized.slice(0, maxChars) };
}

export type ClipboardSelectionWatcherDeps = {
	/** 读取剪贴板纯文本；失败可由调用方返回空串。 */
	readText: () => string;
	/** 自己的任一窗口是否有焦点（主窗口 / 系统划词浮窗 / 其它 PiDeck 窗口）。 */
	isOwnWindowFocused: () => boolean;
	onCaptured: (text: string) => void;
	logger?: { warn?: (message: string, detail?: unknown) => unknown } | null;
	intervalMs?: number;
	minChars?: number;
	maxChars?: number;
	now?: () => number;
};

/**
 * 轮询剪贴板并触发系统浮窗。装配层负责 start/stop（跟随「系统级划词」开关）；
 * pollOnce 公开给单测（不依赖真实计时器）。
 */
export class ClipboardSelectionWatcher {
	private readonly intervalMs: number;
	private lastText: string;
	private timer: ReturnType<typeof setInterval> | null = null;
	private suppressedUntil = 0;
	private disposed = false;

	constructor(private readonly deps: ClipboardSelectionWatcherDeps) {
		this.intervalMs = Math.max(100, deps.intervalMs ?? CLIPBOARD_SELECTION_POLL_INTERVAL_MS);
		this.lastText = normalizeClipboardText(this.readTextSafely());
	}

	/** 开关：启动时以当前剪贴板为基线，已有文本不会立即触发。 */
	setEnabled(enabled: boolean): void {
		if (enabled) this.start();
		else this.stop();
	}

	start(): void {
		if (this.disposed || this.timer) return;
		this.lastText = normalizeClipboardText(this.readTextSafely());
		this.suppressedUntil = 0;
		this.timer = setInterval(() => this.pollOnce(), this.intervalMs);
	}

	stop(): void {
		if (!this.timer) return;
		clearInterval(this.timer);
		this.timer = null;
	}

	/** 应用自己写剪贴板（取词哨兵/恢复/复制结果）期间抑制触发。 */
	suppressFor(durationMs: number): void {
		const now = this.deps.now?.() ?? Date.now();
		this.suppressedUntil = Math.max(this.suppressedUntil, now + Math.max(0, durationMs));
	}

	/** 单次轮询（测试入口）：更新基线，必要时回调。 */
	pollOnce(): void {
		if (this.disposed) return;
		const now = this.deps.now?.() ?? Date.now();
		const candidate = resolveClipboardSelectionCandidate({
			currentText: this.readTextSafely(),
			lastText: this.lastText,
			ownWindowFocused: this.isOwnWindowFocusedSafely(),
			suppressed: now < this.suppressedUntil,
			minChars: this.deps.minChars,
			maxChars: this.deps.maxChars,
		});
		this.lastText = candidate.nextLastText;
		if (!candidate.triggerText) return;
		try {
			this.deps.onCaptured(candidate.triggerText);
		} catch (error) {
			this.deps.logger?.warn?.("Clipboard selection trigger failed", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	dispose(): void {
		this.disposed = true;
		this.stop();
	}

	private readTextSafely(): string {
		try {
			return this.deps.readText() ?? "";
		} catch (error) {
			this.deps.logger?.warn?.("Clipboard read failed", { error: error instanceof Error ? error.message : String(error) });
			return "";
		}
	}

	private isOwnWindowFocusedSafely(): boolean {
		try {
			return this.deps.isOwnWindowFocused();
		} catch {
			return false;
		}
	}
}
