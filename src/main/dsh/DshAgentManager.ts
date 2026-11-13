import type { AgentBackend, AgentGatewayCapability, AgentRuntimeState, AgentTab, AvailableModel, ChatMessage, CreateAgentInput, DshSkillView, ImageContent, PiCommand, Project, SendPromptInput, SendPromptResult, SessionRuntimeModelSelection, SessionUiResponseInput } from "../../shared/types";
import { emitAgentMessageMeasured } from "../perf/messageFlushMeter";
import type { SessionProcessEvent } from "../../shared/types/trajectory";
// DSH 会话 id 品牌类型（零运行时成本，仅类型擦除）
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { agentEventTags, ipcChannels } from "../../shared/ipc";
import { isLocalProject } from "../../shared/projectLocation";
import { getAppLogger } from "../logging/sharedLogger";
import type { DshEnvelope, DshHistoryEntry, DshHistoryPage } from "./dshRemoteClient";
import type { SessionAgentGateway } from "../sessions/SessionRuntimeCoordinator";
import type { DshHost } from "./DshHost";
import { defaultToolDetailTranslate, type ToolDetailTranslate } from "../../shared/formatToolDetail";
import { projectDshEvent, parseDshTodoList } from "./dshEventProjector";
import type { DshSubagentTranscriptPage } from "./dshSubagentTranscript";
import { collectDshProcessEvents, parseContextBreakdownProjection, parseContextPressureProjection, parseSessionStatsProjection, parseTokenUsageProjection } from "./dshProcessEvents";
import { beginDshCancel, type DshControlState } from "./dshRuntimeControl";
import { isDshModelImageUnsupportedRejection, readDshModelSelection, resolveDshModelDirectory, toDshAvailableModels } from "./dshModels";
import { approvalUiRequest, buildDshRejectValue, buildDshRespondValue, parseDshApprovalFrame, parseDshQuestionFrame, questionUiRequest, type DshApprovalFrame, type DshQuestionFrame } from "./dshApprovalBridge";
import { dshRuntimeWindowFields, resolveDshHistoryWindow } from "./dshHistoryPagePlan";
import { DSH_SESSION_FIND_MAX_MATCHES, findDshSessionMatches, type DshSessionFindResult } from "./dshSessionFind";
import { reasoningText } from "../../shared/reasoningText";
import { parseDshTeamProjection } from "./dshTeamProjection";
import type { RpcLogEntry } from "../../shared/types/rpcLog";
import type { RpcLogLiveSink } from "../logging/RpcLogLiveBroadcaster";
import type { DshAgentRuntime } from "./manager/dshAgentRuntime";
import { applyDshHistoryProjectionBaseline, DSH_PROJECTION_KEYS } from "./manager/dshProjectionFrames";
import { dispatchDshMuxFrame, type DshMuxFrameHost, lastAssistantText, mergeDshHydratedMessages } from "./manager/dshMuxFrames";
import { readDshHistoryPage, readDshProcessEvents, readDshSubagentHistory, type DshHistoryReadHost } from "./manager/dshHistoryReads";
import { buildDshRuntimeState } from "./manager/dshRuntimeState";
import { DshRuntimePumps, initialDshControl } from "./manager/dshRuntimePumps";
import { hydrateDshImageRefs as hydrateDshImageRefsOnMessages } from "./manager/dshImageHydration";
import { setDshModel, setDshPermission, setDshThinking, type DshModelControlHost } from "./manager/dshModelControl";
import { exportDshAgentHtml, exportDshSessionHtml, readDshSessionExportMessages, type DshSessionExportHost } from "./manager/dshSessionExport";

/**
 * DSH 后端网关：实现 SessionAgentGateway，把 DSH host（DshHost）的会话/事件
 * 投影成 PiDeck 的 ChatMessage / AgentTab / runtime 状态，走统一 onOutput 通道
 * （agents:* 载荷）推给渲染层——渲染层无需区分后端。
 *
 * v1 范围（能力缺失显式声明，UI 按能力禁用入口）：
 * - 支持：create/list/sendPrompt（queue=下一轮 / steer=插入当前回合）/abort/stop/
 *   restart/rename/getRuntimeState/getAvailableModels/setModel/
 *   prepareResendFromMessage/publishRuntimeState/fork/getForkMessages
 *   （session.fork 锚 seq）/compact（/compact 命令）/getCommands（D15）/
 *   exportHtml（G10：投影式导出）
 * - 缺失（capabilities 未声明，且接口方法不实现——可选能力，见 SessionAgentGateway
 *   注释）：editMessage/deleteMessage。调用方经 capability 检查拒绝，
 *   不再复制 throw 样板。
 *
 * 事件模型（DSH SessionEvent = { type, seq, time, data }，PoC 实测）：
 * - assistant/chunk.data.chunk 是 StreamChunk delta（text-delta / reasoning-delta / finish）
 * - assistant/message.data.message.content 是组装后内容块
 * - turn/end.data.reason.kind === 'error' 表示回合失败
 * 投影逻辑在 dshEventProjector.ts（纯函数，可单测）。
 */
/**
 * DSH prompt image 媒体类型收窄（G2）：仅 attachment 服务支持的四种光栅格式。
 */
function isDshImageMediaType(value: string): value is "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
	return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

/** skills/list 的 host 错误：保留 error.code 以便上层区分「会话未 attach」与真实故障。 */
export class DshSkillListError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "DshSkillListError";
		this.code = code;
	}
}

/** skills/list 条目 → 渲染层视图（listSkills / listSkillsByHostSession 共用同一映射）。 */
function toDshSkillViews(skills: Array<{ name?: string; description?: string; whenToUse?: string; modelInvocable?: boolean }> | undefined): DshSkillView[] {
	return (skills ?? []).map((skill) => ({
		name: String(skill.name),
		description: String(skill.description),
		...(skill.whenToUse !== undefined && skill.whenToUse !== null ? { whenToUse: String(skill.whenToUse) } : {}),
		modelInvocable: skill.modelInvocable !== false,
	}));
}

export class DshAgentManager implements SessionAgentGateway {
	readonly backend: AgentBackend = "dsh"; /** 已支持的可选能力：fork（session.fork 锚 seq 裁剪）、compact（/compact 命令）、getCommands（host 命令注册表枚举桥，D15）、exportHtml（投影式导出，G10）。 */
	readonly capabilities: ReadonlySet<AgentGatewayCapability> = new Set(["fork", "getForkMessages", "compact", "getCommands", "exportHtml"]);

	private readonly runtimes = new Map<string, DshAgentRuntime>();
	/** 三条共享流泵（共享 mux / session/control / 每会话 follow）：连接簿记与退避重连在
	 *  manager/dshRuntimePumps，宿主只留 startMux / stopSharedMux / stopFollowPump。 */
	private readonly pumps: DshRuntimePumps;
	private readonly outputListeners = new Set<(channel: string, payload: unknown) => void>();
	/** 成功收口订阅（桌宠 done 气泡 / 会话完成通知）：用户停止与失败不触发。 */
	private readonly settledListeners = new Set<(info: { agentId: string; title: string }) => void>();
	/** 每轮只提醒一次 Ask：sendPrompt 开头清空。 */
	private readonly notifiedAskAgents = new Set<string>();
	/** 待应答的 DSH server-request 帧：rpcId → frame（approval/question 共用一张表）。 */
	private readonly pendingResponses = new Map<string, DshApprovalFrame | DshQuestionFrame>();
	/** RPC 日志开关集合（G17；agentId → 开启）。 */
	private readonly rpcLoggingAgents = new Set<string>();
	/** 审批/提问 pending 超时定时器（D5：用户不响应时自动拒绝，避免永久挂起）。 */
	private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
	/** pending 审批/提问的超时时长（10 分钟：Ask 弹窗常驻等待太久无意义）。 */
	private static readonly PENDING_RESPONSE_TIMEOUT_MS = 10 * 60_000;

	/** 会话内查找历史快照的复用窗口：连续输入命中缓存，超过窗口不复用（下次检索重建，进程内最多一份）。 */
	private static readonly SESSION_FIND_CACHE_TTL_MS = 60_000;
	/**
	 * 会话内查找的历史快照缓存（单份）：用户逐字输入时每 160ms 就会查一次，
	 * 同一个 cursor（会话没有新事件）下不必重走整段分页。切换会话/新事件/超时即失效。
	 */
	private sessionFindCache?: { dshSessionId: string; cursor: number; messages: ChatMessage[]; expiresAt: number };
	/** 正在构建的历史快照（按会话合并并发）：连续输入会并发发起多次检索，不能各走一遍分页。 */
	private readonly sessionFindInflight = new Map<string, Promise<ChatMessage[]>>();
	/** mux 帧分发/投影模块的宿主出口（模块只经这些方法回读会话 map 与输出通道，状态仍留宿主）。 */
	private readonly muxFrameHost: DshMuxFrameHost = {
		findRuntimeBySessionId: (sessionId) => this.findRuntimeBySessionId(sessionId),
		handleServerRequest: (runtime, frame, payload) => this.handleServerRequest(runtime, frame, payload),
		applyControl: (runtime, next) => this.applyControl(runtime, next),
		emit: (channel, payload) => this.emit(channel, payload),
		emitState: () => this.emit(agentEventTags.agentsState, this.list()),
		emitMessages: (runtime) => this.emitMessages(runtime),
		emitRuntimeState: (agentId) => this.emitRuntimeState(agentId),
		notifyAgentSettled: (agentId, title) => this.notifyAgentSettled(agentId, title),
		notifyTitleChanged: (dshSessionId, title) => this.onTitleChanged?.(dshSessionId, title),
		hydrateRuntimeDshImages: (runtime) => this.hydrateRuntimeDshImages(runtime),
	};
	/** 历史读取域（分页/轨迹过程事件/子代理 transcript）的宿主出口：会话 map、客户端获取与
	 *  图片回填留在宿主，模块只经窄接口走既有路径。 */
	private readonly historyReadHost: DshHistoryReadHost;
	/** 模型/思考档/权限预设的宿主出口：runtime 查表与 idle 串行化留在宿主。 */
	private readonly modelControlHost: DshModelControlHost;
	/** 会话 HTML 导出的宿主出口：runtime 查表、host 拉起与导出目录注入留在宿主。 */
	private readonly sessionExportHost: DshSessionExportHost;
	constructor(
		private readonly dshHost: DshHost,
		private readonly getProject: (id: string) => Project | undefined,
		/** 审批自动放行开关：运行时读取（默认关闭），true 时 approval 帧直接应答 allowed-once。 */
		private readonly getAutoAllowApproval: () => boolean = () => false,
		/** DSH host 会话标题变化回调（attach 初值 / session/title 事件 / rename）：
		 *  装配层据此写回 catalog 并推送侧栏刷新——DSH 会话没有 pi 会话文件，
		 *  标题只存在于 host（dsh-session-title 的 session/title 事件 fold）。 */
		private readonly onTitleChanged?: (dshSessionId: string, title: string) => void,
		/** RPC 日志服务（G17：DSH 领域调用记录，与 pi 共用 RpcLogger；未注入时静默）。
		 *  push 返回截断后的实时副本（与 getLive 环形缓冲同形态），供实时广播复用。 */
		private readonly rpcLogger?: { push(entry: RpcLogEntry): RpcLogEntry },
		/** 会话 HTML 导出目录（G10：应用数据目录内，装配层注入；空串 = 导出不可用）。 */
		private readonly getExportDir: () => string = () => "",
		/** 新会话无标题时的兜底标题（i18n；缺省保留历史文案「DSH 会话」）。 */
		private readonly getUntitledTitle: () => string = () => "DSH 会话",
		/** 实时 RPC 日志广播（RpcLogLiveBroadcaster；未注入时实时流不可用但记录/落盘不受影响）。 */
		private readonly rpcLogLive?: RpcLogLiveSink,
		/**
		 * 桌面 Ask 通知出口（与 pi 同一份门控/toast，见 notifications/agentToast.ts）。
		 * 返回是否真的弹出：false 时不占用「每轮只提醒一次」的去重位。缺省静默。
		 */
		private readonly notify?: { askPending?: (input: { agentId: string; sessionId: string; sessionTitle: string; question: string }) => boolean },
		/** 导出上限提示由装配传入当前 mainCopy；未装配时沿用主进程词典兜底。 */
		private readonly translate: ToolDetailTranslate = defaultToolDetailTranslate,
	) {
		// 宿主出口带构造参数（dshHost），必须在参数属性赋值后装配，不能放字段初始化器。
		this.historyReadHost = {
			runtimes: this.runtimes,
			dshHost: this.dshHost,
			getRuntime: (agentId) => this.runtime(agentId),
			requireClient: () => this.requireClient(),
			ensureClient: () => this.ensureClient(),
			historyPage: (sessionId, options) => this.historyPage(sessionId, options),
			hydrateDshImageRefs: (client, sessionId, messages, attempted) => this.hydrateDshImageRefs(client, sessionId, messages, attempted),
		};
		this.pumps = new DshRuntimePumps({
			runtimes: this.runtimes,
			dshHost: this.dshHost,
			requireClient: () => this.requireClient(),
			dispatchMuxFrame: (frame) => this.dispatchMuxFrame(frame),
			backfillHistory: (runtime) => this.backfillHistory(runtime),
			emitRuntimeState: (agentId) => this.emitRuntimeState(agentId),
		});
		this.modelControlHost = {
			getRuntime: (agentId) => this.runtime(agentId),
			requireClient: () => this.requireClient(),
			waitForIdle: (agentId) => this.waitForIdle(agentId),
		};
		this.sessionExportHost = {
			getRuntime: (agentId) => this.runtime(agentId),
			ensureClient: () => this.ensureClient(),
			historyPage: (sessionId, options) => this.historyPage(sessionId, options),
			getExportDir: () => this.getExportDir(),
			translate: this.translate,
			readSessionExportMessages: (dshSessionId, options) => this.readSessionExportMessages(dshSessionId, options),
		};
		// E4：host 崩溃自动重启完成后恢复所有 runtime（host 内存已丢失：流式/工具/
		// 压缩状态停在崩溃前，mux 重连后新 host 没有已订阅会话，事件不会再推）。
		this.dshHost.onHostReady(() => {
			void this.recoverAfterHostRestart();
		});
	}

