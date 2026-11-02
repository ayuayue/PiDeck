/**
 * 会话采集：把「已经落盘的会话」解析成统一的 `{ session, messages }` 再喂给索引。
 *
 * M2 覆盖范围与理由：
 * - **pi**：`sessions/<编码目录>/<时间戳>_<id>.jsonl`，一行一个事件，`type:"message"` 里带
 *   `message.role/content`。system 消息带整份系统提示（含工具表），必须跳过——它既不是对话，
 *   也不会有人去检索，入库只会把索引撑爆。
 * - **ACP**：`<userData>/acp-sessions/<sha1>.json` 的归档信封，`messages[].text` 是纯文本。
 * - **DSH**：`<dshHome>/sessions/<workspace>/<sessionId>/session[.vN].jsonl[.zstd]` 的事件日志。
 *   只采根会话（跳过 subagent/派生）与两类事件（user/message 真人消息、assistant/message 终态），
 *   不复刻它的格式代迁移链——增量索引靠 (size, mtime) 指纹，日志变了就整份重灌；
 *   压缩件按 zstd 帧边界逐帧解压，与 dshForeignSessionScan 同一策略：解不开就停，不截半帧。
 *   DSH 自己的 session_query 不受影响；这里解决的是「跨后端检索自己的历史」。
 *
 * 增量：以 (size, mtime) 为指纹，没变就跳过整份文件——会话是 append-only 的，
 * 变了就整段重灌（单会话几百条，成本远小于做增量 diff）。
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { zstdDecompressSync } from "node:zlib";

import { replaceSession, sessionFileMeta } from "./db.mjs";
import { MAX_INDEXED_MESSAGE_CHARS, projectKeyFromPath } from "./paths.mjs";

/** 单份会话文件的读取上限：超大文件直接跳过，宁可漏索引也不让 MCP 进程吃满内存。 */
const MAX_SESSION_FILE_BYTES = 64 * 1024 * 1024;
/** 单会话入库消息上限（保留最近的 N 条）。 */
const MAX_MESSAGES_PER_SESSION = 2000;
/** JSONL 单行上限：坏行直接丢弃，不尝试修复。 */
const MAX_LINE_CHARS = 512 * 1024;

/* ─────────────────────── DSH 事件日志（zstd 帧序列） ─────────────────────── */

/** zstd 帧魔数（小端读前 4 字节）。 */
const ZSTD_MAGIC = 0xfd2fb528;
/** 单帧解压上限（与 dshForeignSessionScan 同值）：帧损坏时避免吃满内存。 */
const MAX_FRAME_OUTPUT_BYTES = 8 * 1024 * 1024;

/** 定位 buffer[offset..] 上第一个完整 zstd 帧的结尾；不完整/不合法返回 undefined。 */
function zstdFrameEnd(buffer, offset = 0) {
	if (buffer.length - offset < 5 || buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return undefined;
	let cursor = offset + 4;
	const descriptor = buffer.readUInt8(cursor);
	cursor += 1;
	// 保留位非零（24 掩码）：官方不支持，按损坏处理。
	if ((descriptor & 24) !== 0) return undefined;
	const contentSizeFlag = descriptor >>> 6;
	const singleSegment = (descriptor & 32) !== 0;
	const checksum = (descriptor & 4) !== 0;
	const dictionaryBytes = descriptor & 3;
	const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
	const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
	if (buffer.length - cursor < remainingHeaderBytes) return undefined;
	cursor += remainingHeaderBytes;
	for (;;) {
		if (buffer.length - cursor < 3) return undefined;
		const blockHeader = buffer.readUIntLE(cursor, 3);
		cursor += 3;
		const lastBlock = (blockHeader & 1) !== 0;
		const blockType = (blockHeader >>> 1) & 3;
		const blockSize = blockHeader >>> 3;
		if (blockType === 3) return undefined; // 保留块类型
		const payloadBytes = blockType === 1 ? 1 : blockSize;
		if (buffer.length - cursor < payloadBytes) return undefined;
		cursor += payloadBytes;
		if (lastBlock) break;
	}
	if (checksum) {
		if (buffer.length - cursor < 4) return undefined;
		cursor += 4;
	}
	return cursor - offset;
}

/** 整份帧序列日志解压成文本；任一帧解不开即停（宁可漏索引，不截半帧）。 */
function zstdLogToText(buffer) {
	const parts = [];
	let offset = 0;
	while (offset < buffer.length) {
		const end = zstdFrameEnd(buffer, offset);
		if (end === undefined) break;
		try {
			parts.push(zstdDecompressSync(buffer.subarray(offset, offset + end), { maxOutputLength: MAX_FRAME_OUTPUT_BYTES }).toString("utf8"));
		} catch {
			break;
		}
		offset += end;
	}
	return parts.join("\n");
}

/** 从 content 数组里抽纯文本；工具调用/结果/思考块只留可检索的痕迹。 */
function extractText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	const tools = [];
	for (const block of content) {
		if (!block || typeof block !== "object") continue;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		// 工具名入库（便于「上次那个 grep 是怎么用的」这类检索），工具结果不入库（体量不可控）。
		else if ((block.type === "tool_use" || block.type === "toolCall") && typeof block.name === "string") tools.push(block.name);
	}
	return { text: parts.join("\n").trim(), tools };
}

