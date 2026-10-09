import { mkdir, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { normalizeImportedToolArguments } from "./importToolArguments";
import { assertSourceWithinRoot } from "./importPathGuard";
import { readImportMetaHead } from "./importMetaHead";
import { readSessionSourceHead } from "./sessionSourceHead";

/** WorkBuddy 的 JSONL 行结构不固定，统一按 unknown 读取后再逐字段收窄。 */
export type WorkBuddyRecord = Record<string, unknown>;

export type ParsedWorkBuddySession = {
	meta: {
		sessionId: string;
		cwd: string;
		firstTimestamp: number;
		lastTimestamp: number;
		modelId: string;
		aiTitle: string;
	};
	entries: WorkBuddyRecord[];
	sourcePath: string;
	sourceSize: number;
	sourceMtime: number;
};

export type WorkBuddyImportMeta = {
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
 * 项目路径 → WorkBuddy 目录名：盘符小写，所有分隔符转 '-'，其余大小写保留。
 * 例：D:\project\github\pi-desktop → d-project-github-pi-desktop
 */
export function getWorkBuddyProjectDir(root: string, projectPath: string): string {
	const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
	const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
	const slug = win ? `${win[1].toLowerCase()}-${win[2].replace(/\//g, "-")}` : normalized.replace(/^\//, "").replace(/\//g, "-");
	return join(root, slug);
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

export function getWorkBuddyTargetPath(piRoot: string, projectPath: string, session: ParsedWorkBuddySession): string {
	const id = session.meta.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
	return join(getProjectSessionDir(piRoot, projectPath), `workbuddy_${id}.jsonl`);
}

/** 路径逃逸校验：只允许读取 ~/.workbuddy/projects 之下的会话文件。 */
export function assertWorkBuddySourcePath(root: string, filePath: string): void {
	// 语义校验（resolve 后比较）：词法 startsWith 不解析 `..`（2026-03 导入器安全审计）
	assertSourceWithinRoot(root, filePath, "WorkBuddy");
}

export function sessionIdFromPath(filePath: string): string {
	return basename(filePath).replace(/\.jsonl$/i, "");
}

/** 从 providerData 中取模型标识，取不到时逐层回退。 */
export function readWorkBuddyModel(entry: WorkBuddyRecord): string {
	const data = readRecord(entry.providerData);
	return readString(data.model) || readString(data.requestModelId) || readString(data.requestModelName);
}

export async function collectWorkBuddyJsonl(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				files.push(...(await collectWorkBuddyJsonl(path)));
			} else if (
				entry.isFile() &&
				entry.name.endsWith(".jsonl") &&
				// file-rollback 是撤销用的快照流，不是会话正文，导入时必须排除。
				!entry.name.endsWith(".file-rollback.ndjson")
			) {
				files.push(path);
			}
		}
		return files;
	} catch {
		return [];
	}
}

/**
 * 只读头部解析 WorkBuddy 会话元数据（scan 用）。
 *
 * 与 readWorkBuddySession 的差异：不把整文件读成字符串，内存占用与文件体积解耦；
 * entries 只含头部区间，摘要字段因此是近似值（与 Codex head-only 扫描同口径）。
 * 时间戳：firstTimestamp 取头部最早，lastTimestamp 用 mtime（头部看不到文件尾）。
 */
export async function readWorkBuddySessionHead(root: string, filePath: string): Promise<ParsedWorkBuddySession> {
	assertWorkBuddySourcePath(root, filePath);
	const { head, size, mtimeMs, truncated } = await readSessionSourceHead(filePath);

	const entries: WorkBuddyRecord[] = [];
	for (const line of head.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// 头部截断可能切在行中间：坏行跳过（与 readWorkBuddySessionHead 同策略）
			continue;
		}
		if (parsed && typeof parsed === "object") entries.push(parsed as WorkBuddyRecord);
	}

	const withId = entries.find((entry) => readString(entry.sessionId));
	const sessionId = withId ? readString(withId.sessionId) : sessionIdFromPath(filePath);
	const cwd = withId ? readString(withId.cwd) : "";
	const timestamps = entries.map((entry) => readNumber(entry.timestamp)).filter((value) => value > 0);
	if (timestamps.length === 0) throw new Error("Missing WorkBuddy session metadata");

	let modelId = "";
	let aiTitle = "";
	for (const entry of entries) {
		if (!modelId) {
			const model = readWorkBuddyModel(entry);
			if (model) modelId = model;
		}
		if (!aiTitle && readString(entry.type) === "ai-title") {
			aiTitle = readString(entry.aiTitle);
		}
	}

	return {
		meta: {
			sessionId,
			cwd,
			firstTimestamp: Math.min(...timestamps),
			// 未截断（头部即全文件）时用真实末次时间戳，列表排序靠它；
			// 截断时头部看不到文件尾，退化用 mtime。
			lastTimestamp: truncated ? mtimeMs : Math.max(...timestamps),
			modelId,
			aiTitle,
		},
		entries,
		sourcePath: filePath,
		sourceSize: size,
		sourceMtime: mtimeMs,
	};
}

/** 读取导入产物头部的 import 标记（有界读头部，不再整读会话文件——见 importMetaHead）。 */
export async function readWorkBuddyImportMeta(targetPath: string): Promise<WorkBuddyImportMeta | undefined> {
	return readImportMetaHead(targetPath, "workbuddy_import");
}

export async function ensureProjectSessionDir(piRoot: string, projectPath: string) {
	const dir = getProjectSessionDir(piRoot, projectPath);
	await mkdir(dir, { recursive: true });
	return dir;
}

/** 移除平台注入的 <system-reminder> 上下文块，只保留用户真实输入。 */
export function stripInjectedContext(value: string): string {
	return (
		value
			.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
			.replace(/<system-reminder\b[^>]*\/>/gi, "")
			// WorkBuddy 还会把用户输入整体包进 <user_query>，标签本身不是正文，去壳留内容。
			.replace(/<\/?user_query>/gi, "")
			.trim()
	);
}

/** function_call.arguments 是 JSON 字符串；解析失败时保留原文而不是丢掉整次调用。 */
export function parseWorkBuddyArguments(value: unknown): Record<string, unknown> {
	return normalizeImportedToolArguments(value);
}
