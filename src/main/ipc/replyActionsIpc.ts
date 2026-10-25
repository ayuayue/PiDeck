/**
 * 回复快捷操作 IPC 域：只做入参校验与装配。
 * 通道：replyActions:get / replyActions:save / replyActions:open-file。
 *
 * 数据落在独立规则文件 userData/reply-actions.json（ReplyActionRuleStore 读写），
 * 结构与快捷消息同构：UI 只是文件的编辑器，用户直接改文件同样生效。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { openSystemPath } from "../fs/openPath";
import type { ReplyActionsSaveResult } from "../../shared/types/replyActions";
import type { ReplyActionRuleStore } from "../replyactions/ReplyActionRuleStore";

export function registerReplyActionsIpc(store: ReplyActionRuleStore, log: (scope: string, message: string, detail?: unknown) => void): void {
	ipcMain.handle(ipcChannels.replyActionsGet, () => store.getSnapshot());

	ipcMain.handle(ipcChannels.replyActionsSave, async (_event, items: unknown): Promise<ReplyActionsSaveResult> => {
		// 渲染层数据不可信：只接受数组（元素清洗交给 store 的 sanitize，与读取路径共用同一份规则）。
		if (!Array.isArray(items)) {
			log("reply-actions", "save rejected: non-array payload", { type: typeof items });
			return { ok: false, error: "invalid payload" };
		}
		const result = await store.save(items);
		log("reply-actions", "save", { ok: result.ok, count: result.ok ? result.snapshot.items.length : undefined });
		return result;
	});

	// 打开规则文件（路径由主进程解析，渲染层只发意图）：文件尚未生成时先落一份默认内容。
	ipcMain.handle(ipcChannels.replyActionsOpenFile, async () => {
		await store.ensureFile();
		const error = await openSystemPath(store.resolveFilePath());
		// Electron 用返回字符串报告打开失败；显式抛出后前端才能提示路径或系统关联问题。
		if (error) throw new Error(error);
	});
}
