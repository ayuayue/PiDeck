import type {
	AgentBackend,
	AgentGatewayCapability,
	AgentRuntimeState,
	AgentTab,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	ImageContent,
	RewindCheckpointPage,
	RewindCheckpointPageParams,
	RewindRestoreResult,
	RewindRestoreScope,
	SendPromptInput,
	SendPromptResult,
	SessionRuntimeModelSelection,
	SessionUiResponseInput,
} from "../../shared/types";
import type { BridgeEvent } from "../../shared/types/bridge";
import type { SessionAgentGateway } from "../sessions/SessionRuntimeCoordinator";

/**
 * 多后端 agent 网关装配器：把 pi / dsh 等具体网关聚合成一个
 * `SessionAgentGateway`，供 SessionRuntimeCoordinator 无感消费。
 *
 * 路由规则：
 * - `create(input)` 按 `input.backend`（缺省走 `defaultBackend`，即 pi）选择网关；
 * - 其余按 agentId 路由到持有该 agent 的网关（ownerByAgent 缓存 + list() 兜底查找）；
 * - `onOutput` 聚合转发所有子网关事件（统一桥接进 sessions:runtime-event 用）。
 *
 * 能力（capabilities）取所有子网关的并集；具体能力缺失仍由各网关自行声明，
 * 上层 UI 按能力禁用入口。
 */
export class CompositeAgentGateway implements SessionAgentGateway {
	private readonly byBackend = new Map<AgentBackend, SessionAgentGateway>();
	private readonly ownerByAgent = new Map<string, SessionAgentGateway>();

	constructor(
		private readonly gateways: SessionAgentGateway[],
		private readonly defaultBackend: AgentBackend = "pi",
	) {
		for (const gateway of gateways) {
			this.byBackend.set(gateway.backend, gateway);
		}
	}

	/** 合成网关的身份：对外以默认后端自居（仅用于接口自洽，实际路由按 agent 归属）。 */
	get backend(): AgentBackend {
		return this.defaultBackend;
	}

	/** 可选能力并集。 */
	get capabilities(): ReadonlySet<AgentGatewayCapability> {
		const union = new Set<AgentGatewayCapability>();
		for (const gateway of this.gateways) {
			for (const capability of gateway.capabilities) union.add(capability);
		}
		return union;
	}

	/** 按 backend 解析网关；未知 backend 抛错（装配层应保证注册完整）。 */
	private resolveBackend(backend: AgentBackend | undefined): SessionAgentGateway {
		const target = backend ?? this.defaultBackend;
		const gateway = this.byBackend.get(target);
		if (!gateway) {
			throw new Error(`CompositeAgentGateway: no gateway for backend "${target}"`);
		}
		return gateway;
	}

	/** 按 agentId 定位网关；未知 agent 抛错（Coordinator 会转成 SESSION_COMMAND_FAILED）。 */
	private owner(agentId: string): SessionAgentGateway {
		const cached = this.ownerByAgent.get(agentId);
		if (cached) return cached;
		for (const gateway of this.gateways) {
			if (gateway.list().some((tab) => tab.id === agentId)) {
				this.ownerByAgent.set(agentId, gateway);
				return gateway;
			}
		}
		throw new Error(`CompositeAgentGateway: no gateway owns agent "${agentId}"`);
	}

	/** 可选能力存在性检查（不抽方法，避免丢 this）；缺失时抛与旧行为一致的错误，由 Coordinator 转 SESSION_COMMAND_FAILED。 */
	private requireCapability(gateway: SessionAgentGateway, method: "getCommands" | "exportHtml" | "editMessage" | "deleteMessage" | "setPermission" | "listCheckpoints" | "getCheckpointDiff" | "restoreCheckpoint"): void {
		if (typeof gateway[method] !== "function") {
			throw new Error(`CompositeAgentGateway: backend "${gateway.backend}" does not support ${method}`);
		}
	}

	list(): AgentTab[] {
		return this.gateways.flatMap((gateway) => gateway.list());
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		return this.owner(input.agentId).sendPrompt(input);
	}

	getMessages(agentId: string): ChatMessage[] {
		return this.owner(agentId).getMessages(agentId);
	}

