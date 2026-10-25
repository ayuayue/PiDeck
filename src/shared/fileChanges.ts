/**
 * 会话文件修改解析（跨进程共用纯函数）。
 *
 * 从会话消息的 write/edit/create/patch 工具调用中提取路径与 diff 目标，按文件聚合。
 * main（会话文件修改汇总 IPC）与 renderer（TimelineFormat / 文件 tab）共用同一份实现，
 * 避免两处各自复制解析逻辑导致口径漂移。
 *
 * 注意：与 AppUtils 的工具参数解析同逻辑（AppUtils 保留独立副本，改动时需同步）。
 * 本模块无运行时依赖，可被 node 单测直接加载。
 */
import type { ChatMessage } from "./types.ts";
import type { SessionFileChange } from "./types/fileChanges.ts";

/* ── 工具参数解析 ── */

function parseToolArgs(value: unknown): Record<string, unknown> | undefined {
	if (!value) return undefined;
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		let parsed = JSON.parse(value) as unknown;
		if (typeof parsed === "string" && parsed.trim()) {
			try {
				parsed = JSON.parse(parsed);
			} catch {
				return undefined;
			}
		}
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function getToolFilePath(args: unknown): string | undefined {
	if (!args) return undefined;
	let a: unknown = args;
	if (typeof a === "string" && a.trim()) {
		try {
			a = JSON.parse(a);
		} catch {
			return undefined;
		}
	}
	if (typeof a !== "object" || a === null) return undefined;
	const r = a as Record<string, unknown>;
	return typeof r.filePath === "string" && r.filePath
		? r.filePath
		: typeof r.file_path === "string" && r.file_path
			? r.file_path
			: typeof r.path === "string" && r.path
				? r.path
				: typeof r.targetPath === "string" && r.targetPath
					? r.targetPath
					: typeof r.target_path === "string" && r.target_path
						? r.target_path
						: typeof r.outputPath === "string" && r.outputPath
							? r.outputPath
							: typeof r.output_path === "string" && r.output_path
								? r.output_path
								: typeof r.file === "string" && r.file
									? r.file
									: typeof r.fileName === "string" && r.fileName
										? r.fileName
										: typeof r.filename === "string" && r.filename
											? r.filename
											: undefined;
}

function countTextLines(value: string): number {
	return value ? value.split(/\r\n|\r|\n/).length : 0;
}

function getToolEditDiff(args: Record<string, unknown>): { oldText: string; newText: string } | undefined {
	const edits = Array.isArray(args.edits) ? args.edits : undefined;
	if (edits) {
		const parts = edits
			.map((edit: unknown) => {
				if (!edit || typeof edit !== "object") return null;
				const e = edit as Record<string, unknown>;
				const oldText = String(e.oldText ?? e.old_text ?? e.old_string ?? "");
				const newText = String(e.newText ?? e.new_text ?? e.new_string ?? "");
				return { oldText, newText };
			})
			.filter((p): p is { oldText: string; newText: string } => p !== null);
		if (parts.length === 0) return undefined;
		return {
			oldText: parts.map((p) => p.oldText).join("\n"),
			newText: parts.map((p) => p.newText).join("\n"),
		};
	}
	const oldText = typeof args.oldText === "string" ? args.oldText : typeof args.old_text === "string" ? args.old_text : typeof args.old_string === "string" ? args.old_string : undefined;
	const newText = typeof args.newText === "string" ? args.newText : typeof args.new_text === "string" ? args.new_text : typeof args.new_string === "string" ? args.new_string : undefined;
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

/**
 * 文件修改类工具名（write / edit / create / patch）：产出 diff 目标的工具集合。
 *
 * 单一口径：聚合侧（getToolDiffTarget）与读取侧的「预判要不要把这一行读进内存」
 * （SessionHistoryReader.isFileChangeSource）共用本判定，避免两处正则各写一份漂移。
 */
export const FILE_CHANGE_TOOL_RE = /write|edit|create|patch/i;

export function isFileChangeToolName(toolName: string): boolean {
	return FILE_CHANGE_TOOL_RE.test(toolName);
}

export function getToolName(message: ChatMessage): string {
	const fromMeta = message.meta?.toolName;
	if (typeof fromMeta === "string" && fromMeta.trim()) return fromMeta;
	const text = stripAnsi(message.text)
		.replace(/^[\u25b6\u2713\u2717]\s*/u, "")
		.trim();
	return text.split(/\s+/)[0] || "tool";
}

/**
 * 提取单条工具消息的 diff 目标（write/edit/create/patch）：
 * write/create 提供完整新内容；edit/patch 提供变动区域（oldText/newText）。
 * 与单条工具卡片的 diff 按钮共用，会话文件汇总也复用此逻辑。
 */
export function getToolDiffTarget(message: ChatMessage): { path: string; originalContent: string; content: string; changedLines: number } | undefined {
	const toolName = getToolName(message);
	if (!isFileChangeToolName(toolName)) return undefined;
	const args = parseToolArgs(message.meta?.args);
	const path = getToolFilePath(args);
	if (!args || !path) return undefined;
	if (/write|create/i.test(toolName)) {
		const content = typeof args.content === "string" ? args.content : typeof args.text === "string" ? args.text : undefined;
		if (content === undefined) return undefined;
		return { path, originalContent: "", content, changedLines: countTextLines(content) };
	}
	// edit/patch：不存储 full file originalContent，只展示变动区域
	const diff = getToolEditDiff(args);
	if (!diff) return undefined;
	return {
		path,
		originalContent: diff.oldText,
		content: diff.newText,
		changedLines: Math.max(countTextLines(diff.oldText), countTextLines(diff.newText)),
	};
}

/**
 * 遍历会话消息收集 write/edit/create/patch 修改的文件（复用 getToolDiffTarget）。
 * 同文件多次修改取最后一次 diff 并累计次数。供会话文件汇总组件与单测共用。
 */
export function collectSessionFileChanges(messages: readonly ChatMessage[]): SessionFileChange[] {
	const map = new Map<string, SessionFileChange>();
	for (const message of messages) {
		const target = getToolDiffTarget(message);
		if (!target) continue;
		const prev = map.get(target.path);
		map.set(target.path, {
			path: target.path,
			count: (prev?.count ?? 0) + 1,
			originalContent: target.originalContent,
			content: target.content,
		});
	}
	return [...map.values()];
}
