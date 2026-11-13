import type { ImageContent, SessionCommandErrorCode, SessionCommandResult, SessionMessageImageTarget, SessionRuntimeTarget } from "../../../shared/types";
import type { SshSessionLocator } from "../../../shared/projectLocation";
import { REMOTE_SESSION_HISTORY_WRITER_CODES, remoteSessionHistoryWriteFailure } from "../../remote/RemoteSessionHistoryWriter";
import type { StoppedMessageIdentityCache } from "../../pi/stoppedMessageIdentity";
import { sessionFileSizeMb } from "../sessionFileSizeCopy";
import { SessionRuntimeCommandError } from "./sessionRuntimeCommandError";
import type { RemoteSessionMessageMutationResolver, SessionAgentGateway, SessionCatalogGateway, SessionRuntimeLogger } from "./sessionRuntimeGateways";

/**
 * catalog 级消息变更（磁盘 JSONL / 远端 JSONL）与它的错误出口。
 *
 * 为什么这两件事在同一个文件：`commandFailure` 是这些写操作的唯一结算点，而远端写面只回稳定码
 * （`REMOTE_SESSION_HISTORY_WRITER_CODES`），映射必须与本机的文案分类共用同一张表；另外
 * `tests/sessionRuntimeCoordinator.test.mjs` 用一条正则把 `commandFailure` 里 `needsRestart: true,`
 * 与紧随其后的 `params: { model: this.extractModelFromNotFound(...) }` 钉成同一函数内的相邻两段——
 * 两者留在同一个函数、同一个文件里，断言边界就是域边界。
 *
 * 宿主（`SessionRuntimeCoordinator`）保留同名薄包装，公开方法签名与调用点都不动；本文件只对宿主做
 * **类型**依赖，运行时无环。
 */

// 与宿主 / `sessionRuntimePreferences` 同形的错误消息归一，保持分类逻辑逐字搬运。
function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * 协作对象对宿主的需求面。成员名与宿主同名字段/方法一致，搬走的正文因此保持 `this.x` 逐字不变。
 */
export type RemoteMessageMutationHost = {
	catalog: Pick<SessionCatalogGateway, "get" | "getLocator" | "getLocalFilePath">;
	agents: Pick<SessionAgentGateway, "backend" | "mutatePersistedSessionMessage">;
	logger: SessionRuntimeLogger | undefined;
	resolveRemoteMessageMutation: RemoteSessionMessageMutationResolver | undefined;
	remoteStoppedMessageIdentities: StoppedMessageIdentityCache;
	canonicalSessionId: (sessionId: string) => string;
	getTarget: (sessionId: string) => SessionRuntimeTarget | undefined;
	isActivating: (sessionId: string) => boolean;
};

export class RemoteMessageMutation {
	constructor(
		private readonly catalog: RemoteMessageMutationHost["catalog"],
		private readonly agents: RemoteMessageMutationHost["agents"],
		private readonly logger: RemoteMessageMutationHost["logger"],
		private readonly resolveRemoteMessageMutation: RemoteMessageMutationHost["resolveRemoteMessageMutation"],
		private readonly remoteStoppedMessageIdentities: RemoteMessageMutationHost["remoteStoppedMessageIdentities"],
		private readonly canonicalSessionId: RemoteMessageMutationHost["canonicalSessionId"],
		private readonly getTarget: RemoteMessageMutationHost["getTarget"],
		private readonly isActivating: RemoteMessageMutationHost["isActivating"],
	) {}

