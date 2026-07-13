import { app, type BrowserWindow, Notification } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { homedir } from "node:os";
import type {
	AgentRuntimeState,
	AgentTab,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	ForkMessage,
	ImageContent,
	Project,
	SendPromptInput,
	ThinkingUpdate,
} from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";
import { PiProcess } from "./PiProcess";
import type { RpcResponse } from "./PiRpcClient";
import { formatBashToolMessage } from "./bashResult";
import { extractMessageText } from "./messageContent";
import type { SettingsStore } from "../settings/SettingsStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { RpcLogger } from "../logging/RpcLogger";
import type { AppLogger } from "../logging/AppLogger";

/** 项目信任确认弹窗的用户选择 */
export type ProjectTrustChoice = "trust-remember" | "trust-session" | "deny";

export class AgentManager {
	private readonly agents = new Map<string, AgentRuntime>();
	private readonly messages = new Map<string, ChatMessage[]>();

	/** 当前流式思考的累积文本，用于实时推送给前端展示 */
	private readonly streamingThinking = new Map<string, string>();
	/** 当前正在流式更新的 assistant 消息；tool 事件插入时仍要继续更新同一个回答块。 */
	private readonly activeAssistantMessageIds = new Map<string, string>();
	/** pi 的 toolCallId 贯穿 start/update/end，用它把同一次工具调用合并成一条 UI 记录。 */
	private readonly toolMessageIds = new Map<string, Map<string, string>>();
	/** 每个 agent 只保留一条自动重试状态消息，避免短暂 5xx/网络错误把会话刷屏。 */
	private readonly retryStatusMessageIds = new Map<string, string>();
	/** 同一历史会话正在创建 Agent 时共享同一个 Promise，避免快速重复点击/IPC 竞态创建多个进程。 */
	private readonly creatingSessionAgents = new Map<string, Promise<AgentTab>>();
	/** 记录每个 agent 当前执行的工具名称，无工具时为 null */
	private readonly toolExecutingByAgent = new Map<string, string | null>();
	/** 缓存每个 agent 的 entryId → JSONL 行号映射，用于编辑/删除定位。每次 loadMessages 后刷新。 */
	private readonly entryIdToLineMap = new Map<string, Map<string, number>>();
	/** 每个 agent 的会话文件写入锁，防止并发 readFile→modify→writeFile 操作破坏 JSONL 文件 */
	private readonly sessionLocks = new Map<string, Promise<void>>();
	/** 流式消息 emit 节流状态。 */
	private readonly messageFlushTimers = new Map<string, NodeJS.Timeout>();
	private readonly pendingMessageAgents = new Set<string>();
	/** 流式 emit 合并窗口（毫秒）。50ms 兼顾流畅度与传输量，肉眼几乎无延迟。 */
	private static readonly MESSAGE_FLUSH_INTERVAL_MS = 50;
	/**
	 * 工具结果文本截断阈值（字符数）。工具结果（如 bash 输出、文件读取）可能达数十 KB，
	 * 若完整存入 ChatMessage.meta 并随流式 emit 反复全量传输，会显著放大 IPC payload
	 * 并推高渲染进程内存，是大会话白屏的重要诱因。超长结果保留首尾各一部分，中间省略。
	 */
	private static readonly MAX_TOOL_RESULT_CHARS = 8000;
	/** 本地事件监听器（用于 FeishuBridge 等主进程内部订阅） */
	private readonly localEventListeners = new Set<(agentId: string, event: unknown) => void>();
	/** 状态变更监听器（用于 PetStateBridge 等主进程内部模块订阅 AgentTab[] 聚合状态） */
	private readonly stateListeners = new Set<(tabs: AgentTab[]) => void>();
	/** 开启了 RPC 日志记录的 agent id 集合 */
	private readonly rpcLoggingAgents = new Set<string>();
	/** 正在执行手动压缩操作的 agent，用于区分手动压缩重启和异常崩溃 */
	private readonly compactingAgents = new Set<string>();
	/**
	 * Pi 通过事件报告正在自动/手动压缩的 agent。
	 * 自动压缩发生在 agent_end 之后，桌面端若不单独追踪，会过早把会话置为 idle，
	 * 用户随后发送的新消息可能撞上 Pi 内部 compaction，表现为“会话中断”。
	 */
	private readonly rpcCompactingAgents = new Set<string>();
	/** 用户主动停止的 agent，用于退出处理器中跳过自动重连 */
	private readonly userInitiatedStop = new Set<string>();
	/** 已尝试过自动重连的 agent（防止无限循环），重连成功后清除 */
	private readonly autoRestartAttempted = new Set<string>();

	/**
	 * 待处理的 Extension UI 请求。key 为 agentId，value 为 Map<requestId, { method, title, options }>。
	 * 用于在 abort 时及时发送 cancellation 防止 pi 等待超时。
	 */
	private readonly pendingUIRequests = new Map<string, Map<string, { method: string; title: string }>>();
	/** abort 时正在等待 ask_question 响应的 agent，用于在工具结果中覆写 answer 为 null。 */
	private readonly abortedDuringAsk = new Set<string>();
	/** 待处理的项目信任确认请求。key 为 requestId，用于在 Agent 启动前等待用户的信任决策。 */
	private readonly pendingTrustRequests = new Map<string, { resolve: (choice: ProjectTrustChoice) => void }>();

	constructor(
		private readonly getProject: (id: string) => Project | undefined,
		private readonly getWindow: () => BrowserWindow | null,
		private readonly settingsStore: SettingsStore,
		private readonly configManager: ConfigManager,
		private readonly rpcLogger?: RpcLogger,
		private readonly appLogger?: AppLogger,
	) {}

	list() {
		return [...this.agents.values()]
			.map((runtime) => runtime.tab)
			.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
	}

	/**
	 * 判断指定项目是否仍有运行中的 Agent（pi 子进程未退出）。
	 * 用于删除项目前拦截，避免删除后 pi 进程悬挂后台继续占用资源。
	 */
	hasAgentForProject(projectId: string): boolean {
		for (const runtime of this.agents.values()) {
			if (runtime.tab.projectId === projectId) return true;
		}
		return false;
	}

	getMessages(agentId: string) {
		return this.messages.get(agentId) ?? [];
	}

	recordHostExchange(agentId: string, userText: string, assistantText: string) {
		this.addMessage(agentId, "user", userText);
		this.addMessage(agentId, "assistant", assistantText);
	}

	getCwd(agentId: string) {
		return this.requireRuntime(agentId).tab.cwd;
	}

	async loadMessages(agentId: string, skipEntries = false, earlyMessagesPromise?: Promise<RpcResponse>) {
		const t0 = Date.now();
		const runtime = this.requireRuntime(agentId);

		// 并行请求：get_messages 和 get_entries 互不依赖，可以同时发起
		// 如果已有提前发出的请求（earlyMessagesPromise），直接复用，避免重复发送
		const messagesPromise = earlyMessagesPromise ?? runtime.process.client.request({
			type: "get_messages",
		});

		let entriesPromise: Promise<any> | undefined;
		if (!skipEntries) {
			entriesPromise = runtime.process.client.request({
				type: "get_entries",
			}, 15_000).catch(() => {
				// get_entries 失败时不阻塞消息加载；编辑/删除走 fallback（_piDeckMsgSeq 计数）
				void this.appLogger?.warn("agent", "Failed to get_entries for entryId mapping", { agentId });
				return undefined;
			});
		}

		const [response, entriesResult] = await Promise.all([
			messagesPromise,
			entriesPromise ?? Promise.resolve(undefined),
		]);
		const t1 = Date.now();

		const rawMessages = (response.data as { messages?: unknown[] } | undefined)?.messages ?? [];
		const trimmed = this.trimHistoryMessages(rawMessages);

		// 解析 entryId 列表
		let activeEntryIds: string[] | undefined;
		if (entriesResult) {
			const entriesData = entriesResult.data as
				| { entries?: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>; leafId?: string }
				| undefined;
			if (entriesData?.entries && entriesData?.leafId) {
				activeEntryIds = this.buildActiveBranchEntryIds(entriesData.entries, entriesData.leafId);
			}
		}

		const messages = this.convertAgentMessages(agentId, trimmed, activeEntryIds);
		const t2 = Date.now();
		void this.appLogger?.info("agent", "Agent messages loaded", {
			agentId,
			skipEntries,
			rawMessages: rawMessages.length,
			trimmedMessages: trimmed.length,
			requestMs: t1 - t0,
			convertMs: t2 - t1,
			totalMs: t2 - t0,
		});
		// abort 时 ask_question 的 answer 已被覆写为 null，不再需要跟踪
		this.abortedDuringAsk.delete(agentId);
		this.messages.set(agentId, messages);
		this.refreshAutoTitle(agentId);
		this.scheduleMessageEmit(agentId, true);
		return messages;
	}

	async create(input: CreateAgentInput) {
		const sessionKey = this.normalizeSessionPathForCompare(input.sessionPath);
		if (!sessionKey) return this.createUnlocked(input);

		const existingForSession = this.findRuntimeBySessionKey(sessionKey);
		if (existingForSession) return existingForSession.tab;

		const pendingCreate = this.creatingSessionAgents.get(sessionKey);
		if (pendingCreate) return pendingCreate;

		// 历史会话激活属于“一个 sessionPath 只能对应一个 Agent”的业务规则；
		// 先登记 in-flight Promise，再启动真实创建，防止第二次点击绕过 agents map 检查。
		const createPromise = this.createUnlocked(input).finally(() => {
			this.creatingSessionAgents.delete(sessionKey);
		});
		this.creatingSessionAgents.set(sessionKey, createPromise);
		return createPromise;
	}

	private normalizeSessionPathForCompare(sessionPath?: string) {
		return sessionPath?.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	}

	private findRuntimeBySessionKey(sessionKey: string) {
		return [...this.agents.values()].find(
			(runtime) =>
				this.normalizeSessionPathForCompare(runtime.tab.sessionPath) === sessionKey,
		);
	}

	private async createUnlocked(input: CreateAgentInput) {
		const t0 = Date.now();
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);

		const id = randomUUID();
		void this.appLogger?.info("agent", "Agent create requested", {
			agentId: id,
			projectId: input.projectId,
			projectPath: project.path,
			sessionPath: input.sessionPath,
			title: input.title,
		});
		const existingForSessionKey = this.normalizeSessionPathForCompare(input.sessionPath);
		const existingForSession = existingForSessionKey
			? this.findRuntimeBySessionKey(existingForSessionKey)
			: undefined;
		if (existingForSession) {
			void this.appLogger?.info("agent", "Agent create reused existing session", {
				agentId: existingForSession.tab.id,
				sessionPath: input.sessionPath,
			});
			return existingForSession.tab;
		}

		const tab: AgentTab = {
			id,
			projectId: project.id,
			cwd: project.path,
			title: input.title || `${project.name} agent`,
			status: "starting",
			sessionPath: input.sessionPath,
			createdAt: Date.now(),
		};

		const t1 = Date.now();
		const trustOverride = await this.ensureProjectTrust(project);
		const t2 = Date.now();

		const process = new PiProcess(project.path, this.settingsStore.get());
		process.on("version-check", (payload) => {
			void this.appLogger?.info("agent", "Pi version check completed", {
				agentId: id,
				...(payload && typeof payload === "object" ? payload : {}),
			});
		});
		const runtime: AgentRuntime = { tab, process };
		this.agents.set(id, runtime);
		this.messages.set(id, []);
		this.emitState();

		const client = process.start(input.sessionPath, trustOverride);
		const t3 = Date.now();
		void this.appLogger?.info("agent", "Pi process spawned", {
			agentId: id,
			prepareMs: t1 - t0,
			trustMs: t2 - t1,
			spawnCallMs: t3 - t2,
		});

		// 启动后立即连续发送两条命令，让 pi 启动后一次性处理，减少空闲等待
		const statePromise = client.request({ type: "get_state" });
		const messagesPromise = client.request({ type: "get_messages" });

		// ... 事件监听器（省略，与原来一致）
		process.on("event", (event) => this.handlePiEvent(id, event));
		process.on("stderr", (text) =>
			this.emit(ipcChannels.agentsLog, { agentId: id, text }),
		);
		process.on("protocol-error", (line) => {
			this.emit(ipcChannels.agentsLog, {
				agentId: id,
				text: `Protocol error: ${line}`,
			});
			this.appLogger?.error("agent", `Protocol error: ${(line as string)?.slice(0, 200)}`, {
				agentId: id,
				project: project.path,
			});
		});
		// 转发 RPC 日志到前端，用于调试面板展示请求/响应/事件
		process.on("rpc-log", (entry: { direction: string; data: unknown }) => {
			const data = entry.data as Record<string, any>;
			let summary: string;
			if (entry.direction === "send") {
				// 发送的命令：显示类型和关键参数
				const type = data.type ?? "?";
				if (type === "prompt")
					summary = `→ prompt: ${(data.message ?? "").slice(0, 60)}`;
				else if (type === "set_model")
					summary = `→ set_model: ${data.provider}/${data.modelId}`;
				else if (type === "set_thinking_level")
					summary = `→ set_thinking: ${data.level}`;
				else if (type === "bash")
					summary = `→ bash: ${(data.command ?? "").slice(0, 60)}`;
				else summary = `→ ${type}`;
			} else {
				// 收到的响应/事件
				const type = data.type ?? "?";
				if (type === "response")
					summary = `← ${data.command ?? "?"} ${data.success ? "✓" : "✗"}${data.error ? ` ${data.error}` : ""}`;
				else if (type === "message_update") {
					const evt = data.assistantMessageEvent?.type ?? "?";
					summary = `← message_update.${evt}`;
				} else summary = `← ${type}`;
			}
			const logEntry = {
				id: randomUUID(),
				agentId: id,
				direction: entry.direction,
				summary,
				data,
				time: Date.now(),
			};
			this.emit(ipcChannels.agentsRpcLog, logEntry);
			// 只有用户手动开启 RPC 日志记录的 agent 才落盘
			if (this.rpcLoggingAgents.has(id)) {
				this.rpcLogger?.push(logEntry);
			}
		});
		process.on("exit", (payload: { code: number | null; signal: string | null }) => {
			// 用户主动停止 → 不自动重连
			if (this.userInitiatedStop.has(id)) {
				this.userInitiatedStop.delete(id);
				tab.status = "closed";
				this.emitState();
				return;
			}

			// 手动压缩期间退出 → compact() 的 catch 块会负责重连
			if (this.compactingAgents.has(id)) {
				tab.status = "closed";
				this.emitState();
				return;
			}

			// 自动压缩 / 进程干净退出（exit code 0）且有会话路径 → 尝试一次自动重连
			if (!this.autoRestartAttempted.has(id) && tab.sessionPath && payload.code === 0) {
				this.autoRestartAttempted.add(id);
				tab.status = "starting";
				this.emitState();
				this.reattachProcess(id, tab.sessionPath)
					.then(() => {
						tab.status = "idle";
						this.addMessage(id, "system", "会话压缩完成，Agent 已自动重连");
						this.emitState();
					})
					.catch(() => {
						tab.status = "closed";
						this.addMessage(id, "error", "Agent 进程意外退出，自动重连失败");
						this.emitState();
					});
				return;
			}

			tab.status = "closed";
			this.emitState();
		});
		process.on("error", (error) => {
			tab.status = "error";
			this.addMessage(id, "error", error.message);
			this.appLogger?.error("agent", "Pi process error", {
				agentId: id,
				error: error instanceof Error ? error.message : String(error),
			});
			this.emitState();
		});

