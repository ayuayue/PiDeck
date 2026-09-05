import { app } from "electron";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, stat, utimes, writeFile, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
	OpenCodeImportReport,
	OpenCodeImportResult,
	OpenCodeImportStatus,
	OpenCodeSessionSummary,
} from "../../shared/types";
import {
	defaultSessionImportCopy,
	type SessionImportCopy,
} from "./SessionImportCopy";

type OpenCodeMessage = {
	id: string;
	time_created: number;
	time_updated: number;
	data: Record<string, any>;
	parts: OpenCodePart[];
};

type OpenCodePart = {
	id: string;
	message_id: string;
	time_created: number;
	time_updated: number;
	data: Record<string, any>;
};

type ParsedOpenCodeSession = {
	meta: Record<string, any>;
	messages: OpenCodeMessage[];
	sourcePath: string;
	/** OpenCode 所有历史在同一个 DB 中，列表里展示单会话内容估算大小，而不是整个数据库大小。 */
	sourceSize: number;
	sourceMtime: number;
};

export class OpenCodeSessionImporter {
	private readonly openCodeDb = join(app.getPath("home"), ".local", "share", "opencode", "opencode.db");
	private readonly piRoot = join(app.getPath("home"), ".pi", "agent", "sessions");

	constructor(private readonly translate: SessionImportCopy = defaultSessionImportCopy) {}

	async scan(projectPath: string): Promise<OpenCodeSessionSummary[]> {
		if (!existsSync(this.openCodeDb)) return [];
		const sessions = await this.readOpenCodeSessions(projectPath);
		const summaries = await Promise.all(sessions.map((session) => this.toSummary(session, projectPath)));
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async import(projectPath: string, sourcePaths: string[]): Promise<OpenCodeImportReport> {
		const sessions = await this.readOpenCodeSessions(projectPath);
		const bySourcePath = new Map(sessions.map((session) => [session.sourcePath, session]));
		const results: OpenCodeImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(await this.importOne(projectPath, sourcePath, bySourcePath.get(sourcePath)));
		}
		return {
			results,
			imported: results.filter((result) => result.success).length,
			failed: results.filter((result) => !result.success).length,
		};
	}

