import type {
	AgentBackend,
	AgentGatewayCapability,
	AgentRuntimeState,
	AgentTab,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	I18nDescriptor,
	ImageContent,
	PiCommand,
	RewindCheckpointPage,
	RewindCheckpointPageParams,
	RewindRestoreResult,
	RewindRestoreScope,
	SendPromptInput,
	SendPromptResult,
	SendSessionPromptInput,
	SendSessionPromptResult,
	SessionCommandErrorCode,
	SessionCommandResult,
	SessionRecord,
	SessionRuntimeEvent,
	SessionRuntimeInfo,
	SessionRuntimeReplacement,
	SessionRuntimeTarget,
	SessionTargetedValue,
	SessionUiResponseInput,
} from "../../shared/types";
import { buildSessionOriginKey } from "../../shared/sessionIdentity";
import { isRewindCheckpointId, isRewindRestoreScope } from "../../shared/types";
import type { SessionCatalogEntry } from "./SessionCatalog";

export interface SessionCatalogGateway {
	get(sessionId: string): SessionCatalogEntry | undefined;
	getRecord(sessionId: string): SessionRecord | undefined;
	update(
		sessionId: string,
		patch: {
			title?: string;
			model?: { provider: string; modelId: string } | null;
			thinkingLevel?: string | null;
			permissionPreset?: string | null;
			backend?: AgentBackend;
			updatedAt?: number;
		},
	): Promise<SessionCatalogEntry>;
	attachRuntime(input: {
		sessionId: string;
		filePath?: string;
		piSessionId?: string;
		dshSessionId?: string;
		promoteToActive?: boolean;
	}): Promise<unknown>;
}

export interface SessionAgentGateway {
	/** 本网关的运行时后端身份（pi/dsh）；CompositeAgentGateway 按它路由。 */
	readonly backend: AgentBackend;
	/** 本网关持有的可选能力；缺失项由 UI 按能力禁用，禁止硬造等价物。 */
	readonly capabilities: ReadonlySet<AgentGatewayCapability>;
	list(): AgentTab[];
	/** 发送提示词到 agent（pi: stdio RPC；dsh: session.prompt）。 */
	sendPrompt(input: SendPromptInput): Promise<SendPromptResult>;
	getMessages(agentId: string): ChatMessage[];
	create(input: CreateAgentInput): Promise<AgentTab>;
	restart(agentId: string): Promise<AgentTab>;
	stop(agentId: string): Promise<void>;
	rename(agentId: string, name: string): Promise<AgentTab>;
	abort(agentId: string): Promise<void>;
	compact(agentId: string, prompt?: string): Promise<AgentRuntimeState>;
	getRuntimeState(agentId: string): Promise<AgentRuntimeState>;
	/** 可选能力：会话内命令列表（pi 经 get_commands RPC；dsh 经 host 命令注册表枚举桥 D15）。 */
	getCommands?(agentId: string): Promise<unknown[]>;
	getAvailableModels(agentId: string): Promise<AvailableModel[]>;
	/** 可选能力：Pi 按当前模型返回可用 thinking levels；旧 Pi 返回 undefined 走 UI 兼容回退。 */
	getAvailableThinkingLevels?(agentId: string): Promise<string[] | undefined>;
	/** 可选能力：导出 HTML（pi 经 export_html RPC；dsh 投影式导出 G10）。 */
	exportHtml?(agentId: string): Promise<unknown>;
	/** 可选能力：checkpoint 列表（refs/pi-checkpoints；纯 git，pi 提供，dsh 暂缺）。支持分页。 */
	listCheckpoints?(agentId: string, params?: RewindCheckpointPageParams): Promise<RewindCheckpointPage>;
	/** 可选能力：checkpoint 与当前 index 树的 diff 摘要（回退预览）。 */
	getCheckpointDiff?(agentId: string, checkpointId: string): Promise<string>;
	/** 可选能力：回退到 checkpoint（scope 决定回退范围；当前仅 files 实现）。 */
	restoreCheckpoint?(agentId: string, checkpointId: string, scope: RewindRestoreScope): Promise<RewindRestoreResult>;
	/** 可选能力：编辑历史消息（pi 提供；dsh 缺失，capabilities 不含 editMessage）。 */
	editMessage?(agentId: string, messageId: string, newText: string): Promise<void>;
	/** 可选能力：删除历史消息（pi 提供；dsh 缺失，capabilities 不含 deleteMessage）。 */
	deleteMessage?(agentId: string, messageId: string): Promise<void>;
	/**
	 * 可选能力：无 runtime 时直接改 pi 会话 JSONL（编辑/删除/重发截断）。
	 * DSH 无会话文件，不得实现；运行中不得调用（先 stopRuntime）。
	 */
	mutatePersistedSessionMessage?(
		sessionPath: string,
		messageId: string,
		operation: "edit" | "delete" | "resend",
		options?: {
			newText?: string;
			environment?: SessionRecord["environment"];
			wslDistro?: string;
			/** 渲染层消息的文件条目 id（meta.entryId），live randomUUID 的文件定位锚点。 */
			entryId?: string;
		},
	): Promise<{ text: string; images?: ImageContent[] } | undefined>;
	prepareResendFromMessage(
		agentId: string,
		messageId: string,
	): Promise<{ text: string; images?: ImageContent[] }>;
	setModel(agentId: string, provider: string, modelId: string): Promise<unknown>;
	setThinking(agentId: string, level: string): Promise<unknown>;
	/** 可选能力：DSH 会话权限预设（/permission 命令）；pi 后端不持有。 */
	setPermission?(agentId: string, preset: string): Promise<unknown>;
	/** 主动推送一次完整 runtime state（get_state）给渲染层：懒启动/重启链路在偏好应用后调用。 */
	publishRuntimeState(agentId: string): Promise<void>;
	getForkMessages(agentId: string): Promise<Array<{ entryId: string; text: string }>>;
	forkSession(agentId: string, entryId: string): Promise<unknown>;
	sendUIResponse(
		agentId: string,
		requestId: string,
		response: SessionUiResponseInput["response"],
	): Promise<unknown> | unknown;
	/** 非聚焦会话收到 Ask 类 UI 请求时触发桌面通知（由 AgentManager 实现）
	 * 参数：agentId（去重/日志）、sessionId（点击跳转目标）、sessionTitle、question（提问内容，可空） */
	notifyAskPending(
		agentId: string,
		sessionId: string,
		sessionTitle: string,
		question: string,
	): void;
	/** 统一的事件出口（agents:* 通道推送），主进程桥接进 sessions:runtime-event 用。 */
	onOutput(listener: (channel: string, payload: unknown) => void): () => void;
}

/**
 * 会话运行时业务日志接口（AppLogger 满足该签名）。
 * 会话全周期事件（激活/停止/重启/模型切换等）经此留痕，与性能日志（session-perf scope）区分；
 * 无实例时静默跳过（启动早期/测试环境）。
 */
export interface SessionRuntimeLogger {
	info(scope: string, message: string, detail?: unknown): unknown;
	warn(scope: string, message: string, detail?: unknown): unknown;
	error(scope: string, message: string, detail?: unknown): unknown;
}

type DeliveryCacheEntry = {
	createdAt: number;
	settled: boolean;
	promise: Promise<SendSessionPromptResult>;
};

export type PendingUiRequestSnapshot = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
	requestId: string;
	method: string;
	title: string;
	options?: string[];
	placeholder?: string;
	prefill?: string;
	allowOther?: boolean;
};

type PendingUiRequest = PendingUiRequestSnapshot;

export type SessionRuntimeBinding = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
};

type RuntimeReplacement = SessionRuntimeBinding & {
	replacementId: number;
};

type DispatchLease = SessionRuntimeBinding & {
	leaseId: number;
};

class SessionRuntimeCommandError extends Error {
	constructor(
		readonly code: SessionCommandErrorCode,
		message: string,
	) {
		super(message);
		this.name = "SessionRuntimeCommandError";
	}
}

const DELIVERY_CACHE_TTL_MS = 10 * 60_000;
const DELIVERY_CACHE_MAX_ENTRIES = 500;
const AGENT_READY_TIMEOUT_MS = 60_000;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isTerminalAgent(tab: AgentTab): boolean {
	return tab.status === "error" || tab.status === "closed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInteractiveUiMethod(method: unknown): boolean {
	return method === "select" ||
		method === "confirm" ||
		method === "input" ||
		method === "editor" ||
		method === "batch_ask";
}

/** catalog 里会在激活后被用户改写的偏好；lastApplied 用这份快照判断要不要再 setModel。 */
type AppliedSessionPreferences = {
	model?: { provider: string; modelId: string };
	thinkingLevel?: string;
	permissionPreset?: string;
};

function snapshotPreferences(entry: SessionCatalogEntry): AppliedSessionPreferences {
	return {
		...(entry.model
			? { model: { provider: entry.model.provider, modelId: entry.model.modelId } }
			: {}),
		...(entry.thinkingLevel ? { thinkingLevel: entry.thinkingLevel } : {}),
		...(entry.permissionPreset ? { permissionPreset: entry.permissionPreset } : {}),
	};
}

function sameAppliedPreferences(
	a: AppliedSessionPreferences | undefined,
	b: AppliedSessionPreferences,
): boolean {
	if (!a) return false;
	const aModel = a.model;
	const bModel = b.model;
	if (Boolean(aModel) !== Boolean(bModel)) return false;
	if (aModel && bModel && (aModel.provider !== bModel.provider || aModel.modelId !== bModel.modelId)) {
		return false;
	}
	return a.thinkingLevel === b.thinkingLevel && a.permissionPreset === b.permissionPreset;
}

