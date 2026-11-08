import { useCallback, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { GripHorizontal } from "lucide-react";
import { t } from "../../i18n";

/**
 * 浮动提问层：阻塞式 Ask 不再钉在对话列底部挤占时间线高度，而是浮在时间线之上。
 *
 * 为什么：很多提问要先读完上面的回复才能回答；钉底卡片把可读区压到 160px 保底高度，
 * 长回复只能一屏屏翻。浮层让时间线保持整列高度，用户可以折叠卡片（ApprovalCard 的 chevron）
 * 或拖到别处再读；位置跨提问记住（localStorage，失败时退回默认位置）。
 *
 * 遮挡兜底：卡片落在列的下半部分时，按卡片实际占用高度给时间线末尾留出滚动余量
 * （`--ask-float-reserve`，由 [role=log]::after 消费），保证滚到底时最后几行不被盖住；
 * 卡片被拖到上半部分或折叠后，余量随之缩小或归零。
 */

const STORAGE_KEY = "pideck:ask-float-offset:v1";
/** 浮层与列边缘的间距（px），也是拖动时的最小留边。 */
export const ASK_FLOAT_MARGIN = 12;
/** 留给时间线末尾的额外缓冲，避免最后一行贴着卡片边。 */
const RESERVE_GAP = 8;

export type AskFloatOffset = { x: number; y: number };
export type AskFloatBounds = { parentWidth: number; parentHeight: number; cardWidth: number; cardHeight: number };

/** 偏移以「右下角默认锚点」为原点：x/y 只会 ≤ 0（往左、往上拖）。超界时收回到列内。 */
export function clampAskFloatOffset(offset: AskFloatOffset, bounds: AskFloatBounds): AskFloatOffset {
	const minX = Math.min(0, -(bounds.parentWidth - bounds.cardWidth - 2 * ASK_FLOAT_MARGIN));
	const minY = Math.min(0, -(bounds.parentHeight - bounds.cardHeight - 2 * ASK_FLOAT_MARGIN));
	return { x: Math.round(Math.min(0, Math.max(minX, offset.x))), y: Math.round(Math.min(0, Math.max(minY, offset.y))) };
}

/** 时间线需要留出的末尾余量：卡片顶边在列下半部分时，留出卡片顶边到列底的距离。 */
export function askFloatReserve(offset: AskFloatOffset, bounds: AskFloatBounds): number {
	const cardTop = bounds.parentHeight - ASK_FLOAT_MARGIN - bounds.cardHeight + offset.y;
	if (cardTop < bounds.parentHeight / 2) return 0;
	return Math.max(0, Math.round(bounds.parentHeight - cardTop + RESERVE_GAP));
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

export function FloatingAskLayer(props: { children: ReactNode }) {
	const layerRef = useRef<HTMLDivElement | null>(null);
	const [offset, setOffset] = useState<AskFloatOffset>(readStoredOffset);
	const dragRef = useRef<{ pointerId: number; startX: number; startY: number; base: AskFloatOffset } | null>(null);
	// 松手时写盘要用最新位置；闭包里的 offset 可能落后最后一次 move 一帧
	const latestOffsetRef = useRef(offset);
	latestOffsetRef.current = offset;

	const measure = useCallback((): AskFloatBounds | null => {
		const layer = layerRef.current;
		const parent = layer?.parentElement;
		if (!layer || !parent) return null;
		return { parentWidth: parent.clientWidth, parentHeight: parent.clientHeight, cardWidth: layer.offsetWidth, cardHeight: layer.offsetHeight };
	}, []);

	// 列尺寸/卡片高度变化（展开折叠、答题切换、窗口缩放）时：收回越界位置并同步时间线余量。
	useLayoutEffect(() => {
		const layer = layerRef.current;
		const parent = layer?.parentElement;
		if (!layer || !parent) return;
		const sync = () => {
			const bounds = measure();
			if (!bounds) return;
			const clamped = clampAskFloatOffset(offset, bounds);
			if (clamped.x !== offset.x || clamped.y !== offset.y) {
				setOffset(clamped);
				return;
			}
			parent.style.setProperty("--ask-float-reserve", `${askFloatReserve(clamped, bounds)}px`);
		};
		sync();
		const observer = new ResizeObserver(sync);
		observer.observe(layer);
		observer.observe(parent);
		return () => observer.disconnect();
	}, [measure, offset]);

	// 卸载（作答完成）时撤掉余量，时间线恢复原样。
	useLayoutEffect(() => {
		const parent = layerRef.current?.parentElement;
		return () => {
			parent?.style.removeProperty("--ask-float-reserve");
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
		const bounds = measure();
		if (!drag || drag.pointerId !== event.pointerId || !bounds) return;
		setOffset(clampAskFloatOffset({ x: drag.base.x + event.clientX - drag.startX, y: drag.base.y + event.clientY - drag.startY }, bounds));
	};
	const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
		if (dragRef.current?.pointerId !== event.pointerId) return;
		dragRef.current = null;
		writeStoredOffset(latestOffsetRef.current);
	};
	const resetPosition = () => {
		setOffset({ x: 0, y: 0 });
		writeStoredOffset({ x: 0, y: 0 });
	};

	return (
		<div
			ref={layerRef}
			className="session-v-ask session-v-ask--floating absolute z-30 flex min-h-0 flex-col overflow-hidden rounded-lg shadow-[0_12px_32px_-8px_rgb(0_0_0/0.35)]"
			style={{
				right: ASK_FLOAT_MARGIN,
				bottom: ASK_FLOAT_MARGIN,
				width: `min(640px, calc(100% - ${2 * ASK_FLOAT_MARGIN}px))`,
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
