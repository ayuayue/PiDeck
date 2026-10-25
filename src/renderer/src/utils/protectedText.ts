import { parseExpandedRefBlocks } from "../../../shared/expandedRefBlocks";

/**
 * 发送管线的「只读区」工具：已展开的自包含块对后续展开器不可见。
 *
 * 为什么需要（2026-10 实测复现的语义 bug）：发送前有三个展开器按序执行
 * （引用 → 会话引用 → 提示词模板），每个都对整段文本跑全局正则。后一个不避让
 * 前一个刚生成的块，于是「引用里提到 /commit」会被替换成整份提交模板正文——
 * 落盘的引用原文与真实被引用的内容不一致，模型读到的是被改写的历史。
 *
 * 规则：块区间（含块内正文）只读；块外文本照常展开。嵌套块由外层区间覆盖
 * （`parseExpandedRefBlocks` 已按「被外层覆盖则跳过」返回顶层块），因此只需保护顶层区间。
 */

export type TextRange = { start: number; end: number };

/** 文本中所有自包含块的顶层区间（升序、互不相交）。 */
export function computeProtectedRanges(text: string): TextRange[] {
	if (!text.includes("<")) return [];
	return parseExpandedRefBlocks(text).map((block) => ({ start: block.start, end: block.end }));
}

/** 给定区间是否落在任一保护区（含部分重叠——跨边界的匹配同样视为块内文本）。 */
export function overlapsProtected(start: number, end: number, ranges: TextRange[]): boolean {
	for (const range of ranges) {
		if (start < range.end && end > range.start) return true;
	}
	return false;
}

/**
 * 按正则替换，但跳过落在保护区内的匹配。
 * `replacer` 签名与 `String.prototype.replace` 的回调一致（match, ...groups, offset, text）。
 */
export function replaceOutsideProtected(text: string, pattern: RegExp, replacer: (...args: string[]) => string): string {
	const ranges = computeProtectedRanges(text);
	// 无保护区时也要走函数形态：字符串形态会把替换内容里的 `$&`、`$\`` 当替换模式（模板正文/引用正文里真实会出现）。
	if (ranges.length === 0) return text.replace(pattern, (...args: string[]) => replacer(...args));
	// String.replace 的回调尾部固定是 (offset, 全文)，中间的才是捕获组：
	// 用 offset 判断匹配是否落在保护区内，并只把捕获组交回调用方（不需要强转）。
	return text.replace(pattern, (matched: string, ...rest: unknown[]) => {
		const offset = rest.at(-2);
		if (typeof offset === "number" && overlapsProtected(offset, offset + matched.length, ranges)) return matched;
		return replacer(matched, ...rest.slice(0, -2).map((value) => String(value)));
	});
}
