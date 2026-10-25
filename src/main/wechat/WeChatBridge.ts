/**
 * WeChatBridge — 微信 iLink（ClawBot）私聊桥接。
 *
 * 与 FeishuBridge 的关系：结构同构（IM 消息 → 稳定 pi 会话 → 结果回信），但有四处
 * 必须重写的差异，抄飞书的代码在微信上会直接坏掉：
 *
 * 1. **收信方向反了**：飞书是服务端 WebSocket 推给我们，微信是我们出站长轮询
 *    getupdates（实测每轮约 18s）。所以有游标持久化、退避重试、会话失效暂停。
 * 2. **不能主动推送**：回信必须带该条用户消息的 context_token，所以「先开口」是
 *    硬约束——开机问候、定时提醒、异步完成的兜底通知在微信上全都不存在。
 * 3. **只有纯文本**：没有卡片/按钮/Markdown/附件。飞书的 CardStream/AskCard/
 *    rich-text 在微信侧零复用价值，这里只用 weChatText 做 Markdown 降级与切分。
 * 4. **1:1 单账号**：一个微信号绑一个 Bot，没有群聊、没有多 Bot 路由；鉴权靠
 *    「只响应扫码那个 ilink_user_id」（协议自己不校验，必须我们兜住）。
 *
 * 后端可切（设置 → 外部连接 → 微信 → 后端：pi / DSH）：桥接只依赖
 * SessionRuntimeBindingGateway（会话、消息、回合收口都是全后端统一语义），不碰任何
 * AgentManager——换后端不该改通道代码，更不该出现「找得到 pi 会话、找不到 DSH 会话」。
 *
 * 会话身份仍是 session-first：binding.sessionId 是跨重启稳定的身份，agentId 只是
 * 当前 runtime 句柄，句柄失效就重新激活同一个 sessionId，而不是新建会话。
 */

import { createHash, randomUUID } from "node:crypto";
import type { AgentRuntimeState, AgentTab, ImChannelBackend, WeChatBindingModel, WeChatBridgeStatus, WeChatChatBinding, WeChatModelChainEntry } from "../../shared/types";
import { IlinkClient, IlinkError, type IlinkLogFn } from "./IlinkClient";
import { ILINK_CHANNEL_VERSION, MESSAGE_TYPE_USER, POLL_RETRY_FAST_MS, POLL_RETRY_SLOW_AFTER, POLL_RETRY_SLOW_MS, extractMessageText, hasUnsupportedItem, type IlinkMessage, type IlinkSession } from "./ilinkProtocol";
import type { SessionRuntimeBindingGateway } from "../sessions/sessionRuntimeBinding";
import type { SessionRunOutcome } from "../sessions/sessionRunWaiter";
import { getAccount, getBinding, getDecryptedBotToken, getCursor, getPublicAccount, getSettings, isAllowedUser, loadBindings, markNeedsRelogin, normalizeModelChain, removeBinding, removeBindingsBySessionId, setCursor, updateSettings, upsertBinding } from "./WeChatConfig";
import { normalizeWeChatLocale, weChatLanguage, wechatT, type WeChatLocale, type WeChatTranslationKey } from "./WeChatI18n";
import { pickLatestAssistantText, pickLatestFailureText, prepareOutgoingText, splitForWeChat } from "./weChatText";

export type WeChatBridgeDeps = {
	/** 返回当前可用项目；未配置时桥接拒绝建会话并提示用户。 */
	getProjects: () => Array<{ id: string; name: string }>;
	runtimeBindings: SessionRuntimeBindingGateway;
	/** 当前界面语言，决定回信文案。每次调用都重新取，用户切语言后无需重连。 */
	getLocale: () => string | undefined;
	/**
	 * 自报身份（base_info.bot_agent）。默认 `PiDeck`，装配处应传 `PiDeck/<version>`。
	 * **绝不冒充 OpenClaw**：实测服务端不据此鉴权，冒充只会让问题无法归因。
	 */
	botAgent?: string;
	/** 状态变化推给渲染层。 */
	onStatusChange?: (status: WeChatBridgeStatus) => void;
	/** 绑定变化推给渲染层（会话被删除/重建时要更新界面）。 */
	onBindingsChange?: () => void;
	logger?: IlinkLogFn;
};

/** 已处理消息 ID 的环形缓冲上限。微信侧重投概率低，但游标回退会重放，必须有幂等网。 */
const DEDUP_MAX = 200;
/** 单次 run 的上限。飞书同值：超时不是失败，而是转交「迟到投递」。 */
const RUN_TIMEOUT_MS = 300_000;
/** 回合收口后等落盘/尾部 text_delta 收尾，避免回信缺最后一段（飞书同样 800ms）。 */
const RESULT_SETTLE_MS = 800;
/**
 * 「收口了但什么都没读到」时再等一拍的时长。
 *
 * DSH 的失败是 turn/end 才追加 role=error 消息，可能晚于 idle 快照到达；不补这一拍
 * 就会把「后端报错」错报成「任务已完成但没有文本」。只有空手路径付这个等待。
 */
const EMPTY_RESULT_RETRY_MS = 600;
/** 分片发送之间的间隔，避免一串长回复被服务端当刷屏。 */
const MULTI_CHUNK_GAP_MS = 400;
/** 迟到的收口超过这个时间就不再尝试回信（context_token 大概率已失效）。 */
const LATE_DELIVERY_MAX_MS = 60 * 60 * 1000;
/**「正在输入」凭证的有效期：协议说它短命，但同一次 run 的开始/结束可以复用同一张。 */
const TYPING_TICKET_TTL_MS = 30_000;

/** 一次 prompt 提交的结局。只有 failed 会触发模型顺延；sendError 是提交链路本身失败。 */
type RunAttemptOutcome = { kind: "ok"; sinceIndex: number } | { kind: "failed"; message?: string } | { kind: "sendError"; message: string } | { kind: "timeout"; sinceIndex: number };

/** 超时后仍在跑的 run：它迟到收口时补发结果（对象身份就是取消凭证）。 */
type LateRunRecord = { sessionId: string; chatId: string; contextToken: string; startedAt: number; runId?: string; generation: number };

