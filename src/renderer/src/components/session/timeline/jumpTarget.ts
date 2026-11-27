/**
 * 时间线跳转的目标归一（纯函数 + 极小的 DOM 兜底）。
 *
 * 会话内查找（`search-session`）的命中 id 是**会话文件条目 id**：Go 索引读的是
 * JSONL 行的顶层 `id`，在渲染层消息上落在 `meta.entryId`。而时间线节点/消息的
 * `id` 是投影 id（`${agentId}-history-${entryId}`，见 AgentMessageProjector）。
 * 两者不相等，直接拿命中 id 当消息 id 去查 `[data-message-id]` 永远查不到 →
 * 点击命中「什么都没发生」（2027-02 用户反馈）。这里统一归一：先按消息 id 精确
 * 匹配（刻度/大纲等调用方传的就是投影 id），再按条目 id 匹配（会话内查找命中）。
 */
/**
 * 从消息 meta 里读条目 id。`ChatMessage.meta` 是 `Record<string, unknown> & I18nDescriptor`，
 * 这里按 `unknown` 收窄（不做 `as` 强转）：非对象 / 没有 entryId / 非字符串一律当没有。
 */
function readEntryId(meta: unknown): string | undefined {
	if (meta === null || typeof meta !== "object" || !("entryId" in meta)) return undefined;
	const entryId = meta.entryId;
	return typeof entryId === "string" && entryId.length > 0 ? entryId : undefined;
}

/**
 * 消息下标 → agent-run 序号（第几条 turn）。窗口锚点只要这一个换算。
 *
 * 为什么单独成一个函数（组 2 列的「两套下标要对同一个数组算」）：
 * `resolveJumpMessageIndex` 给的是 messages 下标，`sliceByRunStarts` 吃的是 run 序号。
 * 换算若散落在调用点，错一位的症状是「跳到上一轮」——看不出是 bug，看着像落位不准。
 * 只留这一处，它可以单测。
 *
 * 返回 -1 表示：目标在该数组里没有（未加载／已被 context_edit 移出展示）。
 * 判据：tests/jumpRunIndex.test.mjs。
 */
export function runIndexOfMessage(runs: ReadonlyArray<{ kind: string; items?: ReadonlyArray<{ id: string; meta?: unknown }> }>, target: { messageId?: string; entryId?: string }): number {
	// 两个 id 空间分开扫，entryId 优先。
	// 事故（组 2 实测）：同一条件里 item.id 与 readEntryId 并列，先命中先返回，
	// 于 messageId 恰好等于另一条 entryId 时锚到错的轮（实测 0，应为 2）。
	const runIndexAt = (predicate: (item: { id: string; meta?: unknown }) => boolean): number => {
		let runIndex = -1;
		for (const run of runs) {
			if (run.kind === "agent-run") runIndex += 1;
			for (const item of run.items ?? []) {
				if (predicate(item)) return runIndex < 0 ? 0 : runIndex;
			}
		}
		return -1;
	};
	if (target.entryId) {
		const byEntry = runIndexAt((item) => readEntryId(item.meta) === target.entryId);
		if (byEntry >= 0) return byEntry;
	}
	if (target.messageId) {
		return runIndexAt((item) => item.id === target.messageId);
	}
	return -1;
}
/**
 * 锚点 run id -> 窗口起点。**找不到返回 undefined（退回尾窗），绝不 clamp 到 0。**
 *
 * 为什么单独一层（组 2 的第 8 件）：runIndexOfMessage 找不到时返回 -1，
 * 而 -1 直接喂 selectTimelineTurnWindow 会走 Math.max(0, -1) -> 0 -> **跳到会话开头**。
 * 那是「跳到别处」那一类，比停在原地糟得多。
 *
 * 真会发生的两类：
 *   context_edit 把那条移出展示
 *   prepend 时基线重算、锚点那轮被合并（stalePrefix 分支把 baseMessages 置空）
 *
 * 策略选「退回尾窗 + 清锚点」（调用方清），不选「保留锚点等下次数据变」：
 * 后者在切会话恢复路径上会留下「锚点在、id 已不在、每帧算一次 -1、每帧退回尾窗」，
 * 表现是「切回来在末尾但回底按钮不亮」—— 状态不一致比「回到底部」更难解释。
 * 收敛成一种：没有锚点就是跟流。
 *
 * 判据：tests/jumpWindowAnchorResolve.test.mjs。
 */
