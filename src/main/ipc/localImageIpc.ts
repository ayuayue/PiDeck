/**
 * 本地图片 IPC 域：只做入参校验与装配。
 * 通道：`local-image:read-bytes`。
 *
 * 用途单一：正文图片的「保存 / 复制」需要在渲染层拿字节，而 `fetch("pideck-file://…")`
 * 在该自定义 scheme 上会被拦（详见 `main/media/localImageRead.ts`）。展示路径仍走协议，
 * 这里只服务按需读取，且白名单/体积判定与协议同一份实现。
 *
 * 拒绝原因以前是静默的：界面只有「图片加载失败」，日志里一条也没有，用户报「相对图片
 * 不显示」时分不清是路径拼错还是被白名单/体积闸拦住（issue #535）。现在每次拒绝都写一条
 * debug 日志（带原因与请求路径），渲染层的返回值不变。
 */
import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { LocalImageBytes } from "../../shared/localImage";
import type { AppLogger } from "../logging/AppLogger";
import type { CanonicalRootsProvider } from "../media/localImageRoots";
import { readLocalImageBytes } from "../media/localImageRead";

const LOG_SCOPE = "local-image";
const MAX_REQUEST_PATH_CHARS = 4096;

export function registerLocalImageIpc(deps: { resolveRoots: CanonicalRootsProvider; appLogger: Pick<AppLogger, "debug"> }): void {
	ipcMain.handle(ipcChannels.localImageReadBytes, async (_event, rawPath: unknown): Promise<LocalImageBytes | null> => {
		if (typeof rawPath !== "string" || rawPath.length === 0 || rawPath.length > MAX_REQUEST_PATH_CHARS) {
			void deps.appLogger.debug(LOG_SCOPE, "Local image read refused", { reason: "invalid-input" });
			return null;
		}
		const result = await readLocalImageBytes(rawPath, deps.resolveRoots);
		if (!result.ok) {
			// 路径是用户自己消息里的本地绝对路径，和 trajectory 日志同口径（debug 级、只落本机日志文件）。
			void deps.appLogger.debug(LOG_SCOPE, "Local image read refused", { reason: result.reason, path: rawPath });
			return null;
		}
		return { data: Buffer.from(result.bytes).toString("base64"), mimeType: result.mimeType };
	});
}
