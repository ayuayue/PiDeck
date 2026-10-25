import { app, dialog, ipcMain, protocol } from "electron";
import { mkdir, copyFile, readdir, readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import { trashPath } from "../fs/trash";
import { getAppLogger } from "../logging/sharedLogger";

/** 背景图存放目录（userData/backgrounds/），协议只服务该目录，杜绝任意本地文件读取 */
export function backgroundsDir(): string {
	return join(app.getPath("userData"), "backgrounds");
}

/**
 * 背景图选图：打开系统文件选择器（图片过滤），把选中文件复制到
 * userData/backgrounds/ 并返回文件名；同时清理旧的背景图文件，避免磁盘堆积。
 * 返回空串 = 用户取消。
 */
export async function pickBackgroundImage(win?: Electron.BrowserWindow): Promise<string> {
	const dir = backgroundsDir();
	await mkdir(dir, { recursive: true });
	const options: Electron.OpenDialogOptions = {
		title: "选择背景图",
		filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "gif", "avif"] }],
		properties: ["openFile"],
	};
	const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
	const picked = result.filePaths[0];
	if (!picked) return "";
	try {
		const ext = picked.includes(".") ? picked.slice(picked.lastIndexOf(".")) : "";
		const name = `bg-${Date.now()}${ext.toLowerCase()}`;
		await copyFile(picked, join(dir, name));
		// 清理旧背景图（仅本目录，文件名前缀 bg-）；替换场景失败不阻塞新图生效。
		for (const f of await readdir(dir)) {
			if (f !== name && f.startsWith("bg-")) {
				await trashPath(join(dir, f), { source: "backgrounds:cleanup" }).catch(() => undefined);
			}
		}
		return name;
	} catch {
		// 复制失败（磁盘/权限）按取消处理，调用方停留在无背景图状态
		return "";
	}
}

/** 删除指定背景图文件（设置清空时调用），文件名仅允许 bg- 前缀白名单 */
export async function removeBackgroundImage(name: string): Promise<void> {
	if (!/^bg-[a-zA-Z0-9.]+$/.test(name)) return;
	// 用户主动删除背景图：走系统回收站（可恢复）；失败抛错由调用方呈现。
	await trashPath(join(backgroundsDir(), name), { source: "backgrounds:remove" });
	void getAppLogger()?.info("backgrounds", "Background image removed", { name });
}

/**
 * pideck-bg:// 协议：服务 userData/backgrounds/ 目录下的背景图。
 * 路径逃逸防护：解析后必须仍位于 backgroundsDir 内，否则 404。
 */
export function registerBackgroundImageProtocol(): void {
	protocol.handle("pideck-bg", async (request) => {
		try {
			const url = new URL(request.url);
			const name = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
			if (!/^bg-[a-zA-Z0-9.]+$/.test(name)) {
				return new Response("forbidden", { status: 403 });
			}
			const file = resolve(backgroundsDir(), name);
			const root = resolve(backgroundsDir()) + sep;
			if (!file.startsWith(root)) {
				return new Response("forbidden", { status: 403 });
			}
			// net.fetch 不支持 file://（Electron 限制），直接读文件返回 Response
			const data = await readFile(file);
			const ext = file.slice(file.lastIndexOf(".") + 1).toLowerCase();
			const type = ext === "png" ? "image/png" : ext === "jpg" || ext === "jpeg" ? "image/jpeg" : ext === "webp" ? "image/webp" : ext === "gif" ? "image/gif" : ext === "avif" ? "image/avif" : "application/octet-stream";
			return new Response(data, { headers: { "Content-Type": type } });
		} catch {
			return new Response("not found", { status: 404 });
		}
	});
}

/** 注册背景图 IPC（settings: 域由 storeIpc 覆盖，这里只挂背景图专用通道） */
export function registerBackgroundsIpc(): void {
	ipcMain.handle(ipcChannels.pickBackgroundImage, (event) => pickBackgroundImage(event.sender as unknown as Electron.BrowserWindow));
	ipcMain.handle(ipcChannels.removeBackgroundImage, (_event, name: string) => removeBackgroundImage(name));
}
