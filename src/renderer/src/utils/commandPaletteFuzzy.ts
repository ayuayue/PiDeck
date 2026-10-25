/**
 * 命令面板模糊匹配内核（纯函数，可 node --test 直接单测）。
 *
 * 为什么不用朴素 includes：命令面板要搜「设置项 + 操作 + 配置页」，条目跨度大、
 * 用户输入往往是缩略（"重启ag"、"代理"、"dsh run"）。子序列匹配 + 位置加权
 * 能在保持零依赖的同时给出「词首命中 > 连续命中 > 分散命中」的合理排序，
 * 并且回传命中下标供 UI 高亮——高亮是模糊匹配的必要反馈，没有它用户不知道
 * 「为什么这条能搜出来」。
 *
 * 与 VSCode 的差距：不做拼音首字母、不做多词 AND/OR 语法。这两项要么需要
 * 词典，要么需要语法解析，收益不足以抵消复杂度；中文关键词靠每条命令自带的
 * keywords 别名覆盖（见 commandPaletteCommands.ts）。
 */

/** 词边界字符：命中这些字符之后的字符视为「词首」，给额外加分。 */
const WORD_SEPARATORS = new Set([" ", "-", "_", "/", "\\", ".", ":", "(", ")", "[", "]", "<", ">", "，", "、", "：", "（", "）"]);

export type FuzzyMatch = {
	/** 越大越相关；仅用于同一次查询内排序，绝对值无意义。 */
	score: number;
	/** 命中字符在原文中的下标（升序），供高亮切片。 */
	indices: number[];
};

/** 判断 text[i] 是否处于词首（i=0 或前一字符是分隔符）。 */
function isWordStart(text: string, index: number): boolean {
	if (index === 0) return true;
	return WORD_SEPARATORS.has(text[index - 1] ?? "");
}

/** 判断 text[i] 是否是 camelCase 边界（前一个小写、当前大写）。 */
function isCamelStart(text: string, index: number): boolean {
	if (index === 0) return false;
	const prev = text[index - 1] ?? "";
	const current = text[index] ?? "";
	return prev !== prev.toUpperCase() && current === current.toUpperCase() && /[a-z]/i.test(prev) && /[a-z]/i.test(current);
}

/**
 * 子序列模糊匹配。
 *
 * 语义：query 的字符（忽略大小写）需按序出现在 text 中，允许中间跳过字符。
 * 返回 null = 不匹配。空 query 恒匹配且得 0 分（调用方按原序展示全部）。
 *
 * 评分（启发式，非严格模型）：
 * - 词首/开头命中 +10，camelCase 边界 +6，其余 +1；
 * - 紧邻上一个命中 +6（连续串更像用户本意）；
 * - 跳过 n 个字符扣 min(n, 6) * 0.5（允许分散但轻微惩罚）；
 * - 末尾按 text 长度做轻微归一化，避免长标题仅因字符多而占优。
 */
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
	if (!query) return { score: 0, indices: [] };
	if (!text) return null;

	const needle = query.toLowerCase();
	const haystack = text.toLowerCase();
	const indices: number[] = [];
	let score = 0;
	let cursor = 0;
	// 上一个命中位置：-2 表示「还没有命中」，用于区分「连续」与「首个命中」。
	let previous = -2;

	for (const char of needle) {
		// 空格只作分隔语义，不要求出现在原文里（"重启 agent" 也能命中 "重启Agent"）
		if (char === " ") continue;

		let found = -1;
		for (let i = cursor; i < haystack.length; i += 1) {
			if (haystack[i] === char) {
				found = i;
				break;
			}
		}
		if (found === -1) return null;

		let gain = 1;
		if (isWordStart(text, found)) gain += 10;
		else if (isCamelStart(text, found)) gain += 6;
		if (found === previous + 1) gain += 6;
		else if (previous >= 0) gain -= Math.min(found - previous - 1, 6) * 0.5;

		score += gain;
		indices.push(found);
		previous = found;
		cursor = found + 1;
	}

	if (indices.length === 0) return { score: 0, indices: [] };
	// 长文本的匹配天然更「稀疏」，轻微折价让短标题占优
	score -= Math.min(text.length, 60) * 0.05;
	return { score, indices };
}

/** 待匹配的最小条目形状：命令面板只要这三段文本就能完成打分。 */
export type FuzzySearchable = {
	/** 主标题，命中时高亮（权重最高） */
	title: string;
	/** 次级说明（权重次之，命中不高亮以免与标题高亮混淆） */
	subtitle?: string;
	/** 别名/关键词（中英同义词、缩写等，权重最低） */
	keywords?: readonly string[];
};

// 这里只保留「打分」这一件事：排序与可见性已交给 cmdk（依据 filter 返回的分数），
// 原先的 rankFuzzy / FuzzyRanked（自己排序 + 自己聚合高亮下标）随迁移下线。
