import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rm, stat, utimes } from "node:fs/promises";
import { basename, join } from "node:path";
import type { ClaudeImportReport, ClaudeImportResult, ClaudeImportStatus, ClaudeSessionSummary } from "../../shared/types";
import { defaultSessionImportCopy, type SessionImportCopy } from "./SessionImportCopy";
import { normalizeImportedToolArguments } from "./importToolArguments";
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

		const summaries = await Promise.all(sessions.filter((session): session is ParsedClaudeSession => Boolean(session)).map((session) => this.toSummary(session, projectPath)));

		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
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

			// 先写临时文件再原子改名：中途失败不会留下半截会话文件污染列表
			handle = await open(tempPath, "w");
			const buffered = createBufferedLineSink(handle);

			const converted = await this.convertToPiSessionTo(projectPath, parsed, readJsonlObjects(sourcePath), buffered.sink);
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
		const status: ClaudeImportStatus = !importMeta ? "new" : importMeta.sourceMtime === session.sourceMtime && importMeta.sourceSize === session.sourceSize ? "current" : "outdated";

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
	 */
	private async convertToPiSessionTo(projectPath: string, session: ParsedClaudeSession, entries: Iterable<Record<string, any>> | AsyncIterable<Record<string, any>>, sink: (line: string) => Promise<void> | void): Promise<{ title: string; preview: string; messageCount: number }> {
		const sessionId = session.meta.sessionId;
		const timestamp = new Date(session.meta.firstTimestamp).toISOString();
		const titleState = { title: "", preview: "" };
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;

		const pushEntry = async (entry: Record<string, unknown>) => {
			await sink(JSON.stringify(entry));
		};

		const pushMessage = async (role: "user" | "assistant" | "toolResult", content: unknown[], extra: Record<string, unknown> = {}, timestampValue?: string) => {
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
			version: 1,
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
		const flushUser = async () => {
			if (userContent.length === 0) return;
			await pushMessage("user", userContent.splice(0), {}, entry.timestamp);
		};
		for (const item of raw) {
			if (typeof item === "string") {
				if (item.trim()) userContent.push({ type: "text", text: item });
				continue;
			}
			if (!item || typeof item !== "object") continue;
			const record = item as Record<string, unknown>;
			if (record.type === "tool_result") {
				await flushUser();
				await this.pushClaudeToolResult(record, entry, pushMessage);
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
		await flushUser();
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

		if (!firstUserEntry?.sessionId || !firstUserEntry?.cwd) {
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
		const root = this.normalize(this.sourceRoot);
		const target = this.normalize(filePath);
		if (target !== root && !target.startsWith(`${root}/`)) {
			throw new Error(`${this.sourceLabel} session path is outside the import root`);
		}
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
		const win = normalized.match(/^([A-Za-z]):\/(.+)$/);
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
			.map((item: any) => item?.text ?? item?.thinking ?? item?.name ?? "")
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
