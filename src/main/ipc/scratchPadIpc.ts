import { app, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { join, basename, resolve, sep } from "node:path";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { migrateLegacyDraft } from "../scratchpad/legacyDraftMigration";

import { ipcChannels } from "../../shared/ipc";
import { trashPath } from "../fs/trash";
import type { DraftMeta, ScratchPadData, ScratchPadScope } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";

export type ScratchPadIpcDeps = {
	appLogger: Pick<AppLogger, "info" | "error">;
};

export function registerScratchPadIpc({ appLogger }: ScratchPadIpcDeps): void {
	const draftsDir = join(app.getPath("userData"), "drafts");

	let migration: Promise<void> | undefined;
	/** 并发接口共享一次迁移，失败保留源文件并允许下次访问重试。 */
	async function ensureDraftsDir(): Promise<void> {
		migration ??= migrateLegacyDraft(app.getPath("userData"))
			.catch((error: unknown) => {
				void appLogger.error("scratchPad", "Legacy draft migration deferred; source retained", { error: String(error) });
			})
			.finally(() => {
				migration = undefined;
			});
		await migration;
	}

	/** 生成以当前时间命名的默认文件名：YYYY-MM-DD HH-mm-ss.md */
	function generateDraftName(): string {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}.md`;
	}

	/**
	 * 作用域 id 只用于目录名：限制为字母数字与 `_-`，杜绝 `..` / 分隔符把草稿写到 drafts 之外。
	 * 项目 id 是 randomUUID（或 builtin-*），全部落在这个字符集内。
	 */
	const SCOPE_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

	/** 把作用域解析成实际目录；缺省/global = drafts 根目录（向后兼容旧调用方）。 */
	function resolveScopeDir(scope?: ScratchPadScope): { dir: string; scope: "global" | "project" } {
		if (!scope || scope.kind === "global") return { dir: draftsDir, scope: "global" };
		if (scope.kind !== "project" || typeof scope.projectId !== "string" || !SCOPE_ID_PATTERN.test(scope.projectId)) {
			throw new Error("Invalid scratch pad scope");
		}
		return { dir: join(draftsDir, "projects", scope.projectId), scope: "project" };
	}

	/** 列出某个目录下的 .md 草稿，按更新时间降序；目录不存在时返回空表。 */
	async function listDraftsIn(dir: string, scope: "global" | "project"): Promise<DraftMeta[]> {
		let files: string[];
		try {
			files = await readdir(dir);
		} catch {
			return [];
		}
		const mdFiles = files.filter((f) => f.endsWith(".md"));
		const drafts = await Promise.all(
			mdFiles.map(async (f) => {
				const fullPath = join(dir, f);
				try {
					const s = await stat(fullPath);
					return {
						id: f.replace(/\.md$/, ""),
						name: f.replace(/\.md$/, ""),
						path: fullPath,
						createdAt: s.birthtimeMs,
						updatedAt: s.mtimeMs,
						scope,
					};
				} catch {
					return null;
				}
			}),
		);
		return drafts.filter((d): d is NonNullable<typeof d> => d !== null);
	}

	/**
	 * 列出草稿，按更新时间降序排列。
	 * - global：只返回全局草稿；
	 * - project：返回本项目草稿 + 全局草稿（可编辑），但不含其他项目——作用域隔离在这里收口。
	 */
	ipcMain.handle(ipcChannels.scratchPadList, async (_event, scope?: ScratchPadScope): Promise<DraftMeta[]> => {
		const resolved = resolveScopeDir(scope);
		// 根目录迁移（旧 scratch-pad.md → drafts）只在访问全局桶时做一次；项目作用域也要能看到全局草稿。
		await ensureDraftsDir();
		const globalDrafts = await listDraftsIn(draftsDir, "global");
		const scopedDrafts = resolved.scope === "project" ? await listDraftsIn(resolved.dir, "project") : [];
		return [...scopedDrafts, ...globalDrafts].sort((a, b) => b.updatedAt - a.updatedAt);
	});

	/** 创建新草稿，默认文件名为当前时间；项目作用域写入项目目录，全局作用域写入 drafts 根目录。 */
	ipcMain.handle(ipcChannels.scratchPadCreate, async (_event, scope?: ScratchPadScope): Promise<DraftMeta> => {
		const resolved = resolveScopeDir(scope);
		await mkdir(resolved.dir, { recursive: true });
		let name = generateDraftName();
		let fullPath = join(resolved.dir, name);
		try {
			await writeFile(fullPath, "", { encoding: "utf8", flag: "wx" });
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error;
			// 秒级名称只用于展示，不能充当唯一身份，更不能截断已有便签。
			name = `${name.replace(/\.md$/, "")} ${randomUUID()}.md`;
			fullPath = join(resolved.dir, name);
			await writeFile(fullPath, "", { encoding: "utf8", flag: "wx" });
		}
		const s = await stat(fullPath);
		void appLogger.info("scratchPad", "draft created", { path: fullPath, scope: resolved.scope });
		return {
			id: name.replace(/\.md$/, ""),
			name: name.replace(/\.md$/, ""),
			path: fullPath,
			createdAt: s.birthtimeMs,
			updatedAt: s.mtimeMs,
			scope: resolved.scope,
		};
	});

	/**
	 * 草稿路径边界：渲染层传入的路径必须落在 userData/drafts 内。
	 * list/create 返回的 path 是渲染层唯一合法来源（join(draftsDir, name)），
	 * 越界路径一律拒绝——否则本 handler 会变成任意文件读/写/删的静默通道
	 * （对照 filesIpc 的 project boundary 与 pasteFilesIpc 的受管根白名单）。
	 */
	const resolveDraftPath = (rawPath: unknown): string => {
		if (typeof rawPath !== "string" || !rawPath.trim()) throw new Error("Invalid draft path");
		const resolved = resolve(rawPath);
		const draftsRoot = resolve(draftsDir);
		if (resolved !== draftsRoot && !resolved.startsWith(draftsRoot + sep)) {
			throw new Error("Draft path must stay inside the drafts directory");
		}
		return resolved;
	};

	/** 删除指定草稿 */
	ipcMain.handle(ipcChannels.scratchPadDelete, async (_event, draftPath: string): Promise<void> => {
		try {
			// 先做目录边界校验再进回收站：草稿删除的合法输入只可能是 drafts 内的文件。
			const safePath = resolveDraftPath(draftPath);
			// 草稿是用户内容：删除走系统回收站（可恢复）；回收站不可用时抛错，拒绝硬删。
			await trashPath(safePath, { source: "scratchPad:delete" });
			void appLogger.info("scratchPad", "draft deleted", { path: safePath });
		} catch (error) {
			void appLogger.error("scratchPad", "Draft delete failed", {
				path: draftPath,
				error: error instanceof Error ? error.message : String(error),
			});
			throw error;
		}
	});

	/** 加载指定草稿内容，path 为空时返回空内容 */
	ipcMain.handle(ipcChannels.scratchPadLoad, async (_event, draftPath?: string): Promise<ScratchPadData> => {
		if (!draftPath) return { content: "", lastEditedAt: 0, cursorPosition: 0 };
		// 任意路径读文件是越权通道：先校验 drafts 边界再读。
		const safePath = resolveDraftPath(draftPath);
		try {
			const content = await readFile(safePath, "utf8");
			const fileStat = await stat(safePath);
			return { content, lastEditedAt: fileStat.mtimeMs, cursorPosition: 0 };
		} catch {
			return { content: "", lastEditedAt: 0, cursorPosition: 0 };
		}
	});

	/** 保存内容到指定草稿 */
	ipcMain.handle(ipcChannels.scratchPadSave, async (_event, draftPath: string, content: string, cursorPosition: number) => {
		await ensureDraftsDir();
		// 写路径同样限制在 drafts 内：渲染层不可信，越界写比越界读更危险。
		const safePath = resolveDraftPath(draftPath);
		await writeFile(safePath, content, "utf8");
		void appLogger.info("scratchPad", "saved", { path: safePath, bytes: Buffer.byteLength(content, "utf8"), cursorPosition });
	});

	/** 导出指定草稿到用户选择的路径 */
	ipcMain.handle(ipcChannels.scratchPadExport, async (_event, draftPath?: string) => {
		if (!draftPath) return false;
		// 读源也必须限制在 drafts 内；写目标由系统保存对话框选定（用户主动选择，不在边界内）。
		const safePath = resolveDraftPath(draftPath);
		const suggestedName = basename(safePath);
		const { canceled, filePath } = await dialog.showSaveDialog({
			defaultPath: suggestedName,
			filters: [{ name: "Markdown", extensions: ["md"] }],
		});
		if (canceled || !filePath) return false;
		const content = await readFile(safePath, "utf8");
		await writeFile(filePath, content, "utf8");
		return true;
	});
}
