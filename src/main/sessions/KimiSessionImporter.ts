import { app } from "electron";
import { randomUUID } from "node:crypto";
import { open, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { KimiImportReport, KimiImportResult, KimiImportStatus, KimiSessionSummary } from "../../shared/types";
import { collectKimiAppendedKeys, convertKimiSession, convertKimiSessionTo } from "./kimiSessionConvert";
import { defaultSessionImportCopy, type SessionImportCopy } from "./SessionImportCopy";
import { ensureProjectSessionDir, getKimiTargetPath, kimiWirePath, normalizePath, readKimiImportMeta, readKimiSessionHead, readKimiSessionIndex, readKimiWireObjects, type KimiIndexEntry, type ParsedKimiSession } from "./kimiSessionSource";
import { createBufferedLineSink, mapWithConcurrency, renameWithRetry, SESSION_SCAN_CONCURRENCY } from "./sessionSourceHead";

/**
 * 导入 Kimi Code（~/.kimi-code）会话为 pi 原生会话文件。
 * 与 Claude/Codex/OpenCode/ZCode/WorkBuddy/Cursor 导入器同构：扫描源 → 转换为 pi JSONL → 写入 ~/.pi。
 * 解析与转换分别落在 kimiSessionSource / kimiSessionConvert，本类只做编排。
 *
 * 与其它源的差异：Kimi Code 没有按项目分目录，而是全局索引
 * `~/.kimi-code/session_index.jsonl`（每行 {sessionId, sessionDir, workDir}），
 * 按 workDir 与当前项目路径匹配；会话正文在 <sessionDir>/agents/main/wire.jsonl。
 */
export class KimiSessionImporter {
	private readonly kimiRoot = join(app.getPath("home"), ".kimi-code");
	private readonly piRoot = join(app.getPath("home"), ".pi", "agent", "sessions");

	constructor(private readonly translate: SessionImportCopy = defaultSessionImportCopy) {}

	async scan(projectPath: string): Promise<KimiSessionSummary[]> {
		const rows = await readKimiSessionIndex(this.kimiRoot).catch(() => []);
		const target = normalizePath(projectPath);
		// workDir 明确的行直接按路径匹配；缺 workDir 的行读 state.json 的 cwd 兜底判定。
		const candidates = rows.filter((row) => (row.workDir ? normalizePath(row.workDir) === target : true));
		// 有界并发 + 只读头部：wire.jsonl 可能正被活跃会话追加（可达几十 MB），
		// 整读（尤其是并发整读）会让主进程 384MB 堆 abort，表现为应用闪退。
		const parsed = await mapWithConcurrency(candidates, SESSION_SCAN_CONCURRENCY, (row) => readKimiSessionHead(this.kimiRoot, kimiWirePath(row.sessionDir)).catch(() => null));

		const sessions: Array<{ row: KimiIndexEntry; session: ParsedKimiSession }> = [];
		for (let i = 0; i < candidates.length; i += 1) {
			const session = parsed[i];
			if (!session) continue;
			const row = candidates[i];
			if (!row.workDir && normalizePath(session.meta.cwd) !== target) continue;
			sessions.push({ row, session });
		}

		const summaries = await Promise.all(sessions.map(({ session }) => this.toSummary(session, projectPath)));
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async import(projectPath: string, sourcePaths: string[]): Promise<KimiImportReport> {
		const results: KimiImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(await this.importOne(projectPath, sourcePath));
		}
		return {
			results,
			imported: results.filter((result) => result.success).length,
			failed: results.filter((result) => result.success === false).length,
		};
	}

	private async importOne(projectPath: string, sourcePath: string): Promise<KimiImportResult> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let tempPath: string | undefined;
		try {
			// 元数据只读头部（大源文件不能整读），正文逐行流式转换写盘：内存 O(单行)
			const parsed = await readKimiSessionHead(this.kimiRoot, sourcePath);
			const targetPath = getKimiTargetPath(this.piRoot, projectPath, parsed);
			const existing = await readKimiImportMeta(targetPath);
			await ensureProjectSessionDir(this.piRoot, projectPath);
			// 临时文件放在目标目录旁（此时已确保存在），与目标同盘才能原子改名；
			// 不写进源目录（~/.kimi-code），避免给其他应用留下垃圾文件。
			tempPath = join(dirname(targetPath), `.pideck-import-${randomUUID().slice(0, 8)}.tmp`);

			// 先写临时文件再原子改名：中途失败不会留下半截会话文件污染列表
			handle = await open(tempPath, "w");
			const buffered = createBufferedLineSink(handle);
			// 第一遍流式收集 agent.message.appended 键集合（去重策略见 kimiSessionConvert），
			// 第二遍重新开流转换。读两遍但全程流式，内存 O(单行)。
			const appendedKeys = await collectKimiAppendedKeys(readKimiWireObjects(sourcePath));
			const converted = await convertKimiSessionTo({
				projectPath,
				session: parsed,
				translate: this.translate,
				entries: readKimiWireObjects(sourcePath),
				appendedKeys,
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

	private async toSummary(session: ParsedKimiSession, projectPath: string): Promise<KimiSessionSummary> {
		const targetPath = getKimiTargetPath(this.piRoot, projectPath, session);
		const importMeta = await readKimiImportMeta(targetPath);
		const converted = await convertKimiSession({
			projectPath,
			session,
			translate: this.translate,
		});
		const status: KimiImportStatus = !importMeta ? "new" : importMeta.sourceMtime === session.sourceMtime && importMeta.sourceSize === session.sourceSize ? "current" : "outdated";

		return {
			id: session.meta.sessionId,
			sourcePath: session.sourcePath,
			targetPath,
			cwd: session.meta.cwd || projectPath,
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
