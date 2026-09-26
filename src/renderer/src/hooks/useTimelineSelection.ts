import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { MAX_QUOTE_CHARS, QUOTE_EXCLUDED_SELECTOR, isQuotableRange } from "../components/session/timeline/selectionToolbarPolicy";

export type TimelineSelectionQuote = {
	text: string;
	messageId: string;
	rect: { top: number; left: number; width: number; height: number };
};

/** 从 DOM 节点向上找所属消息 id；不在容器内返回 null。 */
function resolveMessageId(node: Node | null, container: HTMLElement): string | null {
	if (!node) return null;
	const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	if (!element || !container.contains(element)) return null;
	return element.closest("[data-message-id]")?.getAttribute("data-message-id") ?? null;
}

function isExcluded(node: Node | null): boolean {
	if (!node) return false;
	const element = node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
	if (!element) return false;
	return Boolean(element.closest(QUOTE_EXCLUDED_SELECTOR));
}

/**
 * 时间线划选监听：选区完全落在同一条消息内且未命中排除区域时，
 * 产出 { 文本快照, 来源消息 id, 选区矩形 } 供浮层按钮使用。
 *
 * 行为对齐 assistant-ui/Codex（2026-09 调研）：
 * - selectionchange 只负责"收起"（拖选中不闪浮层）；pointerup/keyup 后延迟 ~60ms 评估展示；
 * - 容器滚动即隐藏（fixed 定位会随滚动失效）；Escape 收起。
 *
 * 展示后锁定（2026-12 流式修复）：浮层一旦展示，selectionchange 的塌陷不再隐藏——
 * agent 输出中 React 重挂文本节点会把浏览器选区收搞（isCollapsed），未锁定时浮层
 * 在流式期间会被随机踢掉（hover 时消失）。快照在展示那刻已定格，保持展示不影响
 * 正确性；真正的用户交互（重新按压 / Escape / 点击按钮本身）才收起。
 *
 * 锁定期间的滚动也不再隐藏，而是跟随选区重新定位（2026-12）：思考/正文流式增高时
 * stick-to-bottom 引擎每帧自动贴底，每次都是 scroll 事件——旧逻辑「滚动即隐藏」会让
 * 浮层弹出后下一帧就被踢掉，流式期间划选永远「没反应」。改为用锁存的 Range 重取
 * rect 平移浮层；Range 失效（选区被挤没，rect 面积为 0）才真正隐藏。
 */
export function useTimelineSelection(containerRef: RefObject<HTMLElement | null>): { quote: TimelineSelectionQuote | null; clear: () => void } {
	const [quote, setQuote] = useState<TimelineSelectionQuote | null>(null);
	const evaluateTimerRef = useRef(0);
	/** 浮层已展示且快照已定格：流式引起的选区塌陷不再收起，见组件头注释。 */
	const lockedRef = useRef(false);
	/** 锁定时锁存的选区 Range：滚动跟随用（重取 rect），失效即隐藏。 */
	const lockedRangeRef = useRef<Range | null>(null);

	const clear = useCallback(() => {
		lockedRef.current = false;
		lockedRangeRef.current = null;
		setQuote(null);
	}, []);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const currentSelection = () => window.getSelection();

		// 拖选过程中 selectionchange 连续触发：折叠立即收起，展开中不动（避免闪烁）。
		// 锁定期间一律忽略：此时塌陷大概率是流式 DOM 变更挤掉选区，不是用户收起。
		const onSelectionChange = () => {
			if (lockedRef.current) return;
			const selection = currentSelection();
			if (!selection || selection.isCollapsed) setQuote(null);
		};

		// 新的按压 = 用户开始新交互：解除锁定并收起（点击浮层按钮自身除外，
		// 否则 pointerdown 先收起、click 到来时 quote 已变 null，插入会落空）。
		const onPointerDown = (event: PointerEvent) => {
			if (event.target instanceof Element && event.target.closest("[data-quote-toolbar]")) return;
			lockedRef.current = false;
			lockedRangeRef.current = null;
			setQuote(null);
		};

		const evaluate = () => {
			const selection = currentSelection();
			if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
				setQuote(null);
				return;
			}
			const range = selection.getRangeAt(0);
			const text = selection.toString();
			const ok = isQuotableRange({
				messageIdA: resolveMessageId(range.startContainer, container),
				messageIdB: resolveMessageId(range.endContainer, container),
				excludedA: isExcluded(range.startContainer),
				excludedB: isExcluded(range.endContainer),
				text,
				maxLength: MAX_QUOTE_CHARS,
			});
			if (!ok) {
				lockedRef.current = false;
				lockedRangeRef.current = null;
				setQuote(null);
				return;
			}
			const rect = range.getBoundingClientRect();
			lockedRef.current = true;
			lockedRangeRef.current = range.cloneRange();
			setQuote({
				text: text.trim(),
				messageId: resolveMessageId(range.startContainer, container) ?? "",
				rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
			});
		};

		// pointerup/键盘选区结束后再评估：给浏览器一点时间稳定最终选区
		const scheduleEvaluate = () => {
			window.clearTimeout(evaluateTimerRef.current);
			evaluateTimerRef.current = window.setTimeout(evaluate, 60);
		};
		const onPointerUp = (event: PointerEvent) => {
			if (event.button !== 0) return;
			scheduleEvaluate();
		};
		const onKeyUp = (event: KeyboardEvent) => {
			// Shift+方向键 / Ctrl+A 等键盘扩选；Escape 只负责收起
			if (event.key === "Escape") {
				lockedRef.current = false;
				lockedRangeRef.current = null;
				setQuote(null);
				return;
			}
			if (event.shiftKey || event.key === "a" || event.key === "A") scheduleEvaluate();
		};
		// 锁定期间滚动跟随选区重新定位（stick-to-bottom 自动贴底每帧都是 scroll，
		// 不能按旧逻辑隐藏）；未锁定时滚动才隐藏（fixed 定位随滚动失真，旧语义不变）。
		const onScroll = () => {
			if (!lockedRef.current) {
				setQuote(null);
				return;
			}
			const range = lockedRangeRef.current;
			if (!range) {
				lockedRef.current = false;
				setQuote(null);
				return;
			}
			const rect = range.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) {
				// 选区被流式 DOM 变更挤没：解除锁定并隐藏
				lockedRef.current = false;
				lockedRangeRef.current = null;
				setQuote(null);
				return;
			}
			setQuote((current) => (current ? { ...current, rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height } } : current));
		};

		document.addEventListener("selectionchange", onSelectionChange);
		document.addEventListener("pointerdown", onPointerDown);
		container.addEventListener("pointerup", onPointerUp);
		document.addEventListener("keyup", onKeyUp);
		// capture：捕获内层滚动容器（消息列自身可滚）
		container.addEventListener("scroll", onScroll, true);
		window.addEventListener("resize", onScroll);

		return () => {
			window.clearTimeout(evaluateTimerRef.current);
			document.removeEventListener("selectionchange", onSelectionChange);
			document.removeEventListener("pointerdown", onPointerDown);
			container.removeEventListener("pointerup", onPointerUp);
			document.removeEventListener("keyup", onKeyUp);
			container.removeEventListener("scroll", onScroll, true);
			window.removeEventListener("resize", onScroll);
		};
	}, [containerRef]);

	return { quote, clear };
}
