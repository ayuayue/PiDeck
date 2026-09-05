import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	ZCodeImportReport,
	ZCodeImportResult,
	ZCodeImportStatus,
	ZCodeSessionSummary,
} from "../../shared/types";
import {
	defaultSessionImportCopy,
	type SessionImportCopy,
} from "./SessionImportCopy";

/**
 * zcode（Z.ai CLI）会话导入器。
 *
 * 数据源：~/.zcode/cli/db/db.sqlite（集中式 SQLite，session/message/part 三表）。
 * 与 OpenCode 一样只读访问，导入时仅生成 pi 可读的 JSONL 副本，绝不修改原始数据库。
 *
 * 结构差异（相对 pi 会话）：
 * - part 同时承载文本/推理/工具调用/工具输出（tool 的 input+output 在同一 part），
 *   转换时拆成 assistant 的 toolCall + 独立的 toolResult 消息；
 * - file part 是图片附件（url 形如 zcode-artifact://sess_<id>/tool-result-<uuid>），
 *   原始数据以 `data:<mime>;base64,` 形式存放在 ~/.zcode/cli/artifacts/sess_<id>/ 下，
 *   能解析出 data URL 时还原为 pi 的 image content，否则降级为文本占位；
 * - timeline / step-start / step-finish 是过程噪声，跳过不转换。
 */
export class ZCodeSessionImporter {
	private readonly zcodeDb = join(app.getPath("home"), ".zcode", "cli", "db", "db.sqlite");
	private readonly zcodeArtifactsRoot = join(app.getPath("home"), ".zcode", "cli", "artifacts");
	private readonly piRoot = join(app.getPath("home"), ".pi", "agent", "sessions");

	constructor(private readonly translate: SessionImportCopy = defaultSessionImportCopy) {}

	async scan(projectPath: string): Promise<ZCodeSessionSummary[]> {
		if (!existsSync(this.zcodeDb)) return [];
		const sessions = await this.readZCodeSessions(projectPath);
		const summaries = await Promise.all(
			sessions.map((session) => this.toSummary(session, projectPath)),
		);
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async import(projectPath: string, sourcePaths: string[]): Promise<ZCodeImportReport> {
		const sessions = await this.readZCodeSessions(projectPath);
		const bySourcePath = new Map(sessions.map((session) => [session.sourcePath, session]));
		const results: ZCodeImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(
				await this.importOne(projectPath, sourcePath, bySourcePath.get(sourcePath)),
			);
		}
		return {
			results,
			imported: results.filter((result) => result.success).length,
			failed: results.filter((result) => !result.success).length,
		};
	}

