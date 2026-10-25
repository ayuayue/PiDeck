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
	/** 同帧 resize 合并用的帧句柄 */
	frame: number | null;
	/** 拖拽循环自身的帧句柄（必须可取消，见 stopDrag） */
	loopFrame: number | null;
	registered: boolean;
	/** 当前挂载的使用者数量：只有最后一个卸载才停循环，避免 A 面板卸载打断 B 的拖拽 */
	consumers: number;
	/** 本次拖拽开始时间：用作丢失 pointerup 时的兜底上限 */
	startedAt: number;
};

/** 拖拽循环最长存活时间：松手事件丢失（指针移出窗口/被系统弹窗吞掉）时的兜底。 */
const MAX_DRAG_LOOP_MS = 30_000;

let tracker: DragTracker = { active: false, frame: null, loopFrame: null, registered: false, consumers: 0, startedAt: 0 };

/** 派发一帧 resize（rAF 合并同帧多次请求） */
function dispatchResizeFrame() {
	if (tracker.frame !== null) return; // 本帧已排队
	tracker.frame = requestAnimationFrame(() => {
		tracker.frame = null;
		window.dispatchEvent(new Event("resize"));
	});
}

/** 停止拖拽循环（幂等）：拖拽期间每帧派发 resize，停止时必须取消未执行的循环帧。 */
function stopDrag() {
	tracker.active = false;
	if (tracker.loopFrame !== null) {
		cancelAnimationFrame(tracker.loopFrame);
		tracker.loopFrame = null;
	}
}

/** 拖拽循环：active 期间每帧派发一次 resize */
function dragLoop() {
	if (!tracker.active) {
		tracker.loopFrame = null;
		return;
	}
	// 兜底（2027-02）：pointerup 只挂在 document 上，指针移出窗口/被系统弹窗
	// 吞掉时收不到松手事件，循环会以 60fps 永久派发 window resize（floating-ui
	// 每帧重定位浮层）。超时或窗口失焦一律停。
	if (Date.now() - tracker.startedAt > MAX_DRAG_LOOP_MS) {
		stopDrag();
		return;
	}
	dispatchResizeFrame();
	tracker.loopFrame = requestAnimationFrame(dragLoop);
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
		tracker.startedAt = Date.now();
		dispatchResizeFrame();
		if (tracker.loopFrame === null) tracker.loopFrame = requestAnimationFrame(dragLoop);
	};
	const stop = () => stopDrag();
	// 窗口失焦/页面隐藏时指针状态不可信（系统弹窗、Alt+Tab、切虚拟桌面），
	// 直接收口，别等到 30s 上限。
	const stopOnHide = () => {
		if (document.visibilityState === "hidden") stopDrag();
	};

	document.addEventListener("pointerdown", onPointerDown);
	document.addEventListener("pointerup", stop);
	document.addEventListener("pointercancel", stop);
	window.addEventListener("blur", stop);
	document.addEventListener("visibilitychange", stopOnHide);
}

export function useNotifyLayoutResized(): () => void {
	ensureRegistered();

	// 使用者计数（2027-02）：AppShell / SessionView / SessionSplitStage 各自挂载本 hook，
	// 原先任一组件卸载都会把全局 active 置 false——A 面板卸载会打断 B 正在进行的拖拽。
	// 现在只有最后一个使用者卸载才停循环并取消待执行帧。
	useEffect(() => {
		tracker.consumers += 1;
		return () => {
			tracker.consumers = Math.max(0, tracker.consumers - 1);
			if (tracker.consumers > 0) return;
			stopDrag();
			if (tracker.frame !== null) {
				cancelAnimationFrame(tracker.frame);
				tracker.frame = null;
			}
		};
	}, []);

	// 供布局落定 handler 兜底调用（如 onLayoutChanged：键盘调整、程序化变更）
	return useCallback(() => {
		dispatchResizeFrame();
	}, []);
}