export type AnchorStartRun =
	| { kind: "ok"; startRun: number }
	/** 各空间都没找到：context_edit 移出展示 / 数据还没到 */
	| { kind: "missing" }
	/** 多个空间都命中但指向不同轮：我们的锚点写错了空间，是真 bug */
	| { kind: "conflict"; hits: { run?: number; entry?: number; message?: number } };

export function resolveAnchorStartRun(runs: ReadonlyArray<{ kind: string; id?: string; items?: ReadonlyArray<{ id: string; meta?: unknown }> }>, anchor: { runId?: string; entryId?: string; messageId?: string }): AnchorStartRun {
	// 输入空间必须与名字对齐（组 2 的第 9 件），且三种结局必须可区分（第 10 件）。
	//
	// 为什么不能只返回 number | undefined：undefined 是二义的 ——
	//   missing（数据侧的事，等数据/改数据层）
	//   conflict（我们的锚点写错了空间，是真 bug 却长得像 missing）
	// 两者都退回尾窗，用户看到的都是「点了刻度落到别处」，但修法完全不同。
	// 分开之后，conflict 能打日志计数：频繁出现就说明写锚点那一侧存错了空间。
	const byRunId = (id: string): number | undefined => {
		let runIndex = -1;
		for (const run of runs) {
			if (run.kind === "agent-run") runIndex += 1;
			if (run.id === id) return runIndex < 0 ? 0 : runIndex;
		}
		return undefined;
	};

	const hits: { run?: number; entry?: number; message?: number } = {};
	if (anchor.runId) hits.run = byRunId(anchor.runId);
	if (anchor.entryId) {
		const index = runIndexOfMessage(runs, { entryId: anchor.entryId });
		if (index >= 0) hits.entry = index;
	}
	if (anchor.messageId) {
		const index = runIndexOfMessage(runs, { messageId: anchor.messageId });
		if (index >= 0) hits.message = index;
	}
	const found = [hits.run, hits.entry, hits.message].filter((value) => typeof value === "number") as number[];
	if (found.length === 0) return { kind: "missing" };
	// 多个空间命中但指向不同轮：不猜（不静默取一个）
	if (new Set(found).size > 1) return { kind: "conflict", hits };
	return { kind: "ok", startRun: found[0] };
}

export function resolveJumpMessageIndex(messages: ReadonlyArray<{ id: string; meta?: unknown }>, target: { messageId?: string; entryId?: string }): number {
	// 与 runIndexOfMessage 同一形态：两个空间分开扫，entryId 优先。
	if (target.entryId) {
		const byEntry = messages.findIndex((message) => readEntryId(message.meta) === target.entryId);
		if (byEntry >= 0) return byEntry;
	}
	if (target.messageId) {
		return messages.findIndex((message) => message.id === target.messageId);
	}
	return -1;
}

/**
 * 落位元素可能被折叠隐藏：轮内中间回答（阶段正文）随「执行过程」折叠区一起
 * `display:none`，几何矩形全为 0；对它 `scrollTop = 0` 等于跳到时间线顶部。
 * 命中不可见时退到所属轮次行（`.turn-row` / `.user-turn`），用户至少落在这一轮，
 * 折叠区就在眼前。
 */
export function resolveJumpScrollTarget(element: HTMLElement): HTMLElement {
	if (element.getClientRects().length > 0) return element;
	// closest 的默认泛型返回 Element：这里限定到 HTMLElement（轮次行/用户气泡都是 HTMLElement）
	return element.closest<HTMLElement>(".turn-row, .user-turn") ?? element;
}
