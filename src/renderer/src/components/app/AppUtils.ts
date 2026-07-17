/**
 * 非组件工具函数，与 AppParts.tsx 分离以避免 Vite Fast Refresh 报错。
 * Fast Refresh 只支持组件和 hook（useXxx）导出，普通函数导出会导致整页刷新。
 */

import type { ReactNode } from "react";
import type { ChatMessage, FileTreeNode, PiCommand } from "../../../../shared/types";

/* ── ANSI 清理 ── */

const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

export function stripThinkingTags(text: string): string {
	return text.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
}

/* ── 时间和摘要 ── */

export function formatTime(timestamp: number) {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function summarizeMessage(text: string) {
	const cleaned = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	const firstLine =
		cleaned
			.replace(/```[\s\S]*?```/g, " ")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return firstLine.length > 48 ? `${firstLine.slice(0, 48)}...` : firstLine;
}

/* ── 路径与匹配 ── */

export function matches(value: string, keyword: string) {
	return (
		!keyword.trim() ||
		value.toLowerCase().includes(keyword.trim().toLowerCase())
	);
}

function getHomePathPrefix() {
	const match = location.href.match(/file:\/\/\/([A-Za-z]:\/Users\/[^/]+)/i);
	return match?.[1] ?? "C:/Users/14012";
}

export function displayPath(path?: string) {
	if (!path) return "";
	const home = getHomePathPrefix();
	const normalized = path.replace(/\\/g, "/");
	const friendly =
		home && normalized.toLowerCase().startsWith(home.toLowerCase())
			? `~${normalized.slice(home.length)}`
			: normalized;
	return friendly.length > 36 ? `...${friendly.slice(-35)}` : friendly;
}

export function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.flatMap((node) =>
		node.type === "file" ? [node] : flattenFiles(node.children ?? []),
	);
}

/* ── 消息分组类型 ── */

export type ToolGroupItem = {
	kind: "tool-group";
	id: string;
	messages: ChatMessage[];
};

export type MessageItem = { kind: "message"; message: ChatMessage };

export type ThinkingGroupItem = {
	kind: "thinking-group";
	id: string;
	messages: ChatMessage[];
	text: string;
	startedAt: number;
	endedAt: number;
};

export type AgentRunItem = {
	kind: "agent-run";
	id: string;
	items: Array<MessageItem | ToolGroupItem | ThinkingGroupItem>;
	startedAt: number;
	endedAt: number;
};

export type RenderMessage = MessageItem | ToolGroupItem | ThinkingGroupItem | AgentRunItem;

export function getMultiSelectImageCaptureIds(
	items: RenderMessage[],
	selectedIds: Set<string>,
): Set<string> {
	const ids = new Set<string>();
	for (const item of items) {
		if (item.kind === "message") {
			if (selectedIds.has(item.message.id)) ids.add(item.message.id);
			continue;
		}
		if (item.kind === "agent-run") {
			const hasSelectedAssistant = item.items.some(
				(sub) =>
					sub.kind === "message" &&
					sub.message.role === "assistant" &&
					selectedIds.has(sub.message.id),
			);
			if (hasSelectedAssistant) ids.add(item.id);
		}
	}
	return ids;
}

/* ── 消息分组 ── */