export class WeChatBridge {
	private readonly deps: WeChatBridgeDeps;
	private client: IlinkClient | null = null;
	private status: WeChatBridgeStatus = { status: "disconnected", account: null, activeBindings: 0 };
	private stopping = false;
	private pollStarted = false;

	/** 消息幂等：Set 提供 O(1) 查询，数组维持插入顺序用于淘汰。 */
	private readonly seenMessages: number[] = [];
	private readonly seenMessageSet = new Set<number>();

	/** 当前占着会话的 run（微信 1:1，最多一个）。非空时新消息只回「忙」。 */
	private activeRun: { chatId: string; contextToken: string; agentId?: string; startedAt: number } | null = null;
	/**
	 * 超时后仍挂着等待投递结果的 run（按 sessionId）。收口事件由等待器给出，
	 * 不再需要 endedAgents/runWaiters 那套「事件早于注册」的兜底表——等待器现在
	 * 在提交 prompt 之前就登记好了（见 submitRun）。
	 */
	private readonly lateRuns = new Map<string, LateRunRecord>();
	/** 「正在输入」凭证缓存（按 chatId）：一次 run 发 status 1/2 两次，只取一次凭证。 */
	private readonly typingTickets = new Map<string, { ticket: string; at: number }>();
	/** 出站 client_id 缓存：按 Bot 账号派生，重启后保持同一个值。 */
	private clientIdCache: { botId: string; id: string } | null = null;

	/** run 代际：/stop 与桥接停止会 +1，让正在按模型链顺延重试的循环立刻退出。 */
	private runGeneration = 0;

	constructor(deps: WeChatBridgeDeps) {
		this.deps = deps;
	}

	getStatus(): WeChatBridgeStatus {
		return this.status;
	}

	/** 启动前的最后一步校验都在这里：没账号/凭据解不开/服务端判失效，都不进轮询。 */
	async start(): Promise<void> {
		this.stopping = false;
		const account = getAccount();
		if (!account) {
			this.setStatus({ status: "disconnected", account: null, activeBindings: loadBindings().length, errorMessage: undefined });
			return;
		}
		const publicAccount = getPublicAccount();
		if (account.needsRelogin) {
			this.setStatus({ status: "error", account: publicAccount, activeBindings: loadBindings().length, errorMessage: "login-required" });
			return;
		}
		const token = getDecryptedBotToken();
		if (!token) {
			// 密文解不开（换了机器或系统凭据变了）。不能拿密文当 token 发出去，也不能
			// 静默当作已登录——直接告诉用户要重扫。
			this.setStatus({ status: "error", account: publicAccount, activeBindings: loadBindings().length, errorMessage: "credential-unavailable" });
			return;
		}

		this.setStatus({ status: "connecting", account: publicAccount, activeBindings: loadBindings().length, errorMessage: undefined });
		this.client = new IlinkClient({ baseUrl: account.baseUrl, channelVersion: ILINK_CHANNEL_VERSION, botAgent: this.deps.botAgent ?? "PiDeck", logger: this.deps.logger });

		const session = this.buildSession();
		if (session) {
			// notifyStart 只是「告知服务端我开始服务」，失败不影响收发（实测非必需），
			// 所以只记日志不阻断——否则一次抖动就让用户以为连不上。
			try {
				await this.client.notifyStart(session);
			} catch (error) {
				this.deps.logger?.("warn", "notifyStart 失败，继续（非必需调用）", error instanceof Error ? error.message : String(error));
			}
		}

		this.setStatus({ status: "connected", account: publicAccount, activeBindings: loadBindings().length, connectedAt: Date.now() });
		if (!this.pollStarted) {
			this.pollStarted = true;
			void this.pollLoop();
		}
	}

	async stop(): Promise<void> {
		this.stopping = true;
		this.runGeneration += 1;
		this.pollStarted = false;
		const client = this.client;
		this.client = null;
		const session = this.buildSession();
		if (client && session) {
			try {
				await client.notifyStop(session);
			} catch {
				// 停机路径的失败不值得打扰用户
			}
		}
		this.activeRun = null;
		this.lateRuns.clear();
		this.typingTickets.clear();
		this.setStatus({ status: "disconnected", account: getPublicAccount(), activeBindings: loadBindings().length });
	}

	/** 会话被删除时清掉指向它的绑定，避免下次收信指向不存在的会话。 */
	removeBindingsForSession(sessionId: string): number {
		const removed = removeBindingsBySessionId(sessionId);
		if (removed > 0) {
			this.setStatus({ activeBindings: loadBindings().length });
			this.notifyBindingsChanged();
		}
		return removed;
	}

	/** 重新读盘并推状态（用户在设置里改工作区/模型、或重新扫码后调用）。 */
	refresh(): void {
		this.setStatus({ account: getPublicAccount(), activeBindings: loadBindings().length, errorMessage: undefined });
		this.notifyBindingsChanged();
	}

	// ===== 收信 =====

	private async pollLoop(): Promise<void> {
		let consecutiveFailures = 0;
		while (!this.stopping) {
			const session = this.buildSession();
			const client = this.client;
			if (!session || !client) return;

			try {
				const { msgs, cursor } = await client.getUpdates(session, session.cursor);
				consecutiveFailures = 0;
				if (cursor && cursor !== session.cursor) {
					setCursor(cursor);
					session.cursor = cursor;
				}
				for (const message of msgs) {
					this.handleIncoming(message);
				}
			} catch (error) {
				if (this.stopping) return;
				if (error instanceof IlinkError && error.kind === "session-expired") {
					// 官方要求：errcode -14 后必须暂停该账号所有调用 1 小时，否则触发风控。
					// 这里直接停轮询并置「需重新扫码」，把节奏交回用户，绝不自动重试。
					markNeedsRelogin();
					this.deps.logger?.("warn", "微信会话已失效（errcode -14），已暂停轮询并要求重新扫码");
					this.setStatus({ status: "error", account: getPublicAccount(), activeBindings: loadBindings().length, errorMessage: "login-required" });
					return;
				}
				consecutiveFailures += 1;
				const delay = consecutiveFailures >= POLL_RETRY_SLOW_AFTER ? POLL_RETRY_SLOW_MS : POLL_RETRY_FAST_MS;
				this.deps.logger?.("warn", `微信收信失败（第 ${consecutiveFailures} 次），${delay}ms 后重试`, error instanceof Error ? error.message : String(error));
				await sleep(delay);
			}
		}
	}

