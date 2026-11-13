/**
 * 分区之间的可拖拽 / 可键盘调整的分隔条。
 *
 * 从 `GitPanel.tsx` 原样搬出：指针拖拽按帧节流（`requestAnimationFrame`），
 * 键盘 ArrowUp/ArrowDown 直接改高度；两端都把结果夹在 `PANE_MIN_BODY_HEIGHT` 之上。
 */
import { type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, useRef } from "react";
import { t } from "../../../i18n";
import { PANE_MIN_BODY_HEIGHT, PANE_RESIZE_LARGE_STEP, PANE_RESIZE_STEP, type PaneId } from "./gitPaneLayout";

export function PaneSash(props: { before: PaneId; after: PaneId; beforeHeight: number; afterHeight: number; onResize: (beforeHeight: number, afterHeight: number) => void }) {
	const frameRef = useRef<number | undefined>(undefined);
	const pendingHeightsRef = useRef<{ before: number; after: number } | null>(null);

	const flushPendingHeights = () => {
		if (frameRef.current !== undefined) {
			cancelAnimationFrame(frameRef.current);
			frameRef.current = undefined;
		}
		const pending = pendingHeightsRef.current;
		pendingHeightsRef.current = null;
		if (pending) props.onResize(pending.before, pending.after);
	};

	const scheduleHeights = (before: number, after: number) => {
		pendingHeightsRef.current = { before, after };
		if (frameRef.current !== undefined) return;
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = undefined;
			const pending = pendingHeightsRef.current;
			pendingHeightsRef.current = null;
			if (pending) props.onResize(pending.before, pending.after);
		});
	};

	const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startY = event.clientY;
		const startBeforeHeight = props.beforeHeight;
		const startAfterHeight = props.afterHeight;
		event.currentTarget.setPointerCapture?.(event.pointerId);
		const onMove = (moveEvent: PointerEvent) => {
			const requestedBefore = startBeforeHeight + moveEvent.clientY - startY;
			const before = Math.max(PANE_MIN_BODY_HEIGHT, Math.min(requestedBefore, startBeforeHeight + startAfterHeight - PANE_MIN_BODY_HEIGHT));
			const after = startBeforeHeight + startAfterHeight - before;
			scheduleHeights(before, after);
		};
		const onEnd = () => {
			flushPendingHeights();
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onEnd);
			document.body.classList.remove("is-git-pane-resizing");
		};
		document.body.classList.add("is-git-pane-resizing");
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onEnd);
		window.addEventListener("pointercancel", onEnd);
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? PANE_RESIZE_LARGE_STEP : PANE_RESIZE_STEP;
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		event.preventDefault();
		const direction = event.key === "ArrowUp" ? -1 : 1;
		const requestedBefore = props.beforeHeight + direction * step;
		const before = Math.max(PANE_MIN_BODY_HEIGHT, Math.min(requestedBefore, props.beforeHeight + props.afterHeight - PANE_MIN_BODY_HEIGHT));
		const after = props.beforeHeight + props.afterHeight - before;
		props.onResize(before, after);
	};

	return (
		<div
			className="git-pane-sash relative z-[1] box-border h-1.5 shrink-0 basis-1.5 -my-[3px] cursor-row-resize touch-none before:absolute before:top-0.5 before:right-0 before:left-0 before:h-px before:bg-[var(--git-panel-border)] before:transition-[background-color,height] before:duration-fast hover:before:h-0.5 hover:before:bg-[var(--color-accent)] focus-visible:before:h-0.5 focus-visible:before:bg-[var(--color-accent)]"
			role="separator"
			tabIndex={0}
			aria-orientation="horizontal"
			aria-label={t("git.resizePanes")}
			aria-valuemin={PANE_MIN_BODY_HEIGHT}
			aria-valuemax={Math.max(PANE_MIN_BODY_HEIGHT, props.beforeHeight + props.afterHeight - PANE_MIN_BODY_HEIGHT)}
			aria-valuenow={props.beforeHeight}
			data-before={props.before}
			data-after={props.after}
			onPointerDown={startResize}
			onKeyDown={onKeyDown}
		/>
	);
}
