import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ClaudeImportReport, ClaudeImportResult, ClaudeImportStatus, ClaudeSessionSummary } from "../../shared/types";
import { defaultSessionImportCopy, type SessionImportCopy } from "./SessionImportCopy";
import { normalizeImportedToolArguments } from "./importToolArguments";
import { assertSourceWithinRoot } from "./importPathGuard";
import { readImportMetaHead } from "./importMetaHead";
import { createBufferedLineSink, mapWithConcurrency, readJsonlObjects, readSessionSourceHead, renameWithRetry, SESSION_SCAN_CONCURRENCY } from "./sessionSourceHead";
import { importedContentHasToolCall, importedUnknownBlockAsText, normalizeImportedStopReason, tryImportedImageBlock } from "./importNormalize";

type ParsedClaudeSession = {
	meta: {
		sessionId: string;
		cwd: string;
		firstTimestamp: number;
		lastTimestamp: number;
	};
	entries: Array<Record<string, any>>;
	sourcePath: string;
	sourceSize: number;
	sourceMtime: number;
};

/** 向 pi 会话写一条消息（返回 Promise：流式导入要尊重写盘背压）。 */
type ClaudePushMessage = (role: "user" | "assistant" | "toolResult", content: unknown[], extra?: Record<string, unknown>, timestampValue?: string) => Promise<void>;

/**
 * 转换器版本：写进 import 标记。转换逻辑影响**产物有效性**时 bump——
 * 旧版本产物在扫描列表里显示 outdated，引导用户重导修复。
 * v2：活链重建 + 孤儿 toolResult 降级（修复 rewind/中断续聊的废弃分支导致的
 * 「tool 消息前无 tool_calls」400）。
 * v3：并行 toolCall 合并（Qoder 把一轮并行调用写成连续单 call assistant 条目，
 * 逐条写出同样产生孤儿 toolResult）。
 */
export const CLAUDE_IMPORT_CONVERTER_VERSION = 3;

/**
 * Claude Code（~/.claude/projects）会话导入器。
 *
 * 同时作为「Claude 同构 transcript」家族的基类：Qoder 等工具的 JSONL 与本类的
 * 解析/转换管线逐字段兼容（user/assistant 行 + text/thinking/tool_use/tool_result 块，
 * 顶层带 cwd/sessionId），子类只需覆盖 sourceRoot/sourceKey 等保护字段与目录扫描方式。
 */
export class ClaudeSessionImporter {
	/** 源会话库根目录；子类导入器（如 Qoder）改指向自己的工具目录。 */
	protected sourceRoot = join(app.getPath("home"), ".claude", "projects");
	/** 来源标识：决定产物文件名 `<key>_<id>.jsonl`、导入标记行 `<key>_import` 与 api 标签。 */
	protected sourceKey = "claude";
	/** 来源展示名（标题/预览兜底文案与扫描错误信息用）。 */
	protected sourceLabel = "Claude";
	/** 源 transcript 不带可辨识模型时的占位标签（model_change 行 / assistant provider）。 */
	protected defaultProvider = "anthropic";
	protected defaultModelId = "claude-sonnet-4";
	private readonly piRoot = join(app.getPath("home"), ".pi", "agent", "sessions");

	constructor(private readonly translate: SessionImportCopy = defaultSessionImportCopy) {}

	/**
	 * 扫描可导入会话（列表摘要）。
	 *
	 * **只读头部**（见 sessionSourceHead）：源 transcript 常达几十 MB~GB，整读会让主进程
	 * 384MB 堆 abort（应用闪退，无堆栈）；并发整读更是乘数灾难（12×60MB 即可复现）。
	 * 摘要所需元数据（sessionId / cwd）都在文件前部；头部找不到元数据的文件不进列表，
	 * 真实导入仍走全量流式，不会少消息。
	 */
	async scan(projectPath: string): Promise<ClaudeSessionSummary[]> {
		const projectDir = this.getClaudeProjectDir(projectPath);
		const files = await this.collectJsonl(projectDir).catch(() => []);
		// 有界并发：内存峰值 = 并发数 × 头部缓冲（见 SESSION_SCAN_CONCURRENCY）
		const sessions = await mapWithConcurrency(files, SESSION_SCAN_CONCURRENCY, (file) => this.readClaudeSessionHead(file).catch(() => null));

		const summaries = await Promise.all(
			sessions
				.filter((session): session is ParsedClaudeSession => Boolean(session))
				// 逐会话兑底：单条畸形数据（null content 元素/非字符串 sessionId/极端时间戳等）
				// 只降级自己那条，不再炸整张列表（旧实现一条 reject → 整个 scan 裸错误过 IPC）
				.map((session) => this.toSummary(session, projectPath).catch(() => null)),
		);

		return summaries.filter((s): s is ClaudeSessionSummary => Boolean(s)).sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async import(projectPath: string, sourcePaths: string[]): Promise<ClaudeImportReport> {
		const results: ClaudeImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(await this.importOne(projectPath, sourcePath));
		}
		return {
			results,
			imported: results.filter((result) => result.success).length,
			failed: results.filter((result) => !result.success).length,
		};
	}

