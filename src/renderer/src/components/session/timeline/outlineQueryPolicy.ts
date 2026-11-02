/**
 * 会话目录面板的输入解析（纯函数，可单测）。
 *
 * 一个输入框干两件事：输入条数 -> 跳到第 N 条；输入文字 -> 按标题过滤。
 * 三态而不是两态，因为「超范围的数字」不能掉进「文字」分支：
 * 用户输 0 或 999，若当文字过滤，列表底部只会显示「命中 0 条」，
 * 他看不出自己输错了什么。无效数字必须单独成一个状态、给出范围提示。
 *
 * 全角数字（"１２"）刻意不认：/^\d+$/ 只匹配 ASCII，Number("０") 是 NaN。
 * 这条写进测试固定下来 —— 以后谁要加 normalize，先改测试说明口径变了。
 */
export type OutlineQueryPlan = { kind: "none" } | { kind: "jump"; index: number } | { kind: "invalid" } | { kind: "filter"; text: string };

export function planOutlineQuery(query: string, itemCount: number): OutlineQueryPlan {
	const trimmed = query.trim();
	if (trimmed === "") return { kind: "none" };
	if (/^\d+$/.test(trimmed)) {
		const n = Number(trimmed);
		if (n >= 1 && n <= itemCount) return { kind: "jump", index: n - 1 };
		return { kind: "invalid" };
	}
	return { kind: "filter", text: trimmed.toLowerCase() };
}
