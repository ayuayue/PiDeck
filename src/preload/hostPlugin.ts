/** Plugin-only preload: five typed requests, no desktop API, ipcRenderer, Node, or arbitrary channels. */
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
		entries: (sessionId, cursor) => request({ method: "sessions.entries", sessionId, cursor }),
	},
	storage: { get: (key) => request({ method: "storage.get", key }), set: (key, value) => request({ method: "storage.set", key, value }) },
	workbench: { navigate: (sessionId, entryId) => request<void>({ method: "workbench.navigate", sessionId, entryId }) },
	onEvent: (listener) => {
		const handler = (_event: Electron.IpcRendererEvent, event: HostPluginEvent) => listener(event);
		ipcRenderer.on(ipcChannels.hostPluginEvent, handler);
		return () => ipcRenderer.removeListener(ipcChannels.hostPluginEvent, handler);
	},
};
contextBridge.exposeInMainWorld("pideck", api);