	/**
	 * 单条入站消息的同步分诊。
	 *
	 * 刻意保持**同步前置**：忙判定、命令判定、占位都在任何 await 之前完成，否则两条
	 * 相邻消息会在第一个 await 处交叉，双双进入 run 分支（JS 单线程只保证同步段原子）。
	 * run 本身 fire-and-forget，否则一次长任务会把长轮询卡住，连 /stop 都收不到。
	 */
	private handleIncoming(message: IlinkMessage): void {
		if (message.message_type !== MESSAGE_TYPE_USER) return;
		if (this.isDuplicate(message.message_id)) return;

		const chatId = message.from_user_id;
		const contextToken = message.context_token ?? "";
		if (message.group_id) {
			// 协议里群聊未文档化，能力元数据也只声明单聊。收到就礼貌拒绝，不假装支持。
			this.sendSafe(chatId, contextToken, this.t("text.group"));
			return;
		}
		if (!isAllowedUser(chatId)) {
			// 只有扫码那个微信号能与 Bot 对话。协议侧不拦，这里静默丢弃（不回错误，
			// 免得陌生人探测出「这个 Bot 认人」）。
			this.deps.logger?.("warn", "忽略非绑定用户的消息", chatId.slice(0, 8));
			return;
		}

		const text = extractMessageText(message.item_list ?? []).trim();
		const hasUnsupported = hasUnsupportedItem(message.item_list ?? []);
		if (!text) {
			if (hasUnsupported) this.sendSafe(chatId, contextToken, this.t("text.empty"));
			return;
		}

		this.setStatus({ lastMessageAt: Date.now() });

		if (text.startsWith("/")) {
			// 命令不占 run 槽：否则「正在跑长任务」时连 /stop 都发不进来。
			void this.handleCommand(chatId, contextToken, text).catch((error) => {
				this.deps.logger?.("error", "微信命令处理失败", error instanceof Error ? error.message : String(error));
			});
			return;
		}

		if (this.activeRun) {
			this.sendSafe(chatId, contextToken, this.t("run.busy"));
			return;
		}
		this.activeRun = { chatId, contextToken, startedAt: Date.now() };
		void this.runAgent(chatId, contextToken, text).catch((error) => {
			this.deps.logger?.("error", "微信任务执行失败", error instanceof Error ? error.message : String(error));
		});
	}

	/**
	 * 跑一轮：按模型链逐个尝试，失败自动顺延到下一条。
	 *
	 * 每次提交前先清掉上一次尝试的终态记录，否则顺延重试会立刻拿到旧结果，
	 * 在同一个微任务里空转到链尾（提交后再注册唤醒器还会白等满 300s）。
	 */
	private async runAgent(chatId: string, contextToken: string, text: string): Promise<void> {
		const binding = await this.ensureBinding(chatId);
		if (!binding) {
			this.activeRun = null;
			return;
		}
		const agentId = binding.agentId;
		if (!agentId) {
			this.activeRun = null;
			this.sendSafe(chatId, contextToken, this.t("session.restoreFailed"));
			return;
		}
		if (this.activeRun) this.activeRun.agentId = agentId;

		const generation = this.runGeneration;
		// run_id：官方插件每条出站消息都带（一次生成一个），缺失会被服务端静默丢弃。
		const runId = randomUUID();
		const plan = await this.buildModelPlan(binding);
		// 微信回复不需要推理过程：提交前先把思考档位关了（失败只记日志，不阻断回信）。
		await this.applyRunThinking(binding);
		// 空计划（链条为空且没有显式选择）也要跑一次：null 表示完全不干预会话模型。
		const attempts: Array<WeChatModelChainEntry | null> = plan.length > 0 ? plan : [null];
		let lastFailure: string | undefined;
		// 「正在输入」是体验增强兼下行探针，失败绝不影响回信；开始过就在收尾时关掉。
		let typingStarted = false;

		try {
			for (const [index, entry] of attempts.entries()) {
				// /stop 或桥接停止会推进代际：中断后的顺延必须立刻停，不能换个模型把用户已经停掉的活接着跑。
				if (this.runGeneration !== generation || this.stopping) return;
				if (entry && !(await this.applyRunModel(binding.sessionId, entry))) {
					// 模型切不过去（已删/供应商下线）没有可回的错误原文：不要覆盖上一轮已经拿到的
					// 错误文本，也不要把它拼进回复（「处理失败：p1/fast」只会误导），交给最后的兜底文案。
					continue;
				}
				if (index > 0 && entry) this.deps.logger?.("warn", "微信模型失败，顺延到下一条", `${entry.provider}/${entry.modelId}`);

				if (!typingStarted) typingStarted = await this.signalTyping(chatId, contextToken, 1);

				const outcome = await this.submitRun(binding, text);
				if (this.runGeneration !== generation) return;
				if (outcome.kind === "sendError") {
					this.activeRun = null;
					this.sendSafe(chatId, contextToken, this.t("run.failed", { message: outcome.message }), runId);
					return;
				}
				if (outcome.kind === "timeout") {
					// 超时不等于失败：run 还在跑，结果只能等它真的收口后补发。
					// 必须登记补发等待，否则用户永远等不到回复且没有任何解释。
					// 先登记再发超时提示：调换顺序会漏掉两步之间收口的回合。
					const record: LateRunRecord = { sessionId: binding.sessionId, chatId, contextToken, startedAt: Date.now(), runId, generation };
					this.lateRuns.set(binding.sessionId, record);
					this.activeRun = null;
					void this.deliverLateResult(record, outcome.sinceIndex).catch((error) => this.deps.logger?.("warn", "微信迟到补发失败", error instanceof Error ? error.message : String(error)));
					await this.sendSafe(chatId, contextToken, this.t("run.timeout"), runId);
					return;
				}
				if (outcome.kind === "ok") {
					this.activeRun = null;
					await this.deliverResult({ sessionId: binding.sessionId, chatId, contextToken, runId }, outcome.sinceIndex);
					return;
				}
				lastFailure = outcome.message;
			}

			// 链上的模型全失败（或全部已不可用）：必须回最后一条错误，不能静默。
			// 连错误原文都没有时别发半句话（「处理失败：」），明说要去看日志比留白有用。
			this.activeRun = null;
			const failureMessage = lastFailure?.trim();
			this.sendSafe(chatId, contextToken, failureMessage ? this.t("run.failed", { message: failureMessage }) : this.t("run.failedNoDetail"), runId);
		} finally {
			if (typingStarted) void this.signalTyping(chatId, contextToken, 2);
		}
	}

