/**
 * 重发/编辑 fork 化替换（supersededBy）后的会话解析。
 *
 * 背景：尾部重发或编辑会 fork 出新会话接替旧会话，旧记录打 `supersededBy` 标记，
 * 会话列表按该标记过滤（旧的 JSONL 文件保留，随时可恢复）。但列表之外还有别的入口会
 * 按 sessionId 找会话——残留的标签页、活动记录、缓存里的焦点会话、外部桥（飞书等）。
 * 这些入口拿到旧 id 时，若照常激活，就会给"已被接替"的会话重新拉起进程；侧栏除了会话行
 * 还会按活着的进程画活动行，于是同一标题出现两行（2026-11 实测：列表里两个「同步组2」，
 * 一个是 `dd3c4ec5`（supersededBy 指向 `33e033d2`），一个是 `33e033d2`）。
 *
 * 这里的职责只有一件：把旧 id 换成接替者 id，让调用方先在正确会话上工作。
 * 换不过去（环、接替者不存在、链太长）就返回 undefined —— 宁可维持原样，也不猜。
 */

/** 只读的目录查询口：只要能用 id 取到 `supersededBy` 就够，避免与 SessionCatalog 耦合。 */
export type SupersededLookup = (sessionId: string) => { supersededBy?: string | undefined } | undefined;

/**
 * 沿 `supersededBy` 链找到最终接替者。
 *
 * 返回 undefined 的四种情况（都按"不需要重定向"处理）：
 * - 起点本身没有被接替；
 * - 链成环（A→B→A）；
 * - 链在 maxHops 步内没走完（防御异常数据，不替用户猜终点）；
 * - 终点的接替者条目不存在（catalog 被并发清理）。
 */
export function resolveSupersededSessionId(sessionId: string, lookup: SupersededLookup, maxHops = 8): string | undefined {
	if (!sessionId) return undefined;
	const visited = new Set<string>([sessionId]);
	let current = sessionId;
	for (let hop = 0; hop < maxHops; hop += 1) {
		const next = lookup(current)?.supersededBy;
		if (!next || next === current) break;
		// 环：A→B→A 这类数据说明标记被污染，重定向只会让调用方在两处之间来回跳。
		if (visited.has(next)) return undefined;
		visited.add(next);
		current = next;
	}
	if (current === sessionId) return undefined;
	// 终点自己也带着标记 = 链没走完（超过 maxHops），同样不重定向。
	const terminal = lookup(current);
	if (!terminal || terminal.supersededBy) return undefined;
	return current;
}
