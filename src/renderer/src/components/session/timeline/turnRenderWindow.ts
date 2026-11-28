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

/** 跳转锚点窗口每侧的默认轮数；挂载量与目标距尾部无关。 */
export const JUMP_WINDOW_RUNS_EACH_SIDE = 6;
/** 锚点窗口的安全上限，防止错误身份把整份会话挂进 DOM。 */
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
/**
 * 从第 startRun 个 agent-run 起保留 maxTurns 轮（含 run 之间的附属条目）。
 *
 * 为什么需要它：sliceLastAgentRuns 是**尾窗**——只保留最后 N 轮。跳转时目标可能在很前面，
 * 尾窗要覆盖它就必须把窗口扩到「目标到末尾」的全部轮数，挂载量随距离线性增长：
 * 实测 700 轮 / 每轮 18 条，跳到第 100 轮要挂 10,818 条（≈5.8MB），跳到第 0 轮要挂 12,600 条（≈6.8MB）
 * —— 这就是用户说的「很卡」。
 *
 * 锚点窗口把「窗口从哪开始」变成独立参数：跳转只改 startRun，挂载轮数恒为 maxTurns，
 * 与目标距离无关（O(1) 挂载量）。尾窗等价于 startRun = 总轮数 - maxTurns。
 *
 * 判据：tests/jumpWindowAnchor.test.mjs。
 */
/**
 * agent-run 起点表：`starts[k]` = 第 k 轮在 items 里的下标，末尾多一个 items.length 作右端点。
 *
 * 为什么要有它（布尔格上的莫比乌斯反演，落到链上就是差分）：
 * 尾窗的「取最后 N 轮」是**累积量**——从尾部往前数，单位是扫过的条目。要反过来问
 * 「第 k 轮从哪开始」，旧做法每次从头数一遍，代价随 k 线性增长。实测 700 轮 / 每轮 18 条，
 * 取 8 轮：起点 0 读 289 个下标，起点 350 读 6589 个，2000 轮起点 1000 读 18289 个 ——
 * 返回值一直是 144 条，多出来的全是「数到起点」的白工。
 *
 * 莫比乌斯反演给的做法：区间和 ↔ 端点差。先把端点在 O(n) 里记下来（前缀表），
 * 之后任意区间的端点查询是两次读数、与 k 无关。布尔格 B_n 的 μ(S,T)=(-1)^{|T|-|S|}，
 * 沿一条链（每层一个元素）退化成 μ(i,i+1)=-1、其余为 0，正是差分。
 *
 * 缓存按 items 引用（WeakMap）：同一数组重复取窗不重建，数组换了就自动失效。
 */
const runStartCache = new WeakMap<readonly unknown[], number[]>();

export function buildAgentRunStarts(items: readonly { kind: string }[]): number[] {
	const cached = runStartCache.get(items);
	if (cached) return cached;
	const starts: number[] = [];
	for (let index = 0; index < items.length; index += 1) {
		if (items[index]?.kind === "agent-run") starts.push(index);
	}
	starts.push(items.length);
	runStartCache.set(items, starts);
	return starts;
}

/** 用起点表取窗：定位 O(1)，读的只有被复制的那几条。starts 必须来自 buildAgentRunStarts。 */
export function sliceByRunStarts<T>(items: readonly T[], starts: readonly number[], startRun: number, maxTurns: number): T[] {
	const totalRuns = starts.length - 1;
	const k = Math.max(0, Math.min(Math.trunc(startRun), totalRuns));
	if (maxTurns <= 0 || k >= totalRuns) return [];
	const from = starts[k];
	const to = starts[Math.min(k + Math.trunc(maxTurns), totalRuns)];
	return items.slice(from, to) as T[];
}
export function sliceAgentRunWindowFrom<T extends { kind: string } & { items?: readonly unknown[] }>(items: readonly T[], startRun: number, maxTurns: number): T[] {
	if (maxTurns <= 0 || items.length === 0) return [];
	// 走起点表：定位两次读数，不随起点扫。旧实现是 here 起一路数到 startRun，
	// 2000 轮起点 1000 时要读 18289 个下标，而返回值一直是同一个 144 条。
	return sliceByRunStarts(items, buildAgentRunStarts(items), startRun, maxTurns);
}
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
 * 跳转目标的渲染身份索引。一次建立后，同一份 reconciledRuns 上的点击是 O(1) 查找；
 * 数组引用变化时自动失效。索引同时收录顶层消息、MessageItem、工具/思考组及其 messages。
 */
const jumpRunIndexCache = new WeakMap<readonly unknown[], { message: Map<string, number>; entry: Map<string, number> }>();

function readJumpEntryId(meta: unknown): string | undefined {
	if (meta === null || typeof meta !== "object" || !("entryId" in meta)) return undefined;
	const entryId = meta.entryId;
	return typeof entryId === "string" && entryId.length > 0 ? entryId : undefined;
}

