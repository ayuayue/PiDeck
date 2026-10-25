import { app } from "electron";
import { randomUUID } from "node:crypto";
import { open, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { CursorImportReport, CursorImportResult, CursorImportStatus, CursorSessionSummary } from "../../shared/types";
import { convertCursorSession, convertCursorSessionTo } from "./cursorSessionConvert";
import { defaultSessionImportCopy, type SessionImportCopy } from "./SessionImportCopy";
import { collectCursorTranscripts, ensureProjectSessionDir, getCursorProjectDir, getCursorTargetPath, readCursorImportMeta, readCursorSessionHead, type ParsedCursorSession } from "./cursorSessionSource";
import { createBufferedLineSink, mapWithConcurrency, readJsonlObjects, renameWithRetry, SESSION_SCAN_CONCURRENCY } from "./sessionSourceHead";

/**
 * 导入 Cursor Agent（~/.cursor/projects/<slug>/agent-transcripts）会话为 pi 原生会话文件。
 * 与 Claude/Codex/OpenCode/ZCode/WorkBuddy 导入器同构：扫描源目录 → 转换为 pi JSONL → 写入 ~/.pi。
 * 解析与转换分别落在 cursorSessionSource / cursorSessionConvert，本类只做编排。
 */
export class CursorSessionImporter {
	private readonly cursorRoot = join(app.getPath("home"), ".cursor", "projects");
	private readonly piRoot = join(app.getPath("home"), ".pi", "agent", "sessions");

	constructor(private readonly translate: SessionImportCopy = defaultSessionImportCopy) {}

	async scan(projectPath: string): Promise<CursorSessionSummary[]> {
		const projectDir = getCursorProjectDir(this.cursorRoot, projectPath);
		const files = await collectCursorTranscripts(projectDir).catch(() => []);
		// 有界并发 + 只读头部：源 transcript 可达几十 MB~GB，
		// 整读（尤其是并发整读）会让主进程 384MB 堆 abort，表现为应用闪退。
		const sessions = await mapWithConcurrency(files, SESSION_SCAN_CONCURRENCY, (file) => readCursorSessionHead(this.cursorRoot, file).catch(() => null));

		const summaries = await Promise.all(sessions.filter((session): session is ParsedCursorSession => Boolean(session)).map((session) => this.toSummary(session, projectPath)));

		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async import(projectPath: string, sourcePaths: string[]): Promise<CursorImportReport> {
		const results: CursorImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(await this.importOne(projectPath, sourcePath));
		}
		return {
			results,
			imported: results.filter((result) => result.success).length,
			failed: results.filter((result) => result.success === false).length,
		};
	}

	private async importOne(projectPath: string, sourcePath: string): Promise<CursorImportResult> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let tempPath: string | undefined;
		try {
			// 元数据只读头部（大源文件不能整读），正文逐行流式转换写盘：内存 O(单行)
			const parsed = await readCursorSessionHead(this.cursorRoot, sourcePath);
			const targetPath = getCursorTargetPath(this.piRoot, projectPath, parsed);
			const existing = await readCursorImportMeta(targetPath);
			await ensureProjectSessionDir(this.piRoot, projectPath);
			// 临时文件放在目标目录旁（此时已确保存在），与目标同盘才能原子改名；
			// 不写进源目录（~/.cursor），避免给其他应用留下垃圾文件。
			tempPath = join(dirname(targetPath), `.pideck-import-${randomUUID().slice(0, 8)}.tmp`);

			// 先写临时文件再原子改名：中途失败不会留下半截会话文件污染列表
			handle = await open(tempPath, "w");
			const buffered = createBufferedLineSink(handle);
			const converted = await convertCursorSessionTo({
				projectPath,
				session: parsed,
				translate: this.translate,
				entries: readJsonlObjects(sourcePath),
				sink: buffered.sink,
			});
			await buffered.flush();
			await handle.close();
			handle = undefined;
			await renameWithRetry(tempPath, targetPath);

			// 侧栏列表时间取文件 mtime：写入后回调为会话真实最后时间，避免导入会话
			// 全部显示为「刚刚导入」并排序置顶（与其他导入器同口径）。
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
			if (tempPath) await rm(tempPath, { force: true }).catch(() => undefined);
			return {
				id: sourcePath,
				sourcePath,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async toSummary(session: ParsedCursorSession, projectPath: string): Promise<CursorSessionSummary> {
		const targetPath = getCursorTargetPath(this.piRoot, projectPath, session);
		const importMeta = await readCursorImportMeta(targetPath);
		const converted = await convertCursorSession({
			projectPath,
			session,
			translate: this.translate,
		});
		const status: CursorImportStatus = !importMeta ? "new" : importMeta.sourceMtime === session.sourceMtime && importMeta.sourceSize === session.sourceSize ? "current" : "outdated";

		return {
			id: session.meta.sessionId,
			sourcePath: session.sourcePath,
			targetPath,
			cwd: projectPath,
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
}
