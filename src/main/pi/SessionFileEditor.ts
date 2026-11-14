import { randomUUID } from "node:crypto";
import type { SessionMessageImageTarget } from "../../shared/types/session";
import { basename, dirname, join } from "node:path";
import { getAppLogger } from "../logging/sharedLogger";
import { ReloadAttemptFailure, SessionFileEditorError, type SessionFileEditorErrorCode } from "./sessionFile/sessionFileEditorError";
import { descendantEntryIds, descendantsFromParentMap, legacyEntryId, locateEntry, removableImageIndex, replaceTextInContent, type LocatedEntry, type SessionEntryTarget, tombstone } from "./sessionFile/sessionFileEntryTargets";
import { currentLeafId, entryIdOf, ensureTrailingEol, inputRole, messageOf, parentIdOf, parseDocument, replaceLine, serializeDocument, textOf, type JsonlDocument, type JsonlEntry } from "./sessionFile/sessionFileJsonl";
import { atomicReplaceFile, createSessionBackup, defaultFs, normalizePhysicalPath, pruneSessionBackups, type SessionFileEditorFs, type SessionFileEditorLogger, type SessionFileStorageDeps } from "./sessionFile/sessionFileStorage";
import { SessionFileStreamError, copySessionFile, copySessionFileToTemp, commitSessionTempFile, hashSessionFile, iterateSessionLines, readSessionLineAt, rewriteSessionFile, scanSessionFile, type SessionFileScan, type SessionFileStreamEntry, type SessionStreamRewritePlan } from "./sessionFileStream";

export type SessionFileEnvironment = "native" | "wsl";

export type SessionFileRef = {
	protocolPath: string;
	hostPath: string;
	environment: SessionFileEnvironment;
	wslDistro?: string;
};

// entry 目标契约随定位域搬到 sessionFile/sessionFileEntryTargets.ts；此处原样 re-export。
export type { SessionEntryTarget };

export type SessionMutationResult = {
	targetEntryId: string;
	changedEntryIds: string[];
	backupPath: string;
};

/**
 * 追加型消息条目（生图等 PiDeck 本地产物落盘用）：按 pi jsonl message 格式写入。
 * content 块格式与 pi 一致（text / image{source:{type:"base64",media_type,data}}）。
 */
export type AppendMessageEntry = {
	role: "user" | "assistant";
	content: Array<Record<string, unknown>>;
	/** 可选附加 message 字段（如 api/provider/model/stopReason），原样并入。 */
	extra?: Record<string, unknown>;
};

/** appendMessages 的入参：文件引用 + 追加条目 + reload 回调（无 target 定位）。 */
export type AppendMessagesInput = {
	file: SessionFileRef;
	reload: () => Promise<void>;
	entries: AppendMessageEntry[];
};

/**
 * 编辑类操作可安全整读的会话文件上限（字节，默认 32MB）。
 *
 * 超过此值的会话走流式路径（sessionFileStream.ts）：扫描只留索引、改写按行复制，
 * 内存与文件体积无关；小文件仍走整读路径，行为完全不变。
 * 与 SessionScanner.MAX_IN_MEMORY_SESSION_BYTES 同口径：正常会话几 MB 以内。
 */
const MAX_IN_MEMORY_SESSION_BYTES = 32 * 1024 * 1024;

// 错误码联合类型与错误类在 sessionFile/sessionFileEditorError.ts；此处原样 re-export，公开契约与 import 路径不变。
export { SessionFileEditorError, type SessionFileEditorErrorCode };

// fs 端口与 logger 契约随落盘层搬到 sessionFile/sessionFileStorage.ts；此处原样 re-export。
export type { SessionFileEditorFs, SessionFileEditorLogger };

export type SessionFileEditorOptions = {
	fs?: Partial<SessionFileEditorFs>;
	now?: () => number;
	randomUUID?: () => string;
	sleep?: (milliseconds: number) => Promise<void>;
	logger?: SessionFileEditorLogger;
	maxBackups?: number;
	/** 整读路径的体积上限（字节）：超过时改走流式路径。测试用小值触发流式分支。 */
	maxInMemoryBytes?: number;
};

type MutationKind = "edit" | "delete" | "resend" | "remove-image";

type MutationInput = {
	file: SessionFileRef;
	target: SessionEntryTarget;
	reload: () => Promise<void>;
};

const sharedFileLocks = new Map<string, Promise<void>>();

export class SessionFileEditor {
	private readonly fs: SessionFileEditorFs;
	private readonly now: () => number;
	private readonly createUuid: () => string;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly logger?: SessionFileEditorLogger;
	private readonly maxBackups: number;
	private readonly maxInMemoryBytes: number;
	/** 落盘层的依赖切片（与下面的私有字段同源，只给 sessionFileStorage 用）。 */
	private readonly storage: SessionFileStorageDeps;

	constructor(options: SessionFileEditorOptions = {}) {
		this.fs = { ...defaultFs, ...options.fs };
		this.now = options.now ?? Date.now;
		this.createUuid = options.randomUUID ?? randomUUID;
		this.sleep =
			options.sleep ??
			((milliseconds) =>
				new Promise((resolve) => {
					setTimeout(resolve, milliseconds);
				}));
		this.logger = options.logger;
		this.maxBackups = Math.max(1, options.maxBackups ?? 3);
		this.maxInMemoryBytes = Math.max(1, options.maxInMemoryBytes ?? MAX_IN_MEMORY_SESSION_BYTES);
		this.storage = { fs: this.fs, logger: this.logger, now: this.now, createUuid: this.createUuid, sleep: this.sleep, maxBackups: this.maxBackups };
	}

	editMessage(input: MutationInput & { newText: string }): Promise<SessionMutationResult> {
		return this.mutate("edit", input, input.newText);
	}

	/** 只删除 user 消息的一张可见图，保留原始 content 其它块及后继分支。 */
	removeImage(input: MutationInput & { imageTarget: SessionMessageImageTarget }): Promise<SessionMutationResult> {
		return this.mutate("remove-image", input, undefined, input.imageTarget);
	}