	async create(input: CreateAgentInput): Promise<AgentTab> {
		const gateway = this.resolveBackend(input.backend);
		const tab = await gateway.create(input);
		this.ownerByAgent.set(tab.id, gateway);
		return tab;
	}

	async restart(agentId: string): Promise<AgentTab> {
		const gateway = this.owner(agentId);
		const tab = await gateway.restart(agentId);
		this.ownerByAgent.set(tab.id, gateway);
		return tab;
	}

	async stop(agentId: string): Promise<void> {
		return this.owner(agentId).stop(agentId);
	}

	async rename(agentId: string, name: string): Promise<AgentTab> {
		return this.owner(agentId).rename(agentId, name);
	}

	async abort(agentId: string): Promise<void> {
		return this.owner(agentId).abort(agentId);
	}

	async compact(agentId: string, prompt?: string): Promise<AgentRuntimeState> {
		return this.owner(agentId).compact(agentId, prompt);
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		return this.owner(agentId).getRuntimeState(agentId);
	}

	/** 可选能力转发：error 终态但进程仍存活时的原进程复活（pi 实现；dsh 未实现返回 false）。 */
	reviveIfProcessAlive(agentId: string): boolean {
		const gateway = this.owner(agentId);
		if (typeof gateway.reviveIfProcessAlive !== "function") return false;
		return gateway.reviveIfProcessAlive(agentId);
	}

	async getCommands(agentId: string): Promise<unknown[]> {
		const gateway = this.owner(agentId);
		this.requireCapability(gateway, "getCommands");
		return gateway.getCommands!(agentId);
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		return this.owner(agentId).getAvailableModels(agentId);
	}

	async getAvailableThinkingLevels(agentId: string): Promise<string[] | undefined> {
		const gateway = this.owner(agentId);
		if (typeof gateway.getAvailableThinkingLevels !== "function") return undefined;
		return gateway.getAvailableThinkingLevels(agentId);
	}

	async exportHtml(agentId: string): Promise<unknown> {
		const gateway = this.owner(agentId);
		this.requireCapability(gateway, "exportHtml");
		return gateway.exportHtml!(agentId);
	}

	async editMessage(agentId: string, messageId: string, newText: string): Promise<void> {
		const gateway = this.owner(agentId);
		this.requireCapability(gateway, "editMessage");
		await gateway.editMessage?.(agentId, messageId, newText);
	}

	async deleteMessage(agentId: string, messageId: string): Promise<void> {
		const gateway = this.owner(agentId);
		this.requireCapability(gateway, "deleteMessage");
		await gateway.deleteMessage?.(agentId, messageId);
	}

	async listCheckpoints(agentId: string, params?: RewindCheckpointPageParams): Promise<RewindCheckpointPage> {
		const gateway = this.owner(agentId);
		this.requireCapability(gateway, "listCheckpoints");
		return gateway.listCheckpoints!(agentId, params);
	}

	async getCheckpointDiff(agentId: string, checkpointId: string): Promise<string> {
		const gateway = this.owner(agentId);
		this.requireCapability(gateway, "getCheckpointDiff");
		return gateway.getCheckpointDiff!(agentId, checkpointId);
	}

	async restoreCheckpoint(agentId: string, checkpointId: string, scope: RewindRestoreScope): Promise<RewindRestoreResult> {
		const gateway = this.owner(agentId);
		this.requireCapability(gateway, "restoreCheckpoint");
		return gateway.restoreCheckpoint!(agentId, checkpointId, scope);
	}

	/**
	 * 无 runtime 的 JSONL 改写只属于 pi：按默认后端解析网关，不按 agentId。
	 * DSH 网关没有该方法，走「不支持」错误，禁止硬造等价物。
	 */
	async mutatePersistedSessionMessage(
		sessionPath: string,
		messageId: string,
		operation: "edit" | "delete" | "resend",
		options?: {
			newText?: string;
			environment?: import("../../shared/types").SessionEnvironment;
			wslDistro?: string;
			/** 渲染层消息的文件条目 id（meta.entryId），live randomUUID 的文件定位锚点。 */
			entryId?: string;
		},
	): Promise<{ text: string; images?: ImageContent[] } | undefined> {
		const gateway = this.resolveBackend("pi");
		// 必须对象调用：抽成 const mutate = gateway.mutatePersistedSessionMessage 会丢 this，
		// AgentManager 内部读 this.toSessionHostPath 直接崩（「会话操作失败，请重试」）。
		if (typeof gateway.mutatePersistedSessionMessage !== "function") {
			throw new Error(`CompositeAgentGateway: backend "${gateway.backend}" does not support persisted session message mutation`);
		}
		return gateway.mutatePersistedSessionMessage(sessionPath, messageId, operation, options);
	}

