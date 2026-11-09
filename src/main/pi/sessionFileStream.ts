/**
 * 会话 JSONL 的流式扫描 / 改写（大文件编辑路径）。
 *
 * 背景：`SessionFileEditor` 的编辑/删除/重发需要「定位条目 + 重算 parentId 链」，
 * 旧实现把整个文件读成 Buffer → decode 成单一字符串 → 每行 JSON.parse 成对象图。
 * 这条路径的内存约为文件体积的数倍，主进程 V8 老生代堆被钉在 384MB 时，
 * 几十 MB 的会话就会直接 OOM abort（见 v8HeapLimits.ts）。因此大文件改走本模块：
 *
 * - 扫描只保留「索引元数据」（id → 行号、parentId、role、thinking 标记等），
 *   不保留行内容与消息文本，内存与文件体积无关；
 * - 改写按行流式复制源文件（未改写行逐字节原样保留），替换行写新内容，
 *   新条目追加到末尾，全程不持有整个文件；
 * - 扫描/改写/提交各自流式计算 sha256，作为「文件未被并发写」的乐观锁
 *   （等价于整读路径的 Buffer.equals 比较）。
 *
 * 只做 IO 与索引，不承载业务语义（定位、墓碑、context_edit 由 SessionFileEditor 决定）。
 */
import { createHash, randomUUID } from "node:crypto";
import { open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

/** 读块大小：与 Node 默认流块同量级，够大以减少 syscall，又不会放大单行缓存。 */
const READ_CHUNK_BYTES = 256 * 1024;

export type SessionFileStreamErrorCode = "SESSION_FILE_EMPTY" | "SESSION_FILE_INVALID_JSONL" | "SESSION_FILE_CHANGED" | "SESSION_FILE_IO_FAILED";

export class SessionFileStreamError extends Error {
	readonly code: SessionFileStreamErrorCode;
	readonly details?: Record<string, string | number>;
	readonly backupPath?: string;

	constructor(code: SessionFileStreamErrorCode, message: string, options: { cause?: unknown; details?: Record<string, string | number>; backupPath?: string } = {}) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "SessionFileStreamError";
		this.code = code;
		this.details = options.details;
		this.backupPath = options.backupPath;
	}
}

export type SessionFileStreamLine = {
	/** 物理行号（0 起，含空行）。 */
	lineNumber: number;
	/** 该行在文件中的起始字节偏移（随机读行用）。 */
	startOffset: number;
	/** 行内容（不含行尾）。 */
	content: Buffer;
	/** 原始行尾字节：`\n` / `\r\n` / 空（文件末尾无换行）。 */
	eol: Buffer;
};

export type SessionFileStreamEntry = Record<string, unknown>;

export type SessionFileScan = {
	size: number;
	/** 扫描时源文件的 sha256（十六进制）。 */
	hash: string;
	lineCount: number;
	lineStartOffsets: number[];
	entryLineById: Map<string, number>;
	parentById: Map<string, string | null>;
	/** message 条目的 role（toolResult 等也记录）；非 message 条目没有。 */
	roleById: Map<string, string>;
	/** assistant 条目里是否含非空 thinking 块（删除回答时决定是否一并移出上下文）。 */
	thinkingById: Set<string>;
	/** message 条目是否有非空可见文本（thinking-only 回答的判据之一）。 */
	textById: Set<string>;
	deletedIds: Set<string>;
	/** 当前叶：文件里最后一条带 id 的非 session 条目（含墓碑），与 pi `_buildIndex` 同口径。 */
	leafId?: string;
	/** 分支叶：最后一条带 id 且非墓碑的条目（与整读路径 activeBranchIds 的缺省 leaf 同口径）。 */
	branchLeafId?: string;
	/** session 头所在行号。 */
	headerLine?: number;
	/** 分支上生效的 `context_edit` 替换文本：targetId → 文本 / null（移出上下文）。 */
	contextEditTexts: Map<string, string | null>;
	hasReloadMarker: boolean;
	/** 最后一行是否带行尾（追加新行前需要补换行）。 */
	lastLineHasEol: boolean;
	/** 文件主流行的行尾（用于追加：取最后一行的 eol，缺省 `\n`）。 */
	trailingEol: string;
};