	deleteMessage(input: MutationInput): Promise<SessionMutationResult> {
		return this.mutate("delete", input);
	}

	truncateForResend(input: MutationInput): Promise<SessionMutationResult> {
		return this.mutate("resend", input);
	}

	/**
	 * 追加消息条目到会话末尾（生图等 PiDeck 本地产物落盘，不走 pi RPC）。
	 * 复用 mutate 的事务骨架：文件锁 / 备份 / 原子写 / reload marker 全保留，
	 * 只把「定位既有条目」换成「以当前 leaf 为 parent 追加新行」。
	 */
	appendMessages(input: AppendMessagesInput): Promise<SessionMutationResult> {
		return this.withFileLock(input.file, async () => {
			if (await this.usesStreamingPath(input.file.hostPath)) return this.appendStreaming(input);
			const original = await this.readSessionFile(input.file.hostPath);
			const document = parseDocument(original);
			if (document.lines.some((line) => line.entry?._reloadMarker !== undefined)) {
				throw new SessionFileEditorError("SESSION_MARKER_CONFLICT", "Session file already contains a reload marker");
			}
			const { firstEntryId, changedEntryIds } = this.appendEntriesToDocument(document, input.entries);
			const next = serializeDocument(document);
			const backupPath = await this.createBackup(input.file.hostPath, original);

			await this.replaceIfUnchanged(input.file.hostPath, original, next, backupPath);
			try {
				await this.reloadWithMarker(input.file, input.reload, next);
			} catch (cause) {
				const reloadFailure = cause instanceof ReloadAttemptFailure ? cause : new ReloadAttemptFailure(cause, [next]);
				// rollback 只读 input.file，target 用占位值满足类型（append 无定位目标）。
				await this.rollback({ ...input, target: {} as SessionEntryTarget }, backupPath, reloadFailure.error, reloadFailure.ownedStates);
				throw new SessionFileEditorError("SESSION_RELOAD_FAILED", "Session reload failed; the original file and runtime were restored", { cause: reloadFailure.error, backupPath });
			}

			getAppLogger()?.info("session-file", "Session messages appended", { file: input.file.hostPath, count: changedEntryIds.length, backupPath });
			return {
				targetEntryId: firstEntryId,
				changedEntryIds,
				backupPath,
			};
		});
	}

	private appendEntriesToDocument(document: JsonlDocument, entries: AppendMessageEntry[]): { firstEntryId: string; changedEntryIds: string[] } {
		if (entries.length === 0) {
			throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "No entries to append");
		}
		ensureTrailingEol(document);
		// leaf = 当前分支尾（与 pi `appendContextEdit` / `SessionManager.leafId` 一致）：
		// 最后一条带 id 的条目，包含 `context_edit` 与 `label`。
		//
		// 不能只找最后一条 message：编辑/删除后会追加 context_edit 记录，它才是真正的 leaf。
		// 若新消息挂到更早的 message 上，就会绕开那条编辑记录分叉，pi 沿新 leaf 回溯父链时
		// 收集不到它——用户的编辑会静默失效（2026-10 实测发现）。
		// 旧墓碑（`deleted`）也算 leaf：它们的 id 与 parentId 构成完整链，pi 同样如此处理。
		let parentId: string | null = currentLeafId(document);

