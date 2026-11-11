import type { IpcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SessionShareExportService } from "../sessions/SessionShareExportService";

/** 只接收会话身份/选项或 main 发出的预览令牌；未选中的原文不回传 renderer。 */
export function registerSessionShareExportIpc(ipc: IpcMain, service: SessionShareExportService): void {
	const owners = new Set<number>();
	ipc.handle(ipcChannels.sessionsSharePrepare, async (event, input: unknown) => {
		const sender = event.sender;
		if (!owners.has(sender.id)) {
			owners.add(sender.id);
			sender.once("destroyed", () => {
				owners.delete(sender.id);
				service.releaseOwner(sender.id);
			});
		}
		const result = await service.prepare(sender.id, input);
		if (sender.isDestroyed()) service.releaseOwner(sender.id);
		return result;
	});
	ipc.handle(ipcChannels.sessionsShareSave, (event, previewId: unknown) => service.save(event.sender.id, previewId));
	ipc.handle(ipcChannels.sessionsShareRelease, (event, previewId: unknown) => service.release(event.sender.id, previewId));
}
