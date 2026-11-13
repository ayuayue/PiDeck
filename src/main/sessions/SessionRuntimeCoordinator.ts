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
	SessionCommandResult,
	SessionMessageImageTarget,
	SessionRecord,
	SessionLocator,
	ProjectLocator,
	SessionModelPreference,
	SessionRuntimeEvent,
	SessionRuntimeInfo,
	SessionRuntimeModelSelection,
	SessionRuntimeReplacement,
	SessionRuntimeTarget,
	SessionTargetedValue,
	SessionUiResponseInput,
	AgentUiBatchQuestion,
} from "../../shared/types";
import { buildSessionOriginKey } from "../../shared/sessionIdentity";
// ssh locator 的窄类型只从 shared 取（与 catalog/项目域/引用审计同一份定义，不再抄一遍结构）。
import type { SshSessionLocator } from "../../shared/projectLocation";
import { descriptorFromThrownError } from "../../shared/errorI18n";
import { createSessionModelPreference } from "../../shared/modelDisplayName";
import { isRewindCheckpointId, isRewindRestoreScope } from "../../shared/types";
import type { SessionCatalogEntry } from "./SessionCatalog";
import { StoppedMessageIdentityCache } from "../pi/stoppedMessageIdentity";
import type { RemoteSessionMessageMutationResolver, SessionAgentGateway, SessionCatalogGateway, SessionProjectLocatorResolver, SessionRuntimeLogger } from "./runtime/sessionRuntimeGateways";

// 网关契约（catalog / agent / logger）搬进了 `runtime/sessionRuntimeGateways.ts`；
// 这里只作 re-export，调用方（AgentManager / DSH / ACP / CompositeAgentGateway…）的 import 路径不变。
export type { RemoteSessionMessageMutationResolver, SessionAgentGateway, SessionCatalogGateway, SessionProjectLocatorResolver, SessionRuntimeLogger };
import { type AppliedSessionPreferences, SessionRuntimePreferences, snapshotPreferences } from "./runtime/sessionRuntimePreferences";
import { RemoteMessageMutation } from "./runtime/remoteMessageMutation";
import { RuntimeBinding } from "./runtime/runtimeBinding";
import { SessionRuntimeCommandError } from "./runtime/sessionRuntimeCommandError";

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
	batchQuestions?: AgentUiBatchQuestion[];
	batchReview?: boolean;
};

type PendingUiRequest = PendingUiRequestSnapshot;

export type SessionRuntimeBinding = {
	sessionId: string;
	agentId: string;
	runtimeGeneration: number;
};

/**
 * coordinator 自己发起的解绑必须让渲染层知道（主进程注入 `emitSessionRuntimeDetach`）。
 * 只服务「终态惰性解绑」：stop/restart/删除/fork 换绑的解绑由调用方推送 detach，
 * 这里重复推会打乱渲染层的代际判定（`SessionRuntimeEvent` 的 detach 分支）。
 */
export type SessionRuntimeDetachNotifier = (binding: SessionRuntimeBinding) => void;

type RuntimeReplacement = SessionRuntimeBinding & {
	replacementId: number;
};

type DispatchLease = SessionRuntimeBinding & {
	leaseId: number;
};

const DELIVERY_CACHE_TTL_MS = 10 * 60_000;
const DELIVERY_CACHE_MAX_ENTRIES = 500;
const AGENT_READY_TIMEOUT_MS = 60_000;
/** 删除前等 agent 进程退出的上限：超时也放行删除，由扫描层重试与结构化错误兜底。 */
const DELETE_STOP_TIMEOUT_MS = 3000;
/**
 * fork/clone/restart 等「换绑运行时」命令等待瞬态 dispatch lease 释放的上限。
 * lease 的持有者通常是一次只读 target 命令（远端 get_state/模型/命令预览，毫秒到 1–2s），
 * 所以取 5s：足够覆盖远端 RTT，又不至于让真·在途 prompt 把用户卡太久（超时后仍按原语义硬失败）。
 */
const REPLACEMENT_LEASE_GRACE_MS = 5000;

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
	return method === "select" || method === "confirm" || method === "input" || method === "editor" || method === "batch_ask";
}

export class SessionRuntimeCoordinator {
	private readonly activationBySession = new Map<string, Promise<AgentTab>>();
	/** SSH live ID 不能在远端文件中直接定位；停止前只留受限摘要（32 会话 × 256 消息），不留正文。 */
	private readonly remoteStoppedMessageIdentities = new StoppedMessageIdentityCache();
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
	private readonly promptSubmittedListeners = new Set<(input: { sessionId: string; requestId: string }) => void>();
	/** 正在删除的会话：先解绑再异步停 agent，禁止激活/bind 把运行时写回 catalog。 */
	private readonly deletingSessions = new Set<string>();
	/**
	 * 草稿期被用户切换后端/ACP 工具作废的进行中激活。
	 *
	 * ACP 激活要等一整个握手（可达数秒）。旧行为是等它绑完再看 catalog——用户为了换个后端
	 * 得干等握手结束或失败，且迟到 bind 会把旧后端的进程（连同 acpSessionId）写进已经切走的会话。
	 * 处理中的取消靠这个集合在 bind 检查点生效；`cancelledActivationReports` 留到下次激活，
	 * 供 IPC 区分「被切换作废」与「真的启动失败」（后者才要弹错误态）。
	 */
	private readonly cancelledActivations = new Set<string>();
	private readonly cancelledActivationReports = new Set<string>();
	/**
	 * 上次成功应用到该会话当前 agent 的偏好。catalog.get 返回 clone，activate 开头的
	 * 快照会过期；预热绑定后用户仍可改模型。用这份记录跳过「catalog 没变」的重复
	 * setModel，保住并发 send / 历史 attach / 懒启动 publish 的 setModel==1 约束。
	 * agentId 必须纳入：新进程（restart）即使 catalog 没变也要再应用。
	 */
	private readonly lastAppliedBySession = new Map<
		string,
		{
			agentId: string;
			preferences: AppliedSessionPreferences;
		}
	>();
	/** Serializes model/effort changes so a slower earlier get_state cannot overwrite a newer choice. */
	private readonly preferenceMutationTails = new Map<string, Promise<void>>();
	private readonly lastRequestedThinkingBySession = new Map<string, { agentId: string; level: string }>();
	/** 偏好重放/降级（模型 / 思考档 / 权限预设）的协作对象；见 `runtime/sessionRuntimePreferences.ts`。 */
	private readonly preferences: SessionRuntimePreferences;
	/** catalog 级消息变更与命令失败分类的协作对象；见 `runtime/remoteMessageMutation.ts`。 */
	private readonly messageMutation: RemoteMessageMutation;
	/** 绑定表读取与代数（stale 拒绝）判定的协作对象；见 `runtime/runtimeBinding.ts`。 */
	private readonly bindings: RuntimeBinding;
	private detachedNotifier: SessionRuntimeDetachNotifier | undefined;

	constructor(
		private readonly catalog: SessionCatalogGateway,
		private readonly agents: SessionAgentGateway,
		private readonly sendAgentPrompt: (input: SendPromptInput) => Promise<SendPromptResult>,
		private readonly logger?: SessionRuntimeLogger,
		private readonly resolveProjectLocator?: SessionProjectLocatorResolver,
		private readonly resolveRemoteMessageMutation?: RemoteSessionMessageMutationResolver,
	) {
		this.preferences = new SessionRuntimePreferences(this.catalog, this.agents, this.logger, (sessionId) => this.isRemoteSession(sessionId), this.lastAppliedBySession, this.lastRequestedThinkingBySession);
		this.messageMutation = new RemoteMessageMutation(
			this.catalog,
			this.agents,
			this.logger,
			this.resolveRemoteMessageMutation,
			this.remoteStoppedMessageIdentities,
			(sessionId) => this.canonicalSessionId(sessionId),
			(sessionId) => this.getTarget(sessionId),
			(sessionId) => this.isActivating(sessionId),
		);
		this.bindings = new RuntimeBinding(this.catalog, this.sessionIdByAgent, this.agentIdBySession, this.generationBySession);
	}

	/** 偏好重放留在宿主：调用点（激活/重启/换绑）只认这个方法名，实现见协作对象。 */
	private applyLatestPreferences(sessionId: string, agentId: string): Promise<boolean> {
		return this.preferences.applyLatestPreferences(sessionId, agentId);
	}

	/** 渲染层在 currentSessionId 变化时汇报聚焦会话（见 sessions:set-focused-session IPC）。 */
	setFocusedSession(sessionId: string | undefined): void {
		this.focusedSessionId = sessionId;
		// 聚焦切换高频发生（点列表即触发），用 debug 级别避免刷屏
		void this.logger?.info("session-runtime", "Focused session changed", { sessionId });
	}

	getFocusedSession(): string | undefined {
		return this.focusedSessionId;
	}

	/**
	 * 订阅「有消息提交到某会话」：渲染层、Web 端、飞书 / 微信桥、自动化、宿主内部转发都经 send，
	 * 订阅者据 requestId 自行区分来源。只在通过入参校验后、投递（激活运行时）之前同步触发一次。
	 */
	onPromptSubmitted(listener: (input: { sessionId: string; requestId: string }) => void): () => void {
		this.promptSubmittedListeners.add(listener);
		return () => {
			this.promptSubmittedListeners.delete(listener);
		};
	}