		const eol = document.lines.length > 0 ? document.lines[document.lines.length - 1].eol || "\n" : "\n";
		const changedEntryIds: string[] = [];
		let firstEntryId = "";
		for (const item of entries) {
			const entryId = this.createUuid();
			if (!firstEntryId) firstEntryId = entryId;
			const now = this.now();
			const timestamp = new Date(now).toISOString();
			const message = {
				role: item.role,
				content: item.content,
				timestamp: now,
				...item.extra,
			};
			const entry: JsonlEntry = {
				type: "message",
				id: entryId,
				parentId,
				timestamp,
				message,
			};
			document.lines.push({ content: JSON.stringify(entry), eol, entry });
			document.entryLineById.set(entryId, document.lines.length - 1);
			changedEntryIds.push(entryId);
			parentId = entryId;
		}
		return { firstEntryId, changedEntryIds };
	}

	reload(input: { file: SessionFileRef; reload: () => Promise<void> }): Promise<void> {
		return this.withFileLock(input.file, async () => {
			try {
				if (await this.usesStreamingPath(input.file.hostPath)) await this.reloadWithMarkerStreaming(input.file, input.reload);
				else await this.reloadWithMarker(input.file, input.reload);
			} catch (cause) {
				if (cause instanceof SessionFileEditorError) throw cause;
				const reloadCause = cause instanceof ReloadAttemptFailure ? cause.error : cause;
				if (reloadCause instanceof SessionFileEditorError) throw reloadCause;
				throw new SessionFileEditorError("SESSION_RELOAD_FAILED", "Session runtime reload failed", { cause: reloadCause });
			}
		});
	}

	private async lockKey(file: SessionFileRef): Promise<string> {
		const physicalPath = await this.fs.realpath(file.hostPath).catch(() => file.hostPath);
		return normalizePhysicalPath(physicalPath);
	}

	private async withFileLock<T>(file: SessionFileRef, operation: () => Promise<T>): Promise<T> {
		const key = await this.lockKey(file);
		const previous = sharedFileLocks.get(key) ?? Promise.resolve();
		const current = previous.then(operation, operation);
		const tail = current.then(
			() => undefined,
			() => undefined,
		);
		sharedFileLocks.set(key, tail);
		try {
			return await current;
		} finally {
			if (sharedFileLocks.get(key) === tail) sharedFileLocks.delete(key);
		}
	}

	private async mutate(kind: MutationKind, input: MutationInput, newText?: string, imageTarget?: SessionMessageImageTarget): Promise<SessionMutationResult> {
		return this.withFileLock(input.file, async () => {
			// 大文件走流式路径：整读 + 整份对象图会超出主进程堆，见 sessionFileStream 文件头。
			if (await this.usesStreamingPath(input.file.hostPath)) return this.mutateStreaming(kind, input, newText, imageTarget);
			const original = await this.readSessionFile(input.file.hostPath);
			const document = parseDocument(original);
			if (document.lines.some((line) => line.entry?._reloadMarker !== undefined)) {
				throw new SessionFileEditorError("SESSION_MARKER_CONFLICT", "Session file already contains a reload marker");
			}
			const located = locateEntry(document, input.target);
			const changedEntryIds = this.applyMutation(document, located, kind, newText, imageTarget);
			const next = serializeDocument(document);
			const backupPath = await this.createBackup(input.file.hostPath, original);

			await this.replaceIfUnchanged(input.file.hostPath, original, next, backupPath);
			try {
				await this.reloadWithMarker(input.file, input.reload, next);
			} catch (cause) {
				const reloadFailure = cause instanceof ReloadAttemptFailure ? cause : new ReloadAttemptFailure(cause, [next]);
				await this.rollback(input, backupPath, reloadFailure.error, reloadFailure.ownedStates);
				throw new SessionFileEditorError("SESSION_RELOAD_FAILED", "Session reload failed; the original file and runtime were restored", { cause: reloadFailure.error, backupPath });
			}

			this.logMutation(kind, input.file.hostPath, changedEntryIds, backupPath);
			return {
				targetEntryId: located.entryId,
				changedEntryIds,
				backupPath,
			};
		});
	}

	/**
	 * 会话文件被就地改写属于不可逆用户操作（编辑/删除/重发截断），必须留痕：
	 * 记录改写类型、文件与备份路径，便于事后从日志定位并手工恢复备份。
	 * 用 getAppLogger() 而非构造注入的 logger（其接口只有 warn，且测试常不注入）。
	 */
	private logMutation(kind: MutationKind, hostPath: string, changedEntryIds: string[], backupPath: string) {
		getAppLogger()?.info("session-file", `Session message ${kind}`, { file: hostPath, changedEntryIds, backupPath });
	}

	private applyMutation(document: JsonlDocument, located: LocatedEntry, kind: MutationKind, newText?: string, imageTarget?: SessionMessageImageTarget): string[] {
		if (kind === "remove-image") {
			const message = messageOf(located.entry);
			if (message?.role !== "user") throw new SessionFileEditorError("SESSION_ENTRY_ROLE_INVALID", "Only user message images can be removed");
			const content = message.content;
			// 在文件锁内校验数量和哈希：重复图片只 splice 一块，不从 UI 重建其它 content。
			const imageIndex = removableImageIndex(content, imageTarget);
			if (!Array.isArray(content) || imageIndex === undefined) {
				throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The selected image is no longer present; reload the session before retrying");
			}
			content.splice(imageIndex, 1);
			replaceLine(document, located.lineIndex, located.entry);
			return [located.entryId];
		}

		if (kind === "edit") {
			const message = messageOf(located.entry);
			if (!message || (message.role !== "user" && message.role !== "assistant")) {
				throw new SessionFileEditorError("SESSION_ENTRY_ROLE_INVALID", "Only user and assistant message entries can be edited");
			}
			// 追加 pi 原生 context_edit（pi docs/session-format.md）：原文行不改写，
			// 模型上下文里这条消息的内容变成替换值。两种做法的关键差别：旧实现原地改文本
			// 会把原文从历史里抹掉（只能从备份找回），且编辑本身不可撤销。
			// 仍只改文本：图片、工具块等其它内容原样保留（见 replaceTextInContent）。
			this.appendContextEdit(document, located.entryId, { content: replaceTextInContent(message.content, newText ?? "") });
			return [located.entryId];
		}

		if (kind === "delete") {
			// 删除 = 追加 `replacement: null`：目标不再进入模型上下文，但原文留在文件里
			// （已发生的 token / 费用不回退，已被摘要转述的内容也不会因为这条记录消失）。
			const targets = [located.entryId];
			// 删除 assistant 回答时，同一轮的过程链（thinking-only assistant / toolResult 祖先）
			// 必须一起移出上下文：它们只服务于被删的回答，留着会被 groupToolMessages 并进
			// 下一轮回答（用户反馈「回答删了，但前面的思考和工具串到另一个上面」）。
			// 沿父链上溯，遇到 user 或带文本的 assistant（上一段回答）即停，保留它们。
			const isProcessNode = (entry: JsonlEntry | undefined): boolean => {
				if (!entry || entry.type !== "message") return false;
				const role = inputRole(entry);
				if (role === "toolResult") return true;
				if (role !== "assistant") return false;
				const message = messageOf(entry);
				const content = message?.content;
				const hasThinking = Array.isArray(content) ? content.some((block) => block && typeof block === "object" && (block as Record<string, unknown>).type === "thinking" && typeof (block as Record<string, unknown>).thinking === "string" && String((block as Record<string, unknown>).thinking).trim() !== "") : false;
				// thinking-only：只有思考块、没有可见文本
				return hasThinking && !textOf(content).trim();
			};
			if (inputRole(located.entry) === "assistant") {
				let cursor = parentIdOf(located.entry);
				const byId = document.entryLineById;
				while (cursor) {
					const lineIndex = byId.get(cursor);
					if (lineIndex === undefined) break;
					const ancestor = document.lines[lineIndex].entry;
					// 索引里没有的祖先：直接停（防御异常文件，不抛错）
					if (!ancestor || !isProcessNode(ancestor)) break;
					targets.push(cursor);
					cursor = parentIdOf(ancestor);
				}
			}
			for (const targetId of targets) {
				this.appendContextEdit(document, targetId, null);
			}
			return targets;
		}

		if (inputRole(located.entry) !== "user") {
			throw new SessionFileEditorError("SESSION_ENTRY_ROLE_INVALID", "Only user messages can be truncated for resend");
		}
		// 重发不是「上下文编辑」而是「回到这条消息重来」：必须真的截断后续分支，
		// 否则 pi 会保留旧回答的 tool_call/toolResult 配对，重发后报工具调用不匹配。
		// 因此这里继续用墓碑（新分支的 leaf 落在墓碑上，旧分支变为不可达）。
		const removeIds = descendantEntryIds(document, located.entryId);
		for (let index = 0; index < document.lines.length; index += 1) {
			const entry = document.lines[index].entry;
			if (!entry || entry.type === "deleted") continue;
			const entryId = entryIdOf(entry);
			if (!entryId || !removeIds.has(entryId)) continue;
			replaceLine(document, index, tombstone(entryId, this.now(), parentIdOf(entry), "resend-truncate"));
		}
		return [...removeIds];
	}

	/**
	 * 追加一条 pi 原生 context_edit 记录（pi docs/session-format.md#context_edit）。
	 *
	 * 形状：`{ type, id, parentId, timestamp, targetId, replacement }`。
	 * - parentId = 当前叶（当前分支尾），使新记录接在活动分支上，成为新的 leaf；
	 * - replacement = null（移出上下文）| `{ content }`（替换内容）；
	 * - 同时追加多条时按顺序串成 parent 链（不能都挂在同一个 parent 上：
	 *   后一条会成为侧分支，pi 只沿 leaf 父链收集编辑，前一条会静默失效）。
	 */
	private appendContextEdit(document: JsonlDocument, targetId: string, replacement: { content: unknown } | null): string {
		ensureTrailingEol(document);
		const entryId = this.createUuid();
		const eol = document.lines.length > 0 ? document.lines[document.lines.length - 1].eol || "\n" : "\n";
		const entry: JsonlEntry = {
			type: "context_edit",
			id: entryId,
			parentId: currentLeafId(document),
			timestamp: new Date(this.now()).toISOString(),
			targetId,
			replacement,
		};
		document.lines.push({ content: JSON.stringify(entry), eol, entry });
		document.entryLineById.set(entryId, document.lines.length - 1);
		return entryId;
	}

	private async readSessionFile(path: string): Promise<Buffer> {
		// 体量护栏：下面的 parseDocument 会 decode 文本 + 逐行 JSON.parse，
		// 内存占用约为文件体积的数倍。主进程 V8 老生代堆被钉在 384MB
		// （见 v8HeapLimits.ts），几百 MB 的会话会直接让 V8
		// FatalProcessOutOfMemory **abort 整个主进程**（用户看到闪退、无堆栈）；
		// 超过 V8 单字符串上限（2^29-24 ≈ 5.37 亿字符）则报 ERR_STRING_TOO_LONG。
		//
		// 超过上限的会话由 mutate / appendMessages / reload 分流到流式路径
		// （sessionFileStream.ts），这条整读路径只处理小文件；这里再拦一次是
		// 防御「分流判断失误 / stat 不可用」——宁可报可读错误也不让主进程崩掉。
		await this.assertInMemoryReadSafe(path);
		try {
			return await this.fs.readFile(path);
		} catch (cause) {
			throw new SessionFileEditorError("SESSION_FILE_EMPTY", "Session file could not be read", { cause });
		}
	}

	/**
	 * 整文件读入前的体量护栏（与分流阈值同一个值）：超过时说明本该走流式路径，
	 * 兜底拒绝并给可读错误，而不是让 parseDocument 把主进程堆吃爆。
	 */
	private async assertInMemoryReadSafe(path: string): Promise<void> {
		// 测试替身可能不提供 stat（它们不关心体量）：缺省时跳过护栏，不改变既有测试行为
		if (typeof this.fs.stat !== "function") return;
		let size: number;
		try {
			size = (await this.fs.stat(path)).size;
		} catch {
			// stat 失败（文件不存在等）：交给下面的 readFile 报原有错误，不改变错误码
			return;
		}
		if (size <= this.maxInMemoryBytes) return;
		throw new SessionFileEditorError("SESSION_FILE_TOO_LARGE", `Session file is too large to edit (${Math.round(size / (1024 * 1024))}MB, ` + `over the ${Math.round(this.maxInMemoryBytes / (1024 * 1024))}MB limit)`, { details: { size, limit: this.maxInMemoryBytes } });
	}

	private async createBackup(path: string, original: Buffer): Promise<string> {
		return createSessionBackup(this.storage, path, original);
	}

	private async pruneBackups(directory: string, filename: string, protectedBackup: string): Promise<void> {
		return pruneSessionBackups(this.storage, directory, filename, protectedBackup);
	}

	private async replaceIfUnchanged(path: string, expected: Buffer, next: Buffer, backupPath?: string): Promise<void> {
		return atomicReplaceFile(this.storage, path, next, backupPath, expected);
	}

	private async atomicReplace(path: string, next: Buffer, backupPath?: string, expected?: Buffer): Promise<void> {
		return atomicReplaceFile(this.storage, path, next, backupPath, expected);
	}

	private async reloadWithMarker(file: SessionFileRef, reload: () => Promise<void>, expectedBase?: Buffer): Promise<void> {
		const markerId = this.createUuid();
		const beforeMarker = await this.readSessionFile(file.hostPath);
		if (expectedBase && !beforeMarker.equals(expectedBase)) {
			throw new SessionFileEditorError("SESSION_FILE_CHANGED", "Session file changed before the runtime reload marker was written");
		}
		const markedDocument = parseDocument(beforeMarker);
		const existingMarker = markedDocument.lines.find((line) => line.entry && line.entry._reloadMarker !== undefined);
		if (existingMarker) {
			throw new SessionFileEditorError("SESSION_MARKER_CONFLICT", "Session file already contains a reload marker");
		}
		const markerLineIndex = markedDocument.lines.findIndex((line) => line.entry?.type === "session");
		if (markerLineIndex < 0) {
			throw new SessionFileEditorError("SESSION_FILE_EMPTY", "Session file has no header entry");
		}
		const originalLine = markedDocument.lines[markerLineIndex].content;
		const markerEntry = markedDocument.lines[markerLineIndex].entry!;
		delete markerEntry._reloadMarker;
		markerEntry._reloadMarker = markerId;
		replaceLine(markedDocument, markerLineIndex, markerEntry);
		const markedLine = markedDocument.lines[markerLineIndex].content;
		const markedBytes = serializeDocument(markedDocument);
		await this.replaceIfUnchanged(file.hostPath, beforeMarker, markedBytes);

		let reloadError: unknown;
		try {
			await reload();
		} catch (error) {
			reloadError = error;
		} finally {
			try {
				const current = await this.fs.readFile(file.hostPath);
				const cleanupDocument = parseDocument(current);
				const ownMarkerLines = cleanupDocument.lines.filter((line) => line.entry?._reloadMarker === markerId);
				if (ownMarkerLines.length > 1) {
					throw new SessionFileEditorError("SESSION_MARKER_CONFLICT", "Session reload marker appears more than once");
				}
				const cleanupLine = ownMarkerLines[0];
				if (cleanupLine) {
					if (cleanupLine.content === markedLine) {
						cleanupLine.content = originalLine;
						cleanupLine.entry = JSON.parse(originalLine) as JsonlEntry;
					} else {
						delete cleanupLine.entry!._reloadMarker;
						cleanupLine.content = JSON.stringify(cleanupLine.entry);
					}
					await this.replaceIfUnchanged(file.hostPath, current, serializeDocument(cleanupDocument));
				} else if (cleanupDocument.lines.some((line) => line.entry?._reloadMarker !== undefined)) {
					throw new SessionFileEditorError("SESSION_MARKER_CONFLICT", "Session reload marker ownership changed during reload");
				}
			} catch (cleanupError) {
				if (!reloadError) reloadError = cleanupError;
				else {
					void this.logger?.warn("Session reload marker cleanup failed", {
						path: file.hostPath,
						error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					});
				}
			}
		}

		if (reloadError) {
			throw new ReloadAttemptFailure(reloadError, [expectedBase ?? beforeMarker, markedBytes]);
		}
	}

	private async rollback(input: MutationInput, backupPath: string, cause: unknown, ownedStates: Buffer[]): Promise<void> {
		try {
			const backup = await this.fs.readFile(backupPath);
			const current = await this.fs.readFile(input.file.hostPath);
			if (!ownedStates.some((owned) => owned.equals(current))) {
				throw new SessionFileEditorError("SESSION_ROLLBACK_CONFLICT", "Session file changed during reload; automatic rollback was refused", {
					cause,
					backupPath,
					details: {
						originalError: cause instanceof Error ? cause.message : String(cause),
					},
				});
			}
			await this.atomicReplace(input.file.hostPath, backup, backupPath, current);
		} catch (rollbackError) {
			if (rollbackError instanceof SessionFileEditorError && rollbackError.code === "SESSION_ROLLBACK_CONFLICT") throw rollbackError;
			if (rollbackError instanceof SessionFileEditorError && rollbackError.code === "SESSION_FILE_CHANGED") {
				throw new SessionFileEditorError("SESSION_ROLLBACK_CONFLICT", "Session file changed while rollback was being committed", {
					cause: new AggregateError([cause, rollbackError]),
					backupPath,
					details: {
						originalError: cause instanceof Error ? cause.message : String(cause),
						rollbackError: rollbackError.message,
					},
				});
			}
			throw new SessionFileEditorError("SESSION_ROLLBACK_FAILED", "Session file rollback failed", {
				cause: new AggregateError([cause, rollbackError]),
				backupPath,
				details: {
					originalError: cause instanceof Error ? cause.message : String(cause),
					rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
				},
			});
		}

		try {
			const backup = await this.fs.readFile(backupPath);
			await this.reloadWithMarker(input.file, input.reload, backup);
		} catch (rollbackReloadError) {
			throw new SessionFileEditorError("SESSION_ROLLBACK_RELOAD_FAILED", "Session file was restored but the runtime could not reload it", {
				cause: rollbackReloadError,
				backupPath,
				details: {
					originalError: cause instanceof Error ? cause.message : String(cause),
				},
			});
		}
	}

	/**
	 * 大文件是否走流式路径：按注入的 stat 判断（测试替身不提供 stat 时保持整读路径，与旧行为一致）。
	 */
	private async usesStreamingPath(path: string): Promise<boolean> {
		if (typeof this.fs.stat !== "function") return false;
		try {
			return (await this.fs.stat(path)).size > this.maxInMemoryBytes;
		} catch {
			// stat 失败（文件不存在等）：交给整读路径报原有错误码，不改变错误语义。
			return false;
		}
	}

	/** 流式模块的错误 → 编辑器错误码；已是对外错误时原样返回。 */
	private toEditorError(error: unknown, fallback: SessionFileEditorErrorCode, backupPath?: string): SessionFileEditorError {
		if (error instanceof SessionFileEditorError) return error;
		if (error instanceof SessionFileStreamError) {
			const code: SessionFileEditorErrorCode = error.code === "SESSION_FILE_IO_FAILED" ? fallback : error.code;
			return new SessionFileEditorError(code, error.message, { cause: error, details: error.details, backupPath: error.backupPath ?? backupPath });
		}
		return new SessionFileEditorError(fallback, error instanceof Error ? error.message : String(error), { cause: error, backupPath });
	}

	private async readStreamEntry(scan: SessionFileScan, path: string, lineIndex: number): Promise<{ entry: SessionFileStreamEntry; raw: string }> {
		const line = await readSessionLineAt(path, scan.lineStartOffsets[lineIndex]);
		const raw = line.content.toString("utf8");
		try {
			return { entry: JSON.parse(raw) as SessionFileStreamEntry, raw };
		} catch (cause) {
			throw new SessionFileEditorError("SESSION_FILE_CHANGED", "Session file line changed while the mutation was being prepared", { cause });
		}
	}

	/** 分支 id 集合（流式版，与整读路径 activeBranchIds 同口径：缺省 leaf 跳过墓碑）。 */
	private streamActiveBranchIds(scan: SessionFileScan, activeLeafId?: string): Set<string> {
		if (activeLeafId && !scan.entryLineById.has(activeLeafId)) {
			throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The active session branch is no longer present in the file");
		}
		const leafId = activeLeafId ?? scan.branchLeafId;
		if (!leafId) return new Set();
		const result = new Set<string>();
		let current: string | null | undefined = leafId;
		while (current && !result.has(current)) {
			result.add(current);
			current = scan.parentById.get(current) ?? null;
		}
		return result;
	}

	private streamLocateById(scan: SessionFileScan, entryId: string | undefined, target: SessionEntryTarget, branchIds: ReadonlySet<string>): { lineIndex: number; entryId: string } | undefined {
		if (!entryId) return undefined;
		const lineIndex = scan.entryLineById.get(entryId);
		if (lineIndex === undefined) return undefined;
		if (!branchIds.has(entryId)) {
			throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The requested entry is not part of the active session branch");
		}
		if (scan.deletedIds.has(entryId)) {
			throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The requested entry has already been deleted");
		}
		const role = scan.roleById.get(entryId);
		if (role !== target.role) {
			throw new SessionFileEditorError("SESSION_ENTRY_ROLE_INVALID", `Session entry role ${String(role)} cannot be used as ${target.role}`);
		}
		return { lineIndex, entryId };
	}

	/**
	 * 定位（流式版）：id / legacy id 直查索引；都不命中时第二遍全扫做文本回退。
	 * 第二遍只保留命中的候选行，不驻留其它消息内容。
	 */
	private async locateStreaming(scan: SessionFileScan, path: string, target: SessionEntryTarget): Promise<{ lineIndex: number; entryId: string; entry?: SessionFileStreamEntry }> {
		const branchIds = this.streamActiveBranchIds(scan, target.activeLeafId);
		const exact = this.streamLocateById(scan, target.entryId, target, branchIds);
		if (exact) return exact;
		const legacy = this.streamLocateById(scan, legacyEntryId(target), target, branchIds);
		if (legacy) return legacy;

		const candidates: Array<{ lineIndex: number; entryId: string; entry: SessionFileStreamEntry }> = [];
		for await (const line of iterateSessionLines(path)) {
			if (line.content.length === 0) continue;
			const raw = line.content.toString("utf8");
			if (!raw.trim()) continue;
			const entry = JSON.parse(raw) as SessionFileStreamEntry;
			const entryId = entryIdOf(entry);
			if (!entryId || !branchIds.has(entryId)) continue;
			const message = messageOf(entry);
			if (message?.role !== target.role) continue;
			const rawText = textOf(message.content);
			const overridden = scan.contextEditTexts.get(entryId);
			const effective = overridden === undefined ? rawText : (overridden ?? "");
			if (rawText !== target.text && effective !== target.text) continue;
			candidates.push({ lineIndex: line.lineNumber, entryId, entry });
		}
		if (candidates.length === 1) return candidates[0];
		if (candidates.length > 1) {
			throw new SessionFileEditorError("SESSION_ENTRY_AMBIGUOUS", "More than one entry matches the requested message on the active branch", { details: { matches: candidates.length } });
		}
		throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "Message was not found on the active session branch");
	}

	/** 删除回答时是否属于同一轮的「过程节点」（thinking-only 回答 / toolResult）。 */
	private isStreamProcessNode(scan: SessionFileScan, entryId: string): boolean {
		const role = scan.roleById.get(entryId);
		if (role === "toolResult") return true;
		if (role !== "assistant") return false;
		return scan.thinkingById.has(entryId) && !scan.textById.has(entryId);
	}

	/**
	 * 流式版的 mutation 计划：产出「行替换 + 末尾追加」，不重建整个文档。
	 * 四种操作的语义与整读路径 applyMutation 一一对应（context_edit 追加 / 墓碑 / 图片行改写）。
	 */
	private async planStreamingMutation(scan: SessionFileScan, path: string, located: { lineIndex: number; entryId: string }, kind: MutationKind, newText?: string, imageTarget?: SessionMessageImageTarget): Promise<{ plan: SessionStreamRewritePlan; changedEntryIds: string[]; targetEntryId: string }> {
		const replaceLines = new Map<number, string>();
		const appendLines: string[] = [];
		const changedEntryIds: string[] = [];
		// context_edit 的 parent 链从当前叶起，后续追加的记录依次改父节点（平行父节点会让前面的编辑静默失效）。
		let parentId: string | null = scan.leafId ?? null;
		const appendContextEdit = (targetId: string, replacement: { content: unknown } | null) => {
			const entryId = this.createUuid();
			appendLines.push(JSON.stringify({ type: "context_edit", id: entryId, parentId, timestamp: new Date(this.now()).toISOString(), targetId, replacement }));
			parentId = entryId;
		};

		if (kind === "edit") {
			const { entry } = await this.readStreamEntry(scan, path, located.lineIndex);
			const message = messageOf(entry);
			if (!message || (message.role !== "user" && message.role !== "assistant")) {
				throw new SessionFileEditorError("SESSION_ENTRY_ROLE_INVALID", "Only user and assistant message entries can be edited");
			}
			appendContextEdit(located.entryId, { content: replaceTextInContent(message.content, newText ?? "") });
			changedEntryIds.push(located.entryId);
		} else if (kind === "remove-image") {
			const { entry } = await this.readStreamEntry(scan, path, located.lineIndex);
			const message = messageOf(entry);
			if (message?.role !== "user") {
				throw new SessionFileEditorError("SESSION_ENTRY_ROLE_INVALID", "Only user message images can be removed");
			}
			const content = message.content;
			const imageIndex = removableImageIndex(content, imageTarget);
			if (!Array.isArray(content) || imageIndex === undefined) {
				throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The selected image is no longer present; reload the session before retrying");
			}
			content.splice(imageIndex, 1);
			replaceLines.set(located.lineIndex, JSON.stringify(entry));
			changedEntryIds.push(located.entryId);
		} else if (kind === "delete") {
			const targets = [located.entryId];
			if (scan.roleById.get(located.entryId) === "assistant") {
				let cursor = scan.parentById.get(located.entryId) ?? null;
				while (cursor) {
					if (!this.isStreamProcessNode(scan, cursor)) break;
					targets.push(cursor);
					cursor = scan.parentById.get(cursor) ?? null;
				}
			}
			for (const targetId of targets) appendContextEdit(targetId, null);
			changedEntryIds.push(...targets);
		} else {
			if (scan.roleById.get(located.entryId) !== "user") {
				throw new SessionFileEditorError("SESSION_ENTRY_ROLE_INVALID", "Only user messages can be truncated for resend");
			}
			const removeIds = descendantsFromParentMap(scan.parentById, located.entryId, scan.deletedIds);
			for (const entryId of removeIds) {
				const lineIndex = scan.entryLineById.get(entryId);
				if (lineIndex === undefined) continue;
				replaceLines.set(lineIndex, JSON.stringify(tombstone(entryId, this.now(), scan.parentById.get(entryId) ?? null, "resend-truncate")));
			}
			changedEntryIds.push(...removeIds);
		}

		return { plan: { replaceLines, appendLines, eol: scan.trailingEol }, changedEntryIds, targetEntryId: located.entryId };
	}

	/** 流式备份：逐块复制并校验哈希（相当于整读路径「写入备份并读回比较」）。 */
	private async createStreamingBackup(path: string, expectedHash: string): Promise<{ backupPath: string; hash: string }> {
		const directory = dirname(path);
		const filename = basename(path);
		const stamp = String(this.now()).padStart(13, "0");
		const backupPath = join(directory, `${filename}.${stamp}-${this.createUuid()}.edit-backup`);
		let copied: { hash: string; size: number };
		try {
			copied = await copySessionFile(path, backupPath);
		} catch (cause) {
			throw new SessionFileEditorError("SESSION_BACKUP_FAILED", "Session backup could not be created", { cause, backupPath });
		}
		if (copied.hash !== expectedHash) {
			await this.fs.unlink(backupPath).catch(() => undefined);
			throw new SessionFileEditorError("SESSION_FILE_CHANGED", "Session file changed while the backup was being created", { backupPath });
		}
		await this.pruneBackups(directory, filename, basename(backupPath));
		return { backupPath, hash: copied.hash };
	}

	private async mutateStreaming(kind: MutationKind, input: MutationInput, newText?: string, imageTarget?: SessionMessageImageTarget): Promise<SessionMutationResult> {
		let backupPath: string | undefined;
		try {
			const scan = await scanSessionFile(input.file.hostPath);
			if (scan.hasReloadMarker) {
				throw new SessionFileEditorError("SESSION_MARKER_CONFLICT", "Session file already contains a reload marker");
			}
			const located = await this.locateStreaming(scan, input.file.hostPath, input.target);
			const planned = await this.planStreamingMutation(scan, input.file.hostPath, located, kind, newText, imageTarget);
			const backup = await this.createStreamingBackup(input.file.hostPath, scan.hash);
			backupPath = backup.backupPath;
			const { tempPath, tempHash } = await rewriteSessionFile(input.file.hostPath, planned.plan, scan.hash);
			await commitSessionTempFile(tempPath, input.file.hostPath, scan.hash);
			try {
				await this.reloadWithMarkerStreaming(input.file, input.reload, tempHash);
			} catch (cause) {
				const failure = cause instanceof ReloadAttemptFailure ? cause : new ReloadAttemptFailure(cause, [], [tempHash]);
				// 回滚只接受「本次改写后的内容」：reload 期间若有外部写入，cleanup 后的哈希就不等于 tempHash，冲突检查会拒绝覆盖。
				await this.rollbackStreaming(input, backup.backupPath, backup.hash, failure.error, [tempHash]);
				throw new SessionFileEditorError("SESSION_RELOAD_FAILED", "Session reload failed; the original file and runtime were restored", { cause: failure.error, backupPath });
			}
			this.logMutation(kind, input.file.hostPath, planned.changedEntryIds, backup.backupPath);
			return { targetEntryId: planned.targetEntryId, changedEntryIds: planned.changedEntryIds, backupPath: backup.backupPath };
		} catch (error) {
			throw this.toEditorError(error, "SESSION_ATOMIC_WRITE_FAILED", backupPath);
		}
	}

	private async appendStreaming(input: AppendMessagesInput): Promise<SessionMutationResult> {
		try {
			const scan = await scanSessionFile(input.file.hostPath);
			if (scan.hasReloadMarker) {
				throw new SessionFileEditorError("SESSION_MARKER_CONFLICT", "Session file already contains a reload marker");
			}
			if (input.entries.length === 0) {
				throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "No entries to append");
			}
			let parentId: string | null = scan.leafId ?? null;
			const appendLines: string[] = [];
			const changedEntryIds: string[] = [];
			let firstEntryId = "";
			for (const item of input.entries) {
				const entryId = this.createUuid();
				if (!firstEntryId) firstEntryId = entryId;
				const now = this.now();
				appendLines.push(
					JSON.stringify({
						type: "message",
						id: entryId,
						parentId,
						timestamp: new Date(now).toISOString(),
						message: { role: item.role, content: item.content, timestamp: now, ...item.extra },
					}),
				);
				changedEntryIds.push(entryId);
				parentId = entryId;
			}
			const backup = await this.createStreamingBackup(input.file.hostPath, scan.hash);
			const { tempPath, tempHash } = await rewriteSessionFile(input.file.hostPath, { replaceLines: new Map(), appendLines, eol: scan.trailingEol }, scan.hash);
			await commitSessionTempFile(tempPath, input.file.hostPath, scan.hash);
			try {
				await this.reloadWithMarkerStreaming(input.file, input.reload, tempHash);
			} catch (cause) {
				const failure = cause instanceof ReloadAttemptFailure ? cause : new ReloadAttemptFailure(cause, [], [tempHash]);
				await this.rollbackStreaming({ ...input, target: {} as SessionEntryTarget }, backup.backupPath, backup.hash, failure.error, [tempHash]);
				throw new SessionFileEditorError("SESSION_RELOAD_FAILED", "Session reload failed; the original file and runtime were restored", { cause: failure.error, backupPath: backup.backupPath });
			}
			getAppLogger()?.info("session-file", "Session messages appended", { file: input.file.hostPath, count: changedEntryIds.length, backupPath: backup.backupPath });
			return { targetEntryId: firstEntryId, changedEntryIds, backupPath: backup.backupPath };
		} catch (error) {
			throw this.toEditorError(error, "SESSION_ATOMIC_WRITE_FAILED");
		}
	}

	/**
	 * reload marker（大文件版）：只改写 session 头那一行，复制其余字节，不整读文件。
	 * 语义与 reloadWithMarker 一致：写入 marker → reload → 清除 marker。
	 */
	private async reloadWithMarkerStreaming(file: SessionFileRef, reload: () => Promise<void>, expectedHash?: string): Promise<void> {
		const markerId = this.createUuid();
		const before = await scanSessionFile(file.hostPath);
		if (expectedHash && before.hash !== expectedHash) {
			throw new SessionFileEditorError("SESSION_FILE_CHANGED", "Session file changed before the runtime reload marker was written");
		}
		if (before.hasReloadMarker) {
			throw new SessionFileEditorError("SESSION_MARKER_CONFLICT", "Session file already contains a reload marker");
		}
		const headerLine = before.headerLine;
		if (headerLine === undefined) {
			throw new SessionFileEditorError("SESSION_FILE_EMPTY", "Session file has no header entry");
		}
		const header = await this.readStreamEntry(before, file.hostPath, headerLine);
		const markedText = JSON.stringify({ ...header.entry, _reloadMarker: markerId });
		// 记录本事务写过的文件内容哈希：reload 失败时回滚只能覆盖「自己写的」那份，
		// 中途被 pi / 外部 append 过就拒绝（与整读路径 ownedStates 同义）。
		const ownedHashes: string[] = [];
		{
			const { tempPath, tempHash } = await rewriteSessionFile(file.hostPath, { replaceLines: new Map([[headerLine, markedText]]), appendLines: [] }, before.hash);
			await commitSessionTempFile(tempPath, file.hostPath, before.hash);
			ownedHashes.push(tempHash);
		}
		let reloadError: unknown;
		try {
			await reload();
		} catch (error) {
			reloadError = error;
		} finally {
			try {
				const after = await scanSessionFile(file.hostPath);
				const afterHeaderLine = after.headerLine;
				if (afterHeaderLine === undefined) throw new SessionFileEditorError("SESSION_FILE_EMPTY", "Session file has no header entry");
				const afterHeader = await this.readStreamEntry(after, file.hostPath, afterHeaderLine);
				if (afterHeader.entry._reloadMarker === markerId) {
					// 头部未被 pi 改写 → 逐字节还原；被改写则只去掉 marker 字段（与整读路径清理策略一致）。
					const restored = afterHeader.raw === markedText ? header.raw : JSON.stringify(stripReloadMarker(afterHeader.entry));
					const { tempPath } = await rewriteSessionFile(file.hostPath, { replaceLines: new Map([[afterHeaderLine, restored]]), appendLines: [] }, after.hash);
					await commitSessionTempFile(tempPath, file.hostPath, after.hash);
				} else if (after.hasReloadMarker) {
					throw new SessionFileEditorError("SESSION_MARKER_CONFLICT", "Session reload marker ownership changed during reload");
				}
			} catch (cleanupError) {
				if (!reloadError) reloadError = cleanupError;
				else {
					void this.logger?.warn("Session reload marker cleanup failed", {
						path: file.hostPath,
						error: cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
					});
				}
			}
		}

		if (reloadError) throw new ReloadAttemptFailure(reloadError, [], ownedHashes);
	}

	/** 回滚（大文件版）：当前文件必须仍是我们写过的内容（哈希匹配），否则拒绝覆盖。 */
	private async rollbackStreaming(input: MutationInput, backupPath: string, backupHash: string, cause: unknown, ownedHashes: string[]): Promise<void> {
		try {
			const currentHash = await hashSessionFile(input.file.hostPath);
			if (!ownedHashes.includes(currentHash)) {
				throw new SessionFileEditorError("SESSION_ROLLBACK_CONFLICT", "Session file changed during reload; automatic rollback was refused", {
					cause,
					backupPath,
					details: { originalError: cause instanceof Error ? cause.message : String(cause) },
				});
			}
			const { tempPath } = await copySessionFileToTemp(backupPath);
			await commitSessionTempFile(tempPath, input.file.hostPath, currentHash);
		} catch (rollbackError) {
			if (rollbackError instanceof SessionFileEditorError && rollbackError.code === "SESSION_ROLLBACK_CONFLICT") throw rollbackError;
			if (rollbackError instanceof SessionFileStreamError && rollbackError.code === "SESSION_FILE_CHANGED") {
				throw new SessionFileEditorError("SESSION_ROLLBACK_CONFLICT", "Session file changed while rollback was being committed", {
					cause: new AggregateError([cause, rollbackError]),
					backupPath,
					details: {
						originalError: cause instanceof Error ? cause.message : String(cause),
						rollbackError: rollbackError.message,
					},
				});
			}
			throw new SessionFileEditorError("SESSION_ROLLBACK_FAILED", "Session file rollback failed", {
				cause: new AggregateError([cause, rollbackError]),
				backupPath,
				details: {
					originalError: cause instanceof Error ? cause.message : String(cause),
					rollbackError: rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
				},
			});
		}

		try {
			await this.reloadWithMarkerStreaming(input.file, input.reload, backupHash);
		} catch (rollbackReloadError) {
			throw new SessionFileEditorError("SESSION_ROLLBACK_RELOAD_FAILED", "Session file was restored but the runtime could not reload it", {
				cause: rollbackReloadError,
				backupPath,
				details: {
					originalError: cause instanceof Error ? cause.message : String(cause),
				},
			});
		}
	}
}

function stripReloadMarker(entry: SessionFileStreamEntry): SessionFileStreamEntry {
	const copy = { ...entry };
	delete copy._reloadMarker;
	return copy;
}