function collectJumpIds(value: unknown, itemIndex: number, index: { message: Map<string, number>; entry: Map<string, number> }): void {
	if (value === null || typeof value !== "object") return;
	const record = value as { id?: unknown; meta?: unknown; message?: unknown; items?: unknown; messages?: unknown };
	if (typeof record.id === "string" && record.id.length > 0 && !index.message.has(record.id)) index.message.set(record.id, itemIndex);
	const entryId = readJumpEntryId(record.meta);
	if (entryId && !index.entry.has(entryId)) index.entry.set(entryId, itemIndex);
	if (record.message !== undefined) collectJumpIds(record.message, itemIndex, index);
	const nested = Array.isArray(record.items) ? record.items : record.messages;
	if (Array.isArray(nested)) for (const child of nested) collectJumpIds(child, itemIndex, index);
}

function buildJumpRunIndex(items: readonly { kind: string; items?: readonly unknown[] }[]): { message: Map<string, number>; entry: Map<string, number> } {
	const cached = jumpRunIndexCache.get(items);
	if (cached) return cached;
	const index = { message: new Map<string, number>(), entry: new Map<string, number>() };
	for (let position = 0; position < items.length; position += 1) collectJumpIds(items[position], position, index);
	jumpRunIndexCache.set(items, index);
	return index;
}

export function findAgentRunIndexByItemId(items: ReadonlyArray<{ kind: string; id?: string; items?: readonly unknown[] }>, itemId: string | null | undefined): number {
	if (!itemId) return -1;
	const index = buildJumpRunIndex(items);
	// 文件条目身份跨重投影稳定；未知入口优先 entryId，和 jumpTarget.ts 同一契约。
	return index.entry.get(itemId) ?? index.message.get(itemId) ?? -1;
}

/** 以锚点为中心取有界窗口；窗口外的 700 轮不会因跳转被复制进 DOM。 */
export function sliceAgentRunsAround<T extends { kind: string; items?: readonly unknown[] }>(items: readonly T[], anchorIndex: number, beforeRuns = 1, afterRuns = 3): T[] | null {
	if (anchorIndex < 0 || anchorIndex >= items.length) return null;
	const anchor = items[anchorIndex];
	if (!anchor || (anchor.kind !== "agent-run" && anchor.kind !== "message")) return null;
	let start = anchorIndex;
	let seen = 0;
	while (start > 0 && seen < beforeRuns) {
		start -= 1;
		if (items[start]?.kind === "agent-run") seen += 1;
	}
	// 轮首的用户提问通常是紧邻 agent-run 的顶层 message；不能把它切掉。
	while (start < anchorIndex && items[start]?.kind !== "agent-run" && items[start]?.kind !== "message") start += 1;
	let end = anchorIndex;
	seen = 0;
	while (end < items.length - 1 && seen < afterRuns) {
		end += 1;
		if (items[end]?.kind === "agent-run") seen += 1;
	}
	return items.slice(start, end + 1) as T[];
}

/** 有锚点走固定半径；锚点不在当前投影时安全退回尾窗，绝不返回全量。 */
export function resolveAnchoredTurnWindow<T extends { kind: string; items?: readonly unknown[] }>(items: readonly T[], windowTurns: number, pinnedMessageId: string | null | undefined, perSideRuns = JUMP_WINDOW_RUNS_EACH_SIDE): T[] {
	if (pinnedMessageId) {
		const anchorIndex = findAgentRunIndexByItemId(items, pinnedMessageId);
		if (anchorIndex >= 0) {
			const perSide = Math.min(JUMP_WINDOW_RUNS_MAX, Math.max(1, Number.isFinite(perSideRuns) ? Math.trunc(perSideRuns) : JUMP_WINDOW_RUNS_EACH_SIDE));
			const before = Math.min(perSide, anchorIndex);
			const after = Math.min(perSide, items.length - 1 - anchorIndex);
			const around = sliceAgentRunsAround(items, anchorIndex, before + Math.max(0, 2 * perSide - before - after), after);
			if (around) return around;
		}
	}
	return selectTimelineTurnWindow(items, windowTurns);
}

export function selectTimelineTurnWindow<T extends { kind: string } & { items?: readonly unknown[] }>(
	items: readonly T[],
	windowTurns: number,
	/**
	 * 窗口锚点：从第几个 agent-run 开始挂载。省略 = 尾窗（只挂最后 windowTurns 轮，现状）。
	 * 跳转用锚点把窗口直接移到目标处，挂载轮数恒为 windowTurns，不随目标距离增长。
	 */
	windowStartRun?: number,
): T[] {
	if (typeof windowStartRun === "number" && Number.isFinite(windowStartRun)) {
		if (windowTurns <= 0) return items as T[];
		return sliceAgentRunWindowFrom(items, Math.max(0, Math.trunc(windowStartRun)), windowTurns);
	}
	if (!shouldWindowTimelineTurns(countAgentRunItems(items), windowTurns)) {
		return items as T[];
	}
	return sliceLastAgentRuns(items, windowTurns);
}
