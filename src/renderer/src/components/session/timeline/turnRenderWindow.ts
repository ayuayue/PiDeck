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
export function sliceAgentRunWindowFrom<T extends { kind: string } & { items?: readonly unknown[] }>(items: readonly T[], startRun: number, maxTurns: number): T[] {
	if (maxTurns <= 0 || items.length === 0) return [];
	let runIndex = -1;
	let start = -1;
	let end = -1;
	for (let index = 0; index < items.length; index += 1) {
		if (items[index]?.kind !== "agent-run") continue;
		runIndex += 1;
		if (runIndex === startRun) start = index;
		if (runIndex === startRun + maxTurns) {
			end = index;
			break;
		}
	}
	// startRun 超出总轮数：没有可挂的轮，返回空（调用方应先把锚点夹到合法区间）
	if (start < 0) return [];
	return (end < 0 ? items.slice(start) : items.slice(start, end)) as T[];
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
