import { useCallback, useEffect, useRef, useState } from "react";
import { classifySmoothStreamChange, pushGraphemes } from "./smoothStreamContent";

/**
 * useSmoothStream —— 把「后端一次性到达的一大段文本」摊成逐字显示。
 *
 * 设计思路沿用 Cherry Studio 的打字机。
 *
 * 四步：
 * 1. 变更分类：用 startsWith 判断是追加 / 回退 / 替换，追加部分按 Intl.Segmenter 切字符
 *    （Intl.Segmenter 保证 emoji、组合字、CJK 不会被切坏）；
 * 2. 排队：请求动画帧（rAF）驱动，不按固定定时器；
 * 3. 每帧步进量 = 队列长度 / divisor，再夹到上限，队列越长追得越快；
 * 4. 收口：流式结束立即直出全文，不再逐字排空。
 *
 * 边界：
 * - 它只负责「显示进度」，不负责解码：上游 atom 给什么文本就显示什么前缀；
 * - 本 hook 只被 UI 层（timeline / turn）调用，不参与数据层。
 *
 * 与 PiDeck 既有 streamdown 的区别：那边是「冻结前缀 + 尾部重解析」，
 * 这边只管「这一帧露几个字」，两者叠加，minDelay 的取值口径也不同。
 */

interface UseSmoothStreamOptions {
	/** 目标全文（上游给的完整文本，每次变化都是一个 chunk） */
	content: string;
	/** 是否仍在流式 */
	isStreaming: boolean;
	/**
	 * 禁用平滑（折叠态用）：直接同步返回 content，不启动 rAF 打字机。
	 * 折叠态内容不可见，逐字推进是纯浪费；展开瞬间以全文呈现（与打字机追平后的观感一致）。
	 */
	disabled?: boolean;
	/**
	 * 暂停推进（非激活分屏 / 窗口不可见）：停止 rAF、清空待显示队列，画面冻结在当前位置。
	 * 与 disabled 的区别：disabled 是「内容不可见，连文本都不用更新」；paused 是
	 * 「内容仍可见，但先不推进动画」，数据照常更新。
	 *
	 * 恢复语义：不重放暂停期间积压的逐字动画，直接对齐到最新权威文本；仍在流式时
	 * 后续新 delta 继续走打字机。这样切回分屏不会看到几分钟的旧文字慢慢追。
	 */
	paused?: boolean;
	/**
	 * 可见但未聚焦（非焦点分屏）：停 rAF 打字机，文本随上游 1s 粗刷新直接跳变。
	 * 与 paused 的区别：paused 是完全冻结（窗口不可见）；background 仍然更新，
	 * 只是不做逐字动画，避免可见分屏看起来停住。
	 */
	background?: boolean;
	/** 两帧之间最短间隔（ms）。默认 16ms≈60Hz；长文本会再降频，见下方 effectiveMinDelay */
	minDelay?: number;
	/** 流式期的分母：队列越长步进越大。步进 = 队列长度 / divisor */
	streamingDivisor?: number;
	/** 收口期的分母（流已结束、队列还在排空） */
	drainDivisor?: number;
	/** 流式期单帧步进上限（字） */
	maxStepPerFrame?: number;
	/** 收口期单帧步进上限（字） */
	maxDrainStepPerFrame?: number;
}

interface UseSmoothStreamReturn {
	/** 当前应显示的文本前缀 */
	displayedContent: string;
}

/** 流式仍活跃但长时间没有新内容时的停帧阈值（防通道中断后 60fps 空转烧 CPU）。 */
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

