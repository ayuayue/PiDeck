import { useEffect, useRef } from "react";
import type { PetAggregateState } from "@shared/types";
import { type PetDragDirection, type PetDragMode, updatePetDragDirection } from "./PetDragDirection";

/**
 * PetInteraction —— 拖拽 / 单击跳转 Agent / 双击逗弄。
 * 位移 < 3px 视为点击；两次 click 间隔 < 300ms 视为双击。
 */

const CLICK = 3,
	DBL_MS = 300;

type Props = {
	state: PetAggregateState;
	onDragModeChange?: (mode: PetDragMode | null) => void;
	/** 窗口是否可被程序移动（Wayland 合成器不支持绝对定位时禁拖拽） */
	canMove?: boolean;
};

export function PetInteraction({ state, onDragModeChange, canMove = true }: Props) {
	/** 上次鼠标屏幕坐标，用于计算增量 */
	const lastScreen = useRef<{ x: number; y: number } | null>(null);
	/** 起始屏幕坐标，用于判断点击/拖拽 */
	const startScreen = useRef<{ x: number; y: number } | null>(null);
	const dragDirection = useRef<PetDragDirection | null>(null);
	const activePointerId = useRef<number | null>(null);
	const moved = useRef(0);
	const lastTap = useRef(0);
	const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(
		() => () => {
			if (tapTimer.current) clearTimeout(tapTimer.current);
		},
		[],
	);

	const menu = (e: React.MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		if (state.mode === "hidden") return;
		void window.piDesktop.pet.contextMenu();
	};

	const down = (e: React.PointerEvent<HTMLDivElement>) => {
		if (state.mode === "hidden" || e.button !== 0 || !canMove) return;
		activePointerId.current = e.pointerId;
		lastScreen.current = { x: e.screenX, y: e.screenY };
		startScreen.current = { x: e.screenX, y: e.screenY };
		dragDirection.current = { anchorX: e.screenX, mode: "idle" };
		moved.current = 0;
		onDragModeChange?.("idle");
		// 通知主进程暂停巡游：松手后遗留的 tick 可能命中行进反向边界，导致瞬移
		void window.piDesktop.pet.setDragging(true);
		e.currentTarget.setPointerCapture?.(e.pointerId);
	};

	const move = (e: React.PointerEvent<HTMLDivElement>) => {
		if (activePointerId.current !== e.pointerId || !lastScreen.current || !startScreen.current) return;
		const dx = e.screenX - lastScreen.current.x;
		const dy = e.screenY - lastScreen.current.y;
		lastScreen.current = { x: e.screenX, y: e.screenY };
		moved.current = Math.max(moved.current, Math.abs(e.screenX - startScreen.current.x) + Math.abs(e.screenY - startScreen.current.y));

		if (dragDirection.current) {
			const nextDirection = updatePetDragDirection(dragDirection.current, e.screenX);
			if (nextDirection.mode !== dragDirection.current.mode) onDragModeChange?.(nextDirection.mode);
			dragDirection.current = nextDirection;
		}

		// 发送增量移动（delta 基于连续 screenX 差值，不混用 clientX/screenLeft，
		// 主进程 ipcMain.handle 串行处理，setPosition 同步，不会产生增量竞争）
		if (dx !== 0 || dy !== 0) void window.piDesktop.pet.moveBy({ dx, dy });
	};

	const finish = (e: React.PointerEvent<HTMLDivElement>, allowTap: boolean) => {
		if (activePointerId.current !== e.pointerId) return;
		activePointerId.current = null;
		lastScreen.current = null;
		startScreen.current = null;
		dragDirection.current = null;
		onDragModeChange?.(null);
		// 拖拽结束：通知主进程，若当前仍为 idle 且巡游开启，则从新位置恢复巡游
		void window.piDesktop.pet.setDragging(false);
		if (e.currentTarget.hasPointerCapture?.(e.pointerId)) {
			e.currentTarget.releasePointerCapture?.(e.pointerId);
		}

		if (!allowTap || moved.current >= CLICK) return;
		const now = Date.now();
		if (now - lastTap.current < DBL_MS) {
			lastTap.current = 0;
			if (tapTimer.current) {
				clearTimeout(tapTimer.current);
				tapTimer.current = null;
			}
			void window.piDesktop.pet.tease();
			return;
		}
		lastTap.current = now;
		if (tapTimer.current) clearTimeout(tapTimer.current);
		tapTimer.current = setTimeout(() => {
			tapTimer.current = null;
			void window.piDesktop.pet.focusAgent();
		}, DBL_MS);
	};

	return <div style={{ position: "absolute", inset: 0, cursor: "grab", touchAction: "none" }} onPointerDown={down} onPointerMove={move} onPointerUp={(e) => finish(e, true)} onPointerCancel={(e) => finish(e, false)} onLostPointerCapture={(e) => finish(e, false)} onContextMenu={menu} />;
}