	/**
	 * pi 历史会话文件改写：DSH / 未落盘 / 仍在运行一律拒绝。
	 * 运行中改文件再 switch_session 会和用户「先停再改、下次发送才激活」的产品规则冲突。
	 */
	async mutateCatalogMessage(
		requestedSessionId: string,
		messageId: string,
		operation: "edit" | "delete" | "resend" | "remove-image",
		newText?: string,
		/** 渲染层消息的文件条目 id（meta.entryId），见 readMessageByMessageId 的锚点语义。 */
		entryId?: string,
		imageTarget?: SessionMessageImageTarget,
	): Promise<SessionCommandResult<{ text: string; images?: ImageContent[] } | undefined>> {
		try {
			// #354：历史（已被身份归并的）会话 ID 先归一化——requireStoppedForFileMutation 是
			// 「pi 活着禁改会话文件」的硬闸，拿旧 ID 查绑定会漏过闸门把文件写坏。
			const sessionId = this.canonicalSessionId(requestedSessionId);
			const entry = this.catalog.get(sessionId);
			if (!entry) {
				throw new SessionRuntimeCommandError("SESSION_NOT_FOUND", `Session not found: ${sessionId}`);
			}
			if (entry.backend === "dsh" || entry.backend === "imagegen" || entry.backend === "acp") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${entry.backend}" does not support persisted session message mutation`);
			}
			// ssh 记录：改写的是**远端** JSONL（P4.5c）。这条分支必须插在 `getLocalFilePath` **之前** ——
			// 那个入口对 ssh locator 抛稳定码，放在它后面就是死代码（P4.5b 归档分支记过同一条账）。
			const locator = this.catalog.getLocator(sessionId);
			if (locator?.kind === "ssh") {
				// remove-image 是 dev 新增的**本机会话文件**操作（SessionFileEditor 支持），远端写面只冻结了
				// edit/delete/resend。这里显式 fail-closed：不把未实现的写操作透传给远端写面，也不偷偷降级成 delete。
				if (operation === "remove-image") throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", REMOTE_SESSION_HISTORY_WRITER_CODES.operationInvalid);
				const value = await this.mutateRemoteCatalogMessage(sessionId, locator, messageId, operation, newText, entryId);
				// 只记身份与操作：远端路径、消息正文、命令行都不进日志（读写/归档同一条脱敏纪律）。
				void this.logger?.info("session-runtime", "Remote catalog session message mutated", { sessionId, hostId: locator.hostId, operation });
				return { ok: true, value };
			}
			const sessionFilePath = this.catalog.getLocalFilePath(sessionId);
			if (!sessionFilePath) {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", "Session not persisted");
			}
			this.requireStoppedForFileMutation(sessionId);
			// 必须对象调用：抽方法会丢掉 this，CompositeAgentGateway 里 this.resolveBackend 变 undefined。
			// mutate 合法返回值可以是 undefined（edit/delete），所以不能用返回值判断方法是否存在。
			if (typeof this.agents.mutatePersistedSessionMessage !== "function") {
				throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", `backend "${this.agents.backend}" does not support persisted session message mutation`);
			}
			const value = await this.agents.mutatePersistedSessionMessage(sessionFilePath, messageId, operation, {
				newText,
				environment: entry.environment,
				wslDistro: entry.wslDistro,
				entryId,
				imageTarget,
			});
			// 写文件期间若被重新激活：磁盘已改且后续激活的 pi 读的就是改后文件（编辑
			// 实际已生效），此时报 BUSY 会让用户重试造成二次编辑。改为记录竞态日志并
			// 按成功返回（文件状态是唯一事实源）。
			try {
				this.requireStoppedForFileMutation(sessionId);
			} catch (busyError) {
				void this.logger?.warn("session-runtime", "Session file mutated while runtime re-activated; mutation already persisted", {
					sessionId,
					messageId,
					operation,
				});
			}
			void this.logger?.info("session-runtime", "Catalog session message mutated", {
				sessionId,
				messageId,
				operation,
			});
			return { ok: true, value };
		} catch (error) {
			return this.commandFailure(error);
		}
	}

	private requireStoppedForFileMutation(sessionId: string): void {
		if (this.getTarget(sessionId) || this.isActivating(sessionId)) {
			throw new SessionRuntimeCommandError("SESSION_RUNTIME_BUSY", "Stop the running agent before mutating the session file");
		}
	}

	/** host + opaque identity + path 同时绑定，换主机/路径之后不能复用旧 runtime 摘要。 */
	remoteMessageIdentityKey(locator: SshSessionLocator): string {
		return JSON.stringify([locator.hostId, locator.remoteSessionId, locator.remotePath]);
	}

	/**
	 * ssh 记录的 catalog 级改写：整条链走远端文件写面，本机一个路径解析都不做。
	 *
	 * 冲突规则（docs/archive/remote/remote-write-plan.md §3，硬性）：会话有运行实例 / 正在激活 ⇒ **先判后发**，一个远端
	 * 命令都不发，抛与本机链路同一个拒绝（`SESSION_RUNTIME_BUSY`，渲染层已有「先停止 Agent」文案）；
	 * 装配没提供写端口（实验开关关闭）时给稳定码，绝不落回本机路径分支。不确定是否在写 ⇒ fail-closed：
	 * 宁可拒绝，也不排队等待或与远端 pi 并发写。
	 */
	private async mutateRemoteCatalogMessage(sessionId: string, locator: SshSessionLocator, messageId: string, operation: "edit" | "delete" | "resend", newText?: string, entryId?: string): Promise<{ text: string; images?: ImageContent[] } | undefined> {
		this.requireStoppedForFileMutation(sessionId);
		const port = this.resolveRemoteMessageMutation?.();
		if (!port) throw new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", REMOTE_SESSION_HISTORY_WRITER_CODES.unavailable);
		let value: { text: string; images?: ImageContent[] } | undefined;
		try {
			value = await port.mutate({
				hostId: locator.hostId,
				locator,
				operation,
				messageId,
				stoppedIdentity: this.remoteStoppedMessageIdentities.get(this.remoteMessageIdentityKey(locator), messageId),
				...(newText === undefined ? {} : { newText }),
				...(entryId === undefined ? {} : { entryId }),
			});
		} catch (error) {
			throw this.remoteMessageMutationCommandError(error);
		}
		// 写期间若被重新激活：远端已改但内存是旧树——拒绝让调用方感知竞态（与本机分支同一步）。
		this.requireStoppedForFileMutation(sessionId);
		return value;
	}

	/**
	 * 远端写面的稳定码 → 会话命令错误码。
	 *
	 * 为什么按码显式映射，而不是沿用 `commandFailure` 的文案匹配：远端写面本来就只回稳定码（路径、
	 * 命令行、stderr 都不外传），匹配自由文本既不稳也没必要。体积参数必须跟着错误一起走 —— 远端的
	 * 整读上界（默认 256 KiB）远小于本机 32MB，用本机兜底数字渲染文案就是骗人。
	 */
	private remoteMessageMutationCommandError(error: unknown): SessionRuntimeCommandError {
		const failure = remoteSessionHistoryWriteFailure(error);
		if (failure.code === REMOTE_SESSION_HISTORY_WRITER_CODES.fileTooLarge) return new SessionRuntimeCommandError("SESSION_FILE_TOO_LARGE", failure.code, failure.details);
		if (failure.code === REMOTE_SESSION_HISTORY_WRITER_CODES.messageNotFound) return new SessionRuntimeCommandError("MESSAGE_NOT_FOUND", failure.code);
		// F5：提交 rename 已发生但回执丢失（REMOTE_SESSION_HISTORY_WRITER_RESULT_UNCONFIRMED）也落在这里，
		// 但 debugDetails 保留独立稳定码——渲染层必须据此显示「结果未确认，重新加载核对，不自动重试」，
		// 不能显示通用的「会话操作失败，请重试」（与远端 Git / 远端文本保存同一条产品口径）。
		// 语义方向：本机不知道远端是否已经替换，宁可让用户核对，也不谎报成功或提示重试。
		return new SessionRuntimeCommandError("SESSION_COMMAND_FAILED", failure.code);
	}

	commandFailure<T>(error: unknown): SessionCommandResult<T> {
		if (error instanceof SessionRuntimeCommandError) {
			return {
				ok: false,
				error: {
					code: error.code,
					debugDetails: error.message,
					// 远端整读上界自带体积参数（见 remoteMessageMutationCommandError）：文案里的两个占位符
					// 必须用真实上界，而不是本机 32MB 的兜底数字。
					...(error.code === "SESSION_FILE_TOO_LARGE" ? { params: this.sessionFileSizeParams(error) } : {}),
				},
			};
		}
		// 模型在本地 models.json 存在但运行中 Agent 未加载：标记 needsRestart，
		// 渲染层据此弹出「重启 Agent 生效」引导（而非误报会话不存在）。
		if (error instanceof Error && (error as Error & { needsRestart?: boolean }).needsRestart) {
			return {
				ok: false,
				error: {
					code: "SESSION_MODEL_NOT_FOUND",
					debugDetails: error.message,
					needsRestart: true,
					// 提取 "Model not found: xxx" 中的模型标识，让 i18n 文案 {model} 有值
					params: { model: this.extractModelFromNotFound(error.message) ?? error.message },
				},
			};
		}
		const message = errorMessage(error);
		const lower = message.toLowerCase();
		const model = this.extractModelFromNotFound(message);
		const editorCode = this.sessionFileEditorErrorCode(error);
		const code: SessionCommandErrorCode =
			// 会话文件超编辑上限：大文件已改走流式路径，这条只剩「流式分流不可用」的兜底。
			// 仍单独成一类——一旦发生，用户看到的就是「这个会话现在改不了」，而不是泛化的
			// 「会话操作失败，请重试」（文案里的两个体积占位符需要真实值）。
			editorCode === "SESSION_FILE_TOO_LARGE"
				? "SESSION_FILE_TOO_LARGE"
				: // SessionFileEditor 的 SESSION_ENTRY_NOT_FOUND 包括「不在活动分支」/
					// 「leaf 不在文件里」/「已删除」，文案并不都带 "message not found"。
					// 按 code 识别，避免历史会话删消息落到 SESSION_COMMAND_FAILED
					//（用户只看到「会话操作失败，请重试」且主进程没日志）。
					editorCode === "SESSION_ENTRY_NOT_FOUND" || lower.includes("message not found") || lower.includes("not found on the active session branch") || lower.includes("not part of the active session branch") || lower.includes("already been deleted") || lower.includes("no longer present in the file")
					? "MESSAGE_NOT_FOUND"
					: // Agent 运行实例已不存在（stop/restart 后立即操作、崩溃清理等）：是
						// 「没有可用的运行实例」而非「会话不存在」——泛化 not found 会误报成
						// 「会话已不存在，请刷新会话列表后重试」，用户刷新后依然复现（2026-08
						// 用户反馈：删除消息报会话已不存在）。
						lower.includes("agent not found")
						? "SESSION_RUNTIME_UNAVAILABLE"
						: // set_model 的 "Model not found: provider/model"（本地 models.json 也没有该模型，
							// 如手误/列表错位产生的假模型）是「模型不存在」而非「会话不存在」——
							// 若落到泛化 "not found" 分支会误报成「会话已不存在」误导排查。
							lower.includes("model not found")
							? "SESSION_MODEL_NOT_FOUND"
							: lower.includes("not found")
								? "SESSION_NOT_FOUND"
								: lower.includes("busy") || lower.includes("in progress") || lower.includes("stream")
									? "SESSION_RUNTIME_BUSY"
									: lower.includes("binding") || lower.includes("generation") || lower.includes("changed")
										? "SESSION_RUNTIME_CHANGED"
										: lower.includes("runtime") && lower.includes("available")
											? "SESSION_RUNTIME_UNAVAILABLE"
											: "SESSION_COMMAND_FAILED";
		return {
			ok: false,
			error: {
				code,
				debugDetails: message,
				// 模型不存在带 model、文件过大带体积：文案里的 {model} / {sizeMb} 占位
				...(code === "SESSION_MODEL_NOT_FOUND" && model ? { params: { model } } : {}),
				...(code === "SESSION_FILE_TOO_LARGE" ? { params: this.sessionFileSizeParams(error) } : {}),
			},
		};
	}

	/**
	 * 从 SessionFileEditorError.details 取「文件过大」的展示参数。
	 *
	 * 两个占位符缺一不可：文案里写的是「{sizeMb}MB，上限 {limitMb}MB」——
	 * 只给 size 会让 {limitMb} 原样显示成 `{limitMb}`。编辑器已带 details，
	 * 这里只做取值与取整；取不到时给保守默认，至少不把原始占位符漏给用户。
	 */
	private sessionFileSizeParams(error: unknown): Record<string, number> {
		const details = (error as { details?: Record<string, unknown> } | null)?.details;
		const size = typeof details?.size === "number" ? details.size : undefined;
		const limit = typeof details?.limit === "number" ? details.limit : undefined;
		const { sizeMb, limitMb } = sessionFileSizeMb({ size, limit });
		return { sizeMb, limitMb };
	}

	/**
	 * 从 "Model not found: <provider/model>" 类错误消息提取模型标识。
	 * 支持 "Model not found: xxx" / "model not found:xxx" 两种分隔；
	 * 未匹配返回 undefined（由调用方决定兜底）。
	 */
	private extractModelFromNotFound(message: string): string | undefined {
		const match = /model not found\s*:?\s*(.+)$/i.exec(message);
		return match?.[1]?.trim() || undefined;
	}

	/** SessionFileEditorError.code；非编辑器错误或缺字段返回 undefined。 */
	private sessionFileEditorErrorCode(error: unknown): string | undefined {
		if (!error || typeof error !== "object" || !("code" in error)) return undefined;
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" && code.startsWith("SESSION_") ? code : undefined;
	}
}
