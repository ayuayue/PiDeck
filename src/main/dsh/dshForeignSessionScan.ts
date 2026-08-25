import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
// 相对导入统一带 .ts 后缀：本模块会被 cloudSync 的 CloudSyncScanner 直接 import
// （Node type-stripping 下 ESM 相对导入必须带扩展名），与全仓 allowImportingTsExtensions 风格一致。
import type { DshForeignSessionItem } from "./dshForeignSync.ts";
import { readSessionProjectionTitles } from "./dshProjectionCache.ts";
import {
	consumeTitleEvent,
	resolveFoldedTitle,
	type LoggedTitleFold,
} from "./dshSessionTitleFold.ts";

/**
 * 从 DSH_HOME 磁盘只读扫描外部根会话（不启动 host、不 attach、不写文件）。
 *
 * 为什么不走 host `sessions.list` / `sessions.history`：
 * - DSH 官方不支持同一 DSH_HOME 双 host；PiDeck 再 fork 会写 `.pideck-host.lock`，
 *   并对冷会话打 history（相当于 attach），会把 dsh-web 正在用的 session log 抢走/覆盖。
 * - 用户要的是「启动侧栏就有会话」，不是「先把 host 拉起来再手动导入」。
 *
 * 布局与 `@deepseek-ai/dsh-session-persistence-jsonl` 一致：
 * `$DSH_HOME/sessions/<workspaceDir>/<sessionId>/session.jsonl.zstd`（或未压缩 `.jsonl`）。
 * 只读 header 帧/首行：`{ type:'session', id, cwd?, origin?, parentSession?, delegationDepth? }`。
 * 标题不在 header 里。优先官方投影缓存 `session_projcache`；缓存未覆盖的冷会话
 * 再只读日志前缀，按 `foldSessionTitle` last-wins 取 `session/title`，
 * 没有事件则用首条真人提示做与 dsh-base 相同的 5 词 / 40 字节回退。
 * 不启动 host、不写缓存、不 attach——首次安装也不能把侧栏铺满「DSH 会话」。
 */

/** 与 dsh-session-persistence-jsonl 相同的 Zstandard magic（小端 0xFD2FB528）。 */
const ZSTD_MAGIC = 4_247_762_216;
/** 标题事件紧跟首条 user/message；256KiB 足够覆盖冷会话前缀，绝不读整段多 MB 日志。 */
const TITLE_LOG_READ_LIMIT = 256 * 1024;

/** 磁盘 header 的最小字段（只取过滤/归属需要的）。 */
export type ScannedDshSessionHeader = {
	id: string;
	cwd?: string;
	origin?: string;
	parentSession?: string;
	delegationDepth?: number;
	/** 会话创建时组合的 agent preset（header passthrough；随导入落 catalog）。 */
	agentPreset?: string;
	/** 日志文件 mtime（ms）；list 投影没有 title 时当 updatedAt）。 */
	updatedAt: number;
	/** 日志折叠标题（缓存未命中时的官方 session/title 或首条提示回退）。 */
	loggedTitle?: string;
};

/**
 * 根会话判定（与 DshHost.listForeignSessions 的 host 过滤对齐）：
 * subagent / 带 parent / delegationDepth>0 都不是用户侧栏该直接打开的「外部会话」。
 */
export function isForeignRootSession(header: ScannedDshSessionHeader): boolean {
	if (header.origin === "subagent") return false;
	if (header.parentSession) return false;
	if ((header.delegationDepth ?? 0) > 0) return false;
	return Boolean(header.id);
}

/** 扫描 DSH_HOME/sessions 下全部带合法 header 的会话（含子代理；只读）。 */
export function scanDshSessionHeaders(dshHome: string): ScannedDshSessionHeader[] {
	const sessionsRoot = join(dshHome, "sessions");
	if (!existsSync(sessionsRoot)) return [];
	let workspaceDirs: string[];
	try {
		workspaceDirs = readdirSync(sessionsRoot, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name);
	} catch {
		return [];
	}
	const found: ScannedDshSessionHeader[] = [];
	for (const workspaceDir of workspaceDirs) {
		const workspacePath = join(sessionsRoot, workspaceDir);
		let sessionDirs: string[];
		try {
			sessionDirs = readdirSync(workspacePath, { withFileTypes: true })
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name);
		} catch {
			continue;
		}
		for (const sessionDir of sessionDirs) {
			const header = readSessionHeader(join(workspacePath, sessionDir));
			if (header) found.push(header);
		}
	}
	return found;
}

