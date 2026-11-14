/**
 * 从 AppUtils 拆出的「渲染列表复用」域：内容未变的 run / 条目换回旧引用，
 * 让 TurnRow、buildTurnDisplay、groupTurnProcess 的 memo 能命中。实现依赖 renderEquality 的判定。
 */

import { sameAgentRunForRender } from "./renderEquality";
import type { AgentRunItem, RenderMessage } from "./renderTypes";

function sameItemReferences(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
	if (a === b) return true;
	if (!a || !b || a.length !== b.length) return false;
	for (let index = 0; index < a.length; index += 1) {
		if (a[index] !== b[index]) return false;
	}
	return true;
}

function sameRunItemReference(previous: AgentRunItem["items"][number], next: AgentRunItem["items"][number]): boolean {
	if (previous === next) return true;
	// MessageItem 没有顶层 id（身份在 message.id 上），所以 id 比较只能在各自分支里做。
	if (previous.kind !== next.kind) return false;
	switch (next.kind) {
		case "message":
			return previous.kind === "message" && previous.message.id === next.message.id && previous.message === next.message;
		case "tool-group":
			// groupToolMessages 每次都新建 messages 数组，所以比成员引用而不是数组引用。
			return previous.kind === "tool-group" && previous.id === next.id && sameItemReferences(previous.messages, next.messages);
		case "thinking-group":
			return previous.kind === "thinking-group" && previous.id === next.id && previous.text === next.text && previous.startedAt === next.startedAt && previous.endedAt === next.endedAt && sameItemReferences(previous.messages, next.messages);
		case "retry-group":
		case "error-group":
			return previous.kind === next.kind && previous.id === next.id && previous.message === next.message;
		case "extension-entries":
			return previous.kind === "extension-entries" && previous.id === next.id && sameItemReferences(previous.messages, next.messages);
	}
}

/**
 * 顶层条目（RenderMessage）的引用等价判断。
 *
 * 为什么单独一个函数：`sameRunItemReference` 只认 `AgentRunItem["items"]` 里的条目类型
 * （message / tool-group / thinking-group / retry-group / error-group / extension-entries），
 * 不含 agent-run 本身；而顶层列表里 agent-run 与这些条目混排，比较需要先分流。
 */
function sameTopLevelEntryReference(previous: RenderMessage, next: RenderMessage): boolean {
	if (previous === next) return true;
	if (previous.kind === "agent-run" || next.kind === "agent-run") {
		return previous.kind === "agent-run" && next.kind === "agent-run" && sameAgentRunForRender(previous, next);
	}
	return sameRunItemReference(previous, next);
}

/**
 * run 的条目列表引用复用：内容未变的条目换回旧引用。
 *
 * 为什么需要：`groupToolMessages` 每次全量重建 run，所以**每个** run 的 `items` 数组与其中的
 * tool-group / thinking-group 对象都是新的。旧实现只复用「整个 run」，于是内容变化的那个 run
 * （流式轮）里，全部条目都是新引用 → `buildTurnDisplay` 的 entry、`groupTurnProcess` 的过程组
 * 全部失去 memo 依据 → 已展开的执行过程组每 50ms 重建预算内的成员元素与组头文案。
 * 这一层把条目换回旧引用后，链路从 `buildTurnDisplay` 开始就能逐层命中。
 */
function reconcileRunItems(previous: readonly AgentRunItem["items"][number][], next: readonly AgentRunItem["items"][number][]): AgentRunItem["items"] {
	let allReused = previous.length === next.length;
	const merged = next.map((item, index) => {
		const prev = previous[index];
		if (prev !== undefined && sameRunItemReference(prev, item)) return prev;
		allReused = false;
		return item;
	});
	// 全部命中且长度相同：把数组引用也复用掉（下游 useMemo 才能整体命中）。
	return allReused ? (previous as AgentRunItem["items"]) : merged;
}

/**
 * 对比新旧渲染列表，对「内容未变化的 run」复用旧对象引用。
 *
 * 背景（阶段0补强）：groupToolMessages 每次全量重建所有 run，即使只有最后一条消息变化。
 * 若每次都返回新对象，TurnRow 的 memo 比较（sameAgentRunForRender）会对每个历史 run
 * 做深度遍历，长会话时成本不小。复用旧引用后，sameAgentRunForRender 的
 * `previous === next` 快速路径直接命中，历史 run 比较退化为 O(1)。
 *
 * 规则：按 run.id 配对，内容相同（sameAgentRunForRender）则取旧引用；
 * 新增/删除/内容变化的 run 用新对象。列表结构（顺序、条目数）以 next 为准。
 *
 * 内容变化的 run 还会再做一层**条目级**复用（reconcileRunItems）：流式轮每 50ms 都在变，
 * 但一轮里真正在变的只有正在输出的那一条，其余条目的旧引用必须留下来，否则整条渲染链
 * （buildTurnDisplay → groupTurnProcess → ProcessFold → ProcessGroupStep）的 memo 全部失效。
 */
export function reconcileRuns(previous: RenderMessage[] | undefined, next: RenderMessage[]): RenderMessage[] {
	if (!previous) return next;
	// 顶层只对 agent-run 做引用复用；message/tool-group/thinking-group 顶层条目按需更新
	const prevRuns = new Map<string, AgentRunItem>();
	for (const item of previous) {
		if (item.kind === "agent-run") prevRuns.set(item.id, item);
	}
	let changed = false;
	const reconciled = next.map((item, index) => {
		if (item.kind !== "agent-run") {
			// 顶层非 run 条目（用户消息、独立的重试/错误卡片、扩展输出条目）：按位置配对，
			// 引用等价就换回旧对象。
			//
			// 这里必须置 changed —— 旧实现直接 `return item` 既不配对也不置位，于是
			// 「只改了一条顶层消息、条目数不变」时整函数返回 `previous`，**新内容被静默丢弃**
			// （编辑用户消息、隐藏文件消息重算、扩展条目原地更新都会踩到）。
			const prev = previous[index];
			if (prev !== undefined && prev.kind !== "agent-run" && sameTopLevelEntryReference(prev, item)) return prev;
			changed = true;
			return item;
		}
		const prev = prevRuns.get(item.id);
		if (!prev) {
			changed = true;
			return item;
		}
		if (sameAgentRunForRender(prev, item)) return prev;
		changed = true;
		// 外层字段（endedAt / askWaitMs 等）真的变了，所以 run 必须新建；但 items 一律用复用后的结果：
		// 全部命中时 `reconcileRunItems` 直接返回 `prev.items` 引用，下游 buildTurnDisplay /
		// groupTurnProcess 的 useMemo 才真正命中；若沿用 next 的 items（内容相同但引用是新的），
		// 这一整层就白做了。
		const items = reconcileRunItems(prev.items, item.items);
		return { ...item, items };
	});
	// 只有「长度相同且全部未变化」才能整体复用 previous 数组本身；
	// 否则（新增/删除/变化）必须返回 reconciled（其中未变化 run 已复用旧引用）。
	if (!changed && previous.length === next.length) return previous;
	return reconciled;
}
