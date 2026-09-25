/**
 * 判断模型请求是否因为上下文窗口超限而失败。
 *
 * 供应商错误经常被包装成 JSON 字符串（例如 `code: "context_length_exceeded"`），
 * 也可能只保留自然语言文案。这里集中做宽松识别，让主进程能把「可通过压缩恢复」
 * 与普通 API/鉴权失败区分开；不要把 rate limit / quota 等错误误判成上下文溢出。
 */
export function isContextOverflowError(value: unknown): boolean {
	const raw = typeof value === "string" ? value : value instanceof Error ? value.message : String(value ?? "");
	const text = raw.trim().toLowerCase();
	if (!text) return false;
	return [
		"context_length_exceeded",
		"context length exceeded",
		"context window exceeded",
		"maximum context length",
		"prompt is too long",
		"prompt too long",
		"too many tokens",
		"token limit exceeded",
	].some((marker) => text.includes(marker));
}
