/** In-page `<webview>` plugin surfaces with per-instance origins, no Node bridge, and paired lifecycle cleanup.
 *
 * The guest webview is created by the renderer (`partition: host-plugin:<instanceId>`) and validated by the
 * window-level attach policy (`hostPluginWebviewPolicy`). This host owns everything around the guest: the
 * isolated session, the asset protocol, broker binding, revocation and the session-change poll loop. */
import { session, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { setInterval, clearInterval } from "node:timers";
import type { HostPluginContext, HostPluginEvent, HostPluginMountInput, HostPluginSessionsRevision } from "../../shared/types/hostPlugin";
import { ipcChannels } from "../../shared/ipc";
import type { HostPluginManager } from "./HostPluginManager";
import type { HostPluginBroker } from "./HostPluginBroker";
import type { HostPluginSessions } from "./HostPluginSessions";
import type { HostPluginWebviewBridge } from "./hostPluginWebviewPolicy";
import { readApprovedPluginAsset } from "./hostPluginFiles";
import { HOST_PLUGIN_CSP, HOST_PLUGIN_SCHEME, pluginAssetFromUrl } from "./hostPluginPolicy";

type Instance = { id: string; pluginId: string; fingerprint: string; context: HostPluginContext; entryUrl: string; guest?: WebContents; revision?: HostPluginSessionsRevision; generation: number; polling: boolean; detach: () => void };

export class HostPluginViewHost implements HostPluginWebviewBridge {
	private readonly instances = new Map<string, Instance>();
	private readonly unsubscribe: () => void;
	private readonly timer: ReturnType<typeof setInterval>;
	constructor(
		private readonly manager: HostPluginManager,
		private readonly broker: HostPluginBroker,
		private readonly sessions: HostPluginSessions,
		private readonly preparedPreload: string,
	) {
		this.unsubscribe = manager.onChanged(() => {
			for (const instance of this.instances.values()) if (manager.getEnabled(instance.pluginId)?.fingerprint !== instance.fingerprint) this.unmount(instance.id);
		});
		this.timer = setInterval(() => {
			for (const instance of this.instances.values()) if (instance.guest) void this.poll(instance);
		}, 1500);
		this.timer.unref();
	}

	/** The only URL space served is this instance's approved package; HTTP/file requests are denied. */
	async mount(input: HostPluginMountInput): Promise<{ instanceId: string; entryUrl: string }> {
		const plugin = this.manager.getEnabled(input.pluginId);
		const panel = plugin?.manifest.contributes.panels.find((item) => item.id === input.panelId);
		if (!plugin || !panel) throw new Error("plugin-not-authorized");
		// Phase one owns one workbench surface per plugin: a new allocation replaces the previous one.
		for (const instance of this.instances.values()) if (instance.pluginId === plugin.manifest.id) this.unmount(instance.id);
		const id = randomUUID();
		const isolated = session.fromPartition(`host-plugin:${id}`);
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
		const entryUrl = `${HOST_PLUGIN_SCHEME}://${id}/${panel.entry}`;
		const instance: Instance = {
			id,
			pluginId: plugin.manifest.id,
			fingerprint: plugin.fingerprint,
			context: input.context,
			entryUrl,
			generation: 0,
			polling: false,
			detach: () => {
				isolated.protocol.unhandle(HOST_PLUGIN_SCHEME);
				isolated.webRequest.onBeforeRequest(null);
			},
		};
		this.instances.set(id, instance);
		return { instanceId: id, entryUrl };
	}

	/** Late guests (unmount/revoke raced the attach) are closed immediately — never served assets. */
	attachGuest(id: string, guest: WebContents): void {
		const instance = this.instances.get(id);
		const plugin = instance && this.manager.getEnabled(instance.pluginId);
		if (!instance || !plugin || plugin.fingerprint !== instance.fingerprint || instance.guest) {
			guest.close();
			return;
		}
		instance.guest = guest;
		this.broker.bind(guest.id, instance.pluginId, instance.fingerprint, instance.context);
		// The package serves a static SPA; top-level navigation away from the entry origin is never legitimate.
		const denyNavigation = (event: { preventDefault(): void }) => event.preventDefault();
		guest.on("will-frame-navigate", denyNavigation);
		guest.on("will-redirect", denyNavigation);
		guest.on("will-attach-webview", denyNavigation);
		guest.setWindowOpenHandler(() => ({ action: "deny" }));
		const onGone = () => this.unmount(id);
		guest.once("render-process-gone", onGone);
		guest.once("destroyed", onGone);
		this.injectAppearance(instance);
	}

	hasLive(id: string): boolean {
		return this.instances.has(id);
	}

	/** did-attach 阶段拿不到 partition 字符串（Electron 43 Session 未暴露）；
	 *  同 partition 的 session.fromPartition 返回同一实例，用对象身份匹配回实例表。 */
	instanceForGuest(guest: WebContents): string | null {
		for (const id of this.instances.keys()) if (guest.session === session.fromPartition(`host-plugin:${id}`)) return id;
		return null;
	}

	preloadPath(): string {
		return this.preparedPreload;
	}

	/** Context updates only (theme/locale/scope); layout is plain DOM and needs no synchronization. */
	update(id: string, context: HostPluginContext): void {
		const instance = this.instances.get(id);
		if (!instance) throw new Error("unknown-instance");
		if (JSON.stringify(instance.context) === JSON.stringify(context)) return;
		instance.context = context;
		instance.generation += 1;
		instance.revision = undefined;
		if (instance.guest) this.broker.update(instance.guest.id, context);
		this.injectAppearance(instance);
		this.emit(instance, { type: "context.changed", context });
	}

	unmount(id: string): void {
		const instance = this.instances.get(id);
		if (!instance) return;
		this.instances.delete(id);
		if (instance.guest && !instance.guest.isDestroyed()) {
			this.broker.unbind(instance.guest.id);
			instance.guest.close();
		}
		instance.detach();
	}

	private emit(instance: Instance, event: HostPluginEvent): void {
		if (this.instances.get(instance.id) === instance && instance.guest && !instance.guest.isDestroyed()) instance.guest.send(ipcChannels.hostPluginEvent, event);
	}

	/** Panels follow the PiDeck theme, not the OS setting: color-scheme aligns native controls/scrollbars,
	 *  and the host token set is re-declared as CSS variables so plugin styles can consume PiDeck semantics. */
	private injectAppearance(instance: Instance): void {
		const guest = instance.guest;
		if (!guest || guest.isDestroyed()) return;
		const tokens = Object.entries(instance.context.tokens ?? {})
			.map(([name, value]) => `${name}:${value}`)
			.join("");
		// Electron 43 没有 per-contents setEmulatedMedia；insertCSS 按插入顺序覆盖旧值，切主题无需移除。
		guest.insertCSS(`:root{color-scheme:${instance.context.theme === "light" ? "light" : "dark"};${tokens}}`).catch(() => {
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
