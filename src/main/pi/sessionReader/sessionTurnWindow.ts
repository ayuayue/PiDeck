/**
 * 轮次分页的窗口算术：轮起点识别、空页不变量、游标解析与条目预算叠加。
 *
 * 全是纯函数（只依赖条目切片本身），宿主 `SessionHistoryReader` 用它把「最近 N 轮」
 * 落成文件下标区间。页边界对齐完整轮次是这里的核心不变量：切半个回答、返回空页
 * 都会让上滚翻页静默停住，所以规则集中在这一个模块里，别处不要另算一遍。
 */

/**
 * 轮次分页起点计算（纯函数，2026-08 激活分页）。
 *
 * 业界 turn 定义（发言权周期）：一轮 = 用户连续发言（可连发多条 user）→
 * AI 回应周期（assistant/tool/thinking 任意组合，直到下一条用户发言）。
 * 因此 turn 起点 = role==="user" 且「跳过中间的杂项消息（system/error/卡片）后，
 * 前一条真实消息不是 user」——连发 user 只有第一条是起点，其余并入同一轮；
 * 纯 user 无回复的会话整体算一轮（用户还没拿到回应，发言权未交还）。
 * 页边界永远对齐完整轮（折叠不会被切成半个回答）。
 *
 * 2026-09 统一轮次协议：页大小只以轮数计，不做字节裁剪
 *（用户看历史就是要看完整一轮，不静默丢内容）。
 *
 * 注：轮数窗口无法限制单轮体量。需要「一次最多多少条」的硬上限时
 * 在本函数之上再叠 boundTurnWindowStart（#213）。
 */
export function findTurnPageStart(entries: ReadonlyArray<{ role?: string; byteLength: number }>, before: number, turnCount: number): number {
	if (before <= 0 || turnCount < 1) return 0;
	// 预扫描 turn 起点（一次遍历，规则见上方注释）：
	// 起点 = user 且其前最近的 user/assistant 边界不是 user。
	const turnStartFlags = new Array<boolean>(before).fill(false);
	let prevUserOrAssistantRole: "user" | "assistant" | undefined;
	for (let i = 0; i < before; i += 1) {
		const role = entries[i].role;
		if (role === "user") {
			// 连发 user：只有前一条是 assistant（或无实质消息）时才算新轮起点。
			if (prevUserOrAssistantRole !== "user") turnStartFlags[i] = true;
			prevUserOrAssistantRole = "user";
		} else if (role === "assistant") {
			prevUserOrAssistantRole = "assistant";
		}
		// system/error/toolResult 等其他 role：不改变边界（发言权仍归上一方）。
	}

	// 从 before-1 向前数第 turnCount 个 turn 起点
	let turnsSeen = 0;
	let start = 0;
	for (let i = before - 1; i >= 0; i -= 1) {
		if (!turnStartFlags[i]) continue;
		turnsSeen += 1;
		if (turnsSeen === turnCount) {
			start = i;
			break;
		}
	}
	// 不足 turnCount 轮：从会话头起（开头的 system/碎片消息归入首轮）
	if (turnsSeen < turnCount) start = 0;
	// 起点之前已无 user 消息（落在首个轮次起点）：开头碎片并入本页，避免碎片单独成页
	else {
		let hasEarlierUser = false;
		for (let i = 0; i < start; i += 1) {
			if (entries[i].role === "user") {
				hasEarlierUser = true;
				break;
			}
		}
		if (!hasEarlierUser) start = 0;
	}
	return start;
}

/**
 * 空页不变量：只要有更早历史（before > 0），窗口起点就必须严格小于 before。
 *
 * 违反它的后果不是「少显示一条」而是死循环：slice(start, before) 得空数组，而 nextBefore
 * 仍等于 before —— 渲染层收到空页照样 prepend、把游标设成同一个值，界面逐字不变、无限重试、
 * 完全静默（#474 记录的第二条「点了没反应」路径，修法在 main 侧）。
 */
export function clampTurnWindowStart(start: number, before: number): number {
	if (before <= 0) return 0;
	return Math.min(start, before - 1);
}