	/**
	 * 提交一次 prompt 并等它收口；模型顺延由调用方决定，这里只报告结局。
	 *
	 * 「先登记等待器、再提交 prompt」是硬要求：快速失败的 run（模型配置错、鉴权失败）
	 * 会在提交窗口内就广播终态，注册晚于事件会白等满超时。等待器的终态契约是后端
	 * 无差别的（见 sessionRunWaiter），所以 pi 的 agent_end 不再是这里的依赖。
	 */
	private async submitRun(binding: WeChatChatBinding, text: string): Promise<RunAttemptOutcome> {
		const sessionId = binding.sessionId;
		const sinceIndex = this.deps.runtimeBindings.getRuntimeMessages(sessionId).length;
		const waitOutcome = this.deps.runtimeBindings.waitForRunEnd({ sessionId, sinceIndex, timeoutMs: RUN_TIMEOUT_MS });
		try {
			await this.deps.runtimeBindings.sendPrompt({
				sessionId,
				...this.promptPayload(binding, text),
			});
		} catch (error) {
			return { kind: "sendError", message: error instanceof Error ? error.message : String(error) };
		}

		let outcome: SessionRunOutcome;
		try {
			outcome = await waitOutcome;
		} catch (error) {
			// 等待器不该抛；真抛了按提交失败处理，不能让这一轮静默消失。
			return { kind: "sendError", message: error instanceof Error ? error.message : String(error) };
		}
		if (outcome.kind === "timeout") return { kind: "timeout", sinceIndex };
		await sleep(RESULT_SETTLE_MS);
		if (outcome.failed) {
			this.deps.logger?.("warn", "微信 run 以错误结束", outcome.errorMessage ?? "unknown");
			return { kind: "failed", message: outcome.errorMessage };
		}
		return { kind: "ok", sinceIndex };
	}

	/**
	 * 本轮的模型尝试计划。模型链是「默认 + 兜底」，不是硬绑定：
	 * - 链条为空且没有显式选择 → 空计划，完全不干预会话模型（旧行为）。
	 * - 显式 /model 选中的模型（binding.modelProvider + modelId）最优先。
	 * - 会话当前模型不在链条里（用户在桌面端手选过）→ 排在最前，尊重用户选择；失败后仍顺延到链条。
	 * - 当前模型在链条里但不在首位 → 从链首重新开始（上一轮顺延后的自愈）。
	 */
	private async buildModelPlan(binding: WeChatChatBinding): Promise<WeChatModelChainEntry[]> {
		// 模型链是 pi 目录的词汇表（provider/modelId）：DSH 只认 /model 的显式选择，
		// 套用 pi 链会变成一串注定被 host 拒掉的 selectModel，白等 8 次。
		const chain = this.bindingBackend(binding) === "pi" ? normalizeModelChain(getSettings().modelChain) : [];
		const explicit = binding.modelProvider && binding.modelId ? { provider: binding.modelProvider, modelId: binding.modelId } : undefined;
		if (chain.length === 0 && !explicit) return [];
		const current = await this.readRuntimeModel(binding.sessionId);
		const entries: WeChatModelChainEntry[] = [];
		const push = (entry: WeChatModelChainEntry) => {
			if (!entry.provider || !entry.modelId) return;
			if (entries.some((candidate) => candidate.provider === entry.provider && candidate.modelId === entry.modelId)) return;
			entries.push(entry);
		};
		if (explicit) push(explicit);
		if (current?.provider && current.modelId && !chain.some((entry) => entry.provider === current.provider && entry.modelId === current.modelId)) {
			push({ provider: current.provider, modelId: current.modelId });
		}
		for (const entry of chain) push(entry);
		return entries;
	}

	/** 把会话切到指定模型；失败（模型已删/供应商下线）返回 false，让调用方顺延到下一条。 */
	private async applyRunModel(sessionId: string, entry: WeChatModelChainEntry): Promise<boolean> {
		const current = await this.readRuntimeModel(sessionId);
		if (current?.provider === entry.provider && current.modelId === entry.modelId) return true;
		try {
			await this.deps.runtimeBindings.setRuntimeModel(sessionId, entry.provider, entry.modelId);
			return true;
		} catch (error) {
			this.deps.logger?.("warn", "微信切换模型失败，尝试下一条", `${entry.provider}/${entry.modelId}: ${error instanceof Error ? error.message : String(error)}`);
			return false;
		}
	}

	private async readRuntimeState(sessionId: string): Promise<AgentRuntimeState | undefined> {
		try {
			return await this.deps.runtimeBindings.getRuntimeState(sessionId);
		} catch {
			// 运行时还没绑定/已失效：拿不到状态不等于失败。
			return undefined;
		}
	}

	private async readRuntimeModel(sessionId: string): Promise<{ provider?: string; modelId?: string } | undefined> {
		const state = await this.readRuntimeState(sessionId);
		return state ? { provider: state.provider, modelId: state.modelId } : undefined;
	}

