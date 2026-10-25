import { app, dialog, ipcMain } from "electron";
import { randomUUID } from "node:crypto";
import { join, basename, resolve, sep } from "node:path";
import { copyFile, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";

import { ipcChannels } from "../../shared/ipc";
import { trashPath } from "../fs/trash";
import type { DraftMeta, ScratchPadData } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";

export type ScratchPadIpcDeps = {
	appLogger: Pick<AppLogger, "info" | "error">;
};

export function registerScratchPadIpc({ appLogger }: ScratchPadIpcDeps): void {
	const draftsDir = join(app.getPath("userData"), "drafts");

	/** 确保 drafts 目录存在，首次访问时如果旧 scratch-pad.md 存在则迁移为草稿 */
	async function ensureDraftsDir(): Promise<void> {
		try {
			await mkdir(draftsDir, { recursive: true });
		} catch {
			// 忽略目录已存在错误
		}
		// 迁移旧 scratch-pad.md：如果存在且有内容，移入 drafts 目录
		const oldPath = join(app.getPath("userData"), "scratch-pad.md");
		try {
			const oldStat = await stat(oldPath);
			if (oldStat.size > 0) {
				const ts = new Date(oldStat.mtimeMs);
				const name = `${ts.getFullYear()}-${String(ts.getMonth() + 1).padStart(2, "0")}-${String(ts.getDate()).padStart(2, "0")} ${String(ts.getHours()).padStart(2, "0")}-${String(ts.getMinutes()).padStart(2, "0")}-${String(ts.getSeconds()).padStart(2, "0")}.md`;
				await copyFile(oldPath, join(draftsDir, name));
			}
			await rm(oldPath);
		} catch {
			// 旧文件不存在则忽略
		}
	}

	/** 生成以当前时间命名的默认文件名：YYYY-MM-DD HH-mm-ss.md */
	function generateDraftName(): string {
		const now = new Date();
		return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")} ${String(now.getHours()).padStart(2, "0")}-${String(now.getMinutes()).padStart(2, "0")}-${String(now.getSeconds()).padStart(2, "0")}.md`;
	}

	/** 列出所有草稿，按更新时间降序排列 */
	ipcMain.handle(ipcChannels.scratchPadList, async (): Promise<DraftMeta[]> => {
		await ensureDraftsDir();
		const files = await readdir(draftsDir);
		const mdFiles = files.filter((f) => f.endsWith(".md"));
		const drafts = await Promise.all(
			mdFiles.map(async (f) => {
				const fullPath = join(draftsDir, f);
				try {
					const s = await stat(fullPath);
					return {
						id: f.replace(/\.md$/, ""),
						name: f.replace(/\.md$/, ""),
						path: fullPath,
						createdAt: s.birthtimeMs,
						updatedAt: s.mtimeMs,
					};
				} catch {
					return null;
				}
			}),
		);
		return drafts.filter((d): d is NonNullable<typeof d> => d !== null).sort((a, b) => b.updatedAt - a.updatedAt);
	});

	/** 创建新草稿，默认文件名为当前时间 */
	ipcMain.handle(ipcChannels.scratchPadCreate, async (): Promise<DraftMeta> => {
		await ensureDraftsDir();
		const name = generateDraftName();
		const fullPath = join(draftsDir, name);
		await writeFile(fullPath, "", "utf8");
		const s = await stat(fullPath);
		void appLogger.info("scratchPad", "draft created", { path: fullPath });
		return {
			id: name.replace(/\.md$/, ""),
			name: name.replace(/\.md$/, ""),
			path: fullPath,
			createdAt: s.birthtimeMs,
			updatedAt: s.mtimeMs,
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
