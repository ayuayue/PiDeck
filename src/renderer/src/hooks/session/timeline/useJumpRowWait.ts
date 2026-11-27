import type { RefObject } from "react";
import { useCallback, useEffect, useRef } from "react";
import { JUMP_TARGET_WAIT_FRAMES, jumpWaitSelector, planJumpTargetWait, shouldExpandWhileWaiting } from "../../../components/session/timeline/jumpTargetWait";
import { logFromRenderer } from "../../../utils/rendererLog";

/** 被等待的行：命中时把落位所需的一切交回调用方。 */
export interface JumpRowHit {
	/** 时间线滚动容器（落位动作的基准）。 */
	timeline: HTMLElement;
	row: HTMLElement;
	entryId: string;
	/** 归一后的投影消息 id；目标还没进数据时为 null。 */
	resolvedId: string | null;
	frames: number;
}

export interface JumpRowWaitOptions {
	/** 每帧都要读到**最新**消息表：rAF 跨多次渲染，闭包里的数组是发起时的快照。 */
	messagesRef: RefObject<readonly { id: string }[]>;
	/** 入口 id（可能是文件条目 id）→ 当前消息表下标，找不到为 -1。 */
	resolveIndex: (list: readonly { id: string }[], entryId: string) => number;
	/** 行已挂上：调用方负责落位、高亮、清 pin、结束挂起。 */
	onFound: (hit: JumpRowHit) => void;
	/** 帧数用尽仍没挂上：调用方负责让状态机重跑一次并报真实原因。inData 分出「认不出」与「挂不出来」。 */
	onExhausted: (info: { entryId: string; frames: number; inData: boolean }) => void;
	/** 目标进数据却不在渲染窗口时，有界推进窗口。 */
	expandWindowBatched: (turns?: number) => void;
	maxFrames?: number;
}

/**
 * 取页成功后自己盯 DOM，直到目标行挂上。
 *
 * 为什么不靠 pendingJump effect 重跑：它依赖 combinedMessages 的**快照**，缓存写入与快照
 * 错位时不重跑。日志实证（2026-11-25 数学组2，点 b6a20c25）：取页 outcome=exact 之后
 * 1.17 秒没有任何 tick / settle，用户再点一次才发现数据到了 —— 表现是「要点好几次」。
 *
 * 与状态机各行其路是故意的：状态机靠 effect 重跑（可能错过），这里靠 rAF 直接量 DOM。
 * 两者都命中同一行时，第二次只是「已在正确位置再落一次」—— settle 见 drift≈0 立刻收敛，
 * highlight 幂等。不做去重的理由：去重需要跨渲染同步的锁，收益不抵风险。
 */
export function useJumpRowWait(options: JumpRowWaitOptions) {
	const { messagesRef, resolveIndex, onFound, onExhausted, expandWindowBatched } = options;
	const maxFrames = options.maxFrames ?? JUMP_TARGET_WAIT_FRAMES;
	const frameRef = useRef<number | null>(null);
	const cancel = useCallback(() => {
		if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
		frameRef.current = null;
	}, []);
	// 切会话 / 卸载时别让上一段循环继续改写新会话的视口。
	useEffect(() => cancel, [cancel]);
	const waitForRow = useCallback(
		(timeline: HTMLElement, entryId: string, isCurrent: () => boolean = () => true) => {
			cancel();
			let frames = 0;
			let expandAttempts = 0;
			/**
			 * 归一结果缓存：一旦找到投影 id 就不再每帧扫全表（500~2000 条 × 120 帧是白烧）。
			 * 只在「按缓存 id 查不到行」时重扫一次 —— 那说明数据换了一批（补页/重载）。
			 */
			let resolvedCache: string | null = null;
			const tick = () => {
				frameRef.current = null;
				if (!isCurrent()) return;
				let resolvedIndex = -1;
				if (resolvedCache === null) {
					const list = messagesRef.current ?? [];
					resolvedIndex = resolveIndex(list, entryId);
					resolvedCache = resolvedIndex >= 0 ? (list[resolvedIndex]?.id ?? null) : null;
				}
				const resolvedId = resolvedCache;
				const row = timeline.querySelector(jumpWaitSelector({ entryId, resolvedId })) as HTMLElement | null;
				// 缓存 id 查不到：数据可能刚被替换（补页合并），下一帧重扫一次再判。
				if (!row && resolvedId !== null) {
					resolvedCache = null;
					resolvedIndex = -1;
				}
				// inData：本帧能不能在当前消息表里认出目标。认不出 = 补页与扩窗都帮不上它，
				// 只能如实交回状态机（它按 hasMorePages/pageOutcome 给可诊断的原因）。
				const inData = resolvedCache !== null || resolvedIndex >= 0;
				const step = planJumpTargetWait({ found: Boolean(row), frames, inData });
				if (step.kind === "found" && row) {
					// following：目标之后还有几条消息。0 = 它就是最后一条 ——「看不到下一条」时先看这个数，
					// 分清「本来没有」与「有但没挂出来」（2026-11-26 用户反馈）。
					const list = messagesRef.current ?? [];
					const at = resolvedId ? list.findIndex((message) => message.id === resolvedId) : -1;
					logFromRenderer("info", "jump", "row-found", { entryId, resolvedId, frames, following: at >= 0 ? list.length - 1 - at : -1, messages: list.length });
					onFound({ timeline, row, entryId, resolvedId, frames });
					return;
				}
				if (step.kind === "exhausted" || frames >= maxFrames) {
					onExhausted({ entryId, frames, inData });
					return;
				}
				// 数据里有目标、DOM 里没有 = 目标轮不在渲染窗口。光等挂不出来，有界推进窗口。
				if (shouldExpandWhileWaiting({ frames, attempts: expandAttempts, inData })) {
					expandAttempts += 1;
					logFromRenderer("info", "jump", "row-expand", { entryId, resolvedId, frames, expandAttempts });
					expandWindowBatched(2);
				}
				frames += 1;
				frameRef.current = requestAnimationFrame(tick);
			};
			frameRef.current = requestAnimationFrame(tick);
		},
		[cancel, expandWindowBatched, maxFrames, messagesRef, onExhausted, onFound, resolveIndex],
	);
	return { waitForRow, cancel };
}
