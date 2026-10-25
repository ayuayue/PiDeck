import { useCallback, useEffect, useRef, useState } from "react";
import { classifySmoothStreamChange } from "./smoothStreamContent";

/**
 * useSmoothStream - ???????? Hook????????
 *
 * ????????????????????????? Cherry Studio ????
 *
 * ?????
 * 1. ?????? startsWith ???????? Intl.Segmenter ????????
 *    ?Intl.Segmenter ??????/??/??????????
 * 2. requestAnimationFrame ???????
 * 3. ?????????????????????/divisor?????????
 * 4. ?????????????????? dump???????
 *
 * ?????
 * - ???"??"?????? atom/???????????/????????
 * - ? hook?????? UI ??? timeline/turn ???????
 *
 * ?????Pideck ????streamdown ?????????????????????
 * ?? rAF ??????????? minDelay?? 24/33ms???? divisor?
 */

interface UseSmoothStreamOptions {
	/** ????????? chunk ????????? */
	content: string;
	/** ????????? */
	isStreaming: boolean;
	/**
	 * 禁用平滑（折叠态用）：直接同步返回 content，不启动 rAF 打字机。
	 * 折叠态内容不可见，逐字推进是纯浪费；展开瞬间以全文呈现（与打字机追平后的观感一致）。
	 */
	disabled?: boolean;
	/** ???????ms???? 8ms?~120Hz ??????? 16ms ??? */
	minDelay?: number;
	/** ??????????? / divisor = ???????????? */
	streamingDivisor?: number;
	/** ????????????????? dump? */
	drainDivisor?: number;
	/** ?????????????????? */
	maxStepPerFrame?: number;
	/** ???????????????? */
	maxDrainStepPerFrame?: number;
}

interface UseSmoothStreamReturn {
	/** ???????? */
	displayedContent: string;
}

/** ????????????????????????? */
const segmenter = new Intl.Segmenter(["en-US", "zh-CN", "zh-TW", "ja-JP", "ko-KR", "de-DE", "fr-FR", "es-ES", "pt-PT", "ru-RU"]);

/**
 * 流式空转停帧阈值（ms）：队列空且超过该时长没有新 delta（流式通道卡死/中断、
 * run 状态未正确收尾）时停掉 60fps rAF 空转，避免烧 CPU；新 delta 到达时
 * content effect 会重新唤醒打字机。
 */
const IDLE_STOP_MS = 3000;

function segmentText(text: string): string[] {
	return Array.from(segmenter.segment(text)).map((s) => s.segment);
}

