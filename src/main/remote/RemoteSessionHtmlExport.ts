/**
 * 远端会话的 HTML 导出：**远端只读 + 本机写文件**。
 *
 * 为什么不复用本机 catalog 导出：那条链是「临时本机 pi 进程的 `export_html` RPC」，它需要**本机会话文件**；
 * ssh locator 记录的本机 `filePath` 已被 `normalizeEntryLocator` 清空，远端路径也禁止交给本机文件实现。
 * 所以远端这条链只能是：`RemoteSessionHistoryReader`（有界窗口分页）读消息 → **同一套**投影式导出渲染器
 * （`dshSessionHtmlExport`，DSH 历史导出用的就是它）渲染 → 本机导出目录写文件。为远端再写一套模板，
 * 会在下一次样式/转义修正时与 DSH 那条分叉，正是 AGENTS.md 里「同一能力一个挂载点」要避免的事。
 *
 * 不变量：
 * - **只读远端**：本模块没有任何远端写/移动/删除动作，远端侧只有 reader 造出来的有界读命令。
 * - **上限必标记**：页数/消息数/文本字节三个上限命中时，结果 `truncated: true`，且 HTML 里有一条可见说明。
 *   绝不把部分历史导出成看起来完整的文件。
 * - **失败稳定码**：远端读失败、本机写失败各有稳定码；裸异常、远端路径、命令行都不外传。
 * - **保留最近的**：上限按「从新往旧」截断（与本地 `REFERENCE_MESSAGE_LIMIT` 同一取舍），用户拿到的是最近的
 *   历史，而不是最旧的一段。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SshSessionLocator } from "../../shared/projectLocation";
import type { ChatMessage, SessionMessagePage } from "../../shared/types";
import { renderDshSessionHtml, sanitizeExportFileName } from "../dsh/dshSessionHtmlExport";

/**
 * 导出上限。
 *
 * 页数上限为什么是 20：每页是一次 pinned SSH 短命令往返（窗口 ≤ 2 MiB，见
 * `REMOTE_SESSION_HISTORY_WINDOW_BYTES`）。实际先命中的通常是下面的文本预算（8 MiB），
 * 两者都按「从新往旧」截断，命中时 `truncated: true` 并在 HTML 里显式说明。
 */
export const REMOTE_SESSION_EXPORT_LIMITS = {
	maxPages: 20,
	maxMessages: 5000,
	/** 投影文本字节上限（HTML 体积的代理量）；单页越界由页自身的 2 MiB 窗口上界兜住。 */
	maxTextBytes: 8 * 1024 * 1024,
} as const;

/** 本模块的稳定码（message 本身就是码，与远端 IPC 一系既有约定一致）。 */
export const REMOTE_SESSION_EXPORT_CODES = {
	/** 装配没提供远端读端口（旧装配 / 远端实验开关关闭）：**不**回退成本机导出。 */
	unavailable: "REMOTE_SESSION_EXPORT_UNAVAILABLE",
	/** 远端读取失败且自身不带稳定码（传输/命令/解析层）。 */
	readFailed: "REMOTE_SESSION_EXPORT_READ_FAILED",
	/** 本机写盘失败（导出目录不可写）。 */
	writeFailed: "REMOTE_SESSION_EXPORT_WRITE_FAILED",
} as const;

/** 远端历史分页读端口（生产实现 = `RemoteSessionHistoryReader.readPage`）。 */
export type RemoteSessionExportReadPort = (input: { hostId: string; locator: SshSessionLocator; before?: number }) => Promise<SessionMessagePage>;

export type RemoteSessionExportLimits = { maxPages: number; maxMessages: number; maxTextBytes: number };

