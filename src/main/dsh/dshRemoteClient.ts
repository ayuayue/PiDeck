import { DshApiClient, type DshRpcResult } from "./DshApiClient";

/** 旧 AbstractApiClient 的返回信封（调用方沿用的解包形状 x.result.ok / x.result.value）。
 *  泛型默认 any：0.1.5 的生成 wire 类型随 dsh-host-apiproxy 一起消失，宿主侧
 *  zod（strict）承担运行时校验；这里属第三方交互边界，按项目豁免规则承接。 */
export type DshEnvelope<T = any> = {
	result: { ok: true; value: T } | { ok: false; error: { code: string; message: string; details: object } };
};

/** 把新 DshRpcResult 包成旧信封（保留语义，调用点零改动）。 */
function envelope<T>(promise: Promise<DshRpcResult<T>>): Promise<DshEnvelope<T>> {
	return promise.then((result) => ({ result }));
}

/**
 * DSH 0.1.5 Typert Remote 适配层（docs/dsh-0.1.5-typert-migration.md §4）。
 *
 * 目标：把 PiDeck 既有调用面（旧 AbstractApiClient 的领域方法签名与
 * `{result:{ok,value|error}}` 信封）映射到 0.1.5 的 Connection RPC 端点，
 * 让 DshHost / DshAgentManager 的调用点改动最小化。
 *
 * wire 契约来自各域包 typert.host.js 的生成描述符（scripts/dump-typert-endpoints.mjs
 * 可复现）。host 侧 zod 为 strict 模式：payload 字段必须与描述符精确一致，
 * 旧载荷里的未知字段在这里剥掉。
 *
 * 语义差异（与旧 apiproxy 对比）：
 * - sessions.history → session/page 分页：适配层以 throughSeq=MAX 拉尾部窗口，
 *   重排为旧 {events:[{event,view}], projections} 形状（view 取 event.surfaceOp）。
 * - events.mux（全会话聚合流）已不存在：审批/提问走 $events 事件瀑布，
 *   会话日志事件走每会话 session/follow 流（manager 侧各自泵）。
 * - respond(client-response) → $events/result 瀑布应答（ApprovalOutcome 字符串 /
 *   AskUserQuestionAnswer 对象）。
 */

/** 旧 HistoryEntry 形状（事件 + host 计算的 view）。 */
export type DshHistoryEntry = { event: Record<string, unknown>; view: unknown };

/** 旧 sessions.history 返回值形状（适配 session/page 后）。 */
export type DshHistoryPage = {
	events: DshHistoryEntry[];
	projections?: unknown;
	hasMore?: boolean;
};

/** 旧 mux 帧形状（follow / $events 翻译后的下游输入）。 */
export type DshMuxFrame = { rpcId?: string; payload: Record<string, unknown> };

/** $events ready 帧携带的 clientId（瀑布应答必须回传）。 */
type RemoteEventDownlink = {
	type: "ready";
	clientId: string;
	host: unknown;
} | {
	type: "emit";
	event: string;
	args: readonly unknown[];
} | {
	type: "waterfall";
	event: string;
	eventId: string;
	agentId: string;
	request: Record<string, unknown>;
} | {
	type: "cancel";
	eventId: string;
};

/** 会话分页地址（普通会话 / 直接子代理）。 */
type SessionAddress =
	| { kind: "session"; sessionId: string }
	| { kind: "subagent"; parentSessionId: string; childSessionId: string; mode: "one-shot" | "continuable" };

/** 通过地址分页（follow 快照 / page 端点共用）。 */
function addressOf(sessionId: string): SessionAddress {
	return { kind: "session", sessionId };
}

export class DshRemoteClient {
	/** $events ready 帧的 clientId（openEvents 消费后缓存；瀑布应答必需）。 */
	private eventClientId: string | null = null;

	constructor(private readonly rpc: DshApiClient) {}

	/** 底层桥客户端（manager 的 abortAllPending/dispose 联动用）。 */
	get transport(): DshApiClient {
		return this.rpc;
	}

	// ── 会话域 ────────────────────────────────────────────────────────────────

	async sessionsList(): Promise<DshEnvelope> {
		return envelope(this.rpc.call("session/list", {}));
	}