	// ── RPC 日志（G17，与 pi 的 setRpcLogging 语义一致）────────────────────────

	/** 开启/关闭某 DSH 会话的 RPC 日志（领域调用经 rpcLogger 落盘）。 */
	setRpcLogging(agentId: string, enabled: boolean): void {
		if (enabled) this.rpcLoggingAgents.add(agentId);
		else this.rpcLoggingAgents.delete(agentId);
	}

	/** 是否开启 RPC 日志。 */
	isRpcLogging(agentId: string): boolean {
		return this.rpcLoggingAgents.has(agentId);
	}

	/** 登记「实时日志面板是否在看」（rpcLogsSetWatching；面板挂载/卸载成对调用，只影响广播）。 */
	setRpcLogWatching(agentId: string, watching: boolean): void {
		this.rpcLogLive?.setWatching(agentId, watching);
	}

	/** 记录一条 DSH 领域调用日志（仅开关开启时；data 透传 RpcLogger 的截断/脱敏）。
	 *  落盘与实时广播共用同一次 push 的截断结果，保证面板实时流与环形缓冲/文件内容一致。 */
	private logRpc(agentId: string, direction: "send" | "recv", summary: string, data?: unknown): void {
		if (!this.rpcLoggingAgents.has(agentId)) return;
		const liveEntry = this.rpcLogger?.push({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			agentId,
			direction,
			summary,
			time: Date.now(),
			...(data !== undefined ? { data } : {}),
		});
		if (liveEntry) this.rpcLogLive?.enqueue(liveEntry);
	}

	// ── 网关身份与订阅 ─────────────────────────────────────────────────────────

	onOutput(listener: (channel: string, payload: unknown) => void): () => void {
		this.outputListeners.add(listener);
		return () => this.outputListeners.delete(listener);
	}

	private emit(channel: string, payload: unknown): void {
		for (const listener of this.outputListeners) listener(channel, payload);
	}

	// ── SessionAgentGateway 实现 ───────────────────────────────────────────────

	list(): AgentTab[] {
		return [...this.runtimes.values()].map((runtime) => runtime.tab);
	}

	getMessages(agentId: string): ChatMessage[] {
		return this.runtime(agentId).messages;
	}

	/**
	 * 按 cwd + dsh sessionId 推导 host 会话文件路径（F5：渲染层右键「复制会话文件路径」用，
	 * 历史会话无运行时 tab 时也拿得到）。DSH 会话文件是 zstd 压缩日志，路径仅作定位。
	 * 目录编码交给 DshHost（按 host 视角路径推导，WSL 项目必须是 H:\... 形式）。
	 */
	resolveSessionFilePath(cwd: string, dshSessionId: string): string {
		return this.dshHost.sessionFilePath(cwd, dshSessionId);
	}

	async create(input: CreateAgentInput): Promise<AgentTab> {
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);
		if (!isLocalProject(project)) throw new Error("UNSUPPORTED_PROJECT_LOCATION");
		const client = await this.ensureClient();
		const cwd = project.path;

		// attach 路径（重启恢复）：catalog 已持久化 DSH sessionId 时复用旧会话，
		// 不新建——DSH 会话由 host 持久化（$DSH_HOME），重建会丢失对话历史。
		let sessionId: string = "";
		let attached = false;
		/** attach 时从 host 拿到的会话标题（list 投影的 title 单元，非 draft 占位名）。 */
		let hostTitle: string | undefined;
		/** attach 时 host list 行携带的 agent preset（会话创建时组合的「模式」；header 权威）。 */
		let attachedAgentPreset: string | undefined;
		/** attach 时 list 投影的 values 块（contextPressure/contextBreakdown 初值，dsh-web 同源）。 */
		let attachProjectionValues: unknown;
		/** attach 时 values 共同对应的 host 日志水位；用于 higher-seq-wins。 */
		let attachProjectionSeq: number | undefined;
		/** 新建时 sessions.create 响应解析出的 agent preset（host 可能回退部署默认）。 */
		let createdAgentPreset: string | undefined;
		if (input.dshSessionId) {
			const listed = await client.sessionsList();
			if (listed.result.ok) {
				const existing = listed.result.value.items?.find((item) => item.sessionId === input.dshSessionId);
				if (existing) {
					sessionId = input.dshSessionId;
					attached = true;
					// host list 行带会话实际组合的 agent preset（header passthrough，dsh-web 同源）：
					// 草稿预选可能被 host 修正为部署默认，这里以 host 为准回写 catalog。
					attachedAgentPreset = existing.agentPreset;
					// dsh-session-title 把最新标题 fold 进 list 行的 projections.values.title：
					// 侧栏显示真实标题（如「打包的体积是否能优化一下呢」）而不是 draft 占位名。
					const projectionBlock = existing.projections as { values?: unknown; asOfSeq?: unknown } | undefined;
					const values = projectionBlock?.values;
					attachProjectionValues = values;
					const rawProjectionSeq = projectionBlock?.asOfSeq;
					if (typeof rawProjectionSeq === "number" && Number.isSafeInteger(rawProjectionSeq) && rawProjectionSeq >= -1) {
						attachProjectionSeq = rawProjectionSeq;
					}
					const projectedTitle = values !== null && typeof values === "object" ? (values as Record<string, unknown>).title : undefined;
					if (typeof projectedTitle === "string" && projectedTitle.trim()) {
						hostTitle = projectedTitle.trim();
					}
				} else {
					// 持久化 id 在 host 里已不存在（DSH_HOME 被清/更换）：退回新建。
					const created = await this.createHostSession(client, cwd, input.agentPreset);
					if (created.ok && created.agentPreset) createdAgentPreset = created.agentPreset;
					if (!created.ok) {
						throw new Error(`dsh session.create failed: ${created.error}`);
					}
					sessionId = created.sessionId;
				}
			} else {
				throw new Error(`dsh session.list failed: ${JSON.stringify(listed.result.error)}`);
			}
		} else {
			const created = await this.createHostSession(client, cwd, input.agentPreset);
			if (created.ok && created.agentPreset) createdAgentPreset = created.agentPreset;
			if (!created.ok) {
				throw new Error(`dsh session.create failed: ${created.error}`);
			}
			sessionId = created.sessionId;
		}

		// catalog 持久化的是普通字符串，host API 需要品牌类型：边界处一次性转换。
		const dshSessionId = sessionId as SessionId;

