/** Host-plugin management belongs to the main desktop frame; guest requests have a separate broker. */
import { ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { HostPluginResult } from "../../shared/types/hostPlugin";
import type { HostPluginService } from "../plugins/HostPluginService";
import { isHostPluginId, isPluginRecord } from "../plugins/hostPluginManifest";
import { parsePluginBounds, parsePluginContext } from "../plugins/hostPluginPolicy";
import { getAppLogger } from "../logging/sharedLogger";

export function registerHostPluginsIpc(service: HostPluginService, getWindow: () => BrowserWindow | null): () => void {
	const channels = [ipcChannels.hostPluginsList, ipcChannels.hostPluginsRescan, ipcChannels.hostPluginsSetEnabled, ipcChannels.hostPluginsOpenDirectory, ipcChannels.hostPluginsMount, ipcChannels.hostPluginsUpdate, ipcChannels.hostPluginsUnmount];
	function trustedWindow(event: IpcMainInvokeEvent): BrowserWindow {
		const window = getWindow();
		if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame) throw new Error("sender-not-authorized");
		return window;
	}
	function instanceId(value: unknown): string {
		if (typeof value !== "string" || !/^[a-f0-9-]{36}$/.test(value)) throw new Error("invalid-instance");
		return value;
	}
	async function result<T>(operation: () => Promise<T> | T): Promise<HostPluginResult<T>> {
		try {
			return { ok: true, value: await operation() };
		} catch (error) {
			const code = error instanceof Error && /^[a-z-]{1,80}$/.test(error.message) ? error.message : "plugin-operation-failed";
			void getAppLogger()?.warn("host-plugins", "Plugin operation rejected", { code });
			return { ok: false, code };
		}
	}
	ipcMain.handle(ipcChannels.hostPluginsList, (event) =>
		result(() => {
			trustedWindow(event);
			return service.manager.catalog();
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsRescan, (event) =>
		result(() => {
			trustedWindow(event);
			return service.manager.rescan();
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsSetEnabled, (event, id: unknown, enabled: unknown, fingerprint: unknown) =>
		result(() => {
			trustedWindow(event);
			if (!isHostPluginId(id) || typeof enabled !== "boolean" || typeof fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint)) throw new Error("invalid-plugin");
			return service.manager.setEnabled(id, enabled, fingerprint);
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsOpenDirectory, (event) =>
		result(async () => {
			trustedWindow(event);
			if (await shell.openPath(service.manager.directory)) throw new Error("open-directory-failed");
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsMount, (event, input: unknown) =>
		result(() => {
			const window = trustedWindow(event);
			if (!isPluginRecord(input) || !isHostPluginId(input.pluginId) || !isHostPluginId(input.panelId)) throw new Error("invalid-plugin");
			return service.mount(window, { pluginId: input.pluginId, panelId: input.panelId, context: parsePluginContext(input.context), bounds: parsePluginBounds(input.bounds) });
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsUpdate, (event, id: unknown, context: unknown, bounds: unknown, visible: unknown) =>
		result(() => {
			const window = trustedWindow(event);
			if (typeof visible !== "boolean") throw new Error("invalid-visibility");
			service.update(instanceId(id), window, parsePluginContext(context), parsePluginBounds(bounds), visible);
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsUnmount, (event, id: unknown) => result(() => service.unmount(instanceId(id), trustedWindow(event))));
	ipcMain.handle(ipcChannels.hostPluginRequest, (event, request: unknown) => service.broker.request(event.sender.id, event.senderFrame === event.sender.mainFrame, request));
	const unsubscribe = service.manager.onChanged(() => {
		const window = getWindow();
		if (window && !window.isDestroyed()) window.webContents.send(ipcChannels.hostPluginsChanged);
	});
	return () => {
		unsubscribe();
		for (const channel of [...channels, ipcChannels.hostPluginRequest]) ipcMain.removeHandler(channel);
	};
}
