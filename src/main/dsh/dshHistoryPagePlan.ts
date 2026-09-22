/**
 * DSH 历史分页的「轮数 → 消息数」换算策略（纯函数，供 DshAgentManager 与单测共用）。
 *
 * 背景（2026-09 定位）：渲染层与 pi 磁盘分页共享同一契约 —— 分页接口第三个参数是
 * **轮数**（渲染层「加载更多对话」送 3 = RUNTIME_HISTORY_TURN_PAGE_SIZE，首屏送 9，
 * 主进程 pi 侧 SessionHistoryReader.MAX_TURN_PAGE_SIZE = 10 是同一语义的上界）。
 * DSH 后端曾把该值当 maxMessages 直接透传给 host，而 host 的 session/page 以
 * **消息事件数** 计数（MESSAGE_TYPES = user/message | assistant/message，
 * 默认 DEFAULT_MAX_MESSAGES = 50，见 @deepseek-ai/.dsh-host-apiproxy 的 paginate）。
 * 单位错配的结果：「加载更多对话」每点一次只前进 3 条消息（稀疏会话里约 1/6 轮），
 * 页内甚至可能一条 user 消息都没有，用户必须连点很多次才看到更早的内容。
 *
 * 实测口径（~/.dsh/sessions 12 个会话 / 84 轮）：
 *  - 每条消息事件伴随 4.3~8.9 条日志记录（p50 5.8，均值 6.2）；
 *  - 每轮消息事件数 p50 = 2、p90 = 25、max = 157（均值 8.9）。
 * 因此换算系数取 24（≈ p90 轮大小），再对单轮请求量与单页总量设上下界：
 *  - 单轮至少 MIN_ROUND_MESSAGES：保证稀疏会话一次点击就能拿到可见的一段历史；
 *  - 单页总量不超过 MAX_PAGE_MESSAGES：单条 IPC 回包 / 渲染层 prepend 的字节上界
 *    （消息里可能带图片引用，见 imagegen blob 协议）。
 */

/** 轮数上界：与 pi 的 SessionHistoryReader.MAX_TURN_PAGE_SIZE 对齐，防渲染层送来离谱值。 */
export const DSH_HISTORY_TURN_PAGE_LIMIT = 10;

/** 轮数缺省值：与 pi 的 SessionHistoryReader.DEFAULT_TURN_PAGE_SIZE 对齐。 */
export const DSH_HISTORY_DEFAULT_TURN_PAGE_SIZE = 3;

/** 每轮历史平均占用的消息事件数预算（实测 p90 ≈ 25，取 24 略保守）。 */
export const DSH_HISTORY_MESSAGES_PER_TURN = 24;

/** 单轮请求下界：稀疏会话下也要凑出「可见的一屏」，避免又回到「3 条消息一页」。 */
export const DSH_HISTORY_MIN_ROUND_MESSAGES = 60;

/** 单轮请求上界：控制单次 host RPC 的返回体量。 */
export const DSH_HISTORY_MAX_ROUND_MESSAGES = 120;

/** 单次翻页最多几轮补取（host 是本地进程，单轮耗时通常 <200ms）。 */
export const DSH_HISTORY_MAX_ROUNDS = 3;

/** 单页消息事件总量上界：轮数需求很大时也不允许无限放大回包。 */
export const DSH_HISTORY_MAX_PAGE_MESSAGES = 240;

/**
 * 分页窗口里的一条历史事件（host session/page 的 records 投影结果）。
 * 字段刻意声明为 unknown：宿主下行事件是 Record<string, unknown>（见 DshHistoryEntry），
 * 这里只做结构最小约定，避免两侧类型互相绑架，也让单测能用字面量造桩。
 */
export type DshHistoryEventEntry = {
	event: { type?: unknown; seq?: unknown };
	view?: unknown;
};

/** 取事件 seq（非数字/缺失 → undefined）：游标与排序都只信任数字 seq。 */
function seqOf(entry: DshHistoryEventEntry): number | undefined {
	const seq = entry.event.seq;
	return typeof seq === "number" && Number.isFinite(seq) ? seq : undefined;
}

/** 与 host MESSAGE_TYPES 同源：分页计数单位（用户/助手消息）。 */
export function isDshMessageEventType(type: unknown): boolean {
	return type === "user/message" || type === "assistant/message";
}

/**
 * 归一化渲染层送来的轮数：非数字/非法值回退缺省值，并夹到 [1, TURN_PAGE_LIMIT]。
 * 渲染层数据一律不可信（IPC 边界校验）。
 */