function clip(text) {
	const value = String(text ?? "");
	return value.length > MAX_INDEXED_MESSAGE_CHARS ? `${value.slice(0, MAX_INDEXED_MESSAGE_CHARS)}…` : value;
}

/**
 * 解析一份 pi 会话 JSONL。
 * @returns {{ session: object, messages: object[] }}
 */
export function parsePiSession(filePath, text, { project = "" } = {}) {
	let id = "";
	let cwd = "";
	let startedAt = "";
	let endedAt = "";
	const messages = [];
	for (const rawLine of text.split("\n")) {
		if (!rawLine || rawLine.length > MAX_LINE_CHARS) continue;
		let entry;
		try {
			entry = JSON.parse(rawLine);
		} catch {
			continue; // 半截行（正在写）/损坏行：跳过即可，下次指纹变化时会重灌。
		}
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "session") {
			id = typeof entry.id === "string" ? entry.id : id;
			cwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
			startedAt = typeof entry.timestamp === "string" ? entry.timestamp : startedAt;
			continue;
		}
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (!message || typeof message !== "object") continue;
		const role = message.role;
		// system：整份系统提示，跳过（见文件头）。tool：工具结果回填，体量不可控且不值得检索。
		if (role !== "user" && role !== "assistant") continue;
		const extracted = extractText(message.content);
		const text2 = typeof extracted === "string" ? extracted : extracted.text;
		const tools = typeof extracted === "string" ? [] : extracted.tools;
		if (!text2 && tools.length === 0) continue;
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : "";
		if (timestamp) endedAt = timestamp;
		messages.push({
			id: typeof entry.id === "string" && entry.id ? entry.id : `${filePath}#${messages.length}`,
			role,
			content: clip(tools.length > 0 ? `${text2}\n[tools] ${tools.join(" ")}` : text2),
			timestamp,
			toolCalls: tools,
		});
	}
	if (!id) id = path.basename(filePath).replace(/\.jsonl$/i, "");
	// 项目归属优先用采集源显式指定的值；否则由会话自己的 cwd 派生。
	// 宿主只给一个 sessions 根目录（所有项目混在一起），cwd 才是唯一可用的项目线索。
	const derivedProject = project || (cwd ? projectKeyFromPath(cwd) : "");
	return {
		session: { id, backend: "pi", project: derivedProject, cwd, startedAt, endedAt, filePath },
		messages: messages.slice(-MAX_MESSAGES_PER_SESSION),
	};
}

