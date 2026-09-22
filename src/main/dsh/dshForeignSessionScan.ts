import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import type { DshForeignSessionItem } from "./dshForeignSync";
import { readSessionProjectionTitles } from "./dshProjectionCache";
import { findDshSessionLogFile } from "./dshSessionPath";
import { consumeTitleEvent, resolveFoldedTitle, type LoggedTitleFold } from "./dshSessionTitleFold";

/**
 * 从 DSH_HOME 磁盘只读扫描外部根会话（不启动 host、不 attach、不写文件）。
 *
 * 为什么不走 host `sessions.list` / `sessions.history`：
 * - DSH 官方不支持同一 DSH_HOME 双 host；PiDeck 再 fork 会写 `.pideck-host.lock`，
 *   并对冷会话打 history（相当于 attach），会把 dsh-web 正在用的 session log 抢走/覆盖。
 * - 用户要的是「启动侧栏就有会话」，不是「先把 host 拉起来再手动导入」。
 *
 * 布局与 `@deepseek-ai/dsh-session-persistence-jsonl` 一致：
 * `$DSH_HOME/sessions/<workspaceDir>/<sessionId>/session[.vN].jsonl[.zstd]`（日志文件名带
 * 「格式代」，v0 无版本名、v1+ 带 `vN`；发现逻辑复用 dshSessionPath.findDshSessionLogFile）。
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
/** 单帧解压输出上限（内存硬边界）：zstd 帧自带可声明的 contentSize，实测 339 字节的帧能
 *  解出 10MB（构造/损坏文件在主进程里就是内存尖峰）。日志帧是「一次追加」的增量，
 *  8MiB 已远超正常单帧；超限时 zlib 抛 ERR_BUFFER_TOO_LARGE，被现有 try/catch 当作
 *  帧损坏处理（调用方降级/跳过），不会解出半个 GB 才 OOM。 */
const MAX_FRAME_OUTPUT_BYTES = 8 * 1024 * 1024;
/** 只读 header 的前缀上限：首帧通常只有 header 行（每追加一次一个帧），64KiB 足够。
 *  目的是让「只要 id/归属、不要标题」的扫描（侧栏清单命中投影缓存时）不读满 256KiB。 */
const HEADER_READ_LIMIT = 64 * 1024;

/**
 * 是否折叠日志标题（CPU 开关）：折叠要读前缀并逐帧解压，是扫描里最贵的一步。
 * - 省略：不折叠——扫描 id/归属的调用方（`DshHost.listSessionIds`）不该为标题买单；
 * - `true`：无条件折叠（导入单个会话、归档区列标题）；
 * - 函数：按会话判定（清单场景：只有官方投影缓存未覆盖的冷会话才回退到日志折叠）。
 */
export type FoldTitleOption = boolean | ((sessionId: string) => boolean);

/** 折叠开关判定（缺省视为不折叠）。 */
function wantsFoldedTitle(option: FoldTitleOption | undefined, sessionId: string): boolean {
	if (option === true) return true;
	if (typeof option === "function") return option(sessionId);
	return false;
}

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
export function scanDshSessionHeaders(dshHome: string, options: { foldTitle?: FoldTitleOption } = {}): ScannedDshSessionHeader[] {
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
			const header = readSessionHeader(join(workspacePath, sessionDir), options.foldTitle);
			if (header) found.push(header);
		}
	}
	return found;
}

