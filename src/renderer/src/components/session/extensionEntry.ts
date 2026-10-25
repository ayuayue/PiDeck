/**
 * 扩展输出条目（pi 的 appendEntry / type:"custom" 会话条目）的纯展示格式化。
 *
 * 背景：RPC 模式下 pi 的 registerEntryRenderer 不工作，PiDeck 在读侧把这些条目
 * 投影成 meta.type="customEntry" 的时间线卡片（见 SessionHistoryReader 的
 * buildCustomMessageCards 与 issue #285）。这里只负责把任意形状的 data 载荷
 * 格式化成稳定的「字段行」列表，供卡片展开态渲染；与 notifySummary 一样
 * 保持纯函数，可独立单测。
 */

/** 单个字段值的展示上限：超出截断并标注，避免超大快照撑爆 DOM。 */
export const EXTENSION_ENTRY_FIELD_VALUE_MAX = 2000;

export type ExtensionEntryField = {
	/** 展示标签；空串 = 无标签载荷（裸字符串/数组整体展示） */
	key: string;
	value: string;
};

function capValue(value: string): string {
	if (value.length <= EXTENSION_ENTRY_FIELD_VALUE_MAX) return value;
	return `${value.slice(0, EXTENSION_ENTRY_FIELD_VALUE_MAX)}…`;
}

function stringifyValue(value: unknown): string {
	try {
		return capValue(JSON.stringify(value, null, "\t") ?? "");
	} catch {
		return "";
	}
}

/**
 * 把 appendEntry 的 data 载荷格式化为字段行：
 * - 裸字符串 → 单个无标签字段（保留换行）
 * - 记录 → 按 key 顺序逐字段（字符串保留换行，原始值 JSON 缩进展示）
 * - 数组/其它 → 单个无标签字段整体 JSON 展示
 * data 缺失或为空记录时返回空数组，卡片据此只显示标题行。
 */
export function formatExtensionEntryFields(data: unknown): ExtensionEntryField[] {
	if (typeof data === "string") return data ? [{ key: "", value: capValue(data) }] : [];
	if (typeof data !== "object" || data === null) {
		return data === undefined ? [] : [{ key: "", value: stringifyValue(data) }];
	}
	if (Array.isArray(data)) return [{ key: "", value: stringifyValue(data) }];
	const fields: ExtensionEntryField[] = [];
	for (const [key, value] of Object.entries(data)) {
		if (typeof value === "string") {
			if (value) fields.push({ key, value: capValue(value) });
			continue;
		}
		if (typeof value === "number" || typeof value === "boolean") {
			fields.push({ key, value: String(value) });
			continue;
		}
		if (value === null || value === undefined) continue;
		fields.push({ key, value: stringifyValue(value) });
	}
	return fields;
}
