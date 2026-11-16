/**
 * 时间线运行期状态：历史改写遮罩、滚动锚点、live 正文/思考通道、轮次折叠信号、
 * 执行过程展开记忆与过程组手风琴状态。
 *
 * 从 `session-atoms.ts` 原样搬家而来（拆分，行为零变化）：atom 与 atomFamily **搬家**
 * 而不是重建——重建会造出两套状态（改 A 处 B 处不更新）。所有家族仍按原 key 参数创建。
 * 入口 `session-atoms.ts` 用 `export *` 转出，所有既有 import 不变。
 */
import { atom } from "jotai";
import { atomFamily, selectAtom } from "jotai/utils";
import type { StreamingThinkingEntry } from "./session-atoms-types";

/** 时间线改写过程遮罩：停 Agent / 写 JSONL / 重载 / 激活 / fork / 重发 / 编辑 / 删除 / 回退，按 sessionId 隔离。 */
export type SessionHistoryMutationOverlayKind = "stopping" | "mutating" | "reloading" | "activating" | "forking" | "resending" | "editing" | "deleting" | "rewinding";

/** 历史消息即时反馈：正在进行的重发/编辑/删除/fork 所指向的消息（按钮 spinner 与失效依据）。 */
export type PendingHistoryMutationKind = "resend" | "edit" | "delete" | "fork";
export type PendingHistoryMutation = { sessionId: string; messageId: string; kind: PendingHistoryMutationKind };

export const sessionHistoryMutationOverlayByIdAtom = atom<Record<string, SessionHistoryMutationOverlayKind>>({});

export const setSessionHistoryMutationOverlayAtom = atom(null, (get, set, input: { sessionId: string; kind: SessionHistoryMutationOverlayKind | null }) => {
	const current = get(sessionHistoryMutationOverlayByIdAtom);
	if (input.kind === null) {
		if (!(input.sessionId in current)) return;
		const next = { ...current };
		delete next[input.sessionId];
		set(sessionHistoryMutationOverlayByIdAtom, next);
		return;
	}
	if (current[input.sessionId] === input.kind) return;
	set(sessionHistoryMutationOverlayByIdAtom, {
		...current,
		[input.sessionId]: input.kind,
	});
});
/**
 * 会话切换时的滚动位置锚点（per-session，切走保存、切回恢复）。
 * 只保存「非跟底」状态：用户正在查看历史时切走，回来时停留在原位置；
 * 在底部跟流切走的会话不存锚点，切回继续跟底。
 */
export type SessionScrollAnchor = {
	/** 锚点行 id（timeline 内 [data-message-id] 的值：可能是 run id 或消息 id） */
	messageId: string;
	/** 锚点行的 meta.entryId：pi 预热重投影/pi 重启会改写投影 id 前缀，恢复时按它反查当前 id */
	entryId?: string;
	/** 锚点行顶边相对视口顶部的偏移（px），恢复时按此对齐 */
	offsetTop: number;
	/**
	 * 切走时实际用于裁剪 DOM 的尾部 agent-run 窗口轮数。恢复必须先采用相同窗口，
	 * 否则锚点行上方的文档高度会变化，按 offsetTop 恢复的位置会被截断或漂移。
	 * undefined 兼容热更新期间仍在内存中的旧锚点，恢复时退回基础窗口并按需扩窗。
	 */
	windowTurns?: number;
	/** 保存时间戳，防止乱序事件用陈旧状态覆盖新状态 */
	savedAt: number;
};

export const sessionScrollAnchorByIdAtom = atom<Record<string, SessionScrollAnchor>>({});

/** 锚点内容比较：messageId/offsetTop/windowTurns 相同视为未变化（savedAt 不计入）。
 *  滚动节流写入时，内容不变则跳过——引用稳定，订阅者不会因无效写入重渲染。 */
export function sameSessionScrollAnchor(a: SessionScrollAnchor | undefined, b: SessionScrollAnchor | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.messageId === b.messageId && a.entryId === b.entryId && a.offsetTop === b.offsetTop && a.windowTurns === b.windowTurns;
}

