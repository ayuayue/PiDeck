import { fuzzyMatch } from "../../../utils/commandPaletteFuzzy";
import { isPinyinQuery, matchPinyinText } from "../../../utils/pinyinSearch";

// 拼音字典已改按需装载（不进启动 chunk）：调用方（SettingsSearchBox / 单测）在本模块
// 打分前必须先 await ensurePinyinTable()，否则拼音通道打 0 分。这里透出同一个装载器，
// 让「打分内核 + 它依赖的字典」保持同一入口，调用方不必再额外 import 第二个模块。
export { ensurePinyinTable } from "../../../utils/pinyinSearch";

/**
 * 设置页搜索的纯打分内核（无 React 依赖，`node --test` 可直接加载）。
 *
 * 为什么要有它：命令面板（Ctrl+P）早就能搜到具体设置项，但那条路径没有任何可见提示，
 * 大多数用户只会打开设置页一页页翻（67 个 tab 子文件、几百行设置），找不到就以为没这个功能。
 * 设置搜索把同一份锚点清单（settingsFieldAnchors + 各 tab 本身）做成可见入口。
 *
 * 三条打分通道，权重按「用户输入的确定性」排序：
 *   1. 标题子串 —— 用户照着页面上的名字打，最可信（整串相等 > 前缀 > 出现在中间）；
 *   2. 标题拼音 —— 「dl」「daili」找「代理」：中文用户主要的输入习惯，
 *      复用会话搜索那套分级分数（整名首字母 700 > 前缀 680 > 全拼 640 > 跳字 560）；
 *   3. 标题模糊 / 关键词 / tab 名 —— 收窄范围用。关键词命中必须低于标题命中，
 *      否则搜「代理」时「网络代理关键词挂在别的行上」会盖住标题就叫「代理」的 tab。
 *
 * 多词查询按 AND 处理（每个词都要在某一段文本里命中），与文件搜索的会话内查找一致。
 */

/** 参与搜索的最小条目形状：文案已由调用方翻译好，本模块只做匹配与排序。 */
export type SettingsSearchEntry<TTab extends string = string, TSection extends string = string> = {
	/** 全局唯一 id：`tab:<id>` 或 `field:<slug>`，供 React key 与选中态使用。 */
	id: string;
	tab: TTab;
	/** 有值 = 跳到该字段/分区锚点；缺省 = 只切到 tab 顶部（tab 级入口）。 */
	section?: TSection;
	/** 主标题（页面上那一行的名字或 tab 名），命中时高亮。 */
	title: string;
	/** 所属 tab 名，结果行右侧显示「它在哪一页」。 */
	tabLabel: string;
	/** 搜索别名：字段英文名、口语说法、相邻概念。 */
	keywords: readonly string[];
};

export type SettingsSearchHit<TTab extends string = string, TSection extends string = string> = {
	entry: SettingsSearchEntry<TTab, TSection>;
	score: number;
	/** 标题里命中的字符下标（升序），供高亮切片；拼音命中时为空。 */
	titleIndices: readonly number[];
};

/** 标题通道分数档位：整串相等 > 前缀 > 中间出现 > 拼音 > 模糊子序列。 */
const TITLE_EXACT = 1000;
const TITLE_PREFIX = 900;
const TITLE_CONTAINS = 800;
const TITLE_PINYIN_BASE = 700;
const TITLE_FUZZY_BASE = 400;

/** 关键词通道：命中说明「这个词跟它相关」，但不是它自己的名字，整体低于标题通道。 */
const KEYWORD_EXACT = 650;
const KEYWORD_PREFIX = 600;
const KEYWORD_CONTAINS = 550;
const KEYWORD_PINYIN_BASE = 500;
const KEYWORD_FUZZY_BASE = 250;

/** tab 名通道：只用来把整页的项兜进来（搜「终端」时该页所有设置项都该出现）。 */
const TAB_LABEL_EXACT = 300;
const TAB_LABEL_CONTAINS = 220;
const TAB_LABEL_PINYIN_BASE = 200;

/** 空查询不返回任何结果：搜索框空着时应显示 tab 内容，而不是一堆条目。 */
export const SETTINGS_SEARCH_MIN_QUERY_LENGTH = 1;

/** 单段文本的打分：子串三档 + 拼音 + 模糊，取最高。 */
function scoreText(text: string, query: string, weights: { exact: number; prefix: number; contains: number; pinyin: number; fuzzy: number }): { score: number; indices: readonly number[] } {
	const haystack = text.toLowerCase();
	if (haystack === query) return { score: weights.exact, indices: rangeIndices(0, query.length) };
	if (haystack.startsWith(query)) return { score: weights.prefix, indices: rangeIndices(0, query.length) };
	const at = haystack.indexOf(query);
	if (at >= 0) return { score: weights.contains, indices: rangeIndices(at, at + query.length) };

	// 拼音分级分数 560..700 归一到 0..1 后铺满本通道的拼音档，保持 Go 侧的分级相对顺序
	const pinyinScore = matchPinyinText(text, query);
	if (pinyinScore > 0) return { score: weights.pinyin + pinyinScore / 1000, indices: [] };

	const fuzzy = fuzzyMatch(query, text);
	if (fuzzy) return { score: weights.fuzzy + fuzzy.score, indices: fuzzy.indices };
	return { score: 0, indices: [] };
}

