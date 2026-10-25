/**
 * 本地图片 IPC 域：只做入参校验与装配。
 * 通道：`local-image:read-bytes`。
 *
 * 用途单一：正文图片的「保存 / 复制」需要在渲染层拿字节，而 `fetch("pideck-file://…")`
 * 在该自定义 scheme 上会被拦（详见 `main/media/localImageRead.ts`）。展示路径仍走协议，
 * 这里只服务按需读取，且白名单/体积判定与协议同一份实现。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { LocalImageBytes } from "../../shared/localImage";
import type { CanonicalRootsProvider } from "../media/localImageRoots";
import { readLocalImageBytes } from "../media/localImageRead";

export function registerLocalImageIpc(deps: { resolveRoots: CanonicalRootsProvider }): void {
	ipcMain.handle(ipcChannels.localImageReadBytes, async (_event, rawPath: unknown): Promise<LocalImageBytes | null> => {
		if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > 4096) return null;
		const result = await readLocalImageBytes(rawPath, deps.resolveRoots);
		if (!result) return null;
		return { data: Buffer.from(result.bytes).toString("base64"), mimeType: result.mimeType };
	});
}
