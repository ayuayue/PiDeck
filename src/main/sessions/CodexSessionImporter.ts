import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CodexImportReport, CodexImportResult, CodexImportStatus, CodexSessionSummary } from "../../shared/types";
import { getCodexSessionThreadInfo } from "../../shared/codexSessionMeta";
import { defaultSessionImportCopy, type SessionImportCopy } from "./SessionImportCopy";
import { assertSourceWithinRoot } from "./importPathGuard";
import { readJsonlObjects, renameWithRetry } from "./sessionSourceHead";
import { normalizeImportedToolArguments } from "./importToolArguments";
import { readImportMetaHead } from "./importMetaHead";
import { normalizeImportedStopReason, tryImportedImageBlock } from "./importNormalize";
import { codexImageGenerationResult, codexToolSearchOutputText, normalizeCodexToolLine, parseCodexToolOutput } from "./codexToolNormalize";
import { loadCodexThreadTitles, lookupCodexThreadTitle, type CodexThreadTitle, type CodexThreadTitleMaps } from "./codexSessionTitles";

// 扫描阶段只读每个文件头部：session_meta / 首条用户消息 / preview 都在前部，
// 全量解析会让内存峰值随 ~/.codex/sessions 总大小线性增长（rollouts 轨迹文件常达几十 MB），
// 曾导致扫描时 OOM、应用被系统静默杀死（无任何日志）——超大会话的 summary 按头部近似。
const SCAN_HEAD_LIMIT = 1024 * 1024;
// 扫描并发上限：限制同时驻留内存的头部缓冲数量（与 SCAN_HEAD_LIMIT 配合防 OOM）。
const SCAN_CONCURRENCY = 6;
// 预过滤阶段只读每个文件头部 64KB 提取 session_meta（codex 会话首行即 session_meta，
// 64KB 足够容纳；超出行数/大小视为无 meta 跳过）。
const META_HEAD_LIMIT = 64 * 1024;

/**
 * Codex 用户消息的两代写盘格式（2026-09 起 Codex Desktop 把 user_message 事件移除）：
 * 1. 旧 CLI（≤0.129）：每轮一条 `event_msg/user_message`（payload.message 纯文本）；
 * 2. 新 Desktop / 迁移后（history_mode: paginated）：用户输入直接作为 `response_item`
 *    里 `role:"user"` 的 message 写盘，且同一轮前面会写入 `<recommended_plugins>` /
 *    `<environment_context>` / `<INSTRUCTIONS>` 等注入包装。
 *
 * 本导入器只支持新格式：装新版 Codex 后旧 jsonl 会被它自带的
 * legacy_to_paginated_v1 迁移器自动转换（少数迁移失败的文件不再兼容，属可接受取舍）。
 */

/**
 * 注入包装块：从消息原文中剥掉（标题/预览不能是包装原文）。
 *
 * 全部形态来自真实 ~/.codex/sessions 数据统计（2026-09）：
 * - <environment_context> / <recommended_plugins> / <INSTRUCTIONS>：首轮环境与技能注入；
 * - <codex_internal_context> / <turn_aborted>：目标续跑与中断控制消息；
 * - <app-context> / <permissions instructions> / <user_instructions>：桌面上下文与权限说明；
 * - <send_user_message_question_reply>：交互式问答回传（正文是结构化 JSON）。
 * 标签分隔符历史上出现过下划线/连字符/空格三种写法，统一用 [_-]? 兼容。
 */
const CODEX_WRAPPER_TAG_NAMES = "recommended_plugins|environment_context|permissions[_-]?instructions|user_instructions|app[_-]context|codex_internal_context|turn_aborted|INSTRUCTIONS|send_user_message_question_reply";
const CODEX_WRAPPER_BLOCK_PATTERN = new RegExp(`<(${CODEX_WRAPPER_TAG_NAMES})\\b[^>]*>[\\s\\S]*?<\\/\\1>`, "gi");

/**
 * 纯注入/控制消息的起始标记：剥完包装块后仍以这些开头的内容不是用户原话（用于标题/预览）。
 * 典型：AGENTS.md 注入（只剩标题行）、响应注释、agent 历史回填、斜杠命令、中断提示。
 */
