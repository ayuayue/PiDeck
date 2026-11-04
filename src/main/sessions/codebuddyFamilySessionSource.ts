import { readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { normalizeImportedToolArguments } from "./importToolArguments";
import { assertSourceWithinRoot } from "./importPathGuard";
import { readImportMetaHead } from "./importMetaHead";
import { readSessionSourceHead } from "./sessionSourceHead";
import { getProjectSessionDir } from "./importShared";

/**
 * CodeBuddy（腾讯 CodeBuddy Code CLI）与 WorkBuddy 是同一套本地会话格式：
 *   ~/.codebuddy/projects/<slug>/<sessionId>.jsonl
 *   ~/.workbuddy/projects/<slug>/<sessionId>.jsonl
 *
 * 记录类型（message / reasoning / function_call / function_call_result / ai-title /
 * file-history-snapshot / session-meta）、目录 slug 规则、字段名都逐字一致，差异只有
 * 家目录名、产物文件名前缀、导入标记 type 与 provider 标识。
 *
 * 所以这里用一份「来源描述符 + 家族管线」承载两者：新增同构来源只加一条描述符，
 * 不复制 Source / Convert / Importer 三份实现（那样会有 500+ 行逐字重复）。
 */

/** 家族来源描述符：Source / Convert / Importer 三处共用的唯一来源定义。 */
export type CodeBuddyFamilySource = {
	/** 来源标识：与 SessionSource、i18n 文案前缀、IPC 命名空间一致。 */
	key: "workbuddy" | "codebuddy";
	/** 家目录下的源数据目录名（会话位于其 projects/ 子目录）。 */
	homeDirName: string;
	/** 导入产物文件名前缀；SessionScanner 靠它判定来源。 */
	filePrefix: string;
	/** 导入产物头部标记行的 type；SessionScanner 靠它判定来源。 */
	importMarker: string;
	/** 写进 pi 消息的 provider / api 标识。 */
	provider: string;
	/** 文案中展示的源名（导入标题/预览的回退文案用）。 */
	displayName: string;
};

export const WORKBUDDY_SOURCE: CodeBuddyFamilySource = {
	key: "workbuddy",
	homeDirName: ".workbuddy",
	filePrefix: "workbuddy_",
	importMarker: "workbuddy_import",
	provider: "workbuddy",
	displayName: "WorkBuddy",
};

export const CODEBUDDY_SOURCE: CodeBuddyFamilySource = {
	key: "codebuddy",
	homeDirName: ".codebuddy",
	filePrefix: "codebuddy_",
	importMarker: "codebuddy_import",
	provider: "codebuddy",
	displayName: "CodeBuddy",
};

/** 源 JSONL 行结构不固定，统一按 unknown 读取后再逐字段收窄。 */
export type CodeBuddyFamilyRecord = Record<string, unknown>;

export type ParsedCodeBuddyFamilySession = {
	meta: {
		sessionId: string;
		cwd: string;
		firstTimestamp: number;
		lastTimestamp: number;
		modelId: string;
		aiTitle: string;
	};
	entries: CodeBuddyFamilyRecord[];
	sourcePath: string;
	sourceSize: number;
	sourceMtime: number;
};

export type CodeBuddyFamilyImportMeta = {
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

/**
 * 项目路径 → 源目录名：盘符小写，所有分隔符转 '-'，其余大小写保留。
 * 例：D:\project\github\pi-desktop → d-project-github-pi-desktop
 * 两个家族成员规则相同，root 里已经带了各自的家目录。
 */
export function getFamilyProjectDir(root: string, projectPath: string): string {
	const normalized = projectPath.replace(/\\/g, "/").replace(/\/+$/, "");
	const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
	const slug = win ? `${win[1].toLowerCase()}-${win[2].replace(/\//g, "-")}` : normalized.replace(/^\//, "").replace(/\//g, "-");
	return join(root, slug);
}

export function getFamilyTargetPath(source: CodeBuddyFamilySource, piRoot: string, projectPath: string, session: ParsedCodeBuddyFamilySession): string {
	const id = session.meta.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
	return join(getProjectSessionDir(piRoot, projectPath), `${source.filePrefix}${id}.jsonl`);
}

/** 路径逃逸校验：只允许读取 <home>/<源目录>/projects 之下的会话文件。 */
export function assertFamilySourcePath(source: CodeBuddyFamilySource, root: string, filePath: string): void {
	// 语义校验（resolve 后比较）：词法 startsWith 不解析 `..`（2026-03 导入器安全审计）
	assertSourceWithinRoot(root, filePath, source.displayName);
}

export function sessionIdFromPath(filePath: string): string {
	return basename(filePath).replace(/\.jsonl$/i, "");
}

/** 从 providerData 中取模型标识，取不到时逐层回退。 */
export function readFamilyModel(entry: CodeBuddyFamilyRecord): string {
	const data = readRecordOf(entry.providerData);
	return readString(data.model) || readString(data.requestModelId) || readString(data.requestModelName);
}

function readRecordOf(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * 递归收集源 JSONL。
 *
 * 跳过 `subagents/` 目录：CodeBuddy 把子代理转录写在 `<sessionId>/subagents/agent-*.jsonl`，
 * 它们是会话内部记录而不是可导入的顶层会话（与 Claude 子代理同口径），
 * 收进来会在列表里重复展示母会话里的同一段对话。
 */
export async function collectFamilyJsonl(dir: string): Promise<string[]> {
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "subagents") continue;
				files.push(...(await collectFamilyJsonl(path)));
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
 * 只读头部解析源会话元数据（scan 用）。
 *
 * 不把整文件读成字符串，内存占用与文件体积解耦；entries 只含头部区间，
 * 摘要字段因此是近似值（与 Codex head-only 扫描同口径）。
 * 时间戳：firstTimestamp 取头部最早，lastTimestamp 用 mtime（头部看不到文件尾）。
 */
export async function readFamilySessionHead(source: CodeBuddyFamilySource, root: string, filePath: string): Promise<ParsedCodeBuddyFamilySession> {
	assertFamilySourcePath(source, root, filePath);
	const { head, size, mtimeMs, truncated } = await readSessionSourceHead(filePath);

	const entries: CodeBuddyFamilyRecord[] = [];
	for (const line of head.split(/\r?\n/)) {
		if (!line.trim()) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(line);
		} catch {
			// 头部截断可能切在行中间：坏行跳过（与 readJsonlObjects 同策略）
			continue;
		}
		if (parsed && typeof parsed === "object") entries.push(parsed as CodeBuddyFamilyRecord);
	}

	const withId = entries.find((entry) => readString(entry.sessionId));
	const sessionId = withId ? readString(withId.sessionId) : sessionIdFromPath(filePath);
	const cwd = withId ? readString(withId.cwd) : "";
	const timestamps = entries.map((entry) => readNumber(entry.timestamp)).filter((value) => value > 0);
	if (timestamps.length === 0) throw new Error(`Missing ${source.displayName} session metadata`);

	let modelId = "";
	let aiTitle = "";
	for (const entry of entries) {
		if (!modelId) {
			const model = readFamilyModel(entry);
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
export async function readFamilyImportMeta(source: CodeBuddyFamilySource, targetPath: string): Promise<CodeBuddyFamilyImportMeta | undefined> {
	return readImportMetaHead(targetPath, source.importMarker);
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
export function parseFamilyArguments(value: unknown): Record<string, unknown> {
	return normalizeImportedToolArguments(value);
}