/** 解析 ACP 归档信封（`AcpSessionArchive` 落的 JSON）。 */
export function parseAcpArchive(filePath, text, { project = "" } = {}) {
	let payload;
	try {
		payload = JSON.parse(text);
	} catch {
		return undefined; // 半截 JSON / 非归档文件：当作没有，不阻断整批采集。
	}
	if (!payload || typeof payload !== "object" || !Array.isArray(payload.messages)) return undefined;
	const messages = [];
	for (const message of payload.messages) {
		if (!message || typeof message !== "object") continue;
		const role = message.role;
		if (role !== "user" && role !== "assistant") continue;
		const content = clip(message.text);
		if (!content) continue;
		const timestamp = typeof message.timestamp === "number" ? new Date(message.timestamp).toISOString() : "";
		messages.push({ id: typeof message.id === "string" && message.id ? message.id : `${filePath}#${messages.length}`, role, content, timestamp, toolCalls: [] });
	}
	const acpSessionId = typeof payload.acpSessionId === "string" && payload.acpSessionId ? payload.acpSessionId : path.basename(filePath).replace(/\.json$/i, "");
	const endedAt = typeof payload.updatedAt === "number" ? new Date(payload.updatedAt).toISOString() : "";
	return {
		session: { id: `acp:${acpSessionId}`, backend: "acp", project, cwd: "", startedAt: messages[0]?.timestamp ?? "", endedAt, filePath },
		messages: messages.slice(-MAX_MESSAGES_PER_SESSION),
	};
}

/**
 * 解析一份 DSH 会话事件日志（已解压的帧序列或明文 JSONL 都收）。
 * @returns {{ session: object, messages: object[] }} 根会话
 * @returns {{ skipped: true }} 非根会话（subagent/派生）——不是错误，不计 failed
 */
