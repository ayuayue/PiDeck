/**
 * 非组件工具函数，与 AppParts.tsx 分离以避免 Vite Fast Refresh 报错。
 * Fast Refresh 只支持组件和 hook（useXxx）导出，普通函数导出会导致整页刷新。
 */

import type { ReactNode } from "react";
import type { ChatMessage, FileTreeNode, PiCommand } from "../../../../shared/types";
import { formatFilePathRef } from "./RichInput";

/* ── 文件树拖拽负载 ── */

/**
 * 文件树行拖拽时写入 dataTransfer 的两个 MIME：
 * - PI_FILE_PATH_DRAG_MIME：纯绝对路径，供「移动到目录」落点使用（历史约定，勿改名）。
 * - PI_FILE_NODE_DRAG_MIME：完整节点 JSON，composer 落点据此生成 @ 引用（区分文件/目录）。
 */
export const PI_FILE_PATH_DRAG_MIME = "text/pi-file-path";
export const PI_FILE_NODE_DRAG_MIME = "application/x-pi-file-node";

export interface FileNodeDragPayload {
	path: string;
	relativePath: string;
	type: "file" | "directory";
}

/** 拖拽开始侧：把节点信息写入 dataTransfer（路径 + JSON 双写，兼容只读路径的旧落点） */
export function writeFileNodeDragPayload(dataTransfer: DataTransfer, node: FileTreeNode): void {
	dataTransfer.setData(PI_FILE_PATH_DRAG_MIME, node.path);
	const payload: FileNodeDragPayload = {
		path: node.path,
		relativePath: node.relativePath,
		type: node.type,
	};
	dataTransfer.setData(PI_FILE_NODE_DRAG_MIME, JSON.stringify(payload));
}

/**
 * 落点侧：读取文件树拖拽负载。
 * 优先解析 JSON；只有纯路径时按「文件 + 绝对路径」兜底（兼容未带 JSON 的拖拽源）。
 * 非文件树拖拽（如 OS 文件拖入）返回 null。
 */
export function readFileNodeDragPayload(dataTransfer: DataTransfer): FileNodeDragPayload | null {
	const raw = dataTransfer.getData(PI_FILE_NODE_DRAG_MIME);
	if (raw) {
		try {
			const parsed = JSON.parse(raw) as Partial<FileNodeDragPayload>;
			if (typeof parsed.path === "string" && parsed.path) {
				return {
					path: parsed.path,
					relativePath: typeof parsed.relativePath === "string" ? parsed.relativePath : "",
					type: parsed.type === "directory" ? "directory" : "file",
				};
			}
		} catch {
			// JSON 损坏时继续走纯路径兜底
		}
	}
	const plainPath = dataTransfer.getData(PI_FILE_PATH_DRAG_MIME);
	return plainPath ? { path: plainPath, relativePath: "", type: "file" } : null;
}

/**
 * 文件树节点 → composer @ 引用文本。
 * 项目内节点优先 relativePath（与 @ 建议一致，可过 chip 白名单校验）；
 * relativePath 缺失时退回绝对路径（chip 规则对绝对路径直接放行）。
 * 目录由 formatFilePathRef 追加尾斜杠，含空格路径自动加引号。
 */
export function fileNodeDragPayloadToRef(payload: FileNodeDragPayload): string {
	return formatFilePathRef(payload.relativePath || payload.path, {
		isDirectory: payload.type === "directory",
	});
}

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

/**
 * 将文件树展平为文件 + 目录列表。
 * 目录节点一并保留，供 @ 引用搜索与 chip 白名单使用（空目录也能被引用）。
 */