		try {
			const state = await statePromise;
			const t4 = Date.now();
			void this.appLogger?.info("agent", "Agent get_state completed", {
				agentId: id,
				stateMs: t4 - t3,
				totalSinceCreateMs: t4 - t0,
			});
			const data = state.data as
				| { sessionId?: string; sessionFile?: string; sessionName?: string }
				| undefined;
			tab.sessionId = data?.sessionId;
			tab.sessionPath = data?.sessionFile ?? input.sessionPath;
			tab.title =
				input.title ||
				data?.sessionName ||
				(input.sessionPath
					? `${project.name} 历史会话`
					: `${project.name} agent`);
			tab.status = "idle";
			// 加载历史消息（跳过 get_entries，编辑/删除时按需加载），最多重试一次
			await this.loadMessages(id, true, messagesPromise)
				.catch(() =>
					new Promise<void>((resolve) => setTimeout(resolve, 800))
						.then(() => this.loadMessages(id, true)),
				)
				.catch(() => undefined);
			void this.appLogger?.info("agent", "Agent create completed", {
				agentId: id,
				totalMs: Date.now() - t0,
			});
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
			void this.appLogger?.error("agent", "Agent create failed", {
				agentId: id,
				projectId: project.id,
				sessionPath: input.sessionPath,
				error: rawMessage,
			});
			// 构建丰富的错误诊断信息
			const diag = process.getDiagnostics();
			let enriched = rawMessage;
			if (diag) {
				const lines: string[] = [];
				// 退出码
				if (diag.exitCode !== null) {
					lines.push(`退出码: ${diag.exitCode}${diag.exitSignal ? ` (signal: ${diag.exitSignal})` : ""}`);
				}
				// stderr 输出（截取末尾最有用的部分）
				const stderrText = diag.stderr.join("").trim();
				if (stderrText) {
					// 只保留末尾 600 字符，避免刷屏
					const snippet = stderrText.length > 600 ? "…" + stderrText.slice(-600) : stderrText;
					lines.push(`进程错误输出:\n${snippet}`);
				}
				// pi 路径与版本检测
				lines.push(`pi 路径: ${diag.command}`);
				if (diag.customPiPath) {
					lines.push(`自定义路径: ${diag.customPiPath}`);
				}
				lines.push(`工作目录: ${diag.cwd}`);
				lines.push(`版本检测: ${diag.versionCheck ? "✓ 通过" : "✗ 失败"}`);

				// 诊断与指引
				lines.push("");
				lines.push("━━━ 排查步骤 ━━━");
				if (!diag.versionCheck) {
					lines.push("1. 在终端执行 pi --version，确认 pi 是否已安装且路径正确");
					lines.push("2. 如未安装，执行 npm install -g @earendil-works/pi-coding-agent");
					lines.push("3. 安装后再次在终端执行 pi --version 验证");
				} else if (diag.exitCode !== 0) {
					lines.push("1. 在终端执行 pi --mode rpc 看是否能正常启动");
					lines.push("2. 注意终端中的错误信息，根据异常信息修复");
				} else if (!stderrText && diag.exitCode === null) {
					lines.push("1. pi 进程可能尚未完成初始化，可在设置页增加 RPC 超时时间");
				} else {
					lines.push("1. 在终端执行 pi --mode rpc 确认 pi 能否正常启动");
					lines.push("2. 检查设置中的 pi 路径是否正确");
				}
				lines.push("");
				lines.push("如问题持续，可在 GitHub 提交 Issue 并附上以上信息。");

				enriched = `⚠️ Pi RPC 启动失败\n\n${rawMessage}\n\n${lines.join("\n")}`;
			}
			this.addMessage(id, "error", enriched);
		}

