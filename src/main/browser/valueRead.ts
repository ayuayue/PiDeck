/**
 * 运行时不可信值的收窄工具。
 *
 * 两个来源都不可信：页面快照来自被操作的网页（可能是恶意页面），
 * 审批回包来自渲染层。所有跨边界字段都先收窄再使用，禁止直接断言结构。
 */

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readString(value: unknown, fallback = ""): string {
	return typeof value === "string" ? value : fallback;
}

export function readFiniteNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function readBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function readArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

/** 折叠空白并截断，避免页面用超长文本撑爆模型上下文。 */
export function truncateText(value: string, maxChars: number): string {
	const text = value.replace(/\s+/g, " ").trim();
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}
