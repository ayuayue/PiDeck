/** Desktop main-frame management only. Guests/LAN clients cannot grant themselves MCP access. */
import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { PiDeckMcpResult } from "../../shared/types/piDeckMcp";
import { piDeckMcpAccessSchema } from "../config/piDeckMcpConfig";
import type { PiDeckMcpService } from "../mcp/PiDeckMcpService";

export function registerPiDeckMcpIpc(service: PiDeckMcpService, getWindow: () => BrowserWindow | null, warn: (code: string) => void): () => void {
	const channels = [ipcChannels.piDeckMcpState, ipcChannels.piDeckMcpSetAccess, ipcChannels.piDeckMcpConnection];
	async function result<T>(event: IpcMainInvokeEvent, run: () => Promise<T>): Promise<PiDeckMcpResult<T>> {
		try {
			const window = getWindow();
			if (!window || window.isDestroyed() || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) throw new Error("sender-not-authorized");
			return { ok: true, value: await run() };
		} catch (error) {
			const code = error instanceof Error && /^[a-z-]{1,80}$/.test(error.message) ? error.message : "operation-failed";
			warn(code);
			return { ok: false, code };
		}
	}
	ipcMain.handle(ipcChannels.piDeckMcpState, (event) => result(event, () => service.getState()));
	ipcMain.handle(ipcChannels.piDeckMcpSetAccess, (event, input: unknown) =>
		result(event, async () => {
			const parsed = piDeckMcpAccessSchema.safeParse(input);
			if (!parsed.success) throw new Error("invalid-input");
			return service.setAccess(parsed.data);
		}),
	);
	ipcMain.handle(ipcChannels.piDeckMcpConnection, (event) => result(event, () => service.connection()));
	return () => {
		for (const channel of channels) ipcMain.removeHandler(channel);
	};
}