export function useSmoothStream({ content, isStreaming, disabled = false, minDelay = 16, streamingDivisor = 5, drainDivisor = 3, maxStepPerFrame = 10, maxDrainStepPerFrame = 12 }: UseSmoothStreamOptions): UseSmoothStreamReturn {
	const [displayedContent, setDisplayedContent] = useState(content);

	// 长文本降频（2026-08 内存/CPU 治理）：每帧 DOM 更新（文本节点替换 → layout）
	// 成本随文本长度增长，逐字 60fps 会把主线程排满 → IPC 消息积压 → 渲染进程
	// 原生内存 GB 级爬升。按长度分级降频：8K 内保持打字机手感；8K+ 降到 16ms
	// （~37fps）；64K+ 降到 33ms（~30fps）。步进上限同步放大，保证排空速率
	// （step×fps）始终高于 LLM 输出速率（100-300 字/s），队列不会越积越长。
	// 调用方显式传入的参数仍是下限之上的覆盖（Math.max 取大）。
	const effectiveMinDelay = Math.max(minDelay, content.length > 64_000 ? 33 : content.length > 8_000 ? 16 : 8);
	const effectiveMaxStepPerFrame = Math.max(maxStepPerFrame, content.length > 8_000 ? 12 : 6);

	// ????????
	const chunkQueueRef = useRef<string[]>([]);
	// rAF ID
	const rafRef = useRef<number | null>(null);
	// ???? UI ???
	const displayedRef = useRef(content);
	// ??????????????? delta?
	const prevContentRef = useRef(content);
	// ??????
	const lastRenderTimeRef = useRef(0);
	// ?????
	const streamDoneRef = useRef(!isStreaming);
	streamDoneRef.current = !isStreaming;
	// 最近一次内容变更时刻：空转停帧判定用（见 renderLoop 空队列分支）
	const lastChunkAtRef = useRef(performance.now());
	// 稳定引用 renderLoop：content effect 需要重启打字机，但 renderLoop 声明在后
	// （TDZ），且引用稳定，不参与 effect 依赖。
	const renderLoopRef = useRef<(currentTime: number) => void>(() => {});

	// ??????? delta ???
	useEffect(() => {
		const prevContent = prevContentRef.current;
		const newContent = content;
		if (newContent === prevContent) return;

		// 折叠态（disabled）：只追平 prevContent 引用，不 push chunk 不 setState，
		// 内容不可见时连「增量入队 + 重渲染」都省掉。
		if (disabled) {
			prevContentRef.current = newContent;
			displayedRef.current = newContent;
			return;
		}

		const change = classifySmoothStreamChange(prevContent, displayedRef.current, newContent);
		if (change.kind === "append") {
			const chars = segmentText(change.delta);
			chunkQueueRef.current.push(...chars);
			// 空转停帧后新 delta 到达：重启打字机
			if (!rafRef.current) renderLoopRef.current(performance.now());
		} else if (change.kind === "rewind") {
			// 权威文本真回退：钳到更短前缀，不清已显示的无关尾巴以外的字。
			chunkQueueRef.current = [];
			displayedRef.current = change.text;
			setDisplayedContent(change.text);
		} else if (change.kind === "replace") {
			chunkQueueRef.current = [];
			displayedRef.current = change.text;
			setDisplayedContent(change.text);
		} else if (change.kind === "ignore") {
			// 更短后缀快照：不改 prevContent，下一帧真实追加仍相对完整文本判定。
			return;
		}
		prevContentRef.current = newContent;
		lastChunkAtRef.current = performance.now();
	}, [content, disabled]);

	// ?????????????????????? dump ???? rAF ?????
	useEffect(() => {
		if (isStreaming) return;
		// 流式结束（会话/回合收口）：立即收口，不再逐字排空——
		// 打字机只在流式期间运行，「会话结束后思考打字机不触发」（2026-12 兼容期）。
		// 取消在途 rAF、清空队列、直接显示全文（终态文本权威）。
		if (rafRef.current) {
			cancelAnimationFrame(rafRef.current);
			rafRef.current = null;
		}
		chunkQueueRef.current = [];
		displayedRef.current = content;
		prevContentRef.current = content;
		setDisplayedContent(content);
	}, [isStreaming, content]);

	// ????
	const renderLoop = useCallback(
		(currentTime: number) => {
			const queue = chunkQueueRef.current;
			if (queue.length === 0) {
				if (streamDoneRef.current) {
					// ??? + ?????????????
					if (displayedRef.current !== prevContentRef.current) {
						displayedRef.current = prevContentRef.current;
						setDisplayedContent(displayedRef.current);
					}
					rafRef.current = null;
					return;
				}
				// 流式仍在但无新内容：超过空转阈值（IDLE_STOP_MS 无新 delta）则停帧，
				// 防止 run 卡死/通道中断时 60fps 空转烧 CPU；新 delta 到达时
				// content effect 会经 renderLoopRef 重新唤醒。
				if (performance.now() - lastChunkAtRef.current > IDLE_STOP_MS) {
					rafRef.current = null;
					return;
				}
				// 正常等待下一批 delta：保持挂帧
				rafRef.current = requestAnimationFrame(renderLoop);
				return;
			}

			if (currentTime - lastRenderTimeRef.current < effectiveMinDelay) {
				rafRef.current = requestAnimationFrame(renderLoop);
				return;
			}
			lastRenderTimeRef.current = currentTime;

			// ?????????????? /streamingDivisor ??????????
			// ??? /drainDivisor ????????? maxStep ??????
			// ????????? delta ??? LLM ??? queue ???count ??
			// ? queue ??????????? ? maxStep????????
			const divisor = streamDoneRef.current ? drainDivisor : streamingDivisor;
			const maxStep = streamDoneRef.current ? maxDrainStepPerFrame : effectiveMaxStepPerFrame;
			const count = Math.min(Math.max(1, Math.floor(queue.length / divisor)), maxStep);
			const chars = queue.splice(0, count);
			displayedRef.current += chars.join("");
			setDisplayedContent(displayedRef.current);

			if (queue.length > 0 || !streamDoneRef.current) {
				rafRef.current = requestAnimationFrame(renderLoop);
			} else {
				// ????? + ??????????????
				if (displayedRef.current !== prevContentRef.current) {
					displayedRef.current = prevContentRef.current;
					setDisplayedContent(displayedRef.current);
				}
				rafRef.current = null;
			}
		},
		[effectiveMinDelay, effectiveMaxStepPerFrame, streamingDivisor, drainDivisor, maxDrainStepPerFrame],
	);
	renderLoopRef.current = renderLoop;

	// ??/???????????????????????
	useEffect(() => {
		if (disabled) return; // 折叠态：不启动 rAF，避免不可见内容逐字推进
		if ((isStreaming || chunkQueueRef.current.length > 0) && !rafRef.current) {
			rafRef.current = requestAnimationFrame(renderLoop);
		}
		return () => {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [isStreaming, renderLoop, disabled]);

	// disabled：同步返回最新内容（展开瞬间全文立现，与打字机追平后观感一致）
	if (disabled) return { displayedContent: content };

	return { displayedContent };
}
