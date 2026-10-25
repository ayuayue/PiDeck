import { app } from "electron";
import { randomUUID } from "node:crypto";
import { open, rm, utimes } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { KimiImportReport, KimiImportResult, KimiImportStatus, KimiSessionSummary } from "../../shared/types";
import { convertKimiWorkSessionTo } from "./kimiWorkConvert";
import { cleanKimiTitle } from "./kimiSessionConvert";
import {
	assertKimiWorkSourcePath,
	describeKimiWorkShareRoot,
	extractKimiWorkCreatedAt,
	getKimiWorkTargetPath,
	kimiWorkDbPath,
	normalizeKimiWorkPath,
	parseKimiWorkRuntimeWirePath,
	readKimiWorkConversations,
	readKimiWorkImportMeta,
	readKimiWorkWireHead,
	resolveKimiWorkShareRoot,
	scanKimiWorkRuntimeSessions,
	statKimiWorkWire,
	type KimiWorkConversationRow,
} from "./kimiWorkSource";
import { ensureProjectSessionDir, readKimiWireObjects, type KimiRecord } from "./kimiSessionSource";
import { defaultSessionImportCopy, type SessionImportCopy } from "./SessionImportCopy";
import { createBufferedLineSink, renameWithRetry } from "./sessionSourceHead";

/**
 * sql.js 定位 wasm 的回调（打包后 wasm 在 app.asar.unpacked，见 package.json asarUnpack）。
 * sql.js 要求同步回调，这里只做字符串拼接不做 IO。
 */
export function locateKimiWorkSqlWasm(file: string): string {
	if (app.isPackaged) {
		return join(process.resourcesPath, "app.asar.unpacked", "node_modules", "sql.js", "dist", file);
	}
	return join(app.getAppPath(), "node_modules", "sql.js", "dist", file);
}

/**
 * 导入 Kimi Work（kimi-desktop 桌面版）会话为 pi 原生会话文件。
 * 与 Kimi Code CLI 版（KimiSessionImporter）的差异：
 * - 元数据不在 wire 里，而在 daimon-share 的 conversations.sqlite（sql.js 只读）；
 * - 会话列表不按项目目录组织，靠 workspace_path 字段与当前项目匹配；
 * - 数据目录可被用户自定义（daimon-storage.json），探测链见 kimiWorkSource。
 */
export class KimiWorkSessionImporter {
	private readonly piRoot = join(app.getPath("home"), ".pi", "agent", "sessions");

	constructor(
		private readonly translate: SessionImportCopy = defaultSessionImportCopy,
		private readonly locateFile: (file: string) => string = locateKimiWorkSqlWasm,
	) {}

	/** 探测 daimon-share 根（导入弹窗展示来源与状态用）。 */
	async describeShareRoot(customRoot?: string): Promise<ReturnType<typeof describeKimiWorkShareRoot>> {
		return describeKimiWorkShareRoot(app.getPath("appData"), customRoot);
	}

