// 频道切换（channelSwitch）IPC 域：handler 只做入参校验与服务适配，业务在 update/ChannelSwitchService.ts（electron-free 可单测）。
// 快照推送不在 handler 内：query/download 服务流程中经装配层 sendToRenderer 广播，渲染层另用 onStateChanged 订阅。
import { ipcMain } from "electron";
import { resolve, sep } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type { ChannelSwitchActionResult, ChannelSwitchSnapshot, TargetChannelRelease } from "../../shared/types/app";
import { toChannelSwitchErrorMessage, type ChannelSwitchService } from "../update/ChannelSwitchService";

export interface ChannelSwitchIpcDeps {
	service: ChannelSwitchService;
	/** 安装包目录白名单根（与 ChannelSwitchService.getInstallerDir() 同源，装配层注入）。 */
	getInstallerDir: () => string;
}

/** 渲染层来的 asset 不可信：逐字段校验形状（digest 可选）。 */
function isTargetChannelRelease(value: unknown): value is TargetChannelRelease {
	if (typeof value !== "object" || value === null) return false;
	const candidate = value as { [K in keyof TargetChannelRelease]: unknown };
	return typeof candidate.version === "string" && typeof candidate.notesExcerpt === "string" && typeof candidate.assetUrl === "string" && typeof candidate.assetName === "string" && (candidate.digestSha256 === undefined || typeof candidate.digestSha256 === "string") && typeof candidate.releasePageUrl === "string";
}

export function registerChannelSwitchIpc(deps: ChannelSwitchIpcDeps): void {
	ipcMain.handle(ipcChannels.channelSwitchQuery, async (): Promise<ChannelSwitchActionResult> => {
		try {
			return { ok: true, release: await deps.service.queryTargetChannelLatest() };
		} catch (error) {
			// 服务已推 error 快照（含发布页退化入口）；IPC 只回结构化结果，不抛裸异常跨进程。
			return { ok: false, error: toChannelSwitchErrorMessage(error) };
		}
	});

	ipcMain.handle(ipcChannels.channelSwitchDownload, async (_event, asset: unknown): Promise<ChannelSwitchActionResult> => {
		if (!isTargetChannelRelease(asset)) {
			return { ok: false, error: "非法参数：asset 必须包含 version/notesExcerpt/assetUrl/assetName/releasePageUrl 字符串字段" };
		}
		try {
			return { ok: true, installerPath: await deps.service.downloadInstaller(asset) };
		} catch (error) {
			return { ok: false, error: toChannelSwitchErrorMessage(error) };
		}
	});

	ipcMain.handle(ipcChannels.channelSwitchLaunch, (_event, installerPath: unknown): ChannelSwitchActionResult => {
		if (typeof installerPath !== "string" || installerPath === "") {
			return { ok: false, error: "非法参数：installerPath 必须是非空字符串" };
		}
		// 路径安全：只允许启动本服务管理的临时安装包目录内的文件（防渲染层传任意路径拉起进程）。
		const normalized = resolve(installerPath);
		const installerDir = resolve(deps.getInstallerDir());
		if (!normalized.startsWith(installerDir + sep)) {
			return { ok: false, error: "非法路径：只允许启动频道切换临时目录内的安装包" };
		}
		try {
			deps.service.launchInstaller(normalized);
			return { ok: true };
		} catch (error) {
			return { ok: false, error: toChannelSwitchErrorMessage(error) };
		}
	});

	ipcMain.handle(ipcChannels.channelSwitchGetStatus, (): ChannelSwitchSnapshot => deps.service.getStatus());
}
