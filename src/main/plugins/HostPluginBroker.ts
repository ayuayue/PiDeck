/** Dedicated, sender-bound API. Neither renderer-supplied plugin IDs nor raw IPC are capabilities. */
import type { HostPluginContext, HostPluginResponse } from "../../shared/types/hostPlugin";
import type { HostPluginManager } from "./HostPluginManager";
import type { HostPluginSessions } from "./HostPluginSessions";
import type { HostPluginStorage } from "./HostPluginStorage";
import { parsePluginRequest } from "./hostPluginPolicy";
import { HostPluginNetwork } from "./HostPluginNetwork";

type Binding = {
	pluginId: string;
	fingerprint: string;
	context: HostPluginContext;
	generation: number;
	pending: number;
	budget: number;
	windowAt: number;
	/** Every network operation belongs to this binding and is cancelled when its scope is revoked. */
	requests: Set<AbortController>;
};

export type HostPluginNavigateSink = (input: { projectId: string; sessionId: string; entryId?: string }) => void;
export type HostPluginOpenExternalSink = (url: string) => void;

export class HostPluginBroker {
	private readonly bindings = new Map<number, Binding>();
	private readonly navigateSinks = new Set<HostPluginNavigateSink>();
	private readonly openExternalSinks = new Set<HostPluginOpenExternalSink>();
	private readonly unsubscribe: () => void;
	constructor(
		private readonly manager: HostPluginManager,
		private readonly sessions: HostPluginSessions,
		private readonly storage: HostPluginStorage,
		private readonly projectNameOf?: (projectId: string) => string | undefined,
		private readonly network = new HostPluginNetwork(),
	) {
		// Manager revocation happens before persistence: do not leave a live socket while disable writes to disk.
		this.unsubscribe = manager.onChanged(() => {
			for (const [senderId, binding] of this.bindings) if (manager.getEnabled(binding.pluginId)?.fingerprint !== binding.fingerprint) this.unbind(senderId);
		});
	}

	/** Aborting here closes transport sockets and releases DNS/response waiters without awaiting the provider. */
	private cancel(binding: Binding): void {
		for (const request of binding.requests) request.abort(new Error("plugin-revoked"));
		binding.requests.clear();
	}

	/** 存进来的范围一律先在桌面侧补全显示名：插件拿到 context 就能直接渲染。 */
	private describe(context: HostPluginContext): HostPluginContext {
		return this.sessions.describe(context, this.projectNameOf);
	}

	bind(senderId: number, pluginId: string, fingerprint: string, context: HostPluginContext): void {
		this.unbind(senderId);
		this.bindings.set(senderId, { pluginId, fingerprint, context: this.describe(context), generation: 0, pending: 0, budget: 0, windowAt: Date.now(), requests: new Set() });
	}

	update(senderId: number, context: HostPluginContext): void {
		const binding = this.bindings.get(senderId);
		if (!binding) return;
		this.cancel(binding);
		binding.context = this.describe(context);
		binding.generation += 1;
	}

	unbind(senderId: number): void {
		const binding = this.bindings.get(senderId);
		if (binding) this.cancel(binding);
		this.bindings.delete(senderId);
	}

	/** The desktop frame owns execution; the broker only forwards validated, permission-checked navigation. */
	onNavigate(sink: HostPluginNavigateSink): () => void {
		this.navigateSinks.add(sink);
		return () => this.navigateSinks.delete(sink);
	}

	/** 外部链接同样由桌面层执行（shell 只在 ipc 层持有）：broker 只校验形状与权限后转发。 */
	onOpenExternal(sink: HostPluginOpenExternalSink): () => void {
		this.openExternalSinks.add(sink);
		return () => this.openExternalSinks.delete(sink);
	}

	private authorized(senderId: number, binding: Binding, generation: number): boolean {
		return this.bindings.get(senderId) === binding && binding.generation === generation && this.manager.getEnabled(binding.pluginId)?.fingerprint === binding.fingerprint;
	}

