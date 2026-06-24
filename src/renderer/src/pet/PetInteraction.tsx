import { useRef } from "react";
import type { PetAggregateState } from "@shared/types";

/**
 * PetInteraction —— 拖拽改位置 / 点击跳转活跃 Agent（设计文档第 6.3 节）。
 *
 * - 拖拽：按下时记录鼠标在窗口内的偏移（clientX/Y 相对窗口左上角）；
 *   移动时窗口左上角屏幕坐标 = 鼠标屏幕坐标 - 偏移，使鼠标始终停在按下处的相对位置，
 *   窗口不会跳变。位移 ≥ 阈值才视为拖拽。
 * - 点击：松开时位移不足阈值则跳转活跃 Agent。
 * - MVP 不做精确像素点击穿透（设计文档 5.3 简化方案），整个小窗可点击/拖拽。
 */

/** 判定为点击而非拖拽的位移阈值（px） */
const CLICK_THRESHOLD = 3;

type Props = {
	state: PetAggregateState;
	onDragStateChange?: (dragging: boolean) => void;
};

export function PetInteraction({ state, onDragStateChange }: Props) {
	// 鼠标按下时在窗口内的偏移（相对窗口左上角），用于拖拽时反算窗口左上角屏幕坐标
	const pressOffset = useRef<{ ox: number; oy: number } | null>(null);
	// 按下时的鼠标屏幕坐标，用于累计位移判定点击 vs 拖拽
	const pressScreen = useRef<{ x: number; y: number } | null>(null);
	const moved = useRef(0);

	const onPointerDown = (e: React.PointerEvent) => {
		if (state.mode === "hidden") return;
		// clientX/Y 是窗口内 CSS 坐标，即鼠标相对窗口左上角的偏移
		pressOffset.current = { ox: e.clientX, oy: e.clientY };
		pressScreen.current = { x: e.screenX, y: e.screenY };
		moved.current = 0;
		onDragStateChange?.(true);
		(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
	};

	const onPointerMove = (e: React.PointerEvent) => {
		if (!pressOffset.current || !pressScreen.current) return;
		const dx = e.screenX - pressScreen.current.x;
		const dy = e.screenY - pressScreen.current.y;
		moved.current = Math.max(moved.current, Math.abs(dx) + Math.abs(dy));
		// 窗口左上角屏幕坐标 = 鼠标屏幕坐标 - 鼠标在窗口内偏移；鼠标随窗口移动停在原相对位置，不跳变
		void window.piDesktop.pet.moveWindow({
			x: e.screenX - pressOffset.current.ox,
			y: e.screenY - pressOffset.current.oy,
		});
	};

	const onPointerUp = (e: React.PointerEvent) => {
		pressOffset.current = null;
		pressScreen.current = null;
		onDragStateChange?.(false);
		(e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
		// 位移小于阈值视为点击：跳转活跃 Agent
		if (moved.current < CLICK_THRESHOLD) {
			void window.piDesktop.pet.focusAgent();
		}
	};

	return (
		<div
			style={{
				position: "absolute",
				inset: 0,
				cursor: "grab",
				touchAction: "none",
			}}
			onPointerDown={onPointerDown}
			onPointerMove={onPointerMove}
			onPointerUp={onPointerUp}
			onPointerCancel={onPointerUp}
		/>
	);
}