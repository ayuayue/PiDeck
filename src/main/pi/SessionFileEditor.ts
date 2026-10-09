import { randomUUID } from "node:crypto";
import { open as openFile, readFile, realpath, readdir, rename, stat, unlink, type FileHandle } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";
import { getAppLogger } from "../logging/sharedLogger";

export type SessionFileEnvironment = "native" | "wsl";

export type SessionFileRef = {
	protocolPath: string;
	hostPath: string;
	environment: SessionFileEnvironment;
	wslDistro?: string;
};

export type SessionEntryTarget = {
	entryId?: string;
	legacyMessageId?: string;
	legacyAgentId?: string;
	role: "user" | "assistant";
	text: string;
	activeLeafId?: string;
};

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
 * 编辑类操作可安全整读的会话文件上限（字节）。
 *
 * 与 SessionScanner.MAX_IN_MEMORY_SESSION_BYTES 同口径（32MB）：正常会话几 MB 以内，
 * 超限的都是该走流式路径的大会话。这里无法流式（编辑要完整文档），只能拒绝。
 */
const MAX_IN_MEMORY_SESSION_BYTES = 32 * 1024 * 1024;

export type SessionFileEditorErrorCode =
	| "SESSION_FILE_EMPTY"
	| "SESSION_FILE_INVALID_JSONL"
	/** 文件超出可安全整读的上限（编辑类操作需完整文档，见 assertInMemoryReadSafe） */
	| "SESSION_FILE_TOO_LARGE"
	| "SESSION_ENTRY_NOT_FOUND"
	| "SESSION_ENTRY_AMBIGUOUS"
	| "SESSION_ENTRY_ROLE_INVALID"
	| "SESSION_FILE_CHANGED"
	| "SESSION_BACKUP_FAILED"
	| "SESSION_ATOMIC_WRITE_FAILED"
	| "SESSION_RELOAD_FAILED"
	| "SESSION_ROLLBACK_FAILED"
	| "SESSION_ROLLBACK_RELOAD_FAILED"
	| "SESSION_ROLLBACK_CONFLICT"
	| "SESSION_MARKER_CONFLICT";

export class SessionFileEditorError extends Error {
	readonly code: SessionFileEditorErrorCode;
	readonly details?: Record<string, string | number>;
	readonly backupPath?: string;

	constructor(
		code: SessionFileEditorErrorCode,
		message: string,
		options: {
			cause?: unknown;
			details?: Record<string, string | number>;
			backupPath?: string;
		} = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "SessionFileEditorError";
		this.code = code;
		this.details = options.details;
		this.backupPath = options.backupPath;
	}
}

type WritableFileHandle = Pick<FileHandle, "writeFile" | "sync" | "close">;

export type SessionFileEditorFs = {
	readFile(path: string): Promise<Buffer>;
	/** 体量护栏用的 stat；测试替身可省（缺省时跳过护栏，不影响行为） */
	stat(path: string): Promise<{ size: number }>;
	realpath(path: string): Promise<string>;
	open(path: string, flags: "wx"): Promise<WritableFileHandle>;
	readdir(path: string): Promise<string[]>;
	rename(from: string, to: string): Promise<void>;
	unlink(path: string): Promise<void>;
};

export type SessionFileEditorLogger = {
	warn(message: string, details?: Record<string, unknown>): void | Promise<void>;
};

export type SessionFileEditorOptions = {
	fs?: Partial<SessionFileEditorFs>;
	now?: () => number;
	randomUUID?: () => string;
	sleep?: (milliseconds: number) => Promise<void>;
	logger?: SessionFileEditorLogger;
	maxBackups?: number;
};

type JsonlEntry = Record<string, unknown>;

type JsonlLine = {
	content: string;
	eol: string;
	entry?: JsonlEntry;
};

type JsonlDocument = {
	lines: JsonlLine[];
	entryLineById: Map<string, number>;
};

type LocatedEntry = {
	lineIndex: number;
	entry: JsonlEntry;
	entryId: string;
};

type MutationKind = "edit" | "delete" | "resend";

type MutationInput = {
	file: SessionFileRef;
	target: SessionEntryTarget;
	reload: () => Promise<void>;
};

class ReloadAttemptFailure extends Error {
	constructor(
		readonly error: unknown,
		readonly ownedStates: Buffer[],
	) {
		super("Session reload attempt failed", { cause: error });
	}
}

const defaultFs: SessionFileEditorFs = {
	stat,
	readFile: (path) => readFile(path),
	realpath,
	open: (path, flags) => openFile(path, flags),
	readdir,
	rename,
	unlink,
};

const sharedFileLocks = new Map<string, Promise<void>>();

function errorCode(error: unknown): string | undefined {
	return error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : undefined;
}

function normalizePhysicalPath(path: string): string {
	const slashed = path.replaceAll("\\", "/");
	const wslUnc = slashed.match(/^\/\/wsl(?:\.localhost|\$)\/([^/]+)(\/.*)?$/i);
	if (wslUnc) {
		return `wsl-unc\u0000${wslUnc[1].toLowerCase()}\u0000${posix.normalize(wslUnc[2] || "/")}`;
	}
	return `host\u0000${win32.normalize(path).replaceAll("\\", "/").toLowerCase()}`;
}

function entryIdOf(entry: JsonlEntry): string | undefined {
	if (typeof entry.id === "string" && entry.id) return entry.id;
	if (typeof entry.entryId === "string" && entry.entryId) return entry.entryId;
	return undefined;
}

function parentIdOf(entry: JsonlEntry): string | null | undefined {
	if (entry.parentId === null) return null;
	return typeof entry.parentId === "string" ? entry.parentId : undefined;
}

function messageOf(entry: JsonlEntry): Record<string, unknown> | undefined {
	return entry.message && typeof entry.message === "object" && !Array.isArray(entry.message) ? (entry.message as Record<string, unknown>) : undefined;
}

function textOf(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is Record<string, unknown> => Boolean(block) && typeof block === "object")
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => String(block.text))
		.join("");
}

function splitJsonl(text: string): JsonlLine[] {
	if (!text) return [];
	const lines: JsonlLine[] = [];
	let start = 0;
	for (let index = 0; index < text.length; index += 1) {
		const character = text[index];
		if (character !== "\r" && character !== "\n") continue;
		let eol = character;
		if (character === "\r" && text[index + 1] === "\n") {
			eol = "\r\n";
			index += 1;
		}
		const end = index + 1 - eol.length;
		lines.push({ content: text.slice(start, end), eol });
		start = index + 1;
	}
	if (start < text.length) lines.push({ content: text.slice(start), eol: "" });
	return lines;
}

function parseDocument(bytes: Buffer): JsonlDocument {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch (cause) {
		throw new SessionFileEditorError("SESSION_FILE_INVALID_JSONL", "Session file is not valid UTF-8", { cause });
	}
	const lines = splitJsonl(text);
	if (!lines.some((line) => line.content.trim())) {
		throw new SessionFileEditorError("SESSION_FILE_EMPTY", "Session file is empty");
	}

	const entryLineById = new Map<string, number>();
	let sessionHeaderCount = 0;
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		if (!line.content.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line.content);
		} catch (cause) {
			throw new SessionFileEditorError("SESSION_FILE_INVALID_JSONL", `Session file contains invalid JSONL at line ${index + 1}`, { cause, details: { line: index + 1 } });
		}
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
			throw new SessionFileEditorError("SESSION_FILE_INVALID_JSONL", `Session file contains a non-object entry at line ${index + 1}`, { details: { line: index + 1 } });
		}
		line.entry = parsed as JsonlEntry;
		// 墓碑也要进 id 索引：pi 会把最后一条带 id 的记录当 leaf，再沿 parentId
		// 回溯。旧墓碑没有 id，这里仍会跳过（entryIdOf 为空）。
		if (line.entry.type === "session") sessionHeaderCount += 1;
		const entryId = entryIdOf(line.entry);
		if (entryId) {
			if (entryLineById.has(entryId)) {
				throw new SessionFileEditorError("SESSION_FILE_INVALID_JSONL", `Session file contains duplicate entry ID ${entryId}`, { details: { line: index + 1 } });
			}
			entryLineById.set(entryId, index);
		}
	}
	if (sessionHeaderCount !== 1) {
		throw new SessionFileEditorError("SESSION_FILE_INVALID_JSONL", `Session file must contain exactly one session header; found ${sessionHeaderCount}`);
	}

	for (const [entryId, lineIndex] of entryLineById) {
		const parentId = parentIdOf(lines[lineIndex].entry!);
		if (parentId && !entryLineById.has(parentId)) {
			throw new SessionFileEditorError("SESSION_FILE_INVALID_JSONL", `Session entry ${entryId} has a dangling parent ${parentId}`, { details: { line: lineIndex + 1 } });
		}
	}

	const completed = new Set<string>();
	for (const entryId of entryLineById.keys()) {
		const visiting = new Set<string>();
		let current: string | null | undefined = entryId;
		while (current && !completed.has(current)) {
			if (visiting.has(current)) {
				throw new SessionFileEditorError("SESSION_FILE_INVALID_JSONL", `Session entry graph contains a cycle at ${current}`);
			}
			visiting.add(current);
			const lineIndex = entryLineById.get(current);
			current = lineIndex === undefined ? undefined : parentIdOf(lines[lineIndex].entry!);
		}
		for (const visited of visiting) completed.add(visited);
	}
	return { lines, entryLineById };
}

function serializeDocument(document: JsonlDocument): Buffer {
	return Buffer.from(document.lines.map((line) => `${line.content}${line.eol}`).join(""), "utf8");
}

function replaceLine(document: JsonlDocument, lineIndex: number, entry: JsonlEntry): void {
	document.lines[lineIndex].entry = entry;
	document.lines[lineIndex].content = JSON.stringify(entry);
}

function legacyEntryId(target: SessionEntryTarget): string | undefined {
	if (!target.legacyMessageId || !target.legacyAgentId) return undefined;
	const prefix = `${target.legacyAgentId}-history-`;
	return target.legacyMessageId.startsWith(prefix) ? target.legacyMessageId.slice(prefix.length) : undefined;
}

function validateLocatedRole(entry: JsonlEntry, target: SessionEntryTarget): void {
	const role = messageOf(entry)?.role;
	if (role !== target.role) {
		throw new SessionFileEditorError("SESSION_ENTRY_ROLE_INVALID", `Session entry role ${String(role)} cannot be used as ${target.role}`);
	}
}

/**
 * 会话内当前叶节点（新追加条目的 parentId）。
 *
 * 与 pi `SessionManager._buildIndex` 语义一致：跳过 session 头部，取**最后一条带 id**
 * 的条目（包括 PiDeck 自己的 `deleted` 墓碑与 `_reloadMarker`）。
 * 不能只找最后一条 message：前面追加过 `context_edit` / label 时，它们就是当前叶，
 * 跳过它们会把新条目挂到更早的位置，形成平行分支而不是延续当前分支。
 */
function currentLeafId(document: JsonlDocument): string | null {
	for (let index = document.lines.length - 1; index >= 0; index -= 1) {
		const entry = document.lines[index].entry;
		if (!entry || entry.type === "session") continue;
		const candidate = entryIdOf(entry);
		if (candidate) return candidate;
	}
	return null;
}

/**
 * 计算「只改文本」的替换内容，保留图片 / 工具块等其他合法内容。
 *
 * 为什么不能直接把 newText 当 replacement.content：pi 的 `projectContextEntry`
 * 会用 replacement.content **整体**替换消息内容，|user 消息直接丢掉附件图片，
 * 块状内容也会被一个纯文本块顶掉。这里沿用旧 `setMessageText` 的语义（只改第一个
 * text 块、其余块原样保留），先算好完整 content 再交给 pi。
 *
 * 返回 `{ content, changed }`：changed 为 false 表示原文与新文本等价（图片但无文本块等），
 * 此时仍会写入替换记录，保持「用户确实编辑过」的事实。
 */
function replaceTextInContent(content: unknown, text: string): unknown {
	if (typeof content === "string") return text;
	if (!Array.isArray(content)) return [{ type: "text", text }];
	const next: unknown[] = [];
	let replaced = false;
	for (const candidate of content) {
		const isText = Boolean(candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).type === "text");
		if (!isText) {
			next.push(candidate);
			continue;
		}
		if (replaced) continue;
		next.push({ ...(candidate as Record<string, unknown>), text });
		replaced = true;
	}
	if (!replaced) next.push({ type: "text", text });
	return next;
}

function locateById(document: JsonlDocument, entryId: string | undefined, target: SessionEntryTarget, activeIds: Set<string>): LocatedEntry | undefined {
	if (!entryId) return undefined;
	const lineIndex = document.entryLineById.get(entryId);
	if (lineIndex === undefined) return undefined;
	if (!activeIds.has(entryId)) {
		throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The requested entry is not part of the active session branch");
	}
	const entry = document.lines[lineIndex].entry!;
	if (entry.type === "deleted") {
		throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The requested entry has already been deleted");
	}
	validateLocatedRole(entry, target);
	return { lineIndex, entry, entryId };
}

function activeBranchIds(document: JsonlDocument, activeLeafId?: string): Set<string> {
	let leafId = activeLeafId;
	if (leafId && !document.entryLineById.has(leafId)) {
		throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "The active session branch is no longer present in the file");
	}
	if (!leafId) {
		for (let index = document.lines.length - 1; index >= 0; index -= 1) {
			const entry = document.lines[index].entry;
			if (!entry || entry.type === "deleted") continue;
			const candidate = entryIdOf(entry);
			if (candidate) {
				leafId = candidate;
				break;
			}
		}
	}
	if (!leafId) return new Set();

	const result = new Set<string>();
	let current: string | null | undefined = leafId;
	while (current && !result.has(current)) {
		result.add(current);
		const lineIndex = document.entryLineById.get(current);
		if (lineIndex === undefined) break;
		current = parentIdOf(document.lines[lineIndex].entry!);
	}
	return result;
}

/**
 * 分支上每个条目最终生效的替换文本（同一 targetId 后者覆盖前者）。
 * 仅用于「按文本定位」的回退比较：编辑后的条目在文件里仍是原文，
 * 但界面上显示的是改写后的文本，用原文比较会找不到刚编辑过的那条。
 * 返回 Map<targetId, string | null>：null 表示已被移出上下文。
 */
function effectiveContextEditTexts(document: JsonlDocument): Map<string, string | null> {
	const texts = new Map<string, string | null>();
	for (const line of document.lines) {
		const entry = line.entry;
		if (!entry || entry.type !== "context_edit") continue;
		const targetId = typeof entry.targetId === "string" ? entry.targetId : undefined;
		if (!targetId) continue;
		const replacement = entry.replacement;
		if (replacement === null) {
			texts.set(targetId, null);
			continue;
		}
		if (replacement && typeof replacement === "object" && !Array.isArray(replacement)) {
			const content = (replacement as Record<string, unknown>).content;
			if (typeof content === "string") texts.set(targetId, content);
			else if (Array.isArray(content)) texts.set(targetId, textOf(content));
		}
	}
	return texts;
}

function locateEntry(document: JsonlDocument, target: SessionEntryTarget): LocatedEntry {
	const branchIds = activeBranchIds(document, target.activeLeafId);
	const exact = locateById(document, target.entryId, target, branchIds);
	if (exact) return exact;
	const legacy = locateById(document, legacyEntryId(target), target, branchIds);
	if (legacy) return legacy;

	// 文本回退要同时认「原文」与「有效文本（改写后）」：一次编辑后界面上显示的是
	// 改写内容，用户再编辑一次时带的就是改写文本，而文件里仍是原文。
	const effectiveTexts = effectiveContextEditTexts(document);
	const candidates: LocatedEntry[] = [];
	for (const entryId of branchIds) {
		const lineIndex = document.entryLineById.get(entryId);
		if (lineIndex === undefined) continue;
		const entry = document.lines[lineIndex].entry!;
		const message = messageOf(entry);
		if (message?.role !== target.role) continue;
		const rawText = textOf(message.content);
		const overridden = effectiveTexts.get(entryId);
		const effective = overridden === undefined ? rawText : (overridden ?? "");
		if (rawText !== target.text && effective !== target.text) continue;
		candidates.push({ lineIndex, entry, entryId });
	}

	if (candidates.length === 1) return candidates[0];
	if (candidates.length > 1) {
		throw new SessionFileEditorError("SESSION_ENTRY_AMBIGUOUS", "More than one entry matches the requested message on the active branch", { details: { matches: candidates.length } });
	}
	throw new SessionFileEditorError("SESSION_ENTRY_NOT_FOUND", "Message was not found on the active session branch");
}