		this.emitState();
		return tab;
	}

	async rename(agentId: string, name: string) {
		const runtime = this.requireRuntime(agentId);
		const trimmed = name.replace(/\s+/g, " ").trim();
		if (!trimmed) throw new Error("Agent name cannot be empty");

		// 会话名属于 pi 原生 session 元数据；通过 RPC 修改，避免 desktop 手写 JSONL 后与 pi 格式演进脱节。
		const response = await runtime.process.client.request(
			{ type: "set_session_name", name: trimmed },
			20_000,
		);
		if (!response.success) {
			throw new Error(response.error ?? "Failed to rename session");
		}

		runtime.tab.title = trimmed;
		const state = await runtime.process.client
			.request({ type: "get_state" }, 10_000)
			.catch(() => ({ data: undefined }));
		const data = state.data as
			| { sessionId?: string; sessionFile?: string; sessionName?: string }
			| undefined;
		runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
		runtime.tab.sessionPath = data?.sessionFile ?? runtime.tab.sessionPath;
		runtime.tab.title = data?.sessionName || runtime.tab.title;
		this.emitState();
		return runtime.tab;
	}

	async sendPrompt(input: SendPromptInput) {
		const runtime = this.requireRuntime(input.agentId);
		const trimmed = input.message.trim();
		const hasImages = input.images && input.images.length > 0;
		const agentMessage = input.agentMessage?.trim() || trimmed || "Describe this image.";
		// 允许只有图片没有文字的情况发送
		if (!trimmed && !hasImages) return;

		// 解析 !/!! 前缀：与 pi 终端行为一致
		// !command  → 执行命令并将输出发送给 LLM（excludeFromContext: false）
		// !!command → 执行命令但不将输出发送给 LLM（excludeFromContext: true）
		const isBashExcluded = trimmed.startsWith("!!");
		const isBashNormal = !isBashExcluded && trimmed.startsWith("!");

		if (isBashExcluded || isBashNormal) {
			const command = isBashExcluded
				? trimmed.slice(2).trim()
				: trimmed.slice(1).trim();
			if (command) {
				await this.executeBashCommand(input.agentId, command, isBashExcluded);
				return;
			}
		}

		// 判断 agent 是否已在忙碌中；运行中继续发送时必须带 streamingBehavior，
		// 否则 pi RPC 会拒绝请求。该值也用于给用户消息打上投递语义标记。
		const alreadyBusy = runtime.tab.status === "running";
		const promptDeliveryBehavior = input.streamingBehavior ?? (alreadyBusy ? "steer" : undefined);

		// 保存用户消息（包含图片）。运行中消息先显示在对话里，并标记它会在何时被 pi 消费：
		// steer=下一次 LLM 调用前，followUp=当前 agent 完全停止后。
		this.addMessage(
			input.agentId,
			"user",
			trimmed || "[图片]",
			promptDeliveryBehavior ? { streamingBehavior: promptDeliveryBehavior } : undefined,
			input.images,
		);

		// 在设置状态为 running 之前检查进程是否还活着，避免进程崩溃后状态不一致
		if (!runtime.process.isRunning()) {
			runtime.tab.status = "error";
			this.addMessage(
				input.agentId,
				"error",
				"Agent 进程已停止，请重启 Agent 后重试",
			);
			this.emitState();
			return;
		}

		runtime.tab.status = "running";
		this.emitState();

		// streamingBehavior 只在 agent 忙碌时需要；UI 可以显式传 steer/followUp 以复用 pi 队列语义。
		// 当前端排队 flush 连续发送多条消息时，第一条会触发 agent_start 使 agent 变忙碌，
		// 后续消息必须带 streamingBehavior 否则 pi 直接返回 error。这里自动兜底。
		// images 用于传递粘贴/拖拽的图片，pi 会将 base64 图片直接传给支持视觉的模型。
		try {
			const promptIsExtensionCommand = await this.promptMatchesRegisteredExtensionCommand(runtime, agentMessage);
			const requestPayload: Record<string, unknown> = {
				type: "prompt",
				message: agentMessage,
				...(input.description ? { description: input.description } : {}),
				...(hasImages ? { images: input.images } : {}),
			};
			// 如果 agent 已经忙碌且调用方没指定 streamingBehavior，默认用 steer；
			// 与上方用户消息 meta 保持同一个计算结果，避免 UI 标记和实际 RPC 语义不一致。
			if (promptDeliveryBehavior) {
				requestPayload.streamingBehavior = promptDeliveryBehavior;
			}
			// 使用用户配置的 RPC 超时时间，因为用户提示词可能触发长时间运行的命令或复杂操作
			const response = await runtime.process.client.request(
				requestPayload,
				this.settingsStore.get().rpcTimeout,
			);
			if (!response.success) {
				// pi RPC 会把不支持图片、忙碌队列参数缺失等前置错误作为 success:false 返回；
				// 必须显式显示出来，否则 UI 会停在“已发送但无响应”的状态。
				runtime.tab.status = "idle";
				this.addMessage(
					input.agentId,
					"error",
					response.error ?? "图片消息发送失败",
				);
				this.emitState();
			} else if (promptIsExtensionCommand) {
				// 机制：Pi 扩展命令可在 prompt 阶段直接执行并返回，不进入 agent run。
				// 证据：@earendil-works/pi-coding-agent/dist/core/agent-session.js 中 AgentSession.prompt()
				//      先调用 _tryExecuteExtensionCommand()；命中后 return，不再调用 _runAgentPrompt()。
				// 推导：不能等 agent_end；只有 Pi get_state 明确报告无剩余工作时才恢复 idle。
				this.scheduleIdleCheckAfterExtensionCommand(input.agentId);
			}
		} catch (error) {
			// 超时或进程崩溃后，需要明确提示用户重启 Agent
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isProcessDead = errorMessage.includes("pi process is not running") || 
			                     errorMessage.includes("RPC command timed out");
			
			if (isProcessDead) {
				runtime.tab.status = "error";
				this.addMessage(
					input.agentId,
					"error",
					errorMessage.includes("timed out") 
						? `命令执行超时（${Math.round(this.settingsStore.get().rpcTimeout / 1000)}秒），Agent 进程可能已停止。请重启 Agent 后重试，或在设置中增加 RPC 超时时间。`
						: `Agent 进程已停止，请重启 Agent 后重试。`,
				);
			} else {
				runtime.tab.status = "idle";
				this.addMessage(
					input.agentId,
					"error",
					`消息发送失败：${errorMessage}`,
				);
			}
			this.emitState();
		}
	}

	/**
	 * 执行 bash 命令并通过 tool 消息展示输出，行为与 pi 终端的 !/!! 前缀一致。
	 * excludeFromContext 控制输出是否作为上下文发送给 LLM。
	 */
	private async executeBashCommand(
		agentId: string,
		command: string,
		excludeFromContext: boolean,
	) {
		this.addMessage(
			agentId,
			"user",
			`${excludeFromContext ? "!!" : "!"}${command}`,
		);
		const runtime = this.requireRuntime(agentId);
		
		// 检查进程是否还活着
		if (!runtime.process.isRunning()) {
			runtime.tab.status = "error";
			this.addMessage(
				agentId,
				"error",
				"Agent 进程已停止，请重启 Agent 后重试",
			);
			this.emitState();
			return;
		}
		
		runtime.tab.status = "running";
		this.emitState();

		try {
			const response = await runtime.process.client.request(
				{
					type: "bash",
					command,
					excludeFromContext,
				},
				60_000,
			);

			const data = response.data as
				| {
						output?: string;
						exitCode?: number;
						cancelled?: boolean;
						truncated?: boolean;
				  }
				| undefined;

			const output = data?.output ?? "";
			const exitCode = data?.exitCode ?? 0;
			const cancelled = data?.cancelled ?? false;

			if (cancelled) {
				this.addMessage(agentId, "system", "命令已取消");
			} else {
				// 以 tool 消息展示命令输出，与 pi 终端的 bash 结果展示保持一致
				const toolMessage = formatBashToolMessage({
					command,
					output,
					exitCode,
					excludeFromContext,
				});
				this.addMessage(agentId, "tool", toolMessage.text, toolMessage.meta);
			}
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			const isProcessDead = errorMessage.includes("pi process is not running") || 
			                     errorMessage.includes("RPC command timed out");
			
			if (isProcessDead) {
				runtime.tab.status = "error";
				this.addMessage(
					agentId,
					"error",
					errorMessage.includes("timed out") 
						? `命令执行超时，Agent 进程可能已停止。请重启 Agent 后重试。`
						: `Agent 进程已停止，请重启 Agent 后重试。`,
				);
			} else {
				this.addMessage(
					agentId,
					"error",
					`命令执行失败：${errorMessage}`,
				);
			}
		} finally {
			if (runtime.tab.status !== "error") {
				runtime.tab.status = "idle";
			}
			this.emitState();
		}
	}

	async abort(agentId: string) {
		const runtime = this.requireRuntime(agentId);

		// pi 在等待 extension_ui_response 时（如 ask_question），不发 abort 也能处理，
		// 但必须解除 pending 请求的阻塞，否则 pi 不会继续读取 stdin 中的后续命令。
		// 发 cancelled: true 会导致 pi 返回 undefined，ask_question 工具默认选第一个；
		// 改发 value: null（不带 cancelled 标记），select parser 返回 null，
		// 工具 result 的 answer = null，answered 为 false → 卡片显示"已取消"。
		const pending = this.pendingUIRequests.get(agentId);
		if (pending && pending.size > 0) {
			this.abortedDuringAsk.add(agentId);
			for (const [requestId] of pending) {
				runtime.process.client.sendRaw({
					type: "extension_ui_response",
					id: requestId,
					value: null,
				});
			}
		}

		runtime.process.client
			.request({ type: "abort" }, 10_000)
			.catch(() => {
				// abort 超时或失败不影响前端状态切换
			});

		// 立即清理 pending UI 记录并移除 ask_question 卡片，不等待 abort 返回
		if (pending && pending.size > 0) {
			const messages = this.messages.get(agentId);
			if (messages) {
				for (const [requestId] of pending) {
					const idx = messages.findIndex(
						(msg) =>
							msg.role === "system" &&
							msg.meta?.type === "askQuestion" &&
							(msg.meta as Record<string, unknown>).uiRequest &&
							((msg.meta as Record<string, unknown>).uiRequest as Record<string, unknown>).requestId === requestId,
					);
					if (idx !== -1) {
						messages.splice(idx, 1);
					}
				}
				this.messages.set(agentId, messages);
			}
			this.pendingUIRequests.delete(agentId);
		}
		runtime.tab.status = "idle";
		this.addMessage(agentId, "system", "已请求停止当前响应", { i18nKey: "app.abortRequested" });
		this.emitState();
	}

	/**
	 * 手动触发上下文压缩。pi 会将历史消息摘要化以释放 context 空间，
	 * 适用于长时间对话后 context 占比过高、但不想丢失关键信息的场景。
	 *
	 * 注意：pi 在压缩完成后可能会自动重启进程（尤其早期版本），此时 RPC 请求会因
	 * "pi exited" 错误而失败。本方法检测到进程退出后会自动重连同一会话并加载消息，
	 * 因此调用方不应把 RPC 失败等同于压缩失败。
	 */
	async compact(agentId: string, prompt?: string) {
		const runtime = this.requireRuntime(agentId);
		const trimmedPrompt = prompt?.trim();
		const startTime = Date.now();

		void this.appLogger?.info("agent", "Compact requested", {
			agentId,
			prompt: trimmedPrompt,
			hasSessionPath: !!runtime.tab.sessionPath,
		});

		// 标记压缩中，退出处理器据此区分压缩重启与异常崩溃
		this.compactingAgents.add(agentId);

		try {
			const response = await runtime.process.client.request(
				trimmedPrompt ? { type: "compact", prompt: trimmedPrompt } : { type: "compact" },
				120_000,
			);
			void this.appLogger?.info("agent", "Compact RPC response received", {
				agentId,
				elapsedMs: Date.now() - startTime,
				rpcSuccess: response.success,
				rpcError: response.error,
			});

			// 检查 RPC 返回的 success 字段：pi CLI 可能压缩成功但后续步骤抛异常，
			// 此时 session 文件已写入但 RPC 仍返回错误。
			if (!response.success) {
				void this.appLogger?.warn("agent", "Compact RPC returned failure (session might still be written)", {
					agentId,
					error: response.error,
				});
			}

			this.compactingAgents.delete(agentId);
			// 压缩成功且进程未退出，直接加载消息
			await this.loadMessages(agentId).catch(() => undefined);
			void this.appLogger?.info("agent", "Compact completed successfully", {
				agentId,
				totalElapsedMs: Date.now() - startTime,
			});
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			const processAlive = runtime.process.isRunning();
			void this.appLogger?.error("agent", "Compact failed", {
				agentId,
				elapsedMs: Date.now() - startTime,
				error: errorMsg,
				processAlive,
				hasSessionPath: !!runtime.tab.sessionPath,
			});

			this.compactingAgents.delete(agentId);

			// 如果进程在压缩期间退出（pi 压缩后自动重启进程的行为），
			// RPC 请求会因连接断开而失败，但压缩实际已完成。
			// 尝试重连同一会话，不从 compact() 层面抛出错误。
			if (!processAlive && runtime.tab.sessionPath) {
				void this.appLogger?.info("agent", "Compact: process exited, reattaching", {
					agentId,
				});
				await this.reattachProcess(agentId, runtime.tab.sessionPath);
				runtime.tab.status = "idle";
				await this.loadMessages(agentId).catch(() => undefined);
				this.addMessage(agentId, "system", "会话压缩完成");
				this.emitState();
				void this.appLogger?.info("agent", "Compact: reattach succeeded", {
					agentId,
					totalElapsedMs: Date.now() - startTime,
				});
			} else {
				// 非退出相关的 RPC 错误，正常抛出
				throw error;
			}
		}

		return this.getRuntimeState(agentId);
	}

	/**
	 * 进程退出后重新附加到同一会话：创建新的 PiProcess 并替换旧的进程引用。
	 * 在压缩导致 pi 进程自动重启后调用，保持同一 agentId 可继续对话。
	 *
	 * 与 create() 中创建过程的区别：不重新分配 agentId、不解绑项目，
	 * 只替换底层的 pi 进程和 RPC 客户端，保留所有消息和 tab 状态。
	 */
	private async reattachProcess(agentId: string, sessionPath: string): Promise<void> {
		const runtime = this.agents.get(agentId);
		if (!runtime) throw new Error("Agent not found: " + agentId);

		const project = this.getProject(runtime.tab.projectId);
		if (!project) throw new Error("Project not found");

		void this.appLogger?.info("agent", "Reattaching process", {
			agentId,
			sessionPath,
		});

		const process = new PiProcess(project.path, this.settingsStore.get());
		const client = process.start(sessionPath);

		// 注册事件监听（与 create() 保持一致）
		process.on("event", (event) => this.handlePiEvent(agentId, event));
		process.on("stderr", (text) =>
			this.emit(ipcChannels.agentsLog, { agentId, text }),
		);
		process.on("protocol-error", (line) => {
			this.emit(ipcChannels.agentsLog, {
				agentId,
				text: `Protocol error: ${line}`,
			});
		});
		process.on("rpc-log", (entry: { direction: string; data: unknown }) => {
			const data = entry.data as Record<string, any>;
			let summary: string;
			if (entry.direction === "send") {
				const type = data.type ?? "?";
				if (type === "prompt") {
					const desc = data.description ? ` [${data.description}]` : "";
					summary = `→ prompt${desc}: ${(data.message ?? "").slice(0, 60)}`;
				}
				else summary = `→ ${type}`;
			} else {
				const type = data.type ?? "?";
				if (type === "response")
					summary = `← ${data.command ?? "?"} ${data.success ? "✓" : "✗"}${data.error ? ` ${data.error}` : ""}`;
				else summary = `← ${type}`;
			}
			const logEntry = {
				id: randomUUID(),
				agentId,
				direction: entry.direction,
				summary,
				data,
				time: Date.now(),
			};
			this.emit(ipcChannels.agentsRpcLog, logEntry);
		});
		process.on("exit", (payload: { code: number | null; signal: string | null }) => {
			if (this.userInitiatedStop.has(agentId)) {
				this.userInitiatedStop.delete(agentId);
				runtime.tab.status = "closed";
				this.emitState();
				return;
			}

			// 自动压缩也可能发生在重连后的进程中；继续复用同一会话文件重附加，
			// 但仍用 autoRestartAttempted 做单次保护，避免真正异常退出时无限重启。
			if (!this.autoRestartAttempted.has(agentId) && runtime.tab.sessionPath && payload.code === 0) {
				this.autoRestartAttempted.add(agentId);
				runtime.tab.status = "starting";
				this.emitState();
				this.reattachProcess(agentId, runtime.tab.sessionPath)
					.then(() => {
						runtime.tab.status = "idle";
						this.addMessage(agentId, "system", "会话压缩完成，Agent 已自动重连");
						this.emitState();
					})
					.catch(() => {
						runtime.tab.status = "closed";
						this.addMessage(agentId, "error", "Agent 进程意外退出，自动重连失败");
						this.emitState();
					});
				return;
			}

			runtime.tab.status = "closed";
			this.emitState();
		});
		process.on("error", (error) => {
			runtime.tab.status = "error";
			this.addMessage(agentId, "error", error.message);
			this.emitState();
		});

		// 替换旧进程引用（但不修改 agents map 中的 key）
		runtime.process = process;

		try {
			const stateResponse = await client.request({ type: "get_state" });
			const data = stateResponse.data as
				| { sessionId?: string; sessionFile?: string; sessionName?: string }
				| undefined;
			runtime.tab.sessionId = data?.sessionId ?? runtime.tab.sessionId;
			runtime.tab.sessionPath = data?.sessionFile ?? sessionPath;
			runtime.tab.title = data?.sessionName ?? runtime.tab.title;
			runtime.tab.status = "idle";
			// 进程退出型压缩可能来不及发 compaction_end；重连成功即表示 Pi 已可继续接收消息。
			this.rpcCompactingAgents.delete(agentId);

			// 重连成功后清除自动重连标记，允许下一次再触发
			this.autoRestartAttempted.delete(agentId);

			// 如果有旧的 pending abort 标记，清理掉
			this.abortedDuringAsk.delete(agentId);

			await this.loadMessages(agentId).catch(() => undefined);

			void this.appLogger?.info("agent", "Process reattached successfully", {
				agentId,
			});
		} catch (error) {
			void this.appLogger?.error("agent", "Process reattach failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}

	/**
	 * 读取 session 文件，提取最后一条 assistant 消息的缓存命中率。
	 * 与 pi CLI footer 的 latestCacheHitRate 逻辑一致：
	 * latestCacheHitRate = cacheRead / (input + cacheRead + cacheWrite) * 100
	 */
	private async getLatestCacheMessageHitRate(sessionPath: string): Promise<number | undefined> {
		try {
			const raw = await readFile(sessionPath, "utf8");
			const lines = raw.split(/\r?\n/);
			// 从后往前遍历，找到最后一条 assistant 消息
			for (let i = lines.length - 1; i >= 0; i--) {
				const line = lines[i].trim();
				if (!line) continue;
				try {
					const entry = JSON.parse(line) as Record<string, any>;
					if (entry?.message?.role === "assistant" && entry.message?.usage) {
						const usage = entry.message.usage;
						const input = usage.input ?? 0;
						const cacheRead = usage.cacheRead ?? 0;
						const cacheWrite = usage.cacheWrite ?? 0;
						const promptTokens = input + cacheRead + cacheWrite;
						if (promptTokens > 0) {
							return (cacheRead / promptTokens) * 100;
						}
						return undefined;
					}
				} catch {
					// 单行解析失败忽略，继续往前找
				}
			}
		} catch {
			// 文件不存在或无法读取，返回 undefined
		}
		return undefined;
	}

	async getRuntimeState(agentId: string): Promise<AgentRuntimeState> {
		const runtime = this.requireRuntime(agentId);
		const [stateResponse, statsResponse] = await Promise.all([
			runtime.process.client
				.request({ type: "get_state" })
				.catch(() => ({ data: undefined })),
			runtime.process.client
				.request({ type: "get_session_stats" })
				.catch(() => ({ data: undefined })),
		]);
		const state = stateResponse.data as any;
		const stats = statsResponse.data as any;
		const model = state?.model;
		const tokens = stats?.tokens;
		const inputTokens = this.pickNumber(
			tokens?.input,
			tokens?.inputTokens,
			tokens?.prompt,
			tokens?.promptTokens,
			stats?.inputTokens,
			stats?.usage?.input,
		);
		const outputTokens = this.pickNumber(
			tokens?.output,
			tokens?.outputTokens,
			tokens?.completion,
			tokens?.completionTokens,
			stats?.outputTokens,
			stats?.usage?.output,
		);
		const cacheRead = this.pickNumber(
			tokens?.cacheRead,
			tokens?.cache?.read,
			stats?.cacheRead,
			stats?.usage?.cacheRead,
		);
		const cacheWrite = this.pickNumber(
			tokens?.cacheWrite,
			tokens?.cache?.write,
			stats?.cacheWrite,
			stats?.usage?.cacheWrite,
		);
		const directCacheHitPercent = this.pickNumber(
			tokens?.cacheHitPercent,
			tokens?.cacheHitRate != null ? tokens.cacheHitRate * 100 : undefined,
			stats?.cacheHitPercent,
			stats?.cacheHitRate != null ? stats.cacheHitRate * 100 : undefined,
		);
	/**
	 * 使用最新一条 assistant 消息的缓存命中率，与 pi CLI footer 保持一致。
	 * pi 的 get_session_stats RPC 不直接返回 cacheHitPercent，需读取 session 文件。
	 */
		const computedCacheHitPercent = runtime.tab.sessionPath
			? await this.getLatestCacheMessageHitRate(runtime.tab.sessionPath)
			: undefined;
		const cacheHitPercent = this.clampPercent(
			directCacheHitPercent ?? computedCacheHitPercent,
		);
		return {
			modelName: model?.name ?? model?.id,
			provider: model?.provider,
			modelId: model?.id,
			thinkingLevel: state?.thinkingLevel,
			isStreaming: state?.isStreaming,
			isCompacting:
				state?.isCompacting ||
				this.rpcCompactingAgents.has(agentId) ||
				this.compactingAgents.has(agentId),
			/** 工具执行状态从本地追踪，无需 Pi 进程查询 */
			isExecutingTool: !!(this.toolExecutingByAgent.get(agentId)),
			executingToolName: this.toolExecutingByAgent.get(agentId) ?? undefined,
			contextTokens: stats?.contextUsage?.tokens,
			contextWindow: stats?.contextUsage?.contextWindow ?? model?.contextWindow,
			contextPercent: stats?.contextUsage?.percent,
			inputTokens,
			outputTokens,
			cacheRead,
			cacheWrite,
			cacheTotal:
				cacheRead != null || cacheWrite != null
					? (cacheRead ?? 0) + (cacheWrite ?? 0)
					: undefined,
			cacheHitPercent,
			cost: stats?.cost,
		};
	}

	private async emitRuntimeState(agentId: string) {
		try {
			const state = await this.getRuntimeState(agentId);
			this.emit(ipcChannels.agentsRuntimeState, { agentId, state });
		} catch {
			// 运行态刷新失败不影响主流程；下一次轮询或事件会继续同步。
		}
	}

	private pickNumber(...values: unknown[]) {
		for (const value of values) {
			if (typeof value === "number" && Number.isFinite(value)) return value;
			if (typeof value === "string" && value.trim()) {
				const parsed = Number(value);
				if (Number.isFinite(parsed)) return parsed;
			}
		}
		return undefined;
	}

	private clampPercent(value: number | undefined) {
		if (value == null || !Number.isFinite(value)) return undefined;
		return Math.max(0, Math.min(100, value));
	}

	private trimHistoryMessages(rawMessages: unknown[], maxTurns = 20) {
		if (rawMessages.length === 0) return rawMessages;
		// 按对话轮次截断：找到最后 maxTurns 个用户提问，保留对应轮次及之后的全部消息
		const userIndices: number[] = [];
		for (let i = rawMessages.length - 1; i >= 0; i--) {
			const msg = rawMessages[i] as { role?: unknown } | undefined;
			if (msg?.role === "user") {
				userIndices.unshift(i);
				if (userIndices.length >= maxTurns) break;
			}
		}
		if (userIndices.length === 0) return rawMessages.slice(-50);
		return rawMessages.slice(userIndices[0]);
	}

	async cycleModel(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request({ type: "cycle_model" }, 60_000);
		return this.getRuntimeState(agentId);
	}

	async getAvailableModels(agentId: string): Promise<AvailableModel[]> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "get_available_models" },
			60_000,
		);
		return ((response.data as any)?.models ?? []) as AvailableModel[];
	}

	async setModel(agentId: string, provider: string, modelId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request(
			{ type: "set_model", provider, modelId },
			60_000,
		);
		return this.getRuntimeState(agentId);
	}

	async cycleThinking(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request(
			{ type: "cycle_thinking_level" },
			60_000,
		);
		return this.getRuntimeState(agentId);
	}

	async setThinking(agentId: string, level: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request(
			{ type: "set_thinking_level", level },
			60_000,
		);
		return this.getRuntimeState(agentId);
	}

	/**
	 * 使用 pi �� switch_session RPC ���ص�ǰ�Ự���������½��̡�
	 * ���̣��༭ JSONL → �ĵ�һ�� JSON ������ _reloadMarker �ֶ� → switch_session
	 * → pi ���ֵ�һ�����ݱ仯→������Ч→���¶�ȡ → �Ƴ� _reloadMarker �ֶΡ�
	 *
	 * ��ȣ��ɷ������б�ǩ�У����� _reloadMarker ��Ϊ�ֶ�д���һ�е� JSON �У�
	 * ���ı��ļ��нṹ������ marker δ��������ļ���Ȼ�ǺϷỰ���ɱ� pi ������
	 */
	private async reloadSession(agentId: string) {
		const startTime = Date.now();
		const runtime = this.requireRuntime(agentId);
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session path not available for reload");

		const markerId = randomUUID();

		try {
			const raw = await readFile(sessionPath, "utf8");
			const lines = raw.split(/\r?\n/);
			if (lines.length === 0 || !lines[0].trim()) {
				throw new Error("Session file is empty");
			}
			// �ĵ�һ�� JSON ���󣬼��� _reloadMarker �ֶΣ����� pi ���·������Ļ��档
			// ֻ�ĵ�һ�е����ݣ����ı��нṹ��ʹ marker ���������ļ���Ȼ�ǺϷỰ��
			const firstLine = JSON.parse(lines[0]) as Record<string, unknown>;
			delete firstLine._reloadMarker; // 先清除旧的，确保值不同
			firstLine._reloadMarker = markerId;
			lines[0] = JSON.stringify(firstLine);
			await writeFile(sessionPath, lines.join("\n"), "utf8");

			void this.appLogger?.info("agent", "Session reload: switch_session start", {
				agentId,
				markerId,
				elapsedMs: Date.now() - startTime,
			});

			const response = await runtime.process.client.request({
				type: "switch_session",
				sessionPath,
			}, 30_000);

			void this.appLogger?.info("agent", "Session reload: switch_session done", {
				agentId,
				markerId,
				success: response.success,
				elapsedMs: Date.now() - startTime,
			});

			// �ָ���һ�У��Ƴ� _reloadMarker �ֶΣ������ļ���ԭʼ״̬
			try {
				const afterRaw = await readFile(sessionPath, "utf8");
				const afterLines = afterRaw.split(/\r?\n/);
				if (afterLines.length > 0 && afterLines[0].includes("_reloadMarker")) {
					const restored = JSON.parse(afterLines[0]) as Record<string, unknown>;
					delete restored._reloadMarker;
					afterLines[0] = JSON.stringify(restored);
					await writeFile(sessionPath, afterLines.join("\n"), "utf8");
				}
			} catch {
				// _reloadMarker �ֶ����� residue ���ᵼ�� pi ���Է�����������Ӱ���Ựʹ��
			}

			if (!response.success) {
				void this.appLogger?.error("agent", "Session reload: switch_session failed", {
					agentId,
					error: response.error,
					elapsedMs: Date.now() - startTime,
				});
				throw new Error(response.error ?? "switch_session failed");
			}

			await this.loadMessages(agentId);
		} catch (error) {
			void this.appLogger?.error("agent", "Session reload failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
				elapsedMs: Date.now() - startTime,
			});
			throw error;
		}
	}

	/**
	 * 根据 entryId 在 JSONL 文件中找到对应的行号。
	 * 先遍历每一行查找 entry 的 id 字段是否匹配 entryId。
	 * 匹配时返回行号（0-based），找不到返回 -1。
	 * 跳过 type=deleted 的行（早期版本保留了 id），避免定位到已删条目。
	 */
	private findJsonlLineByEntryId(lines: string[], targetEntryId: string): number {
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const parsed = JSON.parse(line);
				// 跳过已删条目：旧版本在 deleted 标记中保留了 id，
				// 后续版本不再保留；两种情况下都不应匹配。
				if (parsed.type === "deleted") continue;
				if (parsed.id === targetEntryId || parsed.entryId === targetEntryId) {
					return i;
				}
			} catch { /* 跳过不可解析的行 */ }
		}
		return -1;
	}

	/**
	 * 修改 JSONL 前备份文件，最多保留最近 3 个备份，用于意外恢复。
	 * 备份文件命名格式：{sessionPath}.{timestamp}.edit-backup
	 */
	private async backupSessionFile(sessionPath: string): Promise<void> {
		const maxBackups = 3;
		try {
			const dir = dirname(sessionPath);
			const base = basename(sessionPath);
			const { readdir, copyFile, unlink } = await import("node:fs/promises");
			const backupPrefix = `${base}.`;
			const backupSuffix = ".edit-backup";

			// 列出已有备份，按时间排序
			const allFiles = await readdir(dir).catch(() => [] as string[]);
			const backups = allFiles
				.filter((f) => f.startsWith(backupPrefix) && f.endsWith(backupSuffix))
				.sort()
				.reverse();

			// 超出限制时删除最旧的
			while (backups.length >= maxBackups) {
				const old = backups.pop();
				if (old) await unlink(join(dir, old)).catch(() => {});
			}

			// 创建新备份
			const backupPath = join(dir, `${base}.${Date.now()}${backupSuffix}`);
			await copyFile(sessionPath, backupPath);
		} catch {
			// 备份失败不影响主流程
			void this.appLogger?.warn("agent", "Session file backup failed", { sessionPath });
		}
	}

	/**
	 * 查找最近的会话文件备份，用于 reload 失败时恢复 JSONL。
	 */
	private findLatestBackup(sessionPath: string): string | null {
		try {
			const dir = dirname(sessionPath);
			const base = basename(sessionPath);
			const backupPrefix = `${base}.`;
			const backupSuffix = ".edit-backup";
			const allFiles = readdirSync(dir).filter(
				(f: string) => f.startsWith(backupPrefix) && f.endsWith(backupSuffix),
			);
			if (allFiles.length === 0) return null;
			// 按文件名排序（时间戳在文件名中，排序即按时间），取最新的
			allFiles.sort().reverse();
			return join(dir, allFiles[0]);
		} catch {
			return null;
		}
	}

	/**
	 * 检查 Agent 是否处于可编辑/可删除的安全状态。
	 * 要求：isStreaming === false && isCompacting !== true && tab.status !== "running"
	 * 编辑/删除操作依赖 pi RPC 的 switch_session，在 busy 状态下行为不确定。
	 */
	private async ensureAgentIdle(agentId: string): Promise<void> {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		if (runtime.tab.status === "running") {
			// 先查一次 runtime state 确认 stream 状态
			try {
				const state = await this.getRuntimeState(agentId);
				if (state.isStreaming || state.isCompacting) {
					throw new Error("BUSY_STREAMING: Agent is streaming, please wait");
				}
				// isExecutingTool 时也视为 busy
				if (state.isExecutingTool) {
					throw new Error("BUSY_TOOL: Agent is executing a tool, please wait");
				}
			} catch (error) {
				// 如果 getRuntimeState 本身失败，但 tab.status 为 running，仍然拒绝
				if (error instanceof Error && error.message.startsWith("BUSY_")) {
					throw error;
				}
				throw new Error("BUSY_GENERIC: Agent is currently busy, please try again later");
			}
		}
	}

	/**
	 * 会话文件写入互斥锁：确保同一 agent 的 readFile→modify→writeFile 原子化。
	 * 防止并发编辑/删除操作同时读取 JSONL 后互相覆盖。
	 * 前一个操作完成（无论成功或失败）后，下一个操作才会开始。
	 */
	private async withSessionLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.sessionLocks.get(agentId) ?? Promise.resolve();
		const next = prev.then(() => fn(), () => fn());
		// 链式尾部 catch 防止单个操作的失败阻断后续队列
		this.sessionLocks.set(agentId, next.then(() => {}, () => {}));
		return await next;
	}

	/**
	 * 根据 chatMessage.meta.entryId（首选）或 _piDeckMsgSeq（回退）
	 * 在 JSONL 中找到对应行并返回行号和解析后的 entry。
	 * 优先使用 entryId 定位（O(n) 扫描 JSONL，n=文件行数），
	 * 回退使用旧的 _piDeckMsgSeq 计数定位（兼容旧版本已创建的聊天记录）。
	 *
	 * @returns [lineIndex, parsedEntry] 如果找到；否则抛出错误
	 */
	private locateJsonlEntry(
		lines: string[],
		messages: ChatMessage[],
		msg: ChatMessage,
	): { lineIndex: number; entry: Record<string, any> } {
		const entryId = msg.meta?.entryId as string | undefined;

		// ── 调试日志（输出到控制台） ──
		console.log(`[locateJsonlEntry] msg.id=${msg.id}, meta.entryId=${entryId?.slice(0, 12) ?? "(none)"}, role=${msg.role}, text=[${msg.text.slice(0, 60)}]`);

		// 方案一：按 entryId 精确定位（首选）
		if (entryId) {
			const lineIndex = this.findJsonlLineByEntryId(lines, entryId);
			if (lineIndex !== -1) {
				console.log(`[locateJsonlEntry] scheme1(entryId) found at line=${lineIndex}`);
				return { lineIndex, entry: JSON.parse(lines[lineIndex]) };
			}
			console.warn(`[locateJsonlEntry] EntryId ${entryId} not found in JSONL, trying msg.id extraction`);
		}

		// 调试：记录 JSONL 前 10 行的 id，辅助排查 entryId 为何找不到
		const lineIds = lines.slice(0, 10).map((l, idx) => {
			try { const p = JSON.parse(l); return `${idx}:id=${p.id?.slice(0, 12) ?? "(no id)"}${p.entryId ? `,entryId=${String(p.entryId).slice(0, 12)}` : ""}`; }
			catch { return `${idx}:(parse error)`; }
		}).join("; ");
		console.log(`[locateJsonlEntry] first 10 JSONL ids: [${lineIds}]`);

		// 方案二：从 msg.id 提取 entryId（id 格式: `${agentId}-history-${entryId}`）
		// 当 get_entries 返回的 entryId 在 JSONL 中找不到时尝试此方案；
		// 也可用于 get_entries 失败时仍能从 msg.id 中恢复 entryId。
		const idPrefix = `${msg.agentId}-history-`;
		if (msg.id.startsWith(idPrefix)) {
			const extracted = msg.id.slice(idPrefix.length);
			console.log(`[locateJsonlEntry] scheme2 extracting from msg.id, extracted=[${extracted}]`);
			const lineIndex = this.findJsonlLineByEntryId(lines, extracted);
			if (lineIndex !== -1) {
				console.log(`[locateJsonlEntry] scheme2 found at line=${lineIndex}`);
				return { lineIndex, entry: JSON.parse(lines[lineIndex]) };
			}
			console.warn(`[locateJsonlEntry] scheme2 extracted [${extracted}] not found in JSONL`);
		} else {
			console.warn(`[locateJsonlEntry] msg.id does NOT start with prefix [${idPrefix}], cannot try scheme2`);
		}

		// 方案三：按角色 + 文本内容匹配（兜底方案）
		// 当 JSONL 中存在多个分支时，计数方案会错误统计非活跃分支的条目。
		// 改用文本匹配，只找与 msg 角色和文本内容完全一致的 entry。
		// 注意：相同文本在不同消息中重复时只能返回第一个匹配，但对常见场景足够。
		console.log(`[locateJsonlEntry] scheme3 scanning by role=${msg.role} + text match`);
		let matchCount = 0;
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i].trim();
			if (!line) continue;
			try {
				const entry = JSON.parse(line);
				const entryRole = (entry as any)?.message?.role;
				if (
					entryRole === msg.role ||
					(entryRole === "toolResult" && msg.role === "tool")
				) {
					const text = this.extractText((entry as any)?.message?.content);
					if (text === msg.text) {
						matchCount++;
						console.log(`[locateJsonlEntry] scheme3 found at line=${i}, role=${entryRole}, match#=${matchCount}`);
						return { lineIndex: i, entry };
					}
				}
			} catch { /* 跳过不可解析的行 */ }
		}

		console.error(`[locateJsonlEntry] ALL SCHEMES FAILED. msg.id=${msg.id}, role=${msg.role}, text=[${msg.text.slice(0, 100)}], jsonlLines=${lines.length}`);
		throw new Error("Message not found in session file");
	}

	/**
	 * 编辑消息：修改 JSONL 中的 text 后通过 switch_session 重载，不重启进程。
	 * 前端需在 agent idle 时调用。
	 *
	 * 流程：
	 * 1. 检查 Agent 空闲状态（忙碌则拒绝）
	 * 2. 通过 meta.entryId 精确定位 JSONL 行（回退：msg.id 提取 entryId / 角色+文本匹配）
	 * 3. 修改对应行的 text 内容
	 * 4. 写回 JSONL
	 * 5. 使用 _reloadMarker 方案让 pi 重新加载会话
	 */
	async editMessage(agentId: string, messageId: string, newText: string) {
		const startTime = Date.now();
		void this.appLogger?.info("agent", "Edit message requested", { agentId, messageId });

		await this.withSessionLock(agentId, async () => {
			// 1. 检查 Agent 空闲状态
			await this.ensureAgentIdle(agentId);

			const runtime = this.requireRuntime(agentId);
			const sessionPath = runtime.tab.sessionPath;
			if (!sessionPath) throw new Error("Session not persisted");

			const raw = await readFile(sessionPath, "utf8").catch(() => "");
			if (!raw) throw new Error("Session file is empty");
			const lines = raw.split(/\r?\n/);

			const messages = this.messages.get(agentId);
			if (!messages) throw new Error("No messages for agent");
			const msg = messages.find((m) => m.id === messageId);
			if (!msg) throw new Error("Message not found");

			// 2. 定位 JSONL 行（优先 entryId，回退 _piDeckMsgSeq 计数）
			const { lineIndex, entry } = this.locateJsonlEntry(lines, messages, msg);
			const role = (entry as any)?.message?.role;

			if (role !== "user" && role !== "assistant") {
				throw new Error("Only user and assistant messages can be edited");
			}

			// 2.5 写前备份（最多保留最近 3 个 .edit-backup 文件）
			await this.backupSessionFile(sessionPath);

			// 3. 修改 text
			const wrapped = entry as { message?: Record<string, any> };
			const content = wrapped.message!.content;
			if (Array.isArray(content)) {
				const textBlock = content.find((c: any) => c.type === "text");
				if (textBlock) {
					textBlock.text = newText;
				} else {
					content.push({ type: "text", text: newText });
				}
			} else {
				wrapped.message!.content = [{ type: "text", text: newText }];
			}

			// 4. 写回 JSONL
			lines[lineIndex] = JSON.stringify(entry);
			await writeFile(sessionPath, lines.join("\n"), "utf8");

			// 5. 使用 _reloadMarker 重载 pi 会话
			// 注意：不再手动更新桌面端内存——reloadSession 内部调用 loadMessages
			// 会从 pi 拉取最新消息列表，保持桌面端与 pi 状态一致。
			try {
				await this.reloadSession(agentId);
			} catch (error) {
				// reload 失败时从备份恢复 JSONL
				const errMsg = error instanceof Error ? error.message : String(error);
				void this.appLogger?.error("agent", "Edit message: reload failed, restoring backup", {
					agentId,
					messageId,
					error: errMsg,
					elapsedMs: Date.now() - startTime,
				});
				try {
					const backupPath = this.findLatestBackup(sessionPath);
					if (backupPath) {
						const backupContent = await readFile(backupPath, "utf8");
						await writeFile(sessionPath, backupContent, "utf8");
						await this.loadMessages(agentId).catch(() => {});
					}
				} catch (restoreError) {
					void this.appLogger?.error("agent", "Edit message: failed to restore backup", {
						agentId,
						error: restoreError instanceof Error ? restoreError.message : String(restoreError),
					});
				}
				throw error;
			}
		});

		void this.appLogger?.info("agent", "Edit message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
	}

	/**
	 * 删除消息：在 JSONL 中用 deleted 标记替换对应行后通过 switch_session 重载。
	 *
	 * 相比旧版本（置空行导致 JSONL 行数偏移），本方案：
	 * - 用 {"type":"deleted","originalEntryId":"...","ts":...} 替换原行
	 * - 同时将删掉 entry 的子 entry 的 parentId 重定向到被删 entry 的父节点（re-parenting），
	 *   确保 pi 重载 session tree 时不会因 dangling parentId 丢弃整个子分支
	 * - 保留行号稳定，不破坏行数对齐
	 * - entryId 精确定位不受之前删除操作影响
	 */
	async deleteMessage(agentId: string, messageId: string) {
		const startTime = Date.now();
		void this.appLogger?.info("agent", "Delete message requested", { agentId, messageId });

		await this.withSessionLock(agentId, async () => {
			// 1. 检查 Agent 空闲状态
			await this.ensureAgentIdle(agentId);

			const runtime = this.requireRuntime(agentId);
			const sessionPath = runtime.tab.sessionPath;
			if (!sessionPath) throw new Error("Session not persisted");

			const raw = await readFile(sessionPath, "utf8").catch(() => "");
			if (!raw) throw new Error("Session file is empty");
			const lines = raw.split(/\r?\n/);

			const messages = this.messages.get(agentId);
			if (!messages) throw new Error("No messages for agent");
			const msg = messages.find((m) => m.id === messageId);
			if (!msg) throw new Error("Message not found");

			// 2. 定位 JSONL 行（优先 entryId）
			const { lineIndex, entry } = this.locateJsonlEntry(lines, messages, msg);
			const deletedEntryId = (entry as any)?.id;
			const deletedParentId = (entry as any)?.parentId;
			const foundRole = (entry as any)?.message?.role;
			console.log(`[deleteMessage] lineIndex=${lineIndex}, entryId=${deletedEntryId?.slice(0, 12) ?? "(none)"}, parentId=${deletedParentId?.slice(0, 12) ?? "(null)"}, entryRole=${foundRole ?? "(none)"}`);

			// 2.5 写前备份（最多保留最近 3 个 .edit-backup 文件）
			await this.backupSessionFile(sessionPath);

			// 3. Re-parenting：将删掉 entry 的所有直接子节点的 parentId 指向被删 entry 的父节点。
			// 这样 pi 在 switch_session 重载 session tree 时，子节点不会因为
			// 父节点消失而变成 dangling orphan，避免 pi 丢弃整个子分支（“删一条丢多条”）。
			if (deletedEntryId && deletedParentId !== undefined) {
				for (let i = 0; i < lines.length; i++) {
					if (i === lineIndex) continue;
					const childLine = lines[i].trim();
					if (!childLine) continue;
					try {
						const child = JSON.parse(childLine);
						if (child.parentId === deletedEntryId) {
							child.parentId = deletedParentId;
							lines[i] = JSON.stringify(child);
						}
					} catch { /* 跳过无法解析的行 */ }
				}
			}

			// 4. 用 deleted 标记替换原行（不保留 id 字段，
			// 避免 pi 的 get_entries 返回已删 entry 导致 activeEntryIds 与 messages 不匹配）
			lines[lineIndex] = JSON.stringify({
				type: "deleted",
				originalEntryId: deletedEntryId ?? `unknown-${messageId}`,
				ts: Date.now(),
			});
			await writeFile(sessionPath, lines.join("\n"), "utf8");

			// 5. 使用 _reloadMarker 重载 pi 会话
			// 不再手动更新 desktop 内存——reloadSession 内部调用 loadMessages
			// 从 pi 拉取最新消息列表
			try {
				await this.reloadSession(agentId);
			} catch (error) {
				// reload 失败时从备份恢复 JSONL
				const errMsg = error instanceof Error ? error.message : String(error);
				void this.appLogger?.error("agent", "Delete message: reload failed, restoring backup", {
					agentId,
					messageId,
					error: errMsg,
					elapsedMs: Date.now() - startTime,
				});
				try {
					const backupPath = this.findLatestBackup(sessionPath);
					if (backupPath) {
						const backupContent = await readFile(backupPath, "utf8");
						await writeFile(sessionPath, backupContent, "utf8");
						await this.loadMessages(agentId).catch(() => {});
					}
				} catch (restoreError) {
					void this.appLogger?.error("agent", "Delete message: failed to restore backup", {
						agentId,
						error: restoreError instanceof Error ? restoreError.message : String(restoreError),
					});
				}
				throw error;
			}
		});

		void this.appLogger?.info("agent", "Delete message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
	}

	/**
	 * 轻量重载：使用 switch_session RPC 重载会话上下文，无需重启进程。
	 * 编辑/删除消息后自动调用；IPC channels:agents:reload 也走此路径。
	 */
	async reload(agentId: string) {
		await this.reloadSession(agentId);
	}

	/**
	 * 重启 agent 进程：停止当前 pi RPC 子进程，用同一个 session 重新启动。
	 * 适用场景：修改了 provider 配置、切换了 API key、更新了 pi 版本后，
	 * /reload 只重载 extension，不会重新读取配置文件，restart 才能生效。
	 */
	async restart(agentId: string): Promise<AgentTab> {
		const runtime = this.requireRuntime(agentId);
		const { projectId, title } = runtime.tab;

		// 优先从 pi 获取最新 sessionFile，兜底用 tab 上缓存的值；
		// 避免首次创建时未指定 session 路径、restart 后丢失历史的情况。
		let sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) {
			try {
				const state = await runtime.process.client.request({
					type: "get_state",
				});
				sessionPath =
					(state.data as { sessionFile?: string } | undefined)?.sessionFile ??
					undefined;
			} catch {
				// 获取失败时继续用 undefined，create 会启动新 session
			}
		}

		// 停止旧进程并清理状态
		runtime.process.stop();
		this.agents.delete(agentId);
		this.messages.delete(agentId);
		this.emitState();

		// 用相同的 session 重新创建 agent，新进程会重新加载所有配置
		return this.create({ projectId, sessionPath, title });
	}

	async exportHtml(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "export_html" },
			120_000,
		);
		return response.data;
	}

	/**
	 * 对未打开的历史会话执行官方 RPC 导出。
	 * 使用临时 pi 进程可以复用官方 export_html 样式，同时不切换当前桌面 Agent。
	 */
	async exportSessionHtml(projectId: string, sessionPath: string) {
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request(
				{ type: "export_html" },
				120_000,
			);
			return response.data;
		});
	}

	/**
	 * 对未打开的历史会话执行官方 clone。
	 * clone 会复制 active branch 到新 session；随后读取 get_state 拿到新 sessionFile 供历史列表刷新。
	 */
	async cloneSessionFile(projectId: string, sessionPath: string) {
		return this.withTemporarySession(projectId, sessionPath, async (process) => {
			const response = await process.client.request({ type: "clone" }, 120_000);
			const state = await process.client.request({ type: "get_state" });
			return {
				...((response.data as object | undefined) ?? {}),
				sessionPath: (state.data as { sessionFile?: string } | undefined)?.sessionFile,
			};
		});
	}

	private async withTemporarySession<T>(
		projectId: string,
		sessionPath: string,
		run: (process: PiProcess) => Promise<T>,
	): Promise<T> {
		const project = this.getProject(projectId);
		if (!project) throw new Error(`Project not found: ${projectId}`);
		const process = new PiProcess(project.path, this.settingsStore.get());
		process.start(sessionPath);
		try {
			return await run(process);
		} finally {
			process.stop();
		}
	}

	async getForkMessages(agentId: string): Promise<ForkMessage[]> {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_fork_messages",
		});
		return (
			(response.data as { messages?: ForkMessage[] } | undefined)?.messages ?? []
		);
	}

	async forkSession(agentId: string, entryId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "fork", entryId },
			120_000,
		);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	async cloneSession(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({ type: "clone" }, 120_000);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	async switchSession(agentId: string, sessionPath: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request(
			{ type: "switch_session", sessionPath },
			120_000,
		);
		await this.refreshRuntimeAfterSessionReplacement(agentId);
		return response.data;
	}

	private async refreshRuntimeAfterSessionReplacement(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const stateResponse = await runtime.process.client
			.request({ type: "get_state" })
			.catch(() => ({ data: undefined }));
		const state = stateResponse.data as { sessionFile?: string; sessionName?: string } | undefined;
		if (state?.sessionFile) runtime.tab.sessionPath = state.sessionFile;
		if (state?.sessionName) runtime.tab.title = state.sessionName;
		await this.loadMessages(agentId).catch(() => undefined);
		this.emitState();
	}

	async getCommands(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_commands",
		});
		return (
			(response.data as { commands?: unknown[] } | undefined)?.commands ?? []
		);
	}

	private async promptMatchesRegisteredExtensionCommand(runtime: AgentRuntime, message: string): Promise<boolean> {
		const trimmed = message.trim();
		if (!trimmed.startsWith("/")) return false;

		const commandName = trimmed.slice(1).split(/\s+/, 1)[0];
		if (!commandName) return false;

		const response = await runtime.process.client
			.request({ type: "get_commands" }, 10_000)
			.catch(() => undefined);
		const commands = (response?.data as { commands?: unknown[] } | undefined)?.commands ?? [];
		return commands.some((command) => {
			if (!command || typeof command !== "object") return false;
			const typed = command as { name?: unknown; source?: unknown };
			return typed.name === commandName && typed.source === "extension";
		});
	}

	/** 设置某 agent 的 RPC 日志记录开关 */
	setRpcLogging(agentId: string, enabled: boolean) {
		if (enabled) {
			this.rpcLoggingAgents.add(agentId);
		} else {
			this.rpcLoggingAgents.delete(agentId);
		}
	}

	/** 查询某 agent 是否开启了 RPC 日志记录 */
	isRpcLogging(agentId: string): boolean {
		return this.rpcLoggingAgents.has(agentId);
	}

	async stop(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;
		// 标记用户主动停止，退出处理器将跳过自动重连
		this.userInitiatedStop.add(agentId);
		const process = runtime.process;
		this.agents.delete(agentId);
		this.messages.delete(agentId);
		// agent 关闭时自动关闭 RPC 日志记录
		this.rpcLoggingAgents.delete(agentId);
		process.stop();
		this.emitState();
	}

	/** 注册本地事件监听器（供 FeishuBridge 等主进程内部模块使用） */
	addLocalEventListener(listener: (agentId: string, event: unknown) => void): () => void {
		this.localEventListeners.add(listener);
		return () => { this.localEventListeners.delete(listener); };
	}

	/** 注册状态变更监听器（供 PetStateBridge 等主进程内部模块使用）；每次 emitState 后同步回调最新 AgentTab[] */
	addStateListener(listener: (tabs: AgentTab[]) => void): () => void {
		this.stateListeners.add(listener);
		return () => { this.stateListeners.delete(listener); };
	}

	private notifyStateListeners(tabs: AgentTab[]) {
		for (const listener of this.stateListeners) {
			try { listener(tabs); } catch {}
		}
	}

	stopAll() {
		// 应用退出时统一清理所有 pi 子进程，避免后台 agent 残留占用模型或文件句柄。
		for (const runtime of this.agents.values()) {
			this.userInitiatedStop.add(runtime.tab.id);
			runtime.process.stop();
		}
		this.agents.clear();
		this.messages.clear();
		this.emitState();
	}

	private handlePiEvent(agentId: string, event: unknown) {
		// 通知本地监听器（FeishuBridge 等主进程内部订阅）
		for (const listener of this.localEventListeners) {
			try { listener(agentId, event); } catch {}
		}
		this.emit(ipcChannels.agentsEvent, { agentId, event });

		if (!event || typeof event !== "object") return;
		const typed = event as Record<string, any>;
		const runtime = this.agents.get(agentId);

		if (typed.type === "agent_start" && runtime) {
			runtime.tab.status = "running";
			this.activeAssistantMessageIds.delete(agentId);
			this.toolMessageIds.delete(agentId);
			this.emitState();
		}

		if (typed.type === "message_start" && typed.message?.role === "assistant") {
			this.beginAssistantMessage(agentId);
			this.upsertAssistantMessage(agentId, typed.message);
		}

		if (typed.type === "auto_retry_start") {
			this.upsertRetryStatusMessage(agentId, typed, "running");
			if (runtime) {
				// pi 在等待指数退避期间可能短暂结束一轮 agent run；桌面端保持 running，
				// 让用户明确知道当前不是最终失败，而是在等待下一次自动重试。
				runtime.tab.status = "running";
				this.emitState();
			}
		}

		if (typed.type === "auto_retry_end") {
			this.upsertRetryStatusMessage(
				agentId,
				typed,
				typed.success ? "success" : "error",
			);
		}

		// 自动/手动压缩事件（pi 在自动或手动压缩完成后会发出这些事件），
		// 用于记录压缩耗时和结果，便于排查压缩性能问题。
		if (typed.type === "compaction_start") {
			this.rpcCompactingAgents.add(agentId);
			if (runtime) {
				// 自动压缩在 agent_end 之后触发：Pi 仍在改写上下文，但不会再发 agent_start。
				// 因此桌面端必须主动保持 running，阻止用户误以为空闲并继续发送消息。
				runtime.tab.status = "running";
				this.emitState();
				void this.emitRuntimeState(agentId);
			}
			void this.appLogger?.info("agent", "Compaction started", {
				agentId,
				reason: typed.reason,
			});
		}
		if (typed.type === "compaction_end") {
			this.rpcCompactingAgents.delete(agentId);
			if (runtime) {
				// compaction 会向 session JSONL 写入新的边界记录；立即重载消息，
				// 避免前端仍展示压缩前分支，下一轮继续对话时看起来像“断在旧会话”。
				void this.loadMessages(agentId).catch(() => undefined);
				if (runtime.tab.status !== "error") {
					// compaction_end 之后 Pi 仍可能因 overflow retry 或 queued follow-up 自动继续。
					// 只有 agent_settled 才表示不会再自动发起下一轮，不能在这里提前 idle。
					runtime.tab.status = "running";
				}
				this.emitState();
				void this.emitRuntimeState(agentId);
			}
			void this.appLogger?.info("agent", "Compaction ended", {
				agentId,
				reason: typed.reason,
				result: typed.result ? "success" : "failed",
				aborted: typed.aborted,
				willRetry: typed.willRetry,
				errorMessage: typed.errorMessage,
			});
		}

		if (typed.type === "agent_end") {
			// agent_end 只表示一次底层 run 结束；Pi 之后仍可能执行自动重试、自动压缩，
			// 或压缩后继续 queued follow-up。最终空闲必须等 agent_settled，避免中途误判 idle。
			if (runtime) {
				this.activeAssistantMessageIds.delete(agentId);
				this.toolMessageIds.delete(agentId);
			}
			// agent 异常结束时（如 API 返回 400、模型报错等），将错误提示写入会话，避免用户看到空白。
			// 错误信息的存放位置因 pi 版本和错误类型不同而有多种可能：
			//   1. agent_end 顶层 errorMessage
			//   2. messages 数组中 stopReason=error 的消息的 errorMessage
			//   3. messages 数组中 assistant 消息的 content 里包含 error 片段
			//   4. agent_end 顶层 stopReason=error 但无 messages
			const agentMessages = Array.isArray(typed.messages) ? typed.messages : [];
			const errorMessages = agentMessages.filter(
				(m: any) => m.stopReason === "error",
			);
			// 逐级查找错误文本：顶层 → 错误消息列表 → 仅检查最后一轮对话中 type=error 的 content 块
			const topMsg = errorMessages[errorMessages.length - 1];
			// 只从最后一条 assistant 消息中查找显式 type=error 的 content 块，
			// 避免扫描全部历史消息导致工具成功输出被误判为错误。
			const lastAssistant = agentMessages
				.filter((m: any) => m.role === "assistant")
				.pop();
			const contentError = Array.isArray(lastAssistant?.content)
				? lastAssistant.content.find((c: any) => c?.type === "error")
				: undefined;
			const errorMsg =
				(typed.errorMessage as string | undefined) ??
				topMsg?.errorMessage ??
				(typed.error as string | undefined) ??
				(typeof contentError?.text === "string" ? contentError.text : undefined) ??
				(typeof contentError?.message === "string"
					? contentError.message
					: undefined);
			if (typed.willRetry === true) {
				// agent_end.willRetry 表示 pi 已判定本次错误会进入自动重试；
				// 此时不写入最终错误，避免用户误以为会话已经失败。
				if (errorMsg && !this.retryStatusMessageIds.has(agentId)) {
					this.upsertRetryStatusMessage(
						agentId,
						{
							attempt: 0,
							maxAttempts: 0,
							delayMs: 0,
							errorMessage: String(errorMsg),
						},
						"running",
					);
				}
				// 重试中保持 running，不能误置为 idle/error，否则宠物聚合状态会提前转 done/failed
				if (runtime) runtime.tab.status = "running";
			} else if (errorMsg) {
				this.addDetailedErrorMessage(agentId, String(errorMsg));
				// 有错误且不会重试 → Agent 进入 error 态，宠物聚合为 failed（行5），
				// 否则会被误置为 idle 触发"所有任务完成"通知
				if (runtime) runtime.tab.status = "error";
			} else if (
				typed.stopReason === "error" ||
				errorMessages.length > 0
			) {
				this.addDetailedErrorMessage(agentId, "Agent 返回未知错误，请重试");
				if (runtime) runtime.tab.status = "error";
			}
			if (runtime) this.emitState();
			// agent_end 后 runtimeState 可能暂时仍显示后续 compaction/retry；立即同步一次，
			// 但不要把它当作最终空闲信号，最终状态由 agent_settled 处理。
			void this.emitRuntimeState(agentId);
		}

		if (typed.type === "agent_settled") {
			if (runtime && runtime.tab.status !== "error" && runtime.tab.status !== "closed") {
				// agent_settled 是 Pi 的最终稳定点：没有自动重试、自动压缩、压缩 retry
				// 或 queued follow-up 会继续执行，此时才允许恢复 idle 并通知用户完成。
				runtime.tab.status = "idle";
				this.streamingThinking.delete(agentId);
				this.activeAssistantMessageIds.delete(agentId);
				this.toolMessageIds.delete(agentId);
				this.rpcCompactingAgents.delete(agentId);
				this.emitThinking(agentId, "");
				this.emitState();
				void this.emitRuntimeState(agentId);

				const messages = this.messages.get(agentId) ?? [];
				const lastMessage = messages[messages.length - 1];
				if (lastMessage?.role === "assistant") {
					this.notifySessionEnd(runtime.tab.title);
				}
			}
		}

		if (
			typed.type === "message_update" &&
			typed.assistantMessageEvent
		) {
			this.handleAssistantMessageEvent(agentId, typed);
		}

		if (
			typed.type === "message_end" &&
			typed.message?.role === "assistant" &&
			this.activeAssistantMessageIds.has(agentId)
		) {
			this.upsertAssistantMessage(agentId, typed.message);
			this.activeAssistantMessageIds.delete(agentId);
			// message_end 是本轮回答的最终状态，立即 flush 确保完整消息及时可见
			this.flushMessageEmit(agentId);
		}

		if (typed.type === "tool_execution_start") {
			this.upsertToolMessage(agentId, typed, "running");
			// 记录当前正在执行的工具名，用于前端准确展示“执行中”而非泛泛的“响应中”
			this.toolExecutingByAgent.set(agentId, typed.toolName ?? "tool");
			// 工具调用开始时确保 agent 状态为 running
			if (runtime) {
				runtime.tab.status = "running";
				this.emitState();
			}
			// 推送运行时状态更新，使前端能立即知道工具正在执行
			void this.getRuntimeState(agentId)
				.then((state) =>
					this.emit(ipcChannels.agentsRuntimeState, { agentId, state }),
				)
				.catch(() => undefined);
		}

		if (typed.type === "tool_execution_end") {
			this.upsertToolMessage(
				agentId,
				typed,
				typed.isError ? "error" : "done",
			);
			// 工具执行结束是终态，立即 flush 把最终结果推给渲染进程，避免节流窗口内用户看不到完成状态。
			this.flushMessageEmit(agentId);
			// 清除工具执行状态
			this.toolExecutingByAgent.set(agentId, null);
			// 工具调用完成后保持 agent 状态为 running，等待后续的 agent_end 事件
			// 这样在工具完成到 agent 生成回复之间，thinking bubble 仍然会显示
			if (runtime) {
				runtime.tab.status = "running";
				this.emitState();
			}
			// 推送运行时状态更新
			void this.getRuntimeState(agentId)
				.then((state) =>
					this.emit(ipcChannels.agentsRuntimeState, { agentId, state }),
				)
				.catch(() => undefined);
		}

		if (typed.type === "tool_execution_update") {
			this.upsertToolMessage(agentId, typed, "running");
		}

		if (typed.type === "extension_ui_request") {
			this.handleUIRequest(agentId, typed);
		}

		if (typed.type === "extension_error") {
			this.addMessage(
				agentId,
				"error",
				String(typed.error ?? "Extension error"),
			);
		}
	}

	/**
	 * 处理 pi 扩展发起的 UI 请求。
	 * 对话类请求写入消息流等待用户回答；fire-and-forget 请求只转发给渲染进程或忽略。
	 */
	private handleUIRequest(agentId: string, typed: Record<string, any>) {
		const method = String(typed.method ?? "");
		const requestId = String(typed.id ?? "");
		// pi RPC 协议将 setWidget / dialog 字段放在顶层，不嵌套 params
		if (method === "notify") {
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				message: String(typed.message ?? ""),
				notifyType: typed.notifyType,
			});
			return;
		}

		if (method === "set_editor_text") {
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				text: String(typed.text ?? ""),
			});
			return;
		}

		if (method === "setWidget") {
			// Plan Mode 等扩展会频繁刷新 widget；只走 IPC 状态，不落入会话消息，避免 JSONL 被进度噪声污染。
			this.emit(ipcChannels.agentsUiRequest, {
				agentId,
				requestId,
				method,
				title: "",
				widgetKey: String(typed.widgetKey ?? requestId),
				widgetLines: Array.isArray(typed.widgetLines) ? typed.widgetLines : undefined,
				widgetPlacement: typed.widgetPlacement,
			});
			return;
		}
		// 其他非对话 UI 方法暂不占用桌面 UI 空间。
		if (["setStatus", "setTitle"].includes(method)) return;
		if (!["select", "confirm", "input", "editor"].includes(method)) return;

		// select 无选项时自动取消，不等用户响应
		if (method === "select" && (!Array.isArray(typed.options) || typed.options.length === 0)) {
			this.sendUIResponse(agentId, requestId, { cancelled: true });
			return;
		}

		const request = {
			agentId,
			requestId,
			method,
			title: String(typed.title ?? typed.question ?? ""),
			options: typed.options as string[] | undefined,
			placeholder: typed.placeholder as string | undefined,
			prefill: typed.prefill as string | undefined,
		};

		// 记录 pending UI 请求，用于 abort 时自动 cancel
		if (!this.pendingUIRequests.has(agentId)) {
			this.pendingUIRequests.set(agentId, new Map());
		}
		this.pendingUIRequests.get(agentId)!.set(requestId, { method, title: request.title });

		// 插入 system 消息作为卡片占位
		this.addMessage(agentId, "system", request.title, {
			type: "askQuestion",
			status: "pending",
			uiRequest: request,
		});

		// 通知渲染进程显示交互卡片
		this.emit(ipcChannels.agentsUiRequest, request);
		this.scheduleUIRequestTimeout(agentId, requestId, typed.timeout);
	}

	/**
	 * 发送 Extension UI 响应（extension_ui_response）到 pi 的 stdin。
	 * 同时更新对应卡片消息的状态。
	 */
	sendUIResponse(agentId: string, requestId: string, response: { value?: string | boolean; cancelled?: boolean; confirmed?: boolean }) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		// 写入 extension_ui_response 到 pi 的 stdin

		const extPayload: Record<string, unknown> = {
			type: "extension_ui_response",
			id: requestId,
			value: response.value,
		};
		// pi 的 ctx.ui.confirm() 检查 confirmed 字段，ctx.ui.select/input 检查 value
		if ("confirmed" in response) extPayload.confirmed = response.confirmed;
		// 取消时发 cancelled: true
		if (response.cancelled) extPayload.cancelled = true;
		runtime.process.client.sendRaw(extPayload);

		// 清理 pending 记录
		const pending = this.pendingUIRequests.get(agentId);
		if (pending) {
			pending.delete(requestId);
			if (pending.size === 0) this.pendingUIRequests.delete(agentId);
		}

		// 更新卡片消息状态为 answered 或 cancelled；cancelled 时从消息流移除，不留痕迹
		const messages = this.messages.get(agentId);
		if (messages) {
			if (response.cancelled) {
				// 取消交互：从消息流中移除对应的 askQuestion 卡片，不在时间线上留下痕迹
				const idx = messages.findIndex(
					(msg) =>
						msg.role === "system" &&
						msg.meta?.type === "askQuestion" &&
						(msg.meta as Record<string, unknown>).uiRequest &&
						((msg.meta as Record<string, unknown>).uiRequest as Record<string, unknown>).requestId === requestId,
				);
				if (idx !== -1) {
					messages.splice(idx, 1);
					this.messages.set(agentId, messages);
				}
			} else {
				for (const msg of messages) {
					if (
						msg.role === "system" &&
						msg.meta?.type === "askQuestion" &&
						(msg.meta as Record<string, unknown>).uiRequest &&
						((msg.meta as Record<string, unknown>).uiRequest as Record<string, unknown>).requestId === requestId
					) {
						(msg.meta as Record<string, string>).status = "answered";
						(msg.meta as Record<string, unknown>).response = response;
						break;
					}
				}
			}
			this.scheduleMessageEmit(agentId, false);
		}

		// 通知渲染进程 UI 请求已完成
		this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true, ...response });
	}

	/**
	 * pi 信任机制只对“含项目级 pi 资源”的项目触发，且 RPC 模式下 pi 的 project_trust 事件
	 * hasUI 恒为 false、ctx.ui.select 不接 RPC UI 协议，无法弹窗。
	 * 因此 pi-desktop 在启动 pi 进程前自行完成信任确认：干净项目自动信任并写入 trust.json；
	 * 含 .pi/.agents 资源且未记录的项目弹窗让用户决策。
	 */
	private static readonly TRUST_REQUIRING_RESOURCE_FILES = [
		"settings.json",
		"extensions",
		"skills",
		"prompts",
		"themes",
		"SYSTEM.md",
		"APPEND_SYSTEM.md",
	] as const;

	/**
	 * 复刻 pi 的 hasTrustRequiringProjectResources：检查项目目录或其父目录是否存在
	 * 需要信任才能加载的资源（.pi 下的配置/扩展/skills 等，或项目级 .agents/skills）。
	 * 用户全局 ~/.agents/skills 视为可信，不触发信任确认。
	 */
	private hasTrustRequiringResources(cwd: string): boolean {
		const configDir = join(cwd, ".pi");
		if (
			AgentManager.TRUST_REQUIRING_RESOURCE_FILES.some((file) => existsSync(join(configDir, file)))
		) {
			return true;
		}
		const userAgentsSkillsDir = join(homedir(), ".agents", "skills");
		let currentDir = cwd;
		while (true) {
			const agentsSkillsDir = join(currentDir, ".agents", "skills");
			if (agentsSkillsDir !== userAgentsSkillsDir && existsSync(agentsSkillsDir)) {
				return true;
			}
			const parentDir = dirname(currentDir);
			if (parentDir === currentDir) return false;
			currentDir = parentDir;
		}
	}

	/**
	 * 启动 pi 前完成项目信任确认。
	 * - 无需信任资源的项目（干净项目）：自动写入 trust.json 标记信任，后续不再重复检查。
	 * - 含信任资源的项目：已信任则放行；已显式拒绝则抛错；未记录则弹窗等待用户决策。
	 */
	/**
	 * 启动 pi 前完成项目信任确认，返回需传给 pi 的信任覆盖指令。
	 * - 无需信任资源的项目（干净项目）：自动写入 trust.json 标记信任。
	 * - 已信任：放行，pi 查 trustStore 即可。
	 * - 未记录或曾记 false：弹窗让用户选择。不持久化 false，保证下次仍可重新选择。
	 *   - trust-remember：写 true，pi 信任加载资源。
	 *   - trust-session：用 --approve 本次覆盖，不落盘。
	 *   - deny：用 --no-approve 本次以不信任模式启动，pi 不加载项目级资源，Agent 仍可创建。
	 */
	private async ensureProjectTrust(project: Project): Promise<"approve" | "no-approve" | undefined> {
		const cwd = project.path;
		if (!this.hasTrustRequiringResources(cwd)) {
			// 干净项目：pi 无需加载项目级资源，pi-desktop 自动记入信任，避免每次创建 Agent 重复检查。
			await this.configManager.ensureTrustedDirectory(cwd);
			return undefined;
		}
		const decision = await this.configManager.getProjectTrustDecision(cwd);
		if (decision === true) return undefined;
		// 未记录或曾记 false：弹窗让用户选择信任策略。不写 false，确保下次打开仍可重新决策。
		const choice = await this.requestProjectTrust(cwd, project.name);
		if (choice === "trust-remember") {
			await this.configManager.setProjectTrustDecision(cwd, true);
			return undefined;
		}
		if (choice === "trust-session") {
			return "approve";
		}
		// deny：本次以不信任模式启动，pi 不加载项目级资源，Agent 仍可创建。
		return "no-approve";
	}

	/**
	 * 通过 IPC 请求渲染进程弹出项目信任确认窗，等待用户选择。
	 * 无窗口可用（如 headless）或 60 秒未响应时默认拒绝（安全优先）。
	 */
	private requestProjectTrust(cwd: string, projectName: string): Promise<ProjectTrustChoice> {
		const requestId = randomUUID();
		const win = this.getWindow();
		if (!win || win.isDestroyed()) {
			return Promise.resolve<ProjectTrustChoice>("deny");
		}
		return new Promise<ProjectTrustChoice>((resolve) => {
			const timer = setTimeout(() => {
				if (this.pendingTrustRequests.delete(requestId)) {
					resolve("deny");
				}
			}, 60_000);
			this.pendingTrustRequests.set(requestId, {
				resolve: (choice) => {
					clearTimeout(timer);
					resolve(choice);
				},
			});
			win.webContents.send(ipcChannels.agentsTrustRequest, { requestId, cwd, projectName });
		});
	}

	/** 渲染进程回传用户对信任确认弹窗的选择，唤醒等待中的 Agent 创建流程。 */
	respondTrustRequest(requestId: string, choice: ProjectTrustChoice): void {
		const pending = this.pendingTrustRequests.get(requestId);
		if (pending) {
			this.pendingTrustRequests.delete(requestId);
			pending.resolve(choice);
		}
	}

	private handleAssistantMessageEvent(agentId: string, event: Record<string, any>) {
		const assistantEvent = event.assistantMessageEvent as Record<string, any>;
		const eventType = assistantEvent.type as string | undefined;
		const partialMessage =
			event.message ??
			assistantEvent.message ??
			assistantEvent.partial ??
			assistantEvent.partialMessage;

		if (eventType === "start" || eventType === "message_start") {
			this.beginAssistantMessage(agentId);
			this.upsertAssistantMessage(agentId, partialMessage);
			return;
		}

		if (eventType === "text_start" || eventType === "text_end") {
			this.upsertAssistantMessage(agentId, partialMessage);
			return;
		}

		if (eventType === "text_delta") {
			this.upsertAssistantMessage(
				agentId,
				partialMessage,
				String(assistantEvent.delta ?? ""),
			);
			return;
		}

		if (eventType === "thinking_delta") {
			const prev = this.streamingThinking.get(agentId) ?? "";
			const delta = String(assistantEvent.delta ?? "");
			this.streamingThinking.set(agentId, prev + delta);
			this.emitThinking(agentId, this.stripAnsi(prev + delta));
			this.upsertAssistantMessage(agentId, partialMessage);
			return;
		}

		if (eventType === "thinking_end") {
			const finalThinking = String(
				assistantEvent.content ?? this.streamingThinking.get(agentId) ?? "",
			);
			if (finalThinking) {
				this.streamingThinking.set(agentId, finalThinking);
			}
			this.upsertAssistantMessage(agentId, partialMessage);
			// thinking_end 是阶段性终态，立即 flush 让思考块完整落盘显示。
			this.flushMessageEmit(agentId);
			return;
		}

		if (eventType === "message_end" || eventType === "done" || eventType === "error") {
			this.upsertAssistantMessage(agentId, partialMessage);
			// message_end/done/error 是本轮回答的最终状态，立即 flush 确保完整消息及时可见。
			this.flushMessageEmit(agentId);
			this.activeAssistantMessageIds.delete(agentId);
		}
	}

	private beginAssistantMessage(agentId: string) {
		if (!this.activeAssistantMessageIds.has(agentId)) {
			this.activeAssistantMessageIds.set(agentId, randomUUID());
		}
	}

	private upsertAssistantMessage(
		agentId: string,
		partialMessage?: unknown,
		fallbackDelta = "",
	) {
		const list = this.messages.get(agentId) ?? [];
		let messageId = this.activeAssistantMessageIds.get(agentId);
		if (!messageId) {
			messageId = randomUUID();
			this.activeAssistantMessageIds.set(agentId, messageId);
		}

		const existing = list.find((message) => message.id === messageId);
		const extractedText =
			partialMessage && typeof partialMessage === "object"
				? this.extractText((partialMessage as any).content)
				: "";
		const extractedThinking =
			partialMessage && typeof partialMessage === "object"
				? this.extractThinking((partialMessage as any).content)
				: "";
		const pendingThinking = this.streamingThinking.get(agentId);
		const nextThinking = this.stripAnsi(extractedThinking || pendingThinking || "");

		if (existing) {
			existing.text = extractedText || `${existing.text}${fallbackDelta}`;
			if (nextThinking) existing.thinking = nextThinking;
			existing.timestamp = Date.now();
		} else {
			const text = extractedText || fallbackDelta;
			if (!text) return;
			list.push({
				id: messageId,
				agentId,
				role: "assistant",
				text,
				timestamp: Date.now(),
				...(nextThinking ? { thinking: nextThinking } : {}),
			});
		}

		if (nextThinking && (extractedText || fallbackDelta)) {
			this.streamingThinking.delete(agentId);
			this.emitThinking(agentId, "");
		}

		this.messages.set(agentId, list);
		// upsertAssistantMessage 被 text_delta/thinking_delta 高频调用，走节流合并；
		// message_end/thinking_end 等终态调用方会在调用后显式 flush，保证最终状态及时。
		this.scheduleMessageEmit(agentId);
	}

	private upsertToolMessage(
		agentId: string,
		event: Record<string, any>,
		status: "running" | "done" | "error",
	) {
		const toolName = event.toolName || "tool";
		const toolCallId = String(event.toolCallId ?? `${toolName}-${Date.now()}`);
		let agentTools = this.toolMessageIds.get(agentId);
		if (!agentTools) {
			agentTools = new Map<string, string>();
			this.toolMessageIds.set(agentId, agentTools);
		}

		let messageId = agentTools.get(toolCallId);
		if (!messageId) {
			messageId = randomUUID();
			agentTools.set(toolCallId, messageId);
		}

		const list = this.messages.get(agentId) ?? [];
		const existing = list.find((message) => message.id === messageId);
		const isError = status === "error" || event.isError === true;
		const args = event.args ?? existing?.meta?.args;
		const startedAt =
			typeof existing?.meta?.startedAt === "number"
				? existing.meta.startedAt
				: Date.now();
		// 工具耗时只能由 start/end 两个事件推导；start 时先保存 startedAt，end 时再写入 durationMs，
		// 避免使用消息 timestamp（会在 update/end 时刷新）导致历史恢复后耗时不可还原。
		const durationMs =
			status === "running" ? undefined : Math.max(0, Date.now() - startedAt);

		// 工具首次开始执行时尝试异步读取原始文件内容（pi-deck-file-capture 扩展未安装时的回退方案）。
		// 当扩展已安装时，后续 tool_execution_end 会从 result.details._piDeckOriginalContent
		// 同步拿到原始内容，可跳过此处的异步读取。
		let originalContent: string | undefined = existing?.meta?.originalContent as
			| string
			| undefined;
		if (
			status === "running" &&
			!originalContent &&
			typeof args === "object" &&
			args !== null
		) {
			const filePath =
				typeof (args as any).filePath === "string"
					? (args as any).filePath
					: typeof (args as any).path === "string"
						? (args as any).path
						: undefined;
			if (filePath) {
				readFile(filePath, "utf8")
					.then((content) => {
						originalContent = content;
						// originalContent 是异步补齐的；必须替换 message/meta 和数组引用，
						// 否则 renderer 的浅比较与 useMemo 会继续使用空快照，diff 左侧就会空白。
						const currentList = this.messages.get(agentId) ?? [];
						const nextList = currentList.map((message) =>
							message.id === messageId
								? {
									...message,
									meta: {
										...(message.meta ?? {}),
										originalContent: content,
									},
								}
								: message,
						);
						this.messages.set(agentId, nextList);
						this.scheduleMessageEmit(agentId, true);
					})
					.catch(() => {
						// 文件不存在或被删除，跳过
					});
			}
		}
		const result =
			event.result ??
			event.partialResult ??
			event.output ??
			existing?.meta?.result;

		// 优先使用 pi-deck-file-capture 扩展注入的原始内容（在 tool_execution_end 中可用）
		// 该扩展在工具执行前从磁盘读取原文件，结果存入 details._piDeckOriginalContent，
		// 无需异步读取，且数据会持久化到 session JSONL 供历史会话恢复。
		if (
			!originalContent &&
			result &&
			typeof result === "object" &&
			(result as any).details?._piDeckOriginalContent
		) {
			originalContent = (result as any).details._piDeckOriginalContent as string;
		}
		const detailText = this.formatToolDetail(
			toolName,
			args,
			result,
			isError,
		);
		const icon = status === "running" ? "▶" : isError ? "✗" : "✓";
		const text =
			status === "running" ? `${icon} ${toolName}` : `${icon} ${toolName}`;
		// args 可能来自 event.args（对象）或 existing.meta.args（已序列化的 JSON 字符串）。
		// 如果是后者（如 tool_execution_end 不带 args），直接复用已有字符串避免 double encoding。
		const argsMeta = typeof args === "string" ? args : this.truncateForDetail(this.safeJson(args));
		// 提取 ask_question 详情用于渲染提问卡片；支持批量（questions 数组）和单问题两种格式。
		const askDetails =
			toolName === "ask_question" &&
				result && typeof result === "object" &&
				((result as any).details?.question || Array.isArray((result as any).details?.answers))
			? (result as any).details
			: undefined;
		const askCard = (() => {
			if (!askDetails) return undefined;
			// abort 时覆写 answer 为 null、answered 为 false，确保卡片显示"已取消"
			const aborted = this.abortedDuringAsk.has(agentId);
			// 单问题格式：details.question (string), details.answer
			if (askDetails.question) {
				return {
					question: askDetails.question,
					type: askDetails.type,
					answered: aborted ? false : askDetails.answered,
					answer: aborted ? null : askDetails.answer,
					answerLabel: aborted ? undefined : askDetails.answerLabel,
					options: askDetails.options,
				};
			}
			// 批量格式：details.questions / details.answers 数组，取第一组问答展示
			if (Array.isArray(askDetails.answers) && askDetails.answers.length > 0) {
				const firstQuestion = Array.isArray(askDetails.questions) ? askDetails.questions[0] : undefined;
				const firstAnswer = askDetails.answers[0];
				return {
					question: firstQuestion?.question ?? String(firstAnswer.id ?? ""),
					type: firstAnswer.type ?? firstQuestion?.type ?? "input",
					answered: !askDetails.cancelled && firstAnswer.value !== null,
					answer: firstAnswer.value,
					answerLabel: firstAnswer.label,
					options: firstQuestion?.options,
				};
			}
			return undefined;
		})();
		const meta = {
			status,
			toolName,
			toolCallId,
			startedAt,
			...(durationMs !== undefined ? { durationMs } : {}),
			args: argsMeta,
			result: this.truncateForDetail(this.extractToolResultText(result) || this.safeJson(result)),
			isError,
			detailText,
			originalContent,
			...(askCard ? { _askCard: askCard } : {}),
		};

		if (existing) {
			existing.text = text;
			existing.timestamp = Date.now();
			existing.meta = meta;
		} else {
			list.push({
				id: messageId,
				agentId,
				role: "tool",
				text,
				timestamp: Date.now(),
				meta,
			});
		}

		this.messages.set(agentId, list);
		this.scheduleMessageEmit(agentId);
	}

	private addMessage(
		agentId: string,
		role: ChatMessage["role"],
		text: string,
		meta?: Record<string, unknown>,
		images?: ImageContent[],
	) {
		const list = this.messages.get(agentId) ?? [];
		list.push({
			id: randomUUID(),
			agentId,
			role,
			text,
			timestamp: Date.now(),
			meta,
			...(images && images.length > 0 ? { images } : {}),
		});
		this.messages.set(agentId, list);
		if (role === "user" || role === "assistant") this.refreshAutoTitle(agentId);
		this.scheduleMessageEmit(agentId, true);
	}

	private refreshAutoTitle(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return false;
		const project = this.getProject(runtime.tab.projectId);
		if (!project) return false;
		if (!this.isDefaultAgentTitle(runtime.tab.title, project)) return false;
		const nextTitle = this.inferTitleFromMessages(this.messages.get(agentId) ?? []);
		if (!nextTitle || nextTitle === runtime.tab.title) return false;
		// Agent 列表标题应和历史会话列表的“摘要名”一致；
		// 只覆盖默认标题，避免打开/重命名过的历史会话名称被第一条消息反向改掉。
		runtime.tab.title = nextTitle;
		this.emitState();
		return true;
	}

	private isDefaultAgentTitle(title: string, project: Project) {
		return (
			title === `${project.name} agent` ||
			title === `${project.name} 历史会话` ||
			title === "历史会话"
		);
	}

	private inferTitleFromMessages(messages: ChatMessage[]) {
		const firstUserText = messages.find((message) => message.role === "user")?.text;
		const firstAssistantText = messages.find(
			(message) => message.role === "assistant",
		)?.text;
		return this.cleanTitle(firstUserText) || this.cleanTitle(firstAssistantText);
	}

	private cleanTitle(value?: string) {
		const text = value?.replace(/\s+/g, " ").trim();
		if (!text || /^untitled$/i.test(text)) return undefined;
		return text.length > 32 ? `${text.slice(0, 32)}…` : text;
	}

	private addDetailedErrorMessage(agentId: string, errorMessage: string) {
		const retryMessageId = this.retryStatusMessageIds.get(agentId);
		const retryMessage = retryMessageId
			? this.messages.get(agentId)?.find((message) => message.id === retryMessageId)
			: undefined;
		const attempt = Number(retryMessage?.meta?.attempt ?? 0);
		const maxAttempts = Number(retryMessage?.meta?.maxAttempts ?? 0);
		const retryLine = maxAttempts > 0 ? `\n\n已自动重试：${attempt}/${maxAttempts} 次` : "";
		// 最终失败时把重试次数和原始错误放在同一条错误消息里，便于用户复制给模型/服务商排查。
		this.addMessage(agentId, "error", `请求失败。${retryLine}\n\n原因：${errorMessage}`);
	}

	private upsertRetryStatusMessage(
		agentId: string,
		event: Record<string, any>,
		status: "running" | "success" | "error",
	) {
		const list = this.messages.get(agentId) ?? [];
		let messageId = this.retryStatusMessageIds.get(agentId);
		let message = messageId ? list.find((item) => item.id === messageId) : undefined;
		if (!message) {
			messageId = randomUUID();
			message = {
				id: messageId,
				agentId,
				role: "system",
				text: "",
				timestamp: Date.now(),
			};
			list.push(message);
			this.retryStatusMessageIds.set(agentId, messageId);
		}

		const attempt = Number(event.attempt ?? message.meta?.attempt ?? 0);
		const maxAttempts = Number(event.maxAttempts ?? message.meta?.maxAttempts ?? 0);
		const delayMs = Number(event.delayMs ?? 0);
		const reason = String(
			event.errorMessage ?? event.finalError ?? message.meta?.errorMessage ?? "未知错误",
		);
		const delayText = delayMs > 0 ? `，${Math.ceil(delayMs / 1000)} 秒后重试` : "";
		const countText = maxAttempts > 0 ? `${attempt}/${maxAttempts}` : String(attempt || 1);

		if (status === "running") {
			message.text = `正在自动重试 ${countText}${delayText}\n原因：${reason}`;
		} else if (status === "success") {
			message.text = `自动重试成功，共重试 ${attempt} 次`;
		} else {
			message.text = `自动重试失败，已重试 ${countText} 次\n原因：${reason}`;
		}
		message.timestamp = Date.now();
		message.meta = { status, attempt, maxAttempts, delayMs, errorMessage: reason };

		this.messages.set(agentId, list);
		this.scheduleMessageEmit(agentId, true);
	}

		/**
	 * 从 get_entries 响应构建 active branch 的 entryId 有序列表。
	 * 从 leafId 沿 parentId 回溯至 root 得到有序列表。
	 * 这个列表的顺序与 get_messages 返回的消息顺序一致，
	 * 用于在 convertAgentMessages 中按位置匹配 entryId 到 message。
	 * 只保留 type=message 的 entryId（即 user/assistant/toolResult 角色消息），
	 * 剔除 session、model_change、thinking_level_change、custom 等非消息条目，
	 * 使返回的 id 列表与 get_messages 返回的 rawMessages 一一对齐。
	 */
	private buildActiveBranchEntryIds(
		entries: Array<{ id: string; parentId: string | null; type?: string; message?: { role?: string } }>,
		leafId: string,
	): string[] {
		const entryById = new Map<string, { id: string; parentId: string | null; type?: string; message?: { role?: string } }>();
		for (const entry of entries) {
			entryById.set(entry.id, entry);
		}

		// 从 leafId 回溯到 root，只保留 type=message 的条目
		const allBranchIds: string[] = [];
		let currentId: string | null = leafId;
		while (currentId) {
			allBranchIds.unshift(currentId);
			const entry = entryById.get(currentId);
			currentId = entry?.parentId ?? null;
		}
		return allBranchIds.filter((id) => entryById.get(id)?.type === "message");
	}

	private convertAgentMessages(
		agentId: string,
		rawMessages: unknown[],
		activeEntryIds?: string[],
	): ChatMessage[] {
		const historicalToolCalls = this.collectHistoricalToolCalls(rawMessages);
		const historicalOriginalContentByPath = this.collectHistoricalOriginalContentByPath(
			rawMessages,
			historicalToolCalls,
		);
		// 用于生成元消息 id（compaction/branchSummary）的计数器
		let metaSeq = 0;
		// entryId 按 active branch 顺序与 rawMessages 一一对应。
		// 注意：entryIndex 只在 user/assistant/toolResult 时递增，
		// 因为 compactionSummary/branchSummary 在 get_entries 中无对应 entry，
		// 同时 activeEntryIds 还包含 model_change/thinking_level_change/custom 等非角色条目。
		// 因此 currentEntryId 的读取必须放在各个角色块内部，不能在所有条目前统一读取，
		// 否则非 user/assistant/toolResult 条目会提前消费 entryIndex 槽位。
		let entryIndex = 0;
		return rawMessages
			.flatMap<ChatMessage>((message, index) => {
				if (!message || typeof message !== "object") return [];
				const typed = message as any;

				if (typed.role === "user") {
					// 在角色块内读取 entryId，避免 compactionSummary 等元消息抢占 slot
					const currentEntryId = activeEntryIds && entryIndex < activeEntryIds.length
						? activeEntryIds[entryIndex]
						: undefined;
					const images = this.extractImages(typed.content);
					const text = this.extractText(typed.content) ||
						(images.length > 0 ? "[图片]" : "");
					if (!text.trim()) return [];
					entryIndex++;
					return [{
						id: `${agentId}-history-${currentEntryId ?? index}`,
						agentId,
						role: "user" as const,
						text,
						timestamp: typed.timestamp ?? Date.now(),
						meta: {
							...(currentEntryId ? { entryId: currentEntryId } : {}),
							// 保留 _piDeckMsgSeq 作为旧版本回退兼容
							_piDeckMsgSeq: index,
						},
						...(images.length > 0 ? { images } : {}),
					}];
				}
				if (typed.role === "assistant") {
					const currentEntryId = activeEntryIds && entryIndex < activeEntryIds.length
						? activeEntryIds[entryIndex]
						: undefined;
					const text = this.extractText(typed.content);
					if (!text.trim()) return [];
					const thinking = this.extractThinking(typed.content);
					entryIndex++;
					return [{
						id: `${agentId}-history-${currentEntryId ?? index}`,
						agentId,
						role: "assistant" as const,
						text,
						timestamp: typed.timestamp ?? Date.now(),
						meta: {
							...(currentEntryId ? { entryId: currentEntryId } : {}),
							_piDeckMsgSeq: index,
						},
						...(thinking ? { thinking } : {}),
					}];
				}
				if (typed.role === "toolResult") {
					const currentEntryId = activeEntryIds && entryIndex < activeEntryIds.length
						? activeEntryIds[entryIndex]
						: undefined;
					const toolCallId = String(typed.toolCallId ?? `history-tool-${index}`);
					const historicalCall = historicalToolCalls.get(toolCallId);
					const toolName = String(typed.toolName ?? historicalCall?.name ?? "tool");
					const isError = Boolean(typed.isError);
					const startedAt =
						typeof typed.startedAt === "number" ? typed.startedAt : historicalCall?.timestamp;
					const durationMs =
						typeof typed.durationMs === "number"
							? typed.durationMs
							: typeof startedAt === "number" && typeof typed.timestamp === "number"
								? Math.max(0, typed.timestamp - startedAt)
								: undefined;
					const result = {
						content: typed.content,
						details: typed.details,
					};
					const filePath = this.getToolPathFromArgs(historicalCall?.args);
					const piDeckOriginalContent = typed.details?._piDeckOriginalContent as
						| string
						| undefined;
					const originalContent =
						piDeckOriginalContent ??
						(filePath
							? historicalOriginalContentByPath.get(filePath)
							: undefined);
					const detailText = this.formatToolDetail(
						toolName,
						historicalCall?.args,
						result,
						isError,
					);
					// 从历史工具结果中提取 ask_question 详情，用于渲染提问卡片（支持单问题和批量格式）。
					const askCard = (() => {
						if (toolName !== "ask_question" || !typed.details) return undefined;
						// abort 时发 value:null 导致 answer 为 null，但 pi 可能已默认选了第一选项。
						// 覆写 answer 为 null、answered 为 false，确保卡片显示"已取消"。
						const aborted = this.abortedDuringAsk.has(agentId);
						// 单问题格式：details.question (string), details.answer
						if (typed.details.question) {
							return {
								question: typed.details.question,
								type: typed.details.type,
								answered: aborted ? false : typed.details.answered,
								answer: aborted ? null : typed.details.answer,
								answerLabel: aborted ? undefined : typed.details.answerLabel,
								options: typed.details.options,
							};
						}
						// 批量格式：details.questions / details.answers 数组，取第一组问答
						if (Array.isArray(typed.details.answers) && typed.details.answers.length > 0) {
							const firstQuestion = Array.isArray(typed.details.questions) ? typed.details.questions[0] : undefined;
							const firstAnswer = typed.details.answers[0];
							return {
								question: firstQuestion?.question ?? String(firstAnswer.id ?? ""),
								type: firstAnswer.type ?? firstQuestion?.type ?? "input",
								answered: !typed.details.cancelled && firstAnswer.value !== null,
								answer: firstAnswer.value,
								answerLabel: firstAnswer.label,
								options: firstQuestion?.options,
							};
						}
						return undefined;
					})();
					entryIndex++;
					return [{
						id: `${agentId}-history-${currentEntryId ?? index}`,
						agentId,
						role: "tool" as const,
						text: `${isError ? "✗" : "✓"} ${toolName}`,
						timestamp: typed.timestamp ?? Date.now(),
						meta: {
							...(currentEntryId ? { entryId: currentEntryId } : {}),
							_piDeckMsgSeq: index,
							status: isError ? "error" : "done",
							toolName,
							toolCallId,
							...(startedAt !== undefined ? { startedAt } : {}),
							...(durationMs !== undefined ? { durationMs } : {}),
							args: this.truncateForDetail(this.safeJson(historicalCall?.args)),
							result: this.truncateForDetail(this.extractToolResultText(result) || this.safeJson(result)),
							isError,
							detailText,
							// 初始加载不传 originalContent（edit 前后的完整文件内容），
							// 仅在用户打开 diff 时通过 IPC 按需加载，减少 IPC 数据量。
							...(askCard ? { _askCard: askCard } : {}),
						},
					}];
				}
				// 压缩/分支摘要等元消息：显示在时间线上，不参与 _piDeckMsgSeq 计数
				if (typed.role === "compactionSummary" || typed.role === "branchSummary") {
					const isCompaction = typed.role === "compactionSummary";
					metaSeq++;
					return [{
						id: `${agentId}-meta-${metaSeq}`,
						agentId,
						role: "system" as const,
						text: typed.summary ?? (isCompaction ? "Session compacted" : "Branch summarized"),
						timestamp: typeof typed.timestamp === "number"
							? typed.timestamp
							: Date.now(),
						meta: {
							type: isCompaction ? "compaction" : "branchSummary",
							tokensBefore: typed.tokensBefore,
						},
					}];
				}
				return [];
			})
			.filter((message: ChatMessage) => message.text.trim());
	}

	private collectHistoricalToolCalls(rawMessages: unknown[]) {
		const calls = new Map<string, { name: string; args: unknown; timestamp?: number }>();
		for (const message of rawMessages) {
			if (!message || typeof message !== "object") continue;
			const typed = message as any;
			if (typed.role !== "assistant" || !Array.isArray(typed.content)) continue;
			for (const block of typed.content) {
				if (!block || typeof block !== "object") continue;
				const toolCall = block as any;
				if (toolCall.type !== "toolCall" || !toolCall.id) continue;
				// pi 的历史文件把工具参数保存在 assistant.content 的 toolCall 块中，
				// toolResult 只带结果；恢复历史详情时必须先建立 toolCallId → 参数映射。
				calls.set(String(toolCall.id), {
					name: String(toolCall.name ?? "tool"),
					args: toolCall.arguments,
					// 旧会话没有 durationMs，只能用发起 toolCall 的 assistant 时间戳作为兜底起点；
					// 同一条 assistant 内并发多个工具时精度有限，但比完全不显示耗时更接近历史行为。
					timestamp: typeof typed.timestamp === "number" ? typed.timestamp : undefined,
				});
			}
		}
		return calls;
	}

	private collectHistoricalOriginalContentByPath(
		rawMessages: unknown[],
		historicalToolCalls: Map<string, { name: string; args: unknown }>,
	) {
		const originals = new Map<string, string>();
		for (const message of rawMessages) {
			if (!message || typeof message !== "object") continue;
			const typed = message as any;
			if (typed.role !== "toolResult") continue;
			const toolCallId = String(typed.toolCallId ?? "");
			const historicalCall = historicalToolCalls.get(toolCallId);
			if (!historicalCall || historicalCall.name !== "read") continue;
			const filePath = this.getToolPathFromArgs(historicalCall.args);
			if (!filePath) continue;
			// 旧历史会话没有保存 originalContent；同一轮写入前通常会先 read 目标文件，
			// 用最近一次 read 结果作为后续 write/edit/patch 的 diff 基准。
			const content = this.extractText(typed.content);
			if (content) originals.set(filePath, content);
		}
		return originals;
	}

	private getToolPathFromArgs(args: unknown) {
		if (!args || typeof args !== "object") return "";
		const typed = args as any;
		return String(
			typed.path ??
				typed.filePath ??
				typed.file ??
				typed.target_file ??
				typed.targetFile ??
				"",
		);
	}

	private formatToolDetail(
		toolName: string,
		args: unknown,
		result: unknown,
		isError: boolean,
	) {
		const details = this.extractToolDetails(result);
		// args/结果/details 都先序列化再截断，避免单条工具详情撑大 ChatMessage.meta。
		// 注意：args 在 end/update 事件里可能已是序列化字符串（从 existing.meta.args 回退），
		// 此时 safeJson(string) 会二次编码导致显示异常，先反解回对象再序列化。
		let argsObj = args;
		if (typeof args === "string" && args.trim()) {
			try {
				argsObj = JSON.parse(args) as unknown;
			} catch {
				// truncated/不可解析时保持原样
			}
		}
		const argsText = argsObj ? this.truncateForDetail(this.safeJson(argsObj)) : "";
		const resultText = result
			? this.truncateForDetail(this.extractToolResultText(result) || this.safeJson(result))
			: "";
		const detailsText = details ? this.truncateForDetail(this.safeJson(details)) : "";
		const sections = [
			`工具：${toolName ?? "tool"}`,
			`状态：${isError ? "失败" : "完成"}`,
			args ? `参数：\n${argsText}` : "",
			result ? `结果：\n${resultText}` : "",
			details ? `详情：\n${detailsText}` : "",
		].filter(Boolean);
		return sections.join("\n\n");
	}

	private extractToolDetails(result: unknown) {
		if (!result || typeof result !== "object") return undefined;
		return (result as any).details;
	}

	/** 对超长工具文本做首尾截断，保留头部和尾部以兼顾开头信息和错误堆栈。 */
	private truncateForDetail(text: unknown): string {
		// safeJson/extractToolResultText 在某些输入下可能返回 undefined（如 JSON.stringify(undefined)），
		// 必须在此归一化为字符串，否则后续 .length 访问会抛 TypeError 导致主进程未捕获异常弹窗。
		const str = typeof text === "string" ? text : text == null ? "" : String(text);
		if (str.length <= AgentManager.MAX_TOOL_RESULT_CHARS) return str;
		const keep = Math.floor(AgentManager.MAX_TOOL_RESULT_CHARS / 2);
		const omitted = str.length - keep * 2;
		return (
			`${str.slice(0, keep)}\n` +
			`…（已省略中间 ${omitted} 字符，完整内容共 ${str.length} 字符）\n` +
			str.slice(-keep)
		);
	}

	private scheduleUIRequestTimeout(agentId: string, requestId: string, timeout: unknown) {
		if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) return;

		const timer = setTimeout(() => {
			const pending = this.pendingUIRequests.get(agentId);
			if (!pending?.has(requestId)) return;

			pending.delete(requestId);
			if (pending.size === 0) this.pendingUIRequests.delete(agentId);

			const messages = this.messages.get(agentId);
			if (messages) {
				const idx = messages.findIndex(
					(msg) =>
						msg.role === "system" &&
						msg.meta?.type === "askQuestion" &&
						(msg.meta as Record<string, unknown>).uiRequest &&
						((msg.meta as Record<string, unknown>).uiRequest as Record<string, unknown>).requestId === requestId,
				);
				if (idx !== -1) {
					messages.splice(idx, 1);
					this.messages.set(agentId, messages);
					this.scheduleMessageEmit(agentId, false);
				}
			}

			this.emit(ipcChannels.agentsUiRequest, { agentId, requestId, completed: true, cancelled: true });
		}, Math.floor(timeout));
		timer.unref?.();
	}

	private scheduleIdleCheckAfterExtensionCommand(agentId: string) {
		const timer = setTimeout(() => {
			void this.markIdleIfPiReportsNoWork(agentId);
		}, 100);
		timer.unref?.();
	}

	private async markIdleIfPiReportsNoWork(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime || runtime.tab.status !== "running") return;
		if ((this.pendingUIRequests.get(agentId)?.size ?? 0) > 0) return;
		if (this.rpcCompactingAgents.has(agentId) || this.compactingAgents.has(agentId)) return;
		if (this.activeAssistantMessageIds.has(agentId)) return;
		if (this.toolExecutingByAgent.get(agentId)) return;

		const response = await runtime.process.client
			.request({ type: "get_state" }, 10_000)
			.catch(() => undefined);
		if (!response?.success || !response.data) return;

		const state = response.data as {
			isStreaming?: boolean;
			isCompacting?: boolean;
			pendingMessageCount?: number;
		};
		if (state.isStreaming || state.isCompacting || (state.pendingMessageCount ?? 0) > 0) return;

		runtime.tab.status = "idle";
		this.streamingThinking.delete(agentId);
		this.emitThinking(agentId, "");
		this.emitState();
		void this.getRuntimeState(agentId)
			.then((state) => this.emit(ipcChannels.agentsRuntimeState, { agentId, state }))
			.catch(() => undefined);
	}

	private extractToolResultText(result: unknown) {
		if (!result || typeof result !== "object") return "";
		const content = (result as any).content;
		if (!Array.isArray(content)) return "";
		return content
			.map((item) => (typeof item?.text === "string" ? item.text : ""))
			.filter(Boolean)
			.join("\n");
	}

	private safeJson(value: unknown) {
		try {
			return JSON.stringify(value, null, 2);
		} catch {
			return String(value);
		}
	}

	private extractText(content: unknown): string {
		return extractMessageText(content);
	}

	/** 从 pi 历史消息 content 中恢复图片附件，用于历史会话重新打开后的图片展示。 */
	private extractImages(content: unknown): ImageContent[] {
		if (!Array.isArray(content)) return [];
		return content.flatMap<ImageContent>((item) => {
			if (!item || typeof item !== "object") return [];
			const typed = item as any;
			if (typed.type !== "image") return [];
			const data = typeof typed.data === "string" ? typed.data : "";
			const mimeType =
				typeof typed.mimeType === "string"
					? typed.mimeType
					: typeof typed.mime_type === "string"
						? typed.mime_type
						: "image/png";
			return data ? [{ type: "image", data, mimeType }] : [];
		});
	}

	/** 从历史消息 content 数组中提取 thinking 内容块的文本，清理 ANSI 转义码 */
	private extractThinking(content: unknown): string {
		if (!Array.isArray(content)) return "";
		const raw = content
			.map((item) => {
				if (!item || typeof item !== "object") return "";
				const typed = item as any;
				if (typed.type !== "thinking") return "";
				return String(typed.thinking ?? typed.text ?? "");
			})
			.filter(Boolean)
			.join("\n");
		return this.stripAnsi(raw);
	}

	private requireRuntime(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) throw new Error(`Agent not found: ${agentId}`);
		return runtime;
	}

	/**
	 * 会话结束时发送系统通知。
	 * 仅在设置中启用通知且 Electron Notification 可用时触发，
	 * 通知用户 agent 已完成响应，可以查看结果或继续对话。
	 */
	private notifySessionEnd(sessionTitle: string) {
		try {
			const settings = this.settingsStore.get();
			if (!settings.enableNotifications) return;
			if (!Notification.isSupported()) return;

			// 使用应用名称作为通知标题，在 Windows/macOS 通知中心中显示为应用标识
			const appName = app.getName();
			const notification = new Notification({
				title: appName,
				body: `${sessionTitle} 已完成响应`,
				silent: false,
			});
			notification.show();
		} catch {
			// 通知失败不影响主流程，静默处理
		}
	}

	/** 清理 ANSI 转义码，模型思考内容中常见终端颜色序列 */
	private stripAnsi(text: string): string {
		return text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	}

	/**
	 * 安排一次消息 emit。流式高频事件走节流合并（同一 agent 50ms 内多次调用只 emit 一次最新数组）；
	 * immediate=true 时跳过节流立即 flush，用于 message_end/tool_execution_end 等终态事件，确保最终状态不丢。
	 */
	private scheduleMessageEmit(agentId: string, immediate = false) {
		if (immediate) {
			this.flushMessageEmit(agentId);
			return;
		}
		if (this.pendingMessageAgents.has(agentId)) return;
		this.pendingMessageAgents.add(agentId);
		const timer = setTimeout(() => this.flushMessageEmit(agentId), AgentManager.MESSAGE_FLUSH_INTERVAL_MS);
		// 节流定时器不应阻止进程退出
		timer.unref?.();
		this.messageFlushTimers.set(agentId, timer);
	}

	private flushMessageEmit(agentId: string) {
		const timer = this.messageFlushTimers.get(agentId);
		if (timer) {
			clearTimeout(timer);
			this.messageFlushTimers.delete(agentId);
		}
		this.pendingMessageAgents.delete(agentId);
		this.emit(ipcChannels.agentsMessage, {
			agentId,
			messages: this.messages.get(agentId) ?? [],
		});
	}

	private emitThinking(agentId: string, thinking: string) {
		const update: ThinkingUpdate = { agentId, thinking };
		this.emit(ipcChannels.agentsThinking, update);
	}

	private emitState() {
		const tabs = this.list();
		this.emit(ipcChannels.agentsState, tabs);
		// 同步通知主进程内部状态订阅者（PetStateBridge），使宠物窗能拿到聚合状态。
		// 设计文档原拟用 ipcMain.on("agents:state") 桥接是错的：webContents.send 是
		// 主进程→渲染层单向通道，ipcMain 收不到主进程自己发出的消息，故改用本钩子。
		this.notifyStateListeners(tabs);
	}

	private emit(channel: string, payload: unknown) {
		const window = this.getWindow();
		if (!window || window.isDestroyed()) return;
		window.webContents.send(channel, payload);
	}
}

type AgentRuntime = {
	tab: AgentTab;
	process: PiProcess;
};
