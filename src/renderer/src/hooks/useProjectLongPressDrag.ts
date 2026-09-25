import { useEffect, useRef, useState, type PointerEvent } from "react";

/** 项目折叠优先；只有静止长按后才能开始原生排序拖拽。 */
export function useProjectLongPressDrag() {
	const [readyProjectId, setReadyProjectId] = useState<string>();
	const pending = useRef<{ id: string; x: number; y: number; timer: ReturnType<typeof setTimeout> } | undefined>(undefined);
	const armed = useRef<string | undefined>(undefined);
	const suppressClick = useRef(false);
	const cancel = () => {
		if (pending.current) clearTimeout(pending.current.timer);
		pending.current = undefined;
		armed.current = undefined;
		setReadyProjectId(undefined);
	};
	useEffect(() => {
		window.addEventListener("pointerup", cancel);
		window.addEventListener("pointercancel", cancel);
		window.addEventListener("blur", cancel);
		return () => {
			if (pending.current) clearTimeout(pending.current.timer);
			window.removeEventListener("pointerup", cancel);
			window.removeEventListener("pointercancel", cancel);
			window.removeEventListener("blur", cancel);
		};
	}, []);
	return {
		readyProjectId,
		cancel,
		canDrag: (id: string) => armed.current === id,
		start: (id: string, event: PointerEvent<HTMLButtonElement>) => {
			cancel();
			suppressClick.current = false;
			if (event.button !== 0 || event.pointerType !== "mouse") return;
			pending.current = {
				id,
				x: event.clientX,
				y: event.clientY,
				timer: setTimeout(() => {
					armed.current = id;
					suppressClick.current = true;
					setReadyProjectId(id);
				}, 350),
			};
		},
		move: (event: PointerEvent<HTMLButtonElement>) => {
			const press = pending.current;
			if (press && !armed.current && Math.hypot(event.clientX - press.x, event.clientY - press.y) > 5) cancel();
		},
		consumeClick: () => {
			const suppressed = suppressClick.current;
			suppressClick.current = false;
			return suppressed;
		},
	};
}
