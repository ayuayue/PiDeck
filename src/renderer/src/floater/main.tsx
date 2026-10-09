import React, { useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import { PiTuiLogoMark } from "../components/app/PiTuiLogo";
import { setI18nLocale, t } from "../i18n";
import type { MiniOverlayLocale } from "../../../shared/types/miniOverlay";
import "./floater.css";

/** 悬浮球窗口的窄状态类型（与 main/floating/FloatingController.ts 对齐）。 */
interface FloatingBallState {
	visible: boolean;
	alwaysOnTop: boolean;
	snapToEdge: boolean;
	expandTarget: "mini" | "compact";
	/** 是否显示运行中任务数量角标（旧主进程未推时视为开启）。 */
	showRunningBadge?: boolean;
	activeCount: number;
	runningCount: number;
	recentTitles: string[];
	locale: MiniOverlayLocale;
}

const api = (
	window as unknown as {
		piDesktop: {
			floatingBall: {
				getState: () => Promise<FloatingBallState>;
				onStateChanged: (cb: (state: FloatingBallState) => void) => () => void;
				dragStart: () => Promise<void>;
				dragMove: (x: number, y: number) => Promise<void>;
				dragEnd: () => Promise<void>;
				contextMenu: () => Promise<void>;
			};
		};
	}
).piDesktop;

/** 球体只承担拖拽/角标与简短无障碍文案；不展示任务标题（标题气泡已按需求移除）。 */
function statusText(state: FloatingBallState): string {
	if (state.runningCount > 0) return `Running ${state.runningCount}`;
	if (state.activeCount > 0) return `Active ${state.activeCount}`;
	return "PiDeck";
}

/** 透明窗口内预留圆环、徽标和气泡空间；拖动只发送采样通知，坐标由宿主统一读取。 */
function FloaterApp() {
	const [state, setState] = useState<FloatingBallState | null>(null);
	const [dragging, setDragging] = useState(false);
	const cleanupDragRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		let cancelled = false;
		const update = (next: FloatingBallState) => {
			if (cancelled) return;
			setI18nLocale(next.locale);
			setState(next);
		};
		void api.floatingBall
			.getState()
			.then(update)
			.catch(() => undefined);
		const off = api.floatingBall.onStateChanged(update);
		return () => {
			cancelled = true;
			off();
			cleanupDragRef.current?.();
		};
	}, []);

	const onMouseDown = (event: React.MouseEvent) => {
		if (event.button !== 0) return;
		cleanupDragRef.current?.();
		setDragging(true);
		void api.floatingBall.dragStart().catch(() => undefined);
		let rafId = 0;
		let ended = false;
		const onMove = (ev: MouseEvent) => {
			cancelAnimationFrame(rafId);
			rafId = requestAnimationFrame(() => {
				if (!ended) void api.floatingBall.dragMove(ev.screenX, ev.screenY).catch(() => undefined);
			});
		};
		const onUp = () => {
			if (ended) return;
			ended = true;
			setDragging(false);
			cancelAnimationFrame(rafId);
			void api.floatingBall.dragEnd().catch(() => undefined);
			window.removeEventListener("mousemove", onMove);
			window.removeEventListener("mouseup", onUp);
			window.removeEventListener("blur", onUp);
			clearTimeout(stuckTimeout);
			cleanupDragRef.current = null;
		};
		// 失去焦点/丢 mouseup 都有配对清理，不把下一次点击粘进上一次拖动。
		const stuckTimeout = setTimeout(onUp, 5000);
		cleanupDragRef.current = onUp;
		window.addEventListener("mousemove", onMove);
		window.addEventListener("mouseup", onUp);
		window.addEventListener("blur", onUp);
	};

	const onContextMenu = (event: React.MouseEvent) => {
		event.preventDefault();
		void api.floatingBall.contextMenu().catch(() => undefined);
	};

	if (!state) return null;
	const text = statusText(state);
	return (
		<div className="flex h-full w-full select-none flex-col items-center justify-end gap-1.5 bg-transparent px-2 pb-2 font-sans">
			<button
				type="button"
				className={`relative grid size-16 shrink-0 place-items-center rounded-full border border-border-strong bg-bg-panel text-foreground shadow-md transition-transform duration-fast focus-visible:outline-2 focus-visible:outline-primary ${dragging ? "scale-95 cursor-grabbing" : "cursor-grab hover:scale-[1.02]"} ${state.runningCount > 0 ? "ring-2 ring-success/50" : ""}`}
				onMouseDown={onMouseDown}
				onContextMenu={onContextMenu}
				onKeyDown={(event) => {
					if (event.key !== "Enter" && event.key !== " ") return;
					event.preventDefault();
					void api.floatingBall
						.dragStart()
						.then(() => api.floatingBall.dragEnd())
						.catch(() => undefined);
				}}
				aria-label={text}
				title={text}
			>
				<PiTuiLogoMark size={32} />
				{state.runningCount > 0 && state.showRunningBadge !== false ? <span className="absolute -right-0.5 -top-0.5 grid h-5 min-w-5 place-items-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground shadow-sm">{state.runningCount > 99 ? "99+" : state.runningCount}</span> : null}
			</button>
		</div>
	);
}

ReactDOM.createRoot(document.getElementById("root")!).render(
	<React.StrictMode>
		<FloaterApp />
	</React.StrictMode>,
);
