/** Isolated browser views with per-instance origins, no Node bridge, and paired lifecycle cleanup. */
import { WebContentsView, session, type BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { setInterval, clearInterval } from "node:timers";
import type { HostPluginBounds, HostPluginContext, HostPluginEvent, HostPluginMountInput, HostPluginSessionsRevision } from "../../shared/types/hostPlugin";
import { ipcChannels } from "../../shared/ipc";
import type { HostPluginManager } from "./HostPluginManager";
import type { HostPluginBroker } from "./HostPluginBroker";
import type { HostPluginSessions } from "./HostPluginSessions";
import { readApprovedPluginAsset } from "./hostPluginFiles";
import { HOST_PLUGIN_CSP, HOST_PLUGIN_SCHEME, pluginAssetFromUrl } from "./hostPluginPolicy";

type Instance = { id: string; pluginId: string; fingerprint: string; window: BrowserWindow; view: WebContentsView; context: HostPluginContext; revision?: HostPluginSessionsRevision; generation: number; visible: boolean; polling: boolean; detach: () => void };

export class HostPluginViewHost {
	private readonly instances = new Map<string, Instance>();
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	constructor(
		private readonly manager: HostPluginManager,
		private readonly broker: HostPluginBroker,
		private readonly sessions: HostPluginSessions,
		private readonly preload: string,
	) {
		this.unsubscribe = manager.onChanged(() => {
			for (const instance of this.instances.values()) if (manager.getEnabled(instance.pluginId)?.fingerprint !== instance.fingerprint) this.unmount(instance.id);
		});
		this.timer = setInterval(() => {
			for (const instance of this.instances.values()) if (instance.visible) void this.poll(instance);
		}, 1500);
		this.timer.unref();
	}

	/** The only URL space served is this instance's approved package; HTTP/file requests are denied. */
	async mount(window: BrowserWindow, input: HostPluginMountInput): Promise<{ instanceId: string }> {
		const plugin = this.manager.getEnabled(input.pluginId);
		const panel = plugin?.manifest.contributes.panels.find((item) => item.id === input.panelId);
		if (!plugin || !panel || window.isDestroyed()) throw new Error("plugin-not-authorized");
		// Phase one owns one workbench surface, never an unbounded pool of renderer processes.
		for (const instance of this.instances.values()) if (instance.window === window) this.unmount(instance.id);
		const id = randomUUID();
		const isolated = session.fromPartition(`host-plugin-${id}`);
		isolated.setPermissionCheckHandler(() => false);
		isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
		isolated.setDevicePermissionHandler(() => false);
		isolated.on("will-download", (event) => event.preventDefault());
		isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !pluginAssetFromUrl(details.url, id) }));
		isolated.protocol.handle(HOST_PLUGIN_SCHEME, async (request) => {
			try {
				const asset = pluginAssetFromUrl(request.url, id);
				if (request.method !== "GET" || !asset || this.manager.getEnabled(plugin.manifest.id)?.fingerprint !== plugin.fingerprint || !this.instances.has(id)) return new Response(null, { status: 403 });
				const { bytes, mime } = await readApprovedPluginAsset(plugin, asset);
				if (this.manager.getEnabled(plugin.manifest.id)?.fingerprint !== plugin.fingerprint || !this.instances.has(id)) return new Response(null, { status: 403 });
				return new Response(new Uint8Array(bytes), { headers: { "Content-Type": mime, "Content-Security-Policy": HOST_PLUGIN_CSP, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } });
			} catch {
				// A changed file cannot continue using previously approved code or data permissions.
				this.unmount(id);
				return new Response(null, { status: 403 });
			}
		});
		let view: WebContentsView;
		try {
			view = new WebContentsView({ webPreferences: { session: isolated, preload: this.preload, sandbox: true, contextIsolation: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true, allowRunningInsecureContent: false, webviewTag: false, devTools: false } });
		} catch (error) {
			isolated.protocol.unhandle(HOST_PLUGIN_SCHEME);
			isolated.webRequest.onBeforeRequest(null);
			throw error;
		}
		const entryUrl = `${HOST_PLUGIN_SCHEME}://${id}/${panel.entry}`;
		const denyNavigation = (event: { preventDefault(): void }) => event.preventDefault();
		view.webContents.on("will-frame-navigate", denyNavigation);
		view.webContents.on("will-redirect", denyNavigation);
		view.webContents.on("will-attach-webview", denyNavigation);
		view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		const onClosed = () => this.unmount(id);
		window.once("closed", onClosed);
		view.webContents.once("render-process-gone", onClosed);
		const instance: Instance = {
			id,
			pluginId: plugin.manifest.id,
			fingerprint: plugin.fingerprint,
			window,
			view,
			context: input.context,
			generation: 0,
			visible: true,
			polling: false,
			detach: () => {
				window.removeListener("closed", onClosed);
				isolated.protocol.unhandle(HOST_PLUGIN_SCHEME);
				isolated.webRequest.onBeforeRequest(null);
			},
		};
		this.instances.set(id, instance);
		this.broker.bind(view.webContents.id, plugin.manifest.id, plugin.fingerprint, input.context);
		this.emulateTheme(instance, input.context.theme);
		window.contentView.addChildView(view);
		this.update(id, window, input.context, input.bounds, true);
		try {
			await view.webContents.loadURL(entryUrl);
			if (!this.instances.has(id) || this.manager.getEnabled(plugin.manifest.id)?.fingerprint !== plugin.fingerprint) throw new Error("plugin-revoked");
			return { instanceId: id };
		} catch (error) {
			this.unmount(id);
			throw error;
		}
	}

	/** Bounds originate in trusted UI but are still clamped to the containing window. */
	update(id: string, window: BrowserWindow, context: HostPluginContext, bounds: HostPluginBounds, visible: boolean): void {
		const instance = this.instances.get(id);
		if (!instance || instance.window !== window || window.isDestroyed()) throw new Error("unknown-instance");
		const contextChanged = JSON.stringify(instance.context) !== JSON.stringify(context);
		if (contextChanged) {
			instance.context = context;
			instance.generation += 1;
			instance.revision = undefined;
			this.broker.update(instance.view.webContents.id, context);
			this.emulateTheme(instance, context.theme);
			this.emit(instance, { type: "context.changed", context });
		}
		const content = window.getContentBounds();
		const scale = window.webContents.getZoomFactor();
		const x = Math.min(content.width, Math.round(bounds.x * scale));
		const y = Math.min(content.height, Math.round(bounds.y * scale));
		const width = Math.max(0, Math.min(content.width - x, Math.round(bounds.width * scale)));
		const height = Math.max(0, Math.min(content.height - y, Math.round(bounds.height * scale)));
		instance.view.setBounds({ x, y, width, height });
		instance.visible = visible && width > 0 && height > 0;
		instance.view.setVisible(instance.visible);
	}

	owns(id: string, window: BrowserWindow): boolean {
		return this.instances.get(id)?.window === window;
	}

	unmount(id: string): void {
		const instance = this.instances.get(id);
		if (!instance) return;
		this.instances.delete(id);
		this.broker.unbind(instance.view.webContents.id);
		instance.detach();
		if (!instance.window.isDestroyed()) instance.window.contentView.removeChildView(instance.view);
		if (!instance.view.webContents.isDestroyed()) instance.view.webContents.close();
	}

	private emit(instance: Instance, event: HostPluginEvent): void {
		if (this.instances.get(instance.id) === instance && !instance.view.webContents.isDestroyed()) instance.view.webContents.send(ipcChannels.hostPluginEvent, event);
	}

	/** Panels follow the PiDeck theme, not the OS setting: `nativeTheme.themeSource` (set from the app theme) already steers `prefers-color-scheme`; insertCSS additionally aligns native controls/scrollbars via `color-scheme`. */
	private emulateTheme(instance: Instance, theme: HostPluginContext["theme"]): void {
		if (!this.instances.has(instance.id) || instance.view.webContents.isDestroyed()) return;
		// Electron 43 没有 per-contents setEmulatedMedia；后续 insertCSS 按插入顺序覆盖旧值，切主题无需移除。
		instance.view.webContents.insertCSS(`:root { color-scheme: ${theme === "light" ? "light" : "dark"}; }`).catch(() => {
			/* Theme alignment is best-effort: pages without native controls are unaffected either way. */
		});
	}

	private async poll(instance: Instance): Promise<void> {
		if (instance.polling) return;
		instance.polling = true;
		const generation = instance.generation;
		try {
			const { revision, detail } = await this.sessions.changeSince(instance.context, instance.revision);
			if (this.instances.get(instance.id) !== instance || generation !== instance.generation) return;
			instance.revision = revision;
			if (detail.catalogChanged || detail.sessionId) this.emit(instance, { type: "sessions.changed", detail });
		} catch {
			/* Polling failure is local to this optional surface. */
		} finally {
			instance.polling = false;
		}
	}

	dispose(): void {
		clearInterval(this.timer);
		this.unsubscribe();
		for (const id of this.instances.keys()) this.unmount(id);
	}
}