	/**
	 * 列出当前项目可导入的 Kimi Work 会话。
	 * 主索引是内嵌 runtime 目录的文件扫描（WAL 免疫，见 scanKimiWorkRuntimeSessions）；
	 * conversations.sqlite 读得到时用它的 title/workspace_path/精确时间做增强，读不到
	 * （WAL 未 checkpoint / 老版本）就回退 wd 标记 + wire 内容。
	 * workspace 匹配（sqlite workspace_path 完整相等 或 wd 标记目录名与当前项目同名）
	 * 的会话排前；其余也列出，按更新时间殿后——用户手动挑，不静默隐藏。
	 */
	async scan(projectPath: string, customRoot?: string): Promise<KimiSessionSummary[]> {
		const resolved = await resolveKimiWorkShareRoot(app.getPath("appData"), customRoot);
		if (!resolved) return [];
		const runtimeSessions = await scanKimiWorkRuntimeSessions(resolved.root);
		if (runtimeSessions.length === 0) return [];

		// sqlite 只作元数据增强；读不到（空表/WAL/无 db）不影响列出
		const rows = await readKimiWorkConversations(kimiWorkDbPath(resolved.root), this.locateFile).catch(() => [] as KimiWorkConversationRow[]);
		const rowByConversationId = new Map(rows.map((row) => [row.conversationId, row]));

		const target = normalizeDir(projectPath);
		const targetBasename = basename(normalizeKimiWorkPath(projectPath)).toLowerCase();
		const collected: Array<{ summary: KimiSessionSummary; matches: boolean }> = [];
		for (const runtimeSession of runtimeSessions) {
			const head = await readKimiWorkWireHead(runtimeSession.wirePath).catch(() => null);
			if (!head) continue;
			const row = rowByConversationId.get(runtimeSession.conversationId);
			const conversation: KimiWorkConversationRow = {
				conversationId: runtimeSession.conversationId,
				title: row?.title ?? "",
				firstUserText: row?.firstUserText ?? "",
				workspacePath: row?.workspacePath ?? "",
				recordsPath: row?.recordsPath ?? runtimeSession.wirePath,
				createdAtMs: row?.createdAtMs || extractKimiWorkCreatedAt(head.entries),
				updatedAtMs: row?.updatedAtMs || runtimeSession.updatedAtMs,
			};
			const matches = (row ? normalizeDir(row.workspacePath) === target : false) || (runtimeSession.workdirName !== "" && runtimeSession.workdirName.toLowerCase() === targetBasename);
			const summary = await this.toSummary(projectPath, conversation, runtimeSession.wirePath, head);
			collected.push({ summary, matches });
		}

		collected.sort((a, b) => (a.matches === b.matches ? b.summary.updatedAt - a.summary.updatedAt : a.matches ? -1 : 1));
		return collected.map((item) => item.summary);
	}

