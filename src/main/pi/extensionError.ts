/**
 * 把 pi 的 extension_error 事件收成可展示的一行原因。
 * 事件里的 error 可能是字符串、Error-like 对象，或再包一层；
 * 直接 String(error) 会变成 "[object Object]"，排查信息就丢了。
 */
function firstNonEmptyString(...values: unknown[]): string {
	for (const value of values) {
		if (typeof value === "string" && value.trim()) return value.trim();
	}
	return "";
}

function stringifyUnknown(value: unknown): string {
	if (typeof value === "string") return value.trim();
	if (value instanceof Error) {
		return firstNonEmptyString(value.stack, value.message) || value.name;
	}
	if (value && typeof value === "object") {
		const nested = firstNonEmptyString(Reflect.get(value, "message"), Reflect.get(value, "error"), Reflect.get(value, "stack"), Reflect.get(value, "reason"));
		if (nested) return nested;
		try {
			const json = JSON.stringify(value);
			if (json && json !== "{}" && json !== "null") return json;
		} catch {
			// 循环引用等：退回通用文案
		}
	}
	return "";
}

/** 从 extension_error 事件抽出扩展名（若有）和错误正文。 */
export function formatExtensionErrorReason(event: Record<string, unknown>): string {
	const extensionName = firstNonEmptyString(event.extensionName, event.extension, event.source);
	const detail = stringifyUnknown(event.error) || stringifyUnknown(event.message) || stringifyUnknown(event.errorMessage) || stringifyUnknown(event.reason) || "Extension error";
	if (extensionName && !detail.includes(extensionName)) {
		return `${extensionName}: ${detail}`;
	}
	return detail;
}