export class SessionRuntimeCoordinator {
	private readonly activationBySession = new Map<string, Promise<AgentTab>>();
	private readonly deliveryByRequest = new Map<string, DeliveryCacheEntry>();
	private readonly agentIdBySession = new Map<string, string>();
	private readonly sessionIdByAgent = new Map<string, string>();
	private readonly generationBySession = new Map<string, number>();
	private readonly pendingUiRequests = new Map<string, PendingUiRequest>();
	private readonly replacementByAgent = new Map<string, RuntimeReplacement>();
	private readonly replacementBySession = new Map<string, RuntimeReplacement>();
	private readonly dispatchLeasesByAgent = new Map<string, Set<DispatchLease>>();
	private readonly dispatchLeasesBySession = new Map<string, Set<DispatchLease>>();
	private replacementSequence = 0;
	private dispatchLeaseSequence = 0;
	/** 渲染层当前聚焦的会话 id；为 undefined 时视为全部会话都需要通知 */
	private focusedSessionId: string | undefined = undefined;
	/** 正在删除的会话：先解绑再异步停 agent，禁止激活/bind 把运行时写回 catalog。 */
	private readonly deletingSessions = new Set<string>();
	/**
	 * 上次成功应用到该会话当前 agent 的偏好。catalog.get 返回 clone，activate 开头的
	 * 快照会过期；预热绑定后用户仍可改模型。用这份记录跳过「catalog 没变」的重复
	 * setModel，保住并发 send / 历史 attach / 懒启动 publish 的 setModel==1 约束。
	 * agentId 必须纳入：新进程（restart）即使 catalog 没变也要再应用。
	 */
	private readonly lastAppliedBySession = new Map<string, {
		agentId: string;
		preferences: AppliedSessionPreferences;
	}>();

	constructor(
		private readonly catalog: SessionCatalogGateway,
		private readonly agents: SessionAgentGateway,
		private readonly sendAgentPrompt: (input: SendPromptInput) => Promise<SendPromptResult>,
		private readonly logger?: SessionRuntimeLogger,
	) {}

	/** 渲染层在 currentSessionId 变化时汇报聚焦会话（见 sessions:set-focused-session IPC）。 */
	setFocusedSession(sessionId: string | undefined): void {
		this.focusedSessionId = sessionId;
		// 聚焦切换高频发生（点列表即触发），用 debug 级别避免刷屏
		void this.logger?.info("session-runtime", "Focused session changed", { sessionId });
	}

	getFocusedSession(): string | undefined {
		return this.focusedSessionId;
	}

	send(input: SendSessionPromptInput): Promise<SendSessionPromptResult> {
		const sessionId = input.sessionId.trim();
		const requestId = input.requestId.trim();
		if (!sessionId) return Promise.resolve(this.rejected(input, "Session ID is required"));
		if (!requestId) return Promise.resolve(this.rejected(input, "Request ID is required"));
		if (!input.message.trim() && !input.images?.length) {
			return Promise.resolve(this.rejected(input, "消息不能为空", {
				i18nKey: "diagnostic.messageRequired",
			}));
		}

		this.pruneDeliveryCache();
		const cacheKey = `${sessionId}\u0000${requestId}`;
		const existing = this.deliveryByRequest.get(cacheKey);
		if (existing) return existing.promise;

		const cacheEntry: DeliveryCacheEntry = {
			createdAt: Date.now(),
			settled: false,
			promise: Promise.resolve(this.rejected(input, "Request was not started")),
		};
		cacheEntry.promise = this.sendOnce({ ...input, sessionId, requestId })
			.finally(() => {
				cacheEntry.settled = true;
			});
		this.deliveryByRequest.set(cacheKey, cacheEntry);
		return cacheEntry.promise;
	}

	getAgentId(sessionId: string): string | undefined {
		const agentId = this.agentIdBySession.get(sessionId);
		if (!agentId) return undefined;
		const tab = this.agents.list().find((candidate) => candidate.id === agentId);
		if (tab && !isTerminalAgent(tab)) return agentId;
		// pi may emit an interactive recovery request immediately before reporting
		// an error. Keep that runtime addressable until the user answers the request.
		if (tab?.status === "error" && this.hasPendingUiRequest(sessionId, agentId)) return agentId;
		// A terminal process cannot safely receive a delayed prompt result. Remove
		// the binding even if its dispatch lease has not unwound yet, which makes
		// that result fail closed instead of reviving a dead runtime association.
		this.unbindTerminalAgent(agentId);
		return undefined;
	}

	getSessionId(agentId: string): string | undefined {
		return this.sessionIdByAgent.get(agentId);
	}

	/**
	 * 进程监控用：按 agentId 反查会话身份（sessionId + 标题）。
	 * 标题取 catalog 条目，供监控表直接展示「是哪个会话」；
	 * 无绑定或 catalog 无记录时返回 undefined（匿名/终端 agent 不关联会话）。
	 */
	getSessionInfoForAgent(
		agentId: string,
	): { sessionId: string; sessionTitle?: string } | undefined {
		const sessionId = this.sessionIdByAgent.get(agentId);
		if (!sessionId) return undefined;
		const entry = this.catalog.get(sessionId);
		return { sessionId, sessionTitle: entry?.title };
	}

	listRuntimes(): SessionRuntimeInfo[] {
		const result: SessionRuntimeInfo[] = [];
		for (const [sessionId, agentId] of this.agentIdBySession) {
			const tab = this.agents.list().find((candidate) => candidate.id === agentId);
			if (!tab || isTerminalAgent(tab)) continue;
			result.push(this.runtimeInfo(sessionId, tab));
		}
		return result.sort((left, right) => right.createdAt - left.createdAt);
	}

	getTarget(sessionId: string): SessionRuntimeTarget | undefined {
		const agentId = this.getAgentId(sessionId);
		if (!agentId) return undefined;
		const binding = this.getRuntimeBinding(agentId);
		if (!binding || binding.sessionId !== sessionId) return undefined;
		return { sessionId, agentId, runtimeGeneration: binding.runtimeGeneration };
	}

	/** A pending activation owns the Session even before AgentManager binding completes. */
	isActivating(sessionId: string): boolean {
		return this.activationBySession.has(sessionId);
	}

	/**
	 * Register a runtime that is being started by a caller outside the normal
	 * activateRuntime path (currently anonymous --no-session sessions).
	 *
	 * The promise is placed in the same per-Session activation gate before the
	 * Session is returned to the renderer. Therefore a fast first send waits for
	 * the already-created process instead of creating a second one.
	 */
	registerPendingRuntime(sessionId: string, activation: Promise<AgentTab>): void {
		const normalizedSessionId = sessionId.trim();
		if (!normalizedSessionId) throw new Error("Session ID is required");
		if (this.activationBySession.has(normalizedSessionId)) return;

		this.activationBySession.set(normalizedSessionId, activation);
		// Do not use Promise.finally here: its derived rejection would become an
		// unhandled promise when nobody races the background activation. The
		// original promise remains the gate consumed by any concurrent caller.
		void activation.then(
			() => this.clearPendingRuntime(normalizedSessionId, activation),
			() => this.clearPendingRuntime(normalizedSessionId, activation),
		);
	}

	private clearPendingRuntime(sessionId: string, activation: Promise<AgentTab>): void {
		if (this.activationBySession.get(sessionId) === activation) {
			this.activationBySession.delete(sessionId);
		}
	}

	/**
	 * 删除前强制释放运行时：先解绑让侧栏立刻可删，agent 停在后台。
	 * 运行中会话也允许删——用户不必先点停止。stop 失败也不挡 catalog 删除。
	 */
	async releaseRuntimeForDelete(sessionId: string): Promise<void> {
		this.deletingSessions.add(sessionId);
		const activating = this.activationBySession.get(sessionId);
		if (activating) await activating.catch(() => undefined);
		// 先读原始映射：getTarget 会把 error/closed 当终态解绑，
		// 失败一次卡在 error 的会话也必须先解绑再杀进程。
		const mappedAgentId = this.agentIdBySession.get(sessionId);
		const mappedGeneration = mappedAgentId
			? this.getRuntimeBinding(mappedAgentId)?.runtimeGeneration ?? 0
			: 0;
		const liveTarget = this.getTarget(sessionId);
		const target = liveTarget ?? (mappedAgentId
			? { sessionId, agentId: mappedAgentId, runtimeGeneration: mappedGeneration }
			: undefined);
		if (!target) {
			this.deletingSessions.delete(sessionId);
			return;
		}
		this.unbindAgentUnchecked(target.agentId);
		// 先解绑再停：删除 IPC 不必等 pi/DSH 进程退出。stop 完成前禁止重新 activate/bind。
		void this.agents.stop(target.agentId)
			.catch(() => undefined)
			.finally(() => this.deletingSessions.delete(sessionId));
	}

	getRuntimeMessages(sessionId: string): SessionTargetedValue<ChatMessage[]> | undefined {
		const target = this.getTarget(sessionId);
		if (!target) return undefined;
		const messages = this.agents.getMessages(target.agentId);
		// Message reads are synchronous, but the gateway can re-enter coordinator code.
		// Revalidate after the read so an A -> B replacement cannot label A's messages as B's Session state.
		if (!this.validateTarget(target).ok) return undefined;
		return { target, value: messages };
	}

