import { matchesJumpMessage } from "../../../../../shared/sessionJumpAnchor";

/**
 * 时间线 turn 挂载窗口：控制「画多少 TurnRow」。
 * - 贴底跟随：只挂尾部 N 轮（TIMELINE_MOUNTED_TURN_LIMIT），流式期间 DOM 最小。
 * - 上滚查看历史：从尾部小窗口起步，按 3 轮 cohort 渐进展开，
 *   并在窗口前留「显示更早」按钮 —— 历史全量挂载是渲染进程内存峰值/黑屏的来源
 *   （2026-08 治理：此前上滚 = 取消跟随 = 全量放开，大会话可一次挂载近千条消息）。
 * 与主进程 runtime 缓存（12 轮）正交：runtime atom 常驻尾部 9 轮窗口段，
 * DOM 只从尾部 3 轮开始按 3 轮 cohort 渐进挂载。
 */

/** 贴底时最多挂载的 agent-run 轮数。 */
export const TIMELINE_MOUNTED_TURN_LIMIT = 3;

/**
 * 跳转锚点窗口：目标**上下各**挂多少轮。
 *
 * 不设成小数字的原因不是「多挂好看」，而是可滚动的必要条件：内容高度必须超过视口，
 * 否则 scrollTop 写不进去（浏览器钳位），落位纠偏就无从收敛。每轮约 300-900px，
 * 6 轮 × 2 = 12 轮 ≈ 3600-10000px，够任何视口。
 * 取 6 而不是 20：一次跳转的挂载量仍是「屏的几倍」而不是「整份会话」，代价可控。
 */
export const JUMP_WINDOW_RUNS_EACH_SIDE = 6;
/**
 * 跳转窗口半径上限。
 *
 * 锚点窗口是**固定半径**的切片，而扩窗（expandWindowBatched）改的是
 * scrolledWindowTurns —— 有锚点时那条路径完全不生效。于是「目标在数据里但不在
 * 锚点窗口内」时，扩窗动作一次都改变不了窗口，只能干等到超时
 * （2026-11-25 数学组2：等待循环按节拍扩窗 3 次，窗口一直是 12 轮）。
 * 所以半径必须能跟着扩窗预算一起长，且有上界：40 轮 ≈ 屏的二十倍，再多就是整表挂载。
 */
export const JUMP_WINDOW_RUNS_MAX = 40;
/** 上滚查看历史时的基础渲染窗口轮数：与贴底同为 3，避免脱离贴底瞬间挂载隐藏历史。 */
export const TIMELINE_SCROLLED_TURN_LIMIT = 3;
/** 本地 DOM 扩窗 / 数据翻页的统一 cohort 大小；主进程 12 轮 = atom 9 轮 + 一页 3 轮。 */
export const TIMELINE_WINDOW_EXPAND_STEP = 3;

export function countAgentRunItems(items: ReadonlyArray<{ kind: string }>): number {
	let count = 0;
	for (const item of items) {
		if (item.kind === "agent-run") count += 1;
	}
	return count;
}

/** 统计消息序列中的 turn 数；分页协议与主进程都以 turn 起点（发言权周期）计数。
 * 与主进程 findTurnPageStart/turnTrimStartIndex 同一约定：
 * turn 起点 = role==="user" 且跳过中间杂项后前一条真实消息不是 user——
 * 连发 user（无 assistant 回复）只算第一条为起点，其余并入同一轮。
 *
 * 同时也是 pi 会话的对外「N 轮」展示口径（统一轮次契约：pi 与内部协议一致，
 * 一开口即算一轮，未回复也算；DSH 会话则用 host sessionStats 官方口径）。
 */
export function countUserTurns(messages: ReadonlyArray<{ role?: string }>): number {
	let count = 0;
	let prevUserOrAssistantRole: "user" | "assistant" | undefined;
	for (const message of messages) {
		const role = message.role;
		if (role === "user") {
			if (prevUserOrAssistantRole !== "user") count += 1;
			prevUserOrAssistantRole = "user";
		} else if (role === "assistant") {
			prevUserOrAssistantRole = "assistant";
		}
	}
	return count;
}