export type SessionStreamRewritePlan = {
	/** 行号 → 新的完整行内容（不含行尾；原行尾字节保持不变）。 */
	replaceLines: ReadonlyMap<number, string>;
	/** 追加到文件末尾的完整行内容（不含行尾）。 */
	appendLines: readonly string[];
	/** 追加行的行尾（缺省 `\n`）；与源文件最后一行保持一致。 */
	eol?: string;
};

function entryIdOf(entry: SessionFileStreamEntry): string | undefined {
	if (typeof entry.id === "string" && entry.id) return entry.id;
	if (typeof entry.entryId === "string" && entry.entryId) return entry.entryId;
	return undefined;
}

function parentIdOf(entry: SessionFileStreamEntry): string | null | undefined {
	if (entry.parentId === null) return null;
	return typeof entry.parentId === "string" ? entry.parentId : undefined;
}

function messageOf(entry: SessionFileStreamEntry): Record<string, unknown> | undefined {
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

function hasThinking(content: unknown): boolean {
	return Array.isArray(content) && content.some((block) => Boolean(block) && typeof block === "object" && (block as Record<string, unknown>).type === "thinking" && typeof (block as Record<string, unknown>).thinking === "string" && String((block as Record<string, unknown>).thinking).trim() !== "");
}

function isBlankLine(content: Buffer): boolean {
	for (const byte of content) {
		if (byte !== 0x20 && byte !== 0x09 && byte !== 0x0d) return false;
	}
	return true;
}

function parseEntry(content: Buffer, lineNumber: number): SessionFileStreamEntry {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(content);
	} catch (cause) {
		throw new SessionFileStreamError("SESSION_FILE_INVALID_JSONL", "Session file is not valid UTF-8", { cause });
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch (cause) {
		throw new SessionFileStreamError("SESSION_FILE_INVALID_JSONL", `Session file contains invalid JSONL at line ${lineNumber + 1}`, { cause, details: { line: lineNumber + 1 } });
	}
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new SessionFileStreamError("SESSION_FILE_INVALID_JSONL", `Session file contains a non-object entry at line ${lineNumber + 1}`, { details: { line: lineNumber + 1 } });
	}
	return parsed as SessionFileStreamEntry;
}

/**
 * 逐行遍历会话文件。
 *
 * 按字节切分而不是整读 decode：只有完整行才 decode，UTF-8 多字节字符不会跨行断开
 * （0x0A 不会出现在多字节序列内部）。单行大小决定峰值内存（含 base64 图片的行可能几十 MB），
 * 与文件总大小无关。
 */
export async function* iterateSessionLines(path: string): AsyncGenerator<SessionFileStreamLine> {
	const handle = await open(path, "r");
	const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
	let pending = Buffer.alloc(0);
	let pendingOffset = 0;
	let fileOffset = 0;
	let lineNumber = 0;
	try {
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, fileOffset);
			if (bytesRead <= 0) break;
			fileOffset += bytesRead;
			const view = chunk.subarray(0, bytesRead);
			const buffer = pending.length > 0 ? Buffer.concat([pending, view]) : view;
			let searchFrom = 0;
			for (;;) {
				const newline = buffer.indexOf(0x0a, searchFrom);
				if (newline < 0) break;
				const hasCarriageReturn = newline > searchFrom && buffer[newline - 1] === 0x0d;
				const contentEnd = hasCarriageReturn ? newline - 1 : newline;
				yield {
					lineNumber,
					startOffset: pendingOffset + searchFrom,
					content: buffer.subarray(searchFrom, contentEnd),
					eol: buffer.subarray(contentEnd, newline + 1),
				};
				lineNumber += 1;
				searchFrom = newline + 1;
			}
			pending = Buffer.from(buffer.subarray(searchFrom));
			pendingOffset += searchFrom;
		}
		if (pending.length > 0) {
			yield { lineNumber, startOffset: pendingOffset, content: pending, eol: Buffer.alloc(0) };
		}
	} finally {
		await handle.close();
	}
}

