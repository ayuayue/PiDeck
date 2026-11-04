/** Assembles independent plugin discovery, data capabilities and views; no pi runtime dependency. */
import { join } from "node:path";
import type { HostPluginCatalog, HostPluginContext, HostPluginMountInput } from "../../shared/types/hostPlugin";
import type { SessionCatalog } from "../sessions/SessionCatalog";
import type { LocalServiceRegistry } from "../localServices/LocalServiceRegistry";
import { getAppLogger } from "../logging/sharedLogger";
import { preparePreloadPath } from "../preloadPath";
import { setHostPluginWebviewBridge } from "./hostPluginWebviewPolicy";
import { HostPluginManager } from "./HostPluginManager";
import { HostPluginSessions, type HostPluginProjectInfo } from "./HostPluginSessions";
import { HostPluginStorage } from "./HostPluginStorage";
import { HostPluginBroker } from "./HostPluginBroker";
import { HostPluginViewHost } from "./HostPluginViewHost";
import type { SessionGroupStore } from "../sessionGroups/sessionGroupStore";

export class HostPluginService {
	readonly manager: HostPluginManager;
	readonly broker: HostPluginBroker;
	private views?: HostPluginViewHost;
	private disposed = false;
	private readonly storage: HostPluginStorage;
	private readonly sessions: HostPluginSessions;
	constructor(
		userData: string,
		catalog: SessionCatalog,
		private readonly preload: string,
		services: LocalServiceRegistry,
		/** 项目登记表查询：名字给 context / 会话行，目录给会话行（不暴露会话文件路径）。 */
		projectOf?: (projectId: string) => HostPluginProjectInfo | undefined,
		/** 会话分组 store（惰性求值）：声明 sessionGroups.manage 的插件经 broker 读写它。 */
		sessionGroups?: () => SessionGroupStore | undefined,
	) {
		this.manager = new HostPluginManager(userData, process.env.PIDECK_DISABLE_HOST_PLUGINS === "1");
		this.sessions = new HostPluginSessions(catalog, projectOf);
		this.storage = new HostPluginStorage(join(userData, "host-plugin-storage"));
		this.broker = new HostPluginBroker(this.manager, this.sessions, this.storage, (projectId) => projectOf?.(projectId)?.name, undefined, services, sessionGroups);
	}

	/** 插件目录一个都不随包：扫描用户自己装的那些，没有就空着。 */
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

	/**
	 * 卸载：撤权 + 删目录（manager）→ 清插件私有 store。
	 * 目录已经删掉后再因为 store 清不掉而报「卸载失败」会误导用户，所以私有数据按尽力而为处理，只留一条警告。
	 */
	async remove(id: string): Promise<HostPluginCatalog> {
		const catalog = await this.manager.remove(id);
		await this.storage.purge(id).catch((error: unknown) => void getAppLogger()?.warn("host-plugins", "Plugin storage cleanup failed", { id, message: String(error) }));
		return catalog;
	}

	dispose(): void {
		this.disposed = true;
		setHostPluginWebviewBridge(null);
		this.views?.dispose();
		this.broker.dispose();
		this.manager.dispose();
	}
}