/**
 * 从尾部保留最多 maxTurns 个 agent-run，并带上从首个保留 run 起的全部条目
 * （run 之间的 system/compaction 等附属消息一并保留）。
 * 只按轮数窗口截断（2026-09 统一轮次协议：删除条目预算——单轮再大也整轮保留，
 * 用户看历史就是要看完整一轮；折叠 unmount 从源头控制 DOM 量，不需要条目兜底）。
 * 不足上限时原样返回（引用不变，便于 memo）。
 */
export function sliceLastAgentRuns<T extends { kind: string } & { items?: readonly unknown[] }>(items: readonly T[], maxTurns: number): T[] {
	if (maxTurns <= 0 || items.length === 0) return items as T[];
	let runs = 0;
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const item = items[index];
		if (item?.kind !== "agent-run") {
			// 非 run 条目（消息/诊断卡片）：不占轮数，随所属轮保留
			continue;
		}
		runs += 1;
		if (runs >= maxTurns) {
			return index === 0 ? (items as T[]) : items.slice(index);
		}
	}
	return items as T[];
}

/**
 * 是否对渲染列表启用 turn 窗口裁剪。
 * windowTurns 由调用方按跟随态决定（贴底 3 轮 / 上滚 15+展开轮）；
 * 与旧签名（following 参与判定）不同：非贴底同样裁剪，只是窗口更大。
 */
export function shouldWindowTimelineTurns(agentRunCount: number, windowTurns: number): boolean {
	return windowTurns > 0 && agentRunCount > windowTurns;
}

/** 按窗口轮数决定展示列表；未裁剪时返回原数组引用。 */
/**
 * 以某个 agent-run 为锚切窗口：[anchor-before, anchor+after]。
 *
 * 为什么需要它：旧窗口只能「从尾部保留 N 轮」（sliceLastAgentRuns）。636 轮会话里
 * 跳第 351 条 = 窗口必须从 3 轮扩到 350 轮，每帧 8 轮 → 44 帧 → 用户看到「慢慢滚」
 * 或「跳不到」（2026-11 真机）。而用户要的只是「那一条出现在屏幕上」——锚点窗口挂
 * 4~6 轮就够，与目标在会话第几成无关。
 *
 * 锚点找不到（run 已被回收）时返回 null，调用方退回尾部窗口，不猜位置。
 */
export function sliceAgentRunsAround<T extends { kind: string } & { items?: readonly unknown[] }>(items: readonly T[], anchorIndex: number, beforeRuns = 1, afterRuns = 3): T[] | null {
	if (anchorIndex < 0 || anchorIndex >= items.length) return null;
	// 锚点可以落在**顶级消息项**上（kind:"message" = 用户提问）：它不属于任何 agent-run，
	// 只认 agent-run 会让它返回 null → 窗口退回尾部 → 点用户提问的查找命中、画面滚到最底部
	// （2026-11-25 实测：3173 条「的」命中里 22% 落在用户提问上）。
	const anchorEntry = items[anchorIndex];
	if (!anchorEntry) return null;
	if (anchorEntry.kind !== "agent-run" && anchorEntry.kind !== "message") return null;
	let start = anchorIndex;
	let seen = 0;
	while (start > 0 && seen < beforeRuns) {
		start -= 1;
		if (items[start]?.kind === "agent-run") seen += 1;
	}
	// 起点落在「轮首的用户提问」（kind:"message"）上时必须**保留**它：
	// 那是这一轮的开头，推掉它用户就看不到自己问的什么（2026-11-25 真机：9 轮会话里
	// 每一轮的开头都不见了，只剩一个空的执行过程折叠块）。
	// 只有既不是 run 也不是 message 的条目（上一轮的尾部附属消息）才向内推，避免切成孤儿。
	while (start < anchorIndex && items[start]?.kind !== "agent-run" && items[start]?.kind !== "message") start += 1;
	let end = anchorIndex;
	seen = 0;
	while (end < items.length - 1 && seen < afterRuns) {
		end += 1;
		if (items[end]?.kind === "agent-run") seen += 1;
	}
	return items.slice(start, end + 1) as T[];
}