export function parseDshSessionLog(filePath, buffer, { project = "" } = {}) {
	let text;
	if (buffer.length >= 4 && buffer.readUInt32LE(0) === ZSTD_MAGIC) {
		text = zstdLogToText(buffer);
	} else {
		text = buffer.toString("utf8");
	}
	let id = "";
	let cwd = "";
	const messages = [];
	for (const rawLine of text.split("\n")) {
		if (!rawLine || rawLine.length > MAX_LINE_CHARS) continue;
		let entry;
		try {
			entry = JSON.parse(rawLine);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		if (entry.type === "session") {
			id = typeof entry.id === "string" ? entry.id : id;
			cwd = typeof entry.cwd === "string" ? entry.cwd : cwd;
			// 与外部会话清单的根会话过滤同口径：检索主体是用户与主对话。
			if (entry.origin === "subagent") return { skipped: true };
			if (typeof entry.parentSession === "string" && entry.parentSession) return { skipped: true };
			if (typeof entry.delegationDepth === "number" && entry.delegationDepth > 0) return { skipped: true };
			continue;
		}
		// 只认两类 durable 事件：真人 user/message 与 assistant 终态。
		// chunk/delta/text-chunks 是流式增量，与终态重复且旧格式里不落盘，全跳过。
		const isUser = entry.type === "user/message";
		const isAssistant = entry.type === "assistant/message";
		if (!isUser && !isAssistant) continue;
		const data = entry.data;
		if (!data || typeof data !== "object") continue;
		if (isUser) {
			// source.kind 区分真人与注入上下文（AGENTS.md、skills 清单等）；缺失按真人（旧格式）。
			const source = data.source;
			if (source && typeof source === "object" && source.kind !== undefined && source.kind !== "user") continue;
		}
		const payload = isUser ? data : data.message;
		if (!payload || typeof payload !== "object") continue;
		const extracted = extractText(payload.content);
		const text2 = typeof extracted === "string" ? extracted : extracted.text;
		const tools = typeof extracted === "string" ? [] : extracted.tools;
		if (!text2 && tools.length === 0) continue;
		const timestamp = typeof entry.time === "number" ? new Date(entry.time).toISOString() : "";
		messages.push({
			// 与 dshEventProjector 同惯例：消息 id 用事件 seq（稳定、可去重）。
			id: `dsh:${typeof entry.seq === "number" ? entry.seq : messages.length}`,
			role: isUser ? "user" : "assistant",
			content: clip(tools.length > 0 ? `${text2}\n[tools] ${tools.join(" ")}` : text2),
			timestamp,
			toolCalls: tools,
		});
	}
	if (!id) id = path.basename(path.dirname(filePath));
	const derivedProject = project || (cwd ? projectKeyFromPath(cwd) : "");
	return {
		session: { id: `dsh:${id}`, backend: "dsh", project: derivedProject, cwd, startedAt: messages[0]?.timestamp ?? "", endedAt: messages[messages.length - 1]?.timestamp ?? "", filePath },
		messages: messages.slice(-MAX_MESSAGES_PER_SESSION),
	};
}

/** DSH 日志文件名（官方 generationLogFilename 语义）：v0 无版本名，v1+ 带小写数字。 */
const DSH_SESSION_LOG_RE = /^session(?:\.v(\d+))?\.jsonl(\.zstd)?$/i;

/**
 * 同一会话目录只发布一个 generation；历史目录遗留的旧代文件不采（与宿主读日志的
 * findDshSessionLogFile 同口径：版本号最大者胜，同版本压缩件优先，前导零不认）。
 */
function pickDshGeneration(files) {
	const best = new Map();
	for (const filePath of files) {
		const match = DSH_SESSION_LOG_RE.exec(path.basename(filePath));
		if (!match) continue;
		const rawVersion = match[1];
		if (rawVersion !== undefined && rawVersion.length > 1 && rawVersion.startsWith("0")) continue;
		const version = rawVersion === undefined ? 0 : Number(rawVersion);
		const compressed = Boolean(match[2]);
		const dir = path.dirname(filePath);
		const current = best.get(dir);
		if (current && (version < current.version || (version === current.version && !compressed))) continue;
		best.set(dir, { filePath, version, compressed });
	}
	return [...best.values()].map((entry) => entry.filePath);
}

/** 递归列出目录下的会话文件（pi 的 sessions 是「编码目录/文件」两层）。 */
export function listSessionFiles(dir, pattern) {
	const found = [];
	const walk = (current, depth) => {
		if (depth > 3) return;
		let entries;
		try {
			entries = readdirSync(current, { withFileTypes: true });
		} catch {
			return; // 目录不存在/无权限：没有会话，不是错误。
		}
		for (const entry of entries) {
			const full = path.join(current, entry.name);
			if (entry.isDirectory()) walk(full, depth + 1);
			else if (entry.isFile() && pattern.test(entry.name)) found.push(full);
		}
	};
	walk(dir, 0);
	return found;
}

/**
 * 采集一批来源目录。
 * @param {string} root 记忆根目录
 * @param {Array<{ backend: "pi"|"acp"|"dsh", dir: string, project?: string }>} sources
 * @returns {{ indexed: number, skipped: number, failed: number, sessions: number }}
 */
export function indexSources(root, sources) {
	const result = { indexed: 0, skipped: 0, failed: 0, sessions: 0 };
	for (const source of sources) {
		const isAcp = source.backend === "acp";
		const isDsh = source.backend === "dsh";
		const files = isDsh ? pickDshGeneration(listSessionFiles(source.dir, DSH_SESSION_LOG_RE)) : listSessionFiles(source.dir, isAcp ? /\.json$/i : /\.jsonl$/i);
		for (const filePath of files) {
			let stat;
			try {
				stat = statSync(filePath);
			} catch {
				result.failed += 1;
				continue;
			}
			if (!stat.isFile() || stat.size === 0 || stat.size > MAX_SESSION_FILE_BYTES) {
				result.skipped += 1;
				continue;
			}
			const previous = sessionFileMeta(root, filePath);
			if (previous && previous.size === stat.size && previous.mtimeMs === Math.round(stat.mtimeMs)) {
				result.skipped += 1;
				continue;
			}
			let buffer;
			try {
				buffer = readFileSync(filePath);
			} catch {
				result.failed += 1;
				continue;
			}
			const parsed = isAcp
				? parseAcpArchive(filePath, buffer.toString("utf8"), { project: source.project ?? "" })
				: isDsh
					? parseDshSessionLog(filePath, buffer, { project: source.project ?? "" })
					: parsePiSession(filePath, buffer.toString("utf8"), { project: source.project ?? "" });
			if (!parsed) {
				result.failed += 1;
				continue;
			}
			if (parsed.skipped) {
				result.skipped += 1;
				continue;
			}
			parsed.session.size = stat.size;
			parsed.session.mtimeMs = Math.round(stat.mtimeMs);
			if (replaceSession(root, parsed.session, parsed.messages)) {
				result.indexed += 1;
				result.sessions += 1;
			} else {
				result.failed += 1;
			}
		}
	}
	return result;
}