function descendantEntryIds(document: JsonlDocument, rootEntryId: string): Set<string> {
	const descendants = new Set<string>([rootEntryId]);
	let changed = true;
	while (changed) {
		changed = false;
		for (const line of document.lines) {
			const entry = line.entry;
			if (!entry || entry.type === "deleted") continue;
			const entryId = entryIdOf(entry);
			const parentId = parentIdOf(entry);
			if (!entryId || !parentId || !descendants.has(parentId) || descendants.has(entryId)) continue;
			descendants.add(entryId);
			changed = true;
		}
	}
	return descendants;
}

/**
 * 删除/重发截断写入的墓碑。必须保留 id + parentId：
 * pi SessionManager._buildIndex 把文件里最后一条带 id 的记录当成 leaf，
 * 再沿 parentId 回溯活动分支。旧墓碑只有 originalEntryId，leaf 会落在
 * 这条「无 id、无父节点」的记录上，get_messages 整页变空。
 */
function tombstone(entryId: string, now: number, parentId?: string | null, reason?: string): JsonlEntry {
	return {
		type: "deleted",
		id: entryId,
		originalEntryId: entryId,
		parentId: parentId ?? null,
		ts: now,
		...(reason ? { reason } : {}),
	};
}

export class SessionFileEditor {
	private readonly fs: SessionFileEditorFs;
	private readonly now: () => number;
	private readonly createUuid: () => string;
	private readonly sleep: (milliseconds: number) => Promise<void>;
	private readonly logger?: SessionFileEditorLogger;
	private readonly maxBackups: number;

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
	}

	editMessage(input: MutationInput & { newText: string }): Promise<SessionMutationResult> {
		return this.mutate("edit", input, input.newText);
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
				await this.reloadWithMarker(input.file, input.reload);
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

	private async mutate(kind: MutationKind, input: MutationInput, newText?: string): Promise<SessionMutationResult> {
		return this.withFileLock(input.file, async () => {
			const original = await this.readSessionFile(input.file.hostPath);
			const document = parseDocument(original);
			if (document.lines.some((line) => line.entry?._reloadMarker !== undefined)) {
				throw new SessionFileEditorError("SESSION_MARKER_CONFLICT", "Session file already contains a reload marker");
			}
			const located = locateEntry(document, input.target);
			const changedEntryIds = this.applyMutation(document, located, kind, newText);
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

	private applyMutation(document: JsonlDocument, located: LocatedEntry, kind: MutationKind, newText?: string): string[] {
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
		// 编辑/删除/重发确实需要完整文档（要定位条目、重算 parentId 链），无法像
		// 读取那样流式化。所以这里明确拒绝并给可读错误，而不是让应用崩掉。
		await this.assertInMemoryReadSafe(path);
		try {
			return await this.fs.readFile(path);
		} catch (cause) {
			throw new SessionFileEditorError("SESSION_FILE_EMPTY", "Session file could not be read", { cause });
		}
	}

	/**
	 * 整文件读入前的体量护栏。
	 *
	 * 与 SessionScanner.MAX_IN_MEMORY_SESSION_BYTES 同口径（32MB）：正常会话在几 MB 内，
	 * 超限的都是应该走流式路径的大会话；这里既拦不住也做不了流式，所以报可读错误。
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
		if (size <= MAX_IN_MEMORY_SESSION_BYTES) return;
		throw new SessionFileEditorError("SESSION_FILE_TOO_LARGE", `Session file is too large to edit (${Math.round(size / (1024 * 1024))}MB, ` + `over the ${Math.round(MAX_IN_MEMORY_SESSION_BYTES / (1024 * 1024))}MB limit)`, { details: { size, limit: MAX_IN_MEMORY_SESSION_BYTES } });
	}

	private async createBackup(path: string, original: Buffer): Promise<string> {
		const directory = dirname(path);
		const filename = basename(path);
		const stamp = String(this.now()).padStart(13, "0");
		const backupPath = join(directory, `${filename}.${stamp}-${this.createUuid()}.edit-backup`);
		let handle: WritableFileHandle | undefined;
		try {
			handle = await this.fs.open(backupPath, "wx");
			await handle.writeFile(original);
			await handle.sync();
			await handle.close();
			handle = undefined;
		} catch (cause) {
			await handle?.close().catch(() => undefined);
			await this.fs.unlink(backupPath).catch(() => undefined);
			throw new SessionFileEditorError("SESSION_BACKUP_FAILED", "Session backup could not be created", { cause, backupPath });
		}

		await this.pruneBackups(directory, filename, basename(backupPath));
		try {
			const verified = await this.fs.readFile(backupPath);
			if (!verified.equals(original)) throw new Error("Backup content mismatch");
		} catch (cause) {
			throw new SessionFileEditorError("SESSION_BACKUP_FAILED", "Session backup could not be verified", { cause, backupPath });
		}
		return backupPath;
	}

	private async pruneBackups(directory: string, filename: string, protectedBackup: string): Promise<void> {
		try {
			const prefix = `${filename}.`;
			const suffix = ".edit-backup";
			const backups = (await this.fs.readdir(directory)).filter((candidate) => candidate.startsWith(prefix) && candidate.endsWith(suffix)).sort();
			while (backups.length > this.maxBackups) {
				const oldestIndex = backups.findIndex((candidate) => candidate !== protectedBackup);
				if (oldestIndex < 0) break;
				const [oldest] = backups.splice(oldestIndex, 1);
				if (oldest) await this.fs.unlink(join(directory, oldest));
			}
		} catch (error) {
			void this.logger?.warn("Session backup pruning failed", {
				directory,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	private async replaceIfUnchanged(path: string, expected: Buffer, next: Buffer, backupPath?: string): Promise<void> {
		await this.atomicReplace(path, next, backupPath, expected);
	}

	private async atomicReplace(path: string, next: Buffer, backupPath?: string, expected?: Buffer): Promise<void> {
		const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${this.createUuid()}.tmp`);
		let handle: WritableFileHandle | undefined;
		let renamed = false;
		try {
			handle = await this.fs.open(tempPath, "wx");
			await handle.writeFile(next);
			await handle.sync();
			await handle.close();
			handle = undefined;
			await this.renameWithRetry(tempPath, path, expected, backupPath);
			renamed = true;
		} catch (cause) {
			if (cause instanceof SessionFileEditorError) throw cause;
			throw new SessionFileEditorError("SESSION_ATOMIC_WRITE_FAILED", "Session file could not be replaced atomically", { cause, backupPath });
		} finally {
			await handle?.close().catch(() => undefined);
			if (!renamed) await this.fs.unlink(tempPath).catch(() => undefined);
		}
	}

	private async renameWithRetry(from: string, to: string, expected?: Buffer, backupPath?: string): Promise<void> {
		const delays = [0, 20, 75, 200];
		let lastError: unknown;
		for (const delay of delays) {
			if (delay) await this.sleep(delay);
			try {
				if (expected) {
					const current = await this.fs.readFile(to).catch((cause) => {
						throw new SessionFileEditorError("SESSION_FILE_CHANGED", "Session file could not be verified before committing", { cause, backupPath });
					});
					if (!current.equals(expected)) {
						throw new SessionFileEditorError("SESSION_FILE_CHANGED", "Session file changed while the replacement was being committed", { backupPath });
					}
				}
				await this.fs.rename(from, to);
				return;
			} catch (error) {
				lastError = error;
				if (errorCode(error) !== "EPERM" && errorCode(error) !== "EBUSY") throw error;
			}
		}
		throw lastError;
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
}

function inputRole(entry: JsonlEntry): string | undefined {
	return typeof messageOf(entry)?.role === "string" ? String(messageOf(entry)?.role) : undefined;
}
