/**
 * 域文件共用的 preload 侧 IPC 胶水。
 *
 * - `subscribe`：所有 `on*` 方法都经它注册监听并返回退订函数（docs/architecture.md：事件订阅必须返回 unsubscribe）。
 * - `clipboardSync`：同步读取必须走主进程 sendSync —— Electron 38 已废弃 preload 直连 clipboard。
 */
import { ipcRenderer } from "electron";

export function subscribe<T>(channel: string, callback: (payload: T) => void) {
	const listener = (_event: Electron.IpcRendererEvent, payload: T) => callback(payload);
	ipcRenderer.on(channel, listener);
	return () => {
		ipcRenderer.removeListener(channel, listener);
	};
}

export function clipboardSync<T>(channel: string, fallback: T): T {
	try {
		return ipcRenderer.sendSync(channel) as T;
	} catch {
		return fallback;
	}
}