/** 保存/清除某会话的滚动锚点。anchor 为 null 时清除（如回到底部或会话关闭）。
 *  内容未变化时不写（保持引用稳定，避免订阅者无谓重渲染）；savedAt 乱序保护防陈旧覆盖。 */
export const saveSessionScrollAnchorAtom = atom(null, (get, set, input: { sessionId: string; anchor: SessionScrollAnchor | null }) => {
	const { sessionId, anchor } = input;
	set(sessionScrollAnchorByIdAtom, (prevMap) => {
		if (anchor === null) {
			if (!(sessionId in prevMap)) return prevMap;
			const nextMap = { ...prevMap };
			delete nextMap[sessionId];
			return nextMap;
		}
		const prev = prevMap[sessionId];
		// 内容未变化：跳过写入（引用稳定，订阅者零重渲染）
		if (prev && sameSessionScrollAnchor(prev, anchor)) return prevMap;
		// 乱序写入保护：只有更新（时间戳更新）才覆盖，防止陈旧滚动事件覆盖新保存。
		if (prev && prev.savedAt > anchor.savedAt) return prevMap;
		return { ...prevMap, [sessionId]: anchor };
	});
});
/**
 * 会话级独立流式正文（阶段1：独立存储）。
 * key: sessionId，value: { content, streaming }。
 * 流式期间 content 由 agents:text-stream 通道实时更新；
 * message_end 后由历史消息（sessionMessagesCacheAtom）接管，此处清空。
 */
export const streamingTextByIdAtom = atom<Record<string, { content: string; streaming: boolean; held?: boolean }>>({});
/**
 * Live 思考正文通道（镜像 text-stream）：key = msg-thinking-${assistantMessageId}。
 * ThinkingStep 叶子订阅；timeline 只订 liveThinkingIdBySessionAtom，避免 50ms 戳醒整树。
 */
export const streamingThinkingByIdAtom = atom<Record<string, StreamingThinkingEntry>>({});
/** 会话当前 live 思考段 id；仅 id 变化时通知 timeline 挂载点。 */
export const liveThinkingIdBySessionAtom = atom<Record<string, string>>({});

function sameStreamingThinkingEntry(a: StreamingThinkingEntry | undefined, b: StreamingThinkingEntry | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.sessionId === b.sessionId && a.text === b.text && a.startedAt === b.startedAt && a.endedAt === b.endedAt && a.streaming === b.streaming;
}

/** ThinkingStep 叶子按稳定 id 订阅，避免整表 tick 戳醒所有思考卡。
 *  jotai atomFamily 无自动 GC：释放数据条目时必须同步 .remove(id)，否则长跑泄漏。 */
export const streamingThinkingEntryByIdAtomFamily = atomFamily((thinkingId: string) => selectAtom(streamingThinkingByIdAtom, (map) => map[thinkingId], sameStreamingThinkingEntry));

/** Timeline 只订本会话 live id，不订思考正文。 */
export const liveThinkingIdBySessionIdAtomFamily = atomFamily((sessionId: string) => selectAtom(liveThinkingIdBySessionAtom, (map) => map[sessionId], Object.is));

/**
 * 本会话「是否存在活动正文流」（streamingTextByIdAtom 单槽 streaming 位）。
 * 输出稳定 boolean：流式期间 content 每 50ms 变化但 streaming 不变 → 引用不变 →
 * TurnRow 零额外重渲染；仅在流开始/结束时触发订阅者。
 * 用途：liveInterimId 要求活动流才挂 live——中间回复 message_end 后槽删（streaming=false）
 * 立即落回容器内 settled，消除「双失明消失窗口」（live 读空 + 容器内被跳过）。
 */
export const liveTextStreamingBySessionAtom = atomFamily((sessionId: string) => selectAtom(streamingTextByIdAtom, (map) => map[sessionId]?.streaming === true, Object.is));

/**
 * 本会话是否应继续挂 live 正文：推流中，或 done 已到、History 未到（held）。
 * 状态条只用 streaming 位；挂载用本 atom，避免交接空白。
 */
