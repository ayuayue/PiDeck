import type { SelectionToolShowPayload } from "../../../shared/types/selectionTool";
import { desktopApi } from "../desktopApi";

type CaptureListener = (payload: SelectionToolShowPayload) => void;

/**
 * 捕获载荷桥：React 挂载前就可能收到第一个 selection-tool:captured。
 *
 * 时序问题：主进程在 did-finish-load 后立即推送，而 React 的 useEffect 要等首帧后
 * 才运行——如果只在 useEffect 里订阅，第一次划词会「窗口弹出来但内容是空的」。
 * 因此 bridge 在渲染前 attach（main.tsx），把载荷缓存在模块级，视图订阅时立即回放。
 */
let latest: SelectionToolShowPayload | null = null;
let unsubscribeTransport: (() => void) | null = null;
const listeners = new Set<CaptureListener>();

/** 订阅主进程推送；窗口生命周期内只建一次（preload 监听成对注销见 detach）。 */
export function attachSelectionCaptureBridge(): void {
	if (unsubscribeTransport) return;
	unsubscribeTransport = desktopApi.selectionTool.onCaptured((payload) => {
		latest = payload;
		for (const listener of listeners) listener(payload);
	});
}

/** 页面卸载（窗口销毁）时退订 preload 监听：与 attach 成对，避免监听悬挂。 */
export function detachSelectionCaptureBridge(): void {
	const unsubscribe = unsubscribeTransport;
	unsubscribeTransport = null;
	latest = null;
	listeners.clear();
	unsubscribe?.();
}

/** 视图订阅捕获事件；挂载时若已有缓存载荷立即回放一次。返回退订函数。 */
export function subscribeSelectionCapture(listener: CaptureListener): () => void {
	listeners.add(listener);
	if (latest) listener(latest);
	return () => {
		listeners.delete(listener);
	};
}
