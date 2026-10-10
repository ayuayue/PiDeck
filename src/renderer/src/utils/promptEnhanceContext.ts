import type { ChatMessage } from "../../../shared/types/session";
import { ENHANCE_CONTEXT_MAX_CHARS, ENHANCE_CONTEXT_MAX_MESSAGES, type EnhanceContextMessage } from "../../../shared/types/enhance";

/** 只从已加载的会话正文取有界快照；不读取文件、图片、思考或工具结果。 */
export function collectPromptEnhanceContext(messages: readonly ChatMessage[]): EnhanceContextMessage[] {
	const result: EnhanceContextMessage[] = [];
	let remaining = ENHANCE_CONTEXT_MAX_CHARS;
	for (let index = messages.length - 1; index >= 0 && remaining > 0 && result.length < ENHANCE_CONTEXT_MAX_MESSAGES; index--) {
		const message = messages[index];
		if (message.role !== "user" && message.role !== "assistant") continue;
		// 优先最近内容；大段较旧正文只取尾部，避免截断 Unicode 代理对。
		let text = message.text.slice(-remaining);
		if (/^[\uDC00-\uDFFF]/.test(text)) text = text.slice(1);
		text = text.trim();
		if (!text) continue;
		result.push({ role: message.role, text });
		remaining -= text.length;
	}
	return result.reverse();
}