export function normalizeDshTurnPageSize(pageSize: unknown): number {
	const value = typeof pageSize === "number" && Number.isFinite(pageSize) ? Math.floor(pageSize) : DSH_HISTORY_DEFAULT_TURN_PAGE_SIZE;
	if (value < 1) return 1;
	return Math.min(value, DSH_HISTORY_TURN_PAGE_LIMIT);
}

/**
 * 把「想要几轮」换成「每轮向 host 要多少条消息、最多要几轮」。
 *
 * 单轮请求量 = clamp(轮数 × 24, 60, 120)，按单页总量上限 240 铺满、最多 3 轮；
 * 调用方每轮结束后只要凑够 user 轮数或 host 报 hasMore=false 就提前收手，
 * 所以正常会话（每轮 2~9 条消息）通常一轮就返回，只有超长轮才会走满 3 轮。
 */
export function planDshHistoryRounds(turnCount: number): number[] {
	const normalizedTurns = normalizeDshTurnPageSize(turnCount);
	const roundSize = Math.min(DSH_HISTORY_MAX_ROUND_MESSAGES, Math.max(DSH_HISTORY_MIN_ROUND_MESSAGES, normalizedTurns * DSH_HISTORY_MESSAGES_PER_TURN));
	const rounds: number[] = [];
	let total = 0;
	while (rounds.length < DSH_HISTORY_MAX_ROUNDS && total < DSH_HISTORY_MAX_PAGE_MESSAGES) {
		const size = Math.min(roundSize, DSH_HISTORY_MAX_PAGE_MESSAGES - total);
		rounds.push(size);
		total += size;
	}
	return rounds;
}

/** 统计一段事件里的 user/message 条数（≈ 轮数），用于判断「够了没」。 */
export function countDshUserMessages(entries: readonly DshHistoryEventEntry[]): number {
	// 注：这里按事件类型计数，不额外过滤 host 的 append-surface 语义——重放副本只会
	// 让「凑够轮数」提前满足，不影响分页正确性（游标始终由 seq 决定）。
	let count = 0;
	for (const entry of entries) {
		if (entry.event.type === "user/message") count += 1;
	}
	return count;
}

/** 合并多轮补取结果：契约防御（丢弃 seq ≥ beforeSeq 的事件）+ 按 seq 去重 + 升序。 */
export function assembleDshHistoryEntries<T extends DshHistoryEventEntry>(batchesNewestFirst: readonly (readonly T[])[], beforeSeq: number | undefined): { entries: T[]; droppedByContract: number } {
	const seen = new Set<number>();
	const merged: T[] = [];
	let droppedByContract = 0;
	// 从最旧的一批开始放入：sort 稳定，缺 seq 的异常事件也能保持批内原始顺序。
	for (const batch of [...batchesNewestFirst].reverse()) {
		for (const entry of batch) {
			const seq = seqOf(entry);
			if (seq !== undefined) {
				// beforeSeq 是排除边界（host 只应返回 seq < beforeSeq）：越界事件会让游标
				// 原地打转（渲染层再点一次拿到同一页），宁可丢弃并计数据日志。
				if (beforeSeq !== undefined && seq >= beforeSeq) {
					droppedByContract += 1;
					continue;
				}
				if (seen.has(seq)) continue;
				seen.add(seq);
			}
			merged.push(entry);
		}
	}
	merged.sort((left, right) => (seqOf(left) ?? 0) - (seqOf(right) ?? 0));
	return { entries: merged, droppedByContract };
}

/**
 * 把页首对齐到「本页最旧的 turn/start」。
 *
 * host 的分页切点是「消息组起点」（paginate 用 sourceEventSeqs 保证不切在消息中间），
 * 因此一页可能从上一轮的中间开始：那段不完整的轮会在下一次点击时重新取到（nextBefore
 * 指向裁剪后的起点，host 只返回 seq < nextBefore），所以裁剪不会丢事件，只是让每页
 * 从完整轮开始，与 pi 的轮对齐分页观感一致。
 *
 * 只在 hasMore 时裁剪：hasMore=false 说明本页已含会话最开头，裁掉的就是真正的前言。
 */
export function trimToOldestTurnStart<T extends DshHistoryEventEntry>(entries: readonly T[], hasMore: boolean): T[] {
	if (!hasMore) return [...entries];
	// 事件按 seq 升序：第一个 turn/start 即本页最旧的轮起点。老日志（v0）可能没有
	// turn/start 事件，此时保持 host 的消息组对齐切点，不做更激进的裁剪。
	const index = entries.findIndex((entry) => entry.event.type === "turn/start");
	if (index <= 0) return [...entries];
	return entries.slice(index);
}