export function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.flatMap((node) =>
		node.type === "file"
			? [node]
			: [node, ...flattenFiles(node.children ?? [])],
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

export function sameChatMessageForRender(previous: ChatMessage, next: ChatMessage): boolean {
	if (
		previous.id !== next.id ||
		previous.role !== next.role ||
		previous.text !== next.text ||
		previous.thinking !== next.thinking ||
		previous.timestamp !== next.timestamp
	) {
		return false;
	}
	const previousImages = previous.images ?? [];
	const nextImages = next.images ?? [];
	return (
		previousImages.length === nextImages.length &&
		previousImages.every(
			(image, index) =>
				image.mimeType === nextImages[index]?.mimeType &&
				image.data === nextImages[index]?.data,
		)
	);
}

export function sameAgentRunForRender(previous: AgentRunItem, next: AgentRunItem): boolean {
	if (
		previous.id !== next.id ||
		previous.startedAt !== next.startedAt ||
		previous.endedAt !== next.endedAt ||
		previous.items.length !== next.items.length
	) {
		return false;
	}
	return previous.items.every((item, index) => {
		const other = next.items[index];
		if (!other || item.kind !== other.kind) return false;
		if (item.kind === "message" && other.kind === "message") {
			return sameChatMessageForRender(item.message, other.message);
		}
		if (item.kind === "thinking-group" && other.kind === "thinking-group") {
			return (
				item.id === other.id &&
				item.text === other.text &&
				item.startedAt === other.startedAt &&
				item.endedAt === other.endedAt
			);
		}
		if (item.kind === "tool-group" && other.kind === "tool-group") {
			return (
				item.id === other.id &&
				item.messages.length === other.messages.length &&
				item.messages.every((message, messageIndex) =>
					sameChatMessageForRender(message, other.messages[messageIndex]),
				)
			);
		}
		return false;
	});
}

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
	/** 当前回合的触发用户消息时间戳，用于替代 assistant/tool 时间戳作为回合起点 */
	let lastUserTimestamp = 0;

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
		// 使用首个消息 ID 作为稳定 key：流式期间 thinking 文本持续增长并多次 flush，
		// 若每次拼接 ID 会导致 React key 变化 → 组件卸载重建 → expanded 状态丢失。
		const stableId = currentThinking[0]?.id ?? "";
		const nextGroup: ThinkingGroupItem = {
			kind: "thinking-group",
			id: stableId,
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
			// 保留原有 stable id，仅合并内容和消息列表
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
		// 使用首个工具消息 ID 作为稳定 key，与 flushThinking 同理。
		const stableId = currentTools[0]?.id ?? "";
		const group: ToolGroupItem = {
			kind: "tool-group",
			id: stableId,
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

		// 合并连续的 assistant 文本消息，避免同一轮回答被拆成多个气泡。
		// 合并时保留首个消息 ID 作为稳定 key，流式期间不变化。
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
				};
			} else {
				merged.push(item);
			}
		}

		// run id 取首个条目的稳定 id，流式期间不会变，React key 保持稳定
		const runStableId = merged[0]
			? (merged[0].kind === "message" ? merged[0].message.id : merged[0].id)
			: "";
		result.push({
			kind: "agent-run",
			id: runStableId,
			items: merged,
			// 回合起点优先用触发它的用户消息时间戳，无用户消息时回退到 run 内首条消息时间戳
			startedAt: lastUserTimestamp || runStartedAt,
			endedAt: runEndedAt || runStartedAt,
		});
		currentRun = [];
		runStartedAt = 0;
		runEndedAt = 0;
		lastUserTimestamp = 0;
	}

	function appendRunMessage(message: ChatMessage) {
		flushThinking();
		flushTools();
		if (currentRun.length === 0) runStartedAt = message.timestamp;
		runEndedAt = message.timestamp;
		currentRun.push({ kind: "message", message });
	}

	// 暂存区：仅用于 ask_question 续答——system 卡片后用户回复时，把卡片前的工具/思考
	// 暂存起来，等下一条 assistant 到来后合并为同一 agent-run。
	// 普通「上一轮只有工具/思考、用户又发新问题」场景不得使用此暂存，否则会串轮。
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
		} else if (message.role === "system") {
			// System 消息（如 askQuestion 卡片）不应中断当前 agent run。
			// 工具、thinking 和后续 assistant 消息应合并为同一轮回答，
			// 否则会被拆成两个独立的折叠区域。
			// 若已有暂存 run（前一次 ask_question 未合并），先 flush 掉。
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				flushRun();
			}
			result.push({ kind: "message", message });
		} else {
			// 若已有暂存 run（前一次 ask_question 未合并），先 flush 掉
			if (pendingRun) {
				currentRun.push(...pendingRun);
				pendingRun = null;
				flushRun();
			}
			// 用户消息到来时，当前 run 可能只有工具/思考、没有最终回答文本。
			// 仅在「回答 ask_question」场景下暂存合并：上一条 result 是 system 消息。
			// 普通新提问（上一轮未完成回答就发下一条）必须 flush 成独立 agent-run，
			// 否则上一轮的工具/思考会混进下一轮回答块。
			const hasToolsWithoutAssistant =
				currentRun.length > 0 &&
				currentRun.every((i) => i.kind !== "message" || i.message.role !== "assistant");
			const lastResult = result[result.length - 1];
			const isAnsweringAskQuestion =
				lastResult?.kind === "message" && lastResult.message.role === "system";
			if (hasToolsWithoutAssistant && isAnsweringAskQuestion) {
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
			// 记录触发回合的用户消息时间戳，作为回合的真实起点
			lastUserTimestamp = message.timestamp;
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
	if (char === "/") {
		// 检查 / 是否属于 @file 路径（@ 在前且路径段内无空白），是则当作 @ 触发而非命令。
		// 关键：路径完成后光标后有空格/后续文本时（@src/ 说明…），必须关闭，
		// 否则路径中的每个 / 都会把建议框永久钉住。
		const beforeSlash = before.slice(0, start);
		const atBefore = beforeSlash.lastIndexOf("@");
		if (atBefore >= 0 && !/\s/.test(beforeSlash.slice(atBefore))) {
			const fileSegment = before.slice(atBefore + 1);
			if (/\s/.test(fileSegment)) return null;
			return { start: atBefore, char: "@", query: fileSegment };
		}
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

/**
 * 关闭建议框时的文本处理。
 * 默认只关面板、不改输入——用户可能已在 @path 后继续写说明文字，
 * 若删掉从触发符到光标的整段，会把正文一起清掉（Esc 全没了）。
 * 仅当「触发后还没有任何有效查询」时（刚输入 @ / &）才去掉触发符本身，避免残留孤立符号。
 */
export function clearSuggestionTrigger(
	current: string,
	cursor: number,
): ComposerSuggestionResult {
	const trigger = detectTrigger(current, cursor);
	if (!trigger) return { text: current, cursor };
	// 已有查询内容：保留全文，只表示关闭菜单
	if (trigger.query.length > 0) {
		return { text: current, cursor };
	}
	// 空触发符（单独的 @ / &）：去掉触发符，避免占位
	const text = `${current.slice(0, trigger.start)}${current.slice(cursor)}`;
	return { text, cursor: trigger.start };
}

export type SuggestionItem = {
	key: string;
	label: string;
	description: string;
	value: string;
	/** 不可选中的分组头；目录本身可选，不再使用 disabled 表示目录 */
	disabled?: boolean;
	/** 树形缩进层级（0=根目录），仅在 @ 无关键词时使用 */
	treeDepth?: number;
	/** 目录引用：UI 显示文件夹图标，插入路径与文件相同 */
	isDirectory?: boolean;
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
	"reload",
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

/** 目录引用在建议列表与插入文本中都用尾斜杠标记，避免 @src 被模型当成智能体。 */
function formatPathSuggestionLabel(node: FileTreeNode): string {
	return node.type === "directory" ? `@${node.name}/` : `@${node.name}`;
}

function formatPathSuggestionValue(node: FileTreeNode): string {
	return formatFilePathRef(node.relativePath, {
		isDirectory: node.type === "directory",
	});
}

/**
 * 从扁平路径列表（文件 + 目录）重建一级树视图。
 * 目录与文件均可选，便于直接 @src 这类目录引用。
 */
function buildFileTreeItems(entries: FileTreeNode[]): SuggestionItem[] {
	interface PathNode {
		name: string;
		relativePath: string;
		children: Map<string, PathNode>;
		files: FileTreeNode[];
		dirNode?: FileTreeNode;
	}
	// 用 / 分隔符构建路径树；目录节点单独挂 dirNode，空目录也能出现。
	const root: PathNode = { name: "", relativePath: "", children: new Map(), files: [] };
	const ensureDir = (parent: PathNode, part: string): PathNode => {
		let child = parent.children.get(part);
		if (!child) {
			const relativePath = parent.relativePath ? `${parent.relativePath}/${part}` : part;
			child = { name: part, relativePath, children: new Map(), files: [] };
			parent.children.set(part, child);
		}
		return child;
	};
	for (const entry of entries) {
		const parts = entry.relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
		if (parts.length === 0) continue;
		if (entry.type === "directory") {
			let node = root;
			for (const part of parts) node = ensureDir(node, part);
			node.dirNode = entry;
			continue;
		}
		let node = root;
		for (const part of parts.slice(0, -1)) node = ensureDir(node, part);
		node.files.push(entry);
	}
	// 仅展平第一层（根目录文件 + 一级目录），避免大项目卡顿
	const result: SuggestionItem[] = [];
	function flatten(node: PathNode, depth: number, maxDepth: number) {
		const sortedDirs = [...node.children.values()].sort((a, b) => a.name.localeCompare(b.name));
		const sortedFiles = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
		for (const dir of sortedDirs) {
			const dirPath = dir.dirNode?.relativePath ?? dir.relativePath;
			result.push({
				key: dir.dirNode?.path ?? `dir:${dirPath}`,
				label: `@${dir.name}/`,
				description: dirPath,
				// 必须插入 @dir/：裸 @dir 无法过 chip 路径规则，也易被模型当成 mention
				value: formatFilePathRef(dirPath, { isDirectory: true }),
				treeDepth: depth,
				isDirectory: true,
			});
			if (depth < maxDepth) flatten(dir, depth + 1, maxDepth);
		}
		for (const file of sortedFiles) {
			result.push({
				key: file.path,
				label: formatPathSuggestionLabel(file),
				description: file.relativePath,
				value: formatPathSuggestionValue(file),
				treeDepth: depth,
				isDirectory: file.type === "directory",
			});
		}
	}
	flatten(root, 0, 0); // 只展开第一层
	return result;
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
		if (!keyword) {
			// 无关键词：展示一级目录/文件；目录可直接选中引用
			return buildFileTreeItems(files);
		}
		// 有关键词：文件与目录一起模糊搜索；同名时目录略优先，方便找文件夹
		return files
			.map((file) => ({
				file,
				score:
					fuzzyScore(file.relativePath, keyword) +
					fuzzyScore(file.name, keyword) * 2 +
					(file.type === "directory" ? 4 : 0),
			}))
			.filter((item) => item.score > 0)
			.sort((a, b) => b.score - a.score)
			.slice(0, 15)
			.map((item) => ({
				key: item.file.path,
				label: formatPathSuggestionLabel(item.file),
				description: item.file.relativePath,
				// 相对路径含空格时同样加引号；目录追加 / 以通过 chip 规则并语义化为路径。
				value: formatPathSuggestionValue(item.file),
				isDirectory: item.file.type === "directory",
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

/* ── 工具参数解析 ── */

export function parseToolArgs(value: unknown): Record<string, unknown> | undefined {
	if (!value) return undefined;
	if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
	if (typeof value !== "string" || !value.trim()) return undefined;
	try {
		let parsed = JSON.parse(value) as unknown;
		if (typeof parsed === "string" && parsed.trim()) {
			try { parsed = JSON.parse(parsed); } catch { return undefined; }
		}
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function getToolFilePath(args: any): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	if (typeof args !== "object") return undefined;
	const a = args as Record<string, unknown>;
	return typeof a.filePath === "string" && a.filePath ? a.filePath
		: typeof a.file_path === "string" && a.file_path ? a.file_path
		: typeof a.path === "string" && a.path ? a.path
		: typeof a.targetPath === "string" && a.targetPath ? a.targetPath
		: typeof a.target_path === "string" && a.target_path ? a.target_path
		: typeof a.outputPath === "string" && a.outputPath ? a.outputPath
		: typeof a.output_path === "string" && a.output_path ? a.output_path
		: typeof a.file === "string" && a.file ? a.file
		: typeof a.fileName === "string" && a.fileName ? a.fileName
		: typeof a.filename === "string" && a.filename ? a.filename
		: undefined;
}

export function countTextLines(value: string): number {
	return value ? value.split(/\r\n|\r|\n/).length : 0;
}

export function getToolEditDiff(args: Record<string, unknown>): { oldText: string; newText: string } | undefined {
	const edits = Array.isArray(args.edits) ? args.edits : undefined;
	if (edits) {
		const parts = edits.map((edit: unknown) => {
			if (!edit || typeof edit !== "object") return null;
			const e = edit as Record<string, unknown>;
			const oldText = String(e.oldText ?? e.old_text ?? e.old_string ?? "");
			const newText = String(e.newText ?? e.new_text ?? e.new_string ?? "");
			return { oldText, newText };
		}).filter((p): p is { oldText: string; newText: string } => p !== null);
		if (parts.length === 0) return undefined;
		return {
			oldText: parts.map(p => p.oldText).join("\n"),
			newText: parts.map(p => p.newText).join("\n"),
		};
	}
	const oldText = typeof args.oldText === "string" ? args.oldText : typeof args.old_text === "string" ? args.old_text : typeof args.old_string === "string" ? args.old_string : undefined;
	const newText = typeof args.newText === "string" ? args.newText : typeof args.new_text === "string" ? args.new_text : typeof args.new_string === "string" ? args.new_string : undefined;
	if (oldText === undefined || newText === undefined) return undefined;
	return { oldText, newText };
}

export function getToolNewContent(toolName: string, args: any): string | undefined {
	if (!args) return undefined;
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return undefined; }
	}
	if (!toolName) return undefined;
	if (/write|create/i.test(toolName)) {
		const a = args as Record<string, unknown>;
		return typeof a.content === "string" ? a.content : typeof a.text === "string" ? a.text : typeof a.data === "string" ? a.data : typeof a.body === "string" ? a.body : undefined;
	}
	if (/edit|patch/i.test(toolName)) {
		const diff = getToolEditDiff(args);
		return diff?.newText;
	}
	return undefined;
}

export function getToolChangedLineCount(toolName: string, args: any): number {
	if (typeof args === "string" && args.trim()) {
		try { args = JSON.parse(args); } catch { return 0; }
	}
	if (!toolName) return 0;
	if (/edit|patch/i.test(toolName)) {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		if (edits) {
			return edits.reduce((total: number, edit: any) => {
				const oldLines = countTextLines(String(edit?.oldText ?? edit?.old_text ?? ""));
				const newLines = countTextLines(String(edit?.newText ?? edit?.new_text ?? ""));
				return total + Math.max(oldLines, newLines);
			}, 0);
		}
		return Math.max(countTextLines(String(args?.oldText ?? args?.old_text ?? "")), countTextLines(String(args?.newText ?? args?.new_text ?? "")));
	}
	if (/write|create/i.test(toolName)) {
		return countTextLines(String(args?.content ?? args?.text ?? args?.data ?? args?.body ?? ""));
	}
	return 0;
}

