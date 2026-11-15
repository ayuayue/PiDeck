/**
 * 会话 JSONL 的文档模型与纯解析 helper（整读路径）。
 *
 * 只做「字节 ↔ 行」的机械工作：切行、逐行 JSON.parse 并建立 id 索引、序列化回字节、
 * 语言内部的整行替换、叶节点与 role 读取。不承载业务语义（定位、墓碑、context_edit
 * 由 sessionFileEntryTargets 与宿主 SessionFileEditor 决定），也不做任何 IO。
 *
 * 拆出的原因：这些函数是纯的、零状态的，却和事务骨架挤在同一个 1500 行文件里；
 * 搬迁时函数体一字未改（含错误消息与错误码），宿主行为完全不变。
 */
import { SessionFileEditorError } from "./sessionFileEditorError";

export type JsonlEntry = Record<string, unknown>;

export type JsonlLine = {
	content: string;
	eol: string;
	entry?: JsonlEntry;
};

export type JsonlDocument = {
	lines: JsonlLine[];
	entryLineById: Map<string, number>;
};

export function entryIdOf(entry: JsonlEntry): string | undefined {
	if (typeof entry.id === "string" && entry.id) return entry.id;
	if (typeof entry.entryId === "string" && entry.entryId) return entry.entryId;
	return undefined;
}

export function parentIdOf(entry: JsonlEntry): string | null | undefined {
	if (entry.parentId === null) return null;
	return typeof entry.parentId === "string" ? entry.parentId : undefined;
}

export function messageOf(entry: JsonlEntry): Record<string, unknown> | undefined {
	return entry.message && typeof entry.message === "object" && !Array.isArray(entry.message) ? (entry.message as Record<string, unknown>) : undefined;
}

export function textOf(content: unknown): string {
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

export function parseDocument(bytes: Buffer): JsonlDocument {
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

export function serializeDocument(document: JsonlDocument): Buffer {
	return Buffer.from(document.lines.map((line) => `${line.content}${line.eol}`).join(""), "utf8");
}

export function replaceLine(document: JsonlDocument, lineIndex: number, entry: JsonlEntry): void {
	document.lines[lineIndex].entry = entry;
	document.lines[lineIndex].content = JSON.stringify(entry);
}

/**
 * 追加新行前补全行尾：文件末尾没有换行时，直接拼接会让新行粘在原最后一行 JSON
 * 后面（相邻两条记录连成一行），整份文件变得不可解析。
 */
export function ensureTrailingEol(document: JsonlDocument): void {
	const last = document.lines[document.lines.length - 1];
	if (last && last.eol === "") last.eol = "\n";
}

/**
 * 会话内当前叶节点（新追加条目的 parentId）。
 *
 * 与 pi `SessionManager._buildIndex` 语义一致：跳过 session 头部，取**最后一条带 id**
 * 的条目（包括 PiDeck 自己的 `deleted` 墓碑与 `_reloadMarker`）。
 * 不能只找最后一条 message：前面追加过 `context_edit` / label 时，它们就是当前叶，
 * 跳过它们会把新条目挂到更早的位置，形成平行分支而不是延续当前分支。
 */
export function currentLeafId(document: JsonlDocument): string | null {
	for (let index = document.lines.length - 1; index >= 0; index -= 1) {
		const entry = document.lines[index].entry;
		if (!entry || entry.type === "session") continue;
		const candidate = entryIdOf(entry);
		if (candidate) return candidate;
	}
	return null;
}

export function inputRole(entry: JsonlEntry): string | undefined {
	return typeof messageOf(entry)?.role === "string" ? String(messageOf(entry)?.role) : undefined;
}
