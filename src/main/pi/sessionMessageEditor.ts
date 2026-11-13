import type { AgentTab, ChatMessage, ImageContent } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { WslEnvironment } from "../wsl/WslPaths";
import type { PiProcess } from "./PiProcess";
import type { SessionEntryTarget, SessionFileEditor, SessionFileRef } from "./SessionFileEditor";
import type { SessionHistoryReader } from "./SessionHistoryReader";

/** 本域只读到的运行时切片（宿主 agents map 的值类型 `AgentRuntime`）。 */
type EditorRuntime = { tab: AgentTab; process: PiProcess };

/** 空闲判据只消费这三个忙碌标志（宿主 getRuntimeState 的返回切片）。 */
type RuntimeBusyState = { isStreaming?: boolean; isCompacting?: boolean; isExecutingTool?: boolean };

/**
 * 会话文件编辑域的窄接口：只列 editMessage / deleteMessage / prepareResendFromMessage / reload
 * 与它们的定位原语真正用到的读取器与回调，不新增状态。
 *
 * agents / messages / wslEnvironment 由宿主持有并按引用读取（事件、加载、装配路径都在直接读写它们）；
 * `sessionFileEditor` / `sessionHistoryReader` 同样是宿主字段，经 `getWslEnvironment` 这类**延迟读取**
 * 保证 `configureWsl` 之后再构造的文件引用语义不变。
 */
export interface SessionMessageEditorHost {
	getSessionFileEditor(): SessionFileEditor;
	getSessionHistoryReader(): SessionHistoryReader;
	readonly appLogger?: AppLogger;
	readonly agents: Map<string, EditorRuntime>;
	readonly messages: Map<string, ChatMessage[]>;
	getWslEnvironment(): WslEnvironment | null;
	toSessionHostPath(sessionPath: string, distro?: string): string;
	toSessionProtocolPath(sessionPath: string, distro?: string): string;
	requireRuntime(agentId: string): EditorRuntime;
	assertLocalRuntimeOperation(runtime: EditorRuntime, operation: string): void;
	getRuntimeState(agentId: string): Promise<RuntimeBusyState>;
	loadMessages(agentId: string): Promise<unknown>;
	scheduleMessageEmit(agentId: string, immediate?: boolean): void;
}

/**
 * 会话文件编辑域（拆分第十一刀）：卡片上的编辑 / 删除 / 重发 / 重载，以及它们共用的
 * 文件引用、活动分支 leaf、条目定位与「未落盘轮次」清理。
 *
 * 本类只做「把消息映射到 pi 会话 JSONL 的某一条」，写盘与原子事务仍在 SessionFileEditor；
 * 宿主保留 editMessage / deleteMessage / prepareResendFromMessage / reload 的同名薄包装。
 */
export class SessionMessageEditor {
	constructor(private readonly host: SessionMessageEditorHost) {}

	/** 宿主字段别名：搬出的实现保持 `this.<字段>` 原样（契约测试按此形态断言）。 */
	/* 行为测试按实例属性替换 editor / reader（manager.sessionFileEditor = ...），
	   必须每次读宿主当前值，否则替换后的夹具不生效。 */
	private get sessionFileEditor() {
		return this.host.getSessionFileEditor();
	}

	private get sessionHistoryReader() {
		return this.host.getSessionHistoryReader();
	}

	private get appLogger() {
		return this.host.appLogger;
	}

	private get agents() {
		return this.host.agents;
	}

	private get messages() {
		return this.host.messages;
	}

	/** `configureWsl` 可能晚于装配，必须每次读宿主当前值而不是构造期快照。 */
	private get wslEnvironment() {
		return this.host.getWslEnvironment();
	}

	private get toSessionHostPath() {
		return this.host.toSessionHostPath;
	}

	private get toSessionProtocolPath() {
		return this.host.toSessionProtocolPath;
	}

	private get requireRuntime() {
		return this.host.requireRuntime;
	}

	private get assertLocalRuntimeOperation() {
		return this.host.assertLocalRuntimeOperation;
	}

	private get getRuntimeState() {
		return this.host.getRuntimeState;
	}

	private get loadMessages() {
		return this.host.loadMessages;
	}

	private get scheduleMessageEmit() {
		return this.host.scheduleMessageEmit;
	}

	/** Build one physical/logical file reference for the isolated JSONL transaction. */
	/* 文件引用/空闲闸/重读是本域与写盘域（sessionFileWriter）共用的定位原语：public 供宿主转发。 */
	createSessionFileRef(runtime: EditorRuntime, sessionPath: string): SessionFileRef {
		const environment = runtime.tab.sessionEnvironment ?? (this.wslEnvironment ? "wsl" : "native");
		return {
			protocolPath: this.toSessionProtocolPath(sessionPath),
			hostPath: this.toSessionHostPath(sessionPath),
			environment,
			wslDistro: runtime.tab.wslDistro ?? (environment === "wsl" ? this.wslEnvironment?.distro : undefined),
		};
	}