	private async importOne(projectPath: string, sourcePath: string, parsed?: ParsedOpenCodeSession): Promise<OpenCodeImportResult> {
		try {
			if (!parsed) throw new Error("OpenCode session not found in database");
			const targetPath = this.getTargetPath(projectPath, parsed);
			const existing = await this.readImportMeta(targetPath);
			const converted = this.convertToPiSession(projectPath, parsed);
			await mkdir(this.getProjectSessionDir(projectPath), { recursive: true });
			// OpenCode 历史集中存放在 SQLite 中；导入时只生成 pi 可读副本，不修改原始数据库。
			await writeFile(targetPath, converted.raw, "utf8");
			// 侧栏列表时间取文件 mtime：写入后回调为会话真实最后时间，避免导入会话
			// 全部显示为「刚刚导入」并排序置顶（与 ZCode/Claude 导入器同口径）。
			const lastTimestamp = Number(parsed.meta.time_updated ?? 0);
			if (lastTimestamp > 0) {
				const stamp = new Date(lastTimestamp);
				await utimes(targetPath, stamp, stamp);
			}
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

	private async toSummary(session: ParsedOpenCodeSession, projectPath: string): Promise<OpenCodeSessionSummary> {
		const targetPath = this.getTargetPath(projectPath, session);
		const importMeta = await this.readImportMeta(targetPath);
		const converted = this.convertToPiSession(projectPath, session);
		const status: OpenCodeImportStatus = !importMeta
			? "new"
			: importMeta.sourceMtime === session.sourceMtime && importMeta.sourceSize === session.sourceSize
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

	private convertToPiSession(projectPath: string, session: ParsedOpenCodeSession) {
		const sessionId = String(session.meta.id);
		const timestamp = new Date(Number(session.meta.time_created ?? session.sourceMtime)).toISOString();
		const model = this.parseModel(session.meta.model);
		const titleState = { title: "", preview: "" };
		const lines: string[] = [];
		let parentId: string | null = null;
		let sequence = 0;
		let messageCount = 0;

		const pushEntry = (entry: Record<string, unknown>) => lines.push(JSON.stringify(entry));
		const pushMessage = (role: "user" | "assistant" | "toolResult", content: unknown[], extra: Record<string, unknown> = {}, timestampValue?: number) => {
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
			if (role === "user" && text && !titleState.title) titleState.title = this.cleanTitle(text);
		};

		pushEntry({ type: "session", version: 3, id: sessionId, timestamp, cwd: projectPath });
		pushEntry({
			type: "opencode_import",
			version: 1,
			openCodeSessionId: sessionId,
			sourcePath: session.sourcePath,
			sourceMtime: session.sourceMtime,
			sourceSize: session.sourceSize,
			importedAt: new Date().toISOString(),
		});
		const modelChangeId = this.makeId(sessionId, sequence++);
		pushEntry({
			type: "model_change",
			id: modelChangeId,
			parentId,
			timestamp,
			provider: model.providerID || "opencode",
			modelId: model.id || model.modelID || "opencode",
		});
		parentId = modelChangeId;

		for (const message of session.messages) {
			const messageData = message.data;
			const role = messageData.role;
			const content: any[] = [];
			for (const part of message.parts) {
				const partData = part.data;
				if (partData.type === "text" && partData.text) {
					content.push({ type: "text", text: String(partData.text) });
				} else if (partData.type === "reasoning" && partData.text) {
					content.push({ type: "thinking", thinking: String(partData.text), thinkingSignature: "opencode_reasoning" });
				} else if (partData.type === "tool") {
					const toolCallId = String(partData.callID ?? part.id);
					if (role === "assistant") {
						content.push({ type: "toolCall", id: toolCallId, name: String(partData.tool ?? "tool"), arguments: partData.state?.input ?? {} });
					} else {
						pushMessage("toolResult", [{ type: "text", text: this.extractToolOutput(partData) }], {
							toolCallId,
							toolName: String(partData.tool ?? "tool"),
							isError: partData.state?.status === "error",
						}, part.time_created);
					}
				}
			}

			if (role === "user") {
				pushMessage("user", content, {}, message.time_created);
			} else if (role === "assistant") {
				pushMessage("assistant", content, {
					api: "opencode-import",
					provider: messageData.providerID ?? model.providerID ?? "opencode",
					model: messageData.modelID ?? model.id ?? model.modelID ?? "opencode",
					stopReason: messageData.finish ?? "stop",
					tokens: messageData.tokens,
				}, message.time_created);
			}
		}

		const title = this.cleanTitle(String(session.meta.title ?? "")) || titleState.title ||
			this.cleanTitle(basename(session.sourcePath)) ||
			this.translate("session.importedTitle", { source: "OpenCode" });
		// 使用 pi 原生 session_info 格式追加在末尾，避免旧版 sessionName 行（无 type 字段）
		// 在文件头破坏 pi 的首行校验导致会话无法加载（见 #114）。
		const sessionInfoId = randomUUID().slice(0, 8);
		lines.push(JSON.stringify({
			type: "session_info",
			id: sessionInfoId,
			parentId,
			timestamp: new Date().toISOString(),
			name: title,
			cwd: projectPath,
		}));
		return {
			raw: `${lines.join("\n")}\n`,
			title,
			preview: titleState.preview || this.translate("session.importedPreview", { source: "OpenCode" }),
			messageCount,
		};
	}

	private async readOpenCodeSessions(projectPath: string): Promise<ParsedOpenCodeSession[]> {
		const info = await stat(this.openCodeDb);
		const normalizedProject = this.normalize(projectPath);
		const db = new DatabaseSync(this.openCodeDb, { readOnly: true });
		try {
			const sessions = db.prepare(`
				select s.*, p.worktree
				from session s
				join project p on p.id = s.project_id
				where lower(replace(p.worktree, '\\', '/')) = lower(?)
				   or lower(replace(s.directory, '\\', '/')) = lower(?)
				   or lower(replace(s.directory, '\\', '/')) like lower(? || '/%')
				order by s.time_updated desc
			`).all(normalizedProject, normalizedProject, normalizedProject) as Array<Record<string, any>>;

			return sessions.map((session) => {
				const messages = db.prepare("select id, time_created, time_updated, data from message where session_id = ? order by time_created asc").all(session.id) as Array<Record<string, any>>;
				const parts = db.prepare("select id, message_id, session_id, time_created, time_updated, data from part where session_id = ? order by time_created asc").all(session.id) as Array<Record<string, any>>;
				const partsByMessage = new Map<string, OpenCodePart[]>();
				for (const part of parts) {
					const parsedPart = { ...part, data: this.parseJson(part.data) } as OpenCodePart;
					const current = partsByMessage.get(parsedPart.message_id) ?? [];
					current.push(parsedPart);
					partsByMessage.set(parsedPart.message_id, current);
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
					sourcePath: `${this.openCodeDb}#${session.id}`,
					sourceSize: this.estimateSessionSize(session, parsedMessages),
					sourceMtime: info.mtimeMs,
				};
			});
		} finally {
			db.close();
		}
	}

	private parseJson(value: unknown) {
		if (typeof value !== "string") return value && typeof value === "object" ? value as Record<string, any> : {};
		try {
			return JSON.parse(value);
		} catch {
			return {};
		}
	}

	private estimateSessionSize(meta: Record<string, any>, messages: OpenCodeMessage[]) {
		return Buffer.byteLength(
			JSON.stringify({
				meta,
				messages,
			}),
			"utf8",
		);
	}

	private parseModel(value: unknown) {
		if (typeof value === "string") return this.parseJson(value);
		return value && typeof value === "object" ? value as Record<string, any> : {};
	}

	private toUsage(tokens: any) {
		return {
			input: Number(tokens?.input ?? 0),
			output: Number(tokens?.output ?? 0),
			cacheRead: Number(tokens?.cache?.read ?? 0),
			cacheWrite: Number(tokens?.cache?.write ?? 0),
			totalTokens: Number(tokens?.total ?? 0),
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};
	}

	private async readImportMeta(targetPath: string) {
		try {
			const raw = await readFile(targetPath, "utf8");
			for (const line of raw.split(/\r?\n/).filter(Boolean).slice(0, 8)) {
				const entry = JSON.parse(line) as any;
				if (entry.type === "opencode_import") {
					return { sourceMtime: Number(entry.sourceMtime), sourceSize: Number(entry.sourceSize) };
				}
			}
		} catch {
			return undefined;
		}
		return undefined;
	}

	private getTargetPath(projectPath: string, session: ParsedOpenCodeSession) {
		const id = String(session.meta.id ?? this.hash(session.sourcePath)).replace(/[^a-zA-Z0-9_-]/g, "-");
		return join(this.getProjectSessionDir(projectPath), `opencode_${id}.jsonl`);
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

	private extractToolOutput(part: Record<string, any>) {
		const state = part.state ?? {};
		const output = state.output ?? state.error ?? part.output ?? "";
		if (typeof output === "string") return output;
		try {
			return JSON.stringify(output ?? "", null, 2);
		} catch {
			return String(output ?? "");
		}
	}

	private extractPiText(content: unknown[]) {
		return content.map((item: any) => item?.text ?? item?.thinking ?? item?.name ?? "").filter(Boolean).join(" ");
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
		return String(path ?? "").replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
	}
}
