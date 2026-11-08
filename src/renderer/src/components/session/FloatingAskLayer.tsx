import { useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { GripHorizontal } from "lucide-react";
import { t } from "../../i18n";

/**
 * 浮动提问层：阻塞式 Ask 不再钉在对话列底部挤占时间线高度，而是浮在时间线之上。
 *
 * 为什么：很多提问要先读完上面的回复才能回答；钉底卡片把可读区压到 160px 保底高度，
 * 长回复只能一屏屏翻。浮层让时间线保持整列高度，用户可以折叠卡片（ApprovalCard 的 chevron）
 * 或拖到别处再读；位置跨提问记住（localStorage，失败时退回默认位置）。
 *
 * 浮层不能吃掉时间线自带的控件，所以它同时：
 * - 贴底时给时间线末尾留出卡片占高的滚动余量（`--ask-float-reserve`，由 [role=log]::after 消费），
 *   滚到底时最后几行停在卡片上方；
 * - 卡片横向压住「回到底部」按钮时把按钮抬到卡片上方（`--ask-float-scroll-lift`）；
 * - 右缘让开对话大纲刻度轴，并在父列打 `data-ask-floating`，让刻度的预览卡与展开面板盖在卡片之上。
 */

const STORAGE_KEY = "pideck:ask-float-offset:v1";
/** 浮层与列边缘的间距（px），也是拖动时的最小留边。 */
export const ASK_FLOAT_MARGIN = 12;
/** 留给时间线末尾的额外缓冲，避免最后一行贴着卡片边。 */
const RESERVE_GAP = 8;
/** 卡片底边离列底不足这个距离时算「压在内容尾部」：卡片下方那条缝放不下可读的几行。 */
export const ASK_FLOAT_TAIL_CLEARANCE = 96;
/** 「回到底部」按钮的半宽（size-8）加一点余量，用于判断卡片是否横向压住它。 */
const SCROLL_BUTTON_HALF_WIDTH = 20;
/** 刻度轴与卡片之间的间距。 */
const RAIL_GAP = 6;

export type AskFloatOffset = { x: number; y: number };
/** rightInset：卡片右缘到列右缘的距离（有大纲刻度轴时要让开它）。 */
export type AskFloatBounds = { parentWidth: number; parentHeight: number; cardWidth: number; cardHeight: number; rightInset?: number };

function hasSize(bounds: AskFloatBounds): boolean {
	return bounds.parentWidth > 0 && bounds.parentHeight > 0 && bounds.cardWidth > 0 && bounds.cardHeight > 0;
}

/**
 * 偏移以「右下角默认锚点」为原点：x/y 只会 ≤ 0（往左、往上拖）。超界时收回到列内。
 * 测量为 0（未布局、标签页隐藏）时原样返回，不能把用户记住的位置夹成 {0,0}。
 */
export function clampAskFloatOffset(offset: AskFloatOffset, bounds: AskFloatBounds): AskFloatOffset {
	if (!hasSize(bounds)) return offset;
	const rightInset = bounds.rightInset ?? ASK_FLOAT_MARGIN;
	const minX = Math.min(0, -(bounds.parentWidth - bounds.cardWidth - rightInset - ASK_FLOAT_MARGIN));
	const minY = Math.min(0, -(bounds.parentHeight - bounds.cardHeight - 2 * ASK_FLOAT_MARGIN));
	return { x: Math.round(Math.min(0, Math.max(minX, offset.x))), y: Math.round(Math.min(0, Math.max(minY, offset.y))) };
}

/** 卡片在列内的上下边（px，相对列顶）。 */
function cardEdges(offset: AskFloatOffset, bounds: AskFloatBounds) {
	const bottom = bounds.parentHeight - ASK_FLOAT_MARGIN + offset.y;
	return { top: bottom - bounds.cardHeight, bottom };
}

/**
 * 时间线末尾需要留出的余量：按卡片底边是否压在内容尾部判断，而不是看卡片顶边在不在列中线以下
 * ——大卡片顶边总在中线以上，那种判法会让最需要余量的批量/长选项卡拿到 0。
 * 卡片被拖离底部、下面留出足够读几行的缝时，尾部内容能从卡片下方滚出来，不用再留。
 */
export function askFloatReserve(offset: AskFloatOffset, bounds: AskFloatBounds): number {
	if (!hasSize(bounds)) return 0;
	const edges = cardEdges(offset, bounds);
	if (bounds.parentHeight - edges.bottom >= ASK_FLOAT_TAIL_CLEARANCE) return 0;
	return Math.max(0, Math.round(bounds.parentHeight - edges.top + RESERVE_GAP));
}

/**
 * 「回到底部」按钮（居中、贴列底）要抬高多少才不被卡片盖住：卡片横向压住列中线且贴着底部时，
 * 抬到卡片顶边之上；抬高后仍要留在列内（卡片几乎占满整列时只能贴列顶，用户可折叠卡片）。
 */
export function askFloatScrollButtonLift(offset: AskFloatOffset, bounds: AskFloatBounds): number {
	if (!hasSize(bounds)) return 0;
	const rightInset = bounds.rightInset ?? ASK_FLOAT_MARGIN;
	const cardRight = bounds.parentWidth - rightInset + offset.x;
	const cardLeft = cardRight - bounds.cardWidth;
	const center = bounds.parentWidth / 2;
	if (cardLeft > center + SCROLL_BUTTON_HALF_WIDTH || cardRight < center - SCROLL_BUTTON_HALF_WIDTH) return 0;
	const edges = cardEdges(offset, bounds);
	if (bounds.parentHeight - edges.bottom >= ASK_FLOAT_TAIL_CLEARANCE) return 0;
	return Math.max(0, Math.min(Math.round(bounds.parentHeight - edges.top + RESERVE_GAP), bounds.parentHeight - 48));
}

function readStoredOffset(): AskFloatOffset {
	try {
		const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<AskFloatOffset> | null;
		if (parsed && Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return { x: Number(parsed.x), y: Number(parsed.y) };
	} catch {
		// 存储不可用（隐私模式等）：用默认位置
	}
	return { x: 0, y: 0 };
}

function writeStoredOffset(offset: AskFloatOffset) {
	try {
		window.localStorage.setItem(STORAGE_KEY, JSON.stringify(offset));
	} catch {
		// 记不住位置不影响作答
	}
}

/**
 * 大纲刻度轴让位：刻度轴贴在列右缘（.session-outline-pane），卡片右缘要停在它左边。
 * 展开态的目录面板很宽，不跟着让（否则卡片会跳开 300px）——它靠 data-ask-floating 盖在卡片之上。
 */
function measureRightInset(parent: HTMLElement, previous: number | undefined): number {
	const rail = parent.querySelector<HTMLElement>(".session-outline-pane");
	const ticks = rail?.firstElementChild as HTMLElement | null | undefined;
	if (!rail || !ticks) return ASK_FLOAT_MARGIN;
	if (ticks.classList.contains("session-outline-panel")) return previous ?? ASK_FLOAT_MARGIN;
	const railRect = rail.getBoundingClientRect();
	if (railRect.width <= 0) return ASK_FLOAT_MARGIN;
	return Math.max(ASK_FLOAT_MARGIN, Math.round(parent.getBoundingClientRect().right - railRect.left + RAIL_GAP));
}

function sameBounds(left: AskFloatBounds | null, right: AskFloatBounds): boolean {
	return Boolean(left && left.parentWidth === right.parentWidth && left.parentHeight === right.parentHeight && left.cardWidth === right.cardWidth && left.cardHeight === right.cardHeight && left.rightInset === right.rightInset);
}

export function FloatingAskLayer(props: { children: ReactNode }) {
	const layerRef = useRef<HTMLDivElement | null>(null);
	// preferred 是用户选的位置（拖动结果 / 记住的位置），渲染位置 = 按当前列尺寸夹紧后的 preferred。
	// 两者分开存：列临时变矮时只夹渲染位置，列恢复后卡片回到用户原来放的地方。
	const [preferred, setPreferred] = useState<AskFloatOffset>(readStoredOffset);
	const [bounds, setBounds] = useState<AskFloatBounds | null>(null);
	const offset = bounds ? clampAskFloatOffset(preferred, bounds) : preferred;
	const dragRef = useRef<{ pointerId: number; startX: number; startY: number; base: AskFloatOffset } | null>(null);
	// 松手时写盘要用最新位置；闭包里的值可能落后最后一次 move 一帧
	const latestPreferredRef = useRef(preferred);
	latestPreferredRef.current = preferred;
	const boundsRef = useRef(bounds);
	boundsRef.current = bounds;

	// 列尺寸/卡片高度/刻度轴变化（展开折叠、答题切换、窗口缩放、刻度出现）时重新测量。
	useLayoutEffect(() => {
		const layer = layerRef.current;
		const parent = layer?.parentElement;
		if (!layer || !parent) return;
		const observer = new ResizeObserver(() => sync());
		let observedRail: Element | null = null;
		function sync() {
			if (!layer || !parent) return;
			const rail = parent.querySelector(".session-outline-pane");
			if (rail !== observedRail) {
				if (observedRail) observer.unobserve(observedRail);
				if (rail) observer.observe(rail);
				observedRail = rail;
			}
			const next = { parentWidth: parent.clientWidth, parentHeight: parent.clientHeight, cardWidth: layer.offsetWidth, cardHeight: layer.offsetHeight, rightInset: measureRightInset(parent, boundsRef.current?.rightInset) };
			// 0 尺寸测量（隐藏标签页、未布局）不算数，沿用上一次的边界
			if (!hasSize(next)) return;
			setBounds((current) => (sameBounds(current, next) ? current : next));
		}
		sync();
		observer.observe(layer);
		observer.observe(parent);
		return () => observer.disconnect();
	}, []);

	// 把余量、按钮抬高量、浮层标记写到父列上（时间线与刻度轴都在父列里，靠继承读到）。
	useLayoutEffect(() => {
		const parent = layerRef.current?.parentElement;
		if (!parent) return;
		parent.dataset.askFloating = "";
		if (!bounds) return;
		parent.style.setProperty("--ask-float-reserve", `${askFloatReserve(offset, bounds)}px`);
		parent.style.setProperty("--ask-float-scroll-lift", `${askFloatScrollButtonLift(offset, bounds)}px`);
	}, [bounds, offset.x, offset.y]);

	// 卸载（作答完成）时撤掉余量与标记，时间线恢复原样。
	useLayoutEffect(() => {
		const parent = layerRef.current?.parentElement;
		return () => {
			if (!parent) return;
			parent.style.removeProperty("--ask-float-reserve");
			parent.style.removeProperty("--ask-float-scroll-lift");
			delete parent.dataset.askFloating;
		};
	}, []);

	const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (event.button !== 0) return;
		event.preventDefault();
		event.currentTarget.setPointerCapture(event.pointerId);
		dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, base: offset };
	};
	const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
		const drag = dragRef.current;
		if (!drag || drag.pointerId !== event.pointerId || !bounds) return;
		setPreferred(clampAskFloatOffset({ x: drag.base.x + event.clientX - drag.startX, y: drag.base.y + event.clientY - drag.startY }, bounds));
	};
	const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (dragRef.current?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		writeStoredOffset(latestPreferredRef.current);
	};
	const resetPosition = () => {
		setPreferred({ x: 0, y: 0 });
		writeStoredOffset({ x: 0, y: 0 });
	};

	const rightInset = bounds?.rightInset ?? ASK_FLOAT_MARGIN;
	return (
		<div
			ref={layerRef}
			className="session-v-ask session-v-ask--floating absolute z-30 flex min-h-0 flex-col overflow-hidden rounded-lg shadow-[0_12px_32px_-8px_rgb(0_0_0/0.35)]"
			style={{
				right: rightInset,
				bottom: ASK_FLOAT_MARGIN,
				width: `min(640px, calc(100% - ${rightInset + ASK_FLOAT_MARGIN}px))`,
				maxHeight: `calc(100% - ${2 * ASK_FLOAT_MARGIN}px)`,
				transform: `translate(${offset.x}px, ${offset.y}px)`,
			}}
			aria-live="polite"
		>
			<div
				className="ask-float-grip flex h-3.5 shrink-0 cursor-grab touch-none items-center justify-center rounded-t-lg border border-b-0 border-border bg-muted/60 text-muted-foreground hover:text-foreground active:cursor-grabbing"
				title={t("ask.floatDragHint")}
				aria-label={t("ask.floatDragHint")}
				role="separator"
				onPointerDown={onPointerDown}
				onPointerMove={onPointerMove}
				onPointerUp={endDrag}
				onPointerCancel={endDrag}
				onDoubleClick={resetPosition}
			>
				<GripHorizontal size={12} aria-hidden="true" />
			</div>
			{/* scroll-ok: bounded —— 单张提问卡，高度受列高约束，超出时卡片内滚动。 */}
			<div className="min-h-0 overflow-y-auto overscroll-contain [&_.ask-inline-bar]:rounded-t-none">{props.children}</div>
		</div>
	);
}
