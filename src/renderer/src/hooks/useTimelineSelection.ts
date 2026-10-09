import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { MAX_QUOTE_CHARS, QUOTE_EXCLUDED_SELECTOR, computeToolbarPosition, isQuotableRange, selectionIntegrityKey } from "../components/session/timeline/selectionToolbarPolicy";

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
 * 锁定期间的滚动不再隐藏，而是逐帧跟随选区重新定位（2026-12）：思考/正文流式增高时
 * stick-to-bottom 引擎每帧自动贴底，每次都是 scroll 事件——旧逻辑「滚动即隐藏」会让
 * 浮层弹出后下一帧就被踢掉，流式期间划选永远「没反应」。跟随走 rAF 循环直写浮层样式
 * （2026-12 三次修复）：scroll → setState → React 重渲染链比浏览器滚动帧晚一拍，流式
 * 期间肉眼可见「慢半拍」；rAF 与滚动引擎同帧节拍且绕开 React，还免去每帧重渲染时间线。
 *
 * 跟随测量的必须是实时选区而非 Range 克隆（2026-12 四次修复，脱节根因）：流式重挂文本
 * 节点时，浏览器会把「真选区」重新锚定到新 DOM（高亮仍粘在原文本上），而展示时 cloneRange
 * 出来的克隆仍指着旧节点——旧节点几何随流式漂移甚至被钳到容器末尾，逐帧跟随克隆就把
 * 浮层写到了错误位置（选区在顶部、浮层停在输入框上方）。每帧取 window.getSelection()
 * 的实时 Range 测量，并用锁存的选区比较键 + 来源消息 id 做健在性校验：文本被流式改写、
 * 塌陷、或被重锚到别的消息 → 解除锁定并隐藏（所在子树整体卸载时 rect 全零，同样收起）。
 *
 * 比较键必须与锁存值同源（2026-12 跨段落引用失效根因）：锁存与逐帧校验都走
 * `selectionIntegrityKey(实时选区)`（内部取 `Range.toString()`）。曾经一侧用
 * `selection.toString()`、一侧用 `range.toString()`——Chromium 只在
 * `Selection.toString()` 里给块级边界补 `\n\n`，跨段落划选两侧恒不等，
 * 浮层展示后第一帧就被自己误撤。详见 selectionToolbarPolicy 的 `selectionIntegrityKey`
 * 注释与 e2e/selection-quote.spec.ts。
 *
 * 浮层只允许出现在时间线可视区内（2026-12 五次修复）：用户滚轮把选区滚出视口后，浮层
 * 若继续按 clamp 后的窗口坐标定位，会悬停在时间线外的 chrome（待办条/修改的文件/输入框）
 * 上，看起来像「幽灵浮层」。所以：① wheel/touchmove（用户滚动意图）直接收起——流式自动
 * 贴底不产生 wheel，两者天然可区分；② 每帧校验选区矩形与时间线容器矩形相交，完全滚出
 * 即收起；③ 写样式前把 top/left 夹紧在容器矩形内，选区贴边时浮层也不会压到输入栏。
 */