/** 读取从 `startOffset` 开始的单行（含行尾）。 */
export async function readSessionLineAt(path: string, startOffset: number): Promise<{ content: Buffer; eol: Buffer }> {
	const handle = await open(path, "r");
	const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
	const parts: Buffer[] = [];
	let fileOffset = startOffset;
	let sawNewline = false;
	try {
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, fileOffset);
			if (bytesRead <= 0) break;
			const view = chunk.subarray(0, bytesRead);
			const newline = view.indexOf(0x0a);
			if (newline >= 0) {
				parts.push(view.subarray(0, newline));
				sawNewline = true;
				break;
			}
			parts.push(Buffer.from(view));
			fileOffset += bytesRead;
		}
	} finally {
		await handle.close();
	}
	if (!sawNewline && parts.length === 0) {
		throw new SessionFileStreamError("SESSION_FILE_EMPTY", "Session file line could not be read", { details: { offset: startOffset } });
	}
	const buffer = parts.length === 1 ? parts[0] : Buffer.concat(parts);
	if (!buffer.length) return { content: Buffer.alloc(0), eol: Buffer.alloc(0) };
	// 该行以换行结束：去掉 `\r`，eol 为 `\n` / `\r\n`（与 iterateSessionLines 一致）。
	const hasCarriageReturn = buffer[buffer.length - 1] === 0x0d;
	return { content: hasCarriageReturn ? buffer.subarray(0, buffer.length - 1) : buffer, eol: Buffer.from(hasCarriageReturn ? "\r\n" : "\n") };
}

/**
 * 流式扫描：索引 + 校验 + 内容哈希。
 *
 * 校验规则与整读路径（SessionFileEditor.parseDocument）保持同一套错误消息，
 * 避免同一份坏文件在两条路径得到不同结论。
 */
export async function scanSessionFile(path: string): Promise<SessionFileScan> {
	const hash = createHash("sha256");
	const entryLineById = new Map<string, number>();
	const parentById = new Map<string, string | null>();
	const roleById = new Map<string, string>();
	const thinkingById = new Set<string>();
	const textById = new Set<string>();
	const deletedIds = new Set<string>();
	const contextEditTexts = new Map<string, string | null>();
	const lineStartOffsets: number[] = [];
	let size = 0;
	let lineCount = 0;
	let headerLine: number | undefined;
	let headerCount = 0;
	let leafId: string | undefined;
	let branchLeafId: string | undefined;
	let hasReloadMarker = false;
	let hasContent = false;
	let trailingEol = "";
	let lastLineHasEol = false;

	for await (const line of iterateSessionLines(path)) {
		size += line.content.length + line.eol.length;
		lineCount += 1;
		lineStartOffsets.push(line.startOffset);
		hash.update(line.content);
		hash.update(line.eol);
		trailingEol = line.eol.length > 0 ? line.eol.toString("utf8") : trailingEol;
		lastLineHasEol = line.eol.length > 0;
		if (isBlankLine(line.content)) continue;
		hasContent = true;
		const entry = parseEntry(line.content, line.lineNumber);
		if (entry._reloadMarker !== undefined) hasReloadMarker = true;
		if (entry.type === "session") {
			headerCount += 1;
			if (headerLine === undefined) headerLine = line.lineNumber;
			continue;
		}
		const entryId = entryIdOf(entry);
		if (!entryId) continue;
		if (entryLineById.has(entryId)) {
			throw new SessionFileStreamError("SESSION_FILE_INVALID_JSONL", `Session file contains duplicate entry ID ${entryId}`, { details: { line: line.lineNumber + 1 } });
		}
		entryLineById.set(entryId, line.lineNumber);
		parentById.set(entryId, parentIdOf(entry) ?? null);
		leafId = entryId;
		if (entry.type === "deleted") {
			deletedIds.add(entryId);
			continue;
		}
		branchLeafId = entryId;
		if (entry.type === "context_edit") {
			const targetId = typeof entry.targetId === "string" ? entry.targetId : undefined;
			if (targetId) {
				const replacement = entry.replacement;
				if (replacement === null) contextEditTexts.set(targetId, null);
				else if (replacement && typeof replacement === "object" && !Array.isArray(replacement)) {
					const content = (replacement as Record<string, unknown>).content;
					if (typeof content === "string") contextEditTexts.set(targetId, content);
					else if (Array.isArray(content)) contextEditTexts.set(targetId, textOf(content));
				}
			}
			continue;
		}
		const message = messageOf(entry);
		if (typeof message?.role === "string") roleById.set(entryId, message.role);
		const content = message?.content;
		if (hasThinking(content)) thinkingById.add(entryId);
		if (textOf(content).trim() !== "") textById.add(entryId);
	}

	if (!hasContent) throw new SessionFileStreamError("SESSION_FILE_EMPTY", "Session file is empty");
	if (headerCount !== 1) {
		throw new SessionFileStreamError("SESSION_FILE_INVALID_JSONL", `Session file must contain exactly one session header; found ${headerCount}`);
	}
	// 与整读路径同序同文案：先悬空父节点，再环检测。
	for (const [entryId, parentId] of parentById) {
		if (parentId && !entryLineById.has(parentId)) {
			throw new SessionFileStreamError("SESSION_FILE_INVALID_JSONL", `Session entry ${entryId} has a dangling parent ${parentId}`, { details: { line: (entryLineById.get(entryId) ?? 0) + 1 } });
		}
	}
	const completed = new Set<string>();
	for (const entryId of entryLineById.keys()) {
		const visiting = new Set<string>();
		let current: string | null | undefined = entryId;
		while (current && !completed.has(current)) {
			if (visiting.has(current)) {
				throw new SessionFileStreamError("SESSION_FILE_INVALID_JSONL", `Session entry graph contains a cycle at ${current}`);
			}
			visiting.add(current);
			current = parentById.get(current) ?? null;
		}
		for (const visited of visiting) completed.add(visited);
	}

	return {
		size,
		hash: hash.digest("hex"),
		lineCount,
		lineStartOffsets,
		entryLineById,
		parentById,
		roleById,
		thinkingById,
		textById,
		deletedIds,
		leafId,
		branchLeafId,
		headerLine,
		contextEditTexts,
		hasReloadMarker,
		lastLineHasEol,
		trailingEol: trailingEol || "\n",
	};
}

