import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { readImportMetaHead } from "./importMetaHead";
import { assertSourceWithinRoot } from "./importPathGuard";
import { readSessionSourceHead } from "./sessionSourceHead";

/** Cursor JSONL 行结构不固定，统一按 unknown 读取后再逐字段收窄。 */
export type CursorRecord = Record<string, unknown>;

export type ParsedCursorSession = {
	meta: {
		sessionId: string;
		cwd: string;
		firstTimestamp: number;
		lastTimestamp: number;
	};
	entries: CursorRecord[];
	sourcePath: string;
	sourceSize: number;
	sourceMtime: number;
};

export type CursorImportMeta = {
	sourceMtime: number;
	sourceSize: number;
};

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

/**
 * 项目路径 → Cursor `~/.cursor/projects/<slug>` 目录名。
 * Windows：`F:\PiDeck` → `f-PiDeck`（盘符小写，冒号丢掉，分隔符变 `-`）。
 * POSIX：`/home/u/repo` → `home-u-repo`（去掉前导斜杠）。
 * 与 Claude 的 `C--Users-...`（冒号变双横杠）不是同一套编码。
 */
export function encodeCursorProjectSlug(projectPath: string): string {
	const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
	const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
	if (win) return `${win[1].toLowerCase()}-${win[2].replace(/\//g, "-")}`;
	return normalized.replace(/^\//, "").replace(/\//g, "-");
}

export function getCursorProjectDir(root: string, projectPath: string): string {
	return join(root, encodeCursorProjectSlug(projectPath));
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

export function getCursorTargetPath(piRoot: string, projectPath: string, session: ParsedCursorSession): string {
	const id = session.meta.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
	return join(getProjectSessionDir(piRoot, projectPath), `cursor_${id}.jsonl`);
}

/** 路径逃逸校验：只允许读取 ~/.cursor/projects 之下的会话文件。 */
export function assertCursorSourcePath(root: string, filePath: string): void {
	// 语义校验（resolve 后比较）：词法 startsWith 不解析 `..`（2026-03 导入器安全审计）
	assertSourceWithinRoot(root, filePath, "Cursor");
}

export function sessionIdFromPath(filePath: string): string {
	return basename(filePath).replace(/\.jsonl$/i, "");
}

/**
 * 收集当前项目的主会话 JSONL。
 * 两种布局并存：`<id>/<id>.jsonl`（现行）与 `agent-transcripts/<id>.jsonl`（旧）。
 * `subagents/` 是委派子代理，第一版不导入，避免和父会话重复。
 */
export async function collectCursorTranscripts(projectDir: string): Promise<string[]> {
	const transcriptsDir = join(projectDir, "agent-transcripts");
	let entries;
	try {
		entries = await readdir(transcriptsDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const files: string[] = [];
	for (const entry of entries) {
		const path = join(transcriptsDir, entry.name);
		if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
			files.push(path);
			continue;
		}
		if (!entry.isDirectory() || entry.name === "subagents") continue;
		const nested = join(path, `${entry.name}.jsonl`);
		try {
			const info = await stat(nested);
			if (info.isFile()) files.push(nested);
		} catch {
			// 目录存在但没有同名主转录，跳过
		}
	}
	return files;
}

/** 把一条 Cursor 消息的 text 块拼起来，供抽 user_query / 时间戳。 */
export function joinCursorTextBlocks(content: unknown): string {
	if (typeof content === "string") return content;
	return asArray(content)
		.map((item) => {
			const record = readRecord(item);
			return readString(record.text);
		})
		.filter(Boolean)
		.join("\n");
}

/**
 * 用户可见正文：优先取 `<user_query>` 内的原话。
 * Cursor 会把时间戳、规则、技能、git 状态等注入包在同一条 user 消息里，
 * 那些不是用户打的字；有 user_query 时丢掉包装才是忠实转写。
 * 没有 user_query 时只剥 timestamp，其余原文保留，避免误删。
 */
export function extractCursorUserText(raw: string): string {
	const queries = [...raw.matchAll(/<user_query\b[^>]*>([\s\S]*?)<\/user_query>/gi)].map((match) => match[1].trim()).filter(Boolean);
	if (queries.length > 0) return queries.join("\n\n");
	return raw.replace(/<timestamp\b[^>]*>[\s\S]*?<\/timestamp>/gi, "").trim();
}

/**
 * Cursor 把时钟写在 user 文本的 `<timestamp>` 里，例如
 * `Tuesday, Sep 15, 2026, 4:35 PM (UTC+8)`。V8 不认 `(UTC+8)`，要改成 GMT 偏移。
 */
export function parseCursorClock(value: string): number {
	const trimmed = value.trim();
	if (!trimmed) return 0;
	const direct = Date.parse(trimmed);
	if (Number.isFinite(direct)) return direct;

	const tz = trimmed.match(/\(UTC([+-])(\d{1,2})(?::(\d{2}))?\)\s*$/i);
	let core = trimmed;
	let suffix = "";
	if (tz && tz.index !== undefined) {
		core = trimmed.slice(0, tz.index).trim();
		const hours = tz[2].padStart(2, "0");
		const minutes = (tz[3] ?? "00").padStart(2, "0");
		suffix = ` GMT${tz[1]}${hours}${minutes}`;
	}
	const withOffset = Date.parse(`${core}${suffix}`);
	if (Number.isFinite(withOffset)) return withOffset;
	const withoutWeekday = Date.parse(`${core.replace(/^[A-Za-z]+,\s+/, "")}${suffix}`);
	return Number.isFinite(withoutWeekday) ? withoutWeekday : 0;
}

export function parseCursorTimestampFromText(raw: string): number {
	const match = raw.match(/<timestamp\b[^>]*>([\s\S]*?)<\/timestamp>/i);
	return match ? parseCursorClock(match[1]) : 0;
}

/**
 * 只读头部解析 Cursor 会话元数据（scan 用）。
 *
 * Cursor 的 sessionId 来自**文件路径**、cwd 来自目录结构，两者都不需要读正文；
 * 只有「是否有对话」与时间戳依赖内容，头部足够近似。
 * 这样扫描内存占用与 transcript 体积解耦（源文件可达几十 MB~GB，整读会 abort 主进程）。
 */
export async function readCursorSessionHead(root: string, filePath: string): Promise<ParsedCursorSession> {
	assertCursorSourcePath(root, filePath);
	const { head, size, mtimeMs, truncated } = await readSessionSourceHead(filePath);

	const entries: CursorRecord[] = [];
	for (const line of head.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// 头部截断可能切在行中间：坏行跳过（与 readCursorSession 同策略）
			continue;
		}
		if (parsed && typeof parsed === "object") entries.push(parsed as CursorRecord);
	}

	const sessionId = sessionIdFromPath(filePath);
	if (!sessionId) throw new Error("Missing Cursor session id");

	const timestamps: number[] = [];
	let hasConversation = false;
	for (const entry of entries) {
		const role = readString(entry.role);
		if (role === "user" || role === "assistant") hasConversation = true;
		if (role !== "user") continue;
		const message = readRecord(entry.message);
		const ts = parseCursorTimestampFromText(joinCursorTextBlocks(message.content ?? entry.content));
		if (ts > 0) timestamps.push(ts);
	}
	if (!hasConversation) throw new Error("Missing Cursor session messages");

	const firstTimestamp = timestamps.length > 0 ? Math.min(...timestamps) : mtimeMs;
	// 未截断（头部即全文件）时用真实末次时间戳，列表排序靠它；
	// 截断时头部看不到文件尾，退化用 mtime（比头部最大值更接近真实末次活动）。
	return {
		meta: {
			sessionId,
			cwd: dirname(dirname(filePath)),
			firstTimestamp,
			lastTimestamp: truncated ? mtimeMs : timestamps.length > 0 ? Math.max(...timestamps) : mtimeMs,
		},
		entries,
		sourcePath: filePath,
		sourceSize: size,
		sourceMtime: mtimeMs,
	};
}

/** 读取导入产物头部的 import 标记（有界读头部，不再整读会话文件——见 importMetaHead）。 */
export async function readCursorImportMeta(targetPath: string): Promise<CursorImportMeta | undefined> {
	return readImportMetaHead(targetPath, "cursor_import");
}

export async function ensureProjectSessionDir(piRoot: string, projectPath: string) {
	const dir = getProjectSessionDir(piRoot, projectPath);
	await mkdir(dir, { recursive: true });
	return dir;
}