export const liveTextActiveBySessionAtom = atomFamily((sessionId: string) => selectAtom(streamingTextByIdAtom, (map) => map[sessionId]?.streaming === true || map[sessionId]?.held === true, Object.is));

/**
 * 本会话 live 思考是否仍在推流（只订 streaming 位，不订思考正文）。
 * 状态条用它区分「回复中」和「残留 liveThinkingId 的空窗」。
 */
export const liveThinkingStreamingBySessionAtom = atomFamily((sessionId: string) =>
	atom((get) => {
		const liveId = get(liveThinkingIdBySessionAtom)[sessionId];
		if (!liveId) return false;
		return get(streamingThinkingByIdAtom)[liveId]?.streaming === true;
	}),
);

/** 正文流条目同值比较：content 与 streaming 位都相等才算同值。 */
function sameStreamingTextEntry(a: { content: string; streaming: boolean; held?: boolean } | undefined, b: { content: string; streaming: boolean; held?: boolean } | undefined): boolean {
	if (a === b) return true;
	if (!a || !b) return false;
	return a.content === b.content && a.streaming === b.streaming && a.held === b.held;
}

/**
 * 单会话正文流内容（selectAtom 隔离）：其它会话的 token 更新不触发本订阅者。
 * 2026-10 性能修复：此前 LiveAnswerBody 直接订全局 streamingTextByIdAtom，
 * 分屏/多开时任一会话的流式 token 会拖着重渲染所有会话的正文实例。
 */
export const streamingTextBySessionIdAtomFamily = atomFamily((sessionId: string) => selectAtom(streamingTextByIdAtom, (map) => map[sessionId], sameStreamingTextEntry));

/** 与 streamingThinkingByIdAtom 条目成对释放，避免 atomFamily Map 无限增长。 */
export function disposeStreamingThinkingFamily(thinkingId: string) {
	streamingThinkingEntryByIdAtomFamily.remove(thinkingId);
}
/**
 * 「新一轮开始」信号：composer 发送成功后 +1（sessionId 键）。
 * TurnRow 订阅本会话 tick：变化时非最新轮强制收起（含用户手动展开的轮次）；
 * tick 低频（每轮一次），跨会话订阅经 family selectAtom 隔离。
 */
export const newTurnCollapseTickByIdAtom = atom<Record<string, number>>({});

export const bumpNewTurnCollapseTickAtom = atom(null, (_get, set, sessionId: string) => {
	set(newTurnCollapseTickByIdAtom, (prev) => ({
		...prev,
		[sessionId]: (prev[sessionId] ?? 0) + 1,
	}));
});

/** 单会话 tick 订阅（selectAtom 隔离：其它会话 bump 不触发本订阅者）。 */
export const newTurnCollapseTickBySessionIdAtomFamily = atomFamily((sessionId: string) => selectAtom(newTurnCollapseTickByIdAtom, (map) => map[sessionId] ?? 0, Object.is));

/**
 * 「发送置顶动画进行中」信号（sessionId 键）。
 *
 * 发送那一刻时间线会把刚发出的消息平滑滚到视口顶部（SendScrollPositioner）。同一窗口内
 * 若「新一轮折叠」把上一轮执行过程收掉，上方内容会整体骤缩数百到上千 px；动画中的视口
 * 补偿只能把 scrollTop 瞬间往回带，于是用户看到的是「先向上再向下」的来回滚动（2026-10
 * 反馈）。折叠信号因此等动画结束再消费（见 useTurnExecution），两者分属 controller 与
 * TurnRow 两棵子树，用 atom 传递而不是互相 import。
 */
export const sendPinAnimatingByIdAtom = atom<Record<string, boolean>>({});

export const sendPinAnimatingBySessionIdAtomFamily = atomFamily((sessionId: string) => selectAtom(sendPinAnimatingByIdAtom, (map) => map[sessionId] === true, Object.is));

/**
 * run 级「执行过程展开状态」的跨挂载记忆条目。
 * atTick 记录写入时的 newTurnCollapseTick：新一轮只压过早于它的旧记忆，
 * 从新一轮之后再次写入的记忆必须在下一次重挂载时恢复（用户明确的最新意愿）。
 */