	/**
	 * 旧 sessions.history({sessionId, maxMessages}) 的分页适配：
	 * throughSeq 取安全上限拉尾部窗口；记录重排为旧 {events, projections} 形状。
	 */
	async 	sessionsHistory(input: {
		sessionId: string;
		maxMessages?: number;
		beforeSeq?: number;
	}): Promise<DshEnvelope<DshHistoryPage>> {
		const result = await this.rpc.call("session/page", {
			address: addressOf(input.sessionId),
			throughSeq: Number.MAX_SAFE_INTEGER,
			...(input.maxMessages !== undefined ? { maxMessages: input.maxMessages } : {}),
			...(input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}),
		});
		if (!result.ok) return { result };
		const value = result.value as {
			records?: Array<{ type?: string; event?: Record<string, unknown> }>;
			hasMore?: boolean;
		};
		const events = (value.records ?? [])
			.filter((record) => record && record.event)
			.map((record) => {
				const event = record.event as Record<string, unknown>;
				// host 对工具卡片的下发 view 现在挂在事件的 surfaceOp 槽。
				return { event, view: event.surfaceOp };
			});
		return { result: { ok: true, value: { events, hasMore: value.hasMore } } };
	}

	async sessionsPrompt(input: {
		sessionId: string;
		mode: "queue" | "steer";
		content: unknown[];
		clientTimeZone?: string;
	}): Promise<DshEnvelope> {
		const { sessionId, mode, content, clientTimeZone } = input;
		return envelope(this.rpc.call("session/prompt", {
			request: {
				sessionId,
				mode,
				content,
				...(clientTimeZone ? { clientTimeZone } : {}),
			},
		}));
	}

	async sessionsCancel(input: { sessionId: string }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("session/cancel", { request: { sessionId: input.sessionId } }));
	}

	async sessionsRename(input: { sessionId: string; title: string }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("session/rename", { request: { sessionId: input.sessionId, title: input.title } }));
	}

	async sessionsCreate(input: {
		workspaceId?: string;
		cwd?: string;
		sessionId?: string;
		agentPreset?: string;
	}): Promise<DshEnvelope> {
		return envelope(this.rpc.call("session/create", {
			request: {
				...(input.workspaceId !== undefined ? { workspaceId: input.workspaceId } : {}),
				...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
				...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
				...(input.agentPreset !== undefined ? { agentPreset: input.agentPreset } : {}),
			},
		}));
	}

	async sessionsFork(input: { sessionId: string; atSeq?: number }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("session/fork", {
			request: {
				sessionId: input.sessionId,
				...(input.atSeq !== undefined ? { atSeq: input.atSeq } : {}),
			},
		}));
	}

	async sessionsAttachment(input: { sessionId: string; attachmentId: string }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("session/attachment", {
			request: { sessionId: input.sessionId, attachmentId: input.attachmentId },
		}));
	}

	async sessionsSearch(input: { query: string }, signal?: AbortSignal): Promise<DshEnvelope> {
		return envelope(this.rpc.call("session/search", { request: { query: input.query } }, signal));
	}

	/** 旧 client.sessions.models / client.llm.models 的 0.1.5 宿主：session/modelCatalog。 */
	async sessionsModelCatalog(): Promise<DshEnvelope> {
		return envelope(this.rpc.call("session/modelCatalog", {}));
	}

	async sessionsSelectModel(input: {
		sessionId: string;
		provider: string;
		model: string;
		reasoningEffort?: string;
	}): Promise<DshEnvelope> {
		return envelope(this.rpc.call("session/selectModel", {
			request: {
				sessionId: input.sessionId,
				provider: input.provider,
				model: input.model,
				...(input.reasoningEffort !== undefined ? { reasoningEffort: input.reasoningEffort } : {}),
			},
		}));
	}

	/**
	 * 每会话日志流（替代旧聚合 mux 的 session/event 帧）。产出旧 mux 帧形状：
	 * {payload:{sessionId, type:'session/event', event, view}}；follow 快照的
	 * projections 转成一条 'session/projection' 帧（下游 applyProjectionFrame 复用）。
	 */
	async *sessionsFollow(
		input: { sessionId: string },
		signal: AbortSignal,
	): AsyncGenerator<DshMuxFrame> {
		const sessionId = input.sessionId;
		const items = this.rpc.openStream(
			"session/follow",
			{ request: { address: addressOf(sessionId) } },
			signal,
		);
		for await (const item of items) {
			const frame = item as {
				type?: string;
				event?: Record<string, unknown>;
				projections?: unknown;
				records?: Array<{ event?: Record<string, unknown> }>;
			};
			if (frame?.type === "event" && frame.event) {
				const event = frame.event;
				yield { payload: { sessionId, type: "session/event", event, view: event.surfaceOp } };
				continue;
			}
			if (frame?.type === "snapshot") {
				if (frame.projections !== undefined) {
					yield {
						payload: { sessionId, type: "session/projection", ...(frame.projections as Record<string, unknown>) },
					};
				}
				for (const record of frame.records ?? []) {
					if (record?.event) {
						const event = record.event;
						yield { payload: { sessionId, type: "session/event", event, view: event.surfaceOp } };
					}
				}
			}
		}
	}

	// ── 事件瀑布（审批 / 提问）─────────────────────────────────────────────────

	/**
	 * 打开 $events 转发事件流，产出旧 mux 的审批/提问帧形状：
	 * - approval/request 瀑布 → {rpcId: eventId, payload:{sessionId: agentId,
	 *   type:'approval/requested', approvalId: eventId, toolName, reason}}
	 * - user-questions/request 瀑布 → {rpcId: eventId, payload:{sessionId: agentId,
	 *   type:'question/requested', questions}}
	 * ready 帧的 clientId 缓存供 respond() 回传。
	 */
	async *openEvents(signal: AbortSignal): AsyncGenerator<DshMuxFrame> {
		const items = this.rpc.openStream("$events", { args: {} }, signal);
		for await (const item of items) {
			const frame = item as RemoteEventDownlink;
			if (!frame || typeof frame !== "object") continue;
			if (frame.type === "ready") {
				this.eventClientId = frame.clientId;
				continue;
			}
			if (frame.type === "waterfall" && frame.event === "approval/request") {
				yield {
					rpcId: frame.eventId,
					payload: {
						sessionId: frame.agentId,
						type: "approval/requested",
						approvalId: frame.eventId,
						...(typeof frame.request.toolName === "string" ? { toolName: frame.request.toolName } : {}),
						...(typeof frame.request.reason === "string" ? { reason: frame.request.reason } : {}),
					},
				};
				continue;
			}
			if (frame.type === "waterfall" && frame.event === "user-questions/request") {
				yield {
					rpcId: frame.eventId,
					payload: {
						sessionId: frame.agentId,
						type: "question/requested",
						questions: Array.isArray(frame.request.questions) ? frame.request.questions : [],
					},
				};
			}
			// 其余 emit（api-session/*、settings/document-updated 等）由各自链路
			// 按需订阅；v1 桥不做通用转发。
		}
	}

	/**
	 * 旧 respond({type:'client-response', rpcId, result}) 的瀑布应答适配：
	 * 旧 value 形状 {sessionId, approvalId, outcome} / {sessionId, answer} →
	 * $events/result 的 outcome {kind:'result', value: ApprovalOutcome | answer}。
	 */
	async respond(message: {
		type: string;
		rpcId: string;
		result: { ok: boolean; value?: unknown };
	}): Promise<DshEnvelope> {
		const clientId = this.eventClientId;
		if (!clientId) {
			return { result: { ok: false, error: { code: "internal", message: "no active $events stream (clientId unknown)", details: {} } } };
		}
		const value = message.result?.value as
			| { outcome?: unknown; answer?: unknown }
			| undefined;
		// 旧载荷槽位区分：approval 带 outcome（ApprovalOutcome 字符串），question 带 answer。
		const outcomeValue = value?.outcome;
		const answer = value?.answer;
		const outcome: { kind: "result"; value?: unknown } =
			value && outcomeValue !== undefined
				? { kind: "result", value: outcomeValue }
				: answer !== undefined
					? { kind: "result", value: answer }
					: { kind: "result", value: "rejected" };
		return envelope(this.rpc.respondRemoteEvent(clientId, message.rpcId, outcome));
	}

	// ── 目标域 ────────────────────────────────────────────────────────────────

	async goalsCreate(input: { sessionId: string; objective: string; maxGoalRounds?: number }): Promise<DshEnvelope> {
		const { sessionId, objective, maxGoalRounds } = input;
		return envelope(this.rpc.call("goals/create", {
			agentId: sessionId,
			request: {
				objective,
				...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
			},
		}));
	}

	private async goalRefAction(endpoint: string, input: { sessionId: string; ref: unknown }): Promise<DshEnvelope> {
		return envelope(this.rpc.call(endpoint, { agentId: input.sessionId, ref: input.ref }));
	}

	goalsPause(input: { sessionId: string; ref: unknown }): Promise<DshEnvelope> {
		return this.goalRefAction("goals/pause", input);
	}

	goalsResume(input: { sessionId: string; ref: unknown }): Promise<DshEnvelope> {
		return this.goalRefAction("goals/resume", input);
	}

	goalsComplete(input: { sessionId: string; ref: unknown }): Promise<DshEnvelope> {
		return this.goalRefAction("goals/complete", input);
	}

	goalsClear(input: { sessionId: string; ref: unknown }): Promise<DshEnvelope> {
		return this.goalRefAction("goals/clear", input);
	}

	// ── 子代理 / 技能 ─────────────────────────────────────────────────────────

	async subagentsList(input: { parentSessionId: string }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("subagents/list", { parentSessionId: input.parentSessionId }));
	}

	/**
	 * 旧 subagents.history → session/page 的 subagent 地址形态。
	 * maxMessages/beforeSeq 透传；mode 缺省 one-shot（与旧 direct-child 语义一致）。
	 */
	async subagentsHistory(input: {
		parentSessionId: string;
		childSessionId: string;
		mode?: "one-shot" | "continuable";
		beforeSeq?: number;
		maxMessages?: number;
	}): Promise<DshEnvelope<DshHistoryPage>> {
		const result = await this.rpc.call("session/page", {
			address: {
				kind: "subagent",
				parentSessionId: input.parentSessionId,
				childSessionId: input.childSessionId,
				mode: input.mode ?? "one-shot",
			},
			throughSeq: Number.MAX_SAFE_INTEGER,
			...(input.beforeSeq !== undefined ? { beforeSeq: input.beforeSeq } : {}),
			...(input.maxMessages !== undefined ? { maxMessages: input.maxMessages } : {}),
		});
		if (!result.ok) return { result };
		const value = result.value as { records?: Array<{ event?: Record<string, unknown> }>; hasMore?: boolean };
		const events = (value.records ?? [])
			.filter((record) => record && record.event)
			.map((record) => {
				const event = record.event as Record<string, unknown>;
				return { event, view: event.surfaceOp };
			});
		return { result: { ok: true, value: { events, hasMore: value.hasMore } } };
	}

	async skillsList(input: { sessionId: string }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("skills/list", { request: { sessionId: input.sessionId } }));
	}

	// ── 设置 / 凭证 / LLM / 预设 / 工作区 ─────────────────────────────────────

	async settingsDescribe(): Promise<DshEnvelope> {
		return envelope(this.rpc.call("settings/describe", {}));
	}

	async settingsUpdate(input: { ns: string; patch: unknown; expectedRevision?: number }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("settings/update", {
			ns: input.ns,
			patch: input.patch,
			...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
		}));
	}

	async settingsMutate(input: { ns: string; ops: unknown; expectedRevision?: number }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("settings/mutate", {
			ns: input.ns,
			ops: input.ops,
			...(input.expectedRevision !== undefined ? { expectedRevision: input.expectedRevision } : {}),
		}));
	}

	async settingsOpenDocument(signal?: AbortSignal): Promise<DshEnvelope> {
		return envelope(this.rpc.call("settings/openSettingsDocument", {}, signal));
	}

	async credentialsDescribe(input: { refs: string[] }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("credentials/describe", { refs: input.refs }));
	}

	async credentialsSet(input: { ref: string; value: string }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("credentials/set", { ref: input.ref, value: input.value }));
	}

	async credentialsUnset(input: { ref: string }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("credentials/unset", { ref: input.ref }));
	}

	async llmProviders(): Promise<DshEnvelope> {
		return envelope(this.rpc.call("llm/listProviders", {}));
	}

	async llmDiscoverModels(input: {
		settingsNs: string;
		provider?: string;
		baseURL?: string;
		api?: string;
		apiKey?: string;
	}): Promise<DshEnvelope> {
		return envelope(this.rpc.call("llm/discoverModels", {
			settingsNs: input.settingsNs,
			request: {
				...(input.provider !== undefined ? { provider: input.provider } : {}),
				...(input.baseURL !== undefined ? { baseURL: input.baseURL } : {}),
				...(input.api !== undefined ? { api: input.api } : {}),
				...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
			},
		}));
	}

	async agentPresetsList(): Promise<DshEnvelope> {
		return envelope(this.rpc.call("agentPresets/list", {}));
	}

	async agentPresetsRemove(input: { agentPreset: string }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("agentPresets/deletePreset", { id: input.agentPreset }));
	}

	async workspaceCreate(input: { path: string }): Promise<DshEnvelope> {
		return envelope(this.rpc.call("workspace/create", { request: { path: input.path } }));
	}
}
