import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { readImportMetaHead } from "./importMetaHead";
import { assertSourceWithinRoot } from "./importPathGuard";
import { readSessionSourceHead, readJsonlObjects } from "./sessionSourceHead";

/** Kimi Code 的 wire.jsonl / session_index.jsonl 行结构不固定，统一按 unknown 读取后再逐字段收窄。 */
export type KimiRecord = Record<string, unknown>;

/** session_index.jsonl 一行：全局索引里的会话指针。 */
export type KimiIndexEntry = {
	sessionId: string;
	sessionDir: string;
	workDir: string;
};

export type ParsedKimiSession = {
	meta: {
		sessionId: string;
		cwd: string;
		/** state.json 的 title（可能为空，空时回退 lastPrompt，再空回退首条 user 消息） */
		title: string;
		lastPrompt: string;
		firstTimestamp: number;
		lastTimestamp: number;
	};
	/** wire.jsonl 头部记录（scan 摘要用，体积有上界） */
	entries: KimiRecord[];
	/** 源文件 = wire.jsonl 绝对路径（活跃会话会持续追加它，mtime/size 即新鲜度判据） */
	sourcePath: string;
	sourceSize: number;
	sourceMtime: number;
};

export type KimiImportMeta = {
	sourceMtime: number;
	sourceSize: number;
};

/**
 * state.json 读取上限。它是单条 JSON 文档（含 agents 索引），正常只有几 KB；
 * 设 256KB 上限防异常膨胀，截断时按解析失败处理（元数据全部回退）。
 */
export const KIMI_STATE_HEAD_BYTES = 256 * 1024;

export function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

export function readString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

export function readNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

export function readRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function normalizePath(path?: string): string {
	return String(path ?? "")
		.replace(/\\/g, "/")
		.replace(/\/+$/, "")
		.toLowerCase();
}