const CODEX_INTERNAL_TEXT_PREFIXES = [/^#\s*AGENTS\.md instructions\b/i, /^#\s*In app browser:/i, /^#\s*Response annotations:/i, /^##\s*Code review guidelines:/i, /^The following is the Codex agent history\b/i, /^\[Request interrupted by user/i, /^<command-name>/i, /^<send_user_message_question_reply>/i];

/**
 * 除标准 function_call 外，Codex 还有一批语义化工具行（真实数据统计得出）。
 * custom_tool_call（apply_patch / exec）是主力工具，量级与 function_call 同级，
 * 过去被整段跳过——导入后的会话中间工具调用凭空消失。
 */
const CODEX_EXTRA_TOOL_TYPES = new Set(["custom_tool_call", "web_search_call", "tool_search_call", "image_generation_call", "agent_message"]);

/** 上述工具行的结果行；按 call_id 与前面的调用配对。 */
const CODEX_EXTRA_TOOL_RESULT_TYPES = new Set(["custom_tool_call_output", "tool_search_output"]);

/**
 * 转换器版本：写进 import 标记。转换逻辑影响**产物有效性**时 bump——
 * 旧版本产物在扫描列表里显示 outdated，引导用户重导修复。
 * v2：并行 toolCall 合并（修复一轮并行调用逐条写 assistant 导致的
 * 「tool 消息前无 tool_calls」孤儿 toolResult，严格供应商 400）。
 */
export const CODEX_IMPORT_CONVERTER_VERSION = 2;

/**
 * 会话名文本清洗（jsonl 提取与状态库标题共用）：
 * 剥注入包装 → 去内部标记 → 从粘贴文件列表里取 `## My request:` 正文。
 * 清洗后为空表示“这段文本不能当标题/预览”。
 */
function sanitizeCodexTitleText(value: string): string {
	const stripped = value.replace(CODEX_WRAPPER_BLOCK_PATTERN, "").trim();
	if (!stripped) return "";
	// 纯内部标记（AGENTS.md 标题行、响应注释、历史回填、斜杠命令、中断提示等）不是用户原话。
	if (CODEX_INTERNAL_TEXT_PREFIXES.some((pattern) => pattern.test(stripped))) return "";
	// 粘贴文件列表：真正的诉求写在 `## My request:` 段；没写就整条丢弃（文件清单当标题是噪声）。
	const requestMatch = stripped.match(/##\s*My request:\s*([\s\S]*)$/i);
	if (requestMatch) return requestMatch[1].trim();
	if (/^#\s*Files (?:pasted|mentioned) by the user:/i.test(stripped)) return "";
	return stripped;
}

/**
 * 提取新格式 `role:"user"` 消息里用户真正打的字。
 *
 * 优先依据 payload 自带的 content_item_kinds（Codex 写盘的块来源元数据：
 * user.text = 用户原话；plugins.recommendations / environments.environment_context 等 = 注入包装）。
 * 缺失时启发式剥包装块；剥完只剩内部标记时返回空（调用方跳过该消息）。
 */
function extractCodexDesktopUserText(payload: Record<string, any>): string {
	const blocks = Array.isArray(payload?.content) ? payload.content : [];
	const allText = blocks
		.map((item: unknown) => {
			if (typeof item === "string") return item;
			if (!item || typeof item !== "object") return "";
			return String((item as Record<string, unknown>).text ?? "");
		})
		.filter(Boolean)
		.join("\n")
		.trim();
	if (!allText) return "";

	// 每条 user message 的 internal_chat_message_metadata_passthrough.content_item_kinds
	// 标明块来源；只有含 user.text 的消息才可能承载用户原话。
	const kindsRaw = payload?.internal_chat_message_metadata_passthrough?.content_item_kinds;
	const kinds: string[] = Array.isArray(kindsRaw) ? kindsRaw.map((kind: unknown) => String(kind)) : [];
	if (kinds.length > 0 && !kinds.includes("user.text")) return "";

	return sanitizeCodexTitleText(allText);
}

type ParsedCodexSession = {
	meta: Record<string, any>;
	entries: Array<Record<string, any>>;
	sourcePath: string;
	sourceSize: number;
	sourceMtime: number;
};

export class CodexSessionImporter {
	private readonly codexRoot = join(app.getPath("home"), ".codex", "sessions");
	private readonly codexHome = join(app.getPath("home"), ".codex");
	private readonly piRoot = join(app.getPath("home"), ".pi", "agent", "sessions");

	constructor(private readonly translate: SessionImportCopy = defaultSessionImportCopy) {}

	async scan(projectPath: string): Promise<CodexSessionSummary[]> {
		const files = await this.collectJsonl(this.codexRoot).catch(() => []);
		const normalizedProject = this.normalize(projectPath);
		// Codex 状态库的会话名映射（用户改名 / 官方标题）：读不到时降级为 jsonl 提取，不阻塞扫描
		const titleMaps: CodexThreadTitleMaps = await loadCodexThreadTitles(this.codexHome);

		// 阶段 1：预过滤——每个文件只读头部 64KB 提取 session_meta.cwd，定位属于当前项目的会话。
		// 注意：~/.codex/sessions 下是所有项目的会话（codex 按 cwd 归档、目录名是 UUID），
		// 只能全目录预过滤后再按项目筛选；非当前项目的会话（可能成百上千）不读正文，
		// 巨型会话（几百 MB~1GB）也只读这 64KB 即丢弃——扫描开销与目录总大小解耦。
		const candidates: string[] = [];
		for (let i = 0; i < files.length; i += SCAN_CONCURRENCY) {
			const chunk = files.slice(i, i + SCAN_CONCURRENCY);
			const metas = await Promise.all(chunk.map((file) => this.readCodexMetaOnly(file).catch(() => null)));
			metas.forEach((meta, index) => {
				if (meta && this.normalize(meta.meta.cwd) === normalizedProject) {
					candidates.push(chunk[index]);
				}
			});
		}

		// 阶段 2：候选会话读头部（1MB）生成 summary；分块并发限制驻留缓冲；
		// 单会话解析/转换失败跳过，不影响其余会话。
		const sessions: Array<ParsedCodexSession | null> = [];
		for (let i = 0; i < candidates.length; i += SCAN_CONCURRENCY) {
			const chunk = candidates.slice(i, i + SCAN_CONCURRENCY);
			const results = await Promise.all(chunk.map((file) => this.readCodexSession(file).catch(() => null)));
			sessions.push(...results);
		}

		const summaries = await Promise.all(sessions.filter((session): session is ParsedCodexSession => Boolean(session)).map((session) => this.toSummary(session, projectPath, titleMaps).catch(() => null)));
		return summaries.filter((summary): summary is CodexSessionSummary => Boolean(summary)).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	/**
	 * 只读文件头部提取完整 session_meta（codex 会话第一行即 session_meta）用于项目预过滤
	 * 与导入元信息；坏行/截断容忍。头部没有 meta 视为不可扫描（返回 null）。
	 */
	private async readCodexMetaOnly(filePath: string): Promise<ParsedCodexSession | null> {
		this.assertCodexSourcePath(filePath);
		const info = await stat(filePath);
		const raw = await this.readFileHead(filePath, META_HEAD_LIMIT);
		for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 8)) {
			try {
				const entry = JSON.parse(line) as Record<string, any>;
				if (entry.type === "session_meta" && entry.payload?.id && entry.payload?.cwd) {
					return {
						meta: entry.payload,
						entries: [],
						sourcePath: filePath,
						sourceSize: info.size,
						sourceMtime: info.mtimeMs,
					};
				}
			} catch {
				// 坏行跳过（与 headOnly 解析同策略）
			}
		}
		return null;
	}

	async import(projectPath: string, sourcePaths: string[]): Promise<CodexImportReport> {
		const results: CodexImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(await this.importOne(projectPath, sourcePath));
		}
		return {
			results,
			imported: results.filter((result) => result.success).length,
			failed: results.filter((result) => !result.success).length,
		};
	}

	private async importOne(projectPath: string, sourcePath: string): Promise<CodexImportResult> {
		try {
			// 轻量读 meta（只读头部 64KB + stat），不加载正文——巨型会话（几百 MB~1GB）
			// 全量解析会 OOM 导致应用被系统静默杀死，导入改为流式转换（见 convertToPiSessionStreaming）
			const info = await this.readCodexMetaOnly(sourcePath);
			if (!info) throw new Error("Missing Codex session metadata");
			const sourceCwd = this.normalize(info.meta.cwd);
			if (sourceCwd !== this.normalize(projectPath)) {
				throw new Error("Codex session cwd does not match selected project");
			}

			// 状态库会话名：单次导入也查一次（有内存缓存，重复导入不重复拷库）
			const titleMaps: CodexThreadTitleMaps = await loadCodexThreadTitles(this.codexHome);
			const threadTitle = lookupCodexThreadTitle(titleMaps, info.meta.id ? String(info.meta.id) : undefined, sourcePath);
			const targetPath = this.getTargetPath(projectPath, info);
			const existing = await this.readImportMeta(targetPath);
			await mkdir(this.getProjectSessionDir(projectPath), { recursive: true });
			// 原子写：先写同目录临时文件再改名（与 Minimax 导入器同构）——直接 open(targetPath, "w")
			// 会先截断目标，转换中途失败（磁盘满/进程退出）会留下半份产物，旧会话内容也丢了。
			// 临时文件放目标目录旁（同盘原子改名），不写进源目录（~/.codex）。
			const tempPath = join(this.getProjectSessionDir(projectPath), `.pideck-import-${randomUUID().slice(0, 8)}.tmp`);
			try {
				const converted = await this.convertToPiSessionStreaming(projectPath, info, tempPath, threadTitle);
				await renameWithRetry(tempPath, targetPath);
				return {
					id: String(info.meta.id ?? sourcePath),
					sourcePath,
					targetPath,
					title: converted.title,
					success: true,
					overwritten: Boolean(existing),
					messageCount: converted.messageCount,
				};
			} finally {
				// 成功路径文件已改名不存在；失败路径清掉半份临时文件，不留垃圾
				await rm(tempPath, { force: true }).catch(() => undefined);
			}
		} catch (error) {
			return {
				id: sourcePath,
				sourcePath,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async toSummary(session: ParsedCodexSession, projectPath: string, titleMaps: CodexThreadTitleMaps): Promise<CodexSessionSummary> {
		const targetPath = this.getTargetPath(projectPath, session);
		const importMeta = await this.readImportMeta(targetPath);
		const threadTitle = lookupCodexThreadTitle(titleMaps, session.meta.id ? String(session.meta.id) : undefined, session.sourcePath);
		const converted = this.convertToPiSession(projectPath, session, threadTitle);
		// 转换器版本不一致也按 outdated：旧转换产物可能含孤儿 toolResult（400 根因），引导重导
		const status: CodexImportStatus = !importMeta ? "new" : importMeta.version !== CODEX_IMPORT_CONVERTER_VERSION || importMeta.sourceMtime !== session.sourceMtime || importMeta.sourceSize !== session.sourceSize ? "outdated" : "current";

		const originalTimestamp = Date.parse(String(session.meta.timestamp ?? "")) || session.sourceMtime;
		const threadInfo = getCodexSessionThreadInfo(session.meta);
		return {
			id: String(session.meta.id ?? session.sourcePath),
			sourcePath: session.sourcePath,
			targetPath,
			cwd: String(session.meta.cwd ?? ""),
			title: converted.title,
			preview: converted.preview,
			createdAt: originalTimestamp,
			updatedAt: originalTimestamp,
			messageCount: converted.messageCount,
			status,
			sourceSize: session.sourceSize,
			importedSourceMtime: importMeta?.sourceMtime,
			threadSource: threadInfo.threadSource,
			parentThreadId: threadInfo.parentThreadId,
			agentRole: threadInfo.agentRole,
			agentNickname: threadInfo.agentNickname,
		};
	}

	private convertToPiSession(projectPath: string, session: ParsedCodexSession, threadTitle?: CodexThreadTitle) {
		const sessionId = String(session.meta.id ?? this.hash(session.sourcePath));
		const threadInfo = getCodexSessionThreadInfo(session.meta);
		const timestamp = new Date(Date.parse(String(session.meta.timestamp ?? "")) || session.sourceMtime).toISOString();
		const titleState = { title: "", preview: "" };
		// Codex 状态库预取的标题（用户改名优先，其次官方自动标题/首条消息）：
		// 库里的值同样可能是一整块注入包装或斜杠命令（如 `<command-name>/exit</command-name>`），
		// 必须走同一套清洗，否则脏标题会直接从库里流进侧栏。
		const presetTitle = this.cleanTitle(sanitizeCodexTitleText(threadTitle?.name ?? ""));
		// jsonl 里提不出用户文本时（如包装剥不干净/首轮就崩）仍能有像样的名字
		const toolNames = new Map<string, string>();
		const toolStartedAt = new Map<string, number>();
		const lines: string[] = [];
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;
		let pendingThinking = "";

		const pushEntry = (entry: Record<string, unknown>) => {
			lines.push(JSON.stringify(entry));
		};
		const emitMessage = (role: "user" | "assistant" | "toolResult", content: unknown[], extra: Record<string, unknown> = {}, timestampValue?: unknown) => {
			if (content.length === 0) return;
			const id = this.makeId(sessionId, sequence++);
			const messageTimestamp = this.parseTimestamp(timestampValue) ?? session.sourceMtime + sequence;
			const ts = new Date(messageTimestamp).toISOString();
			pushEntry({
				type: "message",
				id,
				parentId,
				timestamp: ts,
				message: {
					role,
					content,
					timestamp: messageTimestamp,
					// pi 的上下文统计会读取 assistant.usage.totalTokens；Codex 原始历史没有该字段，导入时用 0 值占位保证可继续对话。
					...(role === "assistant" ? { usage: this.zeroUsage() } : {}),
					...extra,
				},
			});
			parentId = id;
			messageCount += 1;

			const text = this.extractPiText(content).trim();
			if (text && !titleState.preview) titleState.preview = text.slice(0, 160);
			if (role === "user" && text && !titleState.title && !presetTitle) {
				titleState.title = this.cleanTitle(text);
			}
		};

		// assistant 运行合并缓冲 + tool 配对跟踪（判定规则与 Claude 导入器同款，改动必须两边同步）：
		// Codex 把同一轮响应拆成多个连续 response_item（并行 function_call、call 与结果之间的
		// 穿插文本），只要 user/toolResult 不出现就仍属同一轮——并为一条 assistant 写出
		// （OpenAI 多 tool_calls 语义），否则 pi transformMessages 在每个新 assistant 边界重置
		// 挂起集，靠前 call 的 toolResult 变孤儿（严格供应商 400）。
		// 挂起集之外的 toolResult 降级为用户文本保留内容（同 Claude 导入器）。
		const pendingToolCalls = new Set<string>();
		let mergeBuffer: { content: unknown[]; extra: Record<string, unknown>; timestampValue: unknown } | null = null;
		const flushMergeBuffer = () => {
			if (!mergeBuffer) return;
			const buffered = mergeBuffer;
			mergeBuffer = null;
			emitMessage("assistant", buffered.content, buffered.extra, buffered.timestampValue);
		};
		const pushMessage = (role: "user" | "assistant" | "toolResult", content: unknown[], extra: Record<string, unknown> = {}, timestampValue?: unknown) => {
			if (content.length === 0) return;
			if (role === "assistant") {
				if (mergeBuffer) mergeBuffer.content.push(...content);
				else {
					pendingToolCalls.clear();
					mergeBuffer = { content: [...content], extra, timestampValue };
				}
				for (const item of content) {
					const block = item as Record<string, unknown>;
					if (block?.type === "toolCall" && typeof block.id === "string") pendingToolCalls.add(block.id);
				}
				return;
			}
			flushMergeBuffer();
			if (role === "user") {
				pendingToolCalls.clear();
			} else if (role === "toolResult") {
				const toolCallId = String(extra.toolCallId ?? "");
				if (!pendingToolCalls.delete(toolCallId)) {
					const text = this.extractPiText(content).trim();
					if (!text) return;
					return pushMessage("user", [{ type: "text", text: this.translate("session.importedOrphanToolResult", { tool: String(extra.toolName ?? "tool"), text }) }], {}, timestampValue);
				}
			}
			emitMessage(role, content, extra, timestampValue);
		};

		pushEntry({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp,
			cwd: projectPath,
		});
		pushEntry({
			type: "codex_import",
			version: CODEX_IMPORT_CONVERTER_VERSION,
			codexSessionId: sessionId,
			sourcePath: session.sourcePath,
			sourceMtime: session.sourceMtime,
			sourceSize: session.sourceSize,
			importedAt: new Date().toISOString(),
			threadSource: threadInfo.threadSource,
			parentThreadId: threadInfo.parentThreadId,
			agentRole: threadInfo.agentRole,
			agentNickname: threadInfo.agentNickname,
		});
		const modelChangeId = this.makeId(sessionId, sequence++);
		pushEntry({
			type: "model_change",
			id: modelChangeId,
			parentId,
			timestamp,
			provider: String(session.meta.model_provider ?? "codex"),
			modelId: String(session.meta.model ?? "codex"),
		});
		parentId = modelChangeId;

		for (const entry of session.entries) {
			if (entry.type !== "response_item") continue;
			const payload = entry.payload ?? {};

			// 新格式：用户输入直接作为 response_item 里的 user message 写盘
			// （包装块已在 extractCodexDesktopUserText 里剥掉）
			if (payload.type === "message" && payload.role === "user") {
				const text = extractCodexDesktopUserText(payload);
				if (text) {
					const content = [{ type: "text", text }, ...this.extractCodexImportedImages(payload)];
					pushMessage("user", content, {}, entry.timestamp);
				}
				continue;
			}

			if (payload.type === "reasoning") {
				const reasoning = this.extractCodexText(payload).trim();
				if (reasoning) pendingThinking = this.joinText(pendingThinking, reasoning);
				continue;
			}

			if (payload.type === "message" && payload.role === "assistant") {
				const text = this.extractCodexText(payload).trim();
				const content = [...(pendingThinking ? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }] : []), ...(text ? [{ type: "text", text }] : []), ...this.extractCodexImportedImages(payload)];
				pendingThinking = "";
				pushMessage(
					"assistant",
					content,
					{
						api: "codex-import",
						provider: String(session.meta.model_provider ?? "codex"),
						model: String(session.meta.model ?? "codex"),
						stopReason: normalizeImportedStopReason({ hasToolCall: false }),
					},
					entry.timestamp,
				);
				continue;
			}

			if (payload.type === "function_call") {
				const callId = String(payload.call_id ?? payload.id ?? this.makeId(sessionId, sequence));
				const toolName = String(payload.name ?? "tool");
				toolNames.set(callId, toolName);
				const callStartedAt = this.parseTimestamp(entry.timestamp);
				if (callStartedAt !== undefined) toolStartedAt.set(callId, callStartedAt);
				const args = this.parseArguments(payload.arguments);
				const content = [...(pendingThinking ? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }] : []), { type: "toolCall", id: callId, name: toolName, arguments: args }];
				pendingThinking = "";
				pushMessage(
					"assistant",
					content,
					{
						api: "codex-import",
						provider: String(session.meta.model_provider ?? "codex"),
						model: String(session.meta.model ?? "codex"),
						stopReason: normalizeImportedStopReason({ hasToolCall: true }),
					},
					entry.timestamp,
				);
				continue;
			}

			// 非标准工具行（custom_tool_call / web_search_call / tool_search_call /
			// image_generation_call / agent_message）：与 function_call 同一套 pi 形态。
			if (CODEX_EXTRA_TOOL_TYPES.has(payload.type)) {
				const match = this.matchCodexToolLine(payload, this.makeId(sessionId, sequence), { names: toolNames, startedAt: toolStartedAt }, entry.timestamp);
				if (match) {
					const content = [...(pendingThinking ? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }] : []), { type: "toolCall", id: match.call.id, name: match.call.name, arguments: match.call.arguments }];
					pendingThinking = "";
					pushMessage(
						"assistant",
						content,
						{
							api: "codex-import",
							provider: String(session.meta.model_provider ?? "codex"),
							model: String(session.meta.model ?? "codex"),
							stopReason: normalizeImportedStopReason({ hasToolCall: true }),
						},
						entry.timestamp,
					);
					if (match.result) {
						pushMessage(
							"toolResult",
							match.result.content,
							{
								toolCallId: match.call.id,
								toolName: match.call.name,
								isError: match.result.isError,
								...(toolStartedAt.get(match.call.id) !== undefined ? { startedAt: toolStartedAt.get(match.call.id) } : {}),
							},
							entry.timestamp,
						);
					}
				}
				continue;
			}

			// 非标准工具的结果行（custom_tool_call_output / tool_search_output）
			if (CODEX_EXTRA_TOOL_RESULT_TYPES.has(payload.type)) {
				const matched = this.matchCodexToolResultLine(payload, { names: toolNames, startedAt: toolStartedAt }, entry.timestamp);
				if (matched) {
					pushMessage(
						"toolResult",
						matched.content,
						{
							toolCallId: matched.toolCallId,
							toolName: matched.toolName,
							isError: matched.isError,
							...(matched.startedAt !== undefined ? { startedAt: matched.startedAt } : {}),
							...(matched.startedAt !== undefined && matched.completedAt !== undefined ? { durationMs: Math.max(0, matched.completedAt - matched.startedAt) } : {}),
						},
						entry.timestamp,
					);
				}
				continue;
			}

			if (payload.type === "function_call_output") {
				const callId = String(payload.call_id ?? payload.id ?? this.makeId(sessionId, sequence));
				const output = this.extractToolOutput(payload);
				const completedAt = this.parseTimestamp(entry.timestamp);
				const startedAt = toolStartedAt.get(callId);
				pushMessage(
					"toolResult",
					[{ type: "text", text: output }],
					{
						toolCallId: callId,
						toolName: toolNames.get(callId) ?? "tool",
						isError: Boolean(payload.is_error),
						// Codex 历史只有 function_call / output 时间戳，导入时保存派生耗时，
						// 让桌面端工具卡片与原生 pi 会话保持一致。
						...(startedAt !== undefined ? { startedAt } : {}),
						...(startedAt !== undefined && completedAt !== undefined ? { durationMs: Math.max(0, completedAt - startedAt) } : {}),
					},
					entry.timestamp,
				);
			}
		}

		// 尾部冲刷：文件以并行调用结尾时缓冲里的 toolCall 不能丢
		flushMergeBuffer();
		if (pendingThinking) {
			pushMessage("assistant", [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }]);
		}

		const title = presetTitle || titleState.title || this.fallbackTitle(session);
		// 使用 pi 原生 session_info 格式追加在末尾，避免旧版 sessionName 行（无 type 字段）
		// 在文件头破坏 pi 的首行校验导致会话无法加载（见 #114）。
		const sessionInfoId = randomUUID().slice(0, 8);
		lines.push(
			JSON.stringify({
				type: "session_info",
				id: sessionInfoId,
				parentId,
				timestamp: new Date().toISOString(),
				name: title,
				cwd: projectPath,
			}),
		);

		return {
			raw: `${lines.join("\n")}\n`,
			title,
			preview: titleState.preview || this.translate("session.importedPreview", { source: "Codex" }),
			messageCount,
		};
	}

	/**
	 * 流式导入转换：逐行读源文件、逐行写目标文件，内存峰值 O(单行)，
	 * 支持数百 MB~1GB 巨型会话（全量版会在 JSON.parse 时 OOM，被系统静默杀进程）。
	 * 状态机（title/preview/messageCount/parentId/sequence/pendingThinking）与
	 * convertToPiSession 保持一致——scan 预览与 import 结果必须等价。
	 */
	private async convertToPiSessionStreaming(projectPath: string, session: ParsedCodexSession, targetPath: string, threadTitle?: CodexThreadTitle): Promise<{ title: string; preview: string; messageCount: number }> {
		const sessionId = String(session.meta.id ?? this.hash(session.sourcePath));
		const threadInfo = getCodexSessionThreadInfo(session.meta);
		const timestamp = new Date(Date.parse(String(session.meta.timestamp ?? "")) || session.sourceMtime).toISOString();
		const titleState = { title: "", preview: "" };
		// 与 convertToPiSession 同口径：状态库预取标题优先（同样要清洗内部包装），jsonl 提取只是兑底
		const presetTitle = this.cleanTitle(sanitizeCodexTitleText(threadTitle?.name ?? ""));
		const toolNames = new Map<string, string>();
		const toolStartedAt = new Map<string, number>();
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;
		let pendingThinking = "";

		// 目标文件打开于 try 外，任何异常路径都由 finally 关闭
		const handle = await open(targetPath, "w");
		// 1MB 写缓冲：巨型会话可达几十万行，逐行系统调用太慢
		let writeBuffer = "";
		const flushBuffer = async () => {
			if (writeBuffer) {
				await handle.write(writeBuffer);
				writeBuffer = "";
			}
		};
		const pushEntry = async (entry: Record<string, unknown>) => {
			writeBuffer += `${JSON.stringify(entry)}\n`;
			if (writeBuffer.length >= 1024 * 1024) await flushBuffer();
		};
		const emitMessage = async (role: "user" | "assistant" | "toolResult", content: unknown[], extra: Record<string, unknown> = {}, timestampValue?: unknown) => {
			if (content.length === 0) return;
			const id = this.makeId(sessionId, sequence++);
			const messageTimestamp = this.parseTimestamp(timestampValue) ?? session.sourceMtime + sequence;
			const ts = new Date(messageTimestamp).toISOString();
			await pushEntry({
				type: "message",
				id,
				parentId,
				timestamp: ts,
				message: {
					role,
					content,
					timestamp: messageTimestamp,
					// pi 的上下文统计会读取 assistant.usage.totalTokens；Codex 原始历史没有该字段，导入时用 0 值占位保证可继续对话。
					...(role === "assistant" ? { usage: this.zeroUsage() } : {}),
					...extra,
				},
			});
			parentId = id;
			messageCount += 1;

			const text = this.extractPiText(content).trim();
			if (text && !titleState.preview) titleState.preview = text.slice(0, 160);
			if (role === "user" && text && !titleState.title && !presetTitle) {
				titleState.title = this.cleanTitle(text);
			}
		};

		// assistant 运行合并缓冲 + tool 配对跟踪：与上方内存路径同款实现，改动必须两边同步。
		const pendingToolCalls = new Set<string>();
		let mergeBuffer: { content: unknown[]; extra: Record<string, unknown>; timestampValue: unknown } | null = null;
		const flushMergeBuffer = async () => {
			if (!mergeBuffer) return;
			const buffered = mergeBuffer;
			mergeBuffer = null;
			await emitMessage("assistant", buffered.content, buffered.extra, buffered.timestampValue);
		};
		const pushMessage = async (role: "user" | "assistant" | "toolResult", content: unknown[], extra: Record<string, unknown> = {}, timestampValue?: unknown) => {
			if (content.length === 0) return;
			if (role === "assistant") {
				if (mergeBuffer) mergeBuffer.content.push(...content);
				else {
					pendingToolCalls.clear();
					mergeBuffer = { content: [...content], extra, timestampValue };
				}
				for (const item of content) {
					const block = item as Record<string, unknown>;
					if (block?.type === "toolCall" && typeof block.id === "string") pendingToolCalls.add(block.id);
				}
				return;
			}
			await flushMergeBuffer();
			if (role === "user") {
				pendingToolCalls.clear();
			} else if (role === "toolResult") {
				const toolCallId = String(extra.toolCallId ?? "");
				if (!pendingToolCalls.delete(toolCallId)) {
					const text = this.extractPiText(content).trim();
					if (!text) return;
					return pushMessage("user", [{ type: "text", text: this.translate("session.importedOrphanToolResult", { tool: String(extra.toolName ?? "tool"), text }) }], {}, timestampValue);
				}
			}
			await emitMessage(role, content, extra, timestampValue);
		};

		try {
			await pushEntry({
				type: "session",
				version: 3,
				id: sessionId,
				timestamp,
				cwd: projectPath,
			});
			await pushEntry({
				type: "codex_import",
				version: CODEX_IMPORT_CONVERTER_VERSION,
				codexSessionId: sessionId,
				sourcePath: session.sourcePath,
				sourceMtime: session.sourceMtime,
				sourceSize: session.sourceSize,
				importedAt: new Date().toISOString(),
				threadSource: threadInfo.threadSource,
				parentThreadId: threadInfo.parentThreadId,
				agentRole: threadInfo.agentRole,
				agentNickname: threadInfo.agentNickname,
			});
			const modelChangeId = this.makeId(sessionId, sequence++);
			await pushEntry({
				type: "model_change",
				id: modelChangeId,
				parentId,
				timestamp,
				provider: String(session.meta.model_provider ?? "codex"),
				modelId: String(session.meta.model ?? "codex"),
			});
			parentId = modelChangeId;

			// 逐行流式转换（经 readJsonlObjects 的 64MiB 单行防线，裸 readline 会无界缓冲
			// ——2026-03 导入器安全审计）；session_meta/turn_context 等非消息行在循环中被自然跳过
			for await (const entry of readJsonlObjects(session.sourcePath)) {
				if (entry.type !== "response_item") continue;
				const payload = entry.payload ?? {};

				// 新格式：用户输入直接作为 response_item 里的 user message 写盘
				// （包装块已在 extractCodexDesktopUserText 里剥掉）
				if (payload.type === "message" && payload.role === "user") {
					const text = extractCodexDesktopUserText(payload);
					if (text) {
						const content = [{ type: "text", text }, ...this.extractCodexImportedImages(payload)];
						await pushMessage("user", content, {}, entry.timestamp);
					}
					continue;
				}

				if (payload.type === "reasoning") {
					const reasoning = this.extractCodexText(payload).trim();
					if (reasoning) pendingThinking = this.joinText(pendingThinking, reasoning);
					continue;
				}

				if (payload.type === "message" && payload.role === "assistant") {
					const text = this.extractCodexText(payload).trim();
					const content = [...(pendingThinking ? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }] : []), ...(text ? [{ type: "text", text }] : []), ...this.extractCodexImportedImages(payload)];
					pendingThinking = "";
					await pushMessage(
						"assistant",
						content,
						{
							api: "codex-import",
							provider: String(session.meta.model_provider ?? "codex"),
							model: String(session.meta.model ?? "codex"),
							stopReason: normalizeImportedStopReason({ hasToolCall: false }),
						},
						entry.timestamp,
					);
					continue;
				}

				if (payload.type === "function_call") {
					const callId = String(payload.call_id ?? payload.id ?? this.makeId(sessionId, sequence));
					const toolName = String(payload.name ?? "tool");
					toolNames.set(callId, toolName);
					const callStartedAt = this.parseTimestamp(entry.timestamp);
					if (callStartedAt !== undefined) toolStartedAt.set(callId, callStartedAt);
					const args = this.parseArguments(payload.arguments);
					const content = [...(pendingThinking ? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }] : []), { type: "toolCall", id: callId, name: toolName, arguments: args }];
					pendingThinking = "";
					await pushMessage(
						"assistant",
						content,
						{
							api: "codex-import",
							provider: String(session.meta.model_provider ?? "codex"),
							model: String(session.meta.model ?? "codex"),
							stopReason: normalizeImportedStopReason({ hasToolCall: true }),
						},
						entry.timestamp,
					);
					continue;
				}

				// 非标准工具行（custom_tool_call / web_search_call / tool_search_call /
				// image_generation_call / agent_message）：与 function_call 同一套 pi 形态。
				if (CODEX_EXTRA_TOOL_TYPES.has(payload.type)) {
					const match = this.matchCodexToolLine(payload, this.makeId(sessionId, sequence), { names: toolNames, startedAt: toolStartedAt }, entry.timestamp);
					if (match) {
						const content = [...(pendingThinking ? [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }] : []), { type: "toolCall", id: match.call.id, name: match.call.name, arguments: match.call.arguments }];
						pendingThinking = "";
						await pushMessage(
							"assistant",
							content,
							{
								api: "codex-import",
								provider: String(session.meta.model_provider ?? "codex"),
								model: String(session.meta.model ?? "codex"),
								stopReason: normalizeImportedStopReason({ hasToolCall: true }),
							},
							entry.timestamp,
						);
						if (match.result) {
							const startedAt = toolStartedAt.get(match.call.id);
							const completedAt = this.parseTimestamp(entry.timestamp);
							await pushMessage(
								"toolResult",
								match.result.content,
								{
									toolCallId: match.call.id,
									toolName: match.call.name,
									isError: match.result.isError,
									...(startedAt !== undefined ? { startedAt } : {}),
									...(startedAt !== undefined && completedAt !== undefined ? { durationMs: Math.max(0, completedAt - startedAt) } : {}),
								},
								entry.timestamp,
							);
						}
					}
					continue;
				}

				// 非标准工具的结果行（custom_tool_call_output / tool_search_output）
				if (CODEX_EXTRA_TOOL_RESULT_TYPES.has(payload.type)) {
					const matched = this.matchCodexToolResultLine(payload, { names: toolNames, startedAt: toolStartedAt }, entry.timestamp);
					if (matched) {
						await pushMessage(
							"toolResult",
							matched.content,
							{
								toolCallId: matched.toolCallId,
								toolName: matched.toolName,
								isError: matched.isError,
								...(matched.startedAt !== undefined ? { startedAt: matched.startedAt } : {}),
								...(matched.startedAt !== undefined && matched.completedAt !== undefined ? { durationMs: Math.max(0, matched.completedAt - matched.startedAt) } : {}),
							},
							entry.timestamp,
						);
					}
					continue;
				}

				if (payload.type === "function_call_output") {
					const callId = String(payload.call_id ?? payload.id ?? this.makeId(sessionId, sequence));
					const output = this.extractToolOutput(payload);
					const completedAt = this.parseTimestamp(entry.timestamp);
					const startedAt = toolStartedAt.get(callId);
					await pushMessage(
						"toolResult",
						[{ type: "text", text: output }],
						{
							toolCallId: callId,
							toolName: toolNames.get(callId) ?? "tool",
							isError: Boolean(payload.is_error),
							// Codex 历史只有 function_call / output 时间戳，导入时保存派生耗时，
							// 让桌面端工具卡片与原生 pi 会话保持一致。
							...(startedAt !== undefined ? { startedAt } : {}),
							...(startedAt !== undefined && completedAt !== undefined ? { durationMs: Math.max(0, completedAt - startedAt) } : {}),
						},
						entry.timestamp,
					);
				}
			}

			// 尾部冲刷：文件以并行调用结尾时缓冲里的 toolCall 不能丢
			await flushMergeBuffer();
			if (pendingThinking) {
				await pushMessage("assistant", [{ type: "thinking", thinking: pendingThinking, thinkingSignature: "codex_reasoning" }]);
			}

			const title = presetTitle || titleState.title || this.fallbackTitle(session);
			// 使用 pi 原生 session_info 格式追加在末尾，避免旧版 sessionName 行（无 type 字段）
			// 在文件头破坏 pi 的首行校验导致会话无法加载（见 #114）。
			const sessionInfoId = randomUUID().slice(0, 8);
			await pushEntry({
				type: "session_info",
				id: sessionInfoId,
				parentId,
				timestamp: new Date().toISOString(),
				name: title,
				cwd: projectPath,
			});
			await flushBuffer();

			return {
				title,
				preview: titleState.preview || this.translate("session.importedPreview", { source: "Codex" }),
				messageCount,
			};
		} finally {
			await handle.close();
		}
	}

	private zeroUsage() {
		return {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	private async readCodexSession(filePath: string): Promise<ParsedCodexSession> {
		this.assertCodexSourcePath(filePath);
		const info = await stat(filePath);
		// 扫描只读头部：头部截断可能切在行中间/多字节字符上，坏行直接跳过（近似扫描）
		const raw = await this.readFileHead(filePath, SCAN_HEAD_LIMIT);
		const entries: Array<Record<string, any>> = [];
		for (const line of raw.split(/\r?\n/).filter(Boolean)) {
			try {
				entries.push(JSON.parse(line) as Record<string, any>);
			} catch {
				// 坏行跳过（近似扫描语义）
			}
		}
		const meta = entries.find((entry) => entry.type === "session_meta")?.payload;
		if (!meta?.id || !meta?.cwd) throw new Error("Missing Codex session metadata");
		return {
			meta,
			entries,
			sourcePath: filePath,
			sourceSize: info.size,
			sourceMtime: info.mtimeMs,
		};
	}

	/** 只读文件前 limit 字节（扫描用，避免全量加载大文件）。 */
	private async readFileHead(filePath: string, limit: number): Promise<string> {
		const handle = await open(filePath, "r");
		try {
			const buffer = Buffer.alloc(limit);
			const { bytesRead } = await handle.read(buffer, 0, limit, 0);
			return buffer.subarray(0, bytesRead).toString("utf8");
		} finally {
			await handle.close();
		}
	}

	private assertCodexSourcePath(filePath: string) {
		// 语义校验（resolve 后比较）：词法 startsWith 不解析 `..`，曾可被
		// `<root>/../../任意文件` 绕过读任意文件（2026-03 导入器安全审计）
		assertSourceWithinRoot(this.codexRoot, filePath, "Codex");
	}

	/** 读取导入产物头部的 import 标记（有界读头部，不再整读会话文件——见 importMetaHead）。 */
	private async readImportMeta(targetPath: string) {
		return readImportMetaHead(targetPath, "codex_import");
	}

	private async collectJsonl(dir: string): Promise<string[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		const files: string[] = [];
		for (const entry of entries) {
			const path = join(dir, entry.name);
			if (entry.isDirectory()) {
				// codex CLI 的 rollouts/ 是每轮 agentic 轨迹文件，体积巨大且不是独立会话，
				// 扫描跳过（否则一次扫描会全量读入几十 MB 的轨迹文件）。
				if (entry.name === "rollouts") continue;
				files.push(...(await this.collectJsonl(path)));
			} else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
		}
		return files;
	}

	private getTargetPath(projectPath: string, session: Pick<ParsedCodexSession, "meta" | "sourcePath">) {
		const id = String(session.meta.id ?? this.hash(session.sourcePath)).replace(/[^a-zA-Z0-9_-]/g, "-");
		return join(this.getProjectSessionDir(projectPath), `codex_${id}.jsonl`);
	}

	private getProjectSessionDir(projectPath: string) {
		return join(this.piRoot, this.safePathToken(projectPath));
	}

	private safePathToken(path: string) {
		const normalized = path.replace(/\\/g, "/");
		// 盘符根（D:\）也要命中本分支：(.+) 时盘根落到 fallback 产出含 ":" 的非法目录名，导入必败
		const win = normalized.match(/^([A-Za-z]):\/(.*)$/);
		if (win) return `--${win[1]}--${win[2].replace(/\//g, "-")}--`;
		return `--${normalized.replace(/^\//, "").replace(/\//g, "-")}--`;
	}

	/**
	 * 兑底标题：状态库和正文都拿不到用户文本时，用「Codex 会话 + 源会话创建日期」。
	 * 不再用 rollout-<时间戳>-<UUID> 文件名——截断后就是一串无意义的 ID 样文本。
	 */
	private fallbackTitle(session: ParsedCodexSession) {
		const createdAt = Date.parse(String(session.meta.timestamp ?? "")) || session.sourceMtime;
		const day = Number.isFinite(createdAt) ? new Date(createdAt).toISOString().slice(0, 10) : "";
		return this.translate("session.codexUntitledTitle", day ? { date: day } : {});
	}

	private extractCodexImportedImages(payload: Record<string, unknown>): unknown[] {
		const images: unknown[] = [];
		const collect = (value: unknown) => {
			if (!Array.isArray(value)) return;
			for (const item of value) {
				const image = tryImportedImageBlock(item);
				if (image) images.push(image);
			}
		};
		collect(payload.content);
		collect(payload.images);
		return images;
	}

	private extractCodexText(payload: Record<string, any>) {
		const content = payload.content ?? payload.summary ?? payload.text ?? payload.output;
		if (typeof content === "string") return content;
		if (!Array.isArray(content)) return "";
		return content
			.map((item) => {
				if (typeof item === "string") return item;
				if (!item || typeof item !== "object") return "";
				return String(item.text ?? item.message ?? item.content ?? "");
			})
			.filter(Boolean)
			.join("\n");
	}

	/**
	 * 非标准工具行（custom_tool_call / web_search_call / tool_search_call /
	 * image_generation_call / agent_message）共用的配对状态。
	 *
	 * custom_tool_call 量与 function_call 同级（apply_patch / exec 是主力工具），
	 * 过去被整段跳过：会话导入后中间的工具调用凭空消失。这里按与 function_call
	 * 完全相同的 pi 形态（assistant.toolCall + 独立 toolResult 行）写入。
	 */
	private codexToolState() {
		return {
			names: new Map<string, string>(),
			startedAt: new Map<string, number>(),
		};
	}

	/** 把一条非标准工具行转成 pi 的 assistant.toolCall + 可选 toolResult（不匹配则 null）。 */
	private matchCodexToolLine(payload: Record<string, any>, fallbackId: string, state: { names: Map<string, string>; startedAt: Map<string, number> }, timestampValue?: unknown): { call: { id: string; name: string; arguments: Record<string, unknown> }; result?: { content: unknown[]; isError: boolean } } | null {
		const normalized = normalizeCodexToolLine(payload, fallbackId);
		if (!normalized) return null;
		const { call } = normalized;
		state.names.set(call.id, call.name);
		const startedAt = this.parseTimestamp(timestampValue);
		if (startedAt !== undefined) state.startedAt.set(call.id, startedAt);

		// image_generation_call 的图片结果就在同一行里：直接作为 toolResult 的图片内容。
		// 生成图常达 1~2MB base64，超过 IMPORTED_IMAGE_MAX_BASE64_CHARS 时由
		// tryImportedImageBlock 降级成占位文本（与其它导入器同一套体积护栏）。
		const generated = payload.type === "image_generation_call" ? codexImageGenerationResult(payload) : "";
		if (generated) {
			const image = tryImportedImageBlock({ type: "image", data: generated, mimeType: "image/png", name: "image_generation" });
			return { call, result: { content: image ? [image] : [{ type: "text", text: "[image]" }], isError: false } };
		}

		if (normalized.skipResult || !normalized.result) return { call };
		return { call, result: { content: [{ type: "text", text: normalized.result.text ?? "" }], isError: Boolean(normalized.result.isError) } };
	}

	/**
	 * 非标准工具行的“结果行”（custom_tool_call_output / tool_search_output）：
	 * 按 call_id 与前面的 toolCall 配对；tool_search_output 没有对应调用时忽略。
	 */
	private matchCodexToolResultLine(payload: Record<string, any>, state: { names: Map<string, string>; startedAt: Map<string, number> }, timestampValue?: unknown): { toolCallId: string; toolName: string; content: unknown[]; isError: boolean; startedAt?: number; completedAt?: number } | null {
		if (payload.type === "custom_tool_call_output") {
			const callId = String(payload.call_id ?? payload.id ?? "");
			if (!callId) return null;
			const parsed = parseCodexToolOutput(payload.output);
			return {
				toolCallId: callId,
				toolName: state.names.get(callId) ?? "tool",
				content: [{ type: "text", text: parsed.text }],
				isError: parsed.isError,
				startedAt: state.startedAt.get(callId),
				completedAt: this.parseTimestamp(timestampValue),
			};
		}
		if (payload.type === "tool_search_output") {
			const callId = String(payload.call_id ?? payload.id ?? "");
			if (!callId) return null;
			return {
				toolCallId: callId,
				toolName: state.names.get(callId) ?? "tool_search",
				content: [{ type: "text", text: codexToolSearchOutputText(payload) }],
				isError: false,
				startedAt: state.startedAt.get(callId),
				completedAt: this.parseTimestamp(timestampValue),
			};
		}
		return null;
	}

	private extractToolOutput(payload: Record<string, any>) {
		const output = payload.output ?? payload.content;
		if (typeof output === "string") return output;
		if (Array.isArray(output)) return this.extractCodexText({ content: output });
		try {
			return JSON.stringify(output ?? "", null, 2);
		} catch {
			return String(output ?? "");
		}
	}

	private parseArguments(value: unknown) {
		return normalizeImportedToolArguments(value);
	}

	private parseTimestamp(value: unknown) {
		if (typeof value === "number" && Number.isFinite(value)) return value;
		if (typeof value !== "string") return undefined;
		const parsed = Date.parse(value);
		return Number.isFinite(parsed) ? parsed : undefined;
	}

	private extractPiText(content: unknown[]) {
		return content
			.map((item) => (typeof item === "string" ? item : item && typeof item === "object" ? String((item as Record<string, unknown>).text ?? (item as Record<string, unknown>).thinking ?? (item as Record<string, unknown>).name ?? "") : ""))
			.filter(Boolean)
			.join(" ");
	}

	private cleanTitle(value?: string) {
		const text = value?.replace(/\s+/g, " ").trim();
		if (!text || /^untitled$/i.test(text)) return "";
		return text.length > 40 ? `${text.slice(0, 40)}...` : text;
	}

	private makeId(sessionId: string, sequence: number) {
		return this.hash(`${sessionId}:${sequence}`).slice(0, 8);
	}

	private hash(value: string) {
		return createHash("sha1").update(value).digest("hex");
	}

	private joinText(a: string, b: string) {
		if (!a) return b;
		if (!b) return a;
		return `${a}\n\n${b}`;
	}

	private normalize(path?: string) {
		return String(path ?? "")
			.replace(/\\/g, "/")
			.replace(/\/+$/, "")
			.toLowerCase();
	}
}