/**
 * 解析翻页游标，返回 null 表示「明确没有更早历史」，调用方必须回空页 + nextBefore: null。
 *
 * beforeEntryId 是渲染层唯一的对齐锚点（运行时窗口与 JSONL 是两个下标空间）。它解析失败
 * 且没有数值游标时，旧写法让游标落回 total（文件尾部），表现是「点加载更多反而跳回最新」，
 * 比原地踏步更糟（#474 记录）。这里改成显式失败，让界面停下来而不是反向跳。
 */
export function resolveTurnPageBefore(before: number | undefined, beforeEntryId: string | undefined, entries: ReadonlyArray<{ id: string }>, total: number): number | null {
	let resolved = before;
	if (beforeEntryId) {
		const position = entries.findIndex((entry) => entry.id === beforeEntryId);
		if (position >= 0) resolved = position;
		else if (!Number.isSafeInteger(resolved)) return null;
	}
	if (!Number.isSafeInteger(resolved)) return total;
	return Math.min(Math.max(0, resolved as number), total);
}

/** 收集 [0, before) 内的 turn 起点下标（升序），规则与 findTurnPageStart 一致。 */
export function collectTurnStartIndices(entries: ReadonlyArray<{ role?: string; byteLength: number }>, before: number): number[] {
	const starts: number[] = [];
	let prevUserOrAssistantRole: "user" | "assistant" | undefined;
	for (let i = 0; i < before; i += 1) {
		const role = entries[i].role;
		if (role === "user") {
			// 连发 user：只有前一条是 assistant（或无实质消息）时才算新轮起点。
			if (prevUserOrAssistantRole !== "user") starts.push(i);
			prevUserOrAssistantRole = "user";
		} else if (role === "assistant") {
			prevUserOrAssistantRole = "assistant";
		}
	}
	return starts;
}

/**
 * 在「最近 N 轮」窗口上再叠一层条目预算（纯函数，2026-08 #213）。
 *
 * 为什么需要：轮数窗口限制不了单轮体量。上下文超限后的极端会话里一轮可以塞进上千条
 * 工具/思考条目，于是「12 轮」= 2000+ 条消息，一次读盘 + 投影 + 全量 IPC 下发就把
 * 渲染进程推到 OOM（#213：压缩失败后重载同一窗口，2162 条 payload）。
 *
 * 语义：从尾部向前并入**完整轮次**，累计条目数将超过 maxEntries 就停在已并入的最早轮起点。
 * 因此页边界仍然对齐轮次（不会切半个回答），预算只决定「一次展示多少轮」——
 * 更早历史依然能通过翻页读回，不静默丢内容。
 *
 * 边界：
 * - 至少保留最后一轮：单轮自身超预算也必须返回该轮起点，否则会返回空页/翻页死锁。
 * - 无 user 轮次边界（纯 assistant/system 片段）：不裁剪，退回轮数窗口结果。
 * - maxEntries 非有限值或 <= 0 = 未启用预算，行为与 findTurnPageStart 完全一致。
 */
export function boundTurnWindowStart(entries: ReadonlyArray<{ role?: string; byteLength: number }>, before: number, turnCount: number, maxEntries: number): number {
	const turnStart = findTurnPageStart(entries, before, turnCount);
	if (!Number.isFinite(maxEntries) || maxEntries <= 0) return turnStart;
	if (before - turnStart <= maxEntries) return turnStart;
	const starts = collectTurnStartIndices(entries, before);
	if (starts.length === 0) return turnStart;
	// 兜底 = 最后一轮起点（单轮超预算时也只能整轮保留，不能返回空页）。
	let bounded = starts[starts.length - 1];
	for (let i = starts.length - 1; i >= 0; i -= 1) {
		// 越过轮数窗口上界：不再向更早扩，保留轮数语义。
		if (starts[i] < turnStart) break;
		// 并入这一轮会突破预算：停在上一次已并入的起点。
		if (before - starts[i] > maxEntries) break;
		bounded = starts[i];
	}
	return bounded;
}
