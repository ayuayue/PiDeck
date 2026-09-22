/**
 * 快捷消息 IPC 域：只做入参校验与装配。
 * 通道：quickMessages:get / quickMessages:save / quickMessages:open-file。
 *
 * 数据落在独立配置文件 userData/quick-messages.json（QuickMessageStore 读写），
 * 不走 settings.json —— 用户可以直接编辑这个文件，UI 只是它的一个编辑器。
 */
import { ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { QuickMessagesSaveResult } from "../../shared/types/quickMessages";
import type { QuickMessageStore } from "../quickmessages/QuickMessageStore";

export function registerQuickMessagesIpc(store: QuickMessageStore, log: (scope: string, message: string, detail?: unknown) => void): void {
	ipcMain.handle(ipcChannels.quickMessagesGet, () => store.getSnapshot());

	ipcMain.handle(ipcChannels.quickMessagesSave, async (_event, items: unknown): Promise<QuickMessagesSaveResult> => {
		// 渲染层数据不可信：只接受数组（元素清洗交给 store 的 normalize，与读取路径共用同一份规则）。
		if (!Array.isArray(items)) {
			log("quick-messages", "save rejected: non-array payload", { type: typeof items });
			return { ok: false, error: "invalid payload" };
		}
		const result = await store.save(items);
		log("quick-messages", "save", { ok: result.ok, count: result.ok ? result.snapshot.items.length : undefined });
		return result;
	});

	// 打开配置文件（路径由主进程解析，渲染层只发意图，不传路径）：文件尚未生成时先落一份默认内容，
	// 否则 shell 会因为路径不存在而报错，用户看到的却是「按钮点了没反应」。
	ipcMain.handle(ipcChannels.quickMessagesOpenFile, async () => {
		await store.ensureFile();
		const error = await shell.openPath(store.resolveFilePath());
		// Electron 用返回字符串报告打开失败；显式抛出后前端才能提示路径或系统关联问题。
		if (error) throw new Error(error);
	});
}