export function groupToolMessages(messages: ChatMessage[]): RenderMessage[] {
	const result: RenderMessage[] = [];
	let currentTools: ChatMessage[] = [];
	let currentThinking: ChatMessage[] = [];
	let currentRun: Array<MessageItem | ToolGroupItem | ThinkingGroupItem> = [];
	let runStartedAt = 0;
	let runEndedAt = 0;

	function isThinkingOnly(message: ChatMessage) {
		return (
			message.role === "assistant" &&
			Boolean(message.thinking?.trim()) &&
			!stripThinkingTags(stripAnsi(message.text)).trim()
		);
	}

	function flushThinking() {
		if (currentThinking.length === 0) return;
		const previous = currentRun[currentRun.length - 1];
		const nextGroup: ThinkingGroupItem = {
			kind: "thinking-group",
			id: currentThinking.map((message) => message.id).join("|"),
			messages: currentThinking,
			text: currentThinking
				.map((message) => stripAnsi(message.thinking ?? ""))
				.filter(Boolean)
				.join("\n\n"),
			startedAt: currentThinking[0]?.timestamp ?? runStartedAt,
			endedAt:
				currentThinking[currentThinking.length - 1]?.timestamp ?? runEndedAt,
		};
		if (previous?.kind === "thinking-group") {
			previous.id = `${previous.id}|${nextGroup.id}`;
			previous.messages = [...previous.messages, ...nextGroup.messages];
			previous.text = [previous.text, nextGroup.text].filter(Boolean).join("\n\n");
			previous.endedAt = nextGroup.endedAt;
		} else {
			currentRun.push(nextGroup);
		}
		runEndedAt = nextGroup.endedAt;
		currentThinking = [];
	}

	function flushTools() {
		if (currentTools.length === 0) return;
		flushThinking();
		const group: ToolGroupItem = {
			kind: "tool-group",
			id: currentTools.map((message) => message.id).join("|"),
			messages: currentTools,
		};
		currentRun.push(group);
		runEndedAt = currentTools[currentTools.length - 1]?.timestamp ?? runEndedAt;
		currentTools = [];
	}

	function flushRun() {
		flushTools();
		flushThinking();
		if (currentRun.length === 0) return;

		// 合并连续的 assistant 文本消息，避免同一轮回答被拆成多个气泡
		const merged: Array<MessageItem | ToolGroupItem | ThinkingGroupItem> = [];
		for (const item of currentRun) {
			const prev = merged[merged.length - 1];
			if (
				item.kind === "message" &&
				item.message.role === "assistant" &&
				prev?.kind === "message" &&
				prev.message.role === "assistant"
			) {
				prev.message = {
					...prev.message,
					text: prev.message.text + "\n\n" + item.message.text,
					thinking: (prev.message.thinking || "") + (item.message.thinking ? "\n\n" + item.message.thinking : ""),
					id: prev.message.id + "|" + item.message.id,
				};
			} else {
				merged.push(item);
			}
		}

		result.push({
			kind: "agent-run",
			id: merged
				.map((item) => (item.kind === "message" ? item.message.id : item.id))
				.join("|"),
			items: merged,
			startedAt: runStartedAt,
			endedAt: runEndedAt || runStartedAt,
		});
		currentRun = [];
		runStartedAt = 0;
		runEndedAt = 0;
	}

	function appendRunMessage(message: ChatMessage) {
		flushThinking();
		flushTools();
		if (currentRun.length === 0) runStartedAt = message.timestamp;
		runEndedAt = message.timestamp;
		currentRun.push({ kind: "message", message });
	}

	// 暂存区：已 flush 但无 assistant 消息的 run（如 ask_question 场景），等待后续消息合并
	let pendingRun: (MessageItem | ToolGroupItem | ThinkingGroupItem)[] | null = null;

	for (const message of messages) {
		if (isThinkingOnly(message)) {
			flushTools();
			if (currentRun.length === 0 && currentThinking.length === 0) {
				runStartedAt = message.timestamp;
			}
			currentThinking.push(message);
			runEndedAt = message.timestamp;
		} else if (message.role === "assistant") {
			// 有暂存 run 时先合并到当前 run
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
			}
			appendRunMessage(message);
		} else if (message.role === "tool") {
			flushThinking();
			if (currentRun.length === 0) runStartedAt = message.timestamp;
			currentTools.push(message);
		} else {
			// 若已有暂存 run（前一次 ask_question 未合并），先 flush 掉
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				flushRun();
			}
			// 用户消息：若当前 run 有工具但无 assistant 消息，暂存起来等待后续合并
			const hasToolsWithoutAssistant =
				currentRun.length > 0 &&
				currentRun.every((i) => i.kind !== "message" || i.message.role !== "assistant");
			if (hasToolsWithoutAssistant) {
				flushTools();
				flushThinking();
				pendingRun = [...currentRun];
				currentRun = [];
				runStartedAt = 0;
				runEndedAt = 0;
			} else {
				flushRun();
			}
			result.push({ kind: "message", message });
		}
	}
	// 最后 flush 当前 run（含合并后的暂存 run）
	if (pendingRun) {
		currentRun.push(...pendingRun);
		pendingRun = null;
	}
	flushRun();

	return result;
}

/* ── 会话大纲 ── */

export function buildOutline(messages: ChatMessage[]) {
	return messages
		.filter((message) => message.role === "user")
		.map((message) => ({
			id: message.id,
			role: message.role,
			title: summarizeMessage(message.text),
			time: formatTime(message.timestamp),
		}))
		.filter((item) => item.title);
}

/* ── 输入框建议 ── */

export type ComposerSuggestionResult = {
	text: string;
	cursor: number;
};

export type ComposerTrigger = {
	start: number;
	char: string;
	query: string;
};

export function detectTrigger(
	text: string,
	cursor: number,
): ComposerTrigger | null {
	if (cursor < 0 || cursor > text.length) cursor = text.length;
	const before = text.slice(0, cursor);
	const atIdx = before.lastIndexOf("@");
	const slashIdx = before.lastIndexOf("/");
	const ampIdx = before.lastIndexOf("&");
	const start = Math.max(atIdx, slashIdx, ampIdx);
	if (start < 0) return null;
	const char = before[start];
	const segment = before.slice(start + 1);
	if (char === "&") {
		if (/[\n]/.test(segment)) return null;
		const prev = start > 0 ? before[start - 1] : "";
		// 只阻止 URL 查询参数场景（?foo=bar&），不拦 &&、&chip& 等正常场景
		if (prev === "=" || prev === "?") return null;
		return { start, char, query: segment };
	}
	if (/[\s@/&]/.test(segment)) return null;
	const prevChar = start > 0 ? before[start - 1] : "";
	if (prevChar) {
		if (/[:/]/.test(prevChar)) return null;
	}
	return { start, char, query: segment };
}

