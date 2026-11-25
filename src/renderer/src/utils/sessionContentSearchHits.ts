import { canonicalizeSessionPath } from "../../../shared/sessionIdentity";
import type { SessionRecord, SessionSearchResult } from "../../../shared/types";

/** 正文搜索结果展示所需的单条会话命中（组件只做呈现，映射策略在这里）。 */
export type SessionContentSearchHitView = {
	record: SessionRecord;
	matchCount: number;
	firstMessageId: string;
	snippet: string;
};

/**
 * 会话文件路径的比较键：分隔符归一 + 去尾斜杠，Windows 形态（盘符/UNC）折大小写。
 *
 * 直接复用 catalog 的身份归一规则（shared/sessionIdentity 的 canonicalizeSessionPath），
 * 平台语义由路径形态决定、不依赖渲染层进程信息——catalog 与 sidecar 对同一个文件
 * 可能给出 `C:\x\a.jsonl` / `c:/x/a.jsonl` 两种写法，必须归一到同一个键。
 */
export function sessionFilePathKey(filePath: string): string {
	return canonicalizeSessionPath(filePath, "native");
}

/**
 * 把 session-index sidecar 的正文命中映射回 catalog 记录。
 *
 * 为什么不能写 `records[hit.filePath]`：`SessionRecord.id` 是跨重启稳定的身份
 * （新条目为 UUID），`filePath` 是独立字段，而 `sessionRecordsAtom` 以 id 为键。
 * 历史上这里把 filePath 当 id 当下标取，映射恒为 undefined，所有命中被
 * `filter(Boolean)` 丢掉，侧栏正文结果区块永远不渲染（回归：
 * tests/sessionContentSearchHitMapping.test.mjs）。
 *
 * 没有 filePath 的会话（匿名草稿/DSH）不参与映射；sidecar 降级返回 null 时返回空数组。
 */
export function buildSessionContentSearchHits(result: SessionSearchResult | null, records: Record<string, SessionRecord>): SessionContentSearchHitView[] {
	const recordsByFilePath = new Map<string, SessionRecord>();
	for (const record of Object.values(records)) {
		if (!record.filePath) continue;
		recordsByFilePath.set(sessionFilePathKey(record.filePath), record);
	}
	const hits: SessionContentSearchHitView[] = [];
	for (const hit of result?.sessions ?? []) {
		const record = recordsByFilePath.get(sessionFilePathKey(hit.filePath));
		const first = hit.matches[0];
		if (!record || !first) continue;
		hits.push({
			record,
			// hitCount 是 sidecar 未截断的命中总数；缺省时回退到本页 matches 条数。
			matchCount: hit.hitCount ?? hit.matches.length,
			firstMessageId: first.messageId,
			snippet: first.snippet,
		});
	}
	return hits;
}

/**
 * 命令面板（Ctrl+F）里一个会话项的正文维度（#610）。
 *
 * 面板原本只能按标题/预览命中，点开就只是「打开了会话」——用户搜的是正文里的词，
 * 落点却在会话顶部。这里把正文命中折成三项：
 * - `description`：换成命中片段（比预览更能解释「为什么它会出现在结果里」）；
 * - `keywords`：片段也要参与匹配，否则标题不含这个词的命中会话根本进不了面板；
 * - `jumpMessageId`：打开会话后必须定位到这条消息，有它才算真「命中」。
 *
 * 纯函数（无 DOM/atom 依赖）：面板过滤与点击行为都由它决定，回归见
 * tests/sessionContentSearchHitMapping.test.mjs。
 */
export type SessionSearchItemFields = {
	description?: string;
	keywords: string[];
	jumpMessageId?: string;
};

export function sessionSearchItemFields(preview: string | undefined, hit: SessionContentSearchHitView | undefined): SessionSearchItemFields {
	if (!hit) return { description: preview, keywords: [] };
	const snippet = hit.snippet.trim();
	return {
		description: snippet || preview,
		// 片段单独进 keywords：标题不含查询词时，筛选项仍然留得下这个会话
		keywords: snippet ? [snippet] : [],
		jumpMessageId: hit.firstMessageId,
	};
}
