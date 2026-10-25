import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { createDragGhost } from "../utils/dragGhost";
import { LIST_REORDER_DRAG_MIME, moveKeyByStep, moveKeyRelative, resolveReorderDropTarget, sameOrder } from "../utils/listReorder";
import type { ReorderDropTarget, ReorderItemRect, ReorderOrientation, ReorderPosition } from "../utils/listReorder";

/** FLIP 落位动画时长：与供应商卡片拖拽保持一致，避免两处手感不同。 */
const REORDER_FLIP_DURATION_MS = 220;

function prefersReducedMotion(): boolean {
	return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** 手柄上的原生 DnD 与方向键事件：只挂在手柄上，卡片本身的点击/展开不受影响。 */
export type ListReorderGripHandlers = {
	draggable: true;
	onDragStart: (event: DragEvent<HTMLElement>) => void;
	onDragEnd: () => void;
	onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
};

/** 单个条目的拖拽状态与手柄接线：由 hook 按 key 生成，条目组件只管把它铺到 DOM 上。 */
export type ListReorderItemBinding = {
	dragging: boolean;
	dropPosition: ReorderPosition | null;
	register: (element: HTMLElement | null) => void;
	gripProps: ListReorderGripHandlers;
};

export type ListReorderContainerHandlers = {
	onDragOver: (event: DragEvent<HTMLElement>) => void;
	onDragLeave: (event: DragEvent<HTMLElement>) => void;
	onDrop: (event: DragEvent<HTMLElement>) => void;
};

export type UseListReorderOptions = {
	/** 完整顺序（含被搜索/筛选隐藏的条目）：持久化的就是这份。 */
	keys: readonly string[];
	/** 当前可见顺序：落点判定与手柄 ↑/↓ 的邻居住在它里面。 */
	visibleKeys: readonly string[];
	orientation: ReorderOrientation;
	/** 只上报真正发生位移的顺序；调用方负责乐观更新 + 持久化。 */
	onReorder: (nextOrder: string[]) => void;
};

/**
 * 列表重排的交互状态机：拖拽影像、落点判定、插入指示线、FLIP 落位动画、手柄方向键。
 *
 * 为什么单独抽 hook：智能体卡片（网格）与收藏列表（单列）布局不同，但「按住手柄拖动 /
 * 用键盘微调 / 松手后平滑落位」是同一套规则。几何与位移算法在 `utils/listReorder.ts`（纯函数、可单测），
 * 这里只保留 DOM 测量与 React 状态。
 *
 * 状态用 ref 镜像一份（latest / draggingKeyRef / dropTargetRef）：dragover/drop 是高频原生事件，
 * 闭包里拿到过期 props 会把条目插到上一次的位置；回调依赖数组保持空，避免拖拽中途重建 handler。
 */
export function useListReorder(options: UseListReorderOptions): { containerProps: ListReorderContainerHandlers; itemBinding: (key: string) => ListReorderItemBinding } {
	const itemRefs = useRef(new Map<string, HTMLElement>());
	const [draggingKey, setDraggingKey] = useState<string | null>(null);
	const [dropTarget, setDropTarget] = useState<ReorderDropTarget | null>(null);
	const draggingKeyRef = useRef<string | null>(null);
	const dropTargetRef = useRef<ReorderDropTarget | null>(null);
	const rectsBeforeReorder = useRef(new Map<string, DOMRect>());
	const flipPending = useRef(false);
	const dragGhostRef = useRef<HTMLDivElement | null>(null);
	// dragover 以鼠标回报率触发（高回报鼠标 125-1000Hz），每次全量读条目 rect 是
	// O(可见条目)/事件；指示线移动后的下一事件还会强制一次全列表 reflow。
	// preventDefault/dropEffect 必须同步留在事件里（浏览器契约），几何解析合并到
	// 每帧一次：事件只记录最新指针位置，rAF 里统一测量 + 判定（同帧多事件只测一次）。
	const dragOverFrameRef = useRef<number | null>(null);
	const dragOverPointRef = useRef<{ x: number; y: number } | null>(null);
	const cancelDragOverFrame = useCallback(() => {
		if (dragOverFrameRef.current !== null) {
			cancelAnimationFrame(dragOverFrameRef.current);
			dragOverFrameRef.current = null;
		}
		dragOverPointRef.current = null;
	}, []);
	// 每次渲染同步最新入参：事件回调只读这里，避免把 keys/visibleKeys 塞进依赖数组。
	const latest = useRef(options);
	latest.current = options;

	const registerItem = useCallback((key: string, element: HTMLElement | null) => {
		if (element) itemRefs.current.set(key, element);
		else itemRefs.current.delete(key);
	}, []);

	const readItemRects = useCallback((): ReorderItemRect[] => {
		const rects: ReorderItemRect[] = [];
		for (const key of latest.current.keys) {
			const element = itemRefs.current.get(key);
			if (!element) continue;
			const rect = element.getBoundingClientRect();
			// 折叠/隐藏条目会塌成 0×0，参与落点计算会把指针误吸走（纯函数里也会过滤，这里提前省掉测量）。
			if (rect.width === 0 && rect.height === 0) continue;
			rects.push({ key, left: rect.left, top: rect.top, width: rect.width, height: rect.height });
		}
		return rects;
	}, []);

	const resolveTarget = useCallback(
		(event: DragEvent<HTMLElement>): ReorderDropTarget | null => {
			const source = draggingKeyRef.current;
			const target = resolveReorderDropTarget(readItemRects(), { x: event.clientX, y: event.clientY }, latest.current.orientation);
			// 落在自己身上 = 拖回原位：不显示指示线，松手也不写盘。
			if (!target || target.key === source) return null;
			return target;
		},
		[readItemRects],
	);

	const resetDrag = useCallback(() => {
		cancelDragOverFrame();
		draggingKeyRef.current = null;
		dropTargetRef.current = null;
		setDraggingKey(null);
		setDropTarget(null);
		dragGhostRef.current?.remove();
		dragGhostRef.current = null;
	}, [cancelDragOverFrame]);

	const commitReorder = useCallback((nextOrder: string[] | null) => {
		if (!nextOrder) return;
		const current = latest.current.keys;
		if (sameOrder(current, nextOrder)) return;
		// 落位前先记下每个条目的位置，React 提交新顺序后做 FLIP。
		if (!prefersReducedMotion()) {
			for (const [key, element] of itemRefs.current) rectsBeforeReorder.current.set(key, element.getBoundingClientRect());
		}
		flipPending.current = true;
		latest.current.onReorder(nextOrder);
	}, []);

	const handleDragStart = useCallback((event: DragEvent<HTMLElement>, key: string) => {
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData(LIST_REORDER_DRAG_MIME, key);
		event.dataTransfer.setData("text/plain", key);
		draggingKeyRef.current = key;
		dropTargetRef.current = null;
		setDraggingKey(key);
		setDropTarget(null);
		const item = itemRefs.current.get(key);
		if (!item) return;
		dragGhostRef.current?.remove();
		const ghost = createDragGhost(item);
		dragGhostRef.current = ghost.node;
		event.dataTransfer.setDragImage(ghost.node, ghost.x, ghost.y);
	}, []);

	const handleContainerDragOver = useCallback(
		(event: DragEvent<HTMLElement>) => {
			// 不是从本列表起拖的（外部文件/文本）：不接管，保持浏览器默认拒绝。
			if (!draggingKeyRef.current) return;
			event.preventDefault();
			event.dataTransfer.dropEffect = "move";
			dragOverPointRef.current = { x: event.clientX, y: event.clientY };
			if (dragOverFrameRef.current !== null) return;
			dragOverFrameRef.current = requestAnimationFrame(() => {
				dragOverFrameRef.current = null;
				const point = dragOverPointRef.current;
				if (!point || !draggingKeyRef.current) return;
				const next = resolveReorderDropTarget(readItemRects(), point, latest.current.orientation);
				const resolved = !next || next.key === draggingKeyRef.current ? null : next;
				if (dropTargetRef.current?.key === resolved?.key && dropTargetRef.current?.position === resolved?.position) return;
				dropTargetRef.current = resolved;
				setDropTarget(resolved);
			});
		},
		[readItemRects],
	);
	// 拖拽结束/组件卸载时取消在帧回调：迟到的判定不得再写状态。
	useEffect(() => cancelDragOverFrame, [cancelDragOverFrame]);

	const handleContainerDragLeave = useCallback((event: DragEvent<HTMLElement>) => {
		const related = event.relatedTarget;
		// 在条目之间移动时 relatedTarget 仍在容器内：不要闪烁清空指示线。
		if (related instanceof Node && event.currentTarget.contains(related)) return;
		dropTargetRef.current = null;
		setDropTarget(null);
	}, []);

	const handleContainerDrop = useCallback(
		(event: DragEvent<HTMLElement>) => {
			const source = draggingKeyRef.current;
			if (!source) return;
			event.preventDefault();
			// 松手位置可能已经离开任何卡片（落在指示线/留白上）：用最近一次已解析的落点兜底。
			const target = resolveTarget(event) ?? dropTargetRef.current;
			resetDrag();
			if (!target) return;
			commitReorder(moveKeyRelative(latest.current.keys, source, target.key, target.position));
		},
		[resolveTarget, resetDrag, commitReorder],
	);

	const handleGripKeyDown = useCallback(
		(event: KeyboardEvent<HTMLElement>, key: string) => {
			if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
			event.preventDefault();
			event.stopPropagation();
			commitReorder(moveKeyByStep(latest.current.keys, latest.current.visibleKeys, key, event.key === "ArrowUp" ? -1 : 1));
		},
		[commitReorder],
	);

	const itemBinding = useCallback(
		(key: string): ListReorderItemBinding => ({
			dragging: draggingKey === key,
			dropPosition: dropTarget?.key === key ? dropTarget.position : null,
			register: (element: HTMLElement | null) => registerItem(key, element),
			gripProps: {
				draggable: true,
				onDragStart: (event) => handleDragStart(event, key),
				onDragEnd: resetDrag,
				onKeyDown: (event) => handleGripKeyDown(event, key),
			},
		}),
		[draggingKey, dropTarget, registerItem, handleDragStart, resetDrag, handleGripKeyDown],
	);

	const containerProps = useMemo(() => ({ onDragOver: handleContainerDragOver, onDragLeave: handleContainerDragLeave, onDrop: handleContainerDrop }), [handleContainerDragOver, handleContainerDragLeave, handleContainerDrop]);

	useLayoutEffect(() => {
		if (!flipPending.current) return;
		flipPending.current = false;
		const beforeRects = rectsBeforeReorder.current;
		if (beforeRects.size === 0) return;
		for (const [key, element] of itemRefs.current) {
			const before = beforeRects.get(key);
			if (!before) continue;
			const after = element.getBoundingClientRect();
			const dx = before.left - after.left;
			const dy = before.top - after.top;
			if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
			element.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: "translate(0px, 0px)" }], { duration: REORDER_FLIP_DURATION_MS, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
		}
		beforeRects.clear();
	}, [options.keys]);

	// 卸载时拖拽影像还挂在 body 上：不清理会留下一张悬空的卡片截图。
	useEffect(() => () => dragGhostRef.current?.remove(), []);

	return { containerProps, itemBinding };
}
