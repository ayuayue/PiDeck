import type {
	AgentBackend,
	AgentGatewayCapability,
	AgentRuntimeState,
	AgentTab,
	DshPermissionPreset,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	DshSkillView,
	ImageContent,
	PiCommand,
	Project,
	SendPromptInput,
	SendPromptResult,
	SessionUiResponseInput,
	TodoItem,
} from "../../shared/types";
import { isDshPermissionPreset } from "../../shared/types/agent";
import type { SessionProcessEvent } from "../../shared/types/trajectory";
// DSH 会话 id 品牌类型（零运行时成本，仅类型擦除）
import type { SessionId } from "@deepseek-ai/dsh-session/types";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import { getAppLogger } from "../logging/sharedLogger";
import type { SessionAgentGateway } from "../sessions/SessionRuntimeCoordinator";
import type { DshHost } from "./DshHost";
import { renderDshSessionHtml, sanitizeExportFileName } from "./dshSessionHtmlExport";
import { projectDshEvent, parseDshTodoList, type DshProjection } from "./dshEventProjector";
import {
	cacheHitPercentOf,
	collectDshProcessEvent,
	collectDshProcessEvents,
	deriveDshSessionStats,
	deriveSessionStatsFallback,
	estimateContextTokens,
	parseContextBreakdownProjection,
	parseContextPressureProjection,
	parseSessionStatsProjection,
	parseTokenUsageProjection,
	pushDshProcessEvent,
	type DshSessionStatsProjection,
	type DshUsageTotals,
} from "./dshProcessEvents";
import {
	applyDshControlEvent,
	beginDshCancel,
	type DshControlState,
} from "./dshRuntimeControl";
import { toDshAvailableModels } from "./dshModels";
import {
	approvalUiRequest,
	buildDshRejectValue,
	buildDshRespondValue,
	parseDshApprovalFrame,
	parseDshQuestionFrame,
	questionUiRequest,
	type DshApprovalFrame,
	type DshQuestionFrame,
} from "./dshApprovalBridge";
// DSH 会话持久化路径编码（与 DshHost 归档共用同一 workspace 目录名规则）
import { dshSessionFilePath } from "./dshSessionPath";

const DSH_PROJECTION_KEYS = ["contextPressure", "contextBreakdown", "tokenUsage", "sessionStats", "todos"];

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
function isDshImageMediaType(
	value: string,
): value is "image/png" | "image/jpeg" | "image/webp" | "image/gif" {
	return value === "image/png" || value === "image/jpeg" || value === "image/webp" || value === "image/gif";
}

/** DSH 历史消息里由投影器登记的持久化图片引用（canonical ImageBlock.attachment）。 */
type DshImageRef = {
	attachmentId: string;
	mediaType: string;
};

/** 从 ChatMessage.meta 安全读取待回填的 DSH 图片引用。 */
function dshImageRefsFromMeta(meta: ChatMessage["meta"] | undefined): DshImageRef[] {
	if (!meta || !Array.isArray(meta.dshImageRefs)) return [];
	const refs: DshImageRef[] = [];
	for (const raw of meta.dshImageRefs) {
		if (!raw || typeof raw !== "object") continue;
		const candidate = raw as Record<string, unknown>;
		if (typeof candidate.attachmentId === "string" && candidate.attachmentId && typeof candidate.mediaType === "string" && candidate.mediaType) {
			refs.push({ attachmentId: candidate.attachmentId, mediaType: candidate.mediaType });
		}
	}
	return refs;
}

export class DshAgentManager implements SessionAgentGateway {
	readonly backend: AgentBackend = "dsh";	/** 已支持的可选能力：fork（session.fork 锚 seq 裁剪）、compact（/compact 命令）、getCommands（host 命令注册表枚举桥，D15）、exportHtml（投影式导出，G10）。 */
	readonly capabilities: ReadonlySet<AgentGatewayCapability> = new Set([
		"fork",
		"getForkMessages",
		"compact",
		"getCommands",
		"exportHtml",
	]);

