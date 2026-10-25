/**
 * 把各导入源的工具参数收成 pi `toolCall.arguments`（对象）。
 * 源里常见 JSON 字符串或数组；工具卡按 map 读 path / command 等字段，
 * 数组包一层以免渲染层把 list 当成 record。
 */
export function normalizeImportedToolArguments(value: unknown): Record<string, unknown> {
	if (typeof value === "string") {
		const trimmed = value.trim();
		if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
			try {
				return normalizeImportedToolArguments(JSON.parse(trimmed) as unknown);
			} catch {
				// 不是合法 JSON：整段原文保留，避免解析失败后丢成空对象。
			}
		}
		return trimmed ? { value: trimmed } : {};
	}
	if (Array.isArray(value)) return { items: value };
	if (value && typeof value === "object") return value as Record<string, unknown>;
	if (value == null) return {};
	return { value };
}
