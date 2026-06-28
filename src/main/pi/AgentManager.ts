import { app, type BrowserWindow, Notification } from "electron";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
import { formatBashToolMessage } from "./bashResult";
import type { SettingsStore } from "../settings/SettingsStore";
import type { ConfigManager } from "../config/ConfigManager";
import type { RpcLogger } from "../logging/RpcLogger";
import type { AppLogger } from "../logging/AppLogger";

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

	getMessages(agentId: string) {
		return this.messages.get(agentId) ?? [];
	}

	getCwd(agentId: string) {
		return this.requireRuntime(agentId).tab.cwd;
	}

	async loadMessages(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_messages",
		});
		const rawMessages = (response.data as { messages?: unknown[] } | undefined)?.messages ?? [];
		const trimmed = this.trimHistoryMessages(rawMessages);
		const messages = this.convertAgentMessages(agentId, trimmed);
		this.messages.set(agentId, messages);
		this.refreshAutoTitle(agentId);
		this.scheduleMessageEmit(agentId, true);
		return messages;
	}

	private async repairAssistantUsage(sessionPath: string) {
		const raw = await readFile(sessionPath, "utf8").catch(() => "");
		if (!raw) return;

		let changed = false;
		const lines = raw.split(/\r?\n/).map((line) => {
			if (!line.trim()) return line;
			try {
				const entry = JSON.parse(line) as { message?: Record<string, any> };
				if (entry.message?.role !== "assistant") return line;

				const usage = entry.message.usage as Record<string, any> | undefined;
				if (usage?.totalTokens != null && usage.cost?.total != null) return line;

				// Codex 导入的旧会话缺少 assistant.usage；pi 的统计/压缩链路会直接读取 totalTokens，所以打开前补零值兼容。
				entry.message.usage = this.normalizeUsage(usage);
				changed = true;
				return JSON.stringify(entry);
			} catch {
				return line;
			}
		});

		if (changed) await writeFile(sessionPath, lines.join("\n"), "utf8");
	}

	private normalizeUsage(usage: Record<string, any> | undefined) {
		return {
			input: usage?.input ?? 0,
			output: usage?.output ?? 0,
			cacheRead: usage?.cacheRead ?? 0,
			cacheWrite: usage?.cacheWrite ?? 0,
			totalTokens:
				usage?.totalTokens ??
				(usage?.input ?? 0) +
					(usage?.output ?? 0) +
					(usage?.cacheRead ?? 0) +
					(usage?.cacheWrite ?? 0),
			cost: {
				input: usage?.cost?.input ?? 0,
				output: usage?.cost?.output ?? 0,
				cacheRead: usage?.cost?.cacheRead ?? 0,
				cacheWrite: usage?.cost?.cacheWrite ?? 0,
				total: usage?.cost?.total ?? 0,
			},
		};
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
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);

		const id = randomUUID();
		const existingForSessionKey = this.normalizeSessionPathForCompare(input.sessionPath);
		const existingForSession = existingForSessionKey
			? this.findRuntimeBySessionKey(existingForSessionKey)
			: undefined;
		if (existingForSession) return existingForSession.tab;

		const tab: AgentTab = {
			id,
			projectId: project.id,
			cwd: project.path,
			title: input.title || `${project.name} agent`,
			status: "starting",
			sessionPath: input.sessionPath,
			createdAt: Date.now(),
		};

		if (input.sessionPath) await this.repairAssistantUsage(input.sessionPath);
		// 新建 Agent 和历史会话恢复都走此入口；启动前落盘 trust.json，确保项目级 AGENTS.md/扩展不仅本次 --approve 生效，
		// 也能出现在 Trust 设置页并在后续会话中自动加载。
		await this.configManager.ensureTrustedDirectory(project.path);

		// 代理环境变量只能在子进程启动前注入；设置变更后通过 restart/new agent 创建新的进程快照。
		// 每个 Agent 独立启动 pi RPC，避免复用进程时 session、事件监听和配置快照串线。
		const process = new PiProcess(project.path, this.settingsStore.get());
		const runtime: AgentRuntime = { tab, process };
		this.agents.set(id, runtime);
		this.messages.set(id, []);
		this.emitState();

		const client = process.start(input.sessionPath);

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
		process.on("exit", () => {
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
			const state = await client.request({ type: "get_state" });
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
			// 加载历史消息，失败时重试一次（新进程可能需要短暂初始化时间）
			await this.loadMessages(id)
				.catch(() => new Promise((resolve) => setTimeout(resolve, 800)))
				.then(() => this.loadMessages(id))
				.catch(() => undefined);
		} catch (error) {
			tab.status = "error";
			const rawMessage = error instanceof Error ? error.message : String(error);
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
			const requestPayload: Record<string, unknown> = {
				type: "prompt",
				message: trimmed || "Describe this image.",
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
		// pi RPC 原生支持 abort，对应终端里的 Escape：停止当前 LLM/tool 流程并保留会话进程。
		await runtime.process.client
			.request({ type: "abort" }, 10_000)
			.catch((error) => {
				this.addMessage(
					agentId,
					"error",
					error instanceof Error ? error.message : String(error),
				);
			});
		runtime.tab.status = "idle";
		this.addMessage(agentId, "system", "已请求停止当前响应");
		this.emitState();
	}

	/**
	 * 手动触发上下文压缩。pi 会将历史消息摘要化以释放 context 空间，
	 * 适用于长时间对话后 context 占比过高、但不想丢失关键信息的场景。
	 */
	async compact(agentId: string, prompt?: string) {
		const runtime = this.requireRuntime(agentId);
		const trimmedPrompt = prompt?.trim();
		// /compact 可带自定义摘要提示词；空字符串保持按钮触发时的默认 pi compact 行为。
		await runtime.process.client.request(
			trimmedPrompt ? { type: "compact", prompt: trimmedPrompt } : { type: "compact" },
			120_000,
		);
		await this.loadMessages(agentId).catch(() => undefined);
		return this.getRuntimeState(agentId);
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
		 * 缓存命中率 = cacheRead / (cacheRead + cacheWrite) × 100%
		 * 使用 Anthropic 标准公式：仅统计可缓存 token 的命中比例。
		 * 和 pi CLI 计算方式一致（pi 不直接返回 hitPercent，我们自行推导）。
		 * 如果 pi RPC 直接返回了 cacheHitPercent，优先信任。
		 */
		const computedCacheHitPercent =
			cacheRead != null && cacheWrite != null && (cacheRead + cacheWrite) > 0
				? (cacheRead / (cacheRead + cacheWrite)) * 100
				: cacheRead != null && cacheRead > 0
					? 100
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
			isCompacting: state?.isCompacting,
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

	private trimHistoryMessages(rawMessages: unknown[], maxMessages = 200) {
		if (rawMessages.length <= maxMessages) return rawMessages;
		const cutoff = rawMessages.length - maxMessages;
		let start = cutoff;
		for (let index = cutoff; index >= 0; index -= 1) {
			const message = rawMessages[index] as { role?: unknown } | undefined;
			if (message?.role === "user") {
				start = index;
				break;
			}
		}
		// 历史恢复不能直接从固定条数截断：一轮会话里工具消息很多时，
		// slice(-N) 会丢掉本轮用户提问，导致右侧定位缺失且列表从 AI 消息开始。
		return rawMessages.slice(start);
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

	async reload(agentId: string) {
		// pi RPC 目前无法通过 prompt 入口正确发送斜线命令（/reload 会被当作文本），
		// 因此前端已去掉 Reload 按钮，统一走 restart。此方法保留以兼容 IPC 通道。
		await this.restart(agentId);
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

		if (typed.type === "agent_end") {
			// 即使 runtime 已被清理（如用户快速切换/停止 agent），仍需向会话写入错误提示，
			// 否则用户会看到发送后完全空白、没有任何反馈。
			if (runtime) {
				runtime.tab.status = "idle";
				// 清理流式思考状态
				this.streamingThinking.delete(agentId);
				this.activeAssistantMessageIds.delete(agentId);
				this.toolMessageIds.delete(agentId);
				this.emitThinking(agentId, "");
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
			// 同步刷新 runtimeState，将 isStreaming 重置为 false；
			// 否则前端 isAgentBusy 依赖的 isStreaming 仍为过期的 true，导致排队 flush 无法触发。
			void this.getRuntimeState(agentId)
				.then((state) =>
					this.emit(ipcChannels.agentsRuntimeState, { agentId, state }),
				)
				.catch(() => undefined);
			// 会话结束时发送系统通知，让用户知道 agent 已完成工作
			// 只在最后一条消息是 assistant 消息时通知，避免工具调用结束时也触发通知
			const messages = this.messages.get(agentId) ?? [];
			const lastMessage = messages[messages.length - 1];
			if (lastMessage?.role === "assistant" && runtime) {
				this.notifySessionEnd(runtime.tab.title);
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

		if (typed.type === "extension_error") {
			this.addMessage(
				agentId,
				"error",
				String(typed.error ?? "Extension error"),
			);
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
		const meta = {
			status,
			toolName,
			toolCallId,
			args: this.truncateForDetail(this.safeJson(args)),
			result: this.truncateForDetail(this.extractToolResultText(result) || this.safeJson(result)),
			isError,
			detailText,
			originalContent,
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

	private convertAgentMessages(
		agentId: string,
		rawMessages: unknown[],
	): ChatMessage[] {
		const historicalToolCalls = this.collectHistoricalToolCalls(rawMessages);
		const historicalOriginalContentByPath = this.collectHistoricalOriginalContentByPath(
			rawMessages,
			historicalToolCalls,
		);
		return rawMessages
			.flatMap<ChatMessage>((message, index) => {
				if (!message || typeof message !== "object") return [];
				const typed = message as any;
				if (typed.role === "user") {
					const images = this.extractImages(typed.content);
					return [
						{
							id: `${agentId}-history-${index}`,
							agentId,
							role: "user" as const,
							text:
								this.extractText(typed.content) ||
								(images.length > 0 ? "[图片]" : ""),
							timestamp: typed.timestamp ?? Date.now(),
							...(images.length > 0 ? { images } : {}),
						},
					];
				}
				if (typed.role === "assistant") {
					const thinking = this.extractThinking(typed.content);
					return [
						{
							id: `${agentId}-history-${index}`,
							agentId,
							role: "assistant" as const,
							text: this.extractText(typed.content),
							timestamp: typed.timestamp ?? Date.now(),
							...(thinking ? { thinking } : {}),
						},
					];
				}
				if (typed.role === "toolResult") {
					const toolCallId = String(typed.toolCallId ?? `history-tool-${index}`);
					const historicalCall = historicalToolCalls.get(toolCallId);
					const toolName = String(typed.toolName ?? historicalCall?.name ?? "tool");
					const isError = Boolean(typed.isError);
					const result = {
						content: typed.content,
						details: typed.details,
					};
					const filePath = this.getToolPathFromArgs(historicalCall?.args);

					// 优先使用 pi-deck-file-capture 扩展注入的原始内容
					// 该数据在工具执行时已写入 details 并持久化到 session JSONL
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
					return [
						{
							id: `${agentId}-history-${index}`,
							agentId,
							role: "tool" as const,
							text: `${isError ? "✗" : "✓"} ${toolName}`,
							timestamp: typed.timestamp ?? Date.now(),
							meta: {
								status: isError ? "error" : "done",
								toolName,
								toolCallId,
								args: this.truncateForDetail(this.safeJson(historicalCall?.args)),
								result: this.truncateForDetail(this.extractToolResultText(result) || this.safeJson(result)),
								isError,
								detailText,
								...(originalContent && /write|edit|create|patch/i.test(toolName)
									? { originalContent }
									: {}),
							},
						},
					];
				}
				return [];
			})
			.filter((message: ChatMessage) => message.text.trim());
	}

	private collectHistoricalToolCalls(rawMessages: unknown[]) {
		const calls = new Map<string, { name: string; args: unknown }>();
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
		const argsText = args ? this.truncateForDetail(this.safeJson(args)) : "";
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
		if (typeof content === "string") return content;
		if (Array.isArray(content))
			return content
				.map((item) => {
					if (typeof item === "string") return item;
					if (item && typeof item === "object") {
						const typed = item as any;
						// 跳过 thinking 和 image 类型的内容，只提取实际文本回复
						if (typed.type === "thinking" || typed.type === "image") return "";
						return String(typed.text ?? "");
					}
					return "";
				})
				.filter(Boolean)
				.join("\n");
		return "";
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
