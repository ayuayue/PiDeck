/**
 * 跳转「补读单条」的 meta 键。
 *
 * 一处可写：主进程注入时写它（sessionMessageReadIpc 的 readPageAroundEntry），
 * 渲染层挑锚点时读它（jumpTarget 的 pickJumpAnchorEntryId）。两处各自写字面量
 * 就是第二处真值——改一边忘另一边，症状是「点中间条目、画面滚到会话底部」。
 */
export const JUMP_INJECTED_ANCHOR_META_KEY = "jumpInjectedAnchor";

/**
 * 这条消息是不是主进程**补读注入**的单条。
 *
 * 判据：页窗口里没有它（被 active branch 排除的 error / aborted 条目），
 * 但它在会话文件里、搜索能命中它。它不属于任何 agent-run，拿它当跳转锚点会让
 * 轮窗口的 findAgentRunIndexByItemId 返回 -1，窗口退回有界尾部。
 */
export function isJumpInjectedAnchorMeta(meta: unknown): boolean {
	if (meta === null || typeof meta !== "object") return false;
	return (meta as Record<string, unknown>)[JUMP_INJECTED_ANCHOR_META_KEY] === true;
}

/**
 * 把「投影 id」还原成「文件条目 id」。
 *
 * 为什么必须有：会话内查找交出来的 messageId 是 ChatMessage.id，也就是投影器生成的
 * agentId + "-history-" + entryId（可能还带前导下划线），而索引的 key 是文件里那一行的顶层 id。
 * 不剥前缀，entries.get() 永远 miss → 报「这条不在当前会话」，而它明明就在。
 * 反例（2026-11-25 实测）：搜索第 1 条给 _viewer-history-731cee61，entries 里有 731cee61，
 * 命中率 0；已加载的第 1 条能跳，是因为渲染层按 meta.entryId 匹配，绕过了这一层。
 */
export function stripProjectionPrefix(raw: string): string {
	const marker = "-history-";
	const at = raw.lastIndexOf(marker);
	if (at < 0) return raw;
	const tail = raw.slice(at + marker.length);
	return tail.length > 0 ? tail : raw;
}
/**
 * 取页结果里是否**已经**含目标条目。
 *
 * 反例（2026-11-25 真机，只发一条显示两条）：查找面板交来的是投影 id
 * （_viewer-history-1388e1fa / agentId-history-1388e1fa），而页里的 meta.entryId 是裸
 * entryId 1388e1fa。直接比字符串 → 判「页里没有」→ 触发补读单条并插到页首 →
 * 同一条消息在时间线里出现两份（搜索面板 57 / 58 两条一模一样）。
 *
 * 判定收在一处：调用方与页内条目都先剥投影前缀，再比。
 */
/**
 * 两个 id 是否指同一条消息（键归一后比较）。
 *
 * 一处可写：主进程判「页里有没有目标」（pageHasTargetEntry）、渲染层判「数据里有没有目标」
 * （jumpTarget.resolveJumpMessageIndex）都必须走这里。各写一套的后果是「主进程说页里有、
 * 渲染层说数据里没有」—— 中间那段就是用户看到的空白（2026-11-26 真机：merged=138、
 * pageHasTarget=true，而渲染层 stillInData=false，随后干等 120 帧再报「没有更早的页」）。
 */
/**
 * 合并去重用的键：与 sameJumpEntry 同一套归一（meta.entryId 优先，剥投影前缀）。
 *
 * 两处各算一套键的症状（2026-11-26 真机）：merge pageMessages=36 merged=138 visibleBefore=138
 * pageHasTarget=true —— 页里 36 条一条都没新增，目标却仍认不出。
 */
export function readJumpEntryId(meta: unknown): string | undefined {
	if (meta === null || typeof meta !== "object" || !("entryId" in meta)) return undefined;
	return typeof meta.entryId === "string" && meta.entryId.length > 0 ? stripProjectionPrefix(meta.entryId) : undefined;
}