/** 按窗口轮数决定展示列表；给了 anchorRunIndex 时以它为中心，否则从尾部切。未裁剪时返回原数组引用。 */
export function selectTimelineTurnWindow<T extends { kind: string } & { items?: readonly unknown[] }>(items: readonly T[], windowTurns: number, anchorRunIndex?: number | null, anchorBeforeTurns = 1): T[] {
	if (typeof anchorRunIndex === "number" && anchorRunIndex >= 0) {
		const around = sliceAgentRunsAround(items, anchorRunIndex, anchorBeforeTurns);
		if (around) return around;
	}
	if (!shouldWindowTimelineTurns(countAgentRunItems(items), windowTurns)) {
		return items as T[];
	}
	return sliceLastAgentRuns(items, windowTurns);
}

/**
 * 目标消息所在的 agent-run 下标；找不到返回 -1。
 *
 * **子项的 id 有三种位置**（2026-11 真机回归的直接原因，逐次补出来的）：
 *   - MessageItem = { kind: "message", message: { id } } —— id 在 message 里，顶层没有
 *   - ToolGroupItem / ThinkingGroupItem / ErrorGroupItem —— id 在顶层
 *
 * 上一版只查 `child.id`，于是「目标那条消息」永远匹配不到（它是 MessageItem），
 * findAgentRunIndexByItemId 恒返回 -1，锚点窗口从未生效 —— 而当时的单元测试用的是
 * 假的 `{ id }` 形状，全绿。这是「只有好样本会绿」的典型：测试数据和真实数据不同形。
 * 现在两种形状都查，测试也改用真实形状。
 */
function childMatchesId(child: unknown, itemId: string): boolean {
	if (child === null || typeof child !== "object") return false;
	// 三种形状都要认，缺一种就是「中间条目跳不过去」：
	//   ① 平铺 ChatMessage：{ id, meta.entryId }
	//   ② 包一层：{ id, message: { id, meta.entryId } }
	//   ③ 只有 message.id（无 entryId 的运行时消息）
	const record = child as { id?: unknown; meta?: { entryId?: unknown }; message?: unknown };
	if (typeof record.id === "string" && matchesJumpMessage({ id: record.id, meta: record.meta }, itemId)) return true;
	const message = record.message as { id?: unknown; meta?: { entryId?: unknown } } | undefined;
	// 组项没有 message 字段（ThinkingGroupItem / ToolGroupItem 的成员在 messages 里）：
	// 这里若 return false，下面的递归永远走不到 —— 这就是「点在折叠组里的那条消息」
	// 锚点恒为 -1 的直接原因（2026-11-25 全网关扫描 288 个刻度点 127 处失配）。
	if (message !== null && typeof message === "object") {
		if (typeof message.id === "string" && matchesJumpMessage({ id: message.id, meta: message.meta }, itemId)) return true;
	}
	// 组的子项：groupToolMessages 会把一条轮次里的 thinking / toolCall / toolResult
	// 折进 ToolGroupItem / ThinkingGroupItem / ErrorGroupItem 的 items（两层深），
	// 只查一层会让「点在折叠组里的那条消息」永远匹配不到 —— 锚点 -1 → 窗口退回尾部
	// → 点查找命中、画面滚到会话最底部（2026-11-25 全网关扫描：288 个刻度点 127 处失配，
	// 失配样本里锚点消息确实在某个 agent-run 的 JSON 里，只是被裹在组内）。
	// 组的成员在 **messages**（ToolGroupItem / ThinkingGroupItem / RetryGroupItem 都是
	// messages: ChatMessage[]），agent-run 的成员在 items。两个键都要看：只查 record.id
	// 只能命中「组里的第一条」，组内第 2 条起永远匹配不到。
	const recordAny = child as { items?: unknown; messages?: unknown };
	const nested = Array.isArray(recordAny.items) ? recordAny.items : recordAny.messages;
	if (Array.isArray(nested)) {
		for (const sub of nested) if (childMatchesId(sub, itemId)) return true;
	}
	return false;
}

