import { join } from "node:path";
import { app, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { QuitCleanupRegistry } from "../lifecycle/QuitCleanupRegistry";
import type { AppLogger } from "../logging/AppLogger";
import type { SettingsStore } from "../settings/SettingsStore";
import type { WebServiceManager } from "../web/WebServiceManager";
import { RemoteAccessManager } from "../web/remoteAccess/RemoteAccessManager";

/**
 * 外网访问编排器启动装配（自 index.ts 的 `app.whenReady()` 装配体就地外移，语句顺序与搬迁前一致）：
 * 构造 RemoteAccessManager（隧道/EasyTier 参数每次 start 现读设置）+ 退出清理登记。
 *
 * 可变单例（remoteAccessManager）仍是 index.ts 模块级 `let` 的唯一 owner：这里经 assign 回写，
 * 退出清理闭包里读到的仍是同一份当前实例。初始探测（refresh/syncWebService）留在 index.ts 原位置。
 */
export interface RemoteAccessContext {
	readonly appLogger: AppLogger;
	readonly settingsStore: SettingsStore;
	readonly quitCleanup: QuitCleanupRegistry;
	/** Web 服务在本块之前已完成装配，getter 读到的是当前实例。 */
	readonly getWebServiceManager: () => WebServiceManager;
	readonly getMainWindow: () => BrowserWindow | null;
	/** 回写编排器单例（index.ts 的 remoteAccessManager）。 */
	assign(patch: { remoteAccessManager?: RemoteAccessManager }): void;
}

export function startRemoteAccess(ctx: RemoteAccessContext): void {
	const { appLogger, settingsStore, quitCleanup, getWebServiceManager, getMainWindow, assign } = ctx;

	// 外网访问编排器：状态推送直达主窗口；渠道随 Web 服务启停收敛
	const remoteAccessManager = new RemoteAccessManager({
		logger: appLogger,
		getWebServiceStatus: () => getWebServiceManager().getStatus(),
		// 隧道参数每次 start 取最新设置；修改后重启隧道生效
		getTunnelOptions: () => {
			const s = settingsStore.get();
			return { protocol: s.webRemoteCloudflaredProtocol ?? "http2", extraArgs: s.webRemoteCloudflaredExtraArgs };
		},
		// EasyTier 自动检测读不到虚拟 IP 时的用户兜底（设置项为空串表示未启用）
		getEasyTierManualIp: () => settingsStore.get().webRemoteEasyTierIp ?? "",
		// 解压版 CLI / 非默认目录安装：自动检测找不到时用用户指定的路径
		getEasyTierCliPath: () => settingsStore.get().webRemoteEasyTierCliPath ?? "",
		// 托管配置：三个字段齐备才接管 core；缺任意一项返回 null，退回只读探测
		getEasyTierConfig: () => {
			const s = settingsStore.get();
			const networkName = s.webRemoteEasyTierNetworkName?.trim() ?? "";
			const networkSecret = s.webRemoteEasyTierNetworkSecret?.trim() ?? "";
			if (!networkName || !networkSecret) return null;
			return {
				networkName,
				networkSecret,
				peers: s.webRemoteEasyTierPeers ?? [],
				bindIpv4: s.webRemoteEasyTierIp ?? "",
				instanceName: networkName,
			};
		},
		// 固定路径：服务安装时 -c 指向它，之后改配置只重写文件、不必重装服务
		getEasyTierConfigPath: () => join(app.getPath("userData"), "easytier", "network.toml"),
		pushState: (state) => {
			const win = getMainWindow();
			if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.webRemoteAccessChanged, state);
		},
	});
	assign({ remoteAccessManager });
	quitCleanup.register("web-remote-access", () => remoteAccessManager?.dispose());
}
