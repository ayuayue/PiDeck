/**
 * Web 端系统分享（Web Share API）+ 复制降级。
 *
 * navigator.share 在移动端 Safari/Chrome 普遍可用，桌面 Chrome/Edge 也支持文本分享；
 * 不可用时降级为剪贴板复制（webClipboard），两者都没有时返回 failed 由 UI 提示。
 */
import { copyTextToClipboard } from "./webClipboard";

export type WebShareOutcome = "shared" | "copied" | "failed";

export function canShareNatively(): boolean {
	return typeof navigator !== "undefined" && typeof navigator.share === "function";
}

export async function shareWebText(title: string, text: string): Promise<WebShareOutcome> {
	if (!text.trim()) return "failed";
	if (canShareNatively()) {
		try {
			await navigator.share({ title, text });
			return "shared";
		} catch (error) {
			// AbortError = 用户自己取消，不算失败也不降级
			if (typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError") {
				return "shared";
			}
			// 其它异常（如桌面端拒绝非手势调用）继续走复制降级
		}
	}
	const copied = await copyTextToClipboard(text);
	return copied ? "copied" : "failed";
}