	private readonly runtimes = new Map<string, DshAgentRuntime>();
	/** 进程级共享 mux：host 的 events.mux 是全会话聚合流，每开一条都会占订阅。
	 *  每个 runtime 各自订阅时，第二个会话 create/attach 会把第一条流打断或被 host 拒绝，
	 *  表现为「运行中切不了会话 / 停了也切不了 / 换模型失败」。 */
	private muxAbort?: AbortController;
	private muxPump?: Promise<void>;
	private muxFirstSubscription = true;
	private readonly outputListeners = new Set<(channel: string, payload: unknown) => void>();
	/** 待应答的 DSH server-request 帧：rpcId → frame（approval/question 共用一张表）。 */
	private readonly pendingResponses = new Map<string, DshApprovalFrame | DshQuestionFrame>();
	/** RPC 日志开关集合（G17；agentId → 开启）。 */
	private readonly rpcLoggingAgents = new Set<string>();
	/** 审批/提问 pending 超时定时器（D5：用户不响应时自动拒绝，避免永久挂起）。 */
	private readonly pendingTimers = new Map<string, NodeJS.Timeout>();
	/** pending 审批/提问的超时时长（10 分钟：Ask 弹窗常驻等待太久无意义）。 */
	private static readonly PENDING_RESPONSE_TIMEOUT_MS = 10 * 60_000;
	/** 历史导出分页大小与页数上限（防超大会话导出失控；单页 500 事件 ≈ 数十轮对话）。 */
	private static readonly EXPORT_HISTORY_PAGE_SIZE = 500;
	private static readonly EXPORT_MAX_HISTORY_PAGES = 100;
	constructor(
		private readonly dshHost: DshHost,
		private readonly getProject: (id: string) => Project | undefined,
		/** 审批自动放行开关：运行时读取（默认关闭），true 时 approval 帧直接应答 allowed-once。 */
		private readonly getAutoAllowApproval: () => boolean = () => false,
		/** DSH host 会话标题变化回调（attach 初值 / session/title 事件 / rename）：
		 *  装配层据此写回 catalog 并推送侧栏刷新——DSH 会话没有 pi 会话文件，
		 *  标题只存在于 host（dsh-session-title 的 session/title 事件 fold）。 */
		private readonly onTitleChanged?: (dshSessionId: string, title: string) => void,
		/** RPC 日志服务（G17：DSH 领域调用记录，与 pi 共用 RpcLogger；未注入时静默）。 */
		private readonly rpcLogger?: { push(entry: import("../../shared/types/rpcLog").RpcLogEntry): void },
		/** 会话 HTML 导出目录（G10：应用数据目录内，装配层注入；空串 = 导出不可用）。 */
		private readonly getExportDir: () => string = () => "",
		/** 新会话无标题时的兜底标题（i18n；缺省保留历史文案「DSH 会话」）。 */
		private readonly getUntitledTitle: () => string = () => "DSH 会话",
	) {
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

	/** 记录一条 DSH 领域调用日志（仅开关开启时；data 透传 RpcLogger 的截断/脱敏）。 */
	private logRpc(agentId: string, direction: "send" | "recv", summary: string, data?: unknown): void {
		if (!this.rpcLoggingAgents.has(agentId)) return;
		this.rpcLogger?.push({
			id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			agentId,
			direction,
			summary,
			time: Date.now(),
			...(data !== undefined ? { data } : {}),
		});
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
	 */
	resolveSessionFilePath(cwd: string, dshSessionId: string): string {
		return dshSessionFilePath(this.dshHost.getHomeDir(), cwd, dshSessionId);
	}

	async create(input: CreateAgentInput): Promise<AgentTab> {
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);
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
			const listed = await client.sessions.list({});
			if (listed.result.ok) {
				const existing = listed.result.value.items.find(
					(item) => item.sessionId === input.dshSessionId,
				);
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
					const projectedTitle = values !== null && typeof values === "object"
						? (values as Record<string, unknown>).title
						: undefined;
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
			backend: "dsh",
			noSession: input.noSession,
			// 会话「模式」：attach 用 host list 行值；新建用 sessions.create 响应解析值
			//（可能被 host 修正为部署默认）。随 buildAttachPatch 回写 catalog。
			agentPreset: attachedAgentPreset ?? createdAgentPreset,
			createdAt: Date.now(),
			// DSH 会话文件（侧栏右键「复制会话文件路径」；attach 时同步写回 catalog 记录）
			sessionPath: dshSessionFilePath(this.dshHost.getHomeDir(), cwd, sessionId),
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
			const history = await client.sessions.history({ sessionId: dshSessionId, maxMessages: 200 }).catch(() => null);
			if (history?.result.ok) {
				// history 条目带 host 计算的 tool view（与 mux 帧同源），随事件一起投影，
				// 历史工具卡片也能展示命令/描述（dsh-web 历史页同数据）。
				const entries = (history.result.value.events ?? [])
					.map((entry) => ({ event: entry.event, view: entry.view }))
					.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
					.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
				for (const { event, view } of entries) {
					runtime.projection = projectDshEvent(runtime.projection, event, agentId, view);
				}
				runtime.messages = runtime.projection.messages;
				// DSH 历史里的图片以 durable attachment ref 存储：拉取字节回填，主界面才能显示。
				runtime.messages = await this.hydrateDshImageRefs(
					client,
					dshSessionId,
					runtime.messages,
					runtime.hydratedImageRefs,
				);
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
				// 轨迹系统提示随历史重放恢复（request/header 事件随历史投影）
				if (runtime.projection.systemPrompt !== undefined) {
					runtime.systemPrompt = runtime.projection.systemPrompt;
				}
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
			const baselineTodos = attachProjectionValues !== null && typeof attachProjectionValues === "object"
				? (attachProjectionValues as Record<string, unknown>).todos
				: undefined;
			const parsedBaselineTodos = parseDshTodoList(baselineTodos);
			if (parsedBaselineTodos !== undefined) runtime.todos = parsedBaselineTodos;
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
		this.emit(ipcChannels.agentsState, this.list());
		// attach 历史会话：消息/投影已就位，立刻推 runtime，输入框底下就能出「N 轮」。
		this.emitRuntimeState(agentId);
		return tab;
	}

	async sendPrompt(input: SendPromptInput): Promise<SendPromptResult> {
		const runtime = this.runtime(input.agentId);
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
		const sent = await client.sessions.prompt({
			sessionId: runtime.sessionId,
			mode,
			content: [
				{ type: "text", text: input.message },
				...imageParts,
			],
		});
		if (!sent.result.ok) {
			this.logRpc(input.agentId, "recv", "sessions.prompt rejected", sent.result.error);
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

	/** 把 host selectModel 错误收成 commandFailure 能识别的文案。 */
	private selectModelError(error: unknown, _provider: string, _modelId: string): Error {
		const code = error && typeof error === "object" && "code" in error
			? String((error as { code?: unknown }).code ?? "")
			: "";
		const lower = `${code} ${JSON.stringify(error)}`.toLowerCase();
		if (lower.includes("busy") || lower.includes("in progress")) {
			return new Error(`dsh selectModel busy: ${JSON.stringify(error)}`);
		}
		// DSH 会把档位错误（如 reasoning effort 不被目标模型支持）折叠成
		// model-unavailable：保留原始 error.message（缺失时 JSON 兜底），
		// 不转译成笼统的 Model not found，真实拒绝原因才能透传给用户。
		if (lower.includes("model-unavailable") || lower.includes("unavailable")) {
			const message = error && typeof error === "object" && "message" in error
				? String((error as { message?: unknown }).message ?? "")
				: "";
			return new Error(message || JSON.stringify(error));
		}
		return new Error(`dsh selectModel failed: ${JSON.stringify(error)}`);
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
			const listed = await client.sessions.list({}).catch(() => null);
			const exists = listed?.result.ok === true && listed.result.value.items.some(
				(item) => item.sessionId === sessionId,
			);
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
			sessionPath: dshSessionFilePath(this.dshHost.getHomeDir(), cwd, sessionId),
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
		const history = await client.sessions.history({ sessionId: dshSessionId, maxMessages: 200 }).catch(() => null);
		if (history?.result.ok) {
			const entries = (history.result.value.events ?? [])
				.map((entry) => ({ event: entry.event, view: entry.view }))
				.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
				.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
			for (const { event, view } of entries) {
				runtime.projection = projectDshEvent(runtime.projection, event, agentId, view);
			}
			runtime.messages = runtime.projection.messages;
			runtime.messages = await this.hydrateDshImageRefs(
				client,
				dshSessionId,
				runtime.messages,
				runtime.hydratedImageRefs,
			);
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
		this.emit(ipcChannels.agentsState, this.list());
		// 重启后历史已投影：立刻推 runtime，输入框底下就能出「N 轮」。
		this.emitRuntimeState(agentId);
		return tab;
	}

	async stop(agentId: string): Promise<void> {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) return;
		// 先取消 host 回合：只断 mux 不解回合，host 仍占着会话，
		// 下一会话 create/attach/selectModel 会落到 SESSION_COMMAND_FAILED。
		await this.abort(agentId).catch(() => undefined);
		// D1/D5：stop 前解阻塞 pending 审批/提问帧——host 侧工具调用在等 client-response，
		// 不应答则回合永不结束；且 runtime 删除后旧弹窗应答（sendUIResponse）会因
		// pendingResponses 已清而 no-op，弹窗残留。这里以拒绝收尾 + 通知渲染层 completed。
		await this.rejectAllPending(agentId).catch(() => undefined);
		this.runtimes.delete(agentId);
		// 共享 mux 只在最后一个 runtime 离开时关掉，避免停当前会话把其他会话的流一起掐掉。
		if (this.runtimes.size === 0) this.stopSharedMux();
		this.emit(ipcChannels.agentsState, this.list());
	}

	/** 对全部 pending 审批/提问帧应答「拒绝」并清表（abort/stop 共用，D1/D5）。
	 * 与 pi abort 对每个 pending UI 请求发 value:null 解阻塞同语义。 */
	private async rejectAllPending(agentId: string): Promise<void> {
		if (this.pendingResponses.size === 0) return;
		const runtime = this.runtimes.get(agentId);
		const sessionId = runtime ? String(runtime.sessionId) : undefined;
		const pending = [...this.pendingResponses.entries()].filter(([, frame]) => (
			// 无 runtime 时按原语义全清（stop 已删表项的兜底）；有 runtime 只清本会话，
			// 避免停当前会话把其他会话挂起的审批一起拒绝。
			!sessionId || frame.sessionId === sessionId
		));
		if (pending.length === 0) return;
		const client = this.requireClient();
		for (const [requestId] of pending) this.pendingResponses.delete(requestId);
		for (const [requestId, frame] of pending) {
			this.clearPendingTimeout(requestId);
			const value = buildDshRejectValue(frame);
			await client.respond({
				type: "client-response",
				// rpcId 来自 mux 帧（持久化为普通字符串），respond 需要品牌类型：边界一次性转换。
				rpcId: requestId as import("@deepseek-ai/dsh-host-apiproxy").RpcId,
				result: { ok: true, value },
			}).catch(() => undefined);
			this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true });
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
	 * mux 断连重连后的历史补帧（D6）：断连窗口内已完成的回合事件不会重放
	 * （mux 只推实时事件），从 session.history 拉尾部，按 seq 跳过已投影事件，
	 * 只补缺失部分。失败不阻断（下一条消息会正常激活 host 侧 agent）。
	 */
	private async backfillHistory(runtime: DshAgentRuntime): Promise<void> {
		try {
			const client = this.requireClient();
			const history = await client.sessions.history({
				sessionId: runtime.sessionId,
				maxMessages: 200,
			}).catch(() => null);
			if (!history?.result.ok) return;
			const entries = (history.result.value.events ?? [])
				.map((entry) => ({ event: entry.event, view: entry.view }))
				.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
				.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
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
			runtime.messages = await this.hydrateDshImageRefs(
				client,
				runtime.sessionId,
				runtime.messages,
				runtime.hydratedImageRefs,
			);
			runtime.lastProjectedSeq = lastSeq;
			runtime.goal = projection.goal;
			// 断连窗口内的 todo/write 折叠一并补账（history 尾部重放；standing plan 语义）
			if (projection.todos !== undefined) runtime.todos = projection.todos;
			// 尾页 projections baseline：断连窗口内可能缺 todo 事件帧，baseline 完整兜底
			this.applyHistoryProjectionBaseline(runtime, history.result.value.projections);
			// 系统提示随补帧同步（request/header 事件可能落在断连窗口内）
			if (projection.systemPrompt !== undefined) runtime.systemPrompt = projection.systemPrompt;
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
			try {
				const client = this.requireClient();
				runtime.isStreaming = false;
				runtime.isCompacting = false;
				runtime.executingTool = undefined;
				runtime.control = initialDshControl();
				runtime.thinkingId = undefined;
				runtime.thinkingStartedAt = undefined;
				runtime.projectionSeq.clear();
				const history = await client.sessions.history({
					sessionId: runtime.sessionId,
					maxMessages: 200,
				}).catch(() => null);
				if (history?.result.ok) {
					const entries = (history.result.value.events ?? [])
						.map((entry) => ({ event: entry.event, view: entry.view }))
						.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
						.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
					let projection = projectDshEvent(undefined, undefined, agentId);
					for (const { event, view } of entries) {
						projection = projectDshEvent(projection, event, agentId, view);
					}
					runtime.projection = projection;
					runtime.messages = projection.messages;
					runtime.messages = await this.hydrateDshImageRefs(
						client,
						runtime.sessionId,
						runtime.messages,
						runtime.hydratedImageRefs,
					);
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
					// 系统提示随恢复重放补齐（host 崩溃窗口内的 request/header 事件）
					if (runtime.projection.systemPrompt !== undefined) {
						runtime.systemPrompt = runtime.projection.systemPrompt;
					}
					// 过程事件随恢复重放补齐（host 崩溃窗口内的 modelChange/权限/plan 记录）
					runtime.processEvents = collectDshProcessEvents(
						runtime.processEvents,
						entries.map(({ event }) => event),
					);
				}
				await this.refreshModelDirectory(runtime, client).catch(() => undefined);
				this.emit(ipcChannels.agentsState, this.list());
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

	async abort(agentId: string): Promise<void> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		// 先抬世代再 cancel：mux 里迟到的 chunk/turn/start 必须丢掉，否则停止按钮会一直亮。
		this.applyControl(runtime, beginDshCancel(runtime.control));
		// 立即收口思考流：停止后旧回合的 reasoning 残留帧会被 cancelled 守卫丢弃，
		// Live 思考块不能等 turn/end（可能迟到/缺失），否则「停止后思考还在转」。
		if (runtime.thinkingId) {
			this.emit(ipcChannels.agentsThinking, {
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
		await client.sessions.cancel({ sessionId: runtime.sessionId }).catch(() => undefined);
		this.logRpc(agentId, "recv", "sessions.cancel done");
		// 停止时立刻收口正文通道：带上已累积字，避免空 done 把屏幕抹空白。
		this.emit(ipcChannels.agentsTextStream, {
			agentId: runtime.tab.id,
			text: lastAssistantText(runtime.messages) || runtime.projection.pendingAssistantText || "",
			done: true,
		});
		this.emitRuntimeState(agentId);
		this.emit(ipcChannels.agentsState, this.list());
	}

	async rename(agentId: string, name: string): Promise<AgentTab> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const renamed = await client.sessions.rename({ sessionId: runtime.sessionId, title: name });
		if (renamed.result.ok) {
			runtime.tab.title = renamed.result.value.title;
			this.emit(ipcChannels.agentsState, this.list());
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
		const commandText = prompt && prompt.trim()
			? `/compact ${prompt.trim()}`
			: "/compact";
		const sent = await client.sessions.prompt({
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
		const runtime = this.runtime(agentId);
		// 上下文占用圆环（ContextMeter）：优先 host contextPressure 投影（provider 上报 +
		// 下一条请求估算 + 路由容量，dsh-web 同源）；投影缺失（token-meter 未挂载 /
		// adapter 未上报 usage / 投影帧未推送）时退化到「request/context 的 contextWindow
		// + 消息字符估算」，保证 dsh 会话首个回合后圆环即出现，与 pi 行为统一。
		const pressure = runtime.contextPressure;
		const breakdown = runtime.contextBreakdown;
		const contextWindow = pressure?.contextWindow ?? runtime.contextWindow;
		// 对话消息估算（字符数 ÷ 4，与 pi 的 contextMessageTokens 同规则）；空会话不兜底
		const estimatedTokens = estimateContextTokens(runtime.messages);
		const fallbackTokens = estimatedTokens > 0 ? estimatedTokens : undefined;
		const contextTokens = pressure?.projectedTokens ?? pressure?.pressureTokens ?? fallbackTokens;
		const contextMessageTokens = breakdown?.messageTokens ?? fallbackTokens;
		// 不封顶 100：投影/估算可能超过窗口（缓存超窗、估算偏大），封顶会
		// 让显示卡在 100% 而 ~used/window 与头部明细继续增长，口径不一致。
		const contextPercent =
			typeof contextTokens === "number" && typeof contextWindow === "number" && contextWindow > 0
				? Math.round((contextTokens / contextWindow) * 100)
				: undefined;
		// 用量：优先 host tokenUsage 投影（整段日志累计，dsh-web StatsLine 同源），
		// 缺失（token-meter 未挂载/未推送）时回退最近一步 usage（G16）。
		const usage = runtime.usageTotals ?? runtime.usage;
		// 会话统计：优先 host sessionStats；投影未到时用已投影消息估回合/步骤。
		const sessionStatsRaw = runtime.sessionStats ?? deriveSessionStatsFallback(runtime.messages);
		return {
			isStreaming: runtime.isStreaming,
			isCompacting: runtime.isCompacting === true,
			isExecutingTool: runtime.executingTool !== undefined,
			executingToolName: runtime.executingTool,
			modelName: runtime.model?.model,
			provider: runtime.model?.provider,
			modelId: runtime.model?.model,
			modelRoutable: runtime.modelRoutable,
			thinkingLevel: runtime.thinkingLevel,
			permissionPreset: runtime.permissionPreset,
			planModeActive: runtime.planModeActive,
			// G5：当前 goal（goal/change 事件投影）
			goal: runtime.goal,
			// 当前待办计划（官方 todos projection / todo/write 快照；渲染层 todo 条数据源）
			todos: runtime.todos,
			// 上下文占用（host contextPressure/contextBreakdown 投影；缺失时消息估算兜底）
			contextTokens: typeof contextTokens === "number" ? contextTokens : undefined,
			contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
			contextPercent: contextPercent,
			contextMessageTokens: typeof contextMessageTokens === "number" ? contextMessageTokens : undefined,
			// host contextBreakdown 的系统/工具两段（dsh-web ContextMeter 三段图例同源；
			// 0 是有效值，undefined 表示无投影）
			contextSystemTokens: breakdown?.systemTokens,
			contextToolsTokens: breakdown?.toolsTokens,
			// G16：usage 指标（tokenUsage 累计投影优先；缺失时最近一步 usage）
			inputTokens: usage?.inputTokens,
			outputTokens: usage?.outputTokens,
			cacheRead: usage?.cacheReadTokens,
			cacheWrite: usage?.cacheWriteTokens,
			cacheTotal: usage
				? (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
				: undefined,
			// 缓存命中率：cacheRead ÷ (input + cacheRead + cacheWrite)，与 pi/dsh-web 同公式
			cacheHitPercent: cacheHitPercentOf(usage),
			dshSessionStats: sessionStatsRaw ? deriveDshSessionStats(sessionStatsRaw) : undefined,
		};
	}

	/**
	 * 轨迹过程事件（G-context）：modelChange/permission/plan/goal/compaction 记录
	 * （pi 会话文件过程事件的 DSH 等价物）。
	 * - 运行时会话：mux 事件流 + attach/backfill 重放收集的缓存；
	 * - 历史（未激活）会话：从 host history 尾部按事件流推导（与 dsh-web 历史页同数据源），
	 *   失败/无 host 时返回空数组（不阻断轨迹展示）。
	 */
	async readProcessEvents(
		agentId: string | undefined,
		dshSessionId: string | undefined,
	): Promise<SessionProcessEvent[]> {
		if (agentId) {
			const runtime = this.runtimes.get(agentId);
			if (runtime) {
				return [...runtime.processEvents].sort((left, right) => left.timestamp - right.timestamp);
			}
		}
		if (!dshSessionId) return [];
		try {
			const client = await this.ensureClient();
			const page = await client.sessions.history({
				sessionId: dshSessionId as SessionId,
				maxMessages: 1000,
			});
			if (!page.result.ok) return [];
			const events = (page.result.value.events ?? [])
				.map((entry) => entry.event)
				.filter((event): event is NonNullable<typeof event> => Boolean(event))
				.sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
			return collectDshProcessEvents([], events).sort(
				(left, right) => left.timestamp - right.timestamp,
			);
		} catch {
			return [];
		}
	}

	/**
	 * 轨迹系统提示（与 dsh-web 轨迹同源：request/header 事件的 EpochHeader.system）：
	 * - 运行时会话：mux 实时 + attach/backfill 重放收集的投影缓存；
	 * - 历史（未激活）会话：从 host history 尾部折叠最后一个 request/header，
	 *   失败/无 host 时返回 undefined（不阻断轨迹展示）。
	 */
	async readSystemPrompt(
		agentId: string | undefined,
		dshSessionId: string | undefined,
	): Promise<string | undefined> {
		if (agentId) {
			const runtime = this.runtimes.get(agentId);
			if (runtime?.systemPrompt) return runtime.systemPrompt;
		}
		if (!dshSessionId) return undefined;
		try {
			const client = await this.ensureClient();
			const page = await client.sessions.history({
				sessionId: dshSessionId as SessionId,
				maxMessages: 1000,
			});
			if (!page.result.ok) return undefined;
			const events = (page.result.value.events ?? [])
				.map((entry) => entry.event)
				.filter((event): event is NonNullable<typeof event> => Boolean(event));
			let projection = projectDshEvent(undefined, undefined, `dsh:${dshSessionId}`);
			for (const event of events) {
				projection = projectDshEvent(projection, event, `dsh:${dshSessionId}`);
			}
			return projection.systemPrompt;
		} catch {
			return undefined;
		}
	}

	/**
	 * 历史分页（D04）：DSH 会话没有 pi 会话文件，历史浏览走 host 的 session.history
	 * （事件流翻页，beforeSeq 为排除边界：返回 seq < beforeSeq 的事件，与本页最旧事件
	 * seq 相同即可不重复）。投影复用 dshEventProjector（过滤注入上下文）。
	 * 返回形状对齐渲染层 disk 分页协议（sessionsCatalogReadMessagePage）。
	 */
	async readHistoryPage(
		dshSessionId: string,
		beforeSeq: number | undefined,
		maxMessages: number,
	): Promise<{ messages: ChatMessage[]; total: number; nextBefore: number | null }> {
		// 历史浏览是 DSH host 的第一个入口：点击历史 DSH 会话时 runtime 尚未激活
		// （懒启动），必须 ensureStarted 拉起 host，否则 requireClient 直接抛
		// "DSH host is not started"，时间线加载失败显示为空会话。
		const client = await this.ensureClient();
		const page = await client.sessions.history({
			sessionId: dshSessionId as SessionId,
			beforeSeq,
			maxMessages,
		});
		if (!page.result.ok) {
			return { messages: [], total: 0, nextBefore: null };
		}
		const entries = (page.result.value.events ?? [])
			.map((entry) => ({ event: entry.event, view: entry.view }))
			.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
			.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
		const agentId = `dsh:${dshSessionId}`;
		let projection = projectDshEvent(undefined, undefined, agentId);
		for (const { event, view } of entries) {
			projection = projectDshEvent(projection, event, agentId, view);
		}
		const hasMore = page.result.value.hasMore === true;
		const oldestSeq = entries.length > 0 ? entries[0].event.seq : undefined;
		// 游标语义：下一页传本页最旧事件 seq（DSH history 的 beforeSeq 是排除边界，
		// 返回 seq < beforeSeq 的事件，与渲染层 prepend 协议「nextBefore 原样回传」对齐）。
		const nextBefore = hasMore && typeof oldestSeq === "number" ? oldestSeq : null;
		const messages = await this.hydrateDshImageRefs(
			client,
			dshSessionId as SessionId,
			projection.messages,
		);
		return {
			messages,
			// 渲染层不消费 total（仅透传）；-1 表示未知（DSH 无总条数概念）。
			total: -1,
			nextBefore,
		};
	}

	private syncModelDirectoryState(
		runtime: DshAgentRuntime,
		models: { current: { provider: string; model: string; reasoningEffort?: string }; routable: boolean },
	): void {
		runtime.modelRoutable = models.routable;
		runtime.model = { provider: models.current.provider, model: models.current.model };
		runtime.thinkingLevel = models.current.reasoningEffort;
	}

	private async refreshModelDirectory(
		runtime: DshAgentRuntime,
		client: import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient,
	) {
		const listed = await client.sessions.models({ sessionId: runtime.sessionId });
		if (listed.result.ok) this.syncModelDirectoryState(runtime, listed.result.value);
		return listed;
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

	// ── 会话 HTML 导出（G10：投影式导出，DSH wire 无 export_html）─────────────

	/**
	 * 活跃会话导出：直接用 runtime 内存消息渲染（含流式最新内容），
	 * 与 pi 的 export_html 同协议（返回导出文件路径）。
	 */
	async exportHtml(agentId: string): Promise<{ path: string }> {
		const runtime = this.runtime(agentId);
		const messages = runtime.messages;
		return this.writeSessionHtmlExport(messages, {
			title: runtime.tab.title,
			cwd: runtime.cwd,
			dshSessionId: String(runtime.sessionId),
		});
	}

	/**
	 * 历史会话导出（无活跃 runtime）：分页拉全量事件后单次投影渲染。
	 * 分页上限防失控（超大会话截断并提示，不静默失败）。
	 */
	async exportSessionHtml(
		dshSessionId: string,
		title: string,
		cwd?: string,
	): Promise<{ path: string }> {
		const messages = await this.collectAllDshMessages(dshSessionId);
		return this.writeSessionHtmlExport(messages, { title, cwd, dshSessionId });
	}

	/** 历史全量消息收集：从最新往前分页（beforeSeq 为排除边界，页间不重叠）。 */
	private async collectAllDshMessages(dshSessionId: string): Promise<ChatMessage[]> {
		const client = await this.ensureClient();
		const entries: Array<{ event: import("@deepseek-ai/dsh-host-apiproxy").HistoryEntry["event"]; view: import("@deepseek-ai/dsh-host-apiproxy").HistoryEntry["view"] }> = [];
		let beforeSeq: number | undefined;
		for (let page = 0; page < DshAgentManager.EXPORT_MAX_HISTORY_PAGES; page += 1) {
			const pageResult = await client.sessions.history({
				sessionId: dshSessionId as SessionId,
				beforeSeq,
				maxMessages: DshAgentManager.EXPORT_HISTORY_PAGE_SIZE,
			});
			if (!pageResult.result.ok) break;
			const pageEntries = (pageResult.result.value.events ?? [])
				.map((entry) => ({ event: entry.event, view: entry.view }))
				.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event));
			if (pageEntries.length === 0) break;
			entries.push(...pageEntries);
			const oldestSeq = pageEntries[0].event.seq;
			if (pageResult.result.value.hasMore !== true || typeof oldestSeq !== "number") break;
			beforeSeq = oldestSeq;
		}
		entries.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
		const agentId = `dsh:${dshSessionId}`;
		let projection = projectDshEvent(undefined, undefined, agentId);
		for (const { event, view } of entries) {
			projection = projectDshEvent(projection, event, agentId, view);
		}
		return this.hydrateDshImageRefs(
			client,
			dshSessionId as SessionId,
			projection.messages,
		);
	}

	/** 渲染 + 落盘（导出目录由装配层注入，写入前确保目录存在）。 */
	private async writeSessionHtmlExport(
		messages: ChatMessage[],
		meta: { title: string; cwd?: string; dshSessionId: string },
	): Promise<{ path: string }> {
		const dir = this.getExportDir();
		if (!dir) throw new Error("session export is not configured");
		const html = renderDshSessionHtml(messages, meta);
		await mkdir(dir, { recursive: true });
		const fileName = sanitizeExportFileName(meta.title, meta.dshSessionId);
		const filePath = join(dir, fileName);
		await writeFile(filePath, html, "utf8");
		return { path: filePath };
	}

	async prepareResendFromMessage(
		agentId: string,
		messageId: string,
	): Promise<{ text: string; images?: ImageContent[] }> {
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
		const fullText = typeof message.meta?.fullText === "string"
			? message.meta.fullText
			: message.text;
		return { text: fullText };
	}

	/** 创建目标（G5）：objective 必填；maxGoalRounds 缺省由 host 服务配置解析。 */
	async createGoal(agentId: string, objective: string, maxGoalRounds?: number): Promise<void> {
		const trimmed = objective.trim();
		if (!trimmed) throw new Error("Goal objective is required");
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const created = await client.goals.create({
			sessionId: runtime.sessionId,
			objective: trimmed,
			...(typeof maxGoalRounds === "number" ? { maxGoalRounds } : {}),
		});
		if (!created.result.ok) {
			throw new Error(`dsh goal.create failed: ${JSON.stringify(created.result.error)}`);
		}
	}

	/** 目标操作（G5）：pause/resume/complete/clear，按当前 goal 的 CAS ref 提交。 */
	async goalAction(
		agentId: string,
		action: "pause" | "resume" | "complete" | "clear",
	): Promise<void> {
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
		const result = action === "pause"
			? await client.goals.pause(request)
			: action === "resume"
				? await client.goals.resume(request)
				: action === "complete"
					? await client.goals.complete(request)
					: await client.goals.clear({ sessionId: runtime.sessionId, ref });
		if (!result.result.ok) {
			throw new Error(`dsh goal.${action} failed: ${JSON.stringify(result.result.error)}`);
		}
	}

	/** 子代理列表（G6）：subagent.list 直接子代目录（不激活双方）。 */
	async listSubagents(agentId: string): Promise<Array<{
		id: string;
		label?: string;
		activity: "running" | "inactive";
		hasChildren: boolean;
		mode: "one-shot" | "continuable";
		kind: "child" | "diagnostic";
	}>> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const listed = await client.subagents.list({ parentSessionId: runtime.sessionId });
		if (!listed.result.ok) return [];
		return (listed.result.value.entries ?? []).map((entry) => ({
			id: String(entry.id),
			label: "label" in entry ? entry.label : undefined,
			activity: "activity" in entry ? entry.activity : "inactive",
			hasChildren: "hasChildren" in entry ? entry.hasChildren : false,
			mode: "mode" in entry ? entry.mode : "one-shot",
			kind: entry.kind,
		}));
	}

	/** 子代理历史（G6）：只读 transcript（不激活 Agent），投影成 ChatMessage。 */
	async readSubagentHistory(
		agentId: string,
		childSessionId: string,
		beforeSeq?: number,
		maxMessages = 100,
	): Promise<{ messages: ChatMessage[]; hasMore: boolean }> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const address = {
			parentSessionId: runtime.sessionId,
			childSessionId: childSessionId as SessionId,
			mode: "one-shot" as const,
		};
		const page = await client.subagents.history({
			...address,
			...(typeof beforeSeq === "number" ? { beforeSeq } : {}),
			maxMessages,
		});
		if (!page.result.ok) {
			return { messages: [], hasMore: false };
		}
		const entries = (page.result.value.events ?? [])
			.map((entry) => ({ event: entry.event, view: entry.view }))
			.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
			.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
		const childAgentId = `dsh:${childSessionId}`;
		let projection = projectDshEvent(undefined, undefined, childAgentId);
		for (const { event, view } of entries) {
			projection = projectDshEvent(projection, event, childAgentId, view);
		}
		return { messages: projection.messages, hasMore: page.result.value.hasMore === true };
	}

	/**
	 * 技能目录（G7）：wire `skill.list` 只读清单（按会话项目 cwd 解析的目录）。
	 * 技能经 composer `/name` 斜杠调用（dsh-tool-skill 在 pre-step 注入正文），
	 * 本方法只做呈现数据源，不做技能管理。
	 */
	async listSkills(agentId: string): Promise<DshSkillView[]> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const listed = await client.skills.list({ sessionId: runtime.sessionId });
		if (!listed.result.ok) return [];
		return (listed.result.value.skills ?? []).map((skill) => ({
			name: String(skill.name),
			description: String(skill.description),
			...(skill.whenToUse !== undefined && skill.whenToUse !== null
				? { whenToUse: String(skill.whenToUse) }
				: {}),
			modelInvocable: skill.modelInvocable !== false,
		}));
	}

	async setModel(agentId: string, provider: string, modelId: string): Promise<unknown> {
		const runtime = this.runtime(agentId);
		// 普通 DSH session 的 model selection 是 host 级可变状态：运行中切换时，
		// 已经发出的 provider request 保持原配置，后续 step 读取新的完整选择。
		// 若某类后端/会话不接受该操作，让 selectModel 返回 busy，由上层排队到下一轮。
		const client = this.requireClient();
		// DSH 官方语义：换模型 = 提交一整个新选择（provider/model/reasoningEffort），
		// 思考档位随目标模型走，而不是把旧模型的 thinkingLevel 带过去。
		const selected = await this.selectModelWithCatalogEffort(client, runtime, provider, modelId);
		if (!selected.result.ok) {
			throw this.selectModelError(selected.result.error, provider, modelId);
		}
		runtime.model = selected.result.value.selected;
		runtime.modelRoutable = true;
		// host 返回的 reasoningEffort 才是真实生效档位；同步内存，避免底栏显示旧档位。
		runtime.thinkingLevel = selected.result.value.selected.reasoningEffort;
		return selected.result.value;
	}

	/**
	 * 按 DSH 官方模型选择语义执行 selectModel：换模型时优先使用目标模型
	 * 声明的 reasoning.defaultEffort；目标模型没有声明时省略 reasoningEffort，
	 * 由 provider 使用自己的默认行为。绝不沿用旧模型的 thinkingLevel，
	 * 避免新模型不支持旧档位导致“模型切不过去”。
	 */
	private async selectModelWithCatalogEffort(
		client: import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient,
		runtime: DshAgentRuntime,
		provider: string,
		modelId: string,
	) {
		let reasoningEffort: string | undefined;
		try {
			const catalog = await client.sessions.models({ sessionId: runtime.sessionId });
			if (catalog.result.ok) {
				const group = catalog.result.value.groups.find((item) => item.id === provider);
				const model = group?.models.find((item) => item.id === modelId);
				reasoningEffort = model?.reasoning?.defaultEffort;
			}
		} catch {
			// 目录读取失败不阻塞换模型：省略档位让 host 按 provider 默认处理。
		}
		return client.sessions.selectModel({
			sessionId: runtime.sessionId,
			provider,
			model: modelId,
			...(reasoningEffort ? { reasoningEffort } : {}),
		});
	}

	async setThinking(agentId: string, level: string): Promise<unknown> {
		// DSH 的思考档走 selectModel.reasoningEffort，没有独立 RPC。
		const runtime = this.runtime(agentId);
		const selected = runtime.model;
		if (!selected) {
			// 没有当前模型时 DSH 无法把档位落到 host；只作为草稿偏好由 catalog 保存，
			// 不写入 runtime.thinkingLevel，否则后续换模型会误把它带过去。
			return { accepted: true, thinkingLevel: level };
		}
		// 不在 PiDeck 侧预先拒绝运行中的回合：如果 host 支持动态切换，
		// 当前回合可以直接使用；如果 host 不支持，由 selectModel 返回 busy/error。
		const previous = runtime.thinkingLevel;
		runtime.thinkingLevel = level;
		const client = this.requireClient();
		try {
			const updated = await client.sessions.selectModel({
				sessionId: runtime.sessionId,
				provider: selected.provider,
				model: selected.model,
				reasoningEffort: level,
			});
			if (updated.result.ok) {
				runtime.model = {
					provider: updated.result.value.selected.provider,
					model: updated.result.value.selected.model,
				};
				runtime.modelRoutable = true;
				runtime.thinkingLevel = updated.result.value.selected.reasoningEffort ?? level;
			} else {
				runtime.thinkingLevel = previous;
				throw this.selectModelError(updated.result.error, selected.provider, selected.model);
			}
			return this.getRuntimeState(agentId);
		} catch (error) {
			runtime.thinkingLevel = previous;
			throw error;
		}
	}

	async setPermission(agentId: string, preset: string): Promise<unknown> {
		if (!isDshPermissionPreset(preset)) {
			throw new Error(`Unsupported DSH permission preset: ${preset}`);
		}
		// DSH 权限预设切换走 /permission 命令（host 侧 slash 桥在 agent/pre-step
		// 拦截执行）：sandbox 模式 + approval 策略随命令立即生效，permission/preset
		// 等事件经 mux 折叠进 runtime state。命令消息不进模型、不上时间线。
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		// 与 sendPrompt 同一串行化约束：命令回合运行中不允许再 splice 消息
		// （reject 路径会滞留回合内到达的 followup，见 sendPrompt 注释）。
		await this.waitForIdle(agentId);
		// The host-apiproxy client exposes sessions.prompt, not the browser runtime's
		// high-level session.command API. The refreshed host-side slash bridge consumes
		// this control message before model dispatch, so it never becomes a timeline item.
		const sent = await client.sessions.prompt({
			sessionId: runtime.sessionId,
			mode: "queue",
			content: [{ type: "text", text: `/permission ${preset}` }],
		});
		if (!sent.result.ok) {
			throw new Error(`dsh /permission failed: ${JSON.stringify(sent.result.error)}`);
		}
		// Prompt admission only means the command reached DSH. Wait for the durable
		// permission/preset projection before reporting success; otherwise the UI can
		// persist a restricted preset while the host is still using the old policy.
		const applied = await this.waitForPermissionPreset(runtime, preset);
		if (!applied) {
			throw new Error(`dsh /permission was accepted but preset did not become active: ${preset}`);
		}
		return { accepted: true, preset };
	}

	/** Wait for the host event fold rather than guessing from prompt acceptance. */
	private async waitForPermissionPreset(
		runtime: DshAgentRuntime,
		preset: DshPermissionPreset,
		timeoutMs = 5_000,
	): Promise<boolean> {
		const startedAt = Date.now();
		while (Date.now() - startedAt < timeoutMs) {
			if (runtime.permissionPreset === preset) return true;
			await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
		return runtime.permissionPreset === preset;
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
		if (!seqMatch) throw new Error(`Invalid dsh fork entryId: ${entryId}`);
		return this.replaceWithFork(agentId, Number(seqMatch[1]));
	}

	/** DSH clone = fork 无锚点：wire 语义是复制到源会话最后一个完成的 turn（完整副本）。 */
	async cloneSession(agentId: string): Promise<{ text?: string }> {
		return this.replaceWithFork(agentId, undefined);
	}

	/**
	 * session.fork + 换绑共用流程：fork 出新 host 会话 → 停旧 mux → runtime 换绑
	 * 新会话并拉历史。atSeq=undefined 表示复制完整会话（clone）。
	 */
	private async replaceWithFork(
		agentId: string,
		atSeq: number | undefined,
	): Promise<{ text?: string }> {
		const runtime = this.runtime(agentId);
		const client = this.requireClient();
		const forked = await client.sessions.fork({
			sessionId: runtime.sessionId,
			...(atSeq !== undefined ? { atSeq } : {}),
		});
		if (!forked.result.ok) {
			throw new Error(`dsh session.fork failed: ${JSON.stringify(forked.result.error)}`);
		}
		const newSessionId = forked.result.value.sessionId;
		const forkedText = atSeq !== undefined
			? runtime.messages.find(
				(message) => message.role === "user" && message.id === `dsh:${atSeq}`,
			)?.text
			: undefined;
		// 停旧 mux，换绑到新会话并拉历史（fork 会话自带 atSeq 前历史）。
		await this.stop(agentId);
		const tab: AgentTab = {
			...runtime.tab,
			sessionId: newSessionId,
			status: "idle",
			createdAt: Date.now(),
			// fork/clone 产生新 dsh sessionId：会话文件路径同步更新
			sessionPath: dshSessionFilePath(this.dshHost.getHomeDir(), runtime.cwd, newSessionId),
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
		};		const history = await client.sessions.history({ sessionId: newSessionId, maxMessages: 200 }).catch(() => null);
		if (history?.result.ok) {
			const entries = (history.result.value.events ?? [])
				.map((entry) => ({ event: entry.event, view: entry.view }))
				.filter((item): item is { event: NonNullable<typeof item.event>; view: typeof item.view } => Boolean(item.event))
				.sort((left, right) => (left.event.seq ?? 0) - (right.event.seq ?? 0));
			for (const { event, view } of entries) {
				nextRuntime.projection = projectDshEvent(nextRuntime.projection, event, agentId, view);
			}
			nextRuntime.messages = nextRuntime.projection.messages;
			nextRuntime.messages = await this.hydrateDshImageRefs(
				client,
				newSessionId,
				nextRuntime.messages,
				nextRuntime.hydratedImageRefs,
			);
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
		this.emit(ipcChannels.agentsState, this.list());
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
			this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true });
			return { accepted: false, reason: "unparseable-response" };
		}
		await client.respond({
			type: "client-response",
			// rpcId 来自 mux 帧（持久化为普通字符串），respond 需要品牌类型：边界一次性转换。
			rpcId: requestId as import("@deepseek-ai/dsh-host-apiproxy").RpcId,
			result: { ok: true, value },
		});
		this.pendingResponses.delete(requestId);
		this.clearPendingTimeout(requestId);
		// 通知渲染层请求完成（与 pi 的 agentsUiRequest completed 同协议）
		this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true });
		return { accepted: true };
	}

	notifyAskPending(): void {
		// 桌面通知由 SessionRuntimeCoordinator.observeRuntimeEvent 统一触发
		// （非聚焦会话收到 agents:ui-request 时），DSH 不需要额外通道。
	}

	// ── 内部 ───────────────────────────────────────────────────────────────────

	private runtime(agentId: string): DshAgentRuntime {
		const runtime = this.runtimes.get(agentId);
		if (!runtime) throw new Error(`No dsh runtime for agent: ${agentId}`);
		return runtime;
	}

	private requireClient(): import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient {
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
		client: import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient,
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
			const created = await client.sessions.create(
				agentPreset ? { workspaceId, agentPreset } : { workspaceId },
			);
			if (!created.result.ok) {
				return { ok: false, error: JSON.stringify(created.result.error) };
			}
			return {
				ok: true,
				sessionId: created.result.value.sessionId,
				...(created.result.value.agentPreset
					? { agentPreset: created.result.value.agentPreset }
					: {}),
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	private async ensureClient(): Promise<import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient> {
		await this.dshHost.ensureStarted();
		return this.requireClient();
	}

	/**
	 * 把 DSH 历史里的 durable image refs 回填成 ChatMessage.images。
	 * host 的 sessions.attachment 会先证明该 attachmentId 属于本会话，再返回 base64 data；
	 * 失败只记日志并保留 refs（后续页面/重试可再尝试）。
	 * @param attempted 运行时复用集合，避免 mux 每帧对同一 ref 重复 RPC。
	 */
	private async hydrateDshImageRefs(
		client: import("@deepseek-ai/dsh-host-apiproxy").AbstractApiClient,
		sessionId: SessionId,
		messages: ChatMessage[],
		attempted?: Set<string>,
	): Promise<ChatMessage[]> {
		const pendingByMessage: Array<{ message: ChatMessage; refs: DshImageRef[] }> = [];
		for (const message of messages) {
			const refs = dshImageRefsFromMeta(message.meta);
			if (refs.length === 0) continue;
			const missing = refs.filter((ref) => !attempted?.has(ref.attachmentId));
			if (missing.length > 0) pendingByMessage.push({ message, refs: missing });
		}
		if (pendingByMessage.length === 0) return messages;
		const uniqueRefs = new Map<string, DshImageRef>();
		for (const item of pendingByMessage) {
			for (const ref of item.refs) uniqueRefs.set(ref.attachmentId, ref);
		}
		const resolved = new Map<string, ImageContent>();
		for (const [attachmentId, ref] of uniqueRefs) {
			try {
				const result = await client.sessions.attachment({
					sessionId,
					attachmentId: ref.attachmentId as import("@deepseek-ai/dsh-attachment").AttachmentIdType,
				});
				if (result.result.ok) {
					attempted?.add(attachmentId);
					resolved.set(attachmentId, {
						type: "image",
						data: result.result.value.data,
						mimeType: result.result.value.attachment.mediaType,
					});
				} else {
					getAppLogger()?.warn("dsh-agent", "attachment resolve rejected", {
						sessionId: String(sessionId),
						attachmentId,
						error: result.result.error,
					});
				}
			} catch (error) {
				getAppLogger()?.warn("dsh-agent", "attachment resolve failed", {
					sessionId: String(sessionId),
					attachmentId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
		if (resolved.size === 0) return messages;
		let changed = false;
		const nextMessages = messages.map((message) => {
			const refs = dshImageRefsFromMeta(message.meta);
			if (refs.length === 0) return message;
			const images = refs
				.map((ref) => resolved.get(ref.attachmentId))
				.filter((image): image is ImageContent => Boolean(image));
			if (images.length === 0) return message;
			changed = true;
			return { ...message, images: [...(message.images ?? []), ...images] };
		});
		return changed ? nextMessages : messages;
	}

	/** 运行时版：拉取后若消息有变化则重推 agentsMessage（实时 mux 中图片后到）。 */
	private async hydrateRuntimeDshImages(runtime: DshAgentRuntime): Promise<void> {
		try {
			const client = this.requireClient();
			const attempted = runtime.hydratedImageRefs ??= new Set<string>();
			const snapshot = runtime.messages;
			const updated = await this.hydrateDshImageRefs(client, runtime.sessionId, snapshot, attempted);
			const merged = runtime.messages === snapshot
				? updated
				: mergeDshHydratedMessages(runtime.messages, updated);
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
				this.emit(ipcChannels.agentsRuntimeState, { agentId, state });
			})
			.catch(() => undefined);
	}

	/** 当前 runtime 是否已有可用于抵御零 usage 覆盖的上下文证据。 */
	private hasKnownContext(runtime: DshAgentRuntime): boolean {
		const pressureValues = [runtime.contextPressure?.pressureTokens, runtime.contextPressure?.projectedTokens];
		if (pressureValues.some((value) => typeof value === "number" && value > 0)) return true;
		const breakdown = runtime.contextBreakdown;
		if (breakdown && breakdown.systemTokens + breakdown.toolsTokens + breakdown.messageTokens > 0) return true;
		const usage = runtime.usageTotals;
		if (usage && usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) > 0) return true;
		return estimateContextTokens(runtime.messages) > 0;
	}

	/** 失败重试可能带来两个 token 字段均为 0 的伪采样；空会话的真实 0 仍然有效。 */
	private isZeroContextPressure(value: NonNullable<DshAgentRuntime["contextPressure"]>): boolean {
		const tokens = [value.pressureTokens, value.projectedTokens].filter(
			(token): token is number => typeof token === "number",
		);
		return tokens.length > 0 && tokens.every((token) => token === 0);
	}

	/** 对齐 DSH web ProjectionValueStore：每个 projection key 独立按 seq higher-seq-wins。 */
	private acceptsProjectionFrame(runtime: DshAgentRuntime, key: string, rawSeq: unknown): boolean {
		const lastSeq = runtime.projectionSeq.get(key);
		if (rawSeq === undefined) return lastSeq === undefined;
		if (typeof rawSeq !== "number" || !Number.isSafeInteger(rawSeq) || rawSeq < 0) return false;
		if (lastSeq !== undefined && rawSeq <= lastSeq) return false;
		runtime.projectionSeq.set(key, rawSeq);
		return true;
	}

	/**
	 * mux session/projection 帧 → runtime 投影缓存（上下文圆环/会话统计数据源）。
	 * 只消费本项目消费的投影单元（contextPressure/contextBreakdown/tokenUsage/sessionStats），
	 * 其余键忽略——渲染层队列/后台任务展示（session/queue、session/jobs）如需接入，在此扩展。
	 * 帧的 value 是 host 按 onChanged 原样下发的单元值本体（无 {key: value} 包装）；
	 * 解析器（parse*Projection）统一兼容包装形（attach projections.values）与单元值形（帧）。
	 */
	private applyProjectionFrame(
		runtime: DshAgentRuntime,
		payload: { sessionId?: unknown; key?: unknown; value?: unknown; seq?: unknown },
	): void {
		const key = typeof payload.key === "string" ? payload.key : "";
		if (!DSH_PROJECTION_KEYS.includes(key)) return;
		if (!this.acceptsProjectionFrame(runtime, key, payload.seq)) return;
		if (key === "contextPressure") {
			const parsed = parseContextPressureProjection(payload.value);
			if (parsed !== undefined) {
				if (this.isZeroContextPressure(parsed) && this.hasKnownContext(runtime)) {
					// 仅更新独立的容量字段，保留最后一个有效分子；否则 retry 的零 usage 会让
					// 一个仍有 200K 对话内容的会话瞬间显示 0 / 1M。
					const previous = runtime.contextPressure;
					if (parsed.contextWindow !== undefined && parsed.contextWindow !== previous?.contextWindow) {
						runtime.contextPressure = {
							...(previous ?? {}),
							contextWindow: parsed.contextWindow,
						};
						this.emitRuntimeState(runtime.tab.id);
					}
					return;
				}
				runtime.contextPressure = parsed;
				this.emitRuntimeState(runtime.tab.id);
			}
			return;
		}
		if (key === "contextBreakdown") {
			const parsed = parseContextBreakdownProjection(payload.value);
			if (parsed !== undefined) {
				runtime.contextBreakdown = parsed;
				this.emitRuntimeState(runtime.tab.id);
			}
			return;
		}
		if (key === "tokenUsage") {
			const parsed = parseTokenUsageProjection(payload.value);
			if (parsed !== undefined) {
				runtime.usageTotals = parsed;
				this.emitRuntimeState(runtime.tab.id);
			}
			return;
		}
		if (key === "sessionStats") {
			const parsed = parseSessionStatsProjection(payload.value);
			if (parsed !== undefined) {
				runtime.sessionStats = parsed;
				this.emitRuntimeState(runtime.tab.id);
			}
			return;
		}
		if (key === "todos") {
			// 官方 tool-todo 的 todos 投影：整表快照（null = 清空）。seq 已在
			// acceptsProjectionFrame 做 higher-seq-wins；解析失败（undefined）保持原值。
			const parsed = parseDshTodoList(payload.value);
			if (parsed !== undefined) {
				runtime.todos = parsed;
				this.emitRuntimeState(runtime.tab.id);
			}
			return;
		}
	}

	/**
	 * 消费 `session.history` 尾页携带的 projections baseline（官方 ProjectionValueStore
	 * 播种语义）：attach/restart/重连补帧/崩溃恢复都拉同一尾页，baseline 是底层完整折叠，
	 * 不受 200 条事件窗口截断影响。与 mux 实时帧共用 acceptsProjectionFrame 的
	 * higher-seq-wins，历史基线晚于实时帧到达时会被拒绝（不回退）。
	 */
	private applyHistoryProjectionBaseline(
		runtime: DshAgentRuntime,
		projections: unknown,
	): void {
		if (projections === null || typeof projections !== "object") return;
		const block = projections as { asOfSeq?: unknown; values?: unknown };
		const asOfSeq = typeof block.asOfSeq === "number" && Number.isSafeInteger(block.asOfSeq) && block.asOfSeq >= -1
			? block.asOfSeq
			: undefined;
		const values = block.values !== null && typeof block.values === "object"
			? block.values as Record<string, unknown>
			: undefined;
		const parsed = parseDshTodoList(values?.todos);
		if (parsed === undefined) return;
		if (asOfSeq !== undefined && !this.acceptsProjectionFrame(runtime, "todos", asOfSeq)) return;
		runtime.todos = parsed;
	}

	private applyControl(runtime: DshAgentRuntime, next: DshControlState): void {
		const statusChanged = runtime.tab.status !== next.status;
		runtime.control = next;
		runtime.isStreaming = next.isStreaming;
		if (statusChanged) {
			runtime.tab.status = next.status;
			this.emit(ipcChannels.agentsState, this.list());
		}
	}

	private emitMessages(runtime: DshAgentRuntime): void {
		this.emit(ipcChannels.agentsMessage, {
			agentId: runtime.tab.id,
			messages: runtime.messages,
			totalLength: runtime.messages.length,
		});
	}

	/**
	 * DSH 审批/提问 server-request：解析帧 → 登记 pending → 转 agents:ui-request。
	 * 帧带 sessionId，与本 runtime 会话不符时忽略（泵按 runtime 隔离订阅）。
	 */
	private handleServerRequest(
		runtime: DshAgentRuntime,
		frame: { rpcId?: unknown; payload?: unknown },
		payload: Record<string, unknown>,
	): void {
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
			this.emit(ipcChannels.agentsUiRequest, approvalUiRequest(approval, runtime.tab.id));
			return;
		}
		const question = parseDshQuestionFrame(frame);
		if (question) {
			this.pendingResponses.set(question.requestId, question);
			this.schedulePendingTimeout(runtime.tab.id, question.requestId);
			this.emit(ipcChannels.agentsUiRequest, questionUiRequest(question, runtime.tab.id));
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
						rpcId: requestId as import("@deepseek-ai/dsh-host-apiproxy").RpcId,
						result: { ok: true, value },
					});
				} catch {
					// host 已不可用：应答失败也不阻断 completed 通知
				}
				this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true });
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
				rpcId: approval.requestId as import("@deepseek-ai/dsh-host-apiproxy").RpcId,
				result: { ok: true, value },
			});
		} catch (error) {
			this.pendingResponses.set(approval.requestId, approval);
			this.schedulePendingTimeout(runtime.tab.id, approval.requestId);
			this.emit(ipcChannels.agentsUiRequest, approvalUiRequest(approval, runtime.tab.id));
		}
	}

	private findRuntimeBySessionId(sessionId: unknown): DshAgentRuntime | undefined {
		if (typeof sessionId !== "string" || !sessionId) return undefined;
		for (const runtime of this.runtimes.values()) {
			if (String(runtime.sessionId) === sessionId) return runtime;
		}
		return undefined;
	}

	private stopSharedMux(): void {
		this.muxAbort?.abort();
		this.muxAbort = undefined;
		this.muxPump = undefined;
		this.muxFirstSubscription = true;
	}

	/**
	 * 确保进程级共享 mux 在跑。host 的 events.mux 是全会话聚合流：
	 * 每个 runtime 再开一条会互相打断，第二个会话 create/attach 失败。
	 * 断连自愈仍按指数退避重连；重连后给每个仍活着的 runtime 补帧。
	 */
	private startMux(_runtime: DshAgentRuntime): void {
		if (this.muxPump && this.muxAbort && !this.muxAbort.signal.aborted) return;
		const controller = new AbortController();
		this.muxAbort = controller;
		this.muxPump = (async () => {
			let backoffMs = 250;
			while (!controller.signal.aborted) {
				if (!this.dshHost.isHostProcessRunning() || !this.dshHost.isHostReady()) {
					await delay(backoffMs, controller.signal);
					backoffMs = Math.min(backoffMs * 2, 2000);
					continue;
				}
				try {
					const client = this.requireClient();
					// D6：共享流重连后给每个仍活着的 runtime 补历史；首次订阅跳过
					// （各会话 create/attach 已拉过 history）。
					if (!this.muxFirstSubscription) {
						for (const runtime of this.runtimes.values()) {
							if (runtime.control.status === "running" || runtime.isStreaming || runtime.isCompacting) {
								runtime.isStreaming = false;
								runtime.isCompacting = false;
								runtime.executingTool = undefined;
								runtime.control = initialDshControl();
								runtime.thinkingId = undefined;
								runtime.thinkingStartedAt = undefined;
								this.emitRuntimeState(runtime.tab.id);
							}
							await this.backfillHistory(runtime);
						}
					}
					this.muxFirstSubscription = false;
					for await (const frame of client.events.mux({}, controller.signal)) {
						backoffMs = 250;
						this.dispatchMuxFrame(frame);
					}
				} catch {
					// 流错误（host 崩溃 abortAllPending）或 host 未启动：走退避重连。
				}
				if (controller.signal.aborted) break;
				await delay(backoffMs, controller.signal);
				backoffMs = Math.min(backoffMs * 2, 2000);
			}
		})().catch((error) => {
			if (controller.signal.aborted) return;
			console.error("[dsh-agent] mux pump error:", error);
		});
	}

	/** 共享 mux 帧按 sessionId 分发给对应 runtime。 */
	private dispatchMuxFrame(frame: { rpcId?: unknown; payload?: unknown }): void {
		const payload = (frame?.payload ?? frame) as Record<string, unknown> | undefined;
		if (!payload || typeof payload !== "object") return;
		const runtime = this.findRuntimeBySessionId(payload.sessionId);
		if (!runtime) return;
		if (payload.type === "approval/requested" || payload.type === "question/requested") {
			this.handleServerRequest(runtime, frame, payload);
			return;
		}
		if (payload.type === "session/projection") {
			this.applyProjectionFrame(runtime, payload);
			return;
		}
		if (payload.type !== "session/event") return;
		const event = payload.event as { type?: string; seq?: number; time?: number; data?: unknown } | undefined;
		// 轨迹过程事件：模型切换/权限/plan/goal/压缩命令等非对话记录
		// （pi 会话文件过程事件的 DSH 等价物；与消息投影并行收集）。
		runtime.processEvents = pushDshProcessEvent(
			runtime.processEvents,
			collectDshProcessEvent(runtime.processEvents, event),
		);
		// DSH host 会话标题（dsh-session-title 的 session/title 事件）：
		// 更新 runtime tab + 写回 catalog（侧栏运行中行实时、历史行/重启后持久），
		// 不投影消息、不影响流式状态机。
		if (
			event?.type === "session/title" &&
			event.data !== null &&
			typeof event.data === "object" &&
			typeof (event.data as { title?: unknown }).title === "string" &&
			((event.data as { title: string }).title).trim()
		) {
			const title = (event.data as { title: string }).title.trim();
			if (runtime.tab.title !== title) {
				runtime.tab.title = title;
				this.emit(ipcChannels.agentsState, this.list());
				this.onTitleChanged?.(String(runtime.sessionId), title);
			}
			return;
		}
		const eventView = (payload as { view?: unknown }).view;
		const eventGeneration = runtime.control.cancelGeneration;
		const controlled = applyDshControlEvent(runtime.control, event?.type, eventGeneration, event?.data);
		this.applyControl(runtime, controlled.next);
		if (controlled.ignoreStream) {
			// 停止后的迟到流：只投影 turn/end（把已流式的部分文本落回骨架，
			// 并收口 cancelled）。assistant/message、chunk、tool 等旧回合残留
			// 一律不投影——否则停止后完整回答/工具卡片继续上屏（「还在跑」），
			// 或被拼进下一条消息（「串台」）。
			if (event?.type === "turn/end") {
				// D8：停止后的迟到 turn/end 不追加 error 气泡（停止 ≠ 回合失败）
				runtime.projection = projectDshEvent(runtime.projection, event, runtime.tab.id, undefined, { skipErrorTurnEnd: true });
				runtime.messages = mergeDshProjectedMessages(runtime.messages, runtime.projection.messages);
				// 收口时带上已累积正文，避免空 done 把渲染层 live 槽抹成空白。
				this.emit(ipcChannels.agentsTextStream, {
					agentId: runtime.tab.id,
					text: lastAssistantText(runtime.messages),
					done: true,
				});
				this.emitMessages(runtime);
				if (runtime.isCompacting) {
					runtime.isCompacting = false;
					this.emitRuntimeState(runtime.tab.id);
				}
			}
			return;
		}
		runtime.projection = projectDshEvent(runtime.projection, event, runtime.tab.id, eventView);
		runtime.messages = mergeDshProjectedMessages(runtime.messages, runtime.projection.messages);
		// todo/write / turn/start 折叠进 projection.todos：实时同步到 runtime，
		// 随 p.stateChanged 的 emitRuntimeState 一起推给渲染层 todo 条。
		runtime.todos = runtime.projection.todos;
		if (typeof event?.seq === "number" && event.seq > (runtime.lastProjectedSeq ?? 0)) {
			runtime.lastProjectedSeq = event.seq;
		}
		const p = runtime.projection;
		const eventSeq = typeof event?.seq === "number" ? event.seq : 0;
		const eventTime = typeof event?.time === "number" ? event.time : Date.now();
		if (event?.type === "turn/start") {
			// 与 pi agent_start 对齐：新回合丢掉上一轮 held live 槽。
			this.emit(ipcChannels.agentsTextStream, {
				agentId: runtime.tab.id,
				text: "",
				done: true,
				reset: true,
			});
		}
		if (p.deltaText !== undefined) {
			this.emit(ipcChannels.agentsTextStream, {
				agentId: runtime.tab.id,
				text: p.pendingAssistantText,
				done: false,
			});
		}
		if (p.deltaReasoning !== undefined) {
			runtime.thinkingId ??= `msg-thinking-${p.pendingAssistantId ?? `dsh:${eventSeq}`}`;
			runtime.thinkingStartedAt ??= eventTime;
			this.emit(ipcChannels.agentsThinking, {
				agentId: runtime.tab.id,
				id: runtime.thinkingId,
				text: p.pendingAssistantThinking,
				startedAt: runtime.thinkingStartedAt,
				done: false,
			});
		}
		if (runtime.thinkingId && p.deltaReasoning === undefined && p.pendingAssistantThinking === "") {
			this.emit(ipcChannels.agentsThinking, {
				agentId: runtime.tab.id,
				id: runtime.thinkingId,
				text: "",
				startedAt: runtime.thinkingStartedAt ?? 0,
				endedAt: eventTime,
				done: true,
			});
			runtime.thinkingId = undefined;
			runtime.thinkingStartedAt = undefined;
		}
		if (p.stateChanged) {
			runtime.executingTool = p.executingTool;
			if (p.model) runtime.model = p.model;
			if (p.contextWindow !== undefined) runtime.contextWindow = p.contextWindow;
			if (p.usage) runtime.usage = p.usage;
			if (p.systemPrompt !== undefined) runtime.systemPrompt = p.systemPrompt;
			if ((event as { type?: string } | undefined)?.type === "goal/change") runtime.goal = p.goal;
			if (p.permissionPreset !== undefined) runtime.permissionPreset = p.permissionPreset;
			runtime.planModeActive = p.planModeActive;
			this.emitRuntimeState(runtime.tab.id);
		}
		if (p.turnEnded) {
			this.emit(ipcChannels.agentsTextStream, {
				agentId: runtime.tab.id,
				text: lastAssistantText(runtime.messages),
				done: true,
			});
			this.emitMessages(runtime);
			// 回合结束必须推 runtime：sessionStats 投影帧可能稍后才到，
			// 消息兜底的轮数/步数要在 turn/end 当帧更新输入框底下的 StatsLine。
			if (runtime.isCompacting) runtime.isCompacting = false;
			this.emitRuntimeState(runtime.tab.id);
		}
		if (p.messagesChanged && !p.turnEnded) {
			this.emitMessages(runtime);
			if (event?.type === "assistant/message") {
				this.emit(ipcChannels.agentsTextStream, {
					agentId: runtime.tab.id,
					text: lastAssistantText(runtime.messages),
					done: true,
				});
			}
		}
		// 实时 mux 中 canonical 图片只有 attachment ref，先推文本、再异步拉字节补图。
		if (p.messagesChanged) {
			void this.hydrateRuntimeDshImages(runtime);
		}
	}
}

/** Merge image bytes already available in a newer runtime snapshot into projection messages. */
function mergeDshProjectedMessages(previous: ChatMessage[], projected: ChatMessage[]): ChatMessage[] {
	const previousImagesById = new Map<string, ImageContent[]>();
	for (const message of previous) {
		if (message.images && message.images.length > 0) previousImagesById.set(message.id, message.images);
	}
	if (previousImagesById.size === 0) return projected;
	let changed = false;
	const merged = projected.map((message) => {
		const previousImages = previousImagesById.get(message.id);
		if (!previousImages) return message;
		const images = mergeDshImageArrays(message.images, previousImages);
		if (images === message.images) return message;
		changed = true;
		return { ...message, images };
	});
	return changed ? merged : projected;
}

/** Merge attachment hydration into the newest runtime list without dropping newer messages. */
function mergeDshHydratedMessages(current: ChatMessage[], hydrated: ChatMessage[]): ChatMessage[] {
	const hydratedById = new Map(hydrated.map((message) => [message.id, message]));
	let changed = false;
	const merged = current.map((message) => {
		const hydratedMessage = hydratedById.get(message.id);
		if (!hydratedMessage?.images) return message;
		const images = mergeDshImageArrays(message.images, hydratedMessage.images);
		if (images === message.images) return message;
		changed = true;
		return { ...message, images };
	});
	return changed ? merged : current;
}

function mergeDshImageArrays(existing: ImageContent[] | undefined, additions: ImageContent[]): ImageContent[] | undefined {
	if (additions.length === 0) return existing;
	const merged = [...(existing ?? [])];
	let changed = false;
	for (const image of additions) {
		let duplicate = false;
		for (const known of merged) {
			if (known.mimeType !== image.mimeType) continue;
			if (known.data !== image.data) continue;
			duplicate = true;
			break;
		}
		if (!duplicate) {
			merged.push(image);
			changed = true;
		}
	}
	return changed ? merged : existing;
}


/** 本轮最后一条助手正文；收口 text-stream 时带上，避免空 done 抹掉 live 槽。 */
function lastAssistantText(messages: ChatMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message.role === "user") return "";
		if (message.role === "assistant" && message.text.trim()) return message.text;
	}
	return "";
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		signal.addEventListener("abort", () => {
			clearTimeout(timer);
			resolve();
		}, { once: true });
	});
}