export type RunStepsVisibleMemoryEntry = {
	/** 展开意愿：true = 展开，false = 明确折叠。 */
	visible: boolean;
	/** 写入时的新一轮 tick（session 级单调递增）。 */
	atTick: number;
	/** 写入时刻（epoch ms）。与 timeline 的「安静收起」时刻比较：收起发生在写入之后
	 * 说明这条意愿已被兑现（记忆只是没来得及清），挂载时不再恢复展开。 */
	atMs: number;
};

/**
 * run 级「执行过程展开状态」的跨挂载记忆（内存级，重启清零）。
 *
 * 背景（2026 用户反馈）：stepsVisible 原本是 TurnRow 组件局部 state，
 * 切会话再切回时 TurnRow 以 run.id 重挂载、状态归零——「正在看 / 手动打开的
 * 中间过程」被初始态折叠规则收掉。此 family 按 runId 记住最近一次明确的
 * 展开意愿：手动开合 / 流式展开写 { visible, atTick }，
 * 新一轮强制折叠 / 1.5s 自动收起后清除（delete）。
 *
 * 语义边界：
 * - 只看历史的会话从未展开过任何轮 → 无记忆 → 走初始态折叠（规则①不变）；
 * - 新一轮已发生且本轮非最新 → 挂载时直接折叠，早于此轮的记忆作废（规则④优先）；
 *   新一轮之后用户再次手动展开写下的记忆（atTick >= 当前 tick）必须恢复；
 * - 重启后 atom 清零 → 全部回到折叠（内存级，不持久化）。
 */
export const runStepsVisibleMemoryBySessionIdAtomFamily = atomFamily((sessionId: string) => atom<Record<string, RunStepsVisibleMemoryEntry>>({}));

/**
 * 过程组手风琴状态（契约 §3）。
 *
 * 定义在 atoms 而不是 hook 里，是为了保持依赖方向：**atom 拥有这个值**，hook 从 atoms 取类型，
 * 而不是 atoms 反向 import components（那会形成 atoms → components 的层级倒置）。
 * 归属与相邻的 `RunStepsVisibleMemoryEntry` 一致。
 *
 * 两条互不干扰的通道 + 一个抑制位：
 * - `autoGroupId`：自动通道，只有一个槽位，永远指向「最新的过程组」；新组出现时推进，旧自动组因此关闭；
 * - `manualGroupIds`：手动通道，用户亲手点开的组集合，新内容不影响它们；
 * - `suppressedAutoGroupId`：用户主动点关的那个自动组，「我就是要它关着」优先于自动展开。
 */
export interface ProcessGroupOpenState {
	/** 自动通道：只有一个槽位，永远指向「最新的组」。新组出现时推进到新组，旧自动组因此关闭。 */
	readonly autoGroupId: string | undefined;
	/** 手动通道：用户亲手点开的组，互不干扰；新内容不影响它们。 */
	readonly manualGroupIds: readonly string[];
	/**
	 * 抑制位：用户**主动点关**的那个自动组 id。
	 *
	 * 为什么必须进状态、不能放组件 ref：ref 不会被「大折叠栏关闭（reset）」清掉，
	 * 于是重开折叠栏时最新组的同步会被同值短路吃掉，**最新组不再自动展开**（已复现的缺陷）。
	 * 放进状态后「关闭 → 清空」天然解除抑制，整条行为也能用纯函数验证。
	 */
	readonly suppressedAutoGroupId: string | undefined;
}

/**
 * 过程组手风琴状态，按 sessionId → runId 两级记忆（内存级，不持久化，与 runStepsVisibleMemory 同规约）。
 *
 * 只记「展开意愿」（自动槽 + 手动集合）；组内卡片的展开态随 Radix 子树卸载自然销毁（契约 §3）。
 */
export const processGroupOpenBySessionIdAtomFamily = atomFamily((sessionId: string) => atom<Record<string, ProcessGroupOpenState>>({}));