		const agentId = `dsh:${sessionId}`;
		const tab: AgentTab = {
			id: agentId,
			projectId: input.projectId,
			cwd,
			title: hostTitle ?? input.title ?? this.getUntitledTitle(),
			status: "idle",
			sessionId,
			// PiDeck 会话身份（catalog SessionRecord.id）：渲染层侧栏 DSH agent ↔ 会话
			// 行配对的兜底键——automation 链路 attach 回写 dshSessionId 是异步的，
			// 渲染层快照可能先于 attach 到达，只按 dshSessionId 配对会产生重复条目。
			deckSessionId: input.deckSessionId,
			backend: "dsh",
			noSession: input.noSession,
			// 会话「模式」：attach 用 host list 行值；新建用 sessions.create 响应解析值
			//（可能被 host 修正为部署默认）。随 buildAttachPatch 回写 catalog。
			agentPreset: attachedAgentPreset ?? createdAgentPreset,
			createdAt: Date.now(),
			// DSH 会话文件（侧栏右键「复制会话文件路径」；attach 时同步写回 catalog 记录）
			sessionPath: this.dshHost.sessionFilePath(cwd, sessionId),
		};
		const runtime: DshAgentRuntime = {
			tab,
			sessionId: dshSessionId,
			cwd,
			messages: [],
			projection: projectDshEvent(undefined, undefined, agentId),
			isStreaming: false,
			control: initialDshControl(),
			projectionSeq: new Map(),
			processEvents: [],
		};
		// attach 旧会话：拉历史尾部投影为初始消息（重启后能直接看到旧对话），
		// 投影器按 source.kind 过滤注入上下文，时间线只含真实对话。
		if (attached) {
			const history = await this.historyPage(String(dshSessionId), { maxMessages: 200 }).catch(() => null);
			if (history?.result.ok) {
				// history 条目带 host 计算的 tool view（与 mux 帧同源），随事件一起投影，
				// 历史工具卡片也能展示命令/描述（dsh-web 历史页同数据）。
				const entries = (history.result.value.events ?? [])
					.map((entry) => ({ event: entry.event, view: entry.view }))
					.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
					.sort((left: { event: { seq?: number } }, right: { event: { seq?: number } }) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
				this.recordDshHistoryWindow(runtime, entries, history.result.value.hasMore === true);
				for (const { event, view } of entries) {
					runtime.projection = projectDshEvent(runtime.projection, event, agentId, view);
				}
				runtime.messages = runtime.projection.messages;
				// DSH 历史里的图片以 durable attachment ref 存储：拉取字节回填，主界面才能显示。
				runtime.messages = await this.hydrateDshImageRefs(client, dshSessionId, runtime.messages, runtime.hydratedImageRefs);
				// 轨迹过程事件随历史重放一并恢复（重新打开的 dsh 会话也有 modelChange/权限等记录）
				runtime.processEvents = collectDshProcessEvents(
					runtime.processEvents,
					entries.map(({ event }) => event),
				);
				// 初始 attach 也推进 lastProjectedSeq：避免 mux 重连补帧重复投影（D6）。
				const lastEntry = entries[entries.length - 1];
				if (lastEntry && typeof lastEntry.event.seq === "number") {
					runtime.lastProjectedSeq = lastEntry.event.seq;
				}
				// G5：attach 后从投影恢复 goal 状态（goal/change 事件随历史重放）
				runtime.goal = runtime.projection.goal;
				// 待办计划随历史重放恢复（todo/write / turn/start 事件折叠；standing plan 语义）
				if (runtime.projection.todos !== undefined) runtime.todos = runtime.projection.todos;
				// 尾页 projections baseline 兜底：底层完整折叠不受事件窗口截断影响
				this.applyHistoryProjectionBaseline(runtime, history.result.value.projections);
			}
		}
		// attach 初值：list 的 projections.values 携带 host 折叠好的 contextPressure /
		// contextBreakdown / tokenUsage / sessionStats（dsh-web ContextMeter/StatsLine 同源），
		// 打开历史会话即可显示占用圆环与会话统计。
		if (attached) {
			runtime.contextPressure = parseContextPressureProjection(attachProjectionValues);
			runtime.contextBreakdown = parseContextBreakdownProjection(attachProjectionValues);
			runtime.usageTotals = parseTokenUsageProjection(attachProjectionValues);
			runtime.sessionStats = parseSessionStatsProjection(attachProjectionValues);
			// attach 初值兜底：list projections.values.todos 是底层完整折叠（和原始文件同源，
			// 但不受 history 尾部截断影响——最早 todo/write 在窗口前也拿得到）。注册 seq
			// 后与 mux 实时帧按 higher-seq-wins 收敛；解析失败保持 history 重放结果。
			const baselineTodos = attachProjectionValues !== null && typeof attachProjectionValues === "object" ? (attachProjectionValues as Record<string, unknown>).todos : undefined;
			const parsedBaselineTodos = parseDshTodoList(baselineTodos);
			if (parsedBaselineTodos !== undefined) runtime.todos = parsedBaselineTodos;
			// agentTeam 投影同样以 list 的完整折叠为 attach 初值（启用实验预设的历史会话
			// 重启后即恢复成员/任务板，不等第一条实时帧）。
			const baselineTeam = attachProjectionValues !== null && typeof attachProjectionValues === "object" ? (attachProjectionValues as Record<string, unknown>).agentTeam : undefined;
			const parsedBaselineTeam = parseDshTeamProjection(baselineTeam);
			if (parsedBaselineTeam !== undefined) runtime.dshTeam = parsedBaselineTeam;
			if (attachProjectionSeq !== undefined && attachProjectionValues !== null && typeof attachProjectionValues === "object") {
				for (const key of DSH_PROJECTION_KEYS) {
					if (Object.prototype.hasOwnProperty.call(attachProjectionValues, key)) {
						runtime.projectionSeq.set(key, attachProjectionSeq);
					}
				}
			}
		}
		// attach 初值同步：host 里已有标题（list 投影）时立即写回 catalog——
		// 否则重启后侧栏一直显示 draft 占位名（如「pi-desktop DSH」）。
		if (hostTitle) {
			this.onTitleChanged?.(sessionId, hostTitle);
		}
		this.runtimes.set(agentId, runtime);
		await this.refreshModelDirectory(runtime, client).catch(() => undefined);
		this.startMux(runtime);
		this.emit(agentEventTags.agentsState, this.list());
		// attach 历史会话：消息/投影已就位，立刻推 runtime，输入框底下就能出「N 轮」。
		this.emitRuntimeState(agentId);
		return tab;
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.runtime(input.agentId);
		// 新一轮开始：Ask 提醒去重复位（同一轮多次提问只提醒一次，跨轮重新提醒）。
		this.notifiedAskAgents.delete(input.agentId);
		const client = this.requireClient();
		// G2：图片附件直接以 PromptContentPart 的 image 块（mediaType + base64 data）
		// 随 prompt 发送——host 受理时自行校验/落盘，无需额外上传端点。
		// 格式非法（非 base64 图片 / 不支持的媒体类型）时整体拒绝，不静默丢图。
		const imageParts: Array<{ type: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string }> = [];
		if (input.images && input.images.length > 0) {
			for (const image of input.images) {
				if (image.type !== "image" || !image.data || !isDshImageMediaType(image.mimeType)) {
					return {
						accepted: false,
						error: "Invalid image attachment",
						delivery: "rejected",
						i18nKey: "session.sendDshImagesUnsupported",
					};
				}
				imageParts.push({ type: "image", mediaType: image.mimeType, data: image.data });
			}
		}
		// 宿主指令仍是 pi 扩展：DSH 没有等价物，显式拒绝。
		if (input.agentMessage) {
			return {
				accepted: false,
				error: "DSH host instructions are not supported",
				delivery: "rejected",
				i18nKey: "session.sendDshUnsupportedPayload",
			};
		}
		const modelDirectory = await this.refreshModelDirectory(runtime, client).catch(() => undefined);
		if (modelDirectory?.result.ok) {
			this.emitRuntimeState(input.agentId);
		}
		if (modelDirectory?.result.ok && modelDirectory.result.value.routable === false) {
			runtime.modelRoutable = false;
			return {
				accepted: false,
				error: "DSH provider route is unavailable",
				delivery: "rejected",
				i18nKey: "session.sendDshModelRouteUnavailable",
			};
		}
		// 复用 composer 的 steer / followUp：host prompt.mode 是 queue|steer。
		// queue = 默认下一轮（followup）；steer = 插入当前回合（dsh-web 手动插入）。
		// slash 命令走 host 命令注册表，mode 无关；命令回合仍须等 idle，避免
		// reject 路径滞留下一条 followup（见 waitForIdle 注释）。
		const mode = input.streamingBehavior === "steer" ? "steer" : "queue";
		// queue 一律等 idle。steer 只在 abort 收尾期等：cancelled 时旧回合还在收口，
		// 立刻插入会被 host 拼进已停止的回合。正常 running 的 steer 必须马上发。
		if (mode === "queue" || runtime.control.cancelled) {
			await this.waitForIdle(input.agentId);
		}
		this.logRpc(input.agentId, "send", "sessions.prompt", {
			message: input.message,
			images: imageParts.length,
			mode,
		});
		const sent = await client.sessionsPrompt({
			sessionId: runtime.sessionId,
			mode,
			content: [{ type: "text", text: input.message }, ...imageParts],
		});
		if (!sent.result.ok) {
			this.logRpc(input.agentId, "recv", "sessions.prompt rejected", sent.result.error);
			// session/writer-held：DSH 每会话跨进程独占写锁（无超时，持有进程退出才释放）。
			// ~/.dsh 与 DeepSeek 桌面版/dsh CLI 共享，那边开着同一会话时 prompt 会被拒——
			// 原始 JSON 对用户不可操作，必须映射为「去那边关闭后重试」的文案。
			if (sent.result.error.code === "session/writer-held") {
				return {
					accepted: false,
					error: JSON.stringify(sent.result.error),
					delivery: "rejected",
					i18nKey: "session.sendDshWriterHeld",
				};
			}
			// 模型输入模态没声明 image：DSH 在准入阶段就拒绝带图消息，请求根本没打到
			// 模型。原始 JSON 对用户不可操作，映射为「去配置页打开输入模态」的文案。
			if (isDshModelImageUnsupportedRejection(sent.result.error)) {
				return {
					accepted: false,
					error: JSON.stringify(sent.result.error),
					delivery: "rejected",
					i18nKey: "session.sendDshModelNoImageInput",
				};
			}
			return { accepted: false, error: JSON.stringify(sent.result.error), delivery: "rejected" };
		}
		this.logRpc(input.agentId, "recv", "sessions.prompt accepted");
		return { accepted: true };
	}

	/**
	 * 等待该 agent 无运行中回合（control 状态 idle）且无未收口的取消。
	 * mux 事件驱动 control 状态机：turn/start → running，turn/end → idle（含命令 reject 的 blocked 收场）。
	 * cancelled 也计入等待：abort 把 status 立即置 idle，但 host 侧旧回合可能仍在收尾
	 * （工具未中断 / cancel 在途），此时发下一条会被 host 当作 followup 拼进旧回合，
	 * 新问题答案串进被停止的输出（「消息串台」）。必须等旧回合 turn/end 收口 cancelled 才放行。
	 * 超时（默认 30s）直接放行，避免 host 卡死把发送永久挂起；放行后由 host 侧
	 * queue 语义兜底（正常回合的 followup 不丢消息，只有 reject 路径才有滞留 bug）。
	 */
	private async waitForIdle(agentId: string, timeoutMs = 30_000): Promise<void> {
		const runtime = this.runtime(agentId);
		const startedAt = Date.now();
		while (runtime.control.status !== "idle" || runtime.control.cancelled) {
			if (Date.now() - startedAt >= timeoutMs) return;
			await new Promise((resolve) => setTimeout(resolve, 100));
		}
	}