function initialDshControl(): DshControlState {
	return {
		status: "idle",
		isStreaming: false,
		cancelGeneration: 0,
		cancelled: false,
	};
}

type DshAgentRuntime = {
	tab: AgentTab;
	sessionId: SessionId;
	cwd: string;
	messages: ChatMessage[];
	projection: DshProjection;
	isStreaming: boolean;
	control: DshControlState;
	executingTool?: string;
	model?: { provider: string; model: string };
	modelRoutable?: boolean;
	thinkingLevel?: string;
	/** DSH 权限预设（permission/preset 事件折叠；read-only/workspace-write/danger-full-access）。 */
	permissionPreset?: string;
	/** DSH plan 模式（plan/mode 事件折叠）。 */
	planModeActive?: boolean;
	/** /compact 命令回合进行中（命令已发出、turn/end 未到）；UI 压缩按钮显示进行态。 */
	isCompacting?: boolean;
	/** 已投影的最大事件 seq（D6：mux 重连补帧时跳过已投影事件，避免重复）。 */
	lastProjectedSeq?: number;
	/** 每个 host projection key 的水位线，按 DSH web 的 higher-seq-wins 规则维护。 */
	projectionSeq: Map<string, number>;
	/** 已尝试拉取过的 DSH attachmentId（避免 mux 每帧对同一图片重复 RPC）。 */
	hydratedImageRefs?: Set<string>;
	/** 最近一次 assistant 回合的 token 用量（G16；assistant/message 事件投影更新）。 */
	usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number };
	/** 会话累计 token 用量（host tokenUsage 投影；整段日志累计，dsh-web StatsLine 同源）。
	 *  优先于 usage（最近一步），缺失时回退 usage。 */
	usageTotals?: DshUsageTotals;
	/** 会话统计（host sessionStats 投影；整段日志回合/步骤计数与墙钟汇总，dsh-web StatsLine 同源）。 */
	sessionStats?: DshSessionStatsProjection;
	/** DSH 当轮真实系统提示（request/header 事件投影；attach/backfill 重放与 mux 实时双来源）。 */
	systemPrompt?: string;
	/**
	 * 上下文占用投影（host contextPressure 单元）：provider 上报的最新请求大小 +
	 * 下一条请求的估算成本 + 路由容量。mux session/projection 帧与 attach 初值双来源，
	 * 供上下文圆环（ContextMeter）展示 DSH 会话占用。
	 */
	contextPressure?: { pressureTokens?: number; projectedTokens?: number; contextWindow?: number };
	/** 上下文构成投影（host contextBreakdown 单元）：系统提示/工具 schema/对话的启发式估算。 */
	contextBreakdown?: { systemTokens: number; toolsTokens: number; messageTokens: number };
	/** 路由上下文容量（request/context 事件的 contextWindow；无 pressure 投影时的兜底窗口）。 */
	contextWindow?: number;
	/** 轨迹过程事件（modelChange/permission/plan/goal/compaction；pi 会话文件过程事件的 DSH 等价物）。 */
	processEvents: SessionProcessEvent[];
	/** 当前 goal（G5；goal/change 事件投影更新，clear 后为 undefined）。 */
	goal?: {
		refId: string;
		revision: number;
		objective: string;
		phase: "active" | "paused" | "blocked" | "complete";
		maxGoalRounds: number;
		roundsStarted: number;
	};
	/**
	 * 当前待办计划（官方 todos projection / todo/write 快照的归一化折叠）：
	 * 实时 mux、attach/restart/backfill/recover 的多来源恢复都收敛到这一个字段，
	 * 经 runtime-state 推给渲染层 todo 条；null = 已清空（standing plan 语义）。
	 */
	todos?: TodoItem[] | null;
	/** 进行中的思考段 id（turn 内首个 reasoning-delta 起登记；终态清空）。 */
	thinkingId?: string;
	thinkingStartedAt?: number;
};