export function jumpEntryKey(message: { id: string; meta?: unknown }): string {
	return readJumpEntryId(message.meta) ?? stripProjectionPrefix(message.id);
}
export function sameJumpEntry(a: string, b: string): boolean {
	return Boolean(a && b) && (a === b || stripProjectionPrefix(a) === stripProjectionPrefix(b));
}

/** 精确显示ID优先；文件条目ID跨 viewer、runtime 重投影保持稳定。 */
export function matchesJumpMessage(message: { id: string; meta?: unknown }, targetId: string): boolean {
	return Boolean(targetId) && (message.id === targetId || sameJumpEntry(jumpEntryKey(message), targetId));
}

/** 搜索、取页、合并与DOM定位共用同一套身份优先级，不按正文或时间猜身份。 */
export function resolveJumpMessageIndex(messages: ReadonlyArray<{ id: string; meta?: unknown }>, targetId: string): number {
	if (!targetId) return -1;
	const direct = messages.findIndex((message) => message.id === targetId);
	return direct >= 0 ? direct : messages.findIndex((message) => matchesJumpMessage(message, targetId));
}

export function pageHasTargetEntry(messages: ReadonlyArray<{ id: string; meta?: unknown }>, rawEntryId: string): boolean {
	return resolveJumpMessageIndex(messages, rawEntryId) >= 0;
}
/**
 * 把「补读单条」按时间插回它该在的位置。
 *
 * 旧实现固定插页首。目标被 compaction 移出活动分支时，它往往**比整页都晚**（页取的是它附近
 * 更早的一段），插到页首就是逆序 —— 用户看到最新一条跑到时间线最上面（2026-11-25 真机
 * 「我的条目怎么直接错乱了」）。
 *
 * 判据：插到「第一个比它晚的条目」之前；都比它早就追加到末尾。没有时间戳可比的条目
 * 视为**不阻挡**（它通常是乐观插入项，本来就该排在可见消息之后）。
 */
export function insertByTimestamp<T extends { timestamp?: number }>(messages: readonly T[], single: T): T[] {
	const ts = typeof single.timestamp === "number" && Number.isFinite(single.timestamp) ? single.timestamp : undefined;
	if (ts === undefined) return [single, ...messages];
	const at = messages.findIndex((message) => {
		const other = message.timestamp;
		return typeof other === "number" && Number.isFinite(other) && other > ts;
	});
	if (at < 0) return [...messages, single];
	return [...messages.slice(0, at), single, ...messages.slice(at)];
}
/**
 * 把「补读单条」按**文件序号**插回它该在的位置。
 *
 * 为什么不能按 timestamp：pi 的 `message.timestamp` 是「请求开始时刻」，同一轮里会倒退。
 * 实测（2026-11-26，真机会话窗口末 6 条）：`…927595` 之后紧跟 `…902597`，倒退 25 秒。
 * `insertByTimestamp` 于是把目标插到了页首 —— 用户看到「点倒数第二条，跳到最上面」，
 * 界面提示 `{data=109 target=0 page=exact}`（目标在已加载数组第 0 位）。
 *
 * 序号来自 `readEntryIndex`（按文件顺序重编的消息序号），与 JSONL 的写入顺序一致，
 * 是这套数据里唯一可靠的「位置真值」。
 *
 * 判据：目标序号落在页区间内 → 插到第一个序号更大的条目之前；比整页都靠后 → 追加末尾；
 * 比整页都靠前 → 插到首位。没有序号可比时（索引里查不到）退化成追加末尾，不猜首位。
 */
export function insertByOrdinal<T extends { meta?: unknown }>(messages: readonly T[], single: T, ordinalOf: (message: T) => number | undefined, singleOrdinal: number | undefined): T[] {
	if (singleOrdinal === undefined) return [...messages, single];
	const at = messages.findIndex((message) => {
		const ordinal = ordinalOf(message);
		return ordinal !== undefined && ordinal > singleOrdinal;
	});
	if (at < 0) return [...messages, single];
	return [...messages.slice(0, at), single, ...messages.slice(at)];
}
