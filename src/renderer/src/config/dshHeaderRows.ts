/** DSH 自定义请求头的纯数据模型；行 ID 与可编辑的 header 名和值解耦。 */
export type DshHeaderRow = {
	id: string;
	name: string;
	value: string;
};

let nextRowId = 0;

/** 为设置页生成稳定的编辑行；只接受字符串值，避免把非法 YAML 值送进请求层。 */
export function createDshHeaderRows(value: unknown): DshHeaderRow[] {
	if (!isRecord(value)) return [];
	return Object.entries(value).flatMap(([name, headerValue]) => (typeof headerValue === "string" && name.trim() ? [{ id: `dsh-header-${nextRowId++}`, name, value: headerValue }] : []));
}

/** 以不可变方式更新指定行，便于 React 保持输入焦点和其余行引用。 */
export function updateDshHeaderRow(rows: DshHeaderRow[], id: string, patch: Partial<Pick<DshHeaderRow, "name" | "value">>): DshHeaderRow[] {
	return rows.map((row) => (row.id === id ? { ...row, ...patch } : row));
}

/** 把编辑草稿变回 DSH profile.headers；空名称不落盘，空值仍是用户的显式覆盖。 */
export function serializeDshHeaderRows(rows: DshHeaderRow[]): Record<string, string> | undefined {
	// HTTP header 名不区分大小写；保留最后一次输入的拼写和值，不发送两个同名头。
	const next = new Map<string, [string, string]>();
	for (const row of rows) {
		const name = row.name.trim();
		if (name) next.set(name.toLowerCase(), [name, row.value]);
	}
	return next.size > 0 ? Object.fromEntries(next.values()) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