/** 外部根会话清单：磁盘扫描 + 根会话过滤 + 投影缓存标题 + 日志折叠补全。 */
export function listForeignSessionsFromDisk(dshHome: string): DshForeignSessionItem[] {
	const titles = readSessionProjectionTitles(dshHome);
	// 缓存是 dsh-web 热路径，且大多数外部会话都在缓存里；只有缓存没覆盖的冷会话才读日志前缀
	// 折叠标题（命中时连 64KiB 以外的字节都不读、后续帧也不解压）。
	return scanDshSessionHeaders(dshHome, { foldTitle: (sessionId) => !titles.has(sessionId) })
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
 * sessions 树同构——同目录名/同 session[.vN].jsonl[.zstd] 布局）。
 * 只读 header/前缀，不启动 host、不写缓存；无日志/折叠失败返回 undefined。
 */
export function foldSessionTitleFromDir(sessionDir: string): string | undefined {
	const header = readSessionHeader(sessionDir, true);
	return header?.loggedTitle;
}

/** 读单个会话目录的 header；按实际 generation 取日志（v1+ 优先），无日志返回 undefined。 */
function readSessionHeader(sessionDir: string, foldTitle?: FoldTitleOption): ScannedDshSessionHeader | undefined {
	const log = findDshSessionLogFile(sessionDir);
	if (!log) return undefined;
	return log.compressed ? readZstdHeader(log.path, foldTitle) : readJsonlHeader(log.path, foldTitle);
}

function readZstdHeader(filePath: string, foldTitle: FoldTitleOption | undefined): ScannedDshSessionHeader | undefined {
	// 两段式读：先只读 header 帧（64KiB），确实需要折叠标题时才补读到 256KiB。
	// 只需要 id/归属的扫描因此既不读满前缀，也不解压第二帧起的任何数据。
	let prefix = readFilePrefix(filePath, HEADER_READ_LIMIT);
	if (!prefix) return undefined;
	let headerEnd = firstZstdFrameEnd(prefix.bytes);
	if (headerEnd === undefined && prefix.bytes.length < TITLE_LOG_READ_LIMIT) {
		// 小会话可能整体写在一帧里（header + 正文同帧）：小前缀装不下就退到大前缀。
		// 读得少绝不能变成丢会话，所以这里必须再试一次而不是直接返回 undefined。
		prefix = readFilePrefix(filePath, TITLE_LOG_READ_LIMIT) ?? prefix;
		headerEnd = firstZstdFrameEnd(prefix.bytes);
	}
	if (headerEnd === undefined) return undefined;
	let header: ScannedDshSessionHeader | undefined;
	try {
		const plain = zstdDecompressSync(prefix.bytes.subarray(0, headerEnd), { maxOutputLength: MAX_FRAME_OUTPUT_BYTES });
		header = parseHeaderLine(plain.toString("utf8"), prefix.mtimeMs);
	} catch {
		return undefined;
	}
	if (!header) return undefined;
	if (!wantsFoldedTitle(foldTitle, header.id)) return header;
	// 折叠要完整前缀：上面为拿 header 可能只读了小前缀，这里补满，否则标题事件落在
	// 64KiB 之后就会漏（标题通常紧跟首条提示，但窗口不能因此悄悄收窄）。
	const foldPrefix = prefix.bytes.length >= TITLE_LOG_READ_LIMIT ? prefix : (readFilePrefix(filePath, TITLE_LOG_READ_LIMIT) ?? prefix);
	const loggedTitle = foldTitleFromZstdPrefix(foldPrefix.bytes);
	return loggedTitle ? { ...header, loggedTitle } : header;
}

function readJsonlHeader(filePath: string, foldTitle: FoldTitleOption | undefined): ScannedDshSessionHeader | undefined {
	const prefix = readFilePrefix(filePath, TITLE_LOG_READ_LIMIT);
	if (!prefix) return undefined;
	const text = prefix.bytes.toString("utf8");
	const header = parseHeaderLine(text, prefix.mtimeMs);
	if (!header) return undefined;
	if (!wantsFoldedTitle(foldTitle, header.id)) return header;
	const loggedTitle = foldTitleFromJsonlPrefix(text);
	return loggedTitle ? { ...header, loggedTitle } : header;
}

/** 只读 zstd 前缀里的完整帧，按官方 last-wins 折叠标题。 */
function foldTitleFromZstdPrefix(buffer: Buffer): string | undefined {
	const state: LoggedTitleFold = {};
	let offset = 0;
	// CPU 边界：循环被前缀长度（≤256KiB）封顶，且解压失败即 break——
	// 构造的大帧最多让循环多试一次就退出，不会逐帧解到底。
	while (offset < buffer.length) {
		const frameEnd = firstZstdFrameEnd(buffer.subarray(offset));
		if (frameEnd === undefined) break;
		try {
			const plain = zstdDecompressSync(buffer.subarray(offset, offset + frameEnd), { maxOutputLength: MAX_FRAME_OUTPUT_BYTES }).toString("utf8");
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
function readFilePrefix(filePath: string, limit: number): { bytes: Buffer; mtimeMs: number } | undefined {
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
			try {
				closeSync(fd);
			} catch {
				/* 关闭失败不阻断扫描 */
			}
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
		...(typeof record.parentSession === "string" && record.parentSession ? { parentSession: record.parentSession } : {}),
		...(typeof record.delegationDepth === "number" && Number.isFinite(record.delegationDepth) ? { delegationDepth: record.delegationDepth } : {}),
		// 会话「模式」随 header 持久化（dsh-session-persistence-jsonl 的 HeaderLine.agentPreset）
		...(typeof record.agentPreset === "string" && record.agentPreset ? { agentPreset: record.agentPreset } : {}),
	};
}
