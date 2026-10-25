// 渲染层拼音检索：侧栏「搜索会话」这类本地过滤（渲染层拿不到 file-index 的索引）
// 用这里的键与匹配器支持「ylcx → 用量查询」。
//
// 与 Go 侧的一致性：表由 `scripts/gen-pinyin-table.mjs` 从 go-pinyin 抽出来
// （`native/file-index/pinyin.go` 用的是同一本字典），分级分数也逐值对齐
// （整名首字母 700 > 首字母前缀 680 > 全拼子串 640 > 跳字首字母 560）——
// 同一个查询在文件搜索与会话搜索里的命中顺序才一致。
//
// 语义（与 Go 侧同步维护）：
//   - 首字母按「逐字读音集合」存，异读不漏：重 → ctz，所以 cq 与 zq 都能命中「重庆」；
//   - 全拼只取字典默认读音（重 → zhong），"chongqing" 不命中；
//   - 只有纯 ASCII 字母、长度 2–24 的查询走拼音通道（中文/带点/带下划线的照常走子串匹配）；
//   - 键按标题缓存，重复渲染不做第二次拆字；
//   - 字典按需装载（ensurePinyinTable）：不进启动 chunk，搜索入口打开时才加载——
//     不用搜索的会话不该为 26k 条表付出解析与常驻堆内存。

export type PinyinKeys = {
	/** 逐字首字母集合，组间用 NUL 分隔（重 → "ctz"），与 Go 侧同一套编码。 */
	initials: string;
	/** 各字默认读音拼接（用量查询 → "yongliangchaxun"）。 */
	full: string;
};

/** 分级分数：与 Go 侧 `scoreNamePinyin*` 常量逐值一致。 */
export const PINYIN_SCORES = {
	exact: 700,
	prefix: 680,
	full: 640,
	skip: 560,
} as const;

/** 首字母组分隔符：标题里不会出现 NUL，用它编码不会与标题冲突。 */
const GROUP_SEPARATOR = "\u0000";
/** 查询长度闸：单字母会命中太多，超长必然不是首字母查询（与 Go 侧 maxPinyinQueryLen 一致）。 */
const MAX_QUERY_LENGTH = 24;
/** 键缓存上限：会话列表滚动时标题会变，但同一个标题反复渲染是常态。 */
const MAX_CACHE_ENTRIES = 2000;

let table: Map<string, string> | null = null;
let tablePromise: Promise<Map<string, string>> | null = null;
const keysCache = new Map<string, PinyinKeys | null>();

/**
 * 按需装载拼音字典（26k 条拆成 Map，约几毫秒）：调用方是搜索入口（侧栏面板打开、
 * 设置搜索挂载），装载完成后必须重新触发一次渲染/重算，pinyinKeys 才会产出真实键。
 * 失败把 tablePromise 置空，下次调用可重试；失败只损失拼音通道，子串匹配照常。
 */
export function ensurePinyinTable(): Promise<Map<string, string>> {
	if (table) return Promise.resolve(table);
	tablePromise ??= import("./pinyinTable").then((mod) => {
		const rows = mod.PINYIN_ENTRIES.split("\n");
		const map = new Map<string, string>();
		for (let index = 0; index < mod.PINYIN_CHARS.length && index < rows.length; index += 1) {
			map.set(mod.PINYIN_CHARS[index], rows[index]);
		}
		table = map;
		return map;
	});
	const pending = tablePromise;
	pending.catch(() => {
		if (tablePromise === pending) tablePromise = null;
	});
	return pending;
}

/** 纯 ASCII 小写字母、长度 2..24 —— 只有这种查询才值得走拼音通道。 */
export function isPinyinQuery(query: string): boolean {
	if (query.length < 2 || query.length > MAX_QUERY_LENGTH) return false;
	for (let index = 0; index < query.length; index += 1) {
		const code = query.charCodeAt(index);
		if (code < 97 || code > 122) return false;
	}
	return true;
}