/** 外部根会话清单：磁盘扫描 + 根会话过滤 + 投影缓存标题 + 日志折叠补全。 */
export function listForeignSessionsFromDisk(dshHome: string): DshForeignSessionItem[] {
	const titles = readSessionProjectionTitles(dshHome);
	return scanDshSessionHeaders(dshHome)
		.filter(isForeignRootSession)
		.map((header) => {
			// 缓存是 dsh-web 热路径；冷会话常缺行，必须再用日志折叠，否则首次安装全是占位名。
			const title = titles.get(header.id) ?? header.loggedTitle;
			return {
				dshSessionId: header.id,
				...(header.cwd ? { cwd: header.cwd } : {}),
				...(title ? { title } : {}),
				// 会话「模式」：磁盘 header 持久化的 agentPreset（外部会话导入后头部即可展示）
				...(header.agentPreset ? { agentPreset: header.agentPreset } : {}),
				updatedAt: header.updatedAt,
			};
		});
}

/**
 * 从单个会话目录只读折叠标题（归档区复用：.pideck-archive/<sessionId>/ 与
 * sessions 树同构——同目录名/同 session.jsonl[.zstd] 布局）。
 * 只读 header/前缀，不启动 host、不写缓存；无日志/折叠失败返回 undefined。
 */
export function foldSessionTitleFromDir(sessionDir: string): string | undefined {
	const header = readSessionHeader(sessionDir);
	return header?.loggedTitle;
}

/** 读单个会话目录的 header；优先 zstd，其次未压缩 jsonl。读失败/损坏返回 undefined。 */
function readSessionHeader(sessionDir: string): ScannedDshSessionHeader | undefined {
	const zstdPath = join(sessionDir, "session.jsonl.zstd");
	if (existsSync(zstdPath)) return readZstdHeader(zstdPath);
	const jsonlPath = join(sessionDir, "session.jsonl");
	if (existsSync(jsonlPath)) return readJsonlHeader(jsonlPath);
	return undefined;
}

function readZstdHeader(filePath: string): ScannedDshSessionHeader | undefined {
	const prefix = readFilePrefix(filePath, TITLE_LOG_READ_LIMIT);
	if (!prefix) return undefined;
	const headerEnd = firstZstdFrameEnd(prefix.bytes);
	if (headerEnd === undefined) return undefined;
	let header: ScannedDshSessionHeader | undefined;
	try {
		const plain = zstdDecompressSync(prefix.bytes.subarray(0, headerEnd));
		header = parseHeaderLine(plain.toString("utf8"), prefix.mtimeMs);
	} catch {
		return undefined;
	}
	if (!header) return undefined;
	const loggedTitle = foldTitleFromZstdPrefix(prefix.bytes);
	return loggedTitle ? { ...header, loggedTitle } : header;
}

function readJsonlHeader(filePath: string): ScannedDshSessionHeader | undefined {
	const prefix = readFilePrefix(filePath, TITLE_LOG_READ_LIMIT);
	if (!prefix) return undefined;
	const header = parseHeaderLine(prefix.bytes.toString("utf8"), prefix.mtimeMs);
	if (!header) return undefined;
	const loggedTitle = foldTitleFromJsonlPrefix(prefix.bytes.toString("utf8"));
	return loggedTitle ? { ...header, loggedTitle } : header;
}

/** 只读 zstd 前缀里的完整帧，按官方 last-wins 折叠标题。 */
function foldTitleFromZstdPrefix(buffer: Buffer): string | undefined {
	const state: LoggedTitleFold = {};
	let offset = 0;
	while (offset < buffer.length) {
		const frameEnd = firstZstdFrameEnd(buffer.subarray(offset));
		if (frameEnd === undefined) break;
		try {
			const plain = zstdDecompressSync(buffer.subarray(offset, offset + frameEnd)).toString("utf8");
			for (const line of plain.split(/\r?\n/)) consumeTitleEvent(line, state);
		} catch {
			break;
		}
		offset += frameEnd;
		// 已经 fold 到 session/title 就停：后面全是回合正文，不必再解。
		if (state.title) break;
	}
	return resolveFoldedTitle(state);
}