	/**
	 * 微信驱动的 run 一律关思考。
	 *
	 * 微信只有纯文本：推理过程对用户既不可见也没用（会被 weChatText 剔掉），推理 token 也白花，
	 * 所以由通道钦定 off，而不是继承会话档位。已经关着就不重复切（协调器也会去重）。
	 * 切档会写回该会话的偏好；桌面端把同一会话改成高思考后，微信再发消息会被重新拉回 off。
	 * 切档失败不影响回信。
	 */
	private async applyRunThinking(binding: WeChatChatBinding): Promise<void> {
		const state = await this.readRuntimeState(binding.sessionId);
		if (state?.thinkingLevel === "off") return;
		try {
			await this.deps.runtimeBindings.setRuntimeThinking(binding.sessionId, "off");
		} catch (error) {
			this.deps.logger?.("debug", "微信关闭思考失败（不影响回信）", error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * 新建/恢复会话后把链条首项设为默认模型。只在会话开始时设置而不在每轮 run 前强制，
	 * 这样用户在桌面端给某个会话手选的模型不会被微信的每条消息拉回链首。
	 */
	private async applyChainDefault(binding: WeChatChatBinding): Promise<void> {
		if (binding.modelProvider) return;
		if (this.bindingBackend(binding) !== "pi") return;
		const first = normalizeModelChain(getSettings().modelChain)[0];
		if (!first) return;
		await this.applyRunModel(binding.sessionId, first);
	}

	/**
	 * 该绑定会话当前实际在用的模型（设置页显示「当前会话模型」用）。
	 *
	 * 拿不到运行时（进程没起/状态未就绪）就返回 undefined：界面宁可少显示一行，
	 * 也不能把上次点过的模型冒充成「现在用的模型」。
	 */
	async getBindingModel(binding: WeChatChatBinding): Promise<WeChatBindingModel | undefined> {
		const state = await this.readRuntimeState(binding.sessionId);
		if (!state?.provider || !state.modelId) return undefined;
		return { provider: state.provider, modelId: state.modelId, modelName: state.modelName };
	}

	/**
	 * 首次建立绑定时，把会话当前真实模型写进模型链链首。
	 *
	 * 为什么写进设置而不是只在界面上显示：链为空时设置页只有一句「使用会话当前模型」，
	 * 用户看不到模型名，也没法据此调整顺序；写一条进链里，链首即新会话的默认模型，
	 * 语义不变但看得见。只在链为空时播种：用户之后删掉链项是有意为之，不该被下一条消息写回来。
	 */
	private async seedModelChain(sessionId: string): Promise<void> {
		// 播种只是让设置页看得见的锦上添花：读不到运行时或写设置失败都不能拖垮会话绑定。
		try {
			if (normalizeModelChain(getSettings().modelChain).length > 0) return;
			const state = await this.readRuntimeState(sessionId);
			if (!state?.provider || !state.modelId) return;
			updateSettings({ modelChain: [{ provider: state.provider, modelId: state.modelId, modelName: state.modelName }] });
			this.deps.logger?.("info", `微信已把会话当前模型写入模型链链首：${state.provider}/${state.modelId}`);
		} catch (error) {
			this.deps.logger?.("warn", "微信模型链播种失败（不影响本次回复）", error instanceof Error ? error.message : String(error));
		}
	}

	/**
	 * 读最近一条助手消息并回信。超时补发与正常投递共用这一条路径。
	 *
	 * 没有正文时必须再找后端错误：回合「正常收口」不等于成功。供应商欠费/鉴权失败在
	 * 很多后端上就表现为「跑完了但没有正文」，DSH 更是把错误留在 turn/end 的 role=error
	 * 消息里（可能晚于 idle 快照到达）。只回一句「任务已完成但没有文本」会让用户以为成功——
	 * 错误原文才是他要的信息。
	 */
	private async deliverResult(target: { sessionId: string; chatId: string; contextToken: string; runId?: string }, sinceIndex = 0): Promise<void> {
		// sinceIndex：顺延重试时只认本轮新产生的消息，否则会把上一次失败留下的错误文本当成结果回信。
		const readTurnMessages = () => this.deps.runtimeBindings.getRuntimeMessages(target.sessionId).slice(sinceIndex);
		let messages = readTurnMessages();
		let raw = pickLatestAssistantText(messages);
		if (!raw && !pickLatestFailureText(messages)) {
			// 空手收口：多等一拍再读一次，等后到的错误消息落进时间线。
			await sleep(EMPTY_RESULT_RETRY_MS);
			messages = readTurnMessages();
			raw = pickLatestAssistantText(messages);
		}
		if (raw) {
			await this.sendSafe(target.chatId, target.contextToken, raw, target.runId);
			return;
		}
		const failure = pickLatestFailureText(messages);
		if (failure) {
			await this.sendSafe(target.chatId, target.contextToken, this.t("run.failed", { message: failure }), target.runId);
			return;
		}
		this.sendSafe(target.chatId, target.contextToken, this.t("run.noText"), target.runId);
	}

	// ===== 命令 =====

	private async handleCommand(chatId: string, contextToken: string, text: string): Promise<void> {
		const [rawCommand, ...rest] = text.trim().split(/\s+/);
		const command = rawCommand.toLowerCase();
		const argument = rest.join(" ").trim();

		switch (command) {
			case "/help":
			case "/?":
				await this.sendSafe(chatId, contextToken, `${this.t("help.title")}\n${this.t("help.body")}\n\n${this.t("help.hint")}`);
				return;
			case "/new": {
				const binding = getBinding(chatId);
				if (binding) {
					// 只解绑不删会话：会话本身仍在桌面端，用户可能还想继续用。
					removeBinding(chatId);
					this.notifyBindingsChanged();
				}
				const created = await this.ensureBinding(chatId, { forceNew: true });
				if (created) {
					await this.sendSafe(chatId, contextToken, this.t("session.created", { id: created.sessionId.slice(0, 8) }));
				}
				return;
			}
			case "/stop": {
				const binding = getBinding(chatId);
				if (!binding) {
					await this.sendSafe(chatId, contextToken, this.t("run.nothing"));
					return;
				}
				await this.deps.runtimeBindings.abortRuntime(binding.sessionId);
				this.runGeneration += 1;
				this.activeRun = null;
				// 取消可能挂着的超时补发：用户已经停掉的活不该在收口后再回一条。
				this.lateRuns.delete(binding.sessionId);
				await this.sendSafe(chatId, contextToken, this.t("run.stopped"));
				return;
			}
			case "/status": {
				const binding = getBinding(chatId);
				if (!binding) {
					await this.sendSafe(chatId, contextToken, this.t("session.none"));
					return;
				}
				const state = await this.deps.runtimeBindings.getRuntimeState(binding.sessionId);
				const model = state?.modelName ?? state?.modelId ?? binding.modelId ?? "-";
				await this.sendSafe(
					chatId,
					contextToken,
					this.t("session.status", {
						id: binding.sessionId.slice(0, 8),
						workspace: binding.workspaceId || this.projectName(binding.workspaceId),
						model,
						state: this.activeRun ? "running" : "idle",
					}),
				);
				return;
			}
			case "/model": {
				await this.handleModelCommand(chatId, contextToken, argument);
				return;
			}
			default:
				await this.sendSafe(chatId, contextToken, `${this.t("help.title")}\n${this.t("help.body")}`);
		}
	}

	private async handleModelCommand(chatId: string, contextToken: string, argument: string): Promise<void> {
		const binding = getBinding(chatId);
		if (!binding) {
			await this.sendSafe(chatId, contextToken, this.t("session.none"));
			return;
		}
		const models = await this.deps.runtimeBindings.listRuntimeModels(binding.sessionId);
		if (models.length === 0) {
			await this.sendSafe(chatId, contextToken, this.t("model.empty"));
			return;
		}
		if (!argument) {
			const state = await this.deps.runtimeBindings.getRuntimeState(binding.sessionId);
			const current = state?.modelName ?? state?.modelId ?? binding.modelId ?? "-";
			// 模型可能上百个，列举要截断并说明截断了——静默截断会让人以为列表就是全部。
			const listed = models.slice(0, 30).map((model) => `- ${model.provider}/${model.id}`);
			if (models.length > listed.length) listed.push(`… +${models.length - listed.length}`);
			await this.sendSafe(chatId, contextToken, `${this.t("model.current", { model: current })}\n${listed.join("\n")}\n\n${this.t("model.usage")}`);
			return;
		}
		const target = argument.toLowerCase();
		const match = models.find((model) => `${model.provider}/${model.id}`.toLowerCase() === target) ?? models.find((model) => model.id.toLowerCase() === target) ?? models.find((model) => model.name?.toLowerCase() === target);
		if (!match) {
			await this.sendSafe(chatId, contextToken, this.t("model.invalid", { model: argument }));
			return;
		}
		await this.deps.runtimeBindings.setRuntimeModel(binding.sessionId, match.provider, match.id);
		// 记下 provider：只有「带 provider 的显式选择」才压过设置里的模型链。
		upsertBinding({ ...binding, modelId: match.id, modelProvider: match.provider });
		await this.sendSafe(chatId, contextToken, this.t("model.switched", { model: `${match.provider}/${match.id}` }));
	}

	// ===== 会话绑定 =====

	/**
	 * 取得可用的 agent 句柄。已有绑定时校验句柄仍然有效（网关会核对 sessionId 身份），
	 * 失败就重新激活同一个 sessionId；只有 /new 才真的新建会话。
	 */
	private async ensureBinding(chatId: string, options?: { forceNew?: boolean }): Promise<WeChatChatBinding | undefined> {
		const current = getBinding(chatId);
		const existing = options?.forceNew ? undefined : current;
		if (existing) {
			// 设置页换后端等于换引擎：旧绑定的会话文件与模型目录都属于另一个引擎，复用旧 sessionId
			// 只会让它静默跑在旧引擎上（用户以为切了后端其实没切）。这种情况按换绑处理，开新会话。
			const settingsBackend = getSettings().backend ?? "pi";
			if ((existing.backend ?? "pi") !== settingsBackend) {
				this.deps.logger?.("info", `微信会话后端变更（${existing.backend ?? "pi"} → ${settingsBackend}），换绑新会话`);
				return this.activateBinding(existing, chatId, { backendChanged: true });
			}
			const agentId = await this.authorizeRuntimeAgent(existing);
			if (agentId) return { ...existing, agentId };
		}
		// firstBinding 只在「这个 chat 从来没绑过」时为真：/new 与换后端都是用户有意的动作，
		// 不该顺手把用户清空的模型链又写回来（见 seedModelChain）。
		return this.activateBinding(existing, chatId, { firstBinding: current === undefined });
	}

	/** 句柄复用必须同时满足「进程还活着」与「网关认可同一个稳定 sessionId」。 */
	private async authorizeRuntimeAgent(binding: WeChatChatBinding): Promise<string | undefined> {
		if (!binding.agentId) return undefined;
		const tab = this.deps.runtimeBindings.findRuntimeAgent(binding.agentId);
		if (!tab || tab.status === "error" || tab.status === "closed") {
			upsertBinding({ ...binding, agentId: undefined });
			return undefined;
		}
		try {
			const runtimeBinding = await this.deps.runtimeBindings.bindRuntime({ projectId: tab.projectId, agent: tab, existingSessionId: binding.sessionId });
			if (runtimeBinding.sessionId !== binding.sessionId) {
				throw new Error(`runtime gateway returned a different session: ${runtimeBinding.sessionId}`);
			}
			return tab.id;
		} catch (error) {
			this.deps.logger?.("warn", "微信绑定句柄校验失败，重新激活会话", error instanceof Error ? error.message : String(error));
			upsertBinding({ ...binding, agentId: undefined });
			return undefined;
		}
	}

	/**
	 * 新建/恢复会话并写回绑定。
	 *
	 * `backendChanged` 表示本次激活是设置页把渠道后端换成了另一个引擎（pi ↔ dsh）：旧绑定的
	 * sessionId/sessionPath 与模型都作废（跨引擎没有可续的历史，模型目录也不是同一套词汇），
	 * 必须真的开新会话，否则新后端只是设置里的摆设。
	 *
	 * `firstBinding` 表示这个 chat 从来没绑过：此时把会话当前模型播种进模型链（见 seedModelChain）。
	 */
	private async activateBinding(existing: WeChatChatBinding | undefined, chatId: string, options?: { backendChanged?: boolean; firstBinding?: boolean }): Promise<WeChatChatBinding | undefined> {
		const projects = this.deps.getProjects();
		if (projects.length === 0) {
			this.sendSafe(chatId, this.currentContextToken(chatId), this.t("project.required"));
			return undefined;
		}
		const preferred = existing?.workspaceId || getSettings().defaultWorkspaceId || "";
		// 工作区优先序：已有绑定 > 设置里的默认工作区 > 项目列表第一项（约等于最近使用）。工作区不因换后端而变化。
		const projectId = projects.some((project) => project.id === preferred) ? preferred : projects[0].id;
		// 换后端走全新会话（标题也用新会话形态）；其余情况已有绑定沿用自身后端与模型，设置只影响新建绑定。
		const reuse = options?.backendChanged ? undefined : existing;
		const title = reuse ? "微信对话" : `微信 ${chatId.slice(-4)}`;
		const backend: ImChannelBackend = reuse ? (reuse.backend ?? "pi") : (getSettings().backend ?? "pi");

		try {
			let session = await this.deps.runtimeBindings.ensureSession({
				projectId,
				title,
				existingSessionId: reuse?.sessionId,
				sessionPath: reuse?.sessionPath,
				backend,
				// 微信会话在侧栏带渠道标志，并像桌面会话一样由 pi 侧自动命名
				// （桥给的「微信 xxxx」只是首条消息前的占位，不再锁死标题所有权）。
				channel: "wechat",
				autoTitle: true,
			});
			let tab: AgentTab;
			try {
				tab = await this.deps.runtimeBindings.activateRuntime(session.sessionId);
			} catch (error) {
				// 历史 sessionPath 恢复失败（文件被删/格式变化）时退化为新会话，
				// 而不是让这个 chat 永久卡在错误上。
				if (!reuse?.sessionPath) throw error;
				this.deps.logger?.("warn", "微信会话恢复失败，改新建", error instanceof Error ? error.message : String(error));
				session = await this.deps.runtimeBindings.ensureSession({ projectId, title: `微信 ${chatId.slice(-4)}`, backend, channel: "wechat", autoTitle: true });
				tab = await this.deps.runtimeBindings.activateRuntime(session.sessionId);
			}
			const binding: WeChatChatBinding = {
				chatId,
				userId: chatId,
				backend,
				sessionId: session.sessionId,
				sessionPath: tab.sessionPath,
				workspaceId: projectId,
				// 跨引擎的模型 id 不是同一套词汇，换绑后不留旧模型的 pin（留了只会连续选模失败）。
				modelId: reuse?.modelId,
				createdAt: existing?.createdAt ?? Date.now(),
				agentId: tab.id,
			};
			upsertBinding(binding);
			// 首次绑定：先把会话真在用的模型写进链首，让设置页一眼看到「现在用的是哪个模型」。
			// DSH 的模型不是 pi 目录的词汇，链条对它是空计划，不播种。
			if (options?.firstBinding && backend === "pi") await this.seedModelChain(binding.sessionId);
			// 链条首项作为这个会话的默认模型；失败不阻断建会话（没有模型也能先回错误提示）。
			await this.applyChainDefault(binding);
			this.setStatus({ activeBindings: loadBindings().length });
			this.notifyBindingsChanged();
			if (options?.backendChanged) {
				// 换绑后原会话的上下文不再延续，必须主动说明，否则用户会把「新会话没上下文」当成丢消息。
				await this.sendSafe(chatId, this.currentContextToken(chatId), this.t("session.backendSwitched", { backend: backend === "dsh" ? "DSH" : "pi", id: session.sessionId.slice(0, 8) }));
			}
			return binding;
		} catch (error) {
			this.deps.logger?.("error", "微信会话激活失败", error instanceof Error ? error.message : String(error));
			// 后端不可用（DSH 未安装/待更新）是用户自己能解决的原因，必须单独说清楚；
			// 其它失败保持笼统提示（细节在日志里）。边界层只给错误码，文案由通道词典决定。
			const key: WeChatTranslationKey = errorCodeOf(error) === "dshUnavailable" ? "session.backendUnavailable" : "session.createFailed";
			this.sendSafe(chatId, this.currentContextToken(chatId), this.t(key));
			return undefined;
		}
	}

	// ===== 超时补发 =====

	/**
	 * 超时后等回合真的收口再补发结果。
	 *
	 * 记录的对象身份就是取消凭证：/stop、桥接停止或新的一轮把它从表里删掉后，
	 * 迟到的收口事件即使唤醒等待器也不会再回信。投递窗口有上限：回信必须带该条
	 * 消息的 context_token，过期后发出去也会被服务端丢弃，所以超窗直接放弃。
	 */
	private async deliverLateResult(record: LateRunRecord, sinceIndex: number): Promise<void> {
		const outcome = await this.deps.runtimeBindings.waitForRunEnd({ sessionId: record.sessionId, sinceIndex, timeoutMs: LATE_DELIVERY_MAX_MS });
		if (outcome.kind === "timeout") return;
		if (this.lateRuns.get(record.sessionId) !== record) return;
		this.lateRuns.delete(record.sessionId);
		if (this.stopping || record.generation !== this.runGeneration) return;
		if (Date.now() - record.startedAt > LATE_DELIVERY_MAX_MS) {
			this.deps.logger?.("warn", "微信迟到结果已超出投递窗口，放弃回信");
			return;
		}
		await sleep(RESULT_SETTLE_MS);
		await this.deliverResult(record, sinceIndex);
	}

	// ===== 发送 =====

	/** 出站统一入口：Markdown 降级 → 分片 → 逐条发。失败不抛（回信失败不该打断会话）。 */
	private async sendSafe(chatId: string, contextToken: string, text: string, runId?: string): Promise<void> {
		const client = this.client;
		const session = this.buildSession();
		if (!client || !session) return;
		if (!contextToken) {
			// 没有 context_token 就无法回信（协议要求）。这只会出现在「桌面端主动发」的
			// 场景，微信不支持，直接放弃而不是发一条注定失败的请求。
			this.deps.logger?.("warn", "缺 context_token，跳过发送");
			return;
		}
		const chunks = splitForWeChat(prepareOutgoingText(text));
		if (chunks.length === 0) return;
		// client_id 是服务端的幂等去重键，必须每条消息唯一：常量 client_id 会让换绑后的
		// 第二条回复起被静默丢弃（仍回 200+message_id，日志全绿）。前缀标识客户端，
		// runId/随机数 + 分片序号保证唯一；同一次回复的分片共享 scope，排障时可聚合。
		const base = this.clientId();
		const scope = runId ?? randomUUID();
		for (let index = 0; index < chunks.length; index += 1) {
			const clientId = base ? `${base}-${scope}-${index}` : undefined;
			try {
				await client.sendText(session, { toUserId: chatId, contextToken, text: chunks[index], clientId, runId });
			} catch (error) {
				this.deps.logger?.("warn", "微信发送失败", error instanceof Error ? error.message : String(error));
				this.setStatus({ errorMessage: "send-failed" });
				return;
			}
			if (index < chunks.length - 1) await sleep(MULTI_CHUNK_GAP_MS);
		}
	}

	/**
	 * 发「正在输入」（status 1 开始 / 2 结束）。
	 *
	 * 除了产品体验，它还是**下行探针**：正文收不到但「正在输入」能看到，说明通道活着、
	 * 问题在内容渲染或风控；连 typing 都收不到，就是账号级下行限制。所以这里的失败
	 * 只记 debug 日志，绝不写 status.errorMessage（别把探针失败说成发送失败）。
	 */
	private async signalTyping(chatId: string, contextToken: string, status: 1 | 2): Promise<boolean> {
		const client = this.client;
		const session = this.buildSession();
		if (!client || !session || !contextToken) return false;
		try {
			let cached = this.typingTickets.get(chatId);
			if (!cached || Date.now() - cached.at > TYPING_TICKET_TTL_MS) {
				const config = await client.getConfig(session, chatId, contextToken);
				const ticket = config.typing_ticket;
				if (!ticket) return false;
				cached = { ticket, at: Date.now() };
				this.typingTickets.set(chatId, cached);
			}
			await client.sendTyping(session, chatId, cached.ticket, status);
			return true;
		} catch (error) {
			this.deps.logger?.("debug", "微信正在输入信号失败（不影响回信）", error instanceof Error ? error.message : String(error));
			return false;
		}
	}

	/**
	 * 出站 client_id 前缀：标识「这条消息是 PiDeck 发的」。官方入站 client_id 每条都
	 * 内嵌时间戳+递增计数，社区协议文档（epiral / Chrysochrome ilink-bot-server）一致
	 * 写明它是幂等去重键、必须全局唯一——所以本值只当前缀，真正保证每条唯一的
	 * 是 sendSafe 拼上的 scope+分片序号，别把它当「实例级稳定 ID」整条发送。
	 */
	private clientId(): string | undefined {
		const account = getAccount();
		if (!account) return undefined;
		if (this.clientIdCache?.botId !== account.ilinkBotId) {
			const digest = createHash("sha256").update(account.ilinkBotId).digest("hex").slice(0, 16);
			this.clientIdCache = { botId: account.ilinkBotId, id: `pideck-${digest}` };
		}
		return this.clientIdCache.id;
	}

	/** 通道指令（pi 走宿主指令通道，其它后端并进正文）：把通道约束告诉 Agent。 */
	private channelInstructions(): string {
		return [
			"当前会话已连接微信（iLink 私聊通道）。微信只支持纯文本：不要输出 Markdown 表格、代码围栏、图片或链接语法，表格请改成分行列表，PiDeck 会在回复前做纯文本降级。",
			"不要调用任何微信/IM 发送接口、CLI 或工具来发消息，也不要询问 chat_id：你的最终回答会自动回复给微信用户。",
			"该通道不支持发送文件、图片与引用消息；需要用户手动取用文件时，直接给出绝对路径。",
			"微信通道不能主动推送消息，用户只有发消息时才能收到回复。",
			`请用${weChatLanguage(this.locale())}回答。`,
		].join("\n");
	}

	/**
	 * 提交给运行时的 prompt 载荷。
	 *
	 * pi 有宿主指令通道（agentMessage：不落用户气泡、只影响本轮），所以指令与正文分开提交。
	 * dsh 没有等价物，整条 prompt 带 agentMessage 会被直接拒（DshAgentManager：
	 * "DSH host instructions are not supported"），只能把指令并进正文——通道约束
	 * （纯文本、别调 IM 接口）比「时间线干净」重要，不能因为换引擎就丢掉。
	 */
	private promptPayload(binding: WeChatChatBinding, text: string): { message: string; agentMessage?: string } {
		const instructions = this.channelInstructions();
		const withInstructions = text ? `${instructions}\n\n${text}` : instructions;
		if (this.bindingBackend(binding) !== "pi") return { message: withInstructions };
		return { message: text, agentMessage: withInstructions };
	}

	/** 绑定的后端（缺省 pi）：设置只决定新建会话，已有绑定跟会话走。 */
	private bindingBackend(binding: WeChatChatBinding): ImChannelBackend {
		return binding.backend ?? "pi";
	}

	// ===== 辅助 =====

	private buildSession(): IlinkSession | null {
		const account = getAccount();
		if (!account) return null;
		const token = getDecryptedBotToken();
		if (!token) return null;
		return {
			botToken: token,
			baseUrl: account.baseUrl,
			ilinkBotId: account.ilinkBotId,
			ilinkUserId: account.ilinkUserId,
			cursor: getCursor(),
		};
	}

	/**
	 * 只在需要回「忙/失败」提示时用作兜底。真正处理消息时用的是消息自带的 token
	 * （这里没有别的来源，微信不支持凭空的会话引用）。
	 */
	private currentContextToken(_chatId: string): string {
		return this.activeRun?.contextToken ?? "";
	}

	private locale(): WeChatLocale {
		return normalizeWeChatLocale(this.deps.getLocale());
	}

	private t(key: WeChatTranslationKey, params?: Record<string, string | number>): string {
		return wechatT(this.locale(), key, params);
	}

	private projectName(projectId: string): string {
		return this.deps.getProjects().find((project) => project.id === projectId)?.name ?? projectId;
	}

	private isDuplicate(messageId: number): boolean {
		if (this.seenMessageSet.has(messageId)) return true;
		this.seenMessageSet.add(messageId);
		this.seenMessages.push(messageId);
		if (this.seenMessages.length > DEDUP_MAX) {
			const evicted = this.seenMessages.shift();
			if (evicted !== undefined) this.seenMessageSet.delete(evicted);
		}
		return false;
	}

	private setStatus(patch: Partial<WeChatBridgeStatus>): void {
		this.status = { ...this.status, ...patch };
		try {
			this.deps.onStatusChange?.(this.status);
		} catch (error) {
			this.deps.logger?.("warn", "微信状态回调抛错", error instanceof Error ? error.message : String(error));
		}
	}

	private notifyBindingsChanged(): void {
		try {
			this.deps.onBindingsChange?.();
		} catch (error) {
			this.deps.logger?.("warn", "微信绑定回调抛错", error instanceof Error ? error.message : String(error));
		}
	}
}

/** 错误对象上挂的机器可读错误码（跨模块传递原因，避免在装配层写文案）。 */
function errorCodeOf(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	const code: unknown = error.code;
	return typeof code === "string" ? code : undefined;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