/** 流式计算文件 sha256（不按行切分，仅用于并发写的乐观锁）。 */
export async function hashSessionFile(path: string): Promise<string> {
	const handle = await open(path, "r");
	const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
	const hash = createHash("sha256");
	let offset = 0;
	try {
		for (;;) {
			const { bytesRead } = await handle.read(chunk, 0, READ_CHUNK_BYTES, offset);
			if (bytesRead <= 0) break;
			hash.update(chunk.subarray(0, bytesRead));
			offset += bytesRead;
		}
	} finally {
		await handle.close();
	}
	return hash.digest("hex");
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Buffer): Promise<void> {
	let written = 0;
	while (written < chunk.length) {
		const { bytesWritten } = await handle.write(chunk, written, chunk.length - written);
		if (bytesWritten <= 0) throw new Error("write returned 0 bytes");
		written += bytesWritten;
	}
}

/**
 * 流式重写：复制源文件到临时文件，替换指定行、末尾追加新行。
 *
 * - 未改写的行逐字节原样写出（保留 CRLF、无尾换行、空行）；
 * - 源文件哈希与 `expectedHash` 不一致说明扫描后文件被并发写过，直接拒绝（等价整读路径的 Buffer 比较）；
 * - 返回的 `nextHash` 是临时文件内容的哈希，供 reload marker / 回滚做「文件仍是自己写的那份」校验。
 */