function foldTitleFromJsonlPrefix(text: string): string | undefined {
	const state: LoggedTitleFold = {};
	for (const line of text.split(/\r?\n/)) {
		consumeTitleEvent(line, state);
		if (state.title) break;
	}
	return resolveFoldedTitle(state);
}

/** 只读文件前缀 + mtime（不把整段会话日志读进内存）。 */
function readFilePrefix(
	filePath: string,
	limit: number,
): { bytes: Buffer; mtimeMs: number } | undefined {
	let fd: number | undefined;
	try {
		const stat = statSync(filePath);
		if (!stat.isFile() || stat.size <= 0) return undefined;
		fd = openSync(filePath, "r");
		const bytes = Buffer.alloc(Math.min(limit, stat.size));
		const n = readSync(fd, bytes, 0, bytes.length, 0);
		if (n <= 0) return undefined;
		return { bytes: bytes.subarray(0, n), mtimeMs: stat.mtimeMs };
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try { closeSync(fd); } catch { /* 关闭失败不阻断扫描 */ }
		}
	}
}

/**
 * 定位第一个完整 Zstandard frame 的结尾（与 persistence-jsonl `scanZstdFrames(..., 1)` 同构）。
 * 帧不完整或 magic 不对返回 undefined——调用方跳过该会话，绝不截断/修复文件。
 */
export function firstZstdFrameEnd(buffer: Buffer): number | undefined {
	if (buffer.length < 5) return undefined;
	if (buffer.readUInt32LE(0) !== ZSTD_MAGIC) return undefined;
	let offset = 4;
	const descriptor = buffer.readUInt8(offset);
	offset += 1;
	if ((descriptor & 24) !== 0) return undefined;
	const contentSizeFlag = descriptor >>> 6;
	const singleSegment = (descriptor & 32) !== 0;
	const checksum = (descriptor & 4) !== 0;
	const dictionaryFlag = descriptor & 3;
	const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
	const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
	const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
	if (buffer.length - offset < remainingHeaderBytes) return undefined;
	offset += remainingHeaderBytes;
	for (;;) {
		if (buffer.length - offset < 3) return undefined;
		const blockHeader = buffer.readUIntLE(offset, 3);
		offset += 3;
		const lastBlock = (blockHeader & 1) !== 0;
		const blockType = (blockHeader >>> 1) & 3;
		const blockSize = blockHeader >>> 3;
		if (blockType === 3) return undefined;
		const payloadBytes = blockType === 1 ? 1 : blockSize;
		if (buffer.length - offset < payloadBytes) return undefined;
		offset += payloadBytes;
		if (lastBlock) break;
	}
	if (checksum) {
		if (buffer.length - offset < 4) return undefined;
		offset += 4;
	}
	return offset;
}

/** 解析 header 行：第一行必须是 `type: session` 且带 id；其余字段按可选处理。 */
export function parseHeaderLine(text: string, updatedAt: number): ScannedDshSessionHeader | undefined {
	const line = text.split(/\r?\n/, 1)[0]?.trim();
	if (!line) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== "object") return undefined;
	const record = parsed as Record<string, unknown>;
	if (record.type !== "session" || typeof record.id !== "string" || !record.id.trim()) {
		return undefined;
	}
	return {
		id: record.id.trim(),
		updatedAt,
		...(typeof record.cwd === "string" && record.cwd ? { cwd: record.cwd } : {}),
		...(typeof record.origin === "string" && record.origin ? { origin: record.origin } : {}),
		...(typeof record.parentSession === "string" && record.parentSession
			? { parentSession: record.parentSession }
			: {}),
		...(typeof record.delegationDepth === "number" && Number.isFinite(record.delegationDepth)
			? { delegationDepth: record.delegationDepth }
			: {}),
		// 会话「模式」随 header 持久化（dsh-session-persistence-jsonl 的 HeaderLine.agentPreset）
		...(typeof record.agentPreset === "string" && record.agentPreset
			? { agentPreset: record.agentPreset }
			: {}),
	};
}