/**
 * 计算标题的拼音键；标题里没有字典收录的汉字时返回 null（纯英文标题不必进拼音通道）。
 * 结果按标题缓存：会话列表每次渲染都会重新过滤，不能每次都拆一遍字。
 */
export function pinyinKeys(text: string): PinyinKeys | null {
	// 表未装载时返回 null 且不写缓存：调用方在 ensurePinyinTable 完成后会重算，
	// 这里若落缓存会把「还没加载」错记成「无汉字」永久污染该标题的键。
	if (!table) return null;
	const cached = keysCache.get(text);
	if (cached !== undefined) return cached;
	const map = table;
	let initials = "";
	let full = "";
	let groupCount = 0;
	for (const char of text) {
		const row = map.get(char);
		if (!row) continue;
		const tab = row.indexOf("\t");
		if (tab <= 0) continue;
		if (groupCount > 0) initials += GROUP_SEPARATOR;
		initials += row.slice(0, tab);
		full += row.slice(tab + 1);
		groupCount += 1;
	}
	const keys = groupCount > 0 ? { initials, full } : null;
	if (keysCache.size >= MAX_CACHE_ENTRIES) keysCache.clear();
	keysCache.set(text, keys);
	return keys;
}

/** 首字母组数：分隔符个数 + 1（空串为 0）。exact 判定要拿它跟「已吃的组数」比。 */
function countInitialGroups(initials: string): number {
	if (!initials) return 0;
	let groups = 1;
	for (let index = 0; index < initials.length; index += 1) {
		if (initials[index] === GROUP_SEPARATOR) groups += 1;
	}
	return groups;
}

/** 首字母命中分级：3 整名逐字对齐 / 2 前缀逐字对齐 / 1 跳字 / 0 不命中。 */
function initialsKind(initials: string, needle: string): number {
	if (!initials || !needle) return 0;
	let needleIndex = 0;
	let matchedGroups = 0;
	let skippedGroups = 0;
	// 查询字母用完就停：剩下的字只影响 exact 判定（组数从整串数）。
	for (let position = 0; position < initials.length && needleIndex < needle.length; ) {
		const separator = initials.indexOf(GROUP_SEPARATOR, position);
		const group = separator < 0 ? initials.slice(position) : initials.slice(position, separator);
		position = separator < 0 ? initials.length : separator + 1;
		if (group.includes(needle[needleIndex])) {
			needleIndex += 1;
			matchedGroups += 1;
		} else {
			skippedGroups += 1;
		}
	}
	if (needleIndex < needle.length) return 0;
	// 跨过任何一个汉字就不是前缀命中（"lcx" 搜「用量查询」属跳字，不是开头匹配）。
	if (skippedGroups > 0) return 1;
	return matchedGroups === countInitialGroups(initials) ? 3 : 2;
}

/**
 * 拼音通道打分：0 表示不命中。只认纯字母查询 —— 调用方（列表过滤）用
 * `isPinyinQuery` 先判一次，避免对中文/带标点的查询白算一遍。
 */
export function matchPinyin(keys: PinyinKeys | null, query: string): number {
	if (!keys) return 0;
	const needle = query.trim().toLowerCase();
	if (!needle) return 0;
	let best = 0;
	switch (initialsKind(keys.initials, needle)) {
		case 3:
			best = PINYIN_SCORES.exact;
			break;
		case 2:
			best = PINYIN_SCORES.prefix;
			break;
		case 1:
			best = PINYIN_SCORES.skip;
			break;
		default:
			best = 0;
	}
	if (best < PINYIN_SCORES.full && keys.full.includes(needle)) best = PINYIN_SCORES.full;
	return best;
}

/** 组合入口：查询与标题都合适时返回分数，否则 0。 */
export function matchPinyinText(text: string, query: string): number {
	if (!isPinyinQuery(query)) return 0;
	return matchPinyin(pinyinKeys(text), query);
}
