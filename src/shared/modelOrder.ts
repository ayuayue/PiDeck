/**
 * 模型展示顺序的统一比较器（主进程 / 渲染进程共用一套排序键）。
 *
 * 为什么需要 shared：历史上「会话模型下拉列表」「配置页模型表」「/models 拉取结果」
 * 「TokenDance 目录写入」各自写了一份 localeCompare，排序键不完全一致，
 * 导致同一批模型在下拉里有序、在配置文件里乱序（用户反馈「保存后很乱」）。
 * 收敛到这里后，任何一处产出模型列表都按同一规则排，落盘顺序 = 下拉顺序。
 *
 * 规则：按展示名（name，去空白后非空）正序；name 缺失回退 id；同键再按 id 兜底，
 * 保证顺序稳定可预期（不随 API 返回顺序变化）。
 *
 * 纯函数、无依赖（shared 层约束）。
 */

/**
 * 参与排序的最小行结构。
 * 字段故意放宽成 unknown：DSH 模型行（DshModelLike）与网络响应都是弱类型袋，
 * 这里自行收窄，避免调用方为了过类型检查而 as 强转。
 */
export type ModelSortRow = {
	id?: unknown;
	name?: unknown;
};

/** 取排序键：name 优先（小写归一），空/缺失时回退 id。 */
export function modelSortKey(row: ModelSortRow): string {
	const name = typeof row.name === "string" ? row.name.trim() : "";
	if (name.length > 0) return name.toLowerCase();
	return typeof row.id === "string" ? row.id.toLowerCase() : "";
}

/**
 * 名称正序比较器。
 * 同键（例如两条 name 相同、或都退化成同一 id 前缀）时按 id 兜底，
 * 让排序在全键相等之外仍然稳定，不依赖输入顺序。
 */
export function compareModelRows(a: ModelSortRow, b: ModelSortRow): number {
	const aKey = modelSortKey(a);
	const bKey = modelSortKey(b);
	if (aKey !== bKey) return aKey.localeCompare(bKey);
	const aId = typeof a.id === "string" ? a.id : "";
	const bId = typeof b.id === "string" ? b.id : "";
	return aId.localeCompare(bId);
}

/**
 * 原地按展示名正序排序并返回同一数组（便于链式调用）。
 * 调用方若需保留原顺序，先自行浅拷贝。
 */
export function sortModelRows<T extends ModelSortRow>(rows: T[]): T[] {
	return rows.sort(compareModelRows);
}