export function useSmoothStream({ content, isStreaming, disabled = false, paused = false, background = false, minDelay = 16, streamingDivisor = 5, drainDivisor = 3, maxStepPerFrame = 10, maxDrainStepPerFrame = 12 }: UseSmoothStreamOptions): UseSmoothStreamReturn {
	const [displayedContent, setDisplayedContent] = useState(content);

	// 长文本降频（2026-08 内存/CPU 治理）：每帧 DOM 更新（文本节点替换 → layout）
	// 成本随文本长度增长，逐字 60fps 会把主线程排满 → IPC 消息积压 → 渲染进程
	// 原生内存 GB 级爬升。按长度分级降频：8K 内保持打字机手感；8K+ 降到 16ms
	// （~37fps）；64K+ 降到 33ms（~30fps）。步进上限同步放大，保证排空速率
	// （step×fps）始终高于 LLM 输出速率（100-300 字/s），队列不会越积越长。
	// 调用方显式传入的参数仍是下限之上的覆盖（Math.max 取大）。
	const effectiveMinDelay = Math.max(minDelay, content.length > 64_000 ? 33 : content.length > 8_000 ? 16 : 8);
	const effectiveMaxStepPerFrame = Math.max(maxStepPerFrame, content.length > 8_000 ? 12 : 6);

	// 待显示字符队列（已按 grapheme 切开）
	const chunkQueueRef = useRef<string[]>([]);
	// rAF ID
	const rafRef = useRef<number | null>(null);
	// 已提交给 UI 的文本
	const displayedRef = useRef(content);
	// 上一版权威文本（用于下次算 delta）
	const prevContentRef = useRef(content);
	// 暂停/后台态：rAF 回调里同步读取，切换瞬间已排队的旧帧不再推进。
	const pausedRef = useRef(paused);
	pausedRef.current = paused;
	const backgroundRef = useRef(background);
	backgroundRef.current = background;
	// 最新权威文本：恢复时一次性对齐用（不依赖 effect 闭包里的 content）。
	const contentRef = useRef(content);
	contentRef.current = content;
	// 上次实际渲染的时刻（minDelay 闸门）
	const lastRenderTimeRef = useRef(0);
	// 流式是否已结束（renderLoop 里读它决定 divisor / maxStep）
	const streamDoneRef = useRef(!isStreaming);
	streamDoneRef.current = !isStreaming;
	// 最近一次内容变更时刻：空转停帧判定用（见 renderLoop 空队列分支）
	const lastChunkAtRef = useRef(performance.now());
	// 稳定引用 renderLoop：content effect 需要重启打字机，但 renderLoop 声明在后
	// （TDZ），且引用稳定，不参与 effect 依赖。
	const renderLoopRef = useRef<(currentTime: number) => void>(() => {});

	// 计算 delta 并入队
	useEffect(() => {
		const prevContent = prevContentRef.current;
		const newContent = content;
		if (newContent === prevContent) return;

		// 折叠态（disabled）：只追平 prevContent 引用，不 push chunk 不 setState，
		// 内容不可见时连「增量入队 + 重渲染」都省掉。
		// 暂停态（paused）：数据继续更新 prevContent，但画面冻结在当前位置；
		// 恢复时由下方 resume effect 一次性对齐到最新文本，不重放积压动画。
		if (disabled || paused) {
			prevContentRef.current = newContent;
			if (disabled) displayedRef.current = newContent;
			lastChunkAtRef.current = performance.now();
			return;
		}

		// 可见但未聚焦（非焦点分屏）：上游 atom 已按 1s 粗采样，这里直接跳变，
		// 不做逐字动画、不建队列。既能看到进度，又不让 delta 驱动整栏逐帧重排。
		if (background) {
			chunkQueueRef.current = [];
			prevContentRef.current = newContent;
			displayedRef.current = newContent;
			lastChunkAtRef.current = performance.now();
			setDisplayedContent(newContent);
			return;
		}

		// 流已结束（isStreaming=false）：不进打字机。同一提交里「收口」effect 会把全文
		// 直接 dump，且 settled 展示只读 props.text（MarkdownStream），displayedContent
		// 根本不参与——这里入队是纯浪费；更糟的是大 delta（点「展开全文」把预览一次性
		// 换成 205KB 全文）segmentText 出十几万 grapheme，曾经 spread 进 push 直接爆栈
		// （RangeError: Maximum call stack size exceeded，2026-10-27 事故）。
		if (streamDoneRef.current) {
			prevContentRef.current = newContent;
			return;
		}

		const change = classifySmoothStreamChange(prevContent, displayedRef.current, newContent);
		if (change.kind === "append") {
			const chars = segmentText(change.delta);
			// 入队必须走 pushGraphemes：流式期一次异常大的 flush 同样会撑爆 spread 实参上限。
			pushGraphemes(chunkQueueRef.current, chars);
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
	}, [content, disabled, paused, background]);

	// 流式结束：取消在途 rAF，直接 dump 全文（不再逐字排空）
	useEffect(() => {
		// 暂停中不 dump：画面必须停在暂停瞬间，等恢复 effect 一次性对齐。
		// 否则「流在暂停期间结束」会把全文直接铺出来，暂停等于没生效。
		// 后台可见栏同理：让 1s 粗刷新自然对齐，避免 settle 时在非焦点栏做全量渲染。
		if (isStreaming || paused || background) return;
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
	}, [isStreaming, content, paused, background]);

	// 暂停/后台/折叠切换：不重放积压的逐字动画，直接对齐到最新权威文本。
	// - 恢复（active）：一次性追平后，后续新 delta 继续走打字机；
	// - 进入 background：停 rAF、丢掉队列，先显示当前全文，之后由 content effect
	//   随 1s 粗刷新直接跳变；
	// - paused/disabled：这里不动，保持冻结。
	useEffect(() => {
		if (disabled || paused) return;
		const latest = contentRef.current;
		chunkQueueRef.current = [];
		prevContentRef.current = latest;
		displayedRef.current = latest;
		lastChunkAtRef.current = performance.now();
		setDisplayedContent(latest);
	}, [disabled, paused, background]);

	// 主循环
	const renderLoop = useCallback(
		(currentTime: number) => {
			// 暂停/后台：停止推进。恢复由 mode effect 重新挂帧。
			// 这里再判一次是因为切换可能发生在已排队的 rAF 回调之前。
			if (pausedRef.current || backgroundRef.current) {
				rafRef.current = null;
				return;
			}
			const queue = chunkQueueRef.current;
			if (queue.length === 0) {
				if (streamDoneRef.current) {
					// 队列空 + 流已结束：与权威文本对齐后停帧
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

			// 流式期用 streamingDivisor，收口期用 drainDivisor（收口要更快追上全文）
			// 步进再夹到 maxStep 上限：队列再长也不能一帧喷完，否则等于没有打字机
			// 队列长度随 LLM 产出增长，步进随之变大，保证排空速率 > 产出速率
			// （否则队列越积越长，显示永远滞后）
			const divisor = streamDoneRef.current ? drainDivisor : streamingDivisor;
			const maxStep = streamDoneRef.current ? maxDrainStepPerFrame : effectiveMaxStepPerFrame;
			const count = Math.min(Math.max(1, Math.floor(queue.length / divisor)), maxStep);
			const chars = queue.splice(0, count);
			displayedRef.current += chars.join("");
			setDisplayedContent(displayedRef.current);

			if (queue.length > 0 || !streamDoneRef.current) {
				rafRef.current = requestAnimationFrame(renderLoop);
			} else {
				// 队列空 + 流已结束：与权威文本对齐后停帧
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

	// 启停 rAF：流式中或有积压就挂帧，卸载时取消
	useEffect(() => {
		if (disabled || paused || background) return; // 折叠/暂停/后台：不启动 rAF
		if ((isStreaming || chunkQueueRef.current.length > 0) && !rafRef.current) {
			rafRef.current = requestAnimationFrame(renderLoop);
		}
		return () => {
			if (rafRef.current) {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = null;
			}
		};
	}, [isStreaming, renderLoop, disabled, paused, background]);

	// disabled：同步返回最新内容（展开瞬间全文立现，与打字机追平后观感一致）
	if (disabled) return { displayedContent: content };

	return { displayedContent };
}
