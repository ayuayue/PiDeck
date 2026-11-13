import type { AgentTab, ImageContent, SessionEnvironment, SessionMessageImageTarget } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { WslEnvironment } from "../wsl/WslPaths";
import type { PiProcess } from "./PiProcess";
import type { AppendMessageEntry, SessionEntryTarget, SessionFileEditor, SessionFileRef } from "./SessionFileEditor";
import type { SessionHistoryReader } from "./SessionHistoryReader";
import type { StoppedMessageIdentityCache } from "./stoppedMessageIdentity";

/** 本域只读到的运行时切片（宿主 agents map 的值类型 `AgentRuntime`）。 */
type WriterRuntime = { tab: AgentTab; process: PiProcess };

/**
 * 会话文件写盘域的窄接口：只列「没有活跃 runtime / 追加本地条目」两条路径用到的读取器与回调，
 * 不新增状态。
 *
 * `sessionFileEditor` / `sessionHistoryReader` / `stoppedMessageIdentities` / `agents` 由宿主持有并按引用
 * 读取；`createSessionFileRef` / `requestSessionReload` / `ensureAgentIdle` 是会话文件编辑域的
 * 定位原语（sessionMessageEditor），宿主按引用转发，避免第二套文件引用/空闲闸实现。
 */
export interface SessionFileWriterHost {
	getSessionFileEditor(): SessionFileEditor;
	getSessionHistoryReader(): SessionHistoryReader;
	readonly stoppedMessageIdentities: StoppedMessageIdentityCache;
	readonly appLogger?: AppLogger;
	readonly agents: Map<string, WriterRuntime>;
	getWslEnvironment(): WslEnvironment | null;
	toSessionHostPath(sessionPath: string, distro?: string): string;
	toSessionProtocolPath(sessionPath: string, distro?: string): string;
	createSessionFileRef(runtime: WriterRuntime, sessionPath: string): SessionFileRef;
	requestSessionReload(runtime: WriterRuntime, file: SessionFileRef): Promise<void>;
	ensureAgentIdle(agentId: string): Promise<void>;
	loadMessages(agentId: string): Promise<unknown>;
}

/**
 * 会话文件写盘域（拆分第十一刀）：两条**不经 pi RPC** 的 JSONL 写路径。
 *
 * - `mutatePersistedSessionMessage`：catalog 级编辑 / 删除 / 重发截断 / 去图（catalog 已要求先停 agent）；
 * - `appendLocalMessagesToSession`：生图等 PiDeck 本地产物补写进会话文件（有 runtime 时 switch_session 重读）。
 *
 * 原子写、分支定位与条目匹配仍在 SessionFileEditor / SessionHistoryReader；
 * 宿主保留同名薄包装（公开签名不变）。
 */
export class SessionFileWriter {
	constructor(private readonly host: SessionFileWriterHost) {}

	/** 宿主字段别名：搬出的实现保持 `this.<字段>` 原样（契约测试按此形态断言）。 */
	/* 行为测试按实例属性替换 editor / reader（manager.sessionFileEditor = ...），
	   必须每次读宿主当前值，否则替换后的夹具不生效。 */
	private get sessionFileEditor() {
		return this.host.getSessionFileEditor();
	}

	private get sessionHistoryReader() {
		return this.host.getSessionHistoryReader();
	}

	private get stoppedMessageIdentities() {
		return this.host.stoppedMessageIdentities;
	}

	private get appLogger() {
		return this.host.appLogger;
	}