	/** Recheck after every asynchronous operation: disable/scope changes revoke already queued results. */
	async request(senderId: number, mainFrame: boolean, input: unknown): Promise<HostPluginResponse> {
		const binding = this.bindings.get(senderId);
		if (!binding || !mainFrame) return { ok: false, code: "plugin-not-authorized" };
		const generation = binding.generation;
		if (!this.authorized(senderId, binding, generation)) return { ok: false, code: "plugin-revoked" };
		if (Date.now() - binding.windowAt > 1000) {
			binding.budget = 0;
			binding.windowAt = Date.now();
		}
		if (binding.pending >= 2 || ++binding.budget > 20) return { ok: false, code: "rate-limited" };
		binding.pending += 1;
		try {
			const request = parsePluginRequest(input);
			const plugin = this.manager.getEnabled(binding.pluginId);
			if (!plugin) throw new Error("plugin-revoked");
			if (request.method.startsWith("sessions.") && !plugin.manifest.permissions.includes("sessions.read")) throw new Error("permission-denied");
			// workbench 下的方法权限逐个对应，不用前缀推断：新增方法忘了登记会报错而不是白拿权限。
			if (request.method === "workbench.navigate" && !plugin.manifest.permissions.includes("workbench.navigate")) throw new Error("permission-denied");
			if (request.method === "workbench.openExternal" && !plugin.manifest.permissions.includes("workbench.openExternal")) throw new Error("permission-denied");
			let value: unknown;
			switch (request.method) {
				case "network.request": {
					const controller = new AbortController();
					binding.requests.add(controller);
					try {
						value = await this.network.request(plugin.manifest, request.request, controller.signal, () => this.authorized(senderId, binding, generation));
					} finally {
						binding.requests.delete(controller);
					}
					break;
				}
				case "context.get":
					value = binding.context;
					break;
				case "sessions.list":
					value = this.sessions.list(binding.context, request.offset);
					break;
				case "sessions.get":
					value = this.sessions.get(binding.context, request.sessionId);
					break;
				case "sessions.search":
					value = this.sessions.search(binding.context, request.query, request.limit);
					break;
				case "sessions.entries":
					value = await this.sessions.entries(binding.context, request.sessionId, request.cursor);
					break;
				case "storage.get":
					value = await this.storage.get(binding.pluginId, request.key);
					break;
				case "storage.set":
					await this.storage.set(binding.pluginId, request.key, request.value, () => this.authorized(senderId, binding, generation));
					value = null;
					break;
				case "storage.keys":
					value = await this.storage.keys(binding.pluginId);
					break;
				case "storage.delete":
					await this.storage.remove(binding.pluginId, request.key, () => this.authorized(senderId, binding, generation));
					value = null;
					break;
				case "workbench.openExternal":
					// 与导航同一条线路：转发前复查授权，插件被撤销后不再弹浏览器。
					if (this.authorized(senderId, binding, generation)) for (const sink of this.openExternalSinks) sink(request.url);
					value = null;
					break;
				case "workbench.navigate": {
					// Navigation acts on the workbench, not on plugin data: ownership gate mirrors sessions.entries.
					const projectId = binding.context.projectId;
					if (!projectId || !this.sessions.navigable(binding.context, request.sessionId)) throw new Error("session-not-authorized");
					const target = { projectId, sessionId: request.sessionId, entryId: request.entryId };
					if (this.authorized(senderId, binding, generation)) for (const sink of this.navigateSinks) sink(target);
					value = null;
					break;
				}
			}
			return this.authorized(senderId, binding, generation) ? { ok: true, value } : { ok: false, code: "plugin-revoked" };
		} catch (error) {
			// Filesystem/provider diagnostics may contain private paths; expose only stable codes.
			const code = error instanceof Error && /^[a-z-]{1,80}$/.test(error.message) ? error.message : "plugin-request-failed";
			return { ok: false, code };
		} finally {
			binding.pending -= 1;
		}
	}

	dispose(): void {
		this.unsubscribe();
		for (const senderId of this.bindings.keys()) this.unbind(senderId);
		this.navigateSinks.clear();
		this.openExternalSinks.clear();
	}
}