	async activateRuntime(
		sessionId: string,
	): Promise<SessionCommandResult<SessionRuntimeInfo>> {
		try {
			const tab = await this.ensureRuntime(sessionId);
			void this.logger?.info("session-runtime", "Runtime activated", {
				sessionId,
				agentId: tab.id,
				status: tab.status,
			});
			return { ok: true, value: this.runtimeInfo(sessionId, tab) };
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	/**
	 * An anonymous record already has a process created with `--no-session`.
	 * Bind it directly instead of routing it through normal activation, which
	 * would otherwise create a second runtime and a persisted pi session.
	 */
	bindAnonymousRuntime(sessionId: string, agentId: string): SessionRuntimeInfo {
		const entry = this.catalog.get(sessionId);
		if (!entry?.noSession) throw new Error(`Anonymous session not found: ${sessionId}`);
		const tab = this.agents.list().find((candidate) => candidate.id === agentId);
		if (!tab?.noSession || isTerminalAgent(tab)) {
			throw new Error(`Anonymous runtime is not available: ${agentId}`);
		}
		const runtimeGeneration = this.bind(sessionId, agentId);
		tab.runtimeGeneration = runtimeGeneration;
		void this.logger?.info("session-runtime", "Anonymous runtime bound", {
			sessionId,
			agentId,
			runtimeGeneration,
		});
		return this.runtimeInfo(sessionId, tab);
	}

	validateTarget(target: SessionRuntimeTarget): SessionCommandResult<SessionRuntimeTarget> {
		try {
			this.requireTarget(target);
			return { ok: true, value: target };
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	renameRuntime(
		target: SessionRuntimeTarget,
		name: string,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentTab>>> {
		return this.runTargetCommand(target, async (agentId) => {
			const result = await this.agents.rename(agentId, name);
			void this.logger?.info("session-runtime", "Runtime renamed", {
				sessionId: target.sessionId,
				agentId,
				name,
			});
			return result;
		});
	}

	abortRuntime(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<void>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.abort(agentId));
	}

	compactRuntime(
		target: SessionRuntimeTarget,
		prompt?: string,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.compact(agentId, prompt));
	}

	getRuntimeState(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.getRuntimeState(agentId));
	}

	listRuntimeCommands(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<PiCommand[]>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// 命令列表是可选能力：后端未声明 getCommands 时按能力缺失拒绝（UI 应已按能力隐藏入口）。
			// 必须对象调用：抽成 const fn = this.agents.fn 会丢掉 this（CompositeAgentGateway.resolveBackend 崩）。
			if (typeof this.agents.getCommands !== "function") {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`backend "${this.agents.backend}" does not support getCommands`,
				);
			}
			return await this.agents.getCommands(agentId) as PiCommand[];
		});
	}

	listRuntimeModels(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<AvailableModel[]>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.getAvailableModels(agentId));
	}

	listRuntimeThinkingLevels(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<string[] | undefined>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// DSH does not own this Pi-specific RPC; callers use its host catalog instead.
			if (typeof this.agents.getAvailableThinkingLevels !== "function") return undefined;
			return this.agents.getAvailableThinkingLevels(agentId);
		});
	}

	exportRuntimeHtml(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<unknown>>> {
		return this.runTargetCommand(target, async (agentId) => {
			if (typeof this.agents.exportHtml !== "function") {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`backend "${this.agents.backend}" does not support exportHtml`,
				);
			}
			return this.agents.exportHtml(agentId);
		});
	}

	listRewindCheckpoints(
		target: SessionRuntimeTarget,
		params?: RewindCheckpointPageParams,
	): Promise<SessionCommandResult<SessionTargetedValue<RewindCheckpointPage>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// rewind 是可选能力：后端未实现 listCheckpoints 时按能力缺失拒绝（UI 应已按能力隐藏入口）。
			if (typeof this.agents.listCheckpoints !== "function") {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`backend "${this.agents.backend}" does not support rewind checkpoints`,
				);
			}
			return this.agents.listCheckpoints(agentId, params);
		});
	}

	getRewindCheckpointDiff(
		target: SessionRuntimeTarget,
		checkpointId: unknown,
	): Promise<SessionCommandResult<SessionTargetedValue<string>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// 渲染层入参不可信：checkpointId 会拼进 ref 名，必须过安全字符校验。
			if (!isRewindCheckpointId(checkpointId)) {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`Invalid rewind checkpoint id: ${String(checkpointId)}`,
				);
			}
			if (typeof this.agents.getCheckpointDiff !== "function") {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`backend "${this.agents.backend}" does not support rewind diffs`,
				);
			}
			return this.agents.getCheckpointDiff(agentId, checkpointId);
		});
	}

	restoreRewindCheckpoint(
		target: SessionRuntimeTarget,
		checkpointId: unknown,
		scope: unknown,
	): Promise<SessionCommandResult<SessionTargetedValue<RewindRestoreResult>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// 渲染层入参不可信：scope 必须落在契约枚举内，checkpointId 必须过安全字符校验。
			if (!isRewindCheckpointId(checkpointId)) {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`Invalid rewind checkpoint id: ${String(checkpointId)}`,
				);
			}
			if (!isRewindRestoreScope(scope)) {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`Invalid rewind restore scope: ${String(scope)}`,
				);
			}
			if (typeof this.agents.restoreCheckpoint !== "function") {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`backend "${this.agents.backend}" does not support rewind restore`,
				);
			}
			return this.agents.restoreCheckpoint(agentId, checkpointId, scope);
		});
	}

	editRuntimeMessage(
		target: SessionRuntimeTarget,
		messageId: string,
		newText: string,
	): Promise<SessionCommandResult<SessionTargetedValue<void>>> {
		return this.runTargetCommand(target, async (agentId) => {
			if (typeof this.agents.editMessage !== "function") {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`backend "${this.agents.backend}" does not support editMessage`,
				);
			}
			return this.agents.editMessage(agentId, messageId, newText);
		});
	}

	deleteRuntimeMessage(
		target: SessionRuntimeTarget,
		messageId: string,
	): Promise<SessionCommandResult<SessionTargetedValue<void>>> {
		return this.runTargetCommand(target, async (agentId) => {
			if (typeof this.agents.deleteMessage !== "function") {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`backend "${this.agents.backend}" does not support deleteMessage`,
				);
			}
			return this.agents.deleteMessage(agentId, messageId);
		});
	}

	prepareRuntimeResend(
		target: SessionRuntimeTarget,
		messageId: string,
	): Promise<SessionCommandResult<SessionTargetedValue<{ text: string; images?: ImageContent[] }>>> {
		return this.runTargetCommand(
			target,
			(agentId) => this.agents.prepareResendFromMessage(agentId, messageId),
		);
	}

	/**
	 * catalog 级编辑：只改磁盘 JSONL，不碰运行中 Agent。
	 * 仍在跑 / 正在激活时拒绝，避免内存与文件分叉；渲染层应先 stop 再调这里。
	 */
	editCatalogMessage(
		sessionId: string,
		messageId: string,
		newText: string,
		/** 渲染层消息的文件条目 id（meta.entryId）：live randomUUID 无法在文件里定位。 */
		entryId?: string,
	): Promise<SessionCommandResult<void>> {
		return this.mutateCatalogMessage(sessionId, messageId, "edit", newText, entryId).then((result) => {
			if (!result.ok) return result;
			return { ok: true as const, value: undefined };
		});
	}

	/** catalog 级删除：墓碑写入 JSONL，要求 Agent 已停。 */
	deleteCatalogMessage(
		sessionId: string,
		messageId: string,
		/** 渲染层消息的文件条目 id（meta.entryId）：live randomUUID 无法在文件里定位。 */
		entryId?: string,
	): Promise<SessionCommandResult<void>> {
		return this.mutateCatalogMessage(sessionId, messageId, "delete", undefined, entryId).then((result) => {
			if (!result.ok) return result;
			return { ok: true as const, value: undefined };
		});
	}

	/** catalog 级重发准备：截断该用户消息及其后继，返回原文快照供随后 sendPrompt。 */
	prepareCatalogResend(
		sessionId: string,
		messageId: string,
		/** 渲染层消息的文件条目 id（meta.entryId）：live randomUUID 无法在文件里定位。 */
		entryId?: string,
	): Promise<SessionCommandResult<{ text: string; images?: ImageContent[] }>> {
		return this.mutateCatalogMessage(sessionId, messageId, "resend", undefined, entryId).then((result) => {
			if (!result.ok) return result;
			return {
				ok: true as const,
				value: result.value ?? { text: "" },
			};
		});
	}

	/** 列出可 fork 的用户消息 entryId（供 UI 在 meta.entryId 缺失时回退匹配）。 */
	getRuntimeForkMessages(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionTargetedValue<Array<{ entryId: string; text: string }>>>> {
		return this.runTargetCommand(
			target,
			(agentId) => this.agents.getForkMessages(agentId),
		);
	}

	/** 按 entryId 执行 pi /fork；成功后调用方需走 replaceAgentSession 刷新绑定。 */
	forkRuntimeSession(
		target: SessionRuntimeTarget,
		entryId: string,
	): Promise<SessionCommandResult<SessionTargetedValue<unknown>>> {
		return this.runTargetCommand(
			target,
			(agentId) => this.agents.forkSession(agentId, entryId),
		);
	}

	setRuntimeModel(
		target: SessionRuntimeTarget,
		provider: string,
		modelId: string,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// 先调运行中 Agent；成功后再写 catalog。
			// 若先写后失败：用户点「取消重启」时 catalog 已是新模型，下次启动会误套上；
			// 且 ConfirmDialog 点确定也会走 onCancel，回滚与确认会互相踩。
			// needsRestart 由渲染层在用户确认后再 updateRecord + 重启。
			await this.agents.setModel(agentId, provider, modelId);
			const runtimeState = await this.agents.getRuntimeState(agentId);
			const appliedModel = runtimeState.provider && runtimeState.modelId
				? { provider: runtimeState.provider, modelId: runtimeState.modelId }
				: { provider, modelId };
			// 模型与思考档位是两项独立的用户选择。DSH/PI 的后端可自行规范化或拒绝
			// reasoning effort，但中间层不能因目录元数据缺失而改写已保存的思考偏好；
			// 否则用户切回支持该档位的模型时会丢失原选择。
			await this.catalog.update(target.sessionId, {
				model: appliedModel,
				updatedAt: Date.now(),
			});
			void this.logger?.info("session-runtime", "Runtime model changed", {
				sessionId: target.sessionId,
				agentId,
				provider,
				modelId,
				requestedProvider: provider,
				requestedModelId: modelId,
				appliedProvider: appliedModel.provider,
				appliedModelId: appliedModel.modelId,
			});
			return runtimeState;
		});
	}

	setRuntimeThinking(
		target: SessionRuntimeTarget,
		level: string,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// D13：与 setRuntimeModel 一致——先调运行中 Agent，成功后再写 catalog。
			// 原先先写 catalog 再调 agent：DSH 无模型选中时 setThinking 只记内存不落 host，
			// catalog 已更新但 host 未生效，重启/attach 后对账漂移。
			await this.agents.setThinking(agentId, level);
			// DSH 的 selectModel 可能规范化或回退 reasoningEffort；runtime state 是
			// host 接受后的权威值。没有当前模型时 DSH 不会产生 runtime thinking，
			// 此时保留用户请求值作为下一次启动时应用的 catalog 偏好。
			const runtimeState = await this.agents.getRuntimeState(agentId);
			const appliedLevel = runtimeState.thinkingLevel ?? level;
			await this.catalog.update(target.sessionId, {
				thinkingLevel: appliedLevel,
				updatedAt: Date.now(),
			});
			void this.logger?.info("session-runtime", "Runtime thinking changed", {
				sessionId: target.sessionId,
				agentId,
				requestedLevel: level,
				appliedLevel,
			});
			return runtimeState;
		});
	}

	/**
	 * Apply a DSH permission preset through the active runtime command path.
	 * The preset is persisted only after the host accepts it, so catalog state
	 * cannot claim a restricted mode while the live host is still unrestricted.
	 */
	setRuntimePermission(
		target: SessionRuntimeTarget,
		preset: string,
	): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, async (agentId) => {
			if (typeof this.agents.setPermission !== "function") {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`backend "${this.agents.backend}" does not support permissions`,
				);
			}
			await this.agents.setPermission(agentId, preset);
			await this.catalog.update(target.sessionId, {
				permissionPreset: preset,
				updatedAt: Date.now(),
			});
			void this.logger?.info("session-runtime", "Runtime permission changed", {
				sessionId: target.sessionId,
				agentId,
				preset,
			});
			return this.agents.getRuntimeState(agentId);
		});
	}

	async stopRuntime(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionRuntimeTarget>> {
		let reservation: RuntimeReplacement | undefined;
		try {
			this.requireTarget(target);
			reservation = this.reserveBoundRuntime(target.sessionId, target.agentId);
			await this.agents.stop(target.agentId);
			this.requireCurrentReservation(reservation);
			this.releaseRuntimeReplacement(reservation);
			reservation = undefined;
			this.unbindAgentUnchecked(target.agentId);
			void this.logger?.info("session-runtime", "Runtime stopped", {
				sessionId: target.sessionId,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			});
			return { ok: true, value: target };
		} catch (error) {
			return this.commandFailure(error);
		} finally {
			if (reservation && this.replacementByAgent.get(target.agentId) === reservation) {
				this.releaseRuntimeReplacement(reservation);
			}
		}
	}

	/**
	 * 按 agentId 停止 agent（进程监控「停止」入口用，调用方只有 agentId）。
	 * 通过 sessionIdByAgent 反查会话并构造完整 target，复用 stopRuntime 的
	 * 保留/解绑收尾，确保会话运行时状态同步；无会话绑定（游离 agent）时幂等直停。
	 */
	async stopAgentById(
		agentId: string,
	): Promise<SessionCommandResult<SessionRuntimeTarget | undefined>> {
		try {
			const binding = this.getRuntimeBinding(agentId);
			if (!binding) {
				await this.agents.stop(agentId);
				void this.logger?.info("session-runtime", "Agent stopped (unbound)", { agentId });
				return { ok: true, value: undefined };
			}
			const target: SessionRuntimeTarget = {
				sessionId: binding.sessionId,
				agentId,
				runtimeGeneration: binding.runtimeGeneration,
			};
			return await this.stopRuntime(target);
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	async restartRuntime(
		target: SessionRuntimeTarget,
	): Promise<SessionCommandResult<SessionRuntimeReplacement>> {
		try {
			this.requireTarget(target);
			const tab = await this.restartSession(target.sessionId, target.agentId);
			const session = this.catalog.getRecord(target.sessionId);
			if (!session) {
				throw new SessionRuntimeCommandError("SESSION_NOT_FOUND", "Session no longer exists");
			}
			void this.logger?.info("session-runtime", "Runtime restarted", {
				sessionId: target.sessionId,
				agentId: target.agentId,
				runtimeGeneration: target.runtimeGeneration,
			});
			return {
				ok: true,
				value: {
					previousTarget: target,
					runtime: this.runtimeInfo(target.sessionId, tab),
					session: { ...session },
				},
			};
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	bindExistingAgent(sessionId: string, agentId: string): number {
		if (!this.catalog.get(sessionId)) throw new Error(`Session not found: ${sessionId}`);
		return this.bind(sessionId, agentId);
	}

	attachCatalogRuntimes(records: SessionRecord[]): Array<{
		sessionId: string;
		agentId: string;
		runtimeGeneration: number;
	}> {
		const bindings: Array<{
			sessionId: string;
			agentId: string;
			runtimeGeneration: number;
		}> = [];
		const availableAgents = this.agents.list().filter((tab) => (
			!isTerminalAgent(tab) &&
			!this.replacementByAgent.has(tab.id) &&
			!this.hasDispatchLease(undefined, tab.id)
		));
		for (const record of records) {
			if (
				!record.filePath ||
				this.replacementBySession.has(record.id) ||
				this.hasDispatchLease(record.id)
			) continue;
			const target = buildSessionOriginKey({
				source: record.source,
				environment: record.environment,
				filePath: record.filePath,
				wslDistro: record.wslDistro,
				wslUser: record.wslUser,
				importedSourceId: record.importedSourceId,
			});
			const tab = availableAgents.find((candidate) => (
				candidate.projectId === record.projectId &&
				candidate.sessionPath &&
				buildSessionOriginKey({
					source: candidate.sessionSource ?? "pi",
					environment: candidate.sessionEnvironment ?? "native",
					filePath: candidate.sessionPath,
					wslDistro: candidate.wslDistro,
					wslUser: candidate.wslUser,
					importedSourceId: candidate.importedSourceId,
				}) === target
			));
			if (!tab) continue;
			bindings.push({
				sessionId: record.id,
				agentId: tab.id,
				runtimeGeneration: this.bind(record.id, tab.id),
			});
		}
		return bindings;
	}

	observeRuntimeEvent(event: SessionRuntimeEvent): void {
		const binding = this.getRuntimeBinding(event.agentId);
		if (
			!binding ||
			binding.sessionId !== event.sessionId ||
			binding.runtimeGeneration !== event.runtimeGeneration ||
			event.sourceChannel !== "agents:ui-request" ||
			!isRecord(event.payload)
		) {
			return;
		}
		const requestId = typeof event.payload.requestId === "string"
			? event.payload.requestId.trim()
			: "";
		if (!requestId) return;
		const key = this.uiRequestKey(event.sessionId, requestId);
		if (event.payload.completed === true) {
			this.pendingUiRequests.delete(key);
			return;
		}
		if (!isInteractiveUiMethod(event.payload.method)) return;
		const options = Array.isArray(event.payload.options)
			? event.payload.options.filter((option): option is string => typeof option === "string")
			: undefined;
		this.pendingUiRequests.set(key, {
			sessionId: event.sessionId,
			agentId: event.agentId,
			runtimeGeneration: event.runtimeGeneration,
			requestId,
			method: String(event.payload.method),
			title: typeof event.payload.title === "string" ? event.payload.title : "",
			options,
			placeholder: typeof event.payload.placeholder === "string" ? event.payload.placeholder : undefined,
			prefill: typeof event.payload.prefill === "string" ? event.payload.prefill : undefined,
			allowOther: event.payload.allowOther === true,
		});

		// 非聚焦会话收到 Ask 类请求时触发桌面通知：用户切到别的会话时
		// 也能第一时间知道另一个会话需要确认，不用手动切回去才发现。
		if (this.focusedSessionId !== event.sessionId) {
			const title = this.catalog.get(event.sessionId)?.title
				?? this.catalog.getRecord(event.sessionId)?.title
				?? "";
			// 带 agentId（每轮去重）、sessionId（点击跳转）与提问内容（展示在通知气泡里）
			const question = typeof event.payload.title === "string" ? event.payload.title : "";
			this.agents.notifyAskPending(event.agentId, event.sessionId, title, question);
		}
	}

	/** Web / 飞书以外的只读快照：手机端轮询后渲染确认卡片。 */
	listPendingUiRequests(sessionId?: string): PendingUiRequestSnapshot[] {
		const items: PendingUiRequestSnapshot[] = [];
		for (const pending of this.pendingUiRequests.values()) {
			if (sessionId && pending.sessionId !== sessionId) continue;
			items.push({ ...pending });
		}
		return items;
	}

	async respondToUi(input: SessionUiResponseInput): Promise<void> {
		const binding = this.getRuntimeBinding(input.agentId);
		if (
			!binding ||
			binding.sessionId !== input.sessionId ||
			binding.runtimeGeneration !== input.runtimeGeneration ||
			this.agentIdBySession.get(input.sessionId) !== input.agentId
		) {
			throw new Error("Session runtime binding changed before UI response");
		}
		const key = this.uiRequestKey(input.sessionId, input.requestId);
		const pending = this.pendingUiRequests.get(key);
		if (
			!pending ||
			pending.agentId !== input.agentId ||
			pending.runtimeGeneration !== input.runtimeGeneration
		) {
			throw new Error("Session UI request is not pending");
		}
		this.pendingUiRequests.delete(key);
		try {
			await this.agents.sendUIResponse(input.agentId, input.requestId, input.response);
		} catch (error) {
			this.pendingUiRequests.set(key, pending);
			throw error;
		}
	}

	getRuntimeBinding(agentId: string): {
		sessionId: string;
		runtimeGeneration: number;
	} | undefined {
		const sessionId = this.sessionIdByAgent.get(agentId);
		if (!sessionId || this.agentIdBySession.get(sessionId) !== agentId) return undefined;
		return {
			sessionId,
			runtimeGeneration: this.generationBySession.get(sessionId) ?? 0,
		};
	}

	async replaceBoundRuntime<T extends { cancelled?: boolean }>(input: {
		agentId: string;
		replace: () => Promise<T>;
		resolveTargetSessionId: (result: T) => Promise<string>;
		canRestoreOrigin: () => boolean;
		onDetached: (binding: SessionRuntimeBinding) => void;
		onAttached: (binding: SessionRuntimeBinding) => void;
		onRestored: (binding: SessionRuntimeBinding) => void;
	}): Promise<T & { targetSessionId?: string }> {
		const replacement = this.beginRuntimeReplacement(input.agentId);
		if (!replacement) return input.replace();

		try {
			input.onDetached(replacement);
			const result = await input.replace();
			if (result.cancelled) {
				const restored = this.restoreRuntimeReplacement(replacement);
				input.onRestored(restored);
				return result;
			}
			const targetSessionId = await input.resolveTargetSessionId(result);
			const attached = this.completeRuntimeReplacement(replacement, targetSessionId);
			// The target binding is committed before observers run. Snapshot failures
			// must not roll the agent back onto the detached origin Session.
			input.onAttached(attached);
			return { ...result, targetSessionId };
		} catch (error) {
			if (this.replacementByAgent.get(input.agentId) === replacement) {
				let canRestoreOrigin = false;
				try {
					canRestoreOrigin = input.canRestoreOrigin();
				} catch {
					// An unprovable runtime identity is handled fail-closed.
				}
				if (canRestoreOrigin) {
					const restored = this.restoreRuntimeReplacement(replacement);
					input.onRestored(restored);
				} else {
					this.failClosedRuntimeReplacement(replacement);
				}
			}
			throw error;
		}
	}

	unbindAgent(agentId: string): void {
		this.assertNoDispatchLease(undefined, agentId);
		this.unbindAgentUnchecked(agentId);
	}

	/**
	 * DSH fork/clone 前调用（D3）：确保该 agent 无在途发送（dispatch lease）。
	 * pi fork 走 replaceBoundRuntime 内部已做此检查；DSH fork 是 manager 内原地换绑，
	 * 不经过 replacement 流程，这里显式检查避免「fork 时 prompt 在途 → RPC 响应落到
	 * 已废弃 mux」的结果丢失/串台。有在途发送时抛错（调用方转 SESSION_COMMAND_FAILED）。
	 */
	assertNoDispatchInFlight(agentId: string): void {
		const sessionId = this.sessionIdByAgent.get(agentId);
		if (sessionId) this.assertNoDispatchLease(sessionId, agentId);
	}

	/**
	 * DSH fork/clone 的绑定预留（C10）：执行期间占用 replacement 槽位，阻止并发
	 * restart/其他 replacement 命令交错（restart 的 reserveBoundRuntime 会发现
	 * replacement 已被占用而拒绝）；执行完成后释放。DSH fork 保持同一
	 * SessionRecord ↔ agentId 绑定（dshSessionId 由 manager/catalog 回写），
	 * 无需像 restart 那样重建绑定。内部同样做 dispatch lease 检查。
	 */
	async withRuntimeReservation<T>(
		sessionId: string,
		agentId: string,
		fn: () => Promise<T>,
	): Promise<T> {
		const reservation = this.reserveBoundRuntime(sessionId, agentId);
		try {
			const result = await fn();
			this.releaseRuntimeReplacement(reservation);
			return result;
		} catch (error) {
			this.releaseRuntimeReplacement(reservation);
			throw error;
		}
	}

	/** Fail closed after a process reaches a terminal state, including mid-dispatch. */
	unbindTerminalAgent(agentId: string): void {
		this.unbindAgentUnchecked(agentId);
	}

	private unbindAgentUnchecked(agentId: string): void {
		const replacement = this.replacementByAgent.get(agentId);
		if (replacement) this.releaseRuntimeReplacement(replacement);
		const sessionId = this.sessionIdByAgent.get(agentId);
		if (sessionId) {
			this.agentIdBySession.delete(sessionId);
			this.clearPendingUiRequests(sessionId, agentId);
			// restart 会先 applyLatestPreferences(新 agent) 再 unbind 旧 agent；
			// 只清「属于这个旧进程」的记录，别把刚写上的新 agent 快照删掉。
			const last = this.lastAppliedBySession.get(sessionId);
			if (last?.agentId === agentId) {
				this.lastAppliedBySession.delete(sessionId);
			}
		}
		this.sessionIdByAgent.delete(agentId);
	}

	async restartSession(sessionId: string, agentId: string): Promise<AgentTab> {
		const entry = this.catalog.get(sessionId);
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		// 直接读绑定表做「是否被其他 agent 抢占」的校验，不能走 getAgentId：
		// getAgentId 对终态（error/closed）agent 有解绑副作用，会清掉绑定后导致
		// 紧随其后的 reserveBoundRuntime 误抛「binding changed」（重启终态 Agent
		// 时用户看到「会话运行实例已发生变化」）。终态 Agent 的 restart 仍由
		// agents.restart 内部先 stop 旧进程再 create 新进程完成，不需要提前解绑。
		const boundAgentId = this.agentIdBySession.get(sessionId);
		if (boundAgentId && boundAgentId !== agentId) {
			throw new Error("Session runtime changed before restart");
		}

		const reservation = this.reserveBoundRuntime(sessionId, agentId);
		try {
			let tab = await this.agents.restart(agentId);
			if (tab.status === "starting") tab = await this.waitUntilReady(tab);
			if (isTerminalAgent(tab)) {
				this.unbindAgentUnchecked(agentId);
				throw new Error(`Failed to restart session runtime (${tab.status})`);
			}
			try {
				// 必须重读 catalog：开头的 entry 是 clone，重启等待期间用户可能已改模型。
				await this.applyLatestPreferences(sessionId, tab.id);
			} catch (error) {
				await this.agents.stop(tab.id).catch(() => undefined);
				this.unbindAgentUnchecked(agentId);
				throw new Error(`Failed to apply session preferences: ${errorMessage(error)}`);
			}

			this.requireCurrentReservation(reservation);
			this.releaseRuntimeReplacement(reservation);
			this.unbindAgentUnchecked(agentId);
			const runtimeGeneration = this.bind(sessionId, tab.id);
			tab.runtimeGeneration = runtimeGeneration;
			// C9：attach patch 收拢 backend 特判（DSH 文件配对分支同时写 dshSessionId，
			// 标题同步与重启后 attach 恢复依赖它）。
			const restartPatch = this.buildAttachPatch(sessionId, tab, entry);
			if (restartPatch) {
				await this.catalog.attachRuntime(restartPatch);
			}
			// 与 activate 同链路：绑定完成后推送完整 runtime state，渲染层底栏即时反映真实模型。
			await this.agents.publishRuntimeState(tab.id).catch(() => undefined);
			return tab;
		} finally {
			if (this.replacementByAgent.get(agentId) === reservation) {
				this.releaseRuntimeReplacement(reservation);
			}
		}
	}

	private async sendOnce(input: SendSessionPromptInput): Promise<SendSessionPromptResult> {
		const pipelineStartedAt = Date.now();
		void this.logger?.info("session-perf", "Prompt pipeline started", {
			sessionId: input.sessionId,
			requestId: input.requestId,
		});
		let tab: AgentTab;
		try {
			void this.logger?.info("session-perf", "Runtime activation started", {
				sessionId: input.sessionId,
				requestId: input.requestId,
			});
			tab = await this.ensureRuntime(input.sessionId);
			void this.logger?.info("session-perf", "Runtime activation completed", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: tab.id,
				activationMs: Date.now() - pipelineStartedAt,
			});
		} catch (error) {
			return this.rejected(input, errorMessage(error));
		}

		let lease: DispatchLease;
		try {
			lease = this.acquireDispatchLease(input.sessionId, tab.id);
		} catch (error) {
			return this.rejected(input, errorMessage(error));
		}

		try {
			if (!this.isCurrentDispatchLease(lease)) {
				return this.unknownDelivery(input, "Session runtime binding changed before prompt dispatch");
			}

			let result: SendPromptResult;
			const dispatchStartedAt = Date.now();
			void this.logger?.info("session-perf", "Prompt dispatch started", {
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: lease.agentId,
			});
			try {
				result = await this.sendAgentPrompt({
					agentId: lease.agentId,
					message: input.message,
					images: input.images,
					streamingBehavior: input.streamingBehavior,
					agentMessage: input.agentMessage,
					description: input.description,
					requestId: input.requestId,
				});
				void this.logger?.info("session-perf", "Prompt dispatch completed", {
					sessionId: input.sessionId,
					requestId: input.requestId,
					agentId: lease.agentId,
					accepted: result.accepted,
					dispatchMs: Date.now() - dispatchStartedAt,
				});
			} catch (error) {
				result = {
					accepted: false,
					error: errorMessage(error),
					delivery: "unknown",
				};
			}
			if (!this.isCurrentDispatchLease(lease)) {
				return this.unknownDelivery(input, "Session runtime binding changed during prompt dispatch");
			}
			const currentTab = this.agents.list().find((candidate) => (
				candidate.id === lease.agentId && !isTerminalAgent(candidate)
			));
			if (!currentTab) {
				return this.unknownDelivery(input, "Session runtime stopped during prompt dispatch");
			}
			// C9：attach patch 收拢 backend 特判（DSH 文件配对分支同时回写 dshSessionId）。
			const dispatchEntry = this.catalog.get(input.sessionId);
			const dispatchPatch = dispatchEntry
				? this.buildAttachPatch(input.sessionId, currentTab, dispatchEntry)
				: null;
			if (dispatchPatch) {
				// Prompt acceptance is the latency-sensitive boundary. Catalog persistence is
				// recovery metadata and must not keep the composer in a sending state; failures
				// are intentionally isolated from the already accepted prompt.
				// DSH 预热只绑 host id、保持 draft；真正发出去才 promoteToActive。
				void this.catalog.attachRuntime({
					...dispatchPatch,
					promoteToActive: true,
				}).catch(() => undefined);
			}
			if (!this.isCurrentDispatchLease(lease)) {
				return this.unknownDelivery(input, "Session runtime binding changed after prompt dispatch");
			}
			return {
				...result,
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: lease.agentId,
				sessionPath: currentTab.sessionPath,
				runtimeGeneration: lease.runtimeGeneration,
			};
		} finally {
			this.releaseDispatchLease(lease);
		}
	}

	private ensureRuntime(sessionId: string): Promise<AgentTab> {
		const existing = this.activationBySession.get(sessionId);
		if (existing) return existing;
		const activation = this.activate(sessionId).finally(() => {
			this.activationBySession.delete(sessionId);
		});
		this.activationBySession.set(sessionId, activation);
		return activation;
	}

	private async activate(sessionId: string): Promise<AgentTab> {
		if (this.deletingSessions.has(sessionId)) {
			throw new Error(`Session is being deleted: ${sessionId}`);
		}
		const entry = this.catalog.get(sessionId);
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		if (this.replacementBySession.has(sessionId)) {
			throw new Error(`Session runtime replacement reservation conflict: ${sessionId}`);
		}

		const mappedAgentId = this.getAgentId(sessionId);
		if (mappedAgentId) {
			const mappedTab = this.agents.list().find((candidate) => candidate.id === mappedAgentId);
			if (mappedTab) {
				const ready = await this.waitUntilReady(mappedTab);
				// 预热已经 bind 后，用户仍可能改 catalog 模型再点发送。旧逻辑直接
				// waitUntilReady 返回，跳过 applyPreferences，发送就会带着旧模型走。
				try {
					const applied = await this.applyLatestPreferences(sessionId, ready.id);
					if (applied) {
						await this.agents.publishRuntimeState(ready.id).catch(() => undefined);
					}
				} catch (error) {
					// 进程已在跑：应用失败只拒绝本次激活/发送，不停掉现有 runtime。
					throw new Error(`Failed to apply session preferences: ${errorMessage(error)}`);
				}
				return ready;
			}
		}

		let tab = entry.filePath ? this.findAgentBySessionPath(entry) : undefined;
		if (tab && isTerminalAgent(tab)) {
			await this.agents.stop(tab.id);
			tab = undefined;
		}
		if (tab?.status === "starting") tab = await this.waitUntilReady(tab);

		const created = !tab;
		if (!tab) {
			// deckSessionId = catalog 会话身份（SessionRecord.id），与 UI 保存安全等级覆盖用的 key 同源，
			// 确保扩展按 PIDECK_SESSION_ID 能命中 sessionLevels（历史扫描会话为文件路径，新会话为 UUID）。
			tab = await this.agents.create({
				projectId: entry.projectId,
				title: entry.title,
				deckSessionId: sessionId,
				sessionPath: entry.filePath,
				environment: entry.environment,
				source: entry.source,
				backend: entry.backend,
				dshSessionId: entry.backend === "dsh" ? entry.dshSessionId : undefined,
				// DSH agent 预设（会话「模式」）：草稿期预选，新建 host 会话时随 sessions.create
				// 应用；attach 已有会话时由 DshAgentManager 从 host list 行读回（本字段被忽略）。
				agentPreset: entry.backend === "dsh" ? entry.agentPreset : undefined,
				wslDistro: entry.wslDistro,
				wslUser: entry.wslUser,
				importedSourceId: entry.importedSourceId,
				noSession: entry.noSession,
			});
		}
		if (tab.status === "starting") tab = await this.waitUntilReady(tab);
		if (isTerminalAgent(tab)) {
			if (created) await this.agents.stop(tab.id).catch(() => undefined);
			throw this.startupFailure(tab);
		}

		try {
			// 用最新 catalog，不用开头的 entry clone——create/waitUntilReady 期间
			// 用户改模型必须在第一次 setModel 就生效。
			await this.applyLatestPreferences(sessionId, tab.id);
		} catch (error) {
			if (created) {
				// 激活失败兜底：DSH 的 host 会话已在 $DSH_HOME 创建，先落 dshSessionId
				// 再停运行时，避免每次重试新建孤儿。保持 draft——还没开聊，不能抬成 active。
				if (tab.backend === "dsh" && tab.sessionId) {
					await this.catalog
						.attachRuntime({ sessionId, dshSessionId: tab.sessionId })
						.catch(() => undefined);
				}
				await this.agents.stop(tab.id).catch(() => undefined);
			}
			throw new Error(`Failed to apply session preferences: ${errorMessage(error)}`);
		}

		const runtimeGeneration = this.bind(sessionId, tab.id);
		tab.runtimeGeneration = runtimeGeneration;
		// C9：attach patch 收拢 backend 特判——DSH 会话没有 pi 会话文件，DSH sessionId
		// 由 host 持久化（$DSH_HOME），回写 catalog 后重启 activate 走 attach 恢复。
		const activatePatch = this.buildAttachPatch(sessionId, tab, entry);
		if (activatePatch) {
			await this.catalog.attachRuntime(activatePatch);
		}
		// 绑定完成后主动推送完整 runtime state：emitSessionRuntimeEvent 依赖 binding 才转发，
		// 且在偏好应用（setModel/setThinking）之后执行，渲染层底栏拿到的是真实模型而不是旧残留。
		await this.agents.publishRuntimeState(tab.id).catch(() => undefined);
		return tab;
	}

	/**
	 * 会话运行时身份 → catalog attach patch（C9）：收拢 backend 特判——
	 * - DSH：只回写 dshSessionId，**绝不写 filePath/piSessionId**（2026-08 兼容期教训：
	 *   dsh 的 tab.sessionPath 是 host 的 zstd 会话文件，曾随文件分支落盘导致 pi 侧把
	 *   zstd 文件当 pi 会话文件启动（pi exited code=1））；
	 * - 通用/pi：sessionPath + piSessionId 落「文件配对」分支。
	 * 返回 null 表示无需回写（匿名会话等）。
	 */
	private buildAttachPatch(
		sessionId: string,
		tab: Pick<AgentTab, "sessionPath" | "sessionId" | "backend" | "agentPreset">,
		entry: Pick<SessionCatalogEntry, "noSession" | "backend">,
	): { sessionId: string; filePath?: string; piSessionId?: string; dshSessionId?: string; agentPreset?: string; promoteToActive?: boolean } | null {
		if (entry.backend === "dsh") {
			return tab.sessionId && !entry.noSession
				? {
					sessionId,
					dshSessionId: tab.sessionId,
					// DSH 会话的 preset 只在 host 会话 header 里（草稿预选可能被 host 修正），
					// attach/新建后把实际值回写 catalog，头部胶囊展示真实模式。
					...(tab.agentPreset ? { agentPreset: tab.agentPreset } : {}),
				}
				: null;
		}
		if (tab.sessionPath && !entry.noSession) {
			return {
				sessionId,
				filePath: tab.sessionPath,
				piSessionId: tab.sessionId,
			};
		}
		return null;
	}

	private findAgentBySessionPath(entry: SessionCatalogEntry): AgentTab | undefined {
		if (!entry.filePath) return undefined;
		const target = buildSessionOriginKey({
			source: entry.source,
			environment: entry.environment,
			filePath: entry.filePath,
			wslDistro: entry.wslDistro,
			wslUser: entry.wslUser,
			importedSourceId: entry.importedSourceId,
		});
		return this.agents.list().find((tab) => (
			!this.replacementByAgent.has(tab.id) &&
			tab.sessionPath &&
			buildSessionOriginKey({
				source: tab.sessionSource ?? "pi",
				environment: tab.sessionEnvironment ?? "native",
				filePath: tab.sessionPath,
				wslDistro: tab.wslDistro,
				wslUser: tab.wslUser,
				importedSourceId: tab.importedSourceId,
			}) === target
		));
	}

	/**
	 * 重读 catalog 再应用偏好。activate 开头的 entry 是 clone，等待期间用户改模型
	 * 不能再用那份快照。lastApplied 按 agentId+prefs 去重，避免每次 send 都 setModel。
	 * @returns 是否真正调用了 applyPreferences（绑定路径据此决定要不要再 publish）。
	 */
	private async applyLatestPreferences(sessionId: string, agentId: string): Promise<boolean> {
		const latest = this.catalog.get(sessionId);
		if (!latest) throw new Error(`Session not found: ${sessionId}`);
		const preferences = snapshotPreferences(latest);
		const last = this.lastAppliedBySession.get(sessionId);
		if (last?.agentId === agentId && sameAppliedPreferences(last.preferences, preferences)) {
			return false;
		}
		await this.applyPreferences(latest, agentId);
		this.lastAppliedBySession.set(sessionId, { agentId, preferences });
		return true;
	}

	private async applyPreferences(
		entry: SessionCatalogEntry,
		agentId: string,
	): Promise<void> {
		// DSH 草稿的 entry.model 可能来自 pi 的 models.json（引导页/欢迎页选型在
		// 创建时不知道后端，或用户切了默认后端）；host 目录没有该 provider/模型时
		// selectModel 会拒绝。降级为「应用宿主默认模型」并告警，不让整个激活失败
		// （否则每次重试都新建一个 host 会话 = 孤儿堆积）。pi 保持严格（模型应在 models.json）。
		const isDsh = entry.backend === "dsh";
		if (entry.model) {
			try {
				await this.agents.setModel(agentId, entry.model.provider, entry.model.modelId);
			} catch (error) {
				if (!isDsh) throw error;
				void this.logger?.warn("session-runtime", "DSH model preference ignored", {
					sessionId: entry.id,
					provider: entry.model.provider,
					modelId: entry.model.modelId,
					error: errorMessage(error),
				});
			}
		}
		if (entry.thinkingLevel) {
			try {
				await this.agents.setThinking(agentId, entry.thinkingLevel);
			} catch (error) {
				if (!isDsh) throw error;
				const message = errorMessage(error);
				void this.logger?.warn("session-runtime", "DSH thinking preference ignored", {
					sessionId: entry.id,
					thinkingLevel: entry.thinkingLevel,
					error: message,
				});
				// 后端是档位能力的最终裁决者。即使本次 host 拒绝，也保留用户偏好：
				// 目录配置、provider 或模型在之后变化时仍可重新应用，不能由 PiDeck
				// 根据一条当前错误擅自清空用户选择。
			}
		}
		// DSH 权限预设（草稿期预选 / 会话内切换回写）：激活时经 /permission 命令应用
		if (entry.permissionPreset && this.agents.setPermission) {
			await this.agents.setPermission(agentId, entry.permissionPreset);
		}
	}

	private async waitUntilReady(initialTab: AgentTab): Promise<AgentTab> {
		const startedAt = Date.now();
		let tab = initialTab;
		while (tab.status === "starting") {
			if (Date.now() - startedAt >= AGENT_READY_TIMEOUT_MS) {
				throw new Error("Timed out while starting session runtime");
			}
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
			const current = this.agents.list().find((candidate) => candidate.id === tab.id);
			if (!current) throw new Error("Session runtime stopped while starting");
			tab = current;
		}
		if (isTerminalAgent(tab)) {
			throw this.startupFailure(tab);
		}
		return tab;
	}

	/** 保留 pi 启动阶段的 stderr/路径等诊断，避免 Web 端只能看到无意义的 status。 */
	private startupFailure(tab: AgentTab): Error {
		try {
			const diagnostic = [...this.agents.getMessages(tab.id)]
				.reverse()
				.find((message) => message.role === "error");
			const debugDetails = diagnostic?.meta?.debugDetails;
			if (typeof debugDetails === "string" && debugDetails.trim()) {
				return new Error(debugDetails);
			}
			if (diagnostic?.text?.trim()) return new Error(diagnostic.text);
		} catch {
			// 诊断读取失败不能覆盖原始启动状态；下面返回稳定的兜底错误。
		}
		return new Error(`Failed to start session runtime (${tab.status})`);
	}

	private bind(sessionId: string, agentId: string): number {
		if (this.deletingSessions.has(sessionId)) {
			throw new Error(`Session is being deleted: ${sessionId}`);
		}
		this.assertNoDispatchLease(sessionId, agentId);
		if (this.replacementByAgent.has(agentId)) {
			throw new Error(`Session runtime replacement already in progress: ${agentId}`);
		}
		if (this.replacementBySession.has(sessionId)) {
			throw new Error(`Session runtime replacement reservation conflict: ${sessionId}`);
		}
		const previousAgentId = this.agentIdBySession.get(sessionId);
		if (
			previousAgentId === agentId &&
			this.sessionIdByAgent.get(agentId) === sessionId
		) {
			return this.generationBySession.get(sessionId) ?? 0;
		}
		if (previousAgentId && previousAgentId !== agentId) {
			this.sessionIdByAgent.delete(previousAgentId);
			this.clearPendingUiRequests(sessionId, previousAgentId);
		}
		const previousSessionId = this.sessionIdByAgent.get(agentId);
		if (previousSessionId && previousSessionId !== sessionId) {
			this.agentIdBySession.delete(previousSessionId);
			this.clearPendingUiRequests(previousSessionId, agentId);
		}
		this.clearPendingUiRequests(sessionId);
		const runtimeGeneration = (this.generationBySession.get(sessionId) ?? 0) + 1;
		this.generationBySession.set(sessionId, runtimeGeneration);
		this.agentIdBySession.set(sessionId, agentId);
		this.sessionIdByAgent.set(agentId, sessionId);
		const tab = this.agents.list().find((candidate) => candidate.id === agentId);
		if (tab) tab.runtimeGeneration = runtimeGeneration;
		return runtimeGeneration;
	}

	private beginRuntimeReplacement(agentId: string): RuntimeReplacement | undefined {
		const binding = this.getRuntimeBinding(agentId);
		if (!binding) return undefined;
		this.assertNoDispatchLease(binding.sessionId, agentId);
		if (this.replacementByAgent.has(agentId)) {
			throw new Error(`Session runtime replacement already in progress: ${agentId}`);
		}
		if (this.replacementBySession.has(binding.sessionId)) {
			throw new Error(`Session runtime replacement reservation conflict: ${binding.sessionId}`);
		}
		const runtimeGeneration = binding.runtimeGeneration + 1;
		this.generationBySession.set(binding.sessionId, runtimeGeneration);
		this.agentIdBySession.delete(binding.sessionId);
		this.sessionIdByAgent.delete(agentId);
		this.clearPendingUiRequests(binding.sessionId, agentId);
		const replacement: RuntimeReplacement = {
			...binding,
			agentId,
			runtimeGeneration,
			replacementId: ++this.replacementSequence,
		};
		this.replacementByAgent.set(agentId, replacement);
		this.replacementBySession.set(binding.sessionId, replacement);
		return replacement;
	}

	private completeRuntimeReplacement(
		replacement: RuntimeReplacement,
		targetSessionId: string,
	): SessionRuntimeBinding {
		this.requireCurrentReplacement(replacement);
		if (!this.catalog.get(targetSessionId)) {
			throw new Error(`Session not found: ${targetSessionId}`);
		}
		const targetAgentId = this.getAgentId(targetSessionId);
		if (targetAgentId && targetAgentId !== replacement.agentId) {
			throw new Error(`Session runtime target already bound: ${targetSessionId}`);
		}
		const targetReplacement = this.replacementBySession.get(targetSessionId);
		if (targetReplacement && targetReplacement !== replacement) {
			throw new Error(`Session runtime replacement reservation conflict: ${targetSessionId}`);
		}
		this.releaseRuntimeReplacement(replacement);
		return {
			sessionId: targetSessionId,
			agentId: replacement.agentId,
			runtimeGeneration: this.bind(targetSessionId, replacement.agentId),
		};
	}

	private restoreRuntimeReplacement(
		replacement: RuntimeReplacement,
	): SessionRuntimeBinding {
		this.requireCurrentReplacement(replacement);
		this.releaseRuntimeReplacement(replacement);
		return {
			sessionId: replacement.sessionId,
			agentId: replacement.agentId,
			runtimeGeneration: this.bind(replacement.sessionId, replacement.agentId),
		};
	}

	private failClosedRuntimeReplacement(replacement: RuntimeReplacement): void {
		this.requireCurrentReplacement(replacement);
		this.releaseRuntimeReplacement(replacement);
	}

	private releaseRuntimeReplacement(replacement: RuntimeReplacement): void {
		if (this.replacementByAgent.get(replacement.agentId) === replacement) {
			this.replacementByAgent.delete(replacement.agentId);
		}
		if (this.replacementBySession.get(replacement.sessionId) === replacement) {
			this.replacementBySession.delete(replacement.sessionId);
		}
	}

	private requireCurrentReplacement(replacement: RuntimeReplacement): void {
		if (this.replacementByAgent.get(replacement.agentId) !== replacement) {
			throw new Error("Session runtime replacement binding changed");
		}
		if (this.replacementBySession.get(replacement.sessionId) !== replacement) {
			throw new Error("Session runtime replacement reservation changed");
		}
		if (
			this.sessionIdByAgent.has(replacement.agentId) ||
			this.agentIdBySession.get(replacement.sessionId) === replacement.agentId
		) {
			throw new Error("Session runtime replacement acquired a competing binding");
		}
	}

	private reserveBoundRuntime(sessionId: string, agentId: string): RuntimeReplacement {
		const binding = this.getRuntimeBinding(agentId);
		if (
			!binding ||
			binding.sessionId !== sessionId ||
			this.agentIdBySession.get(sessionId) !== agentId
		) {
			throw new Error("Session runtime changed before reservation");
		}
		this.assertNoDispatchLease(sessionId, agentId);
		if (this.replacementByAgent.has(agentId)) {
			throw new Error(`Session runtime replacement already in progress: ${agentId}`);
		}
		if (this.replacementBySession.has(sessionId)) {
			throw new Error(`Session runtime replacement reservation conflict: ${sessionId}`);
		}
		const reservation: RuntimeReplacement = {
			...binding,
			agentId,
			replacementId: ++this.replacementSequence,
		};
		this.replacementByAgent.set(agentId, reservation);
		this.replacementBySession.set(sessionId, reservation);
		return reservation;
	}

	private requireCurrentReservation(reservation: RuntimeReplacement): void {
		if (
			this.replacementByAgent.get(reservation.agentId) !== reservation ||
			this.replacementBySession.get(reservation.sessionId) !== reservation
		) {
			throw new Error("Session runtime reservation changed");
		}
		const binding = this.getRuntimeBinding(reservation.agentId);
		if (
			!binding ||
			binding.sessionId !== reservation.sessionId ||
			binding.runtimeGeneration !== reservation.runtimeGeneration
		) {
			throw new Error("Session runtime binding changed during reservation");
		}
	}

	private runtimeInfo(sessionId: string, tab: AgentTab): SessionRuntimeInfo {
		const target = this.getTarget(sessionId);
		if (!target || target.agentId !== tab.id) {
			throw new SessionRuntimeCommandError(
				"SESSION_RUNTIME_CHANGED",
				"Session runtime binding changed while building runtime state",
			);
		}
		return {
			...target,
			projectId: tab.projectId,
			cwd: tab.cwd,
			status: tab.status,
			sessionPath: tab.sessionPath,
			createdAt: tab.createdAt,
			compactionCount: tab.compactionCount,
			noSession: tab.noSession,
		};
	}

	private requireTarget(target: SessionRuntimeTarget): SessionRuntimeBinding {
		if (!this.catalog.get(target.sessionId)) {
			throw new SessionRuntimeCommandError(
				"SESSION_NOT_FOUND",
				`Session not found: ${target.sessionId}`,
			);
		}
		const binding = this.getRuntimeBinding(target.agentId);
		if (!binding || this.agentIdBySession.get(target.sessionId) !== target.agentId) {
			throw new SessionRuntimeCommandError(
				"SESSION_RUNTIME_UNAVAILABLE",
				"Session runtime is not available",
			);
		}
		if (
			binding.sessionId !== target.sessionId ||
			binding.runtimeGeneration !== target.runtimeGeneration
		) {
			throw new SessionRuntimeCommandError(
				"SESSION_RUNTIME_CHANGED",
				"Session runtime binding changed",
			);
		}
		return { ...target };
	}

	private async runTargetCommand<T>(
		target: SessionRuntimeTarget,
		operation: (agentId: string) => Promise<T>,
	): Promise<SessionCommandResult<SessionTargetedValue<T>>> {
		let lease: DispatchLease | undefined;
		try {
			this.requireTarget(target);
			lease = this.acquireDispatchLease(target.sessionId, target.agentId);
			if (lease.runtimeGeneration !== target.runtimeGeneration) {
				throw new SessionRuntimeCommandError(
					"SESSION_RUNTIME_CHANGED",
					"Session runtime generation changed before command dispatch",
				);
			}
			const value = await operation(lease.agentId);
			if (!this.isCurrentDispatchLease(lease)) {
				throw new SessionRuntimeCommandError(
					"SESSION_RUNTIME_CHANGED",
					"Session runtime binding changed during command dispatch",
				);
			}
			return {
				ok: true,
				value: {
					target: {
						sessionId: lease.sessionId,
						agentId: lease.agentId,
						runtimeGeneration: lease.runtimeGeneration,
					},
					value,
				},
			};
		} catch (error) {
			return this.commandFailure(error);
		} finally {
			if (lease) this.releaseDispatchLease(lease);
		}
	}

	/**
	 * pi 历史会话文件改写：DSH / 未落盘 / 仍在运行一律拒绝。
	 * 运行中改文件再 switch_session 会和用户「先停再改、下次发送才激活」的产品规则冲突。
	 */
	private async mutateCatalogMessage(
		sessionId: string,
		messageId: string,
		operation: "edit" | "delete" | "resend",
		newText?: string,
		/** 渲染层消息的文件条目 id（meta.entryId），见 readMessageByMessageId 的锚点语义。 */
		entryId?: string,
	): Promise<SessionCommandResult<{ text: string; images?: ImageContent[] } | undefined>> {
		try {
			const entry = this.catalog.get(sessionId);
			if (!entry) {
				throw new SessionRuntimeCommandError(
					"SESSION_NOT_FOUND",
					`Session not found: ${sessionId}`,
				);
			}
			if (entry.backend === "dsh" || entry.backend === "imagegen") {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`backend "${entry.backend}" does not support persisted session message mutation`,
				);
			}
			if (!entry.filePath) {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					"Session not persisted",
				);
			}
			this.requireStoppedForFileMutation(sessionId);
			// 必须对象调用：抽方法会丢掉 this，CompositeAgentGateway 里 this.resolveBackend 变 undefined。
			// mutate 合法返回值可以是 undefined（edit/delete），所以不能用返回值判断方法是否存在。
			if (typeof this.agents.mutatePersistedSessionMessage !== "function") {
				throw new SessionRuntimeCommandError(
					"SESSION_COMMAND_FAILED",
					`backend "${this.agents.backend}" does not support persisted session message mutation`,
				);
			}
			const value = await this.agents.mutatePersistedSessionMessage(entry.filePath, messageId, operation, {
				newText,
				environment: entry.environment,
				wslDistro: entry.wslDistro,
				entryId,
			});
			// 写文件期间若被重新激活，磁盘已改但内存是旧树——拒绝让调用方感知竞态。
			this.requireStoppedForFileMutation(sessionId);
			void this.logger?.info("session-runtime", "Catalog session message mutated", {
				sessionId,
				messageId,
				operation,
			});
			return { ok: true, value };
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	private requireStoppedForFileMutation(sessionId: string): void {
		if (this.getTarget(sessionId) || this.isActivating(sessionId)) {
			throw new SessionRuntimeCommandError(
				"SESSION_RUNTIME_BUSY",
				"Stop the running agent before mutating the session file",
			);
		}
	}

	private commandFailure<T>(error: unknown): SessionCommandResult<T> {
		if (error instanceof SessionRuntimeCommandError) {
			return {
				ok: false,
				error: { code: error.code, debugDetails: error.message },
			};
		}
		// 模型在本地 models.json 存在但运行中 Agent 未加载：标记 needsRestart，
		// 渲染层据此弹出「重启 Agent 生效」引导（而非误报会话不存在）。
		if (error instanceof Error && (error as Error & { needsRestart?: boolean }).needsRestart) {
			return {
				ok: false,
				error: {
					code: "SESSION_MODEL_NOT_FOUND",
					debugDetails: error.message,
					needsRestart: true,
					// 提取 "Model not found: xxx" 中的模型标识，让 i18n 文案 {model} 有值
					params: { model: this.extractModelFromNotFound(error.message) ?? error.message },
				},
			};
		}
		const message = errorMessage(error);
		const lower = message.toLowerCase();
		const model = this.extractModelFromNotFound(message);
		const editorCode = this.sessionFileEditorErrorCode(error);
		const code: SessionCommandErrorCode =
			// SessionFileEditor 的 SESSION_ENTRY_NOT_FOUND 包括「不在活动分支」/
			// 「leaf 不在文件里」/「已删除」，文案并不都带 "message not found"。
			// 按 code 识别，避免历史会话删消息落到 SESSION_COMMAND_FAILED
			//（用户只看到「会话操作失败，请重试」且主进程没日志）。
			editorCode === "SESSION_ENTRY_NOT_FOUND"
				|| lower.includes("message not found")
				|| lower.includes("not found on the active session branch")
				|| lower.includes("not part of the active session branch")
				|| lower.includes("already been deleted")
				|| lower.includes("no longer present in the file")
				? "MESSAGE_NOT_FOUND"
				// Agent 运行实例已不存在（stop/restart 后立即操作、崩溃清理等）：是
				// 「没有可用的运行实例」而非「会话不存在」——泛化 not found 会误报成
				// 「会话已不存在，请刷新会话列表后重试」，用户刷新后依然复现（2026-08
				// 用户反馈：删除消息报会话已不存在）。
				: lower.includes("agent not found")
					? "SESSION_RUNTIME_UNAVAILABLE"
					// set_model 的 "Model not found: provider/model"（本地 models.json 也没有该模型，
					// 如手误/列表错位产生的假模型）是「模型不存在」而非「会话不存在」——
					// 若落到泛化 "not found" 分支会误报成「会话已不存在」误导排查。
					: lower.includes("model not found")
						? "SESSION_MODEL_NOT_FOUND"
						: lower.includes("not found")
							? "SESSION_NOT_FOUND"
							: lower.includes("busy") || lower.includes("in progress") || lower.includes("stream")
								? "SESSION_RUNTIME_BUSY"
								: lower.includes("binding") || lower.includes("generation") || lower.includes("changed")
									? "SESSION_RUNTIME_CHANGED"
									: lower.includes("runtime") && lower.includes("available")
										? "SESSION_RUNTIME_UNAVAILABLE"
										: "SESSION_COMMAND_FAILED";
		return {
			ok: false,
			error: {
				code,
				debugDetails: message,
				// 仅模型不存在类错误带 model 参数（i18n 文案占位）；其余错误不附加
				...(code === "SESSION_MODEL_NOT_FOUND" && model ? { params: { model } } : {}),
			},
		};
	}

	/**
	 * 从 "Model not found: <provider/model>" 类错误消息提取模型标识。
	 * 支持 "Model not found: xxx" / "model not found:xxx" 两种分隔；
	 * 未匹配返回 undefined（由调用方决定兜底）。
	 */
	private extractModelFromNotFound(message: string): string | undefined {
		const match = /model not found\s*:?\s*(.+)$/i.exec(message);
		return match?.[1]?.trim() || undefined;
	}

	/** SessionFileEditorError.code；非编辑器错误或缺字段返回 undefined。 */
	private sessionFileEditorErrorCode(error: unknown): string | undefined {
		if (!error || typeof error !== "object" || !("code" in error)) return undefined;
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" && code.startsWith("SESSION_") ? code : undefined;
	}

	private acquireDispatchLease(sessionId: string, agentId: string): DispatchLease {
		if (this.replacementBySession.has(sessionId) || this.replacementByAgent.has(agentId)) {
			throw new Error("Session runtime replacement is in progress");
		}
		const binding = this.getRuntimeBinding(agentId);
		if (!binding || binding.sessionId !== sessionId) {
			throw new Error("Session runtime binding changed before prompt dispatch");
		}
		const lease: DispatchLease = {
			...binding,
			agentId,
			leaseId: ++this.dispatchLeaseSequence,
		};
		this.addDispatchLease(this.dispatchLeasesBySession, sessionId, lease);
		this.addDispatchLease(this.dispatchLeasesByAgent, agentId, lease);
		return lease;
	}

	private addDispatchLease(
		leases: Map<string, Set<DispatchLease>>,
		key: string,
		lease: DispatchLease,
	): void {
		const current = leases.get(key) ?? new Set<DispatchLease>();
		current.add(lease);
		leases.set(key, current);
	}

	private releaseDispatchLease(lease: DispatchLease): void {
		for (const [leases, key] of [
			[this.dispatchLeasesBySession, lease.sessionId],
			[this.dispatchLeasesByAgent, lease.agentId],
		] as const) {
			const current = leases.get(key);
			if (!current) continue;
			current.delete(lease);
			if (current.size === 0) leases.delete(key);
		}
	}

	private isCurrentDispatchLease(lease: DispatchLease): boolean {
		if (
			!this.dispatchLeasesBySession.get(lease.sessionId)?.has(lease) ||
			!this.dispatchLeasesByAgent.get(lease.agentId)?.has(lease)
		) return false;
		const binding = this.getRuntimeBinding(lease.agentId);
		return Boolean(
			binding &&
			binding.sessionId === lease.sessionId &&
			binding.runtimeGeneration === lease.runtimeGeneration &&
			this.agentIdBySession.get(lease.sessionId) === lease.agentId
		);
	}

	private hasDispatchLease(sessionId?: string, agentId?: string): boolean {
		return Boolean(
			(sessionId && this.dispatchLeasesBySession.get(sessionId)?.size) ||
			(agentId && this.dispatchLeasesByAgent.get(agentId)?.size)
		);
	}

	private assertNoDispatchLease(sessionId?: string, agentId?: string): void {
		if (this.hasDispatchLease(sessionId, agentId)) {
			throw new Error("Session runtime prompt dispatch is in progress");
		}
	}

	private uiRequestKey(sessionId: string, requestId: string): string {
		return `${sessionId}\u0000${requestId}`;
	}

	private hasPendingUiRequest(sessionId: string, agentId: string): boolean {
		for (const pending of this.pendingUiRequests.values()) {
			if (pending.sessionId === sessionId && pending.agentId === agentId) return true;
		}
		return false;
	}

	private clearPendingUiRequests(sessionId: string, agentId?: string): void {
		for (const [key, pending] of this.pendingUiRequests) {
			if (pending.sessionId === sessionId && (!agentId || pending.agentId === agentId)) {
				this.pendingUiRequests.delete(key);
			}
		}
	}

	private pruneDeliveryCache(): void {
		const now = Date.now();
		for (const [key, entry] of this.deliveryByRequest) {
			if (entry.settled && now - entry.createdAt > DELIVERY_CACHE_TTL_MS) {
				this.deliveryByRequest.delete(key);
			}
		}
		if (this.deliveryByRequest.size <= DELIVERY_CACHE_MAX_ENTRIES) return;
		for (const [key, entry] of this.deliveryByRequest) {
			if (!entry.settled) continue;
			this.deliveryByRequest.delete(key);
			if (this.deliveryByRequest.size <= DELIVERY_CACHE_MAX_ENTRIES) break;
		}
	}

	private rejected(
		input: Pick<SendSessionPromptInput, "sessionId" | "requestId">,
		error: string,
		descriptor: I18nDescriptor = {
			i18nKey: "diagnostic.promptRejected",
			debugDetails: error,
		},
	): SendSessionPromptResult {
		return {
			accepted: false,
			delivery: "rejected",
			error,
			...descriptor,
			sessionId: input.sessionId,
			requestId: input.requestId,
		};
	}

	private unknownDelivery(
		input: Pick<SendSessionPromptInput, "sessionId" | "requestId">,
		error: string,
	): SendSessionPromptResult {
		return {
			accepted: false,
			delivery: "unknown",
			error,
			i18nKey: "diagnostic.promptDeliveryUnknown",
			debugDetails: error,
			sessionId: input.sessionId,
			requestId: input.requestId,
		};
	}
}
