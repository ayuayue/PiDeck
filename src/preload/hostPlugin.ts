/** Plugin-only preload: typed requests over one channel, no desktop API, ipcRenderer, Node, or arbitrary channels. */
import { contextBridge, ipcRenderer } from "electron";
import { ipcChannels } from "../shared/ipc";
import type { HostPluginApi, HostPluginEvent, HostPluginRequest, HostPluginResponse } from "../shared/types/hostPlugin";

async function request<T>(input: HostPluginRequest): Promise<T> {
	const result: HostPluginResponse = await ipcRenderer.invoke(ipcChannels.hostPluginRequest, input);
	if (!result.ok) throw new Error(result.code);
	// The broker owns the response contract; casts do not authorize plugin input.
	return result.value as T;
}

/**
 * 主进程对无返回值的方法回的是 null，但契约（HostPluginApi）声明的是 void。
 * 直接透出 null 会让 `await openUi()` 拿到 null 而不是 undefined，
 * 插件按契约做解构/属性访问就会在边界外爆掉，所以在 preload 收口。
 */
async function requestVoid(input: HostPluginRequest): Promise<void> {
	await request<unknown>(input);
}

const api: HostPluginApi = {
	apiVersion: 1,
	context: { get: () => request({ method: "context.get" }) },
	sessions: {
		list: (offset) => request({ method: "sessions.list", offset }),
		get: (sessionId) => request({ method: "sessions.get", sessionId }),
		search: (query, limit) => request({ method: "sessions.search", query, limit }),
		entries: (sessionId, cursor) => request({ method: "sessions.entries", sessionId, cursor }),
	},
	storage: {
		get: (key) => request({ method: "storage.get", key }),
		set: (key, value) => request({ method: "storage.set", key, value }),
		keys: () => request({ method: "storage.keys" }),
		remove: (key) => request({ method: "storage.delete", key }),
	},
	workbench: {
		navigate: (sessionId, entryId) => requestVoid({ method: "workbench.navigate", sessionId, entryId }),
		openExternal: (url) => requestVoid({ method: "workbench.openExternal", url }),
	},
	network: { request: (input) => request({ method: "network.request", request: input }) },
	services: {
		status: (id) => request({ method: "service.status", id }),
		start: (id) => request({ method: "service.start", id }),
		stop: (id) => request({ method: "service.stop", id }),
		openUi: (id, pid) => requestVoid({ method: "service.openUi", id, ...(typeof pid === "number" ? { pid } : {}) }),
	},
	onEvent: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, event: HostPluginEvent) => listener(event);
		ipcRenderer.on(ipcChannels.hostPluginEvent, handler);
		return () => ipcRenderer.removeListener(ipcChannels.hostPluginEvent, handler);
	},
};
contextBridge.exposeInMainWorld("pideck", api);
