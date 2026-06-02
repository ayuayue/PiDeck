import { app, BrowserWindow, Notification } from "electron";
import { randomUUID } from "node:crypto";
import type {
	AgentRuntimeState,
	AgentTab,
	AvailableModel,
	ChatMessage,
	CreateAgentInput,
	ImageContent,
	Project,
	SendPromptInput,
} from "../../shared/types";
import { ipcChannels } from "../../shared/ipc";
import { PiProcess } from "./PiProcess";
import type { SettingsStore } from "../settings/SettingsStore";

export class AgentManager {
	private readonly agents = new Map<string, AgentRuntime>();
	private readonly messages = new Map<string, ChatMessage[]>();

	constructor(
		private readonly getProject: (id: string) => Project | undefined,
		private readonly getWindow: () => BrowserWindow | null,
		private readonly settingsStore: SettingsStore,
	) {}

	list() {
		return [...this.agents.values()].map((runtime) => runtime.tab);
	}

	getMessages(agentId: string) {
		return this.messages.get(agentId) ?? [];
	}

	async loadMessages(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_messages",
		});
		const messages = this.convertAgentMessages(
			agentId,
			(response.data as { messages?: unknown[] } | undefined)?.messages ?? [],
		);
		this.messages.set(agentId, messages);
		this.emit(ipcChannels.agentsMessage, { agentId, messages });
		return messages;
	}

	async create(input: CreateAgentInput) {
		const project = this.getProject(input.projectId);
		if (!project) throw new Error(`Project not found: ${input.projectId}`);

		const id = randomUUID();
		const existingForSession = input.sessionPath
			? [...this.agents.values()].find(
					(runtime) => runtime.tab.sessionPath === input.sessionPath,
				)
			: undefined;
		if (existingForSession) return existingForSession.tab;

		const tab: AgentTab = {
			id,
			projectId: project.id,
			cwd: project.path,
			title: input.title || `${project.name} agent`,
			status: "starting",
			createdAt: Date.now(),
		};

		const process = new PiProcess(project.path);
		const runtime: AgentRuntime = { tab, process };
		this.agents.set(id, runtime);
		this.messages.set(id, []);
		this.emitState();

		const client = process.start(input.sessionPath);

		process.on("event", (event) => this.handlePiEvent(id, event));
		process.on("stderr", (text) =>
			this.emit(ipcChannels.agentsLog, { agentId: id, text }),
		);
		process.on("protocol-error", (line) =>
			this.emit(ipcChannels.agentsLog, {
				agentId: id,
				text: `Protocol error: ${line}`,
			}),
		);
		process.on("exit", () => {
			tab.status = "closed";
			this.emitState();
		});
		process.on("error", (error) => {
			tab.status = "error";
			this.addMessage(id, "error", error.message);
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
			await this.loadMessages(id).catch(() => undefined);
		} catch (error) {
			tab.status = "error";
			this.addMessage(
				id,
				"error",
				error instanceof Error ? error.message : String(error),
			);
		}

		this.emitState();
		return tab;
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

		// 保存用户消息（包含图片）
		this.addMessage(input.agentId, "user", trimmed || "[图片]", undefined, input.images);
		runtime.tab.status = "running";
		this.emitState();

		// streamingBehavior 只在 agent 忙碌时需要；UI 可以显式传 steer/followUp 以复用 pi 队列语义。
		// images 用于传递粘贴/拖拽的图片，pi 会将 base64 图片直接传给支持视觉的模型。
		try {
			const response = await runtime.process.client.request({
				type: "prompt",
				message: trimmed || "Describe this image.",
				...(hasImages ? { images: input.images } : {}),
				...(input.streamingBehavior
					? { streamingBehavior: input.streamingBehavior }
					: {}),
			});
			if (!response.success) {
				// pi RPC 会把不支持图片、忙碌队列参数缺失等前置错误作为 success:false 返回；
				// 必须显式显示出来，否则 UI 会停在“已发送但无响应”的状态。
				runtime.tab.status = "idle";
				this.addMessage(input.agentId, "error", response.error ?? "图片消息发送失败");
				this.emitState();
			}
		} catch (error) {
			runtime.tab.status = "idle";
			this.addMessage(
				input.agentId,
				"error",
				`图片消息发送失败：${error instanceof Error ? error.message : String(error)}`,
			);
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
				const statusIcon = exitCode === 0 ? "✓" : "✗";
				const header = `${statusIcon} ${command}`;
				const detailSections = [
					`命令：${command}`,
					`退出码：${exitCode}`,
					output ? `输出：\n${output}` : "(无输出)",
				].filter(Boolean);
				this.addMessage(agentId, "tool", header, {
					status: exitCode === 0 ? "done" : "error",
					toolName: "bash",
					args: { command },
					result: { output, exitCode },
					isError: exitCode !== 0,
					detailText: detailSections.join("\n\n"),
				});
			}
		} catch (error) {
			this.addMessage(
				agentId,
				"error",
				`命令执行失败：${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			runtime.tab.status = "idle";
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
	async compact(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		await runtime.process.client.request({ type: "compact" }, 120_000);
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
		return {
			modelName: model?.name ?? model?.id,
			provider: model?.provider,
			modelId: model?.id,
			thinkingLevel: state?.thinkingLevel,
			isStreaming: state?.isStreaming,
			isCompacting: state?.isCompacting,
			contextTokens: stats?.contextUsage?.tokens,
			contextWindow: stats?.contextUsage?.contextWindow ?? model?.contextWindow,
			contextPercent: stats?.contextUsage?.percent,
			cacheRead: tokens?.cacheRead,
			cacheWrite: tokens?.cacheWrite,
			cacheTotal: (tokens?.cacheRead ?? 0) + (tokens?.cacheWrite ?? 0),
			cost: stats?.cost,
		};
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
		const runtime = this.requireRuntime(agentId);
		// RPC 没有专门的 reload command；pi 文档说明 extension/斜线命令应通过 prompt 入口执行。
		await runtime.process.client.request(
			{ type: "prompt", message: "/reload" },
			60_000,
		);
		await this.loadMessages(agentId).catch(() => undefined);
	}

	/**
	 * 重启 agent 进程：停止当前 pi RPC 子进程，用同一个 session 重新启动。
	 * 适用场景：修改了 provider 配置、切换了 API key、更新了 pi 版本后，
	 * /reload 只重载 extension，不会重新读取配置文件，restart 才能生效。
	 */
	async restart(agentId: string): Promise<AgentTab> {
		const runtime = this.requireRuntime(agentId);
		const { projectId, sessionPath, title } = runtime.tab;

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

	async getCommands(agentId: string) {
		const runtime = this.requireRuntime(agentId);
		const response = await runtime.process.client.request({
			type: "get_commands",
		});
		return (
			(response.data as { commands?: unknown[] } | undefined)?.commands ?? []
		);
	}

	async stop(agentId: string) {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;
		runtime.process.stop();
		this.agents.delete(agentId);
		this.messages.delete(agentId);
		this.emitState();
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
		this.emit(ipcChannels.agentsEvent, { agentId, event });

		if (!event || typeof event !== "object") return;
		const typed = event as Record<string, any>;
		const runtime = this.agents.get(agentId);

		if (typed.type === "agent_start" && runtime) {
			runtime.tab.status = "running";
			this.emitState();
		}

		if (typed.type === "agent_end" && runtime) {
			runtime.tab.status = "idle";
			this.emitState();
			// 会话结束时发送系统通知，让用户知道 agent 已完成工作
			this.notifySessionEnd(runtime.tab.title);
		}

		if (
			typed.type === "message_update" &&
			typed.assistantMessageEvent?.type === "text_delta"
		) {
			this.appendAssistantDelta(
				agentId,
				String(typed.assistantMessageEvent.delta ?? ""),
			);
		}

		if (typed.type === "tool_execution_start") {
			this.addMessage(agentId, "tool", `▶ ${typed.toolName || "tool"}`, {
				status: "running",
				toolName: typed.toolName,
				args: typed.args,
			});
		}

		if (typed.type === "tool_execution_end") {
			const detailText = this.formatToolDetail(
				typed.toolName,
				typed.args,
				typed.result,
				typed.isError,
			);
			this.addMessage(
				agentId,
				"tool",
				`✓ ${typed.toolName || "tool"}${typed.isError ? " failed" : " done"}`,
				{
					status: typed.isError ? "error" : "done",
					toolName: typed.toolName,
					args: typed.args,
					result: typed.result,
					isError: typed.isError,
					detailText,
				},
			);
		}

		if (typed.type === "extension_error") {
			this.addMessage(
				agentId,
				"error",
				String(typed.error ?? "Extension error"),
			);
		}
	}

	private appendAssistantDelta(agentId: string, delta: string) {
		const list = this.messages.get(agentId) ?? [];
		const last = list[list.length - 1];

		if (last?.role === "assistant") {
			last.text += delta;
		} else {
			list.push({
				id: randomUUID(),
				agentId,
				role: "assistant",
				text: delta,
				timestamp: Date.now(),
			});
		}

		this.messages.set(agentId, list);
		this.emit(ipcChannels.agentsMessage, { agentId, messages: list });
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
		this.emit(ipcChannels.agentsMessage, { agentId, messages: list });
	}

	private convertAgentMessages(
		agentId: string,
		rawMessages: unknown[],
	): ChatMessage[] {
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
							text: this.extractText(typed.content) || (images.length > 0 ? "[图片]" : ""),
							timestamp: typed.timestamp ?? Date.now(),
							...(images.length > 0 ? { images } : {}),
						},
					];
				}
				if (typed.role === "assistant")
					return [
						{
							id: `${agentId}-history-${index}`,
							agentId,
							role: "assistant" as const,
							text: this.extractText(typed.content),
							timestamp: typed.timestamp ?? Date.now(),
						},
					];
				if (typed.role === "toolResult")
					return [
						{
							id: `${agentId}-history-${index}`,
							agentId,
							role: "tool" as const,
							text: `${typed.toolName ?? "tool"} result`,
							timestamp: typed.timestamp ?? Date.now(),
						},
					];
				return [];
			})
			.filter((message: ChatMessage) => message.text.trim());
	}

	private formatToolDetail(
		toolName: string,
		args: unknown,
		result: unknown,
		isError: boolean,
	) {
		const sections = [
			`工具：${toolName ?? "tool"}`,
			`状态：${isError ? "失败" : "完成"}`,
			args ? `参数：\n${this.safeJson(args)}` : "",
			result
				? `结果：\n${this.extractToolResultText(result) || this.safeJson(result)}`
				: "",
		].filter(Boolean);
		return sections.join("\n\n");
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

	private emitState() {
		this.emit(ipcChannels.agentsState, this.list());
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
