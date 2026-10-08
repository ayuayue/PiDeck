/** Assembles independent plugin discovery, data capabilities and views; no pi runtime dependency. */
import type { BrowserWindow } from "electron";
import { join } from "node:path";
import type { HostPluginBounds, HostPluginContext, HostPluginMountInput } from "../../shared/types/hostPlugin";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import { preparePreloadPath } from "../preloadPath";
import { HostPluginManager } from "./HostPluginManager";
import { HostPluginSessions } from "./HostPluginSessions";
import { HostPluginStorage } from "./HostPluginStorage";
import { HostPluginBroker } from "./HostPluginBroker";
import { HostPluginViewHost } from "./HostPluginViewHost";

export class HostPluginService {
	readonly manager: HostPluginManager;
	readonly broker: HostPluginBroker;
	private views?: HostPluginViewHost;
	private disposed = false;
	private readonly sessions: HostPluginSessions;
	constructor(
		userData: string,
		catalog: SessionCatalog,
		private readonly preload: string,
	) {
		this.manager = new HostPluginManager(userData, process.env.PIDECK_DISABLE_HOST_PLUGINS === "1");
		this.sessions = new HostPluginSessions(catalog);
		this.broker = new HostPluginBroker(this.manager, this.sessions, new HostPluginStorage(join(userData, "host-plugin-storage")));
	}

	async initialize(): Promise<void> {
		await this.manager.load();
		const preload = await preparePreloadPath(this.preload, "host-plugin-preload.js");
		if (!this.disposed) this.views = new HostPluginViewHost(this.manager, this.broker, this.sessions, preload);
	}

	mount(window: BrowserWindow, input: HostPluginMountInput) {
		if (!this.views) throw new Error("plugin-host-unavailable");
		return this.views.mount(window, input);
	}

	update(id: string, window: BrowserWindow, context: HostPluginContext, bounds: HostPluginBounds, visible: boolean): void {
		if (!this.views) throw new Error("plugin-host-unavailable");
		this.views.update(id, window, context, bounds, visible);
	}

	unmount(id: string, window: BrowserWindow): void {
		if (this.views?.owns(id, window)) this.views.unmount(id);
	}

	dispose(): void {
		this.disposed = true;
		this.views?.dispose();
		this.broker.dispose();
		this.manager.dispose();
	}
}
