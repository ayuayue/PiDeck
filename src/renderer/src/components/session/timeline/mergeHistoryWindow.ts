import { jumpEntryKey } from "../../../../../shared/sessionJumpAnchor";
/**
 * 跨段消息合并：**顺序与身份的唯一真值都是 entryId（JSONL 文件顺序与 id）**。
 *
 * 三次真机事故把这条写进了本文件：
 *
 * ① 「最新一条跑到时间线最上面」（2026-11-25/26，rectTop=-3113）
 *    曾用 timestamp 做逆序校正。但 pi 的 message.timestamp 是**请求开始时刻**，同一轮里
 *    user → assistant → toolResult → assistant 可以倒退（实测相邻两条差 -25s）。改成不排序。
 *
 * ② 「点倒数第二条跳到最上面」（2026-11-26，`{data=109 target=0 page=exact}`）
 *    补读单条曾固定插页首 / 按时间插。现在按文件序号插（见 sessionJumpAnchor.insertByOrdinal）。
 *
 * ③ 「跳过去上下文都没了」（2026-11-26 13:03，694 轮会话）
 *    `jump/merge {pageMessages: 146, merged: 467, visibleBefore: 467}` —— 页里 146 条一条没进，
 *    目标是其中一条，于是 `foundIndex=-1`、反复取同一页、`give-up no-earlier-pages`。
 *    成因是内容兜底（按 role+text+时间猜身份）在真实数据上大面积误判：toolResult 文本大量相同，
 *    而窗口里缺 entryId 的项远不止「刚发的那 1~2 条」，于是页里的新消息被当成「窗口已有」吞掉。
 *
 * 结论：**猜身份一律删掉**。去重只按 entryId（缺省回退 id）。代价是刚发出、还没回写 entryId 的
 * live 消息有可能多出一份重复气泡 —— 那是可见、可再迭代的问题；而吞掉 146 条是不可见的信息丢失。
 * 宁可多一条重复，不能少一条内容。
 */
export interface MergeableMessage {
	id: string;
	/** 只关心 entryId，其余字段（i18n 描述符等）不看：收窄成 unknown 才能直接吃 ChatMessage。 */
	meta?: unknown;
	/** 消息时间戳（ms）。**不参与排序与去重**，仅保留给调用方展示。 */
	timestamp?: number;
	role?: string;
	text?: string;
	/** 思考正文。同键两条时用来判「哪一份更全」：丢内容是不可见的信息丢失。 */
	thinking?: string;
}

/** 与定位、取页共用身份键；投影缺少meta时仍能认出相同文件条目。 */
export function messageIdentityKey(message: MergeableMessage): string {
	return jumpEntryKey(message);
}

/** 内容量：正文 + 思考的字符数。只用于「同键时留哪一份」，不参与顺序。 */
function contentWeight(message: MergeableMessage): number {
	return (message.text?.length ?? 0) + (message.thinking?.length ?? 0);
}

/**
 * 同键两条 → 留内容更全的那一份。
 *
 * 反例（2026-11-26 真机「会话思考不见了」）：窗口里那条是同一次运行的事件快照（正文有、
 * 思考还没回填），磁盘页里同 entryId 那条带完整 thinking。旧实现一律保留窗口版本 →
 * 思考正文被静默丢掉，界面上那一轮只剩空思考行。
 *
 * 只在「另一侧更全」时才换，其余走原路径返回原引用 —— 引用稳定是流式性能的前提。
 */
function richerOf<T extends MergeableMessage>(a: T, b: T): T {
	// b 是当前窗口那一份，默认留它（引用稳定）；只有 a 内容**严格更全**时才换。
	return contentWeight(a) > contentWeight(b) ? a : b;
}

/**
 * 前缀（首屏历史）与运行时窗口的拼接。
 *
 * 重叠只能落在交界处：从第一个重叠项开始整体交接给窗口。逐个过滤会把窗口外的较早项
 * 留到末尾 —— 反例（2026-11-25 真机）：历史 [19:50 提问, 19:56 回复]、窗口首条与历史重复时，
 * 过滤后成了 [19:56 回复, 21:10, 19:50 提问]，时间线直接乱序。
 */
/**
 * 用「另一侧同键且更全」的版本替换窗口项。
 *
 * 返回 undefined = 一条都不用换（调用方可以原样返回窗口引用，保住流式期的引用稳定性）；
 * 返回数组 = 换了至少一条，引用必然变，这是内容更新的必要代价。
 */