export function useTimelineSelection(containerRef: RefObject<HTMLElement | null>): { quote: TimelineSelectionQuote | null; clear: () => void; toolbarRef: RefObject<HTMLButtonElement | null> } {
	const [quote, setQuote] = useState<TimelineSelectionQuote | null>(null);
	const evaluateTimerRef = useRef(0);
	/** 浮层已展示且快照已定格：流式引起的选区塌陷不再收起，见组件头注释。 */
	const lockedRef = useRef(false);
	/** 锁定时的选区比较键（selectionIntegrityKey(实时选区)）：rAF 跟随时用同一个函数重算，被流式改写即失效。 */
	const lockedSelectionKeyRef = useRef("");
	/** 锁定时锁存的来源消息 id：跟随时校验实时选区未被重锚到别的消息。 */
	const lockedMessageIdRef = useRef("");
	/** rAF 跟随循环句柄：0 = 未在跑。 */
	const followFrameRef = useRef(0);
	/** 浮层按钮 DOM（SelectionToolbar 挂入）：rAF 循环逐帧直写样式用。 */
	const toolbarRef = useRef<HTMLButtonElement | null>(null);

	const clear = useCallback(() => {
		lockedRef.current = false;
		lockedSelectionKeyRef.current = "";
		lockedMessageIdRef.current = "";
		if (followFrameRef.current) {
			window.cancelAnimationFrame(followFrameRef.current);
			followFrameRef.current = 0;
		}
		setQuote(null);
	}, []);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const currentSelection = () => window.getSelection();

		// 解除锁定并收起浮层（锁存物与 rAF 跟随循环一并停掉）。clear 是对外版本。
		const releaseLock = () => {
			lockedRef.current = false;
			lockedSelectionKeyRef.current = "";
			lockedMessageIdRef.current = "";
			if (followFrameRef.current) {
				window.cancelAnimationFrame(followFrameRef.current);
				followFrameRef.current = 0;
			}
			setQuote(null);
		};

		// 锁定期的逐帧跟随：与滚动引擎同帧节拍，绕开 setState/React 渲染链（慢半拍根因）。
		// 每帧直接测量实时选区（浏览器在流式重挂 DOM 时会把真选区重锚到新节点，克隆 Range
		// 做不到，几何必过期——脱节根因），校验用锁存文本 + 来源消息 id。浮层未挂载时跳过
		// 写样式（React 首帧按快照定位，下一帧接管）。resize 也被循环覆盖：每帧重读视口。
		const followTick = () => {
			followFrameRef.current = 0;
			if (!lockedRef.current) return;
			const selection = window.getSelection();
			const range = selection && selection.rangeCount > 0 && !selection.isCollapsed ? selection.getRangeAt(0) : null;
			// 每帧重算键（同一个函数、同一个 API）：跨块级边界的划选不再因 API 差异被误判改写。
			if (!range || selectionIntegrityKey(selection) !== lockedSelectionKeyRef.current || resolveMessageId(range.startContainer, container) !== lockedMessageIdRef.current) {
				// 实时选区被流式变更挤没/改写/重锚到别的消息：解除锁定并隐藏
				releaseLock();
				return;
			}
			const rect = range.getBoundingClientRect();
			if (rect.width === 0 && rect.height === 0) {
				// 选区所在子树被整体卸载：Range 落在游离节点上，rect 全零
				releaseLock();
				return;
			}
			const containerRect = container.getBoundingClientRect();
			if (rect.bottom < containerRect.top || rect.top > containerRect.bottom) {
				// 选区被用户滚动完全带出时间线视口：收起，避免浮层悬在时间线外的
				// chrome（待办条/修改的文件/输入框）上变成幽灵（2026-12 五次修复）
				releaseLock();
				return;
			}
			const el = toolbarRef.current;
			if (el) {
				const position = computeToolbarPosition({ top: rect.top, left: rect.left, width: rect.width, height: rect.height }, { width: window.innerWidth, height: window.innerHeight }, { width: el.offsetWidth, height: el.offsetHeight });
				// 夹紧在时间线容器内：选区贴近视口边缘时浮层也不得压到输入栏/待办条
				const top = Math.max(containerRect.top + 4, Math.min(position.top, containerRect.bottom - el.offsetHeight - 4));
				el.style.top = `${top}px`;
				el.style.left = `${position.left}px`;
			}
			followFrameRef.current = window.requestAnimationFrame(followTick);
		};
		const startFollow = () => {
			if (!followFrameRef.current) followFrameRef.current = window.requestAnimationFrame(followTick);
		};

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
			releaseLock();
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
				releaseLock();
				return;
			}
			const rect = range.getBoundingClientRect();
			const messageId = resolveMessageId(range.startContainer, container) ?? "";
			lockedRef.current = true;
			// 快照文本用 Selection.toString()：块级边界保留成 \n\n，引文才有段落结构（发给模型的上下文）。
			// 比较键另取实时 Range 的纯文本（selectionIntegrityKey）——两者语义不同，
			// 不能让同一个字符串兼任（跨段落时它们本来就不相等）。
			lockedSelectionKeyRef.current = selectionIntegrityKey(selection);
			lockedMessageIdRef.current = messageId;
			setQuote({
				text: text.trim(),
				messageId,
				rect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
			});
			startFollow();
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
				releaseLock();
				return;
			}
			if (event.shiftKey || event.key === "a" || event.key === "A") scheduleEvaluate();
		};
		// 锁定期定位由 rAF 跟随循环全权负责；未锁定时滚动才隐藏（fixed 定位随滚动失真，
		// 旧语义不变）。wheel/touchmove = 用户滚动意图：直接收起（流式自动贴底不产生这两类
		// 事件，不会误伤流式跟随），对齐 assistant-ui「用户一滚就收」的交互。
		const onUserScrollIntent = () => {
			if (lockedRef.current) releaseLock();
		};
		const onScroll = () => {
			if (!lockedRef.current) setQuote(null);
		};

		document.addEventListener("selectionchange", onSelectionChange);
		document.addEventListener("pointerdown", onPointerDown);
		container.addEventListener("pointerup", onPointerUp);
		document.addEventListener("keyup", onKeyUp);
		// capture：捕获内层滚动容器（消息列自身可滚）
		container.addEventListener("scroll", onScroll, true);
		container.addEventListener("wheel", onUserScrollIntent, { passive: true });
		container.addEventListener("touchmove", onUserScrollIntent, { passive: true });
		window.addEventListener("resize", onScroll);

		return () => {
			window.clearTimeout(evaluateTimerRef.current);
			if (followFrameRef.current) {
				window.cancelAnimationFrame(followFrameRef.current);
				followFrameRef.current = 0;
			}
			document.removeEventListener("selectionchange", onSelectionChange);
			document.removeEventListener("pointerdown", onPointerDown);
			container.removeEventListener("pointerup", onPointerUp);
			document.removeEventListener("keyup", onKeyUp);
			container.removeEventListener("scroll", onScroll, true);
			container.removeEventListener("wheel", onUserScrollIntent);
			container.removeEventListener("touchmove", onUserScrollIntent);
			window.removeEventListener("resize", onScroll);
		};
	}, [containerRef]);

	return { quote, clear, toolbarRef };
}
