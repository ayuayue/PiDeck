import { app } from "electron";
import { randomUUID } from "node:crypto";
import { open, rm, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { MinimaxImportReport, MinimaxImportResult, MinimaxImportStatus, MinimaxSessionSummary } from "../../shared/types";
import { convertMinimaxSessionTo, type MinimaxMessageRecord } from "./minimaxSessionConvert";
import { getMinimaxTargetPath, minimaxSessionsRoot, readMinimaxImportMeta, readMinimaxSessionMeta, readMinimaxSqliteIndex, scanMinimaxSessions, type MinimaxSessionMeta, type MinimaxSqliteEntry } from "./minimaxSessionSource";
import { ensureProjectSessionDir, normalizePath } from "./kimiSessionSource";
import { assertSourceWithinRoot } from "./importPathGuard";
import { defaultSessionImportCopy, type SessionImportCopy } from "./SessionImportCopy";
import { createBufferedLineSink, readJsonlObjects, renameWithRetry } from "./sessionSourceHead";

/** messages.jsonl 逐行流式解析（经 readJsonlObjects 宽容模式：坏行/半行跳过 + 64MiB 单行防线）。 */
async function* readMinimaxMessageRecords(filePath: string): AsyncGenerator<MinimaxMessageRecord> {
	for await (const record of readJsonlObjects(filePath, { skipBadLines: true })) {
		yield record as MinimaxMessageRecord;
	}
}

/**
 * 导入 MinimaxCode（~/.minimax）会话为 pi 原生会话文件。
 * 与 Kimi/Claude/Codex 等导入器同构：扫描源 → 转换为 pi JSONL → 写入 ~/.pi。
 * 解析与转换分别落在 minimaxSessionSource / minimaxSessionConvert，本类只做编排。
 *
 * 与其它源的差异：数据目录固定（~/.minimax/v2/sessions，无自定义位置）；
 * 全局索引在 ~/.minimax/v2/sqlite/runtime-state.sqlite（标题/workspace_dir，读取失败降级），
 * cwd 主源是 llm-call.json 的 systemPrompt（working directory 行），索引的 workspace_dir 兜底，
 * 与当前项目路径匹配的才是候选。
 */
export class MinimaxSessionImporter {
	private readonly minimaxRoot = minimaxSessionsRoot(app.getPath("home"));
	private readonly piRoot = join(app.getPath("home"), ".pi", "agent", "sessions");
	/** sqlite 索引（标题）：首访问时读一次并缓存；失败降级为空 Map，不影响导入 */
	private sqliteIndex?: Promise<Map<string, MinimaxSqliteEntry>>;

	constructor(private readonly translate: SessionImportCopy = defaultSessionImportCopy) {}

	private getIndex(): Promise<Map<string, MinimaxSqliteEntry>> {
		this.sqliteIndex ??= readMinimaxSqliteIndex(dirname(this.minimaxRoot));
		return this.sqliteIndex;
	}

	async scan(projectPath: string): Promise<MinimaxSessionSummary[]> {
		const metas = await scanMinimaxSessions(this.minimaxRoot, projectPath, await this.getIndex());
		const summaries: MinimaxSessionSummary[] = [];
		for (const meta of metas) {
			summaries.push(await this.toSummary(meta, projectPath));
		}
		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async import(projectPath: string, sourcePaths: string[]): Promise<MinimaxImportReport> {
		const results: MinimaxImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(await this.importOne(projectPath, sourcePath));
		}
		return {
			results,
			imported: results.filter((result) => result.success).length,
			failed: results.filter((result) => result.success === false).length,
		};
	}

	private async importOne(projectPath: string, sourcePath: string): Promise<MinimaxImportResult> {
		let handle: Awaited<ReturnType<typeof open>> | undefined;
		let tempPath: string | undefined;
		try {
			// 路径安全：源必须在 minimax 根下（防任意路径写入）；语义校验（resolve 后比较，
			// 旧词法 startsWith 无 `/` 边界且不解析 `..`，兄弟目录与出根路径均可通过——2026-03
			// 导入器安全审计）；元数据从源目录现读（messages.jsonl 的 mtime/size 即 import 标记的判定基准）。
			assertSourceWithinRoot(this.minimaxRoot, dirname(sourcePath), "MinimaxCode");
			const meta = await readMinimaxSessionMeta(dirname(sourcePath));
			if (!meta || meta.messagesPath !== sourcePath) throw new Error(`Invalid MinimaxCode session source: ${sourcePath}`);
			// 单会话导入不走 scan：从 sqlite 索引补会话标题（缺了会回退首问/兜底文案）
			meta.sourceTitle = (await this.getIndex()).get(meta.sessionId)?.title;
			const targetPath = getMinimaxTargetPath(this.piRoot, projectPath, meta.sessionId);
			const existing = await readMinimaxImportMeta(targetPath);
			await ensureProjectSessionDir(this.piRoot, projectPath);
			// 临时文件放目标目录旁（同盘原子改名），不写进源目录（~/.minimax）
			tempPath = join(dirname(targetPath), `.pideck-import-${randomUUID().slice(0, 8)}.tmp`);

			handle = await open(tempPath, "w");
			const buffered = createBufferedLineSink(handle);
			const converted = await convertMinimaxSessionTo({
				projectPath,
				meta,
				translate: this.translate,
				entries: readMinimaxMessageRecords(sourcePath),
				sink: buffered.sink,
			});
			await buffered.flush();
			await handle.close();
			handle = undefined;
			await renameWithRetry(tempPath, targetPath);

			// 侧栏列表时间取文件 mtime：写入后回调为会话真实最后时间，
			// 避免导入会话全部显示为「刚刚导入」并排序置顶（与其他导入器同口径）。
			if (meta.updatedAt > 0) {
				const stamp = new Date(meta.updatedAt);
				await utimes(targetPath, stamp, stamp);
			}

			return {
				id: meta.sessionId,
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

	private async toSummary(meta: MinimaxSessionMeta, projectPath: string): Promise<MinimaxSessionSummary> {
		const targetPath = getMinimaxTargetPath(this.piRoot, projectPath, meta.sessionId);
		const importMeta = await readMinimaxImportMeta(targetPath);
		// 扫描摘要复用转换器（headLines 小数组、内存模式 sink），标题/预览口径与导入一致
		const lines: string[] = [];
		const converted = await convertMinimaxSessionTo({
			projectPath,
			meta,
			translate: this.translate,
			entries: meta.headLines as MinimaxMessageRecord[],
			sink: (line) => {
				lines.push(line);
			},
		});
		void lines;
		const status: MinimaxImportStatus = !importMeta ? "new" : importMeta.sourceMtime === meta.sourceMtime && importMeta.sourceSize === meta.sourceSize ? "current" : "outdated";

		return {
			id: meta.sessionId,
			sourcePath: meta.messagesPath,
			targetPath,
			cwd: meta.cwd || projectPath,
			title: converted.title,
			preview: converted.preview,
			createdAt: meta.createdAt,
			updatedAt: meta.updatedAt,
			messageCount: converted.messageCount,
			status,
			sourceSize: meta.sourceSize,
			importedSourceMtime: importMeta?.sourceMtime,
		};
	}
}