export async function rewriteSessionFile(path: string, plan: SessionStreamRewritePlan, expectedHash: string): Promise<{ tempPath: string; tempHash: string }> {
	const tempPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
	const sourceHash = createHash("sha256");
	const outputHash = createHash("sha256");
	const source = await open(path, "r");
	let target;
	try {
		target = await open(tempPath, "wx");
	} catch (cause) {
		await source.close();
		throw new SessionFileStreamError("SESSION_FILE_IO_FAILED", "Session temp file could not be created", { cause });
	}
	const write = async (chunk: Buffer) => {
		if (chunk.length === 0) return;
		outputHash.update(chunk);
		await writeAll(target!, chunk);
	};
	let lastLineHasEol = true;
	try {
		for await (const line of iterateSessionLines(path)) {
			sourceHash.update(line.content);
			sourceHash.update(line.eol);
			lastLineHasEol = line.eol.length > 0;
			const replacement = plan.replaceLines.get(line.lineNumber);
			if (replacement === undefined) {
				await write(line.content);
				await write(line.eol);
				continue;
			}
			await write(Buffer.from(replacement, "utf8"));
			await write(line.eol);
		}
		if (plan.appendLines.length > 0) {
			// 文件末尾没有换行时先补一个：否则新行会粘在最后一行 JSON 后面，整份文件不可解析。
			const eol = plan.eol ?? "\n";
			if (!lastLineHasEol) await write(Buffer.from(eol, "utf8"));
			for (const line of plan.appendLines) {
				await write(Buffer.from(`${line}${eol}`, "utf8"));
			}
		}
		await target.sync();
	} catch (cause) {
		await target.close().catch(() => undefined);
		await unlink(tempPath).catch(() => undefined);
		throw cause;
	} finally {
		await target.close().catch(() => undefined);
		await source.close().catch(() => undefined);
	}

	const actualHash = sourceHash.digest("hex");
	if (actualHash !== expectedHash) {
		await unlink(tempPath).catch(() => undefined);
		throw new SessionFileStreamError("SESSION_FILE_CHANGED", "Session file changed while the replacement was being prepared");
	}
	return { tempPath, tempHash: outputHash.digest("hex") };
}

/** 把已 synced 的临时文件提交为正式文件；提交前再核对目标哈希（与整读路径 rename 前的 Buffer 比较同义）。 */
export async function commitSessionTempFile(tempPath: string, targetPath: string, expectedHash: string): Promise<void> {
	const delays = [0, 20, 75, 200];
	let lastError: unknown;
	for (const delay of delays) {
		if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
		try {
			if ((await hashSessionFile(targetPath)) !== expectedHash) {
				throw new SessionFileStreamError("SESSION_FILE_CHANGED", "Session file changed while the replacement was being committed");
			}
			await rename(tempPath, targetPath);
			return;
		} catch (error) {
			lastError = error;
			if (error instanceof SessionFileStreamError) {
				await unlink(tempPath).catch(() => undefined);
				throw error;
			}
			const code = error && typeof error === "object" && "code" in error ? String((error as { code?: unknown }).code ?? "") : "";
			if (code !== "EPERM" && code !== "EBUSY") throw error;
		}
	}
	await unlink(tempPath).catch(() => undefined);
	throw lastError;
}

/** 流式复制（备份 / 回滚用），同时返回源哈希与字节数。 */
export async function copySessionFile(fromPath: string, toPath: string): Promise<{ hash: string; size: number }> {
	const source = await open(fromPath, "r");
	let target;
	try {
		target = await open(toPath, "wx");
	} catch (cause) {
		await source.close();
		throw new SessionFileStreamError("SESSION_FILE_IO_FAILED", "Session file copy target could not be created", { cause });
	}
	const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
	const hash = createHash("sha256");
	let size = 0;
	try {
		for (;;) {
			const { bytesRead } = await source.read(chunk, 0, READ_CHUNK_BYTES, size);
			if (bytesRead <= 0) break;
			const view = chunk.subarray(0, bytesRead);
			hash.update(view);
			await writeAll(target, view);
			size += bytesRead;
		}
		await target.sync();
	} catch (cause) {
		await target.close().catch(() => undefined);
		await unlink(toPath).catch(() => undefined);
		throw new SessionFileStreamError("SESSION_FILE_IO_FAILED", "Session file copy failed", { cause });
	} finally {
		await target.close().catch(() => undefined);
		await source.close().catch(() => undefined);
	}
	return { hash: hash.digest("hex"), size };
}

/** 流式复制到同目录临时文件（回滚用：源是备份文件，目标是待提交的临时文件）。 */
export async function copySessionFileToTemp(fromPath: string): Promise<{ tempPath: string; tempHash: string }> {
	const tempPath = join(dirname(fromPath), `.${basename(fromPath)}.${process.pid}.${randomUUID()}.tmp`);
	const { hash } = await copySessionFile(fromPath, tempPath);
	return { tempPath, tempHash: hash };
}