function rangeIndices(from: number, to: number): readonly number[] {
	const indices: number[] = [];
	for (let index = from; index < to; index += 1) indices.push(index);
	return indices;
}

/** 单个条目对单个词的最优命中（标题优先，其次关键词，最后 tab 名）。 */
function scoreEntry(entry: SettingsSearchEntry, token: string): { score: number; titleIndices: readonly number[] } {
	const title = scoreText(entry.title, token, { exact: TITLE_EXACT, prefix: TITLE_PREFIX, contains: TITLE_CONTAINS, pinyin: TITLE_PINYIN_BASE, fuzzy: TITLE_FUZZY_BASE });
	// 高亮下标永远取标题的：关键词/拼音命中时标题本身没被命中，返回空数组即可。
	let best = { score: title.score, titleIndices: title.indices };
	for (const keyword of entry.keywords) {
		const keywordScore = scoreText(keyword, token, { exact: KEYWORD_EXACT, prefix: KEYWORD_PREFIX, contains: KEYWORD_CONTAINS, pinyin: KEYWORD_PINYIN_BASE, fuzzy: KEYWORD_FUZZY_BASE });
		if (keywordScore.score > best.score) best = { score: keywordScore.score, titleIndices: title.indices };
	}
	const tabLabel = scoreText(entry.tabLabel, token, { exact: TAB_LABEL_EXACT, prefix: TAB_LABEL_CONTAINS, contains: TAB_LABEL_CONTAINS, pinyin: TAB_LABEL_PINYIN_BASE, fuzzy: 0 });
	if (tabLabel.score > best.score) best = { score: tabLabel.score, titleIndices: title.indices };
	return best;
}

/**
 * 搜索入口：空查询返回空数组（调用方据此切回 tab 列表）。
 *
 * @param tabOrder 各 tab 在侧栏里的顺序，用于同分时按「页面上下顺序」排，用户不会觉得跳。
 */
export function searchSettingsEntries<TTab extends string, TSection extends string>(entries: readonly SettingsSearchEntry<TTab, TSection>[], rawQuery: string, tabOrder: readonly TTab[], limit = 40): SettingsSearchHit<TTab, TSection>[] {
	const query = rawQuery.trim().toLowerCase();
	if (query.length < SETTINGS_SEARCH_MIN_QUERY_LENGTH) return [];
	// 逐词 AND：每个词都必须命中某一段文本（标题/关键词/tab 名），与「中文多词」直觉一致。
	const tokens = query.split(/\s+/).filter((token) => token.length > 0);
	if (tokens.length === 0) return [];
	// 纯字母 2..24 才走拼音；中文/带标点的查询 matchPinyinText 内部会直接返回 0，这里判定只为省掉拆字。
	const pinyinEligible = isPinyinQuery(query);

	const orderIndex = new Map<TTab, number>();
	tabOrder.forEach((tab, index) => orderIndex.set(tab, index));

	const hits: SettingsSearchHit<TTab, TSection>[] = [];
	for (const entry of entries) {
		let total = 0;
		let matched = true;
		let titleIndices: readonly number[] = [];
		for (const token of tokens) {
			const result = scoreEntry(entry, token);
			if (result.score <= 0) {
				matched = false;
				break;
			}
			total += result.score;
			if (result.titleIndices.length > 0) titleIndices = result.titleIndices;
		}
		if (!matched) continue;
		// 整串就是一个纯字母拼音查询时，给拼音命中一点点总增益：避免 40 条同分结果里
		// 把「关键词里恰好含这几个字母」的项排到真正按首字母命中的项前面。
		if (pinyinEligible && tokens.length === 1 && matchPinyinText(entry.title, query) > 0) total += 1;
		hits.push({ entry, score: total, titleIndices });
	}

	hits.sort((left, right) => {
		if (right.score !== left.score) return right.score - left.score;
		const leftOrder = orderIndex.get(left.entry.tab) ?? Number.MAX_SAFE_INTEGER;
		const rightOrder = orderIndex.get(right.entry.tab) ?? Number.MAX_SAFE_INTEGER;
		if (leftOrder !== rightOrder) return leftOrder - rightOrder;
		// 同页内短标题更可能是用户找的那个（「字体」优先于「字体与行距设置」）
		if (left.entry.title.length !== right.entry.title.length) return left.entry.title.length - right.entry.title.length;
		return left.entry.title.localeCompare(right.entry.title);
	});
	return limit > 0 ? hits.slice(0, limit) : hits;
}

/** 高亮切片：把标题按命中下标切成 [普通, 命中, 普通, ...] 段落，UI 直接 map 渲染。 */
export function splitHighlightedTitle(title: string, indices: readonly number[]): { text: string; hit: boolean }[] {
	if (indices.length === 0) return [{ text: title, hit: false }];
	const hitSet = new Set(indices);
	const segments: { text: string; hit: boolean }[] = [];
	let buffer = "";
	let bufferHit = hitSet.has(0);
	for (let index = 0; index < title.length; index += 1) {
		const hit = hitSet.has(index);
		if (hit !== bufferHit && buffer.length > 0) {
			segments.push({ text: buffer, hit: bufferHit });
			buffer = "";
		}
		bufferHit = hit;
		buffer += title[index];
	}
	if (buffer.length > 0) segments.push({ text: buffer, hit: bufferHit });
	return segments;
}
