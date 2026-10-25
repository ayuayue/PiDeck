import { MAX_QUICK_MESSAGES, normalizeQuickMessages } from "../../../shared/quickMessages";

/**
 * 只把内置缺项追加到个人草稿末尾。去重复用落盘清洗规则，原有行却不清洗：
 * 空行、重复行和首尾空白都是合法的编辑中间态，也必须占用条数预算。
 */
export function appendMissingQuickMessages(current: string[], defaults: readonly string[]): string[] {
	const seen = new Set(current.flatMap((item) => normalizeQuickMessages([item]).map((text) => text.toLowerCase())));
	const missing: string[] = [];
	for (const text of normalizeQuickMessages(defaults)) {
		if (current.length + missing.length >= MAX_QUICK_MESSAGES) break;
		const key = text.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		missing.push(text);
	}
	// 无变化保留引用，让命令层跳过不必要的写盘及成功提示。
	return missing.length > 0 ? [...current, ...missing] : current;
}

/** 移动到目标最终位置；无效/过期下标和原地放下均不改动，其余条目保持相对顺序。 */
export function reorderQuickMessages(items: string[], sourceIndex: number, targetIndex: number): string[] {
	if (!Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex) || sourceIndex < 0 || targetIndex < 0 || sourceIndex >= items.length || targetIndex >= items.length || sourceIndex === targetIndex) return items;
	const next = [...items];
	const [moved] = next.splice(sourceIndex, 1);
	next.splice(targetIndex, 0, moved);
	return next;
}