	send(input: SendSessionPromptInput): Promise<SendSessionPromptResult> {
		const sessionId = input.sessionId.trim();
		const requestId = input.requestId.trim();
		if (!sessionId) return Promise.resolve(this.rejected(input, "Session ID is required"));
		if (!requestId) return Promise.resolve(this.rejected(input, "Request ID is required"));
		if (!input.message.trim() && !input.images?.length) {
			return Promise.resolve(
				this.rejected(input, "消息不能为空", {
					i18nKey: "diagnostic.messageRequired",
				}),
			);
		}
		for (const listener of this.promptSubmittedListeners) {
			try {
				listener({ sessionId: this.canonicalSessionId(sessionId), requestId });
			} catch {
				// 订阅者失败不能挡住用户的消息
			}
		}

		this.pruneDeliveryCache();
		// #354：渲染层可能还抱着已被身份归并的历史会话 ID。投递去重与后续整个状态机
		// （activation gate / dispatch lease / catalog attach）必须统一用现存 ID，否则同一
		// requestId 经别名与现存 ID 各投递一次，且 acquireDispatchLease 会在旧 ID 上失败。
		const canonicalSessionId = this.canonicalSessionId(sessionId);
		const cacheKey = `${canonicalSessionId}\u0000${requestId}`;
		const existing = this.deliveryByRequest.get(cacheKey);
		if (existing) return existing.promise;

		const cacheEntry: DeliveryCacheEntry = {
			createdAt: Date.now(),
			settled: false,
			promise: Promise.resolve(this.rejected(input, "Request was not started")),
		};
		cacheEntry.promise = this.sendOnce({ ...input, sessionId: canonicalSessionId, requestId }).finally(() => {
			cacheEntry.settled = true;
		});
		this.deliveryByRequest.set(cacheKey, cacheEntry);
		return cacheEntry.promise;
	}

	/**
	 * catalog 外部删除清理的活性探针（纯查询，无 getAgentId 的终态解绑副作用）：
	 * 绑定存在且 agent 未到终态即视为活会话——pi 在首条消息前可能尚未创建 session
	 * 文件（预热激活后空闲进程甚至长期不写盘），「运行时还在、文件暂时不在」不能
	 * 当成外部删除（2026-10-05：预热 attach 同秒扫描剔掉记录 → 闪回引导页、
	 * 输入草稿丢失、发送另起新进程）。
	 */
	hasLiveRuntime(sessionId: string): boolean {
		const canonicalSessionId = this.canonicalSessionId(sessionId);
		const agentId = this.agentIdBySession.get(canonicalSessionId);
		if (!agentId) return false;
		const tab = this.agents.list().find((candidate) => candidate.id === agentId);
		if (!tab) return false;
		if (!isTerminalAgent(tab)) return true;
		// 与 getAgentId 同口径：回复级错误（Issue #218）的进程仍活着、待用户答问时同样保护。
		return tab.status === "error" && this.hasPendingUiRequest(canonicalSessionId, agentId);
	}

	getAgentId(sessionId: string): string | undefined {
		const canonicalSessionId = this.canonicalSessionId(sessionId);
		const agentId = this.agentIdBySession.get(canonicalSessionId);
		if (!agentId) return undefined;
		const tab = this.agents.list().find((candidate) => candidate.id === agentId);
		if (tab && !isTerminalAgent(tab)) return agentId;
		// pi may emit an interactive recovery request immediately before reporting
		// an error. Keep that runtime addressable until the user answers the request.
		if (tab?.status === "error" && this.hasPendingUiRequest(canonicalSessionId, agentId)) return agentId;
		// Issue #218：回复级错误（API 400/模型报错/投递未知）不会杀进程。error 终态
		// 但进程仍存活时先复活（error → idle），让激活/发送复用原进程，而不是在此
		// 解绑后走 stop+create 重建——重建在扩展有问题时还会触发无插件回退。
		if (tab?.status === "error" && this.reviveTerminalAgent(agentId)) return agentId;
		// A terminal process cannot safely receive a delayed prompt result. Remove
		// the binding even if its dispatch lease has not unwound yet, which makes
		// that result fail closed instead of reviving a dead runtime association.
		//
		// 这条解绑发生在查询路径里（读历史/翻页、空闲释放器的聚焦探针都会走到），
		// 必须把解绑推送出去：之前静默丢绑定，渲染层快照就永远停在 error——红点常亮、
		// 「关闭 Agent」对着一个已不存在的运行实例反复失败（2026-10 实测日志的根因）。
		const binding = this.getRuntimeBinding(agentId);
		this.unbindTerminalAgent(agentId);
		// getRuntimeBinding 只回 sessionId/generation（不包含 agentId），解绑通知要把身份补全。
		if (binding) this.notifyRuntimeDetached({ ...binding, agentId });
		return undefined;
	}

	/**
	 * 注入 detach 通知（主进程 `emitSessionRuntimeDetach`）。见 `SessionRuntimeDetachNotifier`。
	 */
	setDetachedNotifier(notifier: SessionRuntimeDetachNotifier | undefined): void {
		this.detachedNotifier = notifier;
	}

	/**
	 * 推送解绑通知。这里吞异常并留 warn：解绑发生在查询路径中（历史读取等 IPC 会走到），
	 * 推送失败不能连带让用户的读盘请求失败——渲染层下次激活时仍会用新绑定自然收敛。
	 */
	private notifyRuntimeDetached(binding: SessionRuntimeBinding): void {
		if (!this.detachedNotifier) return;
		try {
			this.detachedNotifier(binding);
		} catch (error) {
			void this.logger?.warn("session-runtime", "Runtime detach notification failed", { ...binding, error: errorMessage(error) });
		}
	}

	getSessionId(agentId: string): string | undefined {
		return this.sessionIdByAgent.get(agentId);
	}

	/**
	 * 进程监控用：按 agentId 反查会话身份（sessionId + 标题）。
	 * 标题取 catalog 条目，供监控表直接展示「是哪个会话」；
	 * 无绑定或 catalog 无记录时返回 undefined（匿名/终端 agent 不关联会话）。
	 */
	getSessionInfoForAgent(agentId: string): { sessionId: string; sessionTitle?: string } | undefined {
		const sessionId = this.sessionIdByAgent.get(agentId);
		if (!sessionId) return undefined;
		const entry = this.catalog.get(sessionId);
		return { sessionId, sessionTitle: entry?.title };
	}

	/**
	 * 会话级模型目录分流用的窄接口：这条会话是否属于远端主机。
	 *
	 * 与 getTarget 的分工：getTarget 回答「现在有没有活进程」，本方法回答「该归谁回答模型目录」——
	 * 远端会话即使尚未激活也不得回退到本机目录（否则用户选到的模型远端根本不存在），
	 * 因此未激活时返回 true，由调用方给「remote-inactive」而不是本机列表。
	 */
	isRemoteSession(sessionId: string): boolean {
		const canonicalSessionId = this.canonicalSessionId(sessionId);
		const entry = this.catalog.get(canonicalSessionId);
		if (!entry) return false;
		return this.remoteHostIdForSession(entry.projectId, entry.locator) !== undefined;
	}

