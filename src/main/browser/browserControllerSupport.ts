/** BrowserController 的纯工具函数与键盘表（拆出来控制单文件体量，也便于单测）。 */
import { BrowserAgentError } from "./browserErrors";
import { isRecord, readString, truncateText } from "./valueRead";

export type KeyDef = { key: string; code: string; vk: number; text?: string };

/** 常用按键的 CDP 参数表；key 统一小写做查找键。 */
export const KEY_DEFS: Record<string, KeyDef> = {
	enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
	tab: { key: "Tab", code: "Tab", vk: 9 },
	escape: { key: "Escape", code: "Escape", vk: 27 },
	backspace: { key: "Backspace", code: "Backspace", vk: 8 },
	delete: { key: "Delete", code: "Delete", vk: 46 },
	arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
	arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
	arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
	arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
	home: { key: "Home", code: "Home", vk: 36 },
	end: { key: "End", code: "End", vk: 35 },
	pageup: { key: "PageUp", code: "PageUp", vk: 33 },
	pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
	space: { key: " ", code: "Space", vk: 32, text: " " },
};

export function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	return Math.min(max, Math.max(min, value));
}

/** CDP modifiers 位掩码：Alt=1, Ctrl=2, Meta=4, Shift=8。 */
export function modifierMask(modifiers: readonly string[] | undefined): number {
	let mask = 0;
	for (const modifier of modifiers ?? []) {
		if (modifier === "alt") mask |= 1;
		else if (modifier === "ctrl") mask |= 2;
		else if (modifier === "meta") mask |= 4;
		else if (modifier === "shift") mask |= 8;
	}
	return mask;
}

export function buttonMask(button: string): number {
	if (button === "right") return 2;
	if (button === "middle") return 4;
	return 1;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(new BrowserAgentError("navigation_failed", message)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolve(value);
			},
			(error) => {
				clearTimeout(timer);
				reject(error);
			},
		);
	});
}

/** Runtime.evaluate 的返回：有 exceptionDetails 视为页面脚本错误（不把页面异常当空结果）。 */
export function readRuntimeValue(raw: unknown): unknown {
	if (!isRecord(raw)) throw new BrowserAgentError("page_script_error", "页面没有返回可用的结果");
	if (raw.exceptionDetails !== undefined && raw.exceptionDetails !== null) {
		const details = isRecord(raw.exceptionDetails) ? raw.exceptionDetails : {};
		const text = readString(details.description) || readString(details.text) || "页面脚本执行失败";
		throw new BrowserAgentError("page_script_error", truncateText(text, 200));
	}
	const result = isRecord(raw.result) ? raw.result : {};
	return result.value;
}