export function safePathToken(path: string): string {
	const normalized = path.replace(/\\/g, "/");
	const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
	if (win) return `--${win[1]}--${win[2].replace(/\//g, "-")}--`;
	return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`;
}

export function getProjectSessionDir(piRoot: string, projectPath: string): string {
	return join(piRoot, safePathToken(projectPath));
}

export function getKimiTargetPath(piRoot: string, projectPath: string, session: ParsedKimiSession): string {
	const id = session.meta.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
	return join(getProjectSessionDir(piRoot, projectPath), `kimi_${id}.jsonl`);
}

/** 路径逃逸校验：只允许读取 ~/.kimi-code 之下的会话文件（sessionDir 来自索引，不可信）。 */
export function assertKimiSourcePath(root: string, filePath: string): void {
	// 语义校验（resolve 后比较）：词法 startsWith 不解析 `..`（2026-03 导入器安全审计）
	assertSourceWithinRoot(root, filePath, "Kimi");
}

export function kimiWirePath(sessionDir: string): string {
	return join(sessionDir, "agents", "main", "wire.jsonl");
}

export function kimiStatePath(sessionDir: string): string {
	return join(sessionDir, "state.json");
}

/** wire.jsonl 固定位于 <sessionDir>/agents/main/wire.jsonl，向上三级即会话目录。 */
export function kimiSessionDirFromWirePath(wirePath: string): string {
	return dirname(dirname(dirname(wirePath)));
}

/**
 * 读取全局索引 session_index.jsonl（有界头部 + 逐行容错）。
 * 索引由 Kimi Code 追加维护，可能正在写入：坏行/截断行跳过，不让一行坏数据废掉整个列表。
 */
export async function readKimiSessionIndex(root: string): Promise<KimiIndexEntry[]> {
	const indexPath = join(root, "session_index.jsonl");
	let head: string;
	try {
		({ head } = await readSessionSourceHead(indexPath));
	} catch {
		// 索引不存在 = 没装过 Kimi Code 或没有会话，按空列表处理
		return [];
	}

	const entries: KimiIndexEntry[] = [];
	for (const line of head.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}
		const record = readRecord(parsed);
		const sessionDir = readString(record.sessionDir);
		if (!sessionDir) continue;
		entries.push({
			sessionId: readString(record.sessionId),
			sessionDir,
			workDir: readString(record.workDir),
		});
	}
	return entries;
}

/** 解析 state.json（有界读取；文件缺失/截断/损坏时返回空记录，由调用方回退）。 */
export async function readKimiSessionState(sessionDir: string): Promise<Record<string, unknown>> {
	try {
		const { head } = await readSessionSourceHead(kimiStatePath(sessionDir), KIMI_STATE_HEAD_BYTES);
		return readRecord(JSON.parse(head));
	} catch {
		return {};
	}
}

/** wire 头部记录里的时间戳（毫秒），供元数据回退用。 */
function wireHeadTimestamps(entries: KimiRecord[]): number[] {
	return entries.map((entry) => readNumber(entry.time)).filter((value) => value > 0);
}

/**
 * 只读头部解析 Kimi Code 会话元数据（scan 用）。
 *
 * 元数据来源：同目录 state.json（小文件，有界读取）+ wire.jsonl 头部（上限
 * SESSION_SCAN_HEAD_BYTES）。内存占用与 wire 体积解耦——活跃会话的 wire 可能
 * 持续增大，整读会 abort 主进程（见 sessionSourceHead 头部注释）。
 */
export async function readKimiSessionHead(root: string, wirePath: string): Promise<ParsedKimiSession> {
	assertKimiSourcePath(root, wirePath);
	const sessionDir = kimiSessionDirFromWirePath(wirePath);
	const state = await readKimiSessionState(sessionDir);
	const { head, size, mtimeMs, truncated } = await readSessionSourceHead(wirePath);

	const entries: KimiRecord[] = [];
	for (const line of head.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// 头部截断可能切在行中间（且源文件可能正被活跃会话追加）：坏行跳过
			continue;
		}
		if (parsed && typeof parsed === "object") entries.push(parsed as KimiRecord);
	}

	const sessionId = readString(state.id);
	if (!sessionId) throw new Error("Missing Kimi session id");

	const timestamps = wireHeadTimestamps(entries);
	const firstTimestamp = readNumber(state.createdAt) || (timestamps.length > 0 ? Math.min(...timestamps) : mtimeMs);
	// 未截断（头部即全文件）时用真实末次时间戳，列表排序靠它；
	// 截断时头部看不到文件尾，退化用 state.updatedAt / mtime。
	const lastTimestamp = readNumber(state.updatedAt) || (truncated ? mtimeMs : timestamps.length > 0 ? Math.max(...timestamps) : mtimeMs);

	return {
		meta: {
			sessionId,
			cwd: readString(state.cwd),
			title: readString(state.title),
			lastPrompt: readString(state.lastPrompt),
			firstTimestamp,
			lastTimestamp,
		},
		entries,
		sourcePath: wirePath,
		sourceSize: size,
		sourceMtime: mtimeMs,
	};
}

/**
 * 逐行流式读取 wire.jsonl，产出已解析的对象（导入路径用，内存 O(单行)）。
 *
 * 与 sessionSourceHead.readJsonlObjects 的关键差异：**坏行跳过而非抛错**。
 * wire.jsonl 可能正被活跃会话追加（最后一行写了一半），严格模式会把
 * 「导入到一半遇到半行」变成整个会话导入失败；这里选择容忍坏行、保住其余内容。
 */
export async function* readKimiWireObjects(filePath: string): AsyncGenerator<KimiRecord> {
	// 经 readJsonlObjects（宽容模式：坏行/半行跳过 + 64MiB 单行防线，裸 readline 会无界缓冲）
	for await (const record of readJsonlObjects(filePath, { skipBadLines: true })) {
		yield record as KimiRecord;
	}
}

/** 读取导入产物头部的 import 标记（有界读头部，不再整读会话文件——见 importMetaHead）。 */
export async function readKimiImportMeta(targetPath: string): Promise<KimiImportMeta | undefined> {
	return readImportMetaHead(targetPath, "kimi_import");
}

export async function ensureProjectSessionDir(piRoot: string, projectPath: string) {
	const dir = getProjectSessionDir(piRoot, projectPath);
	await mkdir(dir, { recursive: true });
	return dir;
}