	async import(projectPath: string, sourcePaths: string[], customRoot?: string): Promise<KimiImportReport> {
		const resolved = await resolveKimiWorkShareRoot(app.getPath("appData"), customRoot);
		const results: KimiImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(await this.importOne(projectPath, sourcePath, resolved?.root));
		}
		return {
			results,
			imported: results.filter((result) => result.success).length,
			failed: results.filter((result) => result.success === false).length,
		};
	}

	private async importOne(projectPath: string, sourcePath: string, shareRoot?: string): Promise<KimiImportResult> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let tempPath: string | undefined;
		try {
			const resolved = shareRoot ?? (await resolveKimiWorkShareRoot(app.getPath("appData")))?.root;
			if (!resolved) throw new Error("Kimi Work data directory not found");
			// sourcePath 来自渲染层（不可信）：必须落在 daimon-share 之内
			assertKimiWorkSourcePath(resolved, sourcePath);

			const wireStat = await statKimiWorkWire(sourcePath);
			if (!wireStat) throw new Error("Kimi Work session file not found");

			// 会话元数据：sqlite 增强（title/精确时间）优先；行找不到时（WAL 未 checkpoint /
			// 老版本）从 runtime 目录结构合成——转换器对空 title 有自己的回退链（首条 user）。
			const parsed = parseKimiWorkRuntimeWirePath(resolved, sourcePath);
			if (!parsed) throw new Error("Kimi Work session path has unexpected layout");
			const rows = await readKimiWorkConversations(kimiWorkDbPath(resolved), this.locateFile).catch(() => [] as KimiWorkConversationRow[]);
			const row = rows.find((item) => item.recordsPath === sourcePath) ?? rows.find((item) => item.conversationId === parsed.conversationId);
			let createdAtMs = row?.createdAtMs ?? 0;
			if (createdAtMs <= 0) {
				const head = await readKimiWorkWireHead(sourcePath).catch(() => null);
				createdAtMs = head ? extractKimiWorkCreatedAt(head.entries) : 0;
			}
			const conversation: KimiWorkConversationRow = {
				conversationId: parsed.conversationId,
				title: row?.title ?? "",
				firstUserText: row?.firstUserText ?? "",
				workspacePath: row?.workspacePath ?? "",
				recordsPath: sourcePath,
				createdAtMs,
				updatedAtMs: row?.updatedAtMs || wireStat.mtimeMs,
			};

			const targetPath = getKimiWorkTargetPath(this.piRoot, projectPath, conversation.conversationId);
			const existing = await readKimiWorkImportMeta(targetPath);
			await ensureProjectSessionDir(this.piRoot, projectPath);
			// 临时文件在目标目录旁（同盘才能原子改名），不写进 daimon-share
			tempPath = join(dirname(targetPath), `.pideck-import-${randomUUID().slice(0, 8)}.tmp`);

			handle = await open(tempPath, "w");
			const buffered = createBufferedLineSink(handle);
			const converted = await convertKimiWorkSessionTo({
				projectPath,
				conversation,
				sourcePath,
				sourceSize: wireStat.size,
				sourceMtime: wireStat.mtimeMs,
				translate: this.translate,
				entries: readKimiWireObjects(sourcePath),
				sink: buffered.sink,
			});
			await buffered.flush();
			await handle.close();
			handle = undefined;
			await renameWithRetry(tempPath, targetPath);

			// 侧栏时间取会话真实最后时间，避免全部显示「刚刚导入」；sqlite 没有时退 wire mtime
			if (conversation.updatedAtMs > 0) {
				const stamp = new Date(conversation.updatedAtMs);
				await utimes(targetPath, stamp, stamp);
			}

			return {
				id: conversation.conversationId,
				sourcePath,
				targetPath,
				title: converted.title,
				success: true,
				overwritten: Boolean(existing),
				messageCount: converted.messageCount,
			};
		} catch (error) {
			await handle?.close().catch(() => undefined);
			if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
			return {
				id: sourcePath,
				sourcePath,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	/** 头部粗算消息数（append_message 计 1；loop 步以 step.begin 计 1）。截断时低估，列表摘要允许近似。 */
	private async toSummary(projectPath: string, conversation: KimiWorkConversationRow, wirePath: string, head: { entries: KimiRecord[]; size: number; mtimeMs: number }): Promise<KimiSessionSummary> {
		const targetPath = getKimiWorkTargetPath(this.piRoot, projectPath, conversation.conversationId);
		const importMeta = await readKimiWorkImportMeta(targetPath);
		const status: KimiImportStatus = !importMeta ? "new" : importMeta.sourceMtime === head.mtimeMs && importMeta.sourceSize === head.size ? "current" : "outdated";

		let messageCount = 0;
		let firstWireUserText = "";
		for (const entry of head.entries) {
			const type = typeof entry.type === "string" ? entry.type : "";
			if (type === "context.append_message") {
				messageCount += 1;
				// sqlite 无行时（WAL 未 checkpoint）的首条 user 回退：title/preview 取自 wire
				const message = entry.message as Record<string, unknown> | undefined;
				if (!firstWireUserText && message && message.role === "user") {
					const content = message.content;
					if (Array.isArray(content)) {
						for (const part of content) {
							if (part && typeof part === "object" && (part as Record<string, unknown>).type === "text" && typeof (part as Record<string, unknown>).text === "string") {
								firstWireUserText = ((part as Record<string, unknown>).text as string).trim().slice(0, 160);
								break;
							}
						}
					}
				}
			}
			if (type === "context.append_loop_event") {
				const event = entry.event;
				if (event && typeof event === "object" && !Array.isArray(event) && (event as Record<string, unknown>).type === "step.begin") messageCount += 1;
			}
		}

		const preview = (conversation.firstUserText.trim() || firstWireUserText).slice(0, 160);
		const title = conversation.title.trim() || cleanKimiTitle(preview) || this.translate("session.importedTitle", { source: "Kimi Work" });
		return {
			id: conversation.conversationId,
			sourcePath: wirePath,
			targetPath,
			cwd: conversation.workspacePath || projectPath,
			title,
			preview,
			createdAt: conversation.createdAtMs,
			updatedAt: conversation.updatedAtMs,
			messageCount,
			status,
			sourceSize: head.size,
			importedSourceMtime: importMeta?.sourceMtime,
		};
	}
}

function normalizeDir(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}