	async restart(agentId: string): Promise<AgentTab> {
		// 重启 = 重建运行时投影，但 attach 到同一个 host 会话（会话数据由 $DSH_HOME
		// 持久化）：新建会话会让重启后对话历史「消失」（旧会话被 catalog 换绑丢弃）。
		// 仅当 host 里已不存在该会话（DSH_HOME 被清/更换）才退回新建。
		const old = this.runtime(agentId);
		const { cwd, projectId, title } = old.tab;
		await this.stop(agentId);
		const client = await this.ensureClient();
		let sessionId = old.tab.sessionId;
		if (sessionId) {
			const listed = await client.sessionsList().catch(() => null);
			const exists = listed?.result.ok === true && (listed.result.value.items ?? []).some((item) => item.sessionId === sessionId);
			if (!exists) sessionId = undefined;
		}
		if (!sessionId) {
			const created = await this.createHostSession(client, cwd, old.tab.agentPreset);
			if (!created.ok) {
				throw new Error(`dsh session.create (restart) failed: ${created.error}`);
			}
			sessionId = created.sessionId;
		}
		const dshSessionId = sessionId as SessionId;
		const tab: AgentTab = {
			...old.tab,
			id: agentId,
			projectId,
			cwd,
			title,
			sessionId,
			status: "idle",
			createdAt: Date.now(),
			// attach 同一会话：文件路径不变（沿用旧 id 的 host 会话文件）
			sessionPath: this.dshHost.sessionFilePath(cwd, sessionId),
		};
		const runtime: DshAgentRuntime = {
			tab,
			sessionId: dshSessionId,
			cwd,
			messages: [],
			projection: projectDshEvent(undefined, undefined, agentId),
			isStreaming: false,
			control: initialDshControl(),
			// 会话级数据跨重启保留：上下文占用/构成/轨迹过程事件与 host 会话同生命周期
			// （host 侧投影在 mux 重连后仍会继续推送，attach 初值由 list projections 兜底）。
			projectionSeq: new Map(),
			processEvents: old.processEvents,
			contextPressure: old.contextPressure,
			contextBreakdown: old.contextBreakdown,
			contextWindow: old.contextWindow,
			usageTotals: old.usageTotals,
			sessionStats: old.sessionStats,
			// 重启瞬间先续上旧值：history 补帧成功后被投影结果覆盖；失败也不丢当前计划
			todos: old.todos,
		};
		// 拉历史尾部投影为初始消息（重启后时间线恢复旧对话，同 create attach 路径）
		const history = await this.historyPage(String(dshSessionId), { maxMessages: 200 }).catch(() => null);
		if (history?.result.ok) {
			const entries = (history.result.value.events ?? [])
				.map((entry) => ({ event: entry.event, view: entry.view }))
				.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
				.sort((left: { event: { seq?: number } }, right: { event: { seq?: number } }) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
			this.recordDshHistoryWindow(runtime, entries, history.result.value.hasMore === true);
			for (const { event, view } of entries) {
				runtime.projection = projectDshEvent(runtime.projection, event, agentId, view);
			}
			runtime.messages = runtime.projection.messages;
			runtime.messages = await this.hydrateDshImageRefs(client, dshSessionId, runtime.messages, runtime.hydratedImageRefs);
			runtime.processEvents = collectDshProcessEvents(
				runtime.processEvents,
				entries.map(({ event }) => event),
			);
			// 重启后从历史投影恢复待办计划（todo/write 折叠；与 goal 同源恢复）
			if (runtime.projection.todos !== undefined) runtime.todos = runtime.projection.todos;
			// 尾页 projections baseline 兜底（历史事件窗口截断时仍恢复完整计划）
			this.applyHistoryProjectionBaseline(runtime, history.result.value.projections);
		}
		this.runtimes.set(agentId, runtime);
		await this.refreshModelDirectory(runtime, client).catch(() => undefined);
		this.startMux(runtime);
		this.emit(agentEventTags.agentsState, this.list());
		// 重启后历史已投影：立刻推 runtime，输入框底下就能出「N 轮」。
		this.emitRuntimeState(agentId);
		return tab;
	}

	async stop(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		// 会话停用：会话内查找的历史快照随之作废（真值在 host，重开时按 cursor 重建）。
		if (this.sessionFindCache?.dshSessionId === String(runtime.sessionId)) this.sessionFindCache = undefined;
		// 先取消 host 回合：只断 mux 不解回合，host 仍占着会话，
		// 下一会话 create/attach/selectModel 会落到 SESSION_COMMAND_FAILED。
		await this.abort(agentId).catch(() => undefined);
		// D1/D5：stop 前解阻塞 pending 审批/提问帧——host 侧工具调用在等 client-response，
		// 不应答则回合永不结束；且 runtime 删除后旧弹窗应答（sendUIResponse）会因
		// pendingResponses 已清而 no-op，弹窗残留。这里以拒绝收尾 + 通知渲染层 completed。
		await this.rejectAllPending(agentId).catch(() => undefined);
		this.runtimes.delete(agentId);
		// 本会话的 follow 泵随之终止（避免已删会话空转重连）。
		this.stopFollowPump(agentId);
		// 丢弃该会话的实时日志聚合缓冲（防止残留条目泄给下一次 attach）；观看登记刻意保留——
		// DSH agentId（dsh:<sessionId>）跨 stop/attach 稳定，面板可能跨重启周期保持挂载。
		this.rpcLogLive?.dropPending(agentId);
		// 共享 mux 只在最后一个 runtime 离开时关掉，避免停当前会话把其他会话的流一起掐掉。
		if (this.runtimes.size === 0) this.stopSharedMux();
		this.emit(agentEventTags.agentsState, this.list());
	}

	/** 对全部 pending 审批/提问帧应答「拒绝」并清表（abort/stop 共用，D1/D5）。
	 * 与 pi abort 对每个 pending UI 请求发 value:null 解阻塞同语义。 */
	private async rejectAllPending(agentId: string): Promise<void> {
		if (this.pendingResponses.size === 0) return;
		const runtime = this.runtimes.get(agentId);
		const sessionId = runtime ? String(runtime.sessionId) : undefined;
		const pending = [...this.pendingResponses.entries()].filter(
			([, frame]) =>
				// 无 runtime 时按原语义全清（stop 已删表项的兜底）；有 runtime 只清本会话，
				// 避免停当前会话把其他会话挂起的审批一起拒绝。
				!sessionId || frame.sessionId === sessionId,
		);
		if (pending.length === 0) return;
		const client = this.requireClient();
		for (const [requestId] of pending) this.pendingResponses.delete(requestId);
		for (const [requestId, frame] of pending) {
			this.clearPendingTimeout(requestId);
			const value = buildDshRejectValue(frame);
			await client
				.respond({
					type: "client-response",
					// rpcId 来自 mux 帧（持久化为普通字符串），respond 需要品牌类型：边界一次性转换。
					rpcId: requestId,
					result: { ok: true, value },
				})
				.catch(() => undefined);
			this.emit(agentEventTags.agentsUiRequest, { agentId, requestId, completed: true });
		}
	}

	/** 清除 pending 超时定时器（应答/拒绝/清理时调用）。 */
	private clearPendingTimeout(requestId: string): void {
		const timer = this.pendingTimers.get(requestId);
		if (timer) {
			clearTimeout(timer);
			this.pendingTimers.delete(requestId);
		}
	}

	/** 停掉全部活跃 DSH 会话（host 重启/目录切换前调用）。
	 * 会话数据由 host 持久化在 $DSH_HOME，PiDeck 侧只丢运行时投影；
	 * catalog 保留 dshSessionId，重新打开会话时走 attach 路径恢复。 */
	async stopAll(): Promise<void> {
		const agentIds = [...this.runtimes.keys()];
		for (const agentId of agentIds) {
			await this.stop(agentId);
		}
	}

	/**
	 * DSH 会话历史分页统一入口（契约收口，见 docs/dsh-remote-contract.md）。
	 *
	 * `session/page` 的 throughSeq 是「包含式日志切点」，必须 ≤ 会话当前 cursor；
	 * 旧实现固定送 MAX_SAFE_INTEGER，恒被 host 拒绝（gateway/bad-request）——这就是
	 * 0.1.5 升级后「历史会话内容为空」的根因。cursor 由 host 侧冷读 observation 提供
	 * （DshHost.readSessionCursor → pideckSessionBridge，与 page 内部 sourceFor 同一
	 * 数据源、不激活会话、不写投影缓存）；取 cursor 与 page 之间日志只可能增长
	 * （append-only），旧 cursor 仍是合法切点，无需重试。
	 * 桥暂不可用（host 未就绪等）时返回结构化 ok:false，调用方按既有 result.ok 分支处理。
	 */
	private async historyPage(sessionId: string, options: { beforeSeq?: number; maxMessages?: number } = {}): Promise<DshEnvelope<DshHistoryPage>> {
		let throughSeq: number;
		try {
			throughSeq = await this.dshHost.readSessionCursor(sessionId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			getAppLogger()?.warn("dsh-agent", "history cursor unavailable, page skipped", { sessionId, error: message });
			return {
				result: {
					ok: false,
					error: { code: "host-unavailable", message: `DSH session cursor unavailable: ${message}`, details: {} },
				},
			};
		}
		return this.requireClient().sessionsHistory({ sessionId, throughSeq, ...options });
	}

	/**
	 * mux 断连重连后的历史补帧（D6）：断连窗口内已完成的回合事件不会重放
	 * （mux 只推实时事件），从 session/page 拉尾部，按 seq 跳过已投影事件，
	 * 只补缺失部分。失败不阻断（下一条消息会正常激活 host 侧 agent）。
	 */
	private async backfillHistory(runtime: DshAgentRuntime): Promise<void> {
		try {
			const client = this.requireClient();
			const history = await this.historyPage(String(runtime.sessionId), { maxMessages: 200 }).catch(() => null);
			if (!history?.result.ok) return;
			const entries = (history.result.value.events ?? [])
				.map((entry) => ({ event: entry.event, view: entry.view }))
				.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
				.sort((left: { event: { seq?: number } }, right: { event: { seq?: number } }) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
			let projection = runtime.projection;
			let lastSeq = runtime.lastProjectedSeq ?? 0;
			const freshEvents: Array<{ type?: string; seq?: number; data?: unknown; time?: unknown }> = [];
			for (const { event, view } of entries) {
				const seq = typeof event?.seq === "number" ? event.seq : 0;
				if (seq <= lastSeq) continue;
				projection = projectDshEvent(projection, event, runtime.tab.id, view);
				freshEvents.push(event);
				if (seq > lastSeq) lastSeq = seq;
			}
			runtime.projection = projection;
			runtime.messages = projection.messages;
			runtime.messages = await this.hydrateDshImageRefs(client, runtime.sessionId, runtime.messages, runtime.hydratedImageRefs);
			runtime.lastProjectedSeq = lastSeq;
			runtime.goal = projection.goal;
			// 断连窗口内的 todo/write 折叠一并补账（history 尾部重放；standing plan 语义）
			if (projection.todos !== undefined) runtime.todos = projection.todos;
			// 尾页 projections baseline：断连窗口内可能缺 todo 事件帧，baseline 完整兜底
			this.applyHistoryProjectionBaseline(runtime, history.result.value.projections);
			// 断连窗口内的过程事件（modelChange/权限/plan/压缩）一并补账
			runtime.processEvents = collectDshProcessEvents(runtime.processEvents, freshEvents);
			this.emitMessages(runtime);
			this.emitRuntimeState(runtime.tab.id);
		} catch (error) {
			getAppLogger()?.warn("dsh-agent", "mux backfill failed", {
				sessionId: String(runtime.sessionId),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	/**
	 * host 崩溃自动重启完成后的恢复（E4）：
	 * - 重置所有 runtime 的运行态（isStreaming/isCompacting/executingTool/control/thinking）：
	 *   host 内存已丢失，mux 重连后新 host 没有已订阅会话、旧回合事件不会再推，
	 *   UI 不能停在「运行中/压缩中/工具执行中」；
	 * - 重新拉 history 尾部补齐投影（断连窗口内可能缺帧，恢复到最近的完整历史）；
	 * - 推送 agentsState / messages / runtime state，渲染层即时刷新。
	 * 会话数据由 $DSH_HOME 持久化；用户下一条消息 prompt 会重新激活 host 侧 agent。
	 */
	private async recoverAfterHostRestart(): Promise<void> {
		for (const runtime of this.runtimes.values()) {
			const agentId = runtime.tab.id;
			// host 崩溃时在跑的回合不可能再有事件：记下来，恢复完用正文通道收口。
			// 不收口时渲染层 live 槽与 Web SSE（turnEnded → finish + [DONE]）会永远停在「运行中」。
			const wasStreaming = runtime.isStreaming === true;
			try {
				const client = this.requireClient();
				runtime.isStreaming = false;
				runtime.isCompacting = false;
				runtime.executingTool = undefined;
				runtime.control = initialDshControl();
				runtime.thinkingId = undefined;
				runtime.thinkingStartedAt = undefined;
				runtime.projectionSeq.clear();
				const history = await this.historyPage(String(runtime.sessionId), { maxMessages: 200 }).catch(() => null);
				if (history?.result.ok) {
					const entries = (history.result.value.events ?? [])
						.map((entry) => ({ event: entry.event, view: entry.view }))
						.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
						.sort((left: { event: { seq?: number } }, right: { event: { seq?: number } }) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
					this.recordDshHistoryWindow(runtime, entries, history.result.value.hasMore === true);
					let projection = projectDshEvent(undefined, undefined, agentId);
					for (const { event, view } of entries) {
						projection = projectDshEvent(projection, event, agentId, view);
					}
					runtime.projection = projection;
					runtime.messages = projection.messages;
					runtime.messages = await this.hydrateDshImageRefs(client, runtime.sessionId, runtime.messages, runtime.hydratedImageRefs);
					// 恢复后推进 lastProjectedSeq（D6 重连补帧跳过基准）。
					const lastEntry = entries[entries.length - 1];
					if (lastEntry && typeof lastEntry.event.seq === "number") {
						runtime.lastProjectedSeq = lastEntry.event.seq;
					}
					runtime.goal = runtime.projection.goal;
					// 待办计划随恢复重放补齐（host 崩溃窗口内的 todo/write 事件）
					if (runtime.projection.todos !== undefined) runtime.todos = runtime.projection.todos;
					// 尾页 projections baseline 兜底（新 host 的 registry 折叠与窗口无关）
					this.applyHistoryProjectionBaseline(runtime, history.result.value.projections);
					// 过程事件随恢复重放补齐（host 崩溃窗口内的 modelChange/权限/plan 记录）
					runtime.processEvents = collectDshProcessEvents(
						runtime.processEvents,
						entries.map(({ event }) => event),
					);
				}
				await this.refreshModelDirectory(runtime, client).catch(() => undefined);
				if (wasStreaming) {
					this.emit(agentEventTags.agentsTextStream, {
						agentId,
						text: lastAssistantText(runtime.messages),
						done: true,
						turnEnded: true,
					});
				}
				this.emit(agentEventTags.agentsState, this.list());
				this.emitMessages(runtime);
				this.emitRuntimeState(agentId);
			} catch (error) {
				// 单个会话恢复失败不阻断其余会话；下一条用户消息仍会重新激活。
				getAppLogger()?.warn("dsh-agent", `host restart recovery failed for ${agentId}`, {
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}

	/**
	 * 可见性补帧：主窗口切到本会话时补一帧全量 live 正文/思考。
	 * 后台期间主进程不发 live 增量（见 sessions/visibleSessionRegistry.ts）；DSH 的
	 * live 事件本身就是全量文本，用当前投影补即可，运行态与消息快照不受影响。
	 */
	emitLiveSnapshot(agentId: string): void {
		const runtime = this.runtimes.get(agentId);
		if (!runtime || runtime.tab.status === "closed" || runtime.tab.status === "error") return;
		const text = runtime.projection.pendingAssistantText ?? "";
		if (text) this.emit(agentEventTags.agentsTextStream, { agentId, text, done: false });
		const thinking = reasoningText(runtime.projection.pendingAssistantThinking);
		if (runtime.thinkingId && thinking) {
			this.emit(agentEventTags.agentsThinking, {
				agentId,
				id: runtime.thinkingId,
				text: thinking,
				startedAt: runtime.thinkingStartedAt ?? 0,
				done: false,
			});
		}
	}

	async abort(agentId: string): Promise<void> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		// 先抬世代再 cancel：mux 里迟到的 chunk/turn/start 必须丢掉，否则停止按钮会一直亮。
		// turn/end 时 control.cancelled 已被复位，完成信号要单独记「本轮是用户停的」；
		// 只在确实有活动回合时置位（idle 下点停止不能污染下一轮的完成信号）。
		const hadActiveTurn = runtime.control.status === "running" || runtime.control.isStreaming;
		this.applyControl(runtime, beginDshCancel(runtime.control));
		if (hadActiveTurn) runtime.userStoppedTurn = true;
		// 立即收口思考流：停止后旧回合的 reasoning 残留帧会被 cancelled 守卫丢弃，
		// Live 思考块不能等 turn/end（可能迟到/缺失），否则「停止后思考还在转」。
		if (runtime.thinkingId) {
			this.emit(agentEventTags.agentsThinking, {
				agentId: runtime.tab.id,
				id: runtime.thinkingId,
				text: "",
				startedAt: runtime.thinkingStartedAt ?? 0,
				endedAt: Date.now(),
				done: true,
			});
			runtime.thinkingId = undefined;
			runtime.thinkingStartedAt = undefined;
		}
		// D1：abort 必须解阻塞 pending 审批/提问帧——host 侧工具调用在等 client-response，
		// 不应答则回合永不结束（后续发送被 waitForIdle 卡满 30s），Ask 弹窗残留。
		await this.rejectAllPending(agentId).catch(() => undefined);
		this.logRpc(agentId, "send", "sessions.cancel");
		await client.sessionsCancel({ sessionId: runtime.sessionId }).catch(() => undefined);
		this.logRpc(agentId, "recv", "sessions.cancel done");
		// 停止时立刻收口正文通道：带上已累积字，避免空 done 把屏幕抹空白。
		// turnEnded 标记「这一轮真的结束了」：Web SSE 靠它产出 finish/[DONE]（停止后
		// useChat 的 status 才能从 streaming 收回 ready；desktop 渲染层不读该字段）。
		this.emit(agentEventTags.agentsTextStream, {
			agentId: runtime.tab.id,
			text: lastAssistantText(runtime.messages) || runtime.projection.pendingAssistantText || "",
			done: true,
			turnEnded: true,
		});
		this.emitRuntimeState(agentId);
		this.emit(agentEventTags.agentsState, this.list());
	}

	async rename(agentId: string, name: string): Promise<AgentTab> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const renamed = await client.sessionsRename({ sessionId: runtime.sessionId, title: name });
		if (renamed.result.ok) {
			runtime.tab.title = renamed.result.value.title;
			this.emit(agentEventTags.agentsState, this.list());
			this.onTitleChanged?.(String(runtime.sessionId), runtime.tab.title);
		}
		return runtime.tab;
	}

	async compact(agentId: string, prompt?: string): Promise<AgentRuntimeState> {
		// DSH 的压缩走 host 侧 /compact 命令注册表（dsh-command-compact），
		// wire 上没有显式 compact RPC（计划 D11）：以 queue 提示词触发，随后返回当前 runtime 状态。
		const runtime = this.runtime(agentId);
		// 与 pi 一致：压缩中拒绝重复请求，避免第二次 /compact 拼进命令回合。
		if (runtime.isCompacting) {
			throw new Error("already compacting");
		}
		const client = this.requireClient();
		// 与 sendPrompt 同一串行化约束：上一回合（含命令回合）idle 后才发 /compact，
		// 避免压缩指令被 host 拼进运行中回合（D4）。
		await this.waitForIdle(agentId);
		const commandText = prompt && prompt.trim() ? `/compact ${prompt.trim()}` : "/compact";
		const sent = await client.sessionsPrompt({
			sessionId: runtime.sessionId,
			mode: "queue",
			content: [{ type: "text", text: commandText }],
		});
		if (!sent.result.ok) {
			throw new Error(`dsh /compact failed: ${JSON.stringify(sent.result.error)}`);
		}
		// 压缩进行态：turn/end（命令回合收口）到达后由 mux 复位（D4）。
		runtime.isCompacting = true;
		this.emitRuntimeState(agentId);
		return this.getRuntimeState(agentId);
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		return buildDshRuntimeState(this.runtime(agentId));
	}

	/**
	 * host 会话当前模型/档位（投影 `modelSelection.next ?? lastUsed`，attach/切换时由
	 * refreshModelDirectory 同步到 runtime）。
	 *
	 * 供 SessionRuntimeCoordinator 判断「catalog 偏好是否已在 host 生效」：DSH 的
	 * session/selectModel 会把选择同时保存成部署默认模型（agentDefaultModel.saveSelection），
	 * 只要偏好已生效就不该在每次激活/重启时重放，否则「打开/切换 DSH 会话」会改写全局默认。
	 * 与 pi 的 getRuntimeModelThinkingState 不同：这里不发 get_state（DSH 的状态来自投影）。
	 */
	async getRuntimeModelThinkingState(agentId: string): Promise<SessionRuntimeModelSelection | undefined> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime?.model) return undefined;
		return {
			provider: runtime.model.provider,
			modelId: runtime.model.model,
			modelName: runtime.model.model,
			...(runtime.thinkingLevel !== undefined ? { thinkingLevel: runtime.thinkingLevel } : {}),
		};
	}

	/**
	 * 冷读 host 会话的当前模型选择（session/projections 的 modelSelection.next ?? lastUsed）。
	 *
	 * 用途：历史/外部 DSH 会话的模型只存在 host 投影里，PiDeck catalog 可能从未写过
	 * model；打开会话读历史时补录 catalog，底栏/选择器才不会回退到全局部署默认
	 * （见 dshSessionModelSync.ts 的线上案例）。只读：不激活会话、不写 host。
	 * host 未就绪时直接返回 undefined——纯展示补录不得为浏览会话主动拉起 host。
	 */
	async readSessionModelSelection(dshSessionId: string): Promise<{ provider: string; model: string; reasoningEffort?: string } | undefined> {
		if (!dshSessionId || !this.dshHost.isHostReady()) return undefined;
		const client = this.dshHost.getClient();
		if (!client) return undefined;
		try {
			const projection = await client.sessionsProjections({ sessionId: dshSessionId as SessionId });
			if (!projection.result.ok) return undefined;
			const value = projection.result.value;
			if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
			const values = (value as { values?: unknown }).values;
			if (!values || typeof values !== "object" || Array.isArray(values)) return undefined;
			const selection = readDshModelSelection((values as Record<string, unknown>).modelSelection);
			if (!selection) return undefined;
			return { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort !== undefined ? { reasoningEffort: selection.reasoningEffort } : {}) };
		} catch (error) {
			// 投影版本不兼容/会话不存在等：展示补录失败不能影响会话本身。
			getAppLogger()?.warn("dsh-agent", "session model selection unavailable", {
				sessionId: dshSessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	/** 轨迹过程事件（G-context）：实现在 manager/dshHistoryReads（运行时缓存与 history 尾部派生）。 */
	async readProcessEvents(agentId: string | undefined, dshSessionId: string | undefined): Promise<{ events: SessionProcessEvent[]; fromStart: boolean; unavailable?: boolean }> {
		return readDshProcessEvents(this.historyReadHost, agentId, dshSessionId);
	}

	/** 历史分页（D04）：实现在 manager/dshHistoryReads（seq 游标 + 轮分页预算）。 */
	async readHistoryPage(dshSessionId: string, beforeSeq: number | undefined, options: { turnCount?: number; maxMessages?: number } = {}): Promise<{ messages: ChatMessage[]; total: number; nextBefore: number | null }> {
		return readDshHistoryPage(this.historyReadHost, dshSessionId, beforeSeq, options);
	}

	/**
	 * 会话内查找（Ctrl/Cmd+Shift+F）的 DSH 实现：把整段 host 会话历史投影成消息后做
	 * 词元匹配（纯匹配逻辑与 pi 的 Go sidecar 同语义，见 dshSessionFind）。
	 *
	 * 为什么走 host 而不是读磁盘：DSH 会话日志是 zstd 压缩的分帧 JSONL，磁盘路径上
	 * 没有投影后的消息 id/角色；host 的 session/page + 投影器是唯一权威口径，命中
	 * 返回的 `dsh:<seq>` 也正好是时间线节点的 id（jumpToMessage 直接可用）。
	 * 失败（host 未就绪/runtime 缺失/桥不可用）由调用方（sessionIpc）降级成 null。
	 * 分页上限与 HTML 导出同口径（EXPORT_MAX_HISTORY_PAGES × 500 事件）：极端超长会话
	 * 只覆盖最近约 5 万条事件，不会为了「搜到第一条」把整段日志读进内存。
	 */
	async searchSessionMessages(dshSessionId: string, query: string, limit = DSH_SESSION_FIND_MAX_MATCHES): Promise<DshSessionFindResult> {
		const trimmed = query.trim();
		if (!trimmed || !dshSessionId) return { matches: [], hitCount: 0 };
		const messages = await this.searchSessionMessagesSnapshot(dshSessionId);
		return findDshSessionMatches(messages, trimmed, limit);
	}

	/**
	 * 查找用的历史快照：同一 cursor 直接复用（逐字输入不重走分页），cursor 前进或
	 * 缓存过期才重建。cursor 读不到（桥未挂载/冷启动）时退化为每次重读，不做缓存——
	 * 拿不到失效信号就缓存会把「刚发出去的消息」永久排除在搜索之外。
	 */
	private async searchSessionMessagesSnapshot(dshSessionId: string): Promise<ChatMessage[]> {
		// cursor 与分页都要 host：先确保拉起（历史会话首次搜索可能 host 还没启动）。
		await this.ensureClient();
		const cursor = await this.readSessionFindCursor(dshSessionId);
		const cached = this.sessionFindCache;
		if (cursor !== undefined && cached && cached.dshSessionId === dshSessionId && cached.cursor === cursor && cached.expiresAt > Date.now()) {
			return cached.messages;
		}
		const messages = await this.buildSessionFindSnapshot(dshSessionId);
		if (cursor !== undefined) {
			this.sessionFindCache = { dshSessionId, cursor, messages, expiresAt: Date.now() + DshAgentManager.SESSION_FIND_CACHE_TTL_MS };
		}
		return messages;
	}

	/** 同会话的快照构建只跑一遍：并发检索共享同一个 Promise（失败同步给所有等待方）。 */
	private buildSessionFindSnapshot(dshSessionId: string): Promise<ChatMessage[]> {
		const existing = this.sessionFindInflight.get(dshSessionId);
		if (existing) return existing;
		const promise = this.collectAllDshSessionMessages(dshSessionId).finally(() => {
			if (this.sessionFindInflight.get(dshSessionId) === promise) this.sessionFindInflight.delete(dshSessionId);
		});
		this.sessionFindInflight.set(dshSessionId, promise);
		return promise;
	}

	/** 冷读会话日志 cursor；失败返回 undefined（调用方据此关闭缓存，不阻断搜索）。 */
	private async readSessionFindCursor(dshSessionId: string): Promise<number | undefined> {
		try {
			return await this.dshHost.readSessionCursor(dshSessionId);
		} catch (error) {
			getAppLogger()?.warn("dsh-agent", "session find cursor unavailable", {
				sessionId: dshSessionId,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	private syncModelDirectoryState(runtime: DshAgentRuntime, models: { current: { provider: string; model: string; reasoningEffort?: string }; routable: boolean }): void {
		runtime.modelRoutable = models.routable;
		runtime.model = { provider: models.current.provider, model: models.current.model };
		runtime.thinkingLevel = models.current.reasoningEffort;
	}

	private async refreshModelDirectory(runtime: DshAgentRuntime, client: import("./dshRemoteClient").DshRemoteClient) {
		const listed = await client.sessionsModelCatalog();
		if (!listed.result.ok) return { result: listed.result };
		const projection = await client.sessionsProjections({ sessionId: runtime.sessionId });
		if (!projection.result.ok) throw new Error(`dsh model selection unavailable: ${projection.result.error.message}`);
		// 0.2 将会话选择从目录拆到投影；只有未配置会话才用 host 默认值。
		const value = { ...listed.result.value, ...resolveDshModelDirectory(listed.result.value, projection.result.value) };
		this.syncModelDirectoryState(runtime, value);
		return { result: { ok: true, value } } as const;
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const models = await this.refreshModelDirectory(runtime, client);
		if (!models.result.ok) {
			throw new Error(`dsh sessions.models failed: ${models.result.error.code}: ${models.result.error.message}`);
		}
		// 选择器打开时同步 host 当前选择和 routable，目录成员资格仍只用于展示。
		this.emitRuntimeState(agentId);
		return toDshAvailableModels(models.result.value.groups ?? []);
	}

	/**
	 * 会话命令列表（D15）：经 pideck-command-bridge 枚举 host 命令注册表
	 * （ctx.commands.list(agent)），Composer `/` 补全据此展示 live 命令
	 * （含用户/插件注册的命令）。会话未激活时桥报错上抛，渲染层按能力
	 * 降级为静态建议列表（DSH_COMMAND_SUGGESTIONS）。
	 */
	async listCommands(agentId: string): Promise<PiCommand[]> {
		const runtime = this.runtime(agentId);
		const views = await this.dshHost.listCommands(String(runtime.sessionId));
		return views.map((view) => ({
			name: view.name,
			description: view.description,
			source: "dsh",
		}));
	}

	/**
	 * SessionAgentGateway.getCommands（可选能力 getCommands）：`listCommands` 的别名。
	 *
	 * 必须显式声明：`capabilities` 里已登记 "getCommands"（否则 CompositeAgentGateway
	 * 直接拒绝），但网关调用的是 **getCommands**，只实现 listCommands 会让
	 * `gateway.getCommands!(id)` 抛 TypeError——渲染层的命令白名单恒为空，
	 * 表现为「DSH 历史里的 `/命令` 不出 chip、`/` 菜单只有静态建议」。
	 * ACP 同样是 listCommands + 这个别名（AcpAgentManager.getCommands），DSH 此前漏了。
	 */
	async getCommands(agentId: string): Promise<PiCommand[]> {
		return this.listCommands(agentId);
	}

	// ── 会话 HTML 导出（G10：投影式导出，DSH wire 无 export_html）─────────────

	/** 活跃会话导出（实现在 manager/dshSessionExport）。 */
	async exportHtml(agentId: string): Promise<{ path: string; truncated: boolean }> {
		return exportDshAgentHtml(this.sessionExportHost, agentId);
	}

	/** 历史会话导出（实现在 manager/dshSessionExport）。 */
	async exportSessionHtml(dshSessionId: string, title: string, cwd?: string): Promise<{ path: string; truncated: boolean }> {
		return exportDshSessionHtml(this.sessionExportHost, dshSessionId, title, cwd);
	}

	/** 只读导出源（实现在 manager/dshSessionExport）。 */
	public async readSessionExportMessages(dshSessionId: string, options: { includeImages: boolean }): Promise<{ messages: ChatMessage[]; truncated: boolean }> {
		return readDshSessionExportMessages(this.sessionExportHost, dshSessionId, options);
	}

	/** 会话查找复用同一收集器，不回填图片，保持搜索签名与附件传输开销不变。 */
	private async collectAllDshSessionMessages(dshSessionId: string): Promise<ChatMessage[]> {
		return (await this.readSessionExportMessages(dshSessionId, { includeImages: false })).messages;
	}

	async prepareResendFromMessage(agentId: string, messageId: string): Promise<{ text: string; images?: ImageContent[] }> {
		const message = this.runtime(agentId).messages.find((item) => item.id === messageId);
		if (!message) throw new Error(`Message not found: ${messageId}`);
		// G2：图片消息重发时带回图片（渲染层附件栏恢复）
		return {
			text: message.text,
			...(message.images && message.images.length > 0 ? { images: message.images } : {}),
		};
	}

	/**
	 * 「查看完整输出」：DSH 会话没有 pi 会话文件可定位（pi 走 SessionFileEditor 文件路径），
	 * 工具结果全文随投影消息保存在 meta.fullText（dshEventProjector tool/result 分支写入），
	 * 这里直接从运行时消息返回；历史会话（未激活）不在此列，由 readDshHistoryPage 路径覆盖。
	 */
	async readMessageFullText(agentId: string, messageId: string): Promise<{ text: string }> {
		const runtime = this.runtime(agentId);
		const message = runtime.messages.find((item) => item.id === messageId);
		if (!message) throw new Error(`Message not found: ${messageId}`);
		const fullText = typeof message.meta?.fullText === "string" ? message.meta.fullText : message.text;
		return { text: fullText };
	}

	/** 创建目标（G5）：objective 必填；maxGoalRounds 缺省由 host 服务配置解析。 */
	async createGoal(agentId: string, objective: string, maxGoalRounds?: number): Promise<void> {
		const trimmed = objective.trim();
		if (!trimmed) throw new Error("Goal objective is required");
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const created = await client.goalsCreate({
			sessionId: runtime.sessionId,
			objective: trimmed,
			...(typeof maxGoalRounds === "number" ? { maxGoalRounds } : {}),
		});
		if (!created.result.ok) {
			throw new Error(`dsh goal.create failed: ${JSON.stringify(created.result.error)}`);
		}
	}

	/** 目标操作（G5）：pause/resume/complete/clear，按当前 goal 的 CAS ref 提交。 */
	async goalAction(agentId: string, action: "pause" | "resume" | "complete" | "clear"): Promise<void> {
		const runtime = this.runtime(agentId);
		const goal = runtime.goal;
		if (!goal) throw new Error("No active goal");
		const client = this.requireClient();
		// goal.refId 是投影持久化的普通字符串，host API 需要品牌类型：边界一次性转换（同 SessionId 模式）。
		const ref = {
			id: goal.refId as import("@deepseek-ai/dsh-goal/types").GoalId,
			revision: goal.revision,
		};
		const request = {
			sessionId: runtime.sessionId,
			ref,
		};
		const result = action === "pause" ? await client.goalsPause(request) : action === "resume" ? await client.goalsResume(request) : action === "complete" ? await client.goalsComplete(request) : await client.goalsClear({ sessionId: runtime.sessionId, ref });
		if (!result.result.ok) {
			throw new Error(`dsh goal.${action} failed: ${JSON.stringify(result.result.error)}`);
		}
	}

	/**
	 * 取消 DSH host 侧排队消息（`session/updateQueue` 的 remove）。
	 * 不 waitForIdle：排队项的存在意义就是运行中可撤回，等 idle 反而错过窗口；
	 * 与 host 消费赛跑时对 queue-item-not-found 幂等成功（目标已不在队列，结果等价）。
	 */
	async cancelQueuedMessage(agentId: string, itemId: string): Promise<void> {
		if (typeof itemId !== "string" || itemId === "") throw new Error("Queue item id is required");
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const result = await client.sessionUpdateQueue({
			sessionId: runtime.sessionId,
			itemId,
			action: { kind: "remove" },
		});
		if (!result.result.ok) {
			const error = result.result.error as { code?: unknown } | undefined;
			if (error && typeof error === "object" && error.code === "session/queue-item-not-found") return;
			throw new Error(`dsh updateQueue failed: ${JSON.stringify(result.result.error)}`);
		}
	}

	/** 子代理列表（G6）：subagent.list 直接子代目录（不激活双方）。 */
	async listSubagents(agentId: string): Promise<
		Array<{
			id: string;
			label?: string;
			activity: "running" | "inactive";
			hasChildren: boolean;
			mode: "one-shot" | "continuable";
			kind: "child" | "diagnostic";
		}>
	> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const listed = await client.subagentsList({ parentSessionId: runtime.sessionId });
		if (!listed.result.ok) return [];
		return listed.result.value.entries;
	}

	/** 子代理历史（G6）：实现在 manager/dshHistoryReads。 */
	async readSubagentHistory(agentId: string, childSessionId: string, beforeSeq?: number, maxMessages = 100): Promise<DshSubagentTranscriptPage> {
		return readDshSubagentHistory(this.historyReadHost, agentId, childSessionId, beforeSeq, maxMessages);
	}

	/**
	 * 技能目录（G7）：wire `skill.list` 只读清单（按会话项目 cwd 解析的目录）。
	 * 技能经 composer `/name` 斜杠调用（dsh-tool-skill 在 pre-step 注入正文），
	 * 本方法只做呈现数据源，不做技能管理。
	 */
	async listSkills(agentId: string): Promise<DshSkillView[]> {
		const runtime = this.runtime(agentId);
		// 工具面板等既有入口保持「失败返回空列表」的宽容语义（UI 只展示空态）。
		try {
			return await this.listSkillsByHostSession(String(runtime.sessionId));
		} catch {
			return [];
		}
	}

	/**
	 * 按 host 会话 id 列技能（不要求 live agent）。
	 *
	 * host 的 skill.list 只要会话 attached 即可：有 live agent 时用其 preset 的 skill
	 * service，没有时回退全局 skill registry + 会话 preset 的 standing scope
	 * （dsh-host-apiproxy 实际实现，不启动 agent/turn）。草稿会话拿到 host 会话 id 后
	 * 即可在「会话启动前」读目录；`session-not-found` 会带 code 抛给调用方判定
	 * （草稿可以安全换新会话，历史会话不行）。
	 */
	async listSkillsByHostSession(dshSessionId: string): Promise<DshSkillView[]> {
		const client = await this.ensureClient();
		const listed = await client.skillsList({ sessionId: dshSessionId as SessionId });
		if (!listed.result.ok) {
			const error = listed.result.error as { code?: unknown; message?: unknown } | undefined;
			const code = typeof error?.code === "string" ? error.code : "internal";
			const message = typeof error?.message === "string" ? error.message : "skill listing failed";
			throw new DshSkillListError(code, message);
		}
		return toDshSkillViews(listed.result.value.skills);
	}

	/**
	 * 为草稿会话准备一个可读技能目录的 host 会话（不启动 agent）。
	 *
	 * 与 create() 内部建会话同一条 `sessions.create` 路径，保证真正开聊时激活能 attach
	 * 同一个会话（不会另起会话丢历史）；agentPreset 沿用草稿预选，host 可能回退部署
	 * 默认，返回值里的实际 preset 由调用方决定是否回写 catalog。
	 */
	async ensureAttachableHostSession(cwd: string, agentPreset?: string): Promise<{ sessionId: string; agentPreset?: string }> {
		const client = await this.ensureClient();
		const created = await this.createHostSession(client, cwd, agentPreset);
		if (!created.ok) throw new Error(`dsh session.create failed: ${created.error}`);
		return created.agentPreset ? { sessionId: created.sessionId, agentPreset: created.agentPreset } : { sessionId: created.sessionId };
	}

	/** 会话级模型切换（实现在 manager/dshModelControl）。 */
	async setModel(agentId: string, provider: string, modelId: string): Promise<unknown> {
		return setDshModel(this.modelControlHost, agentId, provider, modelId);
	}

	/** 思考档位（实现在 manager/dshModelControl：走 selectModel.reasoningEffort）。 */
	async setThinking(agentId: string, level: string): Promise<void> {
		return setDshThinking(this.modelControlHost, agentId, level);
	}

	/**
	 * 会话保存的模型偏好被 host 拒绝时的用户提示（issue #253 的「选了但没生效」）。
	 *
	 * 引导页/草稿期的 DSH 点选已作为显式 model 传给 host（sessions.selectModel）；
	 * host 是模型与档位能力的最终裁决者，拒绝时 applyPreferences 会降级到部署默认并
	 * 保留 catalog 偏好——但不告知的话，用户会看到底栏显示自己选的模型，实际跑的却是
	 * 另一个模型（比修复前的「选不动」更难排查）。
	 *
	 * 为什么用 toast（agentsNotice）而不是像 pi 那样插会话内系统消息：DSH 的
	 * runtime.messages 是 host projection 的整段替换（history/回填等多处
	 * `runtime.messages = projection.messages`），本地插入的消息在下一次投影时会被冲掉；
	 * toast 通道（useSessionRuntimeBridge → showNotice）不依赖消息列表，可靠可见。
	 */
	notifyModelPreferenceIgnored(agentId: string, provider: string, modelId: string): void {
		if (!this.runtimes.has(agentId)) return;
		this.emit(agentEventTags.agentsNotice, {
			agentId,
			i18nKey: "notice.modelPreferenceIgnored",
			kind: "warning",
			duration: 8000,
			// 渲染层 t() 支持 i18nParams？——不支持（bridge 只传 key），所以主文案里不放占位符，
			// 模型身份放进 message 供 i18n 未命中时的兜底显示。
			message: `模型偏好 ${provider}/${modelId} 未能应用（DSH host 未接受），已沿用当前模型。请重新选择。`,
		});
	}

	/** 权限预设切换（实现在 manager/dshModelControl：`/permission` 命令 + 投影落地等待）。 */
	async setPermission(agentId: string, preset: string): Promise<unknown> {
		return setDshPermission(this.modelControlHost, agentId, preset);
	}

	async publishRuntimeState(agentId: string): Promise<void> {
		this.emitRuntimeState(agentId);
	}

	async getForkMessages(agentId: string): Promise<Array<{ entryId: string; text: string }>> {
		// DSH 没有 pi 的 entryId 概念：用用户消息的事件 seq 作为 fork 锚点。
		// entryId 编码为 "seq:<n>"，forkSession 侧解析回 seq（session.fork 的 atSeq）。
		const runtime = this.runtime(agentId);
		return runtime.messages
			.filter((message) => message.role === "user" && message.text.trim().length > 0)
			.map((message) => {
				const seqMatch = /^dsh:(\d+)$/.exec(message.id);
				return {
					entryId: seqMatch ? `seq:${seqMatch[1]}` : "",
					text: message.text,
				};
			})
			.filter((item) => item.entryId.length > 0);
	}

	async forkSession(agentId: string, entryId: string): Promise<{ text?: string }> {
		// DSH fork：session.fork 在 atSeq 处裁剪出新会话，然后把当前 runtime 换绑过去
		// （保留 agentId，模拟 pi /fork 的「当前会话变成 fork 结果」语义）。
		const seqMatch = /^seq:(\d+)$/.exec(entryId);
		const seq = seqMatch ? Number(seqMatch[1]) : NaN;
		// V4 atSeq 包含边界事件；首条用户消息之前至少有 session/create，seq=0
		// 不能减成 -1 或省略成 clone。只接受当前历史里可回填的用户消息。
		if (!Number.isSafeInteger(seq) || seq <= 0 || !this.runtime(agentId).messages.some((message) => message.role === "user" && message.id === `dsh:${seq}`)) {
			throw new Error(`Invalid dsh fork entryId: ${entryId}`);
		}
		return this.replaceWithFork(agentId, seq);
	}

	/** DSH clone = fork 无锚点：wire 语义是复制到源会话最后一个完成的 turn（完整副本）。 */
	async cloneSession(agentId: string): Promise<{ text?: string }> {
		return this.replaceWithFork(agentId, undefined);
	}

	/**
	 * session.fork + 换绑共用流程：fork 出新 host 会话 → 停旧 mux → runtime 换绑
	 * 新会话并拉历史。atSeq=undefined 表示复制完整会话（clone）。
	 */
	private async replaceWithFork(agentId: string, atSeq: number | undefined): Promise<{ text?: string }> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const forked = await client.sessionsFork({
			sessionId: runtime.sessionId,
			// UI 选中的是待编辑消息；包含式截断必须停在它之前，避免重复发送。
			...(atSeq !== undefined ? { atSeq: atSeq - 1 } : {}),
		});
		if (!forked.result.ok) {
			throw new Error(`dsh session.fork failed: ${JSON.stringify(forked.result.error)}`);
		}
		const newSessionId = forked.result.value.sessionId;
		const forkedText = atSeq !== undefined ? runtime.messages.find((message) => message.role === "user" && message.id === `dsh:${atSeq}`)?.text : undefined;
		// 停旧 mux，换绑到新会话并拉历史（fork 会话自带 atSeq 前历史）。
		await this.stop(agentId);
		const tab: AgentTab = {
			...runtime.tab,
			sessionId: newSessionId,
			status: "idle",
			createdAt: Date.now(),
			// fork/clone 产生新 dsh sessionId：会话文件路径同步更新
			sessionPath: this.dshHost.sessionFilePath(runtime.cwd, newSessionId),
		};
		const nextRuntime: DshAgentRuntime = {
			...runtime,
			tab,
			sessionId: newSessionId,
			messages: [],
			projection: projectDshEvent(undefined, undefined, agentId),
			isStreaming: false,
			control: initialDshControl(),
			// fork/clone 是全新 host 会话：过程事件/上下文占用投影/路由容量随旧会话作废，
			// 等 mux 重推（request/context 会重新带 contextWindow）。
			processEvents: [],
			projectionSeq: new Map(),
			contextPressure: undefined,
			contextBreakdown: undefined,
			contextWindow: undefined,
			// 新 host 会话的窗口边界重新按它自己的 attach 页判定（...runtime 会把旧会话的游标带过来）
			historyHasOlder: undefined,
			historyBeforeSeq: undefined,
		};
		const history = await this.historyPage(String(newSessionId), { maxMessages: 200 }).catch(() => null);
		if (history?.result.ok) {
			const entries = (history.result.value.events ?? [])
				.map((entry) => ({ event: entry.event, view: entry.view }))
				.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
				.sort((left: { event: { seq?: number } }, right: { event: { seq?: number } }) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
			this.recordDshHistoryWindow(nextRuntime, entries, history.result.value.hasMore === true);
			for (const { event, view } of entries) {
				nextRuntime.projection = projectDshEvent(nextRuntime.projection, event, agentId, view);
			}
			nextRuntime.messages = nextRuntime.projection.messages;
			nextRuntime.messages = await this.hydrateDshImageRefs(client, newSessionId, nextRuntime.messages, nextRuntime.hydratedImageRefs);
			// fork 会话自带 atSeq 前历史：过程事件一并重放（新会话从零开始收集）
			nextRuntime.processEvents = collectDshProcessEvents(
				nextRuntime.processEvents,
				entries.map(({ event }) => event),
			);
			// 初始 attach 也推进 lastProjectedSeq（D6 重连补帧跳过基准）。
			const lastEntry = entries[entries.length - 1];
			if (lastEntry && typeof lastEntry.event.seq === "number") {
				nextRuntime.lastProjectedSeq = lastEntry.event.seq;
			}
			nextRuntime.goal = nextRuntime.projection.goal;
		}
		this.runtimes.set(agentId, nextRuntime);
		this.startMux(nextRuntime);
		this.emit(agentEventTags.agentsState, this.list());
		this.emitMessages(nextRuntime);
		this.emitRuntimeState(agentId);
		// 返回 fork 点文案（渲染层把它预填到输入框，与 pi 一致；clone 无锚点时为 undefined）
		return { text: forkedText };
	}

	async sendUIResponse(agentId: string, requestId: string, response: SessionUiResponseInput["response"]): Promise<unknown> {
		// DSH 审批/提问桥：把 PiDeck 的 Ask 应答转成 DSH client-response（回显 rpcId）。
		const frame = this.pendingResponses.get(requestId);
		if (!frame) {
			// 未知/已过期的请求：DSH 侧没有对应 server-request，直接 no-op。
			return { accepted: false, reason: "no-pending-request" };
		}
		const client = this.requireClient();
		const value = buildDshRespondValue(frame, response);
		if (!value) {
			// 应答不可解析（如 batch 答案 JSON 损坏）：按拒绝处理，避免 host 永久挂起。
			this.pendingResponses.delete(requestId);
			this.clearPendingTimeout(requestId);
			this.emit(agentEventTags.agentsUiRequest, { agentId, requestId, completed: true });
			return { accepted: false, reason: "unparseable-response" };
		}
		await client.respond({
			type: "client-response",
			// rpcId 来自 mux 帧（持久化为普通字符串），respond 需要品牌类型：边界一次性转换。
			rpcId: requestId,
			result: { ok: true, value },
		});
		this.pendingResponses.delete(requestId);
		this.clearPendingTimeout(requestId);
		// 通知渲染层请求完成（与 pi 的 agentsUiRequest completed 同协议）
		this.emit(agentEventTags.agentsUiRequest, { agentId, requestId, completed: true });
		return { accepted: true };
	}

	notifyAskPending(agentId: string, sessionId: string, sessionTitle: string, question: string): void {
		// 桌面通知出口由装配层注入（与 pi 同一份门控/toast）；开关关着时不占用每轮去重位。
		if (!this.notify?.askPending) return;
		if (this.notifiedAskAgents.has(agentId)) return;
		if (!this.notify.askPending({ agentId, sessionId, sessionTitle, question })) return;
		this.notifiedAskAgents.add(agentId);
	}

	/** 注册「本轮成功收口」监听器（桌宠 / 完成通知）；返回退订。 */
	onAgentSettled(listener: (info: { agentId: string; title: string }) => void): () => void {
		this.settledListeners.add(listener);
		return () => {
			this.settledListeners.delete(listener);
		};
	}

	private notifyAgentSettled(agentId: string, title: string): void {
		for (const listener of this.settledListeners) {
			try {
				listener({ agentId, title });
			} catch {
				// 订阅者失败不得影响会话收口
			}
		}
	}

	// ── 内部 ───────────────────────────────────────────────────────────────────

	private runtime(agentId: string): DshAgentRuntime {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) throw new Error(`No dsh runtime for agent: ${agentId}`);
		return runtime;
	}

	private requireClient(): import("./dshRemoteClient").DshRemoteClient {
		const client = this.dshHost.getClient();
		if (!client) throw new Error("DSH host is not started");
		return client;
	}

	/**
	 * 新建 host 会话并挂到 cwd 对应 workspace：sessions.create 只在传入
	 * workspaceId 时把会话计入 workspace（dsh-web 按 workspace 分组展示；
	 * 不挂 = dsh-web「未分组」）。
	 * 契约约束：payload 的 workspaceId 与 cwd **二选一**（host schema
	 * `.refine(workspaceId === undefined || cwd === undefined)`，同传会被
	 * bad-request 拒绝）——有 workspaceId 时省略 cwd（workspace 路径即 cwd）。
	 * 禁止降级为只传 cwd：官方规则里 cwd-only 会话永远留在 dsh-web「未分组」，
	 * 会污染第三方客户端的分组视图。解析失败就让创建失败，由调用方重试/报错。
	 * agentPreset（可选）：会话「模式」草稿期预选，随 create 提交给 host 解析并持久化。
	 */
	private async createHostSession(
		client: import("./dshRemoteClient").DshRemoteClient,
		cwd: string,
		/** DSH agent 预设（会话「模式」）草稿期预选；缺省让 host 用部署默认。 */
		agentPreset?: string,
	): Promise<{ ok: true; sessionId: string; agentPreset?: string } | { ok: false; error: string }> {
		try {
			const workspaceId = await this.dshHost.resolveWorkspaceId(cwd);
			if (workspaceId === undefined) {
				return {
					ok: false,
					error: `workspace.resolve failed for cwd: ${cwd}`,
				};
			}
			// sessions.create 接受 agentPreset：host 解析（预选无效 id 会 agent-preset-not-found）
			// 并把解析后的 id 持久化到会话 header——preset 决定会话的工具与提示，创建即固定。
			const created = await client.sessionsCreate(agentPreset ? { workspaceId, agentPreset } : { workspaceId });
			if (!created.result.ok) {
				return { ok: false, error: JSON.stringify(created.result.error) };
			}
			return {
				ok: true,
				sessionId: created.result.value.sessionId,
				...(created.result.value.agentPreset ? { agentPreset: created.result.value.agentPreset } : {}),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async ensureClient(): Promise<import("./dshRemoteClient").DshRemoteClient> {
		await this.dshHost.ensureStarted();
		return this.requireClient();
	}

	/**
	 * 把 DSH 历史里的 durable image refs 回填成 ChatMessage.images（实现在 manager/dshImageHydration）。
	 * @param attempted 运行时复用集合，避免 mux 每帧对同一 ref 重复 RPC。
	 */
	private async hydrateDshImageRefs(client: import("./dshRemoteClient").DshRemoteClient, sessionId: SessionId, messages: ChatMessage[], attempted?: Set<string>): Promise<ChatMessage[]> {
		return hydrateDshImageRefsOnMessages(client, sessionId, messages, attempted);
	}

	/** 运行时版：拉取后若消息有变化则重推 agentsMessage（实时 mux 中图片后到）。 */
	private async hydrateRuntimeDshImages(runtime: DshAgentRuntime): Promise<void> {
		try {
			const client = this.requireClient();
			const attempted = (runtime.hydratedImageRefs ??= new Set<string>());
			const snapshot = runtime.messages;
			const updated = await this.hydrateDshImageRefs(client, runtime.sessionId, snapshot, attempted);
			const merged = runtime.messages === snapshot ? updated : mergeDshHydratedMessages(runtime.messages, updated);
			if (merged !== runtime.messages) {
				runtime.messages = merged;
				this.emitMessages(runtime);
			}
		} catch (error) {
			getAppLogger()?.warn("dsh-agent", "runtime image hydration failed", {
				agentId: runtime.tab.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private emitRuntimeState(agentId: string): void {
		void this.getRuntimeState(agentId)
			.then((state) => {
				this.emit(agentEventTags.agentsRuntimeState, { agentId, state });
			})
			.catch(() => undefined);
	}

	/** `session.history` 尾页 projections baseline 入口（语义见 applyDshProjectionBaseline）。 */
	private applyHistoryProjectionBaseline(runtime: DshAgentRuntime, projections: unknown): void {
		applyDshHistoryProjectionBaseline(this.muxFrameHost, runtime, projections);
	}

	private applyControl(runtime: DshAgentRuntime, next: DshControlState): void {
		const statusChanged = runtime.tab.status !== next.status;
		runtime.control = next;
		runtime.isStreaming = next.isStreaming;
		if (statusChanged) {
			runtime.tab.status = next.status;
			this.emit(agentEventTags.agentsState, this.list());
		}
	}

	/**
	 * 运行时消息窗口（SessionAgentGateway 可选能力；emitReplacementState 消费）：
	 * DSH 的 attach 只取尾部 200 条消息事件，窗口前的历史由渲染层「加载更多对话」补页。
	 * 渲染层窗口协议只有 windowStart（数字）与 windowStartFilePos（数值游标）两个槽位，
	 * 且 cardCount = len − totalLength + windowStart：这里用「有更早历史 = 1」的标记值，
	 * 并让 totalLength 同步 +1，cardCount 仍为 0（增量 flush 偏移不受影响，DSH 也不发增量）。
	 * windowStartFilePos 放窗口最旧事件 seq——readRecordMessagePage 的 before 会原样透传给
	 * session/page 的 beforeSeq，正是 DSH 的分页游标。
	 */
	private historyWindowFields(runtime: DshAgentRuntime): { totalLength: number; windowStart?: number; windowStartFilePos?: number } {
		return dshRuntimeWindowFields({ messageCount: runtime.messages.length, historyHasOlder: runtime.historyHasOlder, historyBeforeSeq: runtime.historyBeforeSeq });
	}

	/** 运行时消息窗口快照（emitReplacementState 用；与 emitMessages 同一窗口口径）。 */
	getMessageWindow(agentId: string): { messages: ChatMessage[]; totalLength: number; windowStart?: number; windowStartFilePos?: number } {
		const runtime = this.runtime(agentId);
		return { messages: runtime.messages, ...this.historyWindowFields(runtime) };
	}

	private emitMessages(runtime: DshAgentRuntime): void {
		// 经计量口投递（Phase 0，PIDECK_PERF_LOG=1 时才记录）：DSH 本就窗口化，作对照基线。
		emitAgentMessageMeasured(
			"dsh",
			runtime.tab.id,
			{
				agentId: runtime.tab.id,
				messages: runtime.messages,
				...this.historyWindowFields(runtime),
			},
			(payload) => this.emit(agentEventTags.agentsMessage, payload),
		);
	}

	/** 记录 attach 窗口的「窗口前还有更早历史」信息（判定规则见 resolveDshHistoryWindow）。 */
	private recordDshHistoryWindow(runtime: DshAgentRuntime, entries: ReadonlyArray<{ event: DshHistoryEntry["event"] }>, hasMore: boolean): void {
		const window = resolveDshHistoryWindow(entries, hasMore);
		runtime.historyHasOlder = window.historyHasOlder;
		runtime.historyBeforeSeq = window.historyBeforeSeq;
	}

	/**
	 * DSH 审批/提问 server-request：解析帧 → 登记 pending → 转 agents:ui-request。
	 * 帧带 sessionId，与本 runtime 会话不符时忽略（泵按 runtime 隔离订阅）。
	 */
	private handleServerRequest(runtime: DshAgentRuntime, frame: { rpcId?: unknown; payload?: unknown }, payload: Record<string, unknown>): void {
		if (payload.sessionId !== runtime.sessionId) return;
		const approval = parseDshApprovalFrame(frame);
		if (approval) {
			if (this.getAutoAllowApproval()) {
				// 自动放行：不登记 pending、不弹 UI，直接应答 allowed-once（同 sendUIResponse 的确认路径）。
				void this.autoAllowApproval(runtime, approval);
				return;
			}
			this.pendingResponses.set(approval.requestId, approval);
			this.schedulePendingTimeout(runtime.tab.id, approval.requestId);
			this.emit(agentEventTags.agentsUiRequest, approvalUiRequest(approval, runtime.tab.id));
			return;
		}
		const question = parseDshQuestionFrame(frame);
		if (question) {
			this.pendingResponses.set(question.requestId, question);
			this.schedulePendingTimeout(runtime.tab.id, question.requestId);
			this.emit(agentEventTags.agentsUiRequest, questionUiRequest(question, runtime.tab.id));
		}
	}

	/**
	 * pending 审批/提问超时（D5）：用户长时间不响应 Ask 弹窗时，自动应答拒绝并通知
	 * 渲染层 completed——否则 host 侧工具调用永远等不到 client-response，回合不结束，
	 * 后续发送被 waitForIdle 卡满。与 pi 的 scheduleUIRequestTimeout 同语义。
	 */
	private schedulePendingTimeout(agentId: string, requestId: string): void {
		const timer = setTimeout(() => {
			this.pendingTimers.delete(requestId);
			const frame = this.pendingResponses.get(requestId);
			if (!frame) return;
			this.pendingResponses.delete(requestId);
			void (async () => {
				try {
					const client = this.requireClient();
					const value = buildDshRejectValue(frame);
					await client.respond({
						type: "client-response",
						rpcId: requestId,
						result: { ok: true, value },
					});
				} catch {
					// host 已不可用：应答失败也不阻断 completed 通知
				}
				this.emit(agentEventTags.agentsUiRequest, { agentId, requestId, completed: true });
			})();
		}, DshAgentManager.PENDING_RESPONSE_TIMEOUT_MS);
		timer.unref();
		this.pendingTimers.set(requestId, timer);
	}

	/**
	 * 自动放行应答：复用 buildDshRespondValue 的确认分支（outcome=allowed-once）。
	 * 失败（host 未启动/通道断开）时回退人工审批：登记 pending + 弹 UI，避免请求丢失。
	 */
	private async autoAllowApproval(runtime: DshAgentRuntime, approval: DshApprovalFrame): Promise<void> {
		try {
			const client = this.requireClient();
			const value = buildDshRespondValue(approval, { confirmed: true });
			if (!value) return;
			await client.respond({
				type: "client-response",
				// rpcId 来自 mux 帧（持久化为普通字符串），respond 需要品牌类型：边界一次性转换。
				rpcId: approval.requestId,
				result: { ok: true, value },
			});
		} catch (error) {
			this.pendingResponses.set(approval.requestId, approval);
			this.schedulePendingTimeout(runtime.tab.id, approval.requestId);
			this.emit(agentEventTags.agentsUiRequest, approvalUiRequest(approval, runtime.tab.id));
		}
	}

	private findRuntimeBySessionId(sessionId: unknown): DshAgentRuntime | undefined {
		if (typeof sessionId !== "string" || !sessionId) return undefined;
		for (const runtime of this.runtimes.values()) {
			if (String(runtime.sessionId) === sessionId) return runtime;
		}
		return undefined;
	}

	/** 终止单会话的 follow 泵（stop() 移除 runtime 时调用，避免死会话空转重连）。 */
	private stopFollowPump(agentId: string): void {
		this.pumps.stopFollowPump(agentId);
	}

	private stopSharedMux(): void {
		this.pumps.stopSharedMux();
	}

	/** 启动/复用三条共享流（实现与重连退避见 manager/dshRuntimePumps）。 */
	private startMux(runtime: DshAgentRuntime): void {
		this.pumps.startMux(runtime);
	}

	/** 共享 mux 帧按 sessionId 分发给对应 runtime（分发/投影在 manager/dshMuxFrames）。 */
	private dispatchMuxFrame(frame: { rpcId?: unknown; payload?: unknown }): void {
		dispatchDshMuxFrame(this.muxFrameHost, frame);
	}
}