export function applySuggestion(
	current: string,
	cursor: number,
	value: string,
): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor);
	if (!trigger) {
		const text = `${current}${value} `;
		return { text, cursor: text.length };
	}
	const text = `${current.slice(0, trigger.start)}${value} ${current.slice(cursor)}`;
	return { text, cursor: trigger.start + value.length + 1 };
}

export function clearSuggestionTrigger(
	current: string,
	cursor: number,
): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor);
	if (!trigger) return { text: current, cursor };
	const text = `${current.slice(0, trigger.start)}${current.slice(cursor)}`;
	return { text, cursor: trigger.start };
}

export type SuggestionItem = {
	key: string;
	label: string;
	description: string;
	value: string;
	sessionMeta?: { sessionId: string; filePath: string; projectPath?: string };
};

/* ── 命令管理 ── */

const PINNED_COMMAND_NAMES = new Set<string>();
const HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES = new Set([
	"new",
	"model",
	"resume",
	"fork",
	"name",
	"logout",
	"goal",
	"tree",
]);

function isBuiltinDesktopCommand(command: PiCommand) {
	return command.source == null || command.source === "builtin";
}

function isVisibleDesktopCommand(command: PiCommand) {
	return !(
		isBuiltinDesktopCommand(command) &&
		HIDDEN_DESKTOP_BUILTIN_COMMAND_NAMES.has(command.name.toLowerCase())
	);
}

function getBuiltinCommands(): PiCommand[] {
	return [
		{ name: "session", description: "", source: "builtin" },
		{ name: "tree", description: "", source: "builtin" },
		{ name: "clone", description: "", source: "builtin" },
		{ name: "compact", description: "", source: "builtin" },
		{ name: "copy", description: "", source: "builtin" },
		{ name: "export", description: "", source: "builtin" },
		{ name: "share", description: "", source: "builtin" },
		{ name: "settings", description: "", source: "builtin" },
		{ name: "reload", description: "", source: "builtin" },
		{ name: "hotkeys", description: "", source: "builtin" },
		{ name: "login", description: "", source: "builtin" },
		{ name: "logout", description: "", source: "builtin" },
	];
}

export function mergeCommands(commands: PiCommand[]) {
	const visibleCommands = commands.filter(isVisibleDesktopCommand);
	const names = new Set(visibleCommands.map((command) => command.name));
	const extras = getBuiltinCommands().filter(
		(command) => !names.has(command.name) && isVisibleDesktopCommand(command),
	);
	return [...visibleCommands, ...extras];
}

function fuzzyScore(value: string, keyword: string) {
	if (!keyword) return 1;
	const text = value.toLowerCase();
	const query = keyword.toLowerCase();
	if (text.includes(query)) return 100 + query.length;
	let score = 0;
	let pos = 0;
	for (const ch of query) {
		const found = text.indexOf(ch, pos);
		if (found === -1) return 0;
		score += found === pos ? 8 : 2;
		pos = found + 1;
	}
	return score;
}

export function buildSuggestionItems(
	prompt: string,
	cursor: number,
	commands: PiCommand[],
	files: FileTreeNode[],
	sessions?: { id: string; filePath: string; projectPath?: string; name?: string; preview: string; updatedAt: number }[],
): SuggestionItem[] {
	const allCommands = mergeCommands(commands);
	const trigger = detectTrigger(prompt, cursor);
	if (!trigger) return [];
	const keyword = trigger.query.toLowerCase();
	if (trigger.char === "/") {
		return allCommands
			.map((command, index) => ({ command, index }))
			.filter(({ command }) => command.name.toLowerCase().includes(keyword))
			.sort((a, b) => {
				const aPinned = PINNED_COMMAND_NAMES.has(a.command.name);
				const bPinned = PINNED_COMMAND_NAMES.has(b.command.name);
				if (aPinned !== bPinned) return aPinned ? -1 : 1;
				return a.index - b.index;
			})
			.map(({ command }) => ({
				key: command.name,
				label: `/${command.name}`,
				description: command.description ?? "",
				value: `/${command.name}`,
			}));
	}
	if (trigger.char === "@") {
		return files
			.map((file) => ({
				file,
				score:
					fuzzyScore(file.relativePath, keyword) +
					fuzzyScore(file.name, keyword) * 2,
			}))
			.filter((item) => item.score > 0 || !keyword)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((item) => ({
				key: item.file.path,
				label: `@${item.file.name}`,
				description: item.file.relativePath,
				value: `@${item.file.relativePath}`,
			}));
	}
	if (trigger.char === "&") {
		const list = sessions ?? [];
		return list
			.map((s) => ({ session: s, score: fuzzyScore(s.name ?? s.filePath, keyword) + fuzzyScore(s.preview ?? "", keyword) }))
			.filter((item) => item.score > 0 || !keyword)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((item) => ({
				key: item.session.filePath,
				label: item.session.name ?? item.session.filePath,
				description: item.session.preview,
				value: `&${item.session.name ?? item.session.filePath}`,
				sessionMeta: { sessionId: item.session.id, filePath: item.session.filePath, projectPath: item.session.projectPath },
			}));
	}
	return [];
}
