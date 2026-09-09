import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

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
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
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
	const slug = win
		? `${win[1].toLowerCase()}-${win[2].replace(/\//g, "-")}`
		: normalized.replace(/^\//, "").replace(/\//g, "-");
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

export function getWorkBuddyTargetPath(
	piRoot: string,
	projectPath: string,
	session: ParsedWorkBuddySession,
): string {
	const id = session.meta.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
	return join(getProjectSessionDir(piRoot, projectPath), `workbuddy_${id}.jsonl`);
}

/** 路径逃逸校验：只允许读取 ~/.workbuddy/projects 之下的会话文件。 */
export function assertWorkBuddySourcePath(root: string, filePath: string): void {
	const base = normalizePath(root);
	const target = normalizePath(filePath);
	if (target !== base && !target.startsWith(`${base}/`)) {
		throw new Error("WorkBuddy session path is outside ~/.workbuddy/projects");
	}
}

export function sessionIdFromPath(filePath: string): string {
	return basename(filePath).replace(/\.jsonl$/i, "");
}

/** 从 providerData 中取模型标识，取不到时逐层回退。 */
export function readWorkBuddyModel(entry: WorkBuddyRecord): string {
	const data = readRecord(entry.providerData);
	return (
		readString(data.model) ||
		readString(data.requestModelId) ||
		readString(data.requestModelName)
	);
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

export async function readWorkBuddySession(
	root: string,
	filePath: string,
): Promise<ParsedWorkBuddySession> {
	assertWorkBuddySourcePath(root, filePath);
	const [raw, info] = await Promise.all([readFile(filePath, "utf8"), stat(filePath)]);
	const entries: WorkBuddyRecord[] = [];
	for (const line of raw.split(/\r?\n/)) {
		if (!line.trim()) continue;
		const parsed: unknown = JSON.parse(line);
		if (parsed && typeof parsed === "object") entries.push(parsed as WorkBuddyRecord);
	}

	const withId = entries.find((entry) => readString(entry.sessionId));
	const sessionId = withId ? readString(withId.sessionId) : sessionIdFromPath(filePath);
	const cwd = withId ? readString(withId.cwd) : "";
	const timestamps = entries
		.map((entry) => readNumber(entry.timestamp))
		.filter((value) => value > 0);
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
			lastTimestamp: Math.max(...timestamps),
			modelId,
			aiTitle,
		},
		entries,
		sourcePath: filePath,
		sourceSize: info.size,
		sourceMtime: info.mtimeMs,
	};
}

export async function readWorkBuddyImportMeta(
	targetPath: string,
): Promise<WorkBuddyImportMeta | undefined> {
	try {
		const raw = await readFile(targetPath, "utf8");
		for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 8)) {
			const entry = JSON.parse(line) as WorkBuddyRecord;
			if (readString(entry.type) === "workbuddy_import") {
				return {
					sourceMtime: readNumber(entry.sourceMtime),
					sourceSize: readNumber(entry.sourceSize),
				};
			}
		}
	} catch {
		return undefined;
	}
	return undefined;
}

export async function ensureProjectSessionDir(piRoot: string, projectPath: string) {
	const dir = getProjectSessionDir(piRoot, projectPath);
	await mkdir(dir, { recursive: true });
	return dir;
}

/** 移除平台注入的 <system-reminder> 上下文块，只保留用户真实输入。 */
export function stripInjectedContext(value: string): string {
	return value
		.replace(/<system-reminder\b[^>]*>[\s\S]*?<\/system-reminder>/gi, "")
		.replace(/<system-reminder\b[^>]*\/>/gi, "")
		// WorkBuddy 还会把用户输入整体包进 <user_query>，标签本身不是正文，去壳留内容。
		.replace(/<\/?user_query>/gi, "")
		.trim();
}

/** function_call.arguments 是 JSON 字符串；解析失败时退化为空对象而不是丢掉整次调用。 */
export function parseWorkBuddyArguments(value: unknown): Record<string, unknown> {
	if (typeof value !== "string") return readRecord(value);
	try {
		const parsed: unknown = JSON.parse(value);
		return readRecord(parsed);
	} catch {
		return {};
	}
}