	async prepareResendFromMessage(agentId: string, messageId: string): Promise<{ text: string; images?: ImageContent[] }> {
		return this.owner(agentId).prepareResendFromMessage(agentId, messageId);
	}

	async setModel(agentId: string, provider: string, modelId: string): Promise<unknown> {
		return this.owner(agentId).setModel(agentId, provider, modelId);
	}

	async getRuntimeModelThinkingState(agentId: string): Promise<SessionRuntimeModelSelection | undefined> {
		return this.owner(agentId).getRuntimeModelThinkingState?.(agentId);
	}

	async setThinking(agentId: string, level: string): Promise<unknown> {
		return this.owner(agentId).setThinking(agentId, level);
	}

	async setPermission(agentId: string, preset: string): Promise<unknown> {
		const gateway = this.owner(agentId);
		this.requireCapability(gateway, "setPermission");
		return gateway.setPermission!(agentId, preset);
	}

	/** 可选能力透传：pi 网关在会话时间线落系统提示；DSH 网关未实现则静默跳过。 */
	notifyModelPreferenceIgnored(agentId: string, provider: string, modelId: string): void {
		const gateway = this.owner(agentId);
		gateway.notifyModelPreferenceIgnored?.(agentId, provider, modelId);
	}

	/**
	 * 可选能力透传：渲染层→pi 的 GUI 桥事件回灌（§8.3）。
	 *
	 * **必须显式转发**：`SessionRuntimeCoordinator` 走的是 `agents.pushBridgeEvent?.(...) ?? false`，
	 * 本类漏实现时可选调用链会直接短路——渲染层所有桥事件（勾选/输入/按钮）
	 * 都变成静默丢弃，表现为「面板点了没反应」。DSH 网关未实现则返回 false（同样静默）。
	 */
	pushBridgeEvent(agentId: string, event: BridgeEvent): boolean {
		try {
			return this.owner(agentId).pushBridgeEvent?.(agentId, event) ?? false;
		} catch {
			// 未知 agent（已停止 / 从未创建）：桥事件是 fire-and-forget 的 UI 交互，
			// 静默丢弃并返回 false，不要把异常抛回 IPC 边界。
			return false;
		}
	}

	/**
	 * 可选能力透传：请求桥下一次轮询时全量重推一次（§9.4）。
	 *
	 * 与 `pushBridgeEvent` 同因：漏转发会让开设置弹窗/切会话/应用启动时的"重推"全部静默失效。
	 */
	requestBridgeResync(agentId: string): boolean {
		return this.owner(agentId).requestBridgeResync?.(agentId) ?? false;
	}

	async publishRuntimeState(agentId: string): Promise<void> {
		return this.owner(agentId).publishRuntimeState(agentId);
	}

	async getForkMessages(agentId: string): Promise<Array<{ entryId: string; text: string }>> {
		return this.owner(agentId).getForkMessages(agentId);
	}

	async forkSession(agentId: string, entryId: string): Promise<unknown> {
		return this.owner(agentId).forkSession(agentId, entryId);
	}

	async sendUIResponse(agentId: string, requestId: string, response: SessionUiResponseInput["response"]): Promise<unknown> {
		return this.owner(agentId).sendUIResponse(agentId, requestId, response);
	}

	notifyAskPending(agentId: string, sessionId: string, sessionTitle: string, question: string): void {
		for (const gateway of this.gateways) {
			if (gateway.list().some((tab) => tab.id === agentId)) {
				gateway.notifyAskPending(agentId, sessionId, sessionTitle, question);
				return;
			}
		}
	}

	onOutput(listener: (channel: string, payload: unknown) => void): () => void {
		const unsubscribers = this.gateways.map((gateway) => gateway.onOutput(listener));
		return () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
	}
}
