/** Host-plugin management belongs to the main desktop frame; guest requests have a separate broker. */
import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { HostPluginResult } from "../../shared/types/hostPlugin";
import type { HostPluginService } from "../plugins/HostPluginService";
import { isHostPluginId, isHostPluginPermission, isPluginRecord } from "../plugins/hostPluginManifest";
import { downloadGitHubPlugin } from "../plugins/hostPluginGitHub";
import { isLocalServiceId } from "../../shared/localServices";
import { createHostPluginScaffold } from "../plugins/hostPluginScaffold";
import { parsePluginContext } from "../plugins/hostPluginPolicy";
import { openSystemPath } from "../fs/openPath";
import { getAppLogger } from "../logging/sharedLogger";

export function registerHostPluginsIpc(service: HostPluginService, getWindow: () => BrowserWindow | null): () => void {
	const channels = [
		ipcChannels.hostPluginsList,
		ipcChannels.hostPluginsRescan,
		ipcChannels.hostPluginsInstall,
		ipcChannels.hostPluginsInstallDirectory,
		ipcChannels.hostPluginsInstallGitHub,
		ipcChannels.hostPluginsScaffold,
		ipcChannels.hostPluginsSetEnabled,
		ipcChannels.hostPluginsOpenDirectory,
		ipcChannels.hostPluginsMount,
		ipcChannels.hostPluginsUpdate,
		ipcChannels.hostPluginsUnmount,
		ipcChannels.hostPluginsRemove,
	];
	/** 外部链接是本层唯一持有 shell 的地方：策略层已收窄到 https，这里再复查一次协议后才交系统。 */
	function openExternal(url: string): void {
		try {
			const parsed = new URL(url);
			if (parsed.protocol !== "https:" || !parsed.hostname) return;
			void shell.openExternal(parsed.toString()).catch((error: unknown) => void getAppLogger()?.warn("host-plugins", "openExternal failed", { message: String(error) }));
		} catch {
			/* 形状不合法的 URL 直接丢弃：不开浏览器也不报错。 */
		}
	}
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
	ipcMain.handle(ipcChannels.hostPluginsInstall, (event) =>
		result(async () => {
			const window = trustedWindow(event);
			// 路径只来自主进程对话框，渲染层无法指定任意文件。
			const picked = await dialog.showOpenDialog(window, { title: "PiDeck host plugin", filters: [{ name: "PiDeck host plugin", extensions: ["pideck-plugin"] }], properties: ["openFile"] });
			if (picked.canceled || !picked.filePaths[0]) throw new Error("canceled");
			return service.manager.installArchive(picked.filePaths[0]);
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsInstallDirectory, (event) =>
		result(async () => {
			const window = trustedWindow(event);
			// 与归档入口分开弹：Windows 上 openFile + openDirectory 同时给会退化成只能选目录，
			// .pideck-plugin 反而选不到（见 shared/ipc.ts 的 hostPluginsInstallDirectory）。
			const picked = await dialog.showOpenDialog(window, { title: "PiDeck host plugin folder", properties: ["openDirectory"] });
			if (picked.canceled || !picked.filePaths[0]) throw new Error("canceled");
			return service.manager.installDirectory(picked.filePaths[0]);
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsInstallGitHub, (event, url: unknown) =>
		result(async () => {
			trustedWindow(event);
			// 链接是渲染层唯一能提供的输入：形状由 parseGitHubPluginUrl 收窄到 github.com 仓库页，
			// 下载与解包都在主进程完成，插件目录路径始终由主进程自己生成。
			if (typeof url !== "string" || url.length === 0 || url.length > 300) throw new Error("invalid-github-url");
			const download = await downloadGitHubPlugin(url);
			return service.manager.installFiles(download.files);
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsScaffold, (event, input: unknown) =>
		result(async () => {
			trustedWindow(event);
			// 输入在边界收窄：id/name 只当文本用，权限走 manifest 的同一份白名单，模式只接受两个枚举。
			if (!isPluginRecord(input) || typeof input.id !== "string" || input.id.length > 80) throw new Error("invalid-plugin");
			if (typeof input.name !== "string" || input.name.trim().length === 0 || input.name.length > 160 || /[\u0000-\u001f]/.test(input.name)) throw new Error("invalid-plugin");
			if (!Array.isArray(input.permissions) || input.permissions.length > 6 || !input.permissions.every(isHostPluginPermission)) throw new Error("invalid-plugin");
			if (input.services !== undefined && (!Array.isArray(input.services) || input.services.length < 1 || input.services.length > 8 || !input.services.every(isLocalServiceId))) throw new Error("invalid-plugin");
			if (input.presentation !== "modal" && input.presentation !== "page") throw new Error("invalid-plugin");
			await createHostPluginScaffold(service.manager.directory, { id: input.id, name: input.name, permissions: input.permissions, ...(input.services !== undefined ? { services: input.services } : {}), presentation: input.presentation });
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
			if (await openSystemPath(service.manager.directory)) throw new Error("open-directory-failed");
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsMount, (event, input: unknown) =>
		result(() => {
			trustedWindow(event);
			if (!isPluginRecord(input) || !isHostPluginId(input.pluginId) || !isHostPluginId(input.panelId)) throw new Error("invalid-plugin");
			return service.mount({ pluginId: input.pluginId, panelId: input.panelId, context: parsePluginContext(input.context) });
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsUpdate, (event, id: unknown, context: unknown) =>
		result(() => {
			trustedWindow(event);
			service.update(instanceId(id), parsePluginContext(context));
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsUnmount, (event, id: unknown) =>
		result(() => {
			// 与其余管理入口同一信任边界：卸载是生命周期操作，不允许 guest 帧。
			trustedWindow(event);
			return service.unmount(instanceId(id));
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginsRemove, (event, id: unknown) =>
		result(() => {
			// 与其余管理入口同一信任边界：删目录是不可逆操作，不允许 guest 帧。
			trustedWindow(event);
			if (!isHostPluginId(id)) throw new Error("invalid-plugin");
			return service.manager.remove(id);
		}),
	);
	ipcMain.handle(ipcChannels.hostPluginRequest, (event, request: unknown) => service.broker.request(event.sender.id, event.senderFrame === event.sender.mainFrame, request));
	const unsubscribe = service.manager.onChanged(() => {
		const window = getWindow();
		if (window && !window.isDestroyed()) window.webContents.send(ipcChannels.hostPluginsChanged);
	});
	const unsubscribeNavigate = service.broker.onNavigate((input) => {
		const window = getWindow();
		if (window && !window.isDestroyed()) window.webContents.send(ipcChannels.hostPluginNavigate, input);
	});
	const unsubscribeOpenExternal = service.broker.onOpenExternal(openExternal);
	const unsubscribeOpenBrowser = service.broker.onOpenBrowser((url) => {
		const window = getWindow();
		if (window && !window.isDestroyed()) window.webContents.send(ipcChannels.hostPluginOpenBrowser, url);
	});
	return () => {
		unsubscribe();
		unsubscribeNavigate();
		unsubscribeOpenExternal();
		unsubscribeOpenBrowser();
		for (const channel of [...channels, ipcChannels.hostPluginRequest]) ipcMain.removeHandler(channel);
	};
}
