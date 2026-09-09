import { app } from "electron";
import { utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	WorkBuddyImportReport,
	WorkBuddyImportResult,
	WorkBuddyImportStatus,
	WorkBuddySessionSummary,
} from "../../shared/types";
import { convertWorkBuddySession } from "./workbuddySessionConvert";
import { defaultSessionImportCopy, type SessionImportCopy } from "./SessionImportCopy";
import {
	collectWorkBuddyJsonl,
	ensureProjectSessionDir,
	getWorkBuddyProjectDir,
	getWorkBuddyTargetPath,
	readWorkBuddyImportMeta,
	readWorkBuddySession,
	type ParsedWorkBuddySession,
} from "./workbuddySessionSource";

/**
 * 导入 WorkBuddy（~/.workbuddy/projects）会话为 pi 原生会话文件。
 * 与 Claude/Codex/OpenCode/ZCode 导入器同构：扫描源目录 → 转换为 pi JSONL → 写入 ~/.pi。
 * 解析与转换分别落在 workbuddySessionSource / workbuddySessionConvert，本类只做编排。
 */
export class WorkBuddySessionImporter {
	private readonly workbuddyRoot = join(app.getPath("home"), ".workbuddy", "projects");
	private readonly piRoot = join(app.getPath("home"), ".pi", "agent", "sessions");

	constructor(private readonly translate: SessionImportCopy = defaultSessionImportCopy) {}

	async scan(projectPath: string): Promise<WorkBuddySessionSummary[]> {
		const projectDir = getWorkBuddyProjectDir(this.workbuddyRoot, projectPath);
		const files = await collectWorkBuddyJsonl(projectDir).catch(() => []);
		const sessions = await Promise.all(
			files.map((file) => readWorkBuddySession(this.workbuddyRoot, file).catch(() => null)),
		);

		const summaries = await Promise.all(
			sessions
				.filter((session): session is ParsedWorkBuddySession => Boolean(session))
				.map((session) => this.toSummary(session, projectPath)),
		);

		return summaries.sort((a, b) => b.updatedAt - a.updatedAt);
	}

	async import(projectPath: string, sourcePaths: string[]): Promise<WorkBuddyImportReport> {
		const results: WorkBuddyImportResult[] = [];
		for (const sourcePath of sourcePaths) {
			results.push(await this.importOne(projectPath, sourcePath));
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
	): Promise<WorkBuddyImportResult> {
		try {
			const parsed = await readWorkBuddySession(this.workbuddyRoot, sourcePath);
			const targetPath = getWorkBuddyTargetPath(this.piRoot, projectPath, parsed);
			const existing = await readWorkBuddyImportMeta(targetPath);
			const converted = convertWorkBuddySession({
				projectPath,
				session: parsed,
				translate: this.translate,
			});
			await ensureProjectSessionDir(this.piRoot, projectPath);
			await writeFile(targetPath, converted.raw, "utf8");
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
			return {
				id: sourcePath,
				sourcePath,
				success: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	private async toSummary(
		session: ParsedWorkBuddySession,
		projectPath: string,
	): Promise<WorkBuddySessionSummary> {
		const targetPath = getWorkBuddyTargetPath(this.piRoot, projectPath, session);
		const importMeta = await readWorkBuddyImportMeta(targetPath);
		const converted = convertWorkBuddySession({
			projectPath,
			session,
			translate: this.translate,
		});
		const status: WorkBuddyImportStatus = !importMeta
			? "new"
			: importMeta.sourceMtime === session.sourceMtime &&
			  importMeta.sourceSize === session.sourceSize
			? "current"
			: "outdated";

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
}
