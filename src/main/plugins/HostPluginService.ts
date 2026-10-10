/** Assembles independent plugin discovery, data capabilities and views; no pi runtime dependency. */
import { join } from "node:path";
import type { HostPluginContext, HostPluginMountInput } from "../../shared/types/hostPlugin";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import { preparePreloadPath } from "../preloadPath";
import { setHostPluginWebviewBridge } from "./hostPluginWebviewPolicy";
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
		projectNameOf?: (projectId: string) => string | undefined,
	) {
		this.manager = new HostPluginManager(userData, process.env.PIDECK_DISABLE_HOST_PLUGINS === "1");
		this.sessions = new HostPluginSessions(catalog);
		this.broker = new HostPluginBroker(this.manager, this.sessions, new HostPluginStorage(join(userData, "host-plugin-storage")), projectNameOf);
	}

	async initialize(): Promise<void> {
		await this.manager.load();
		const preload = await preparePreloadPath(this.preload, "host-plugin-preload.js");
		if (!this.disposed) {
			this.views = new HostPluginViewHost(this.manager, this.broker, this.sessions, preload);
			// 窗口层 webview attach 策略在 service 初始化前就注册，经 bridge 拿到实例表与 preload 路径。
			setHostPluginWebviewBridge(this.views);
		}
	}

	mount(input: HostPluginMountInput) {
		if (!this.views) throw new Error("plugin-host-unavailable");
		return this.views.mount(input);
	}

	update(id: string, context: HostPluginContext): void {
		if (!this.views) throw new Error("plugin-host-unavailable");
		this.views.update(id, context);
	}

	unmount(id: string): void {
		this.views?.unmount(id);
	}

	dispose(): void {
		this.disposed = true;
		setHostPluginWebviewBridge(null);
		this.views?.dispose();
		this.broker.dispose();
		this.manager.dispose();
	}
}