	private async importOne(
		projectPath: string,
		sourcePath: string,
		parsed?: ParsedZCodeSession,
	): Promise<ZCodeImportResult> {
		try {
			if (!parsed) throw new Error("ZCode session not found in database");
			const targetPath = this.getTargetPath(projectPath, parsed);
			const existing = await this.readImportMeta(targetPath);
			const converted = await this.convertToPiSession(projectPath, parsed);
			await mkdir(this.getProjectSessionDir(projectPath), { recursive: true });
			await writeFile(targetPath, converted.raw, "utf8");
			return {
				id: String(parsed.meta.id),
				sourcePath,
				targetPath,
				title: converted.title,
				success: true,
				overwritten: Boolean(existing),
				messageCount: converted.messageCount,
			};
		} catch (error) {
			return {
				id: sourcePath,
				sourcePath,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async toSummary(
		session: ParsedZCodeSession,
		projectPath: string,
	): Promise<ZCodeSessionSummary> {
		const targetPath = this.getTargetPath(projectPath, session);
		const importMeta = await this.readImportMeta(targetPath);
		const converted = await this.convertToPiSession(projectPath, session);
		// 状态判定与 Claude/OpenCode 一致：以导入标记中记录的源 mtime/size 对比当前源文件，
		// 源未变化视为已导入（current），源更新过则提示可覆盖（outdated）。
		const status: ZCodeImportStatus = !importMeta
			? "new"
			: importMeta.sourceMtime === session.sourceMtime &&
			  importMeta.sourceSize === session.sourceSize
				? "current"
				: "outdated";

		return {
			id: String(session.meta.id),
			sourcePath: session.sourcePath,
			targetPath,
			cwd: String(session.meta.directory ?? projectPath),
			title: converted.title,
			preview: converted.preview,
			createdAt: Number(session.meta.time_created ?? session.sourceMtime),
			updatedAt: Number(session.meta.time_updated ?? session.sourceMtime),
			messageCount: converted.messageCount,
			status,
			sourceSize: session.sourceSize,
			importedSourceMtime: importMeta?.sourceMtime,
		};
	}

	private async convertToPiSession(projectPath: string, session: ParsedZCodeSession) {
		const sessionId = String(session.meta.id);
		const timestamp = new Date(
			Number(session.meta.time_created ?? session.sourceMtime),
		).toISOString();
		const titleState = { title: "", preview: "" };
		const lines: string[] = [];
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;

		const pushEntry = (entry: Record<string, unknown>) => lines.push(JSON.stringify(entry));
		const pushMessage = (
			role: "user" | "assistant" | "toolResult",
			content: unknown[],
			extra: Record<string, unknown> = {},
			timestampValue?: number,
		) => {
			if (content.length === 0) return;
			const id = this.makeId(sessionId, sequence++);
			const messageTimestamp = Number(timestampValue ?? session.sourceMtime + sequence);
			pushEntry({
				type: "message",
				id,
				parentId,
				timestamp: new Date(messageTimestamp).toISOString(),
				message: {
					role,
					content,
					timestamp: messageTimestamp,
					...(role === "assistant" ? { usage: this.toUsage(extra.tokens) } : {}),
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

		// 会话头：固定 version 3 + cwd（与其它导入器一致，保证 pi 首行校验可过）
		pushEntry({ type: "session", version: 3, id: sessionId, timestamp, cwd: projectPath });
		pushEntry({
			type: "zcode_import",
			version: 1,
			zcodeSessionId: sessionId,
			sourcePath: session.sourcePath,
			sourceMtime: session.sourceMtime,
			sourceSize: session.sourceSize,
			importedAt: new Date().toISOString(),
		});

		const model = this.firstModel(session.messages);
		const modelChangeId = this.makeId(sessionId, sequence++);
		pushEntry({
			type: "model_change",
			id: modelChangeId,
			parentId,
			timestamp,
			provider: model.providerID || "zcode",
			modelId: model.modelID || "zcode",
		});
		parentId = modelChangeId;

		for (const message of session.messages) {
			const messageData = message.data;
			const role = messageData.role;
			const content: unknown[] = [];

			// 工具结果按调用顺序在 assistant 消息处理完后统一补发（见下方 toolQueue）。
			const toolQueue: Array<{ part: ZCodePart; callId: string; name: string }> = [];

			for (const part of message.parts) {
				const partData = part.data;
				if (partData.type === "text" && partData.text) {
					content.push({ type: "text", text: String(partData.text) });
				} else if (partData.type === "reasoning" && partData.text) {
					content.push({
						type: "thinking",
						thinking: String(partData.text),
						thinkingSignature: "zcode_reasoning",
					});
				} else if (partData.type === "tool") {
					const callId = String(partData.callID ?? part.id);
					const name = String(partData.tool ?? "tool");
					// 工具调用（assistant 侧）进入消息 content；输出留给 toolResult。
					const input = (partData.state as Record<string, unknown> | undefined)?.input ?? {};
					content.push({
						type: "toolCall",
						id: callId,
						name,
						arguments: input,
					});
					toolQueue.push({ part, callId, name });
				} else if (partData.type === "file") {
					// 图片附件：尝试从 artifacts 目录还原为 image content（只读，不改源）。
					const image = await this.resolveFilePart(partData, String(session.meta.id));
					if (image) content.push(image);
					else {
						content.push({
							type: "text",
							text: `[zcode attachment: ${String(partData.url ?? "")}]`,
						});
					}
				}
				// timeline / step-start / step-finish 为过程噪声，跳过。
			}

			if (role === "user") {
				pushMessage("user", content, {}, message.time_created);
			} else if (role === "assistant") {
				// semantics.origin === "system" 的消息（model_change 等 timeline 事件）
				// 没有实际对话内容，跳过，避免导入后出现空 assistant 气泡。
				const semantics = messageData.semantics as Record<string, unknown> | undefined;
				if (semantics?.origin === "system") continue;
				pushMessage(
					"assistant",
					content,
					{
						api: "zcode-import",
						provider: messageData.providerID ?? model.providerID ?? "zcode",
						model: messageData.modelID ?? model.modelID ?? "zcode",
						stopReason: messageData.finish ?? "stop",
						tokens: messageData.tokens,
					},
					message.time_created,
				);
			}

			// 工具输出：每个 tool part 生成一条 toolResult 消息，紧跟在所属 assistant 消息后，
			// 保证 toolCall 与 toolResult 的顺序可被渲染层正确配对。
			for (const { part, callId, name } of toolQueue) {
				const state = (part.data.state ?? {}) as Record<string, unknown>;
				const time = part.data.time as Record<string, unknown> | undefined;
				pushMessage(
					"toolResult",
					[{ type: "text", text: this.extractToolOutput(state) }],
					{
						toolCallId: callId,
						toolName: name,
						isError: state.status === "error",
					},
					Number(time?.end ?? part.time_created),
				);
			}
		}

		const title =
			this.cleanTitle(String(session.meta.title ?? "")) ||
			titleState.title ||
			this.cleanTitle(basename(session.sourcePath)) ||
			this.translate("session.importedTitle", { source: "ZCode" });
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
			preview:
				titleState.preview || this.translate("session.importedPreview", { source: "ZCode" }),
			messageCount,
		};
	}

	/** 解析 zcode file part 为 pi image content；解析失败返回 undefined 由调用方降级。 */
	private async resolveFilePart(
		partData: Record<string, unknown>,
		sessionId: string,
	): Promise<{ type: "image"; data: string; mimeType?: string } | undefined> {
		const url = String(partData.url ?? "");
		// url 形如 zcode-artifact://sess_<id>/tool-result-<uuid>，取尾部 uuid 定位文件。
		const match = url.match(/tool-result-([0-9a-f-]+)$/i);
		if (!match) return undefined;
		const uuid = match[1];
		// 注意：zcode 的 sessionId 本身已带 `sess_` 前缀（如 sess_1ae8ad12-...），
		// artifacts 目录名与之一致，直接拼接即可，不能再加一次前缀。
		const dir = join(this.zcodeArtifactsRoot, sessionId);
		try {
			const files = await readdir(dir);
			const target = files.find((name) => name.endsWith(`tool-result-${uuid}.txt`));
			if (!target) return undefined;
			const raw = await readFile(join(dir, target), "utf8");
			// 附件以 `data:<mime>;base64,<payload>` 形式存储；其余内容无法还原为图片。
			const dataUrl = raw.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=]+)\s*$/);
			if (!dataUrl) return undefined;
			return { type: "image", data: dataUrl[2], mimeType: dataUrl[1] };
		} catch {
			return undefined;
		}
	}

	private async readZCodeSessions(projectPath: string): Promise<ParsedZCodeSession[]> {
		const info = await stat(this.zcodeDb);
		const normalizedProject = this.normalize(projectPath);
		const db = new DatabaseSync(this.zcodeDb, { readOnly: true });
		try {
			// directory 是会话工作目录（可能等于项目根，也可能是项目下的子目录），
			// 规范化后按「相等或位于项目路径之下」匹配，避免漏掉子目录会话。
			const sessions = db
				.prepare(
					`select * from session
					 where lower(replace(directory, '\\', '/')) = lower(?)
					    or lower(replace(directory, '\\', '/')) like lower(? || '/%')
					 order by time_updated desc`,
				)
				.all(normalizedProject, normalizedProject) as Array<Record<string, unknown>>;

			// zcode 子代理会话 id 固定以 sess_subagent_ 开头（父任务的分支），
			// 与 Codex 导入器同样不导入，避免与父会话内容重复、列表混乱。
			return sessions
				.filter((session) => !String(session.id).startsWith("sess_subagent_"))
				.map((session) => {
				const messages = db
					.prepare(
						`select id, sequence, time_created, time_updated, data
						 from message where session_id = ? order by coalesce(sequence, time_created), time_created`,
					)
					.all(String(session.id)) as Array<Record<string, unknown>>;
				const parts = db
					.prepare(
						`select id, message_id, session_id, sequence, time_created, time_updated, data
						 from part where session_id = ? order by coalesce(sequence, time_created), time_created`,
					)
					.all(String(session.id)) as Array<Record<string, unknown>>;
				const partsByMessage = new Map<string, ZCodePart[]>();
				for (const part of parts) {
					const parsedPart = { ...part, data: this.parseJson(part.data) } as ZCodePart;
					const current = partsByMessage.get(String(parsedPart.message_id)) ?? [];
					current.push(parsedPart);
					partsByMessage.set(String(parsedPart.message_id), current);
				}
				const parsedMessages = messages.map((message) => ({
					id: String(message.id),
					time_created: Number(message.time_created),
					time_updated: Number(message.time_updated),
					data: this.parseJson(message.data),
					parts: partsByMessage.get(String(message.id)) ?? [],
				}));
				return {
					meta: session,
					messages: parsedMessages,
					sourcePath: `${this.zcodeDb}#${session.id}`,
					// 单会话内容大小估算（而非整个 DB 文件大小），供列表展示与状态对比。
					sourceSize: this.estimateSessionSize(session, parsedMessages),
					sourceMtime: info.mtimeMs,
				};
			});
		} finally {
			db.close();
		}
	}

	private parseJson(value: unknown) {
		if (typeof value !== "string") {
			return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
		}
		try {
			return JSON.parse(value) as Record<string, unknown>;
		} catch {
			return {};
		}
	}

	private estimateSessionSize(meta: Record<string, unknown>, messages: ZCodeMessage[]) {
		return Buffer.byteLength(JSON.stringify({ meta, messages }), "utf8");
	}

	private firstModel(messages: ZCodeMessage[]) {
		// 取第一条 assistant 消息的模型信息；zcode 会在会话内切换模型（timeline part），
		// 这里只用于 model_change 头行的默认展示，具体每条消息仍带各自 provider/model。
		for (const message of messages) {
			const data = message.data;
			if (data.role === "assistant") {
				return {
					providerID: data.providerID,
					modelID: data.modelID,
				};
			}
		}
		return { providerID: undefined, modelID: undefined };
	}

	private toUsage(tokens: unknown) {
		const t = (tokens ?? {}) as Record<string, unknown>;
		const cache = (t.cache ?? {}) as Record<string, unknown>;
		return {
			input: Number(t.input ?? 0),
			output: Number(t.output ?? 0),
			cacheRead: Number(cache.read ?? 0),
			cacheWrite: Number(cache.write ?? 0),
			totalTokens: Number(t.total ?? 0),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	private async readImportMeta(targetPath: string) {
		try {
			const raw = await readFile(targetPath, "utf8");
			for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 8)) {
				const entry = JSON.parse(line) as Record<string, unknown>;
				if (entry.type === "zcode_import") {
					return {
						sourceMtime: Number(entry.sourceMtime),
						sourceSize: Number(entry.sourceSize),
					};
				}
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private getTargetPath(projectPath: string, session: ParsedZCodeSession) {
		const id = String(session.meta.id ?? this.hash(session.sourcePath)).replace(
			/[^a-zA-Z0-9_-]/g,
			"-",
		);
		return join(this.getProjectSessionDir(projectPath), `zcode_${id}.jsonl`);
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

	private extractToolOutput(state: Record<string, unknown>) {
		const output = state.output ?? state.error ?? "";
		if (typeof output === "string") return output;
		try {
			return JSON.stringify(output ?? "", null, 2);
		} catch {
			return String(output ?? "");
		}
	}

	private extractPiText(content: unknown[]) {
		return content
			.map((item) => {
				const record = item as Record<string, unknown>;
				return record?.text ?? record?.thinking ?? record?.name ?? "";
			})
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

type ZCodeMessage = {
	id: string;
	time_created: number;
	time_updated: number;
	data: Record<string, unknown>;
	parts: ZCodePart[];
};

type ZCodePart = {
	id: string;
	message_id: string;
	time_created: number;
	time_updated: number;
	data: Record<string, unknown>;
};

type ParsedZCodeSession = {
	meta: Record<string, unknown>;
	messages: ZCodeMessage[];
	sourcePath: string;
	/** zcode 历史集中在同一个 DB 中，列表里展示单会话内容估算大小，而不是整个数据库大小。 */
	sourceSize: number;
	sourceMtime: number;
};