	private get agents() {
		return this.host.agents;
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

	private get createSessionFileRef() {
		return this.host.createSessionFileRef;
	}

	private get requestSessionReload() {
		return this.host.requestSessionReload;
	}

	private get ensureAgentIdle() {
		return this.host.ensureAgentIdle;
	}

	private get loadMessages() {
		return this.host.loadMessages;
	}

	/**
	 * 追加 PiDeck 本地产物的消息条目到 pi 会话文件（生图等不走 pi RPC 的记录落盘）。
	 * - 会话有活跃 runtime 时：写文件后 switch_session 让 pi 重读，内存与文件保持一致；
	 * - 无 runtime（生图不依赖 Agent）时：直接落盘，下次激活由 pi 读文件自然吸收。
	 * reload 失败不阻断落盘（文件已原子写成功），仅记日志——pi 重读失败不影响磁盘记录。
	 */
	/**
	 * 无 runtime 时改 pi 会话 JSONL（编辑 / 删除 / 重发截断）。
	 * 有运行中 Agent 时禁止走这里：内存树和文件会分叉，必须先停再改。
	 * reload 空操作，下次发送激活时由 pi 读文件吸收。
	 */
	async mutatePersistedSessionMessage(
		sessionPath: string,
		messageId: string,
		operation: "edit" | "delete" | "resend" | "remove-image",
		options?: {
			newText?: string;
			environment?: SessionEnvironment;
			wslDistro?: string;
			/** 渲染层消息携带的文件条目 id（meta.entryId）：live randomUUID 无法在文件里定位，
			 * 必须用该锚点（见 SessionHistoryReader.readMessageByMessageId）。 */
			entryId?: string;
			imageTarget?: SessionMessageImageTarget;
		},
	): Promise<{ text: string; images?: ImageContent[] } | undefined> {
		const hostPath = this.toSessionHostPath(sessionPath);
		const live = [...this.agents.values()].find((candidate) => candidate.tab.sessionPath && this.toSessionHostPath(candidate.tab.sessionPath) === hostPath);
		// 边界防御：协调器已要求先停；这里再拦一次，避免漏调 stop 时静默写文件。
		if (live && live.tab.status !== "closed" && live.tab.status !== "error") {
			throw new Error("BUSY_GENERIC: Stop the running agent before mutating the session file");
		}
		const environment = options?.environment === "wsl" || this.wslEnvironment ? ("wsl" as const) : ("native" as const);
		const file: SessionFileRef = {
			protocolPath: this.toSessionProtocolPath(sessionPath),
			hostPath,
			environment,
			wslDistro: options?.wslDistro ?? (environment === "wsl" ? this.wslEnvironment?.distro : undefined),
		};
		const activeLeafId = await this.sessionHistoryReader.getActiveLeafId(sessionPath).catch(() => undefined);
		const located = await this.sessionHistoryReader.readMessageByMessageId(sessionPath, messageId, options?.entryId, this.stoppedMessageIdentities.get(hostPath, messageId));
		if (!located) {
			// 未落盘删除兜底：发送中/刚结束即中断，再删该轮消息时 JSONL 还没有这条记录——
			// 渲染层流程是先停 agent 再走 catalog 删除，stop 已清空内存消息缓存，
			// deleteMessage 的 removeUnpersistedRuntimeTurn（内存定位）在此路径不可用。
			// 删除的目标就是让消息从会话消失：文件里本来就没有，无需写盘，
			// 返回成功让渲染层重载时间线，未落盘气泡自然消失（与删后刷新结果一致）。
			// 仅 delete 放宽：edit/resend 依赖文件正文，找不到条目则无法执行，必须保留报错。
			if (operation === "delete") {
				void this.appLogger?.info("agent", "Delete no-op: message not in session file (unpersisted turn)", {
					sessionPath,
					messageId,
				});
				return undefined;
			}
			throw new Error("Message not found");
		}
		const role: "user" | "assistant" = located.role === "user" ? "user" : "assistant";
		if ((operation === "resend" || operation === "remove-image") && role !== "user") {
			throw new Error(operation === "resend" ? "Only user messages can be resent" : "Only user message images can be removed");
		}
		const target: SessionEntryTarget = {
			entryId: located.entryId,
			legacyMessageId: messageId,
			legacyAgentId: "_viewer",
			role,
			text: located.text,
			activeLeafId,
		};
		const reload = async () => undefined;
		if (operation === "edit") {
			await this.sessionFileEditor.editMessage({
				file,
				target,
				newText: options?.newText ?? "",
				reload,
			});
		} else if (operation === "delete") {
			await this.sessionFileEditor.deleteMessage({ file, target, reload });
		} else if (operation === "remove-image") {
			if (!options?.imageTarget) throw new Error("Image target is required");
			await this.sessionFileEditor.removeImage({ file, target, reload, imageTarget: options.imageTarget });
		} else {
			await this.sessionFileEditor.truncateForResend({ file, target, reload });
		}
		void this.appLogger?.info("agent", "Persisted session message mutated", {
			sessionPath,
			messageId,
			operation,
		});
		return operation === "resend"
			? {
					text: located.text,
					...(located.images?.length ? { images: located.images } : {}),
				}
			: undefined;
	}

	async appendLocalMessagesToSession(sessionPath: string, entries: import("./SessionFileEditor").AppendMessageEntry[]): Promise<void> {
		if (entries.length === 0) return;
		const hostPath = this.toSessionHostPath(sessionPath);
		const runtime = [...this.agents.values()].find((candidate) => candidate.tab.sessionPath && this.toSessionHostPath(candidate.tab.sessionPath) === hostPath);
		try {
			if (runtime) {
				const agentId = runtime.tab.id;
				await this.ensureAgentIdle(agentId);
				const file = this.createSessionFileRef(runtime, sessionPath);
				await this.sessionFileEditor.appendMessages({
					file,
					reload: () => this.requestSessionReload(runtime, file),
					entries,
				});
				await this.loadMessages(agentId);
			} else {
				// 无 runtime：按环境默认值构造文件引用（WSL 走 Linux 协议路径 + Windows 宿主路径）。
				const file: SessionFileRef = {
					protocolPath: this.toSessionProtocolPath(sessionPath),
					hostPath,
					environment: this.wslEnvironment ? "wsl" : "native",
					wslDistro: this.wslEnvironment?.distro,
				};
				await this.sessionFileEditor.appendMessages({
					file,
					reload: async () => undefined,
					entries,
				});
			}
			void this.appLogger?.info("agent", "Local messages appended to session", {
				sessionPath,
				entryCount: entries.length,
				hadRuntime: Boolean(runtime),
			});
		} catch (error) {
			void this.appLogger?.warn("agent", "Local messages append failed", {
				sessionPath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	}
}