	/**
	 * 这条会话的 runtime 在哪台机器上（undefined = 本机）。
	 *
	 * 判据顺序：**条目自己的 locator 优先**（有 locator 的条目，位置真相就是它 —— 与之前逐字一致，
	 * 包括 local locator 在远端项目里这种错位形态）；没有 locator（新建草稿）才问项目位置。
	 * 远端会话在 pi 上报会话文件之前没有任何本地字段能承载它的位置，项目位置是那个窗口里唯一可信
	 * 的判据。
	 */
	private remoteHostIdForSession(projectId: string, locator: SessionLocator | undefined): string | undefined {
		if (locator) return locator.kind === "ssh" ? locator.hostId : undefined;
		const projectLocator = this.resolveProjectLocator?.(projectId);
		return projectLocator?.kind === "ssh" ? projectLocator.hostId : undefined;
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

	/**
	 * 会话的 runtime 目标（会话身份 ↔ 运行实例的稳定地址）。
	 *
	 * 这里**不再**对 ssh 条目返回 undefined：那个跳过分支写于「远端会话只存在于侧栏、不可能有 runtime」
	 * 的时候（P4.2 协议层批次）。远端 runtime 现在是真实 runtime，把它挡在 getTarget 之外会让
	 * `activateRuntime` 自己拿不到自己的 runtime（runtimeInfo 要求 target）、侧栏也看不到运行中的远端
	 * 会话。本机专属操作有更精确的守卫（`SessionCatalog.getLocalFilePath` 对 ssh 抛稳定码、
	 * `AgentManager.assertLocalRuntimeOperation` 逐操作拒绝），不需要在这里按 locator 一刀切。
	 */
	getTarget(sessionId: string): SessionRuntimeTarget | undefined {
		const canonicalSessionId = this.canonicalSessionId(sessionId);
		const agentId = this.getAgentId(canonicalSessionId);
		if (!agentId) return undefined;
		const binding = this.getRuntimeBinding(agentId);
		if (!binding || binding.sessionId !== canonicalSessionId) return undefined;
		return { sessionId: canonicalSessionId, agentId, runtimeGeneration: binding.runtimeGeneration };
	}

	/** A pending activation owns the Session even before AgentManager binding completes. */
	isActivating(sessionId: string): boolean {
		return this.activationBySession.has(this.canonicalSessionId(sessionId));
	}

	/** 最近一次激活是否被 {@link cancelActivation} 作废（下次激活开始时清空）。 */
	isActivationCancelled(sessionId: string): boolean {
		return this.cancelledActivationReports.has(this.canonicalSessionId(sessionId));
	}

	/**
	 * 作废这条会话进行中的激活（换后端 / 换 ACP 工具的专用出口）。
	 *
	 * 为什么不能交给「改完 catalog 再让激活自己发现」：ACP 预热是一次完整握手（npx 拉包 + 会话
	 * 创建，秒级），用户改完后端后既不想等它握手完、也不该收下它的迟到绑定。所以这里主动做四件事：
	 * 1. 标记取消，`activate` 的 bind 检查点据此拒绑（否则记录已切走，运行时还挂在旧后端进程上）；
	 * 2. 停掉已 spawn 的启动中进程——只等它自然结束的话用户仍要等握手超时；
	 * 3. 等激活 promise 收敛，保证本方法返回时不会再有后续副作用；
	 * 4. 收尾：激活在信号之前已越过检查点时会留下绑定，解绑并停掉（迟到绑定不得存活）。
	 */
	async cancelActivation(sessionId: string): Promise<void> {
		const canonicalSessionId = this.canonicalSessionId(sessionId);
		this.cancelledActivations.add(canonicalSessionId);
		// 报告留到下次激活：IPC 失败分支要据此区分「被切换取消」和真正的启动失败。
		this.cancelledActivationReports.add(canonicalSessionId);
		try {
			const starting = this.agents.list().find((tab) => tab.deckSessionId === canonicalSessionId && tab.status === "starting");
			if (starting) await this.agents.stop(starting.id).catch(() => undefined);
			const activating = this.activationBySession.get(canonicalSessionId);
			if (activating) await activating.catch(() => undefined);
			const target = this.getTarget(canonicalSessionId);
			if (target) {
				this.unbindAgentUnchecked(target.agentId);
				await this.agents.stop(target.agentId).catch(() => undefined);
				void this.logger?.info("session-runtime", "Late runtime binding dropped after activation cancel", { sessionId: canonicalSessionId, agentId: target.agentId });
			}
		} finally {
			this.cancelledActivations.delete(canonicalSessionId);
		}
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
		const normalizedSessionId = this.canonicalSessionId(sessionId.trim());
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
	 * 删除前强制释放运行时：先解绑让侧栏立刻可删，再停进程并等它真的退出。
	 * 运行中会话也允许删——用户不必先点停止。停进程失败/超时也不挡 catalog 删除。
	 */
	async releaseRuntimeForDelete(sessionId: string): Promise<void> {
		const requestedSessionId = this.canonicalSessionId(sessionId);
		this.deletingSessions.add(requestedSessionId);
		const activating = this.activationBySession.get(requestedSessionId);
		if (activating) await activating.catch(() => undefined);
		// 先读原始映射：getTarget 会把 error/closed 当终态解绑，
		// 失败一次卡在 error 的会话也必须先解绑再杀进程。
		const mappedAgentId = this.agentIdBySession.get(requestedSessionId);
		const mappedGeneration = mappedAgentId ? (this.getRuntimeBinding(mappedAgentId)?.runtimeGeneration ?? 0) : 0;
		const liveTarget = this.getTarget(requestedSessionId);
		const target = liveTarget ?? (mappedAgentId ? { sessionId: requestedSessionId, agentId: mappedAgentId, runtimeGeneration: mappedGeneration } : undefined);
		// 会话删除 = 代数作废：generationBySession 按 sessionId 累积且仅随删除回收，
		// 否则反复创建/删除会话会让键集无界增长（2026 内存排查：慢泄漏）。
		// 注意不能放到 unbindAgentUnchecked：restart 流程 unbind 旧 agent 后要
		// bind 新 agent 并代数 +1，提前删会导致旧 runtime 的迟到结果被误接受。
		this.generationBySession.delete(requestedSessionId);
		if (!target) {
			this.deletingSessions.delete(requestedSessionId);
			return;
		}
		this.unbindAgentUnchecked(target.agentId);
		// 先解绑（侧栏立刻可删），但停进程必须等到真的退出：pi 还握着会话文件句柄时，
		// 后续 shell.trashItem 会失败（issue #364）。等待有上限，超时放行。
		try {
			await this.stopForDelete(target.agentId);
		} finally {
			this.deletingSessions.delete(requestedSessionId);
		}
	}

	/**
	 * 删除路径的停进程收尾：有等待能力的网关必须等进程真正退出再返回。
	 * 老网关（或 DSH 这类无进程池实现）退回只发 stop，超时也不挡删除。
	 */
	private async stopForDelete(agentId: string): Promise<void> {
		const stopAndWait = this.agents.stopAndWaitForExit;
		if (typeof stopAndWait !== "function") {
			await this.agents.stop(agentId).catch(() => undefined);
			return;
		}
		let exited = false;
		try {
			exited = await stopAndWait.call(this.agents, agentId, DELETE_STOP_TIMEOUT_MS);
		} catch {
			exited = false;
		}
		if (!exited) {
			void this.logger?.warn("session-runtime", "Agent exit timed out before session delete", { agentId, timeoutMs: DELETE_STOP_TIMEOUT_MS });
		}
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

	async activateRuntime(sessionId: string): Promise<SessionCommandResult<SessionRuntimeInfo>> {
		// #354：别名归一化必须覆盖返回值构造——ensureRuntime 内部归一化只保证 runtime 建在
		// 现存 ID 上，runtimeInfo 仍拿旧 ID 查询就会误报 SESSION_RUNTIME_CHANGED。
		const canonicalSessionId = this.canonicalSessionId(sessionId);
		try {
			const tab = await this.ensureRuntime(canonicalSessionId);
			const resolvedSessionId = this.canonicalSessionId(canonicalSessionId);
			if (resolvedSessionId !== canonicalSessionId) {
				// attach/扫描可在 activate 的 await 期间归并 catalog 身份。沿别名再走既有激活链路，
				// 让 bind 把同一 agent 从旧 ID 迁到现存 ID，而不是留下旧绑定后报 SESSION_RUNTIME_CHANGED。
				return this.activateRuntime(resolvedSessionId);
			}
			void this.logger?.info("session-runtime", "Runtime activated", {
				sessionId: canonicalSessionId,
				agentId: tab.id,
				status: tab.status,
			});
			return { ok: true, value: this.runtimeInfo(canonicalSessionId, tab) };
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
		const canonicalSessionId = this.canonicalSessionId(sessionId);
		const entry = this.catalog.get(canonicalSessionId);
		if (!entry?.noSession) throw new Error(`Anonymous session not found: ${canonicalSessionId}`);
		const tab = this.agents.list().find((candidate) => candidate.id === agentId);
		if (!tab?.noSession || isTerminalAgent(tab)) {
			throw new Error(`Anonymous runtime is not available: ${agentId}`);
		}
		const runtimeGeneration = this.bind(canonicalSessionId, agentId);
		tab.runtimeGeneration = runtimeGeneration;
		void this.logger?.info("session-runtime", "Anonymous runtime bound", {
			sessionId: canonicalSessionId,
			agentId,
			runtimeGeneration,
		});
		return this.runtimeInfo(canonicalSessionId, tab);
	}

	validateTarget(target: SessionRuntimeTarget): SessionCommandResult<SessionRuntimeTarget> {
		try {
			const canonical = this.canonicalTarget(target);
			this.requireTarget(canonical);
			return { ok: true, value: canonical };
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	renameRuntime(target: SessionRuntimeTarget, name: string): Promise<SessionCommandResult<SessionTargetedValue<AgentTab>>> {
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

	abortRuntime(target: SessionRuntimeTarget): Promise<SessionCommandResult<SessionTargetedValue<void>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.abort(agentId));
	}

	compactRuntime(target: SessionRuntimeTarget, prompt?: string): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.compact(agentId, prompt));
	}

	getRuntimeState(target: SessionRuntimeTarget): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.getRuntimeState(agentId));
	}

	listRuntimeCommands(target: SessionRuntimeTarget): Promise<SessionCommandResult<SessionTargetedValue<PiCommand[]>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// 命令列表是可选能力：后端未声明 getCommands 时按能力缺失拒绝（UI 应已按能力隐藏入口）。
			// 必须对象调用：抽成 const fn = this.agents.fn 会丢掉 this（CompositeAgentGateway.resolveBackend 崩）。
			if (typeof this.agents.getCommands !== "function") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${this.agents.backend}" does not support getCommands`);
			}
			return (await this.agents.getCommands(agentId)) as PiCommand[];
		});
	}

	/**
	 * 热重载 pi 资源（扩展/技能/提示词/主题/上下文文件）。
	 * 与 `listRuntimeCommands` 同为会话内命令，但会改动扩展运行时，因此只对 live idle
	 * 进程开放；DSH/ACP 没有对应能力，UI 按 backend 隐藏入口。
	 */
	reloadResources(target: SessionRuntimeTarget): Promise<SessionCommandResult<SessionTargetedValue<PiCommand[]>>> {
		return this.runTargetCommand(target, async (agentId) => {
			if (typeof this.agents.reloadResources !== "function") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${this.agents.backend}" does not support reloadResources`);
			}
			return this.agents.reloadResources(agentId);
		});
	}

	listRuntimeModels(target: SessionRuntimeTarget): Promise<SessionCommandResult<SessionTargetedValue<AvailableModel[]>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.getAvailableModels(agentId));
	}

	/**
	 * 草稿会话（尚无 runtime）的斜杠命令预览：只读借用 pi standby 进程的命令表。
	 * 可选能力缺失/查询失败一律返回 null——这是“提示增强”而非命令执行链路，
	 * 不能让预览失败影响草稿会话本身。
	 */
	async draftCommands(projectId: string): Promise<PiCommand[] | null> {
		if (typeof this.agents.draftCommands !== "function") return null;
		try {
			return await this.agents.draftCommands(projectId);
		} catch {
			return null;
		}
	}

	listRuntimeThinkingLevels(target: SessionRuntimeTarget): Promise<SessionCommandResult<SessionTargetedValue<string[] | undefined>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// DSH does not own this Pi-specific RPC; callers use its host catalog instead.
			if (typeof this.agents.getAvailableThinkingLevels !== "function") return undefined;
			return this.agents.getAvailableThinkingLevels(agentId);
		});
	}

	exportRuntimeHtml(target: SessionRuntimeTarget): Promise<SessionCommandResult<SessionTargetedValue<unknown>>> {
		return this.runTargetCommand(target, async (agentId) => {
			if (typeof this.agents.exportHtml !== "function") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${this.agents.backend}" does not support exportHtml`);
			}
			return this.agents.exportHtml(agentId);
		});
	}

	listRewindCheckpoints(target: SessionRuntimeTarget, params?: RewindCheckpointPageParams): Promise<SessionCommandResult<SessionTargetedValue<RewindCheckpointPage>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// rewind 是可选能力：后端未实现 listCheckpoints 时按能力缺失拒绝（UI 应已按能力隐藏入口）。
			if (typeof this.agents.listCheckpoints !== "function") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${this.agents.backend}" does not support rewind checkpoints`);
			}
			return this.agents.listCheckpoints(agentId, params);
		});
	}

	getRewindCheckpointDiff(target: SessionRuntimeTarget, checkpointId: unknown): Promise<SessionCommandResult<SessionTargetedValue<string>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// 渲染层入参不可信：checkpointId 会拼进 ref 名，必须过安全字符校验。
			if (!isRewindCheckpointId(checkpointId)) {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `Invalid rewind checkpoint id: ${String(checkpointId)}`);
			}
			if (typeof this.agents.getCheckpointDiff !== "function") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${this.agents.backend}" does not support rewind diffs`);
			}
			return this.agents.getCheckpointDiff(agentId, checkpointId);
		});
	}

	restoreRewindCheckpoint(target: SessionRuntimeTarget, checkpointId: unknown, scope: unknown): Promise<SessionCommandResult<SessionTargetedValue<RewindRestoreResult>>> {
		return this.runTargetCommand(target, async (agentId) => {
			// 渲染层入参不可信：scope 必须落在契约枚举内，checkpointId 必须过安全字符校验。
			if (!isRewindCheckpointId(checkpointId)) {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `Invalid rewind checkpoint id: ${String(checkpointId)}`);
			}
			if (!isRewindRestoreScope(scope)) {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `Invalid rewind restore scope: ${String(scope)}`);
			}
			if (typeof this.agents.restoreCheckpoint !== "function") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${this.agents.backend}" does not support rewind restore`);
			}
			return this.agents.restoreCheckpoint(agentId, checkpointId, scope);
		});
	}

	editRuntimeMessage(target: SessionRuntimeTarget, messageId: string, newText: string): Promise<SessionCommandResult<SessionTargetedValue<void>>> {
		return this.runTargetCommand(target, async (agentId) => {
			if (typeof this.agents.editMessage !== "function") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${this.agents.backend}" does not support editMessage`);
			}
			return this.agents.editMessage(agentId, messageId, newText);
		});
	}

	deleteRuntimeMessage(target: SessionRuntimeTarget, messageId: string): Promise<SessionCommandResult<SessionTargetedValue<void>>> {
		return this.runTargetCommand(target, async (agentId) => {
			if (typeof this.agents.deleteMessage !== "function") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${this.agents.backend}" does not support deleteMessage`);
			}
			return this.agents.deleteMessage(agentId, messageId);
		});
	}

	prepareRuntimeResend(target: SessionRuntimeTarget, messageId: string): Promise<SessionCommandResult<SessionTargetedValue<{ text: string; images?: ImageContent[] }>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.prepareResendFromMessage(agentId, messageId));
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

	/** 单图原地移除：沿用 catalog 文件事务，不 fork、不截断后续对话。 */
	removeCatalogMessageImage(sessionId: string, messageId: string, imageTarget: SessionMessageImageTarget, entryId?: string): Promise<SessionCommandResult<void>> {
		return this.mutateCatalogMessage(sessionId, messageId, "remove-image", undefined, entryId, imageTarget).then((result) => {
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
	getRuntimeForkMessages(target: SessionRuntimeTarget): Promise<SessionCommandResult<SessionTargetedValue<Array<{ entryId: string; text: string }>>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.getForkMessages(agentId));
	}

	/** 按 entryId 执行 pi /fork；成功后调用方需走 replaceAgentSession 刷新绑定。 */
	forkRuntimeSession(target: SessionRuntimeTarget, entryId: string): Promise<SessionCommandResult<SessionTargetedValue<unknown>>> {
		return this.runTargetCommand(target, (agentId) => this.agents.forkSession(agentId, entryId));
	}

	setRuntimeModel(target: SessionRuntimeTarget, provider: string, modelId: string, modelName?: string): Promise<SessionCommandResult<SessionTargetedValue<SessionRuntimeModelSelection>>> {
		return this.runTargetCommand(target, (agentId) =>
			this.serializePreferenceMutation(target.sessionId, async () => {
				this.requireBoundTarget(target);
				const existing = this.catalog.get(target.sessionId);
				const selectedModel = createSessionModelPreference(provider, modelId, modelName);
				const last = this.lastAppliedBySession.get(target.sessionId);
				const alreadyApplied = last?.agentId === agentId && last.preferences.model?.provider === provider && last.preferences.model.modelId === modelId;
				if (alreadyApplied && existing?.model?.modelName === selectedModel.modelName) return selectedModel;

				// Pi 自己按目标模型默认值、全局默认和当前档位选择实际强度；不要把旧档位再发回去。
				if (!alreadyApplied) {
					await this.agents.setModel(agentId, provider, modelId);
					this.lastRequestedThinkingBySession.delete(target.sessionId);
				}
				this.requireBoundTarget(target);
				const runtimeSelection = await this.agents.getRuntimeModelThinkingState?.(agentId);
				this.requireBoundTarget(target);
				const appliedModel = runtimeSelection ? createSessionModelPreference(runtimeSelection.provider, runtimeSelection.modelId, runtimeSelection.modelName) : selectedModel;
				const effectiveThinkingLevel = runtimeSelection?.thinkingLevel;
				const result: SessionRuntimeModelSelection = {
					...appliedModel,
					...(effectiveThinkingLevel !== undefined ? { thinkingLevel: effectiveThinkingLevel } : {}),
				};
				const updated = await this.catalog.update(target.sessionId, {
					model: appliedModel,
					...(effectiveThinkingLevel !== undefined ? { thinkingLevel: effectiveThinkingLevel } : {}),
					updatedAt: Date.now(),
				});
				this.lastAppliedBySession.set(target.sessionId, {
					agentId,
					preferences: snapshotPreferences(updated),
				});
				// 审计契约（tests/sessionLifecycleAudit.test.mjs）要求 provider/modelId 以简写
				// 字段出现；set_model 精确应用请求的 provider/id，另附 Pi 回报的名称与生效档位。
				void this.logger?.info("session-runtime", "Runtime model changed", {
					sessionId: target.sessionId,
					agentId,
					provider,
					modelId,
					modelName: appliedModel.modelName,
					thinkingLevel: effectiveThinkingLevel,
				});
				// 模型名称写回 catalog 不会更新圆环使用的 runtime 用量快照；切换确认后
				// 立即推送新窗口与占用率。刷新失败不撤销已生效的选择，迟到快照由网关丢弃。
				this.requireBoundTarget(target);
				await this.agents.publishRuntimeState(agentId).catch(() => undefined);
				return result;
			}),
		);
	}

	setRuntimeThinking(target: SessionRuntimeTarget, level: string): Promise<SessionCommandResult<SessionTargetedValue<{ thinkingLevel: string }>>> {
		return this.runTargetCommand(target, (agentId) =>
			this.serializePreferenceMutation(target.sessionId, async () => {
				this.requireBoundTarget(target);
				const lastRequest = this.lastRequestedThinkingBySession.get(target.sessionId);
				if (lastRequest?.agentId === agentId && lastRequest.level === level) {
					return { thinkingLevel: this.catalog.get(target.sessionId)?.thinkingLevel ?? level };
				}

				await this.agents.setThinking(agentId, level);
				this.requireBoundTarget(target);
				const runtimeSelection = await this.agents.getRuntimeModelThinkingState?.(agentId);
				this.requireBoundTarget(target);
				const effectiveThinkingLevel = runtimeSelection?.thinkingLevel ?? level;
				const updated = await this.catalog.update(target.sessionId, {
					thinkingLevel: effectiveThinkingLevel,
					updatedAt: Date.now(),
				});
				this.lastAppliedBySession.set(target.sessionId, {
					agentId,
					preferences: snapshotPreferences(updated),
				});
				this.lastRequestedThinkingBySession.set(target.sessionId, { agentId, level });
				void this.logger?.info("session-runtime", "Runtime thinking changed", {
					sessionId: target.sessionId,
					agentId,
					requestedLevel: level,
					thinkingLevel: effectiveThinkingLevel,
				});
				return { thinkingLevel: effectiveThinkingLevel };
			}),
		);
	}

	/**
	 * Apply a DSH permission preset through the active runtime command path.
	 * The preset is persisted only after the host accepts it, so catalog state
	 * cannot claim a restricted mode while the live host is still unrestricted.
	 */
	setRuntimePermission(target: SessionRuntimeTarget, preset: string): Promise<SessionCommandResult<SessionTargetedValue<AgentRuntimeState>>> {
		return this.runTargetCommand(target, async (agentId) => {
			if (typeof this.agents.setPermission !== "function") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${this.agents.backend}" does not support permissions`);
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

	async stopRuntime(target: SessionRuntimeTarget): Promise<SessionCommandResult<SessionRuntimeTarget>> {
		let reservation: RuntimeReplacement | undefined;
		try {
			// 停止以「活着的进程」为准：定时任务草稿会话被扫描合并 remap 后，渲染层可能
			// 仍持有旧 sessionId/generation。只要 agentId 仍有 live 绑定，就用 live 绑定
			// 规范化目标，别让陈旧身份挡住停止（此前用户只能靠重启停掉后台 Agent）。
			const stopTarget = this.resolveStopTarget(target);
			// 停止必须永远可行：在途 prompt 回合的 dispatch lease 覆盖整个回合（ACP 长任务或
			// 卡死的 agent 会让 lease 挂到超时甚至永不释放），不该挡住杀进程——那正是用户唯一
			// 的恢复出口。跳过 lease 等待与断言，直接占 replacement 槽（新 dispatch 会被
			// acquireDispatchLease 的 replacement 检查拒绝），dispatch 侧对「stop 期间回合死亡」
			// 已有 unknownDelivery 收尾路径。
			reservation = this.reserveBoundRuntime(stopTarget.sessionId, stopTarget.agentId, { ignoreDispatchLease: true });
			const locator = this.catalog.getLocator(stopTarget.sessionId);
			if (locator?.kind === "ssh") {
				// stop 会销毁 gateway 消息缓存；必须在它之前捕获，且不能把远端路径交给本机 fs。
				this.remoteStoppedMessageIdentities.capture(this.remoteMessageIdentityKey(locator), this.agents.getMessages(stopTarget.agentId));
			}
			await this.agents.stop(stopTarget.agentId);
			this.requireCurrentReservation(reservation);
			this.releaseRuntimeReplacement(reservation);
			reservation = undefined;
			this.unbindAgentUnchecked(stopTarget.agentId);
			void this.logger?.info("session-runtime", "Runtime stopped", {
				sessionId: stopTarget.sessionId,
				agentId: stopTarget.agentId,
				runtimeGeneration: stopTarget.runtimeGeneration,
				// 渲染层原始目标仅入日志，便于排查「停止报会话不存在」类反馈。
				requestedSessionId: target.sessionId,
			});
			return { ok: true, value: stopTarget };
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
	async stopAgentById(agentId: string): Promise<SessionCommandResult<SessionRuntimeTarget | undefined>> {
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

	async restartRuntime(target: SessionRuntimeTarget): Promise<SessionCommandResult<SessionRuntimeReplacement>> {
		try {
			const canonical = this.canonicalTarget(target);
			this.requireTarget(canonical);
			const tab = await this.restartSession(canonical.sessionId, canonical.agentId);
			const session = this.catalog.getRecord(canonical.sessionId);
			if (!session) {
				throw new SessionRuntimeCommandError("SESSION_NOT_FOUND", "Session no longer exists");
			}
			void this.logger?.info("session-runtime", "Runtime restarted", {
				sessionId: canonical.sessionId,
				agentId: canonical.agentId,
				runtimeGeneration: canonical.runtimeGeneration,
			});
			return {
				ok: true,
				value: {
					previousTarget: canonical,
					runtime: this.runtimeInfo(canonical.sessionId, tab),
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
		const availableAgents = this.agents.list().filter((tab) => !isTerminalAgent(tab) && !this.replacementByAgent.has(tab.id) && !this.hasDispatchLease(undefined, tab.id));
		for (const record of records) {
			if (!record.filePath || this.replacementBySession.has(record.id) || this.hasDispatchLease(record.id)) continue;
			const target = buildSessionOriginKey({
				source: record.source,
				environment: record.environment,
				filePath: record.filePath,
				wslDistro: record.wslDistro,
				wslUser: record.wslUser,
				importedSourceId: record.importedSourceId,
			});
			const tab = availableAgents.find(
				(candidate) =>
					candidate.projectId === record.projectId &&
					candidate.sessionPath &&
					buildSessionOriginKey({
						source: candidate.sessionSource ?? "pi",
						environment: candidate.sessionEnvironment ?? "native",
						filePath: candidate.sessionPath,
						wslDistro: candidate.wslDistro,
						wslUser: candidate.wslUser,
						importedSourceId: candidate.importedSourceId,
					}) === target,
			);
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
		// 远端 runtime 的 Ask/UI 请求走的是**同一条**事件桥（同一个 stdio RPC 通道），所以这里不再按
		// ssh locator 一刀切：跳过它会让远端 pi 的提问既不被记录、也无法回答（会话卡在无人应答的提问上）。
		// 身份校验仍然只认 binding（sessionId + agentId + runtimeGeneration）。
		const binding = this.getRuntimeBinding(event.agentId);
		if (!binding || binding.sessionId !== event.sessionId || binding.runtimeGeneration !== event.runtimeGeneration || event.sourceChannel !== "agents:ui-request" || !isRecord(event.payload)) {
			return;
		}
		const requestId = typeof event.payload.requestId === "string" ? event.payload.requestId.trim() : "";
		if (!requestId) return;
		const key = this.uiRequestKey(event.sessionId, requestId);
		if (event.payload.completed === true) {
			this.pendingUiRequests.delete(key);
			return;
		}
		if (!isInteractiveUiMethod(event.payload.method)) return;
		const options = Array.isArray(event.payload.options) ? event.payload.options.filter((option): option is string => typeof option === "string") : undefined;
		const batchQuestions = Array.isArray(event.payload.batchQuestions) ? (event.payload.batchQuestions as AgentUiBatchQuestion[]) : undefined;
		const batchReview = event.payload.batchReview === true;
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
			batchQuestions,
			batchReview,
		});

		// 任何会话收到 Ask 类请求都触发桌面通知：不再按聚焦会话/窗口焦点过滤，
		// 只要 Agent 在提问就提醒（是否真正弹出由 askNotificationEnabled 设置门控）。
		const title = this.catalog.get(event.sessionId)?.title ?? this.catalog.getRecord(event.sessionId)?.title ?? "";
		// 带 agentId（每轮去重）、sessionId（点击跳转）与提问内容（展示在通知气泡里）
		const rawQuestion = typeof event.payload.title === "string" ? event.payload.title : "";
		const question = rawQuestion || (batchQuestions && batchQuestions[0]?.question ? batchQuestions[0].question : "");
		this.agents.notifyAskPending(event.agentId, event.sessionId, title, question);
	}

	/** Web / 飞书以外的只读快照：手机端轮询后渲染确认卡片。 */
	listPendingUiRequests(sessionId?: string): PendingUiRequestSnapshot[] {
		const items: PendingUiRequestSnapshot[] = [];
		// 远端 runtime 的待答请求同样属于「可回答」集合（回答只写回该 runtime 的 stdin，与位置无关）。
		for (const pending of this.pendingUiRequests.values()) {
			if (sessionId && pending.sessionId !== sessionId) continue;
			items.push({ ...pending });
		}
		return items;
	}

	async respondToUi(input: SessionUiResponseInput): Promise<void> {
		// 回答只经 `agents.sendUIResponse` 写回该 runtime 的 stdin（AgentManager 侧是纯 stdio 写，
		// 没有本机路径参与）：远端 runtime 与本地走同一条链路，所以不再按 ssh locator 拒绝。
		const binding = this.getRuntimeBinding(input.agentId);
		if (!binding || binding.sessionId !== input.sessionId || binding.runtimeGeneration !== input.runtimeGeneration || this.agentIdBySession.get(input.sessionId) !== input.agentId) {
			throw new Error("Session runtime binding changed before UI response");
		}
		const key = this.uiRequestKey(input.sessionId, input.requestId);
		const pending = this.pendingUiRequests.get(key);
		if (!pending || pending.agentId !== input.agentId || pending.runtimeGeneration !== input.runtimeGeneration) {
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

	/**
	 * 激活前合成事件用的当前代数（bind 递增前的值）：IPC 层在激活窗口发 session 级
	 * starting 事件时，需要与渲染层已存的代数对齐才能压住旧 runtime 的迟到事件。
	 * 实现见 `runtime/runtimeBinding.ts`。
	 */
	currentRuntimeGeneration(sessionId: string): number {
		return this.bindings.currentRuntimeGeneration(sessionId);
	}

	getRuntimeBinding(agentId: string): { sessionId: string; runtimeGeneration: number } | undefined {
		return this.bindings.getRuntimeBinding(agentId);
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
		// 瞬态 lease 宽限（与 restartSession 同一纪律，见 waitForNoDispatchLease）。fork 前面常刚做完
		// 一次远端 runtime 激活（8–16s），激活一结束渲染层立刻并发发出只读 target 命令
		// （运行时状态 / 模型目录 / 斜杠命令预览），每条都经 runTargetCommand 各持一次 dispatch lease。
		// 用户此刻点 Fork 就是确定性撞车：beginRuntimeReplacement 硬抛
		// "Session runtime prompt dispatch is in progress"，elapsedMs=1、主进程零日志，
		// 界面上只剩一条 5s 后消失的 toast ⇒ 真机表现为「Fork 偶发挂起」。
		// 2026-10 复现：3 条产品路里 1 条必然栽在这里（激活 8497ms → fork 17ms 后被拒）。
		// 这里等这些毫秒级 lease 释放后再占位；真·在途 prompt 仍会在宽限期满后按原语义硬失败。
		const binding = this.getRuntimeBinding(input.agentId);
		if (binding) await this.waitForNoDispatchLease(binding.sessionId, input.agentId, REPLACEMENT_LEASE_GRACE_MS);
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
			// /fork 会从旧分支 model_change 恢复模型；同一 agentId 并不代表偏好仍已生效。
			// 换绑前重放目标 catalog 偏好，失败保持解绑，不能公布旧模型再允许重发。
			this.lastAppliedBySession.delete(targetSessionId);
			await this.applyLatestPreferences(targetSessionId, input.agentId);
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
			if (last?.agentId === agentId) this.lastAppliedBySession.delete(sessionId);
			const lastRequest = this.lastRequestedThinkingBySession.get(sessionId);
			if (lastRequest?.agentId === agentId) this.lastRequestedThinkingBySession.delete(sessionId);
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

		// 与在途 prompt dispatch 并发时先等 lease 释放，避免重启/停止撞上毫秒级发送窗口
		// 直接报「prompt dispatch is in progress」（web 端头部菜单触发 restart 的常见竞态）。
		await this.waitForNoDispatchLease(sessionId, agentId);
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

	/**
	 * fork 化重发/编辑前的模型核对（issue #370）：pi 的 /fork 按旧分支的 model_change 恢复模型，
	 * 模型被删除或改名时它只在进程内部记录回落（RPC 不暴露 modelFallbackMessage），
	 * applyPreferences 也只能提示「偏好失效」后继续。不核对就会「用户以为在 A 模型上重发，
	 * 请求实际打到默认供应商的模型」。只对显式要求核对的重发生效（普通发送沿用 2026-09 的
	 * 降级不阻断策略）；读不到运行态时放行，核对本身不能变成新的阻塞点。
	 */
	private async runtimeModelMismatch(sessionId: string, agentId: string): Promise<{ expected: string; actual: string } | undefined> {
		const entry = this.catalog.get(sessionId);
		const expected = entry?.model;
		if (!entry || !expected?.provider || !expected.modelId) return undefined;
		// DSH/ACP 的模型由各自 host 管，catalog 里的 model 不代表运行时选择，只核对 pi。
		if (entry.backend === "dsh" || entry.backend === "acp") return undefined;
		let actual: SessionRuntimeModelSelection | undefined;
		try {
			actual = await this.agents.getRuntimeModelThinkingState?.(agentId);
		} catch {
			return undefined;
		}
		if (!actual?.provider || !actual.modelId) return undefined;
		if (actual.provider === expected.provider && actual.modelId === expected.modelId) return undefined;
		return { expected: `${expected.provider}/${expected.modelId}`, actual: `${actual.provider}/${actual.modelId}` };
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
			// 网关可给 thrown error 挂 I18nDescriptor（如 ACP AUTH_REQUIRED 登录引导）：
			// 透传给渲染层 toast；未挂载时回落通用「发送失败 + 原文」描述符。
			return this.rejected(input, errorMessage(error), descriptorFromThrownError(error));
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

			// 重发/编辑：核对运行时真的在用会话选择的模型。不一致说明 fork 恢复的模型已不可用、
			// pi 已静默回落到其他模型——宁可拒绝并说清期望/实际，也不拿别的模型执行用户请求。
			// 不在这重试 setModel：激活阶段已重放过偏好，模型确实不存在时重试也不会成功。
			if (input.requireAppliedModel) {
				const mismatch = await this.runtimeModelMismatch(input.sessionId, lease.agentId);
				// 核对期间绑定可能被替换/停止：此时一个 token 都没发出去，按 rejected 而不是 unknown 结算。
				if (!this.isCurrentDispatchLease(lease)) {
					return this.rejected(input, "Session runtime binding changed before prompt dispatch");
				}
				if (mismatch) {
					void this.logger?.warn("session-runtime", "Refused prompt dispatch: runtime model differs from session selection", {
						sessionId: input.sessionId,
						requestId: input.requestId,
						agentId: lease.agentId,
						expected: mismatch.expected,
						actual: mismatch.actual,
					});
					return this.rejected(input, `Session model unavailable: expected ${mismatch.expected}, runtime is ${mismatch.actual}`, {
						i18nKey: "diagnostic.promptModelMismatch",
						i18nParams: { expected: mismatch.expected, actual: mismatch.actual },
						debugDetails: `expected ${mismatch.expected}, actual ${mismatch.actual}`,
					});
				}
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
			const currentTab = this.agents.list().find((candidate) => candidate.id === lease.agentId && !isTerminalAgent(candidate));
			if (!currentTab) {
				return this.unknownDelivery(input, "Session runtime stopped during prompt dispatch");
			}
			// C9：attach patch 收拢 backend 特判（DSH 文件配对分支同时回写 dshSessionId）。
			const dispatchEntry = this.catalog.get(input.sessionId);
			const dispatchPatch = dispatchEntry ? this.buildAttachPatch(input.sessionId, currentTab, dispatchEntry) : null;
			if (dispatchPatch) {
				// Prompt acceptance is the latency-sensitive boundary. Catalog persistence is
				// recovery metadata and must not keep the composer in a sending state; failures
				// are intentionally isolated from the already accepted prompt.
				// DSH 预热只绑 host id、保持 draft；真正发出去才 promoteToActive。
				void this.catalog
					.attachRuntime({
						...dispatchPatch,
						promoteToActive: true,
					})
					.catch(() => undefined);
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
		// #354：渲染层可能还抱着已被身份归并的历史会话 ID（持久化置顶/Tab 引用迁移到位前的
		// 迟到请求）。先进原有激活/绑定状态机前统一归一化，否则同一会话会在旧 ID 上另起一个
		// runtime（两个进程、两份历史，且旧 ID 在 catalog 里已经不存在）。
		const canonicalSessionId = this.canonicalSessionId(sessionId);
		const existing = this.activationBySession.get(canonicalSessionId);
		if (existing) return existing;
		const activation = this.activate(canonicalSessionId).finally(() => {
			this.activationBySession.delete(canonicalSessionId);
		});
		this.activationBySession.set(canonicalSessionId, activation);
		return activation;
	}

	/** 归并别名的归一化入口（网关未提供时按原 ID）。 */
	private canonicalSessionId(sessionId: string): string {
		return this.catalog.resolveSessionId?.(sessionId) ?? sessionId;
	}

	/** 目标里的会话 ID 同样要归一化：target 命令的路由、绑定校验与返回的 target 都用同一个 ID。 */
	private canonicalTarget(target: SessionRuntimeTarget): SessionRuntimeTarget {
		const sessionId = this.canonicalSessionId(target.sessionId);
		return sessionId === target.sessionId ? target : { ...target, sessionId };
	}

	private async activate(sessionId: string): Promise<AgentTab> {
		if (this.deletingSessions.has(sessionId)) {
			throw new Error(`Session is being deleted: ${sessionId}`);
		}
		// 新一次激活自己就是「最新意图」：上一次被切换作废的报告到此失效——
		// 之后若再失败，那是真失败，IPC 要照常弹错误态。
		this.cancelledActivationReports.delete(sessionId);
		const entry = this.catalog.get(sessionId);
		if (!entry) throw new Error(`Session not found: ${sessionId}`);
		const locator = this.catalog.getLocator(sessionId);
		// 远端会话（ssh locator，或属于远端项目的草稿）走**同一条**运行时链路，不另开一套准备逻辑：
		// 进程怎么起来、cwd/plan/launcher 怎么定全在 `AgentManager.createRemoteUnlocked` 里（它才是远端
		// 事实与端口的消费者）。协调器多知道的那一件事只是「这条会话的 runtime 在远端」。
		const remoteHostId = this.remoteHostIdForSession(entry.projectId, locator);
		if (this.replacementBySession.has(sessionId)) {
			throw new Error(`Session runtime replacement reservation conflict: ${sessionId}`);
		}

		const mappedAgentId = this.getAgentId(sessionId);
		if (mappedAgentId) {
			const mappedTab = this.agents.list().find((candidate) => candidate.id === mappedAgentId);
			if (mappedTab) {
				// 回复级错误会把仍存活的进程标成终态 error（Issue #218）：先尝试原进程
				// 复活；复活失败（进程真死了）才按启动失败拒绝，保持原终态语义。
				if (isTerminalAgent(mappedTab) && !this.reviveTerminalAgent(mappedTab.id)) {
					throw this.startupFailure(mappedTab);
				}
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

		const localSessionPath = locator?.kind === "local" ? locator.filePath : undefined;
		// 远端会话文件只能来自远端记录的 `remotePath`（pi 重启同一会话的 `--session`）；草稿还没上报时
		// 就是 undefined ⇒ 与本地新建会话同一个入参（远端 pi 会自己选一个新的会话文件并在握手时上报）。
		const remoteSessionPath = locator?.kind === "ssh" ? locator.remotePath : undefined;
		let tab = remoteHostId === undefined ? (localSessionPath ? this.findAgentBySessionPath({ ...entry, filePath: localSessionPath }) : undefined) : this.findAgentByRemoteSession(remoteHostId, remoteSessionPath);
		if (tab && isTerminalAgent(tab)) {
			// 进程仍存活的 error 终态（回复级错误标出，Issue #218）优先复活复用，
			// 而不是停掉活进程重建——重建在扩展有问题时会触发无插件回退。
			if (!this.reviveTerminalAgent(tab.id)) {
				await this.agents.stop(tab.id);
				tab = undefined;
			}
		}
		if (tab?.status === "starting") tab = await this.waitUntilReady(tab);

		const created = !tab;
		if (!tab) {
			// standby 池认领（仅 pi 网关实现，其余返回 null）：只服务「无既有会话文件」的新会话——
			// 历史会话必须 --session 恢复，dsh 会话与 pi 进程形态不同，都回退正常创建。
			// 认领到的进程模型/扩展是 spawn 时快照：模型/思考档由下面的 applyLatestPreferences
			// 按 catalog 最新值热补；扩展/代理等 spawn-only 输入靠 AgentManager 的指纹比对，
			// 不一致根本不会被认领。created 保持 true：认领的进程归本次激活所有，失败清理必须能停掉它。
			if (entry.backend !== "dsh" && entry.backend !== "acp" && !entry.filePath) {
				tab = (await this.agents.claimStandbyAgent?.({ projectId: entry.projectId, sessionId, noSession: entry.noSession }).catch(() => null)) ?? undefined;
			}
		}
		if (!tab) {
			// deckSessionId = catalog 会话身份（SessionRecord.id），与 UI 保存安全等级覆盖用的 key 同源，
			// 确保扩展按 PIDECK_SESSION_ID 能命中 sessionLevels（历史扫描会话为文件路径，新会话为 UUID）。
			tab = await this.agents.create({
				projectId: entry.projectId,
				title: entry.title,
				deckSessionId: sessionId,
				// ssh locator **不得**交给 `SessionLocatorRouter`（它对 ssh 抛 `UNSUPPORTED_PROJECT_LOCATION`）：
				// 远端运行时位置由项目 locator + 注入端口决定，会话文件只经 `sessionPath` 表达。
				sessionLocator: remoteHostId === undefined ? locator : undefined,
				sessionPath: remoteHostId === undefined ? localSessionPath : remoteSessionPath,
				environment: entry.environment,
				source: entry.source,
				backend: entry.backend,
				dshSessionId: entry.backend === "dsh" ? entry.dshSessionId : undefined,
				// DSH agent 预设（会话「模式」）：草稿期预选，新建 host 会话时随 sessions.create
				// 应用；attach 已有会话时由 DshAgentManager 从 host list 行读回（本字段被忽略）。
				agentPreset: entry.backend === "dsh" ? entry.agentPreset : undefined,
				// ACP：acpSessionId 存在则 session/load 恢复旧会话；工具选择复用 agentPreset
				// 字段（AcpToolConfig.id），草稿预选优先 acpToolId。
				acpSessionId: entry.backend === "acp" ? entry.acpSessionId : undefined,
				...(entry.backend === "acp" ? { agentPreset: entry.acpToolId ?? entry.agentPreset } : {}),
				wslDistro: entry.wslDistro,
				wslUser: entry.wslUser,
				importedSourceId: entry.importedSourceId,
				noSession: entry.noSession,
			});
		}
		if (tab.status === "starting") tab = await this.waitUntilReady(tab);
		if (isTerminalAgent(tab)) {
			// 启动错误卡必须**先读后停**：`stop()` 会删掉该 agent 的 messages，先停会让下面的
			// startupFailure() 取不到带 debugDetails 的错误卡，只能回落到「(error)」这种零信息文案
			// （用户报的「远端会话失败但看不到原因」就是这条顺序造成的）。
			const failure = this.startupFailure(tab);
			if (created) await this.agents.stop(tab.id).catch(() => undefined);
			throw failure;
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
					// 连同 host 实际 preset 一起回写：host 会话已存在，胶囊要展示真实模式而不是
					// 回落默认值（否则界面显示一种、重试时用的又是另一种）。
					await this.catalog.attachRuntime({ sessionId, dshSessionId: tab.sessionId, ...(tab.agentPreset ? { agentPreset: tab.agentPreset } : {}) }).catch(() => undefined);
				}
				// ACP 同理：agent 侧会话可能已创建，先落 acpSessionId 再停，避免重试新建孤儿。
				if (tab.backend === "acp" && tab.sessionId) {
					await this.catalog.attachRuntime({ sessionId, acpSessionId: tab.sessionId }).catch(() => undefined);
				}
				await this.agents.stop(tab.id).catch(() => undefined);
			}
			throw new Error(`Failed to apply session preferences: ${errorMessage(error)}`);
		}

		// 过期激活检查点：到这里已经过 create/claimStandby、waitUntilReady、applyLatestPreferences
		// 三段 await（ACP 的握手就在第一段里，可达数秒）。这期间用户完全可能已经换了后端或 ACP
		// 工具——此时 catalog 里的身份已变，本次激活不得再 bind：否则记录指向新后端，绑定和
		// acpSessionId 回写却挂在旧后端的进程上（表现为「切了后端但还在等旧进程启动」）。
		// 取消信号和 catalog 身份都要看：后端未变但同后端换了工具时只有前者能发现。
		const latestEntry = this.catalog.get(sessionId);
		if (this.cancelledActivations.has(sessionId) || !latestEntry || latestEntry.backend !== entry.backend || latestEntry.acpToolId !== entry.acpToolId) {
			if (created) await this.agents.stop(tab.id).catch(() => undefined);
			throw new Error(`Session activation cancelled: ${sessionId}`);
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
		// standby 补热：本次激活可能消耗了池化进程（或用户正连续开新会话），后台补一个待命。
		// 仅 pi 后端补（dsh 无进程池概念）；ensure 自身幂等，且受 standbyRuntimeEnabled 设置闸。
		if (entry.backend !== "dsh" && entry.backend !== "acp") this.agents.ensureStandbyAgent?.(entry.projectId);
		return tab;
	}

	/**
	 * 会话运行时身份 → catalog attach patch（C9 收拢点）。**按 locator 路由**，三条互斥分支：
	 * - 远端会话（ssh 条目，或属于远端项目的会话）：只回写 ssh 身份（hostId + pi 上报的远端会话文件），
	 *   **绝不**把远端路径写进本机 `filePath`（那会让同一远端会话在 catalog 里出现两条记录）；
	 * - DSH：只回写 dshSessionId，**绝不写 filePath/piSessionId**（2026-08 兼容期教训：
	 *   dsh 的 tab.sessionPath 是 host 的 zstd 会话文件，曾随文件分支落盘导致 pi 侧把
	 *   zstd 文件当 pi 会话文件启动（pi exited code=1））；
	 * - 通用/pi 本机：sessionPath + piSessionId 落「文件配对」分支（行为与以前逐字一致）。
	 * 返回 null 表示无需回写（匿名会话等）。
	 */
	private buildAttachPatch(
		sessionId: string,
		tab: Pick<AgentTab, "sessionPath" | "sessionId" | "backend" | "agentPreset">,
		entry: Pick<SessionCatalogEntry, "noSession" | "backend" | "projectId">,
	): { sessionId: string; filePath?: string; piSessionId?: string; dshSessionId?: string; acpSessionId?: string; agentPreset?: string; promoteToActive?: boolean; remoteLocator?: SshSessionLocator } | null {
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
		// ACP：只回写 acpSessionId（历史在 agent 侧，无本地文件）；agentPreset（工具 id）
		// 回写作展示镜像。
		if (entry.backend === "acp") {
			return tab.sessionId && !entry.noSession ? { sessionId, acpSessionId: tab.sessionId, ...(tab.agentPreset ? { agentPreset: tab.agentPreset } : {}) } : null;
		}
		// 远端路径只以 ssh 身份回写：`tab.sessionPath` 是 pi 上报的**远端**会话文件（本地规则不得改写它），
		// 由 catalog 把这条条目收敛成 ssh locator 并吸收同身份的重复条目。
		const remoteHostId = this.remoteHostIdForSession(entry.projectId, this.catalog.getLocator(sessionId));
		if (remoteHostId !== undefined) {
			return tab.sessionPath && !entry.noSession ? { sessionId, remoteLocator: { kind: "ssh", hostId: remoteHostId, remotePath: tab.sessionPath } } : null;
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

	/**
	 * 远端会话的 runtime 匹配（对照 `findAgentBySessionPath`）：身份是 **(hostId, remotePath)**，
	 * 不是本机路径。
	 *
	 * 为什么必须带 hostId：`sessionPath` 孤立地看只是那台机器上的一条远端路径，同一路径在两台主机上
	 * 是两个不同的会话（测试锁住了「两个同路径不同 hostId 的记录不得互相命中」）。主机身份从 tab 的
	 * 项目位置取 —— 与 `AgentManager` 的路由判据同源（它也按项目 locator 决定 runtime 在哪跑）。
	 */
	private findAgentByRemoteSession(hostId: string, remotePath: string | undefined): AgentTab | undefined {
		if (!remotePath) return undefined;
		return this.agents.list().find((tab) => !this.replacementByAgent.has(tab.id) && tab.sessionPath === remotePath && this.remoteHostIdForSession(tab.projectId, undefined) === hostId);
	}

	private findAgentBySessionPath(entry: SessionCatalogEntry): AgentTab | undefined {
		// 本机 matcher：ssh 条目没有本机路径可配，也不允许拿远端路径去比本机 origin key。
		if (this.catalog.getLocator(entry.id)?.kind === "ssh" || !entry.filePath) return undefined;
		const target = buildSessionOriginKey({
			source: entry.source,
			environment: entry.environment,
			filePath: entry.filePath,
			wslDistro: entry.wslDistro,
			wslUser: entry.wslUser,
			importedSourceId: entry.importedSourceId,
		});
		return this.agents.list().find(
			(tab) =>
				!this.replacementByAgent.has(tab.id) &&
				tab.sessionPath &&
				buildSessionOriginKey({
					source: tab.sessionSource ?? "pi",
					environment: tab.sessionEnvironment ?? "native",
					filePath: tab.sessionPath,
					wslDistro: tab.wslDistro,
					wslUser: tab.wslUser,
					importedSourceId: tab.importedSourceId,
				}) === target,
		);
	}

	/**
	 * error 终态 agent 的原进程复活：进程仍存活（回复级错误不会杀进程）时把状态
	 * 回复为 idle 并复用，避免「激活即抛启动失败」或「发消息就杀掉活进程重建」
	 * （重建在扩展有问题时还会触发无插件回退，Issue #218）。
	 * 网关未实现该能力（dsh）或进程确已死亡时返回 false，调用方走原终态路径。
	 */
	private reviveTerminalAgent(agentId: string): boolean {
		if (typeof this.agents.reviveIfProcessAlive !== "function") return false;
		const revived = this.agents.reviveIfProcessAlive(agentId);
		if (revived) {
			void this.logger?.info("session-runtime", "Terminal agent revived with live process", {
				agentId,
			});
		}
		return revived;
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
			const diagnostic = [...this.agents.getMessages(tab.id)].reverse().find((message) => message.role === "error");
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

	/**
	 * 绑定会话身份与运行实例（远端会话同样适用：`sessionId` 是 catalog 身份（远端为 ssh 条目），
	 * `agentId` 是那个远端 pi 进程）。旧实现在这里对 ssh 抛 `UNSUPPORTED_PROJECT_LOCATION`，那是
	 * 「远端没有 runtime」时期的拦路码，现在会让远端激活直接失败。
	 */
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
		if (previousAgentId === agentId && this.sessionIdByAgent.get(agentId) === sessionId) {
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

	private completeRuntimeReplacement(replacement: RuntimeReplacement, targetSessionId: string): SessionRuntimeBinding {
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
		// Per-runtime commands/diagnostics must not keep the origin record after fork.
		const tab = this.agents.list().find((candidate) => candidate.id === replacement.agentId);
		if (tab) tab.deckSessionId = targetSessionId;
		return {
			sessionId: targetSessionId,
			agentId: replacement.agentId,
			runtimeGeneration: this.bind(targetSessionId, replacement.agentId),
		};
	}

	private restoreRuntimeReplacement(replacement: RuntimeReplacement): SessionRuntimeBinding {
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
		if (this.sessionIdByAgent.has(replacement.agentId) || this.agentIdBySession.get(replacement.sessionId) === replacement.agentId) {
			throw new Error("Session runtime replacement acquired a competing binding");
		}
	}

	private reserveBoundRuntime(sessionId: string, agentId: string, opts: { ignoreDispatchLease?: boolean } = {}): RuntimeReplacement {
		const binding = this.getRuntimeBinding(agentId);
		if (!binding || binding.sessionId !== sessionId || this.agentIdBySession.get(sessionId) !== agentId) {
			throw new Error("Session runtime changed before reservation");
		}
		// stop 路径传 ignoreDispatchLease：停止杀进程是卡死回合的唯一恢复出口，必须越过
		// 在途 dispatch lease（其余 replacement 路径保持原断言，避免重配与 dispatch 竞态）。
		if (!opts.ignoreDispatchLease) this.assertNoDispatchLease(sessionId, agentId);
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
		if (this.replacementByAgent.get(reservation.agentId) !== reservation || this.replacementBySession.get(reservation.sessionId) !== reservation) {
			throw new Error("Session runtime reservation changed");
		}
		const binding = this.getRuntimeBinding(reservation.agentId);
		if (!binding || binding.sessionId !== reservation.sessionId || binding.runtimeGeneration !== reservation.runtimeGeneration) {
			throw new Error("Session runtime binding changed during reservation");
		}
	}

	private runtimeInfo(sessionId: string, tab: AgentTab): SessionRuntimeInfo {
		const target = this.getTarget(sessionId);
		if (!target || target.agentId !== tab.id) {
			throw new SessionRuntimeCommandError("SESSION_RUNTIME_CHANGED", "Session runtime binding changed while building runtime state");
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
			// 远端 trust 现状随 runtime 快照一起给：渲染层重载/首次渲染就能显示提示，不用等下一条
			// `agents:state`（那条推送只在该会话发生状态变化时才来）。本机会话不带该字段。
			...(tab.remoteTrustUnhandled === true ? { remoteTrustUnhandled: true } : {}),
			// 远端注入面同样随 runtime 快照下发：重载后 UI 的能力门不能退化成“应该能”。
			...(tab.remoteExtensions === undefined ? {} : { remoteExtensions: tab.remoteExtensions }),
			// PiDeck 会话身份透传：渲染层侧栏 ACP「agent↔会话」配对依赖它（见 SessionRuntimeInfo.deckSessionId）。
			deckSessionId: tab.deckSessionId,
		};
	}

	private requireTarget(target: SessionRuntimeTarget): SessionRuntimeBinding {
		return this.bindings.requireTarget(target);
	}

	/**
	 * 停止专用目标规范化（与 requireTarget 不同）：停止的语义是「让这个进程停下来」，
	 * agentId 才是运行实例的稳定身份。草稿会话被扫描合并 remap 后，渲染层持有的
	 * sessionId/generation 可能同时过期——只要 agentId 仍有 live 绑定就按 live 绑定停。
	 * 真正两边都没有（无 live 绑定且 catalog 无行）才报 SESSION_NOT_FOUND；
	 * 有 catalog 行但无绑定则报「运行实例不可用」，避免误导用户去刷新会话列表。
	 * 实现见 `runtime/runtimeBinding.ts`。
	 */
	private resolveStopTarget(target: SessionRuntimeTarget): SessionRuntimeTarget {
		return this.bindings.resolveStopTarget(target);
	}

	private requireBoundTarget(target: SessionRuntimeTarget): SessionRuntimeBinding {
		return this.bindings.requireBoundTarget(target);
	}

	private serializePreferenceMutation<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.preferenceMutationTails.get(sessionId) ?? Promise.resolve();
		const current = previous.then(operation, operation);
		const tail = current.then(
			() => undefined,
			() => undefined,
		);
		this.preferenceMutationTails.set(sessionId, tail);
		void tail.then(() => {
			if (this.preferenceMutationTails.get(sessionId) === tail) this.preferenceMutationTails.delete(sessionId);
		});
		return current;
	}

	private async runTargetCommand<T>(target: SessionRuntimeTarget, operation: (agentId: string) => Promise<T>): Promise<SessionCommandResult<SessionTargetedValue<T>>> {
		let lease: DispatchLease | undefined;
		try {
			// #354：所有 target 命令的唯一入口——先把历史会话 ID 归一化，再走原有绑定/租约状态机。
			const canonical = this.canonicalTarget(target);
			this.requireTarget(canonical);
			lease = this.acquireDispatchLease(canonical.sessionId, canonical.agentId);
			if (lease.runtimeGeneration !== canonical.runtimeGeneration) {
				throw new SessionRuntimeCommandError("SESSION_RUNTIME_CHANGED", "Session runtime generation changed before command dispatch");
			}
			const value = await operation(lease.agentId);
			if (!this.isCurrentDispatchLease(lease)) {
				throw new SessionRuntimeCommandError("SESSION_RUNTIME_CHANGED", "Session runtime binding changed during command dispatch");
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
	 * 实现见 `runtime/remoteMessageMutation.ts`（catalog 写面与错误分类同域）。
	 */
	private mutateCatalogMessage(
		requestedSessionId: string,
		messageId: string,
		operation: "edit" | "delete" | "resend" | "remove-image",
		newText?: string,
		/** 渲染层消息的文件条目 id（meta.entryId），见 readMessageByMessageId 的锚点语义。 */
		entryId?: string,
		imageTarget?: SessionMessageImageTarget,
	): Promise<SessionCommandResult<{ text: string; images?: ImageContent[] } | undefined>> {
		return this.messageMutation.mutateCatalogMessage(requestedSessionId, messageId, operation, newText, entryId, imageTarget);
	}

	/** 命令失败分类（文案匹配 + SessionFileEditorError 稳定码 + 远端写面稳定码）见 `runtime/remoteMessageMutation.ts`。 */
	private commandFailure<T>(error: unknown): SessionCommandResult<T> {
		return this.messageMutation.commandFailure(error);
	}

	/** 远端会话摘要的键仍在停止路径上使用（stop 会先捕获、再销毁 gateway 消息缓存）。 */
	private remoteMessageIdentityKey(locator: SshSessionLocator): string {
		return this.messageMutation.remoteMessageIdentityKey(locator);
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

	private addDispatchLease(leases: Map<string, Set<DispatchLease>>, key: string, lease: DispatchLease): void {
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
		if (!this.dispatchLeasesBySession.get(lease.sessionId)?.has(lease) || !this.dispatchLeasesByAgent.get(lease.agentId)?.has(lease)) return false;
		const binding = this.getRuntimeBinding(lease.agentId);
		return Boolean(binding && binding.sessionId === lease.sessionId && binding.runtimeGeneration === lease.runtimeGeneration && this.agentIdBySession.get(lease.sessionId) === lease.agentId);
	}

	private hasDispatchLease(sessionId?: string, agentId?: string): boolean {
		return Boolean((sessionId && this.dispatchLeasesBySession.get(sessionId)?.size) || (agentId && this.dispatchLeasesByAgent.get(agentId)?.size));
	}

	/**
	 * 瞬态 dispatch lease 宽限：stop/restart/activate 与在途发送并发时，prompt dispatch
	 * 只覆盖 sendAgentPrompt 的 RPC 窗口（毫秒到秒级，pi 忙时排队会更久），此时硬抛
	 * 「prompt dispatch is in progress」对用户只是一次无意义的失败——等 lease 释放后
	 * 重试同一操作即可成功。在 deadline 内轮询等待，超时则返回让调用方走原有
	 * assert 硬失败路径（保留既有错误语义，避免无限挂起）。
	 */
	private async waitForNoDispatchLease(sessionId: string, agentId: string, timeoutMs = 2000): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (this.hasDispatchLease(sessionId, agentId)) {
			if (Date.now() >= deadline) return;
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
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

	private unknownDelivery(input: Pick<SendSessionPromptInput, "sessionId" | "requestId">, error: string): SendSessionPromptResult {
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
