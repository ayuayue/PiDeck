import { useRef } from "react";
import type { PetAggregateState } from "@shared/types";

/**
 * PetInteraction —— 拖拽 / 单击跳转 Agent / 双击逗弄。
 * 位移 < 3px 视为点击；两次 click 间隔 < 300ms 视为双击。
 */

const CLICK = 3, DBL_MS = 300;

type Props = { state: PetAggregateState; onDragStateChange?: (d: boolean) => void };

export function PetInteraction({ state, onDragStateChange }: Props) {
	const offset = useRef<{ ox: number; oy: number } | null>(null);
	const screen = useRef<{ x: number; y: number } | null>(null);
	const moved = useRef(0);
	const lastTap = useRef(0);
	const tapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const down = (e: React.PointerEvent) => {
		if (state.mode === "hidden") return;
		offset.current = { ox: e.clientX, oy: e.clientY };
		screen.current = { x: e.screenX, y: e.screenY };
		moved.current = 0;
		onDragStateChange?.(true);
		(e.target as HTMLElement).setPointerCapture?.(e.pointerId);
	};

	const move = (e: React.PointerEvent) => {
		if (!offset.current || !screen.current) return;
		moved.current = Math.max(moved.current, Math.abs(e.screenX - screen.current.x) + Math.abs(e.screenY - screen.current.y));
		void window.piDesktop.pet.moveWindow({ x: e.screenX - offset.current.ox, y: e.screenY - offset.current.oy });
	};

	const up = (e: React.PointerEvent) => {
		offset.current = null; screen.current = null;
		onDragStateChange?.(false);
		(e.target as HTMLElement).releasePointerCapture?.(e.pointerId);

		if (moved.current < CLICK) {
			const now = Date.now();
			if (now - lastTap.current < DBL_MS) {
				lastTap.current = 0;
				if (tapTimer.current) { clearTimeout(tapTimer.current); tapTimer.current = null; }
				void window.piDesktop.pet.tease();
				return;
			}
			lastTap.current = now;
			if (tapTimer.current) clearTimeout(tapTimer.current);
			tapTimer.current = setTimeout(() => { tapTimer.current = null; void window.piDesktop.pet.focusAgent(); }, DBL_MS);
		}
	};

	return <div style={{ position: "absolute", inset: 0, cursor: "grab", touchAction: "none" }} onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} />;
}