function patchWindowWithRicher<T extends MergeableMessage>(richerSide: readonly T[], window: readonly T[]): T[] | undefined {
	const byKey = new Map<string, T>();
	for (const message of richerSide) {
		const key = messageIdentityKey(message);
		if (!byKey.has(key)) byKey.set(key, message);
	}
	let changed = false;
	const patched = window.map((message) => {
		const candidate = byKey.get(messageIdentityKey(message));
		if (!candidate) return message;
		const winner = richerOf(candidate, message);
		if (winner === message) return message;
		changed = true;
		return winner;
	});
	return changed ? patched : undefined;
}
export function mergeHistoryAndWindow<T extends MergeableMessage>(history: readonly T[], window: readonly T[]): T[] {
	if (history.length === 0) return window as T[];
	if (window.length === 0) return history as T[];
	const inWindow = new Set(window.map(messageIdentityKey));
	const firstOverlap = history.findIndex((message) => inWindow.has(messageIdentityKey(message)));
	// 乘接之前先补齐内容：同一条两处都有时，留思考/正文更全的那份。
	// 反例（2026-11-26「会话思考不见了」）：窗口那份是运行事件快照，thinking 还没回填，
	// 而历史那份带完整 thinking —— 旧实现直接把历史那份判为「已存在」丢掉。
	// 一条都不用换时返回 undefined，下面的原引用返回照旧生效。
	const patched = patchWindowWithRicher(history, window);
	// 最常见情形：前缀整段都被窗口覆盖。此时**返回窗口原引用** —— 每次都 concat 新数组会让
	// 下游 useMemo / jotai 的相等判断失效，输入没变也重算整条时间线（真机：流式时不实时刷新）。
	if (firstOverlap === 0) return (patched ?? (window as T[])) as T[];
	const tail = patched ?? (window as T[]);
	return firstOverlap < 0 ? (history as T[]).concat(tail) : (history.slice(0, firstOverlap) as T[]).concat(tail);
}

/**
 * 交错两段合并：页是「目标附近的一段」，可能与窗口交错，因此不能整体交接（会丢项）。
 *
 * 定位规则：页里那些窗口没有的新项，插到「它在页里后面第一个重叠项」在窗口中的位置之前；
 * 页里后面没有任何重叠项的新项追加到末尾（保守：不知道位置就不猜）。
 *
 * 反例（2026-11-26 09:32 真机，点刻度第 2973 条）：页 128 条里 127 条与窗口重复，
 * 只有目标 1 条是新的。旧实现把它排在数组首位 → 渲染在文档 150px 处
 * （`jump/settle rectTop=-64 scrollTop=214`、`jump/entry foundIndex=0`）。
 */
export function mergeInterleavedHistory<T extends MergeableMessage>(earlier: readonly T[], later: readonly T[]): T[] {
	if (earlier.length === 0) return later.slice();
	if (later.length === 0) return earlier.slice();

	const windowIndex = new Map<string, number>();
	later.forEach((message, index) => {
		const key = messageIdentityKey(message);
		if (!windowIndex.has(key)) windowIndex.set(key, index);
	});

	// 每个新项的锚点 = 它在 earlier 里后面第一个「窗口也有」的项在窗口中的下标。
	const insertBefore = new Map<number, T[]>();
	const appended: T[] = [];
	let nextAnchor: number | undefined;
	for (let index = earlier.length - 1; index >= 0; index -= 1) {
		const message = earlier[index];
		const located = windowIndex.get(messageIdentityKey(message));
		if (located !== undefined) {
			nextAnchor = located;
			continue;
		}
		if (nextAnchor === undefined) {
			appended.unshift(message);
			continue;
		}
		const bucket = insertBefore.get(nextAnchor);
		if (bucket) bucket.unshift(message);
		else insertBefore.set(nextAnchor, [message]);
	}
	// 同键时同样要补齐内容：页里那份常带完整 thinking，窗口那份是事件快照。
	// 漏换一处，合并结果就是「位置对、内容缺」—— 用户看到思考整段不见。
	const windowWithRicher = patchWindowWithRicher(earlier, later) ?? (later as T[]);
	const merged: T[] = [];
	windowWithRicher.forEach((message, index) => {
		const before = insertBefore.get(index);
		if (before) merged.push(...before);
		merged.push(message);
	});
	// 追加段去重：earlier 里同一条出现多次（同 id）时只留一份。
	const seen = new Set(merged.map(messageIdentityKey));
	for (const message of appended) {
		const key = messageIdentityKey(message);
		if (seen.has(key)) continue;
		seen.add(key);
		merged.push(message);
	}
	return merged;
}