	/**
	 * 定位编辑/删除/重发时用的活动分支 leaf。
	 * 有会话文件时与 loadMessages 一致走 JSONL 索引：历史会话展示的就是文件活动分支，
	 * get_entries 的 leaf 可能跟文件不一致（陌生 leaf 会让 SessionFileEditor 报
	 * 「分支不在文件里」，用户只看到泛化「会话操作失败」），
	 * 且大会话会把整棵 entry 树打成单行 JSON 冻窗。
	 * 无文件时才回退 RPC；RPC 失败则让 SessionFileEditor 用文件末条 leaf。
	 */
	private async getActiveSessionLeafId(agentId: string, runtime: EditorRuntime): Promise<string | undefined> {
		const sessionPath = runtime.tab.sessionPath;
		if (sessionPath) {
			try {
				const leafId = await this.sessionHistoryReader.getActiveLeafId(sessionPath);
				return typeof leafId === "string" && leafId ? leafId : undefined;
			} catch (error) {
				void this.appLogger?.warn("agent", "Session file leaf lookup failed", {
					agentId,
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			}
		}
		try {
			const response = await runtime.process.client.request({ type: "get_entries" }, 15_000);
			if (!response.success) return undefined;
			const leafId = (response.data as { leafId?: unknown } | undefined)?.leafId;
			return typeof leafId === "string" && leafId ? leafId : undefined;
		} catch (error) {
			void this.appLogger?.warn("agent", "Session entry leaf lookup failed", {
				agentId,
				error: error instanceof Error ? error.message : String(error),
			});
			return undefined;
		}
	}

	private createSessionEntryTarget(message: ChatMessage, activeLeafId?: string): SessionEntryTarget {
		if (message.role !== "user" && message.role !== "assistant") {
			throw new Error("SESSION_ENTRY_ROLE_INVALID");
		}
		const entryId = typeof message.meta?.entryId === "string" ? message.meta.entryId : undefined;
		return {
			entryId,
			legacyMessageId: message.id,
			legacyAgentId: message.agentId,
			role: message.role,
			text: message.text,
			activeLeafId,
		};
	}

	async requestSessionReload(runtime: EditorRuntime, file: SessionFileRef): Promise<void> {
		const response = await runtime.process.client.request(
			{
				type: "switch_session",
				sessionPath: file.protocolPath,
			},
			30_000,
		);
		if (!response.success) {
			throw new Error(response.error ?? "switch_session failed");
		}
	}

	/**
	 * File mutations are only valid while Pi is idle. The editor owns file-level
	 * serialization; this check protects the runtime protocol boundary.
	 */
	async ensureAgentIdle(agentId: string): Promise<void> {
		const runtime = this.agents.get(agentId);
		if (!runtime) return;

		if (runtime.tab.status === "running") {
			try {
				const state = await this.getRuntimeState(agentId);
				if (state.isStreaming || state.isCompacting) {
					throw new Error("BUSY_STREAMING: Agent is streaming, please wait");
				}
				if (state.isExecutingTool) {
					throw new Error("BUSY_TOOL: Agent is executing a tool, please wait");
				}
			} catch (error) {
				if (error instanceof Error && error.message.startsWith("BUSY_")) {
					throw error;
				}
				throw new Error("BUSY_GENERIC: Agent is currently busy, please try again later");
			}
		}
	}

	/**
	 * 编辑/删除/重发定位消息条目：优先运行时缓存（最近 12 轮窗口，O(1)），
	 * 缓存未命中时按 messageId 从文件索引定位 —— 使这些操作不再依赖缓存轮数
	 * （此前 40 轮缓存的一部分意义是保证操作按钮可用，12 轮窗口外也能操作）。
	 * 文件定位返回 entryId 精确锚点（SessionFileEditor.locateEntry 优先 entryId 匹配）。
	 */
	private async locateMessageTarget(agentId: string, sessionPath: string, messageId: string, activeLeafId?: string): Promise<{ target: SessionEntryTarget; resend?: { text: string; images?: ImageContent[] } }> {
		const cached = this.messages.get(agentId) ?? [];
		const message = cached.find((candidate) => candidate.id === messageId) ?? cached.find((candidate) => candidate.meta?.requestId === messageId);
		if (message) {
			return { target: this.createSessionEntryTarget(message, activeLeafId) };
		}
		const located = await this.sessionHistoryReader.readMessageByMessageId(sessionPath, messageId);
		if (!located) throw new Error("Message not found");
		void this.appLogger?.info("agent", "Message located from session file (runtime cache miss)", {
			agentId,
			messageId,
			entryId: located.entryId,
		});
		const role: "user" | "assistant" = located.role === "user" ? "user" : "assistant";
		return {
			target: {
				entryId: located.entryId,
				legacyMessageId: messageId,
				legacyAgentId: agentId,
				role,
				text: located.text,
				activeLeafId,
			},
			// 缓存未命中分支必须恒带回 draft：prepareResendFromMessage 先截断会话再返回草稿，
			// 若只在有图片时附 resend，纯文本重发会先截断历史再返回空文本（数据不可恢复）。
			resend: {
				text: located.text,
				...(located.images?.length ? { images: located.images } : {}),
			},
		};
	}

	async editMessage(agentId: string, messageId: string, newText: string) {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		// 编辑/删除/重发/重载都直接改本机会话文件（SessionFileEditor）：远端会话的会话文件不在本机。
		this.assertLocalRuntimeOperation(runtime, "editMessage");
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		const { target } = await this.locateMessageTarget(agentId, sessionPath, messageId, activeLeafId);
		await this.sessionFileEditor.editMessage({
			file,
			target,
			newText,
			reload: () => this.requestSessionReload(runtime, file),
		});
		await this.loadMessages(agentId);
		void this.appLogger?.info("agent", "Edit message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
	}

	async deleteMessage(agentId: string, messageId: string) {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		this.assertLocalRuntimeOperation(runtime, "deleteMessage");
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		const { target } = await this.locateMessageTarget(agentId, sessionPath, messageId, activeLeafId);
		try {
			await this.sessionFileEditor.deleteMessage({
				file,
				target,
				reload: () => this.requestSessionReload(runtime, file),
			});
		} catch (error) {
			// 发送后立刻中断：缓存里有气泡，JSONL 可能还没落盘。此时按未持久化轮次从内存删掉，
			// 避免把 SESSION_ENTRY_NOT_FOUND 误报成「消息未找到，可能已被删除或上下文压缩」。
			if (this.removeUnpersistedRuntimeTurn(agentId, messageId, target, error)) {
				void this.appLogger?.info("agent", "Deleted unpersisted runtime message", {
					agentId,
					messageId,
					elapsedMs: Date.now() - startTime,
				});
				return;
			}
			throw error;
		}
		await this.loadMessages(agentId);
		void this.appLogger?.info("agent", "Delete message completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
	}

	/**
	 * 发送后立刻中断再删：缓存命中、JSONL 还没这条时，按本轮从内存摘掉，不当成定位失败。
	 * 只处理「无 entryId」的未落盘气泡；已有 entryId 说明文件里该有记录，继续抛原错。
	 */
	private removeUnpersistedRuntimeTurn(agentId: string, messageId: string, target: SessionEntryTarget, error: unknown): boolean {
		if (!this.isSessionEntryMissing(error)) return false;
		if (typeof target.entryId === "string" && target.entryId.trim()) return false;
		const list = this.messages.get(agentId);
		if (!list?.length) return false;
		const index = list.findIndex((candidate) => candidate.id === messageId || candidate.meta?.requestId === messageId || (candidate.role === target.role && candidate.text === target.text));
		if (index < 0) return false;
		const next = list.slice(0, index);
		this.messages.set(agentId, next);
		this.scheduleMessageEmit(agentId, true);
		return true;
	}

	private isSessionEntryMissing(error: unknown): boolean {
		// 按 code / 文案识别，不依赖 instanceof：部分测试夹具只注入 editor 方法，没有真实 Error 子类。
		const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
		if (code === "SESSION_ENTRY_NOT_FOUND") return true;
		const message = error instanceof Error ? error.message : String(error);
		const lower = message.toLowerCase();
		return lower.includes("message not found") || lower.includes("not found on the active session branch");
	}

	async prepareResendFromMessage(agentId: string, messageId: string): Promise<{ text: string; images?: ImageContent[] }> {
		const startTime = Date.now();
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		this.assertLocalRuntimeOperation(runtime, "prepareResendFromMessage");
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");
		// 缓存命中时先校验角色（重发仅限用户消息）；缓存未命中时由 SessionFileEditor 的 inputRole 校验兜底
		const cached = this.messages.get(agentId)?.find((candidate) => candidate.id === messageId);
		if (cached && cached.role !== "user") throw new Error("Only user messages can be resent");

		const file = this.createSessionFileRef(runtime, sessionPath);
		const activeLeafId = await this.getActiveSessionLeafId(agentId, runtime);
		const { target, resend } = await this.locateMessageTarget(agentId, sessionPath, messageId, activeLeafId);
		await this.sessionFileEditor.truncateForResend({
			file,
			target,
			reload: () => this.requestSessionReload(runtime, file),
		});
		await this.loadMessages(agentId);
		void this.appLogger?.info("agent", "Prepare resend completed", {
			agentId,
			messageId,
			elapsedMs: Date.now() - startTime,
		});
		return (
			resend ?? {
				text: cached?.text ?? "",
				...(cached?.images?.length ? { images: cached.images } : {}),
			}
		);
	}

	async reload(agentId: string) {
		await this.ensureAgentIdle(agentId);
		const runtime = this.requireRuntime(agentId);
		this.assertLocalRuntimeOperation(runtime, "reload");
		const sessionPath = runtime.tab.sessionPath;
		if (!sessionPath) throw new Error("Session not persisted");
		const file = this.createSessionFileRef(runtime, sessionPath);
		await this.sessionFileEditor.reload({
			file,
			reload: () => this.requestSessionReload(runtime, file),
		});
		await this.loadMessages(agentId);
	}
}