function stable(code: string): Error {
	return new Error(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 只让本身已经是稳定码的 message 通过；其余折叠成 fallback（路径/命令行/errno 永不外传）。 */
function codeOf(error: unknown, fallback: string): string {
	if (isRecord(error)) {
		const message = error.message;
		if (typeof message === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(message)) return message;
	}
	return fallback;
}

function resolveLimits(overrides?: Partial<RemoteSessionExportLimits>): RemoteSessionExportLimits {
	const limits = { ...REMOTE_SESSION_EXPORT_LIMITS, ...overrides };
	for (const value of Object.values(limits)) {
		if (!Number.isSafeInteger(value) || value < 1) throw stable("REMOTE_SESSION_EXPORT_LIMITS_INVALID");
	}
	return limits;
}

/** 一条消息落到 HTML 里的字符量（正文 + thinking + 内联图片字节）：字节预算的计量口径。 */
function messageTextChars(message: ChatMessage): number {
	const images = message.images ?? [];
	let chars = (message.text ?? "").length + (message.thinking ?? "").length;
	for (const image of images) chars += image.data?.length ?? 0;
	return chars;
}

function pageMessages(page: unknown): ChatMessage[] {
	if (!isRecord(page) || !Array.isArray(page.messages)) throw stable(REMOTE_SESSION_EXPORT_CODES.readFailed);
	return page.messages as ChatMessage[];
}

export type RemoteSessionExportCollection = {
	/** 按时间正序（更早 → 更新）的投影消息。 */
	messages: ChatMessage[];
	/** true = 上限命中，更早的历史**没有**包含在这份结果里。 */
	truncated: boolean;
	pagesRead: number;
};

/**
 * 从最新往更早分页收集消息，直到取尽或命中上限（纯逻辑，读端口由调用方注入）。
 *
 * 页内已经是时间正序、分页方向是从新往旧，所以最终顺序 = 各页倒序拼接。`truncated` 的语义是「还有更早的历史
 * 没有被包含」，两种来处：① 循环因上限退出（此时刚读到的一页明确还有更早历史 `nextBefore !== null`）；
 * ② 拼接后条数超过 maxMessages 被裁头（含「文件刚好取尽、但尾页把条数顶过了上限」这个边界）。文件取尽时
 * （`nextBefore === null`）上限判断在退出**之后**，所以一份完整导出不会被误报成截断。
 */
export async function collectRemoteSessionMessages(input: { readPage: RemoteSessionExportReadPort; hostId: string; locator: SshSessionLocator; limits?: Partial<RemoteSessionExportLimits>; logger?: { warn(message: string, details?: Record<string, unknown>): void } }): Promise<RemoteSessionExportCollection> {
	const limits = resolveLimits(input?.limits);
	if (typeof input?.readPage !== "function") throw stable(REMOTE_SESSION_EXPORT_CODES.unavailable);
	const pages: ChatMessage[][] = [];
	let truncated = false;
	let cursor: number | undefined;
	let messageCount = 0;
	let textChars = 0;
	while (true) {
		let page: SessionMessagePage;
		try {
			page = await input.readPage({ hostId: input.hostId, locator: input.locator, ...(cursor !== undefined ? { before: cursor } : {}) });
		} catch (error) {
			// reader 自己的稳定码（REMOTE_SESSION_HISTORY_* / 连接层码）原样转述，其余折叠成 readFailed。
			throw stable(codeOf(error, REMOTE_SESSION_EXPORT_CODES.readFailed));
		}
		const messages = pageMessages(page);
		pages.push(messages);
		messageCount += messages.length;
		for (const message of messages) textChars += messageTextChars(message);
		const next = isRecord(page) ? page.nextBefore : undefined;
		if (next === null || next === undefined) break;
		if (pages.length >= limits.maxPages || messageCount >= limits.maxMessages || textChars >= limits.maxTextBytes) {
			truncated = true;
			break;
		}
		cursor = next;
	}
	// 分页方向是从新往旧：倒序拼接才得到时间正序。超限的多余部分（最多一页）按「保留最近的」从头部裁掉——
	// 裁掉就是没包含，所以这里也必须把 truncated 置真（否则尾页越界会变成一次静默截断）。
	const ordered = pages.reverse().flat();
	const messages = ordered.length > limits.maxMessages ? ordered.slice(ordered.length - limits.maxMessages) : ordered;
	if (messages.length !== ordered.length) truncated = true;
	if (truncated) input.logger?.warn("remote session export truncated by limit", { hostId: input.hostId, pagesRead: pages.length, messageCount: messages.length, limits });
	return { messages, truncated, pagesRead: pages.length };
}

export type RemoteSessionExportPorts = {
	readPage: RemoteSessionExportReadPort;
	/** 本机导出目录（装配注入；与 DSH 投影式导出同一个目录，避免两处各拼一次路径）。 */
	resolveExportDir: () => string;
	/** 用户可见文案（本地化由装配的 mainCopy 提供，模块内不硬编码）。 */
	copy: { footer: string; partialNotice: string };
	limits?: Partial<RemoteSessionExportLimits>;
	logger?: { info(message: string, details?: Record<string, unknown>): void; warn(message: string, details?: Record<string, unknown>): void };
};

export type RemoteSessionHtmlExportResult = {
	path: string;
	/** true = 上限命中：HTML 里有对应的可见说明，调用方/日志也必须如实带上这个标记。 */
	truncated: boolean;
	pagesRead: number;
	messageCount: number;
};

/** 收集 + 渲染 + 写本机文件（返回值是本地导出那条链的同一形状加上截断标记）。 */
export async function exportRemoteSessionHtml(input: RemoteSessionExportPorts & { sessionId: string; title: string; hostId: string; locator: SshSessionLocator; exportedAt?: number }): Promise<RemoteSessionHtmlExportResult> {
	const collection = await collectRemoteSessionMessages({
		readPage: input.readPage,
		hostId: input.hostId,
		locator: input.locator,
		...(input.limits !== undefined ? { limits: input.limits } : {}),
		...(input.logger !== undefined ? { logger: input.logger } : {}),
	});
	const html = renderDshSessionHtml(collection.messages, {
		title: input.title,
		...(input.exportedAt !== undefined ? { exportedAt: input.exportedAt } : {}),
		footerText: input.copy.footer,
		...(collection.truncated ? { partialNotice: input.copy.partialNotice } : {}),
	});
	const dir = input.resolveExportDir();
	if (!dir) throw stable(REMOTE_SESSION_EXPORT_CODES.writeFailed);
	const filePath = join(dir, sanitizeExportFileName(input.title, input.sessionId));
	try {
		await mkdir(dir, { recursive: true });
		await writeFile(filePath, html, "utf8");
	} catch (error) {
		// 写盘失败只报稳定码：本机路径与 errno 不进返回结构（日志由装配侧按需记录）。
		throw stable(codeOf(error, REMOTE_SESSION_EXPORT_CODES.writeFailed));
	}
	input.logger?.info("remote session exported to html", { hostId: input.hostId, pagesRead: collection.pagesRead, messageCount: collection.messages.length, truncated: collection.truncated });
	return { path: filePath, truncated: collection.truncated, pagesRead: collection.pagesRead, messageCount: collection.messages.length };
}