export function findAgentRunIndexByItemId(items: ReadonlyArray<{ kind: string; items?: readonly unknown[] }>, itemId: string | null | undefined): number {
	if (!itemId) return -1;
	// 从尾部往前找：同一 id 出现在多个 run 时，取最靠后那一轮（重发/重试会留旧 id 的残影）。
	for (let index = items.length - 1; index >= 0; index -= 1) {
		const entry = items[index];
		if (entry?.kind !== "agent-run") {
			// 顶级消息项（用户提问）：自身就是锚点目标，返回它的下标。
			// 只扫 agent-run 的 items 会漏掉全部用户提问——它们不在任何 run 里。
			if (childMatchesId(entry, itemId)) return index;
			continue;
		}
		for (const child of entry.items ?? []) {
			if (childMatchesId(child, itemId)) return index;
		}
	}
	return -1;
}

/**
 * 渲染层出口：把「钉住的消息 id」直接翻译成窗口，省掉调用方两行中间量。
 *
 * 钉 id 为 null / 不在任何 run 里时，等价于 selectTimelineTurnWindow(items, windowTurns)
 * （从尾部切）—— 跳转目标还没进数据时走的就是这条，行为不突变。
 */
export function resolveAnchoredTurnWindow<T extends { kind: string; items?: readonly unknown[] }>(items: readonly T[], windowTurns: number, pinnedMessageId: string | null | undefined, perSideRuns: number = JUMP_WINDOW_RUNS_EACH_SIDE): T[] {
	// 有锚点就切到目标那一轮附近。
	// 锚点在但一条都匹配不上时**退回有界尾部窗口**，绝不能返回全量：
	// 全量会让整份会话（722 轮）一次挂进 DOM —— 切换会话、滚动全部卡死。
	// 「别让用户看到跳到底部」由调用方负责：跳转只能拿**能命中**的 id 当锚点，
	// 命中不了就不要设锚点（见 loadPageAroundEntry 的 anchorEntryId）。
	if (pinnedMessageId) {
		const anchorIndex = findAgentRunIndexByItemId(items, pinnedMessageId);
		if (anchorIndex >= 0) {
			// **双向**：上下各取 JUMP_WINDOW_RUNS_EACH_SIDE 轮，任一侧不足由另一侧补足。
			//
			// 固定「1 前 3 后」的失败形状（2026-11-25 日志实证）：跳到第 1 条之后，窗口只剩
			// 1 前 3 后 = 5 轮，内容总高 858px 恰好等于视口 858px → scrollTop 恒被钳在 0 →
			// 目标滚不到视口顶 → 24 帧后 give-up。之后每一次往下跳，窗口仍钉在顶部那 5 轮，
			// 于是「从 1 到 100、200、300 全部失败」。往下跳需要上方留够（滚动空间来自上方），
			// 往上跳需要下方留够（空间来自下方），只朝一个方向留就是单向适配。
			// 非有限值（NaN / Infinity / undefined 传成 number）不能让半径变成 NaN：
			// NaN 会让 slice 的边界全失效，切出 1 轮的窗口，落位永远等不到目标行。退默认值。
			const rawPerSide = Number.isFinite(perSideRuns) ? Math.floor(perSideRuns) : JUMP_WINDOW_RUNS_EACH_SIDE;
			const perSide = Math.min(JUMP_WINDOW_RUNS_MAX, Math.max(1, rawPerSide));
			const beforeAvailable = anchorIndex;
			const afterAvailable = items.length - 1 - anchorIndex;
			const before = Math.min(perSide, beforeAvailable);
			const after = Math.min(perSide, afterAvailable);
			const deficit = 2 * perSide - before - after;
			const around = sliceAgentRunsAround(items, anchorIndex, before + Math.max(0, deficit), after);
			if (around) return around;
		}
	}
	if (!shouldWindowTimelineTurns(countAgentRunItems(items), windowTurns)) return items as T[];
	return sliceLastAgentRuns(items, windowTurns);
}
