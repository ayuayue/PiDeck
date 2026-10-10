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
		navigate: (sessionId, entryId) => request<void>({ method: "workbench.navigate", sessionId, entryId }),
		openExternal: (url) => request<void>({ method: "workbench.openExternal", url }),
	},
	network: { request: (input) => request({ method: "network.request", request: input }) },
	onEvent: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, event: HostPluginEvent) => listener(event);
		ipcRenderer.on(ipcChannels.hostPluginEvent, handler);
		return () => ipcRenderer.removeListener(ipcChannels.hostPluginEvent, handler);
	},
};
contextBridge.exposeInMainWorld("pideck", api);