	private async importOne(projectPath: string, sourcePath: string): Promise<ClaudeImportResult> {
		const tempPath = `${join(this.getProjectSessionDir(projectPath), `${randomUUID().slice(0, 8)}.importing`)}`;
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		try {
			const parsed = await this.readClaudeSessionHead(sourcePath);
			const targetPath = this.getTargetPath(projectPath, parsed);
			const existing = await this.readImportMeta(targetPath);
			await mkdir(this.getProjectSessionDir(projectPath), { recursive: true });

			// 第一遍流式扫描重建活链（只留存 uuid→parent，内存 O(行数)，不 materialize 记录）
			const chainIds = await this.collectLiveChainIds(readJsonlObjects(sourcePath));

			// 先写临时文件再原子改名：中途失败不会留下半截会话文件污染列表
			handle = await open(tempPath, "w");
			const buffered = createBufferedLineSink(handle);

			const converted = await this.convertToPiSessionTo(projectPath, parsed, readJsonlObjects(sourcePath), buffered.sink, chainIds);
			await buffered.flush();
			await handle.close();
			handle = undefined;
			await renameWithRetry(tempPath, targetPath);

			// 侧栏列表时间取文件 mtime：写入后回调为会话真实最后时间，避免导入会话
			// 全部显示为「刚刚导入」并排序置顶（与 ZCode/OpenCode 导入器同口径）。
			if (parsed.meta.lastTimestamp > 0) {
				const stamp = new Date(parsed.meta.lastTimestamp);
				await utimes(targetPath, stamp, stamp);
			}

			return {
				id: parsed.meta.sessionId,
				sourcePath,
				targetPath,
				title: converted.title,
				success: true,
				overwritten: Boolean(existing),
				messageCount: converted.messageCount,
			};
		} catch (error) {
			await handle?.close().catch(() => undefined);
			// 半截临时文件不可用：清掉再上报，避免残留
			await rm(tempPath, { force: true }).catch(() => undefined);
			return {
				id: sourcePath,
				sourcePath,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async toSummary(session: ParsedClaudeSession, projectPath: string): Promise<ClaudeSessionSummary> {
		const targetPath = this.getTargetPath(projectPath, session);
		const importMeta = await this.readImportMeta(targetPath);
		// 扫描路径：entries 只是头部小数组，直接内存转换（体积有上界）
		const converted = await this.convertToPiSession(projectPath, session);
		// 转换器版本不一致也按 outdated：旧转换产物可能含孤儿 toolResult（400 根因），引导重导
		const status: ClaudeImportStatus = !importMeta ? "new" : importMeta.version !== CLAUDE_IMPORT_CONVERTER_VERSION || importMeta.sourceMtime !== session.sourceMtime || importMeta.sourceSize !== session.sourceSize ? "outdated" : "current";

		return {
			id: session.meta.sessionId,
			sourcePath: session.sourcePath,
			targetPath,
			cwd: session.meta.cwd,
			title: converted.title,
			preview: converted.preview,
			createdAt: session.meta.firstTimestamp,
			updatedAt: session.meta.lastTimestamp,
			messageCount: converted.messageCount,
			status,
			sourceSize: session.sourceSize,
			importedSourceMtime: importMeta?.sourceMtime,
		};
	}

	/**
	 * 把源记录折叠为 pi 会话行，输出交给 `sink`。
	 *
	 * `entries` 是**可迭代的源记录序列**而不是数组：
	 * - 导入（importOne）传逐行流式读取的迭代器 → 内存 O(单行)，巨型会话可导入；
	 * - 扫描（toSummary）传头部已解析的小数组 → 体积有上界。
	 * 两路共用同一份转换逻辑，避免像 Codex 那样维护两份实现而漂移（改一处漏一处）。
	 *
	 * `chainIds`：活链 uuid 集合（见 collectLiveChainIds，仅导入路径传入）；
	 * 扫描路径的头部数组不知道文件尾是谁，传 null 不做过滤。
	 */
	private async convertToPiSessionTo(projectPath: string, session: ParsedClaudeSession, entries: Iterable<Record<string, any>> | AsyncIterable<Record<string, any>>, sink: (line: string) => Promise<void> | void, chainIds: Set<string> | null = null): Promise<{ title: string; preview: string; messageCount: number }> {
		const sessionId = session.meta.sessionId;
		const timestamp = new Date(session.meta.firstTimestamp).toISOString();
		const titleState = { title: "", preview: "" };
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;
		// 当前挂起的 toolCall id 集（配对跟踪，见 pushMessage）
		const pendingToolCalls = new Set<string>();

		const pushEntry = async (entry: Record<string, unknown>) => {
			await sink(JSON.stringify(entry));
		};

		const emitMessage = async (role: "user" | "assistant" | "toolResult", content: unknown[], extra: Record<string, unknown> = {}, timestampValue?: string) => {
			if (content.length === 0) return;
			const id = this.makeId(sessionId, sequence++);
			const ts = timestampValue || new Date().toISOString();
			await pushEntry({
				type: "message",
				id,
				parentId,
				timestamp: ts,
				message: {
					role,
					content,
					timestamp: new Date(ts).getTime(),
					...(role === "assistant" ? { usage: this.zeroUsage() } : {}),
					...extra,
				},
			});
			parentId = id;
			messageCount += 1;

			const text = this.extractPiText(content).trim();
			if (text && !titleState.preview) titleState.preview = text.slice(0, 160);
			if (role === "user" && text && !titleState.title) {
				titleState.title = this.cleanTitle(text);
			}
		};

		// assistant 运行合并缓冲：Claude Code 把同一轮响应拆成多个连续 assistant 条目
		// （Qoder 并行调用的 call_00_/call_01_ 拆分、长文本/思考分片、call 与结果之间的
		// 穿插评论）。只要 user/toolResult 不出现就仍属同一轮——并为一条 assistant 写出
		// （OpenAI 多 tool_calls 语义），否则 pi transformMessages 在每个新 assistant 边界
		// 重置挂起集，靠前 call 的 toolResult 变孤儿（严格供应商 400）。
		// 任何非 assistant 消息到来或转换结束时先冲刷；运行期间 toolCall id 持续累积进 pendingToolCalls。
		let mergeBuffer: { content: unknown[]; extra: Record<string, unknown>; timestampValue?: string } | null = null;
		const flushMergeBuffer = async () => {
			if (!mergeBuffer) return;
			const buffered = mergeBuffer;
			mergeBuffer = null;
			await emitMessage("assistant", buffered.content, buffered.extra, buffered.timestampValue);
		};

		const pushMessage = async (role: "user" | "assistant" | "toolResult", content: unknown[], extra: Record<string, unknown> = {}, timestampValue?: string) => {
			if (content.length === 0) return;
			if (role === "assistant") {
				if (mergeBuffer) mergeBuffer.content.push(...content);
				else {
					// 新运行开启 = pi 语义的新 assistant 边界：关闭上一段挂起集
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
			// 与 pi transformMessages 同口径的 tool 配对跟踪：任一 user 消息出现即关闭挂起
			// （pi 请求时会为未应答的 toolCall 补占位结果，不会 400）。挂起集之外的 toolResult
			// 在 OpenAI completions 请求里是「前面没有 tool_calls 的 tool 消息」→ 严格供应商
			// 400，降级为用户文本保留内容。
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

		// 写入会话头
		await pushEntry({
			type: "session",
			version: 3,
			id: sessionId,
			timestamp,
			cwd: projectPath,
		});

		await pushEntry({
			type: `${this.sourceKey}_import`,
			version: CLAUDE_IMPORT_CONVERTER_VERSION,
			sourceSessionId: sessionId,
			sourcePath: session.sourcePath,
			sourceMtime: session.sourceMtime,
			sourceSize: session.sourceSize,
			importedAt: new Date().toISOString(),
		});

		// 源未声明模型时回退占位标签（Qoder 等子类可覆盖）
		const modelChangeId = this.makeId(sessionId, sequence++);
		await pushEntry({
			type: "model_change",
			id: modelChangeId,
			parentId,
			timestamp,
			provider: this.defaultProvider,
			modelId: this.defaultModelId,
		});
		parentId = modelChangeId;

		// 转换消息
		for await (const entry of entries) {
			// 只转换活链上的记录（见 collectLiveChainIds）；无 uuid 的记录不属于任何分支，保留
			if (chainIds) {
				const uuid = entry.uuid;
				if (typeof uuid === "string" && uuid && !chainIds.has(uuid)) continue;
			}
			// 跳过非消息类型
			if (entry.type === "file-history-snapshot") continue;
			if (entry.type === "system" && entry.subtype === "turn_duration") continue;
			if (entry.type === "system" && entry.subtype === "api_error") continue;

			if (entry.type === "user") {
				await this.pushClaudeUserEntry(entry, pushMessage);
				continue;
			}

			if (entry.type === "assistant") {
				const message = entry.message;
				if (!message) continue;

				const content: Array<Record<string, unknown>> = [];

				if (typeof message.content === "string") {
					if (message.content.trim()) content.push({ type: "text", text: message.content });
				} else if (Array.isArray(message.content)) {
					for (const item of message.content) {
						// null/非对象元素是合法 JSON（畸形导出产物）：跳过而非 TypeError（2026-03 导入器审计）
						if (!item || typeof item !== "object") continue;
						if (item.type === "text") {
							content.push({ type: "text", text: item.text });
						} else if (item.type === "thinking") {
							content.push({
								type: "thinking",
								thinking: item.thinking,
								thinkingSignature: "claude_thinking",
							});
						} else if (item.type === "tool_use") {
							content.push({
								type: "toolCall",
								id: item.id,
								name: item.name,
								arguments: normalizeImportedToolArguments(item.input),
							});
						} else {
							const image = tryImportedImageBlock(item);
							content.push(image ?? importedUnknownBlockAsText(item));
						}
					}
				}

				if (content.length > 0) {
					await pushMessage(
						"assistant",
						content,
						{
							api: `${this.sourceKey}-import`,
							provider: this.defaultProvider,
							model: message.model || this.defaultModelId,
							stopReason: normalizeImportedStopReason({
								raw: message.stop_reason,
								hasToolCall: importedContentHasToolCall(content),
							}),
						},
						entry.timestamp,
					);
				}
				continue;
			}

			// 兼容少数顶层 type=tool_result 的导出；主流 Claude Code 写在 user.content 里。
			if (entry.type === "tool_result") {
				await this.pushClaudeToolResult(entry, entry, pushMessage);
			}
		}

		// 尾部冲刷：文件以并行调用结尾时缓冲里的 toolCall 不能丢
		await flushMergeBuffer();

		const title = titleState.title || this.cleanTitle(basename(session.sourcePath)) || this.translate("session.importedTitle", { source: this.sourceLabel });
		// 使用 pi 原生 session_info 格式追加在末尾，避免旧版 sessionName 行（无 type 字段）
		// 在文件头破坏 pi 的首行校验导致会话无法加载（见 #114）。
		await pushEntry({
			type: "session_info",
			id: randomUUID().slice(0, 8),
			parentId,
			timestamp: new Date().toISOString(),
			name: title,
			cwd: projectPath,
		});

		return {
			title,
			preview: titleState.preview || this.translate("session.importedPreview", { source: this.sourceLabel }),
			messageCount,
		};
	}

	/** 内存版转换（仅供**扫描**：entries 是头部小数组，体积有上界）。导入请走 convertToPiSessionTo。 */
	private async convertToPiSession(projectPath: string, session: ParsedClaudeSession) {
		const lines: string[] = [];
		const result = await this.convertToPiSessionTo(projectPath, session, session.entries, (line) => {
			lines.push(line);
		});
		return { ...result, raw: `${lines.join("\n")}\n` };
	}

	/**
	 * 重建「活链」uuid 集合：源 transcript 是 uuid/parentUuid **树**——rewind、
	 * 中断后续聊都从旧节点分叉，废弃分支仍按时间混在文件里。线性转换会把废弃
	 * 分支插进 tool_use ↔ tool_result 之间，产物必然含孤儿 toolResult（严格供应商 400）。
	 *
	 * 以文件中**最后一条**带 uuid 的非 sidechain 记录为活链尖端，沿 parentUuid 回溯到根；
	 * sidechain（Task 子代理）记录是支线转录，绝不作为尖端——否则文件恰好以子代理
	 * 记录结尾时主链会被整体丢弃。整份文件都是 sidechain 时（独立的 subagents/*.jsonl
	 * 也会作为会话导入）退化为以最后一条记录为尖端。无 uuid 信息时返回 null
	 * （兼容无 uuid 的第三方同构文件）。
	 */
	private async collectLiveChainIds(entries: AsyncIterable<Record<string, any>>): Promise<Set<string> | null> {
		const parentById = new Map<string, string | null>();
		let tipId: string | null = null;
		let anyTipId: string | null = null;
		for await (const entry of entries) {
			const uuid = typeof entry.uuid === "string" && entry.uuid ? entry.uuid : null;
			if (!uuid) continue;
			parentById.set(uuid, typeof entry.parentUuid === "string" && entry.parentUuid ? entry.parentUuid : null);
			if (entry.isSidechain) {
				anyTipId = uuid;
			} else {
				tipId = uuid;
			}
		}
		const effectiveTip = tipId ?? anyTipId;
		if (!effectiveTip) return null;
		const chain = new Set<string>();
		let cursor: string | null = effectiveTip;
		// has(cursor) 防环：损坏文件的循环引用不会死循环，已收集的部分链仍是有效活链
		while (cursor && !chain.has(cursor)) {
			chain.add(cursor);
			cursor = parentById.get(cursor) ?? null;
		}
		return chain;
	}

	/**
	 * Claude Code 的 user 行可能是纯文本，也可能是 content[]：
	 * tool_result 块（喂回模型的工具输出）必须写成 pi toolResult，不能 String(数组) 变成用户气泡。
	 */
	private async pushClaudeUserEntry(entry: Record<string, any>, pushMessage: ClaudePushMessage) {
		const raw = entry.message?.content;
		if (typeof raw === "string") {
			const text = raw.trim();
			if (text) await pushMessage("user", [{ type: "text", text }], {}, entry.timestamp);
			return;
		}
		if (!Array.isArray(raw)) return;
		const userContent: Array<Record<string, unknown>> = [];
		const toolResults: Array<Record<string, unknown>> = [];
		for (const item of raw) {
			if (typeof item === "string") {
				if (item.trim()) userContent.push({ type: "text", text: item });
				continue;
			}
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			if (record.type === "tool_result") {
				toolResults.push(record);
				continue;
			}
			if (record.type === "text") {
				const text = String(record.text ?? "");
				if (text) userContent.push({ type: "text", text });
				continue;
			}
			const image = tryImportedImageBlock(record);
			userContent.push(image ?? importedUnknownBlockAsText(record));
		}
		// tool_result 必须先于本 entry 的文本写出：OpenAI completions 里 tool 消息只能
		// 紧跟带 tool_calls 的 assistant，user 文本插在前面会把结果挤成孤儿（严格供应商 400）。
		for (const record of toolResults) {
			await this.pushClaudeToolResult(record, entry, pushMessage);
		}
		if (userContent.length > 0) {
			await pushMessage("user", userContent, {}, entry.timestamp);
		}
	}

	private async pushClaudeToolResult(payload: Record<string, any>, entry: Record<string, any>, pushMessage: ClaudePushMessage) {
		await pushMessage(
			"toolResult",
			[{ type: "text", text: this.extractToolOutput(payload) }],
			{
				toolCallId: String(payload.tool_use_id ?? payload.toolCallId ?? ""),
				toolName: String(payload.name ?? "tool"),
				isError: Boolean(payload.is_error ?? payload.isError),
			},
			entry.timestamp,
		);
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

	/**
	 * 只读头部解析 Claude 会话元数据（scan 用）。
	 *
	 * 与 readClaudeSessionHead 的关键差异：不把整文件读成字符串，内存与文件体积解耦。
	 * entries 只含**头部区间**的记录，所以 title/preview/messageCount 是该区间的近似值
	 * （与 Codex 导入器的 head-only 扫描同口径：摘要允许近似，真实导入仍跑全量流式）。
	 *
	 * 时间：firstTimestamp 取头部最早（会话开头就在头部，准确）；
	 * lastTimestamp 用源文件 mtime——头部看不到文件尾，mtime 比头部最大值更接近真实末次活动。
	 */
	private async readClaudeSessionHead(filePath: string): Promise<ParsedClaudeSession> {
		this.assertClaudeSourcePath(filePath);
		const { head, size, mtimeMs, truncated } = await readSessionSourceHead(filePath);

		const entries: Array<Record<string, any>> = [];
		let firstUserEntry: Record<string, any> | undefined;
		let firstTimestamp = 0;
		let lastTimestamp = 0;
		// 头部可能切在多字节字符/行中间：坏行跳过（与既有 head-only 解析同策略）
		for (const line of head.split(/\r?\n/)) {
			if (!line.trim()) continue;
			let entry: Record<string, any>;
			try {
				entry = JSON.parse(line) as Record<string, any>;
			} catch {
				continue;
			}
			entries.push(entry);
			if (!firstUserEntry && entry.type === "user" && entry.sessionId && entry.cwd) {
				firstUserEntry = entry;
			}
			const ts = entry.timestamp ? new Date(entry.timestamp).getTime() : NaN;
			if (Number.isFinite(ts)) {
				if (firstTimestamp === 0 || ts < firstTimestamp) firstTimestamp = ts;
				if (ts > lastTimestamp) lastTimestamp = ts;
			}
		}

		// 非字符串 sessionId/cwd 是畸形源（数字 id 能过 truthy 检查但下游 .replace/join 炸 TypeError）
		if (typeof firstUserEntry?.sessionId !== "string" || !firstUserEntry.sessionId || typeof firstUserEntry.cwd !== "string" || !firstUserEntry.cwd) {
			throw new Error(`Missing ${this.sourceLabel} session metadata`);
		}

		return {
			meta: {
				sessionId: firstUserEntry.sessionId,
				cwd: firstUserEntry.cwd,
				firstTimestamp: firstTimestamp || mtimeMs,
				// 未截断（头部即全文件）时用真实末次时间戳，列表排序靠它；
				// 截断时头部看不到文件尾，退化用 mtime。
				lastTimestamp: truncated ? mtimeMs : lastTimestamp || mtimeMs,
			},
			entries,
			sourcePath: filePath,
			sourceSize: size,
			sourceMtime: mtimeMs,
		};
	}

	private assertClaudeSourcePath(filePath: string) {
		// 语义校验（resolve 后比较）：词法 startsWith 不解析 `..`，曾可被
		// `<root>/../../任意文件` 绕过（2026-03 导入器安全审计）
		assertSourceWithinRoot(this.sourceRoot, filePath, this.sourceLabel);
	}

	/** 读取导入产物头部的 import 标记（有界读头部，不再整读会话文件——见 importMetaHead）。 */
	private async readImportMeta(targetPath: string) {
		return readImportMetaHead(targetPath, `${this.sourceKey}_import`);
	}

	protected async collectJsonl(dir: string): Promise<string[]> {
		try {
			const entries = await readdir(dir, { withFileTypes: true });
			const files: string[] = [];
			for (const entry of entries) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) {
					files.push(...(await this.collectJsonl(path)));
				} else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
					files.push(path);
				}
			}
			return files;
		} catch {
			return [];
		}
	}

	private getClaudeProjectDir(projectPath: string): string {
		// 将项目路径转换为 Claude 的目录名格式（Qoder 等衍生工具沿用同一 slug 约定）
		// 例如：C:\Users\14012\pi-desktop -> C--Users-14012-pi-desktop
		const normalized = projectPath.replace(/\\/g, "/");
		const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
		if (win) {
			const dirName = `${win[1]}--${win[2].replace(/\//g, "-")}`;
			return join(this.sourceRoot, dirName);
		}
		const dirName = normalized.replace(/^\//, "").replace(/\//g, "-");
		return join(this.sourceRoot, dirName);
	}

	private getTargetPath(projectPath: string, session: ParsedClaudeSession) {
		const id = session.meta.sessionId.replace(/[^a-zA-Z0-9_-]/g, "-");
		return join(this.getProjectSessionDir(projectPath), `${this.sourceKey}_${id}.jsonl`);
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

	private extractToolOutput(payload: Record<string, any>) {
		const output = payload.content ?? payload.output;
		if (typeof output === "string") return output;
		if (Array.isArray(output)) {
			return output
				.map((item) => {
					if (typeof item === "string") return item;
					return String(item?.text ?? item?.content ?? "");
				})
				.filter(Boolean)
				.join("\n");
		}
		try {
			return JSON.stringify(output ?? "", null, 2);
		} catch {
			return String(output ?? "");
		}
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

	private normalize(path?: string) {
		return String(path ?? "")
			.replace(/\\/g, "/")
			.replace(/\/+$/, "")
			.toLowerCase();
	}
}
