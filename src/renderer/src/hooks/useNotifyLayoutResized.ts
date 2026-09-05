import { useCallback, useEffect, useRef } from "react";

/**
 * 布局变化 → 通知悬浮层重算定位（模块级单例）。
 *
 * 背景：floating-ui（Radix 菜单/Popover/Tooltip 的定位引擎）只监听 scroll /
 * window resize / 锚点自身尺寸，不感知 flex 布局位移。拖拽分割线时面板宽度
 * 实时变化，已打开的悬浮层会停留在旧锚点位置，松手后才跳回（甚至不跳回）。
 *
 * 机制：
 * - document 级 pointerdown 命中分割线（.splitter/.v-splitter/.session-split-sash/.session-terminal-splitter）
 *   时启动 rAF 循环，拖拽期间每帧向 window 派发 resize——floating-ui 的
 *   autoUpdate 监听 window resize，据此重新测量锚点并重定位浮层；
 * - 不用 react-resizable-panels v4 的 onLayoutChange（已标记 deprecated，
 *   官方建议 onLayoutChanged 完成时回调，拖拽中每帧回调无稳定公开 API）；
 * - 松手/取消后停止循环；组件仍可在布局落定的 handler（onLayoutChanged 等）
 *   里调用返回的 notifyLayoutResized 兜底一次（覆盖键盘调整分隔条的场景）。
 *
 * 模块级单例：AppShell / SessionView / SessionSplitStage 各自挂载分割线，
 * 共享同一份 document 监听与 rAF 调度，避免每帧重复派发。
 */

type DragTracker = {
	active: boolean;
	frame: number | null;
	registered: boolean;
};

let tracker: DragTracker = { active: false, frame: null, registered: false };

/** 派发一帧 resize（rAF 合并同帧多次请求） */
function dispatchResizeFrame() {
	if (tracker.frame !== null) return; // 本帧已排队
	tracker.frame = requestAnimationFrame(() => {
		tracker.frame = null;
		window.dispatchEvent(new Event("resize"));
	});
}

/** 拖拽循环：active 期间每帧派发一次 resize */
function dragLoop() {
	if (!tracker.active) return;
	dispatchResizeFrame();
	requestAnimationFrame(dragLoop);
}

function ensureRegistered() {
	if (tracker.registered) return;
	tracker.registered = true;

	const isSplitter = (target: EventTarget | null): boolean => {
		// 命中分割线本体或其子元素（withHandle 手柄里的图标/手柄框）
		return target instanceof HTMLElement && Boolean(target.closest(".splitter, .v-splitter, .session-split-sash, .session-terminal-splitter"));
	};

	const onPointerDown = (event: PointerEvent) => {
		if (!isSplitter(event.target)) return;
		tracker.active = true;
		dispatchResizeFrame();
		requestAnimationFrame(dragLoop);
	};
	const stop = () => {
		tracker.active = false;
	};

	document.addEventListener("pointerdown", onPointerDown);
	document.addEventListener("pointerup", stop);
	document.addEventListener("pointercancel", stop);
}

export function useNotifyLayoutResized(): () => void {
	ensureRegistered();

	// 组件卸载时若该组件是唯一使用者，停止循环（保守处理：直接停掉即可，
	// 下一组件挂载时 pointerdown 会重新拉起；frame 未执行则一并取消）
	useEffect(
		() => () => {
			tracker.active = false;
			if (tracker.frame !== null) {
				cancelAnimationFrame(tracker.frame);
				tracker.frame = null;
			}
		},
		[],
	);

	// 供布局落定 handler 兜底调用（如 onLayoutChanged：键盘调整、程序化变更）
	return useCallback(() => {
		dispatchResizeFrame();
	}, []);
}
