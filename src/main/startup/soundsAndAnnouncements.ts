import { app, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { AnnouncementService } from "../announcements/AnnouncementService";
import { registerAnnouncementIpc } from "../ipc/announcementIpc";
import { registerSoundIpc } from "../ipc/soundIpc";
import type { QuitCleanupRegistry } from "../lifecycle/QuitCleanupRegistry";
import type { AppLogger } from "../logging/AppLogger";
import { isMainWindowFocused } from "../notifications/alertFocusGate";
import type { AgentManager } from "../pi/AgentManager";
import type { SettingsStore } from "../settings/SettingsStore";
import { SoundAlertService } from "../sounds/SoundAlertService";
import { registerSoundProtocol } from "../sounds/soundProtocol";
import { registerHtmlPreviewProtocol } from "../htmlPreviewProtocol";

/**
 * 声音提醒 + 应用公告启动装配（自 index.ts 的 `app.whenReady()` 装配体就地外移，语句顺序与搬迁前一致）：
 * 两个自定义协议 + 声音 IPC/服务挂载 → 公告服务构造/自启/IPC 注册，退出清理登记留在原位置。
 *
 * 可变单例（soundAlertService / announcementService）仍是 index.ts 模块级 `let` 的唯一 owner，
 * 这里经 assign 回写；退出清理闭包里读到的是同一份当前实例。
 */
export interface SoundsAndAnnouncementsContext {
	readonly appLogger: AppLogger;
	readonly agentManager: AgentManager;
	readonly settingsStore: SettingsStore;
	readonly quitCleanup: QuitCleanupRegistry;
	readonly getMainWindow: () => BrowserWindow | null;
	/** 回写两个服务单例（index.ts 的 soundAlertService / announcementService）。 */
	assign(patch: { soundAlertService?: SoundAlertService | null; announcementService?: AnnouncementService | null }): void;
}

export function startSoundsAndAnnouncements(ctx: SoundsAndAnnouncementsContext): void {
	const { appLogger, agentManager, settingsStore, quitCleanup, getMainWindow, assign } = ctx;

	// 声音提醒：纯主进程判定（settled/error 边沿/waiting 请求）+ 渲染层播放。
	// 与宠物系统同构，独立开关，不依赖宠物是否启用。
	registerSoundProtocol();
	registerHtmlPreviewProtocol();
	registerSoundIpc();
	const soundAlertService = new SoundAlertService({
		agentManager,
		settingsStore,
		getMainWindow,
		isWindowFocused: () => isMainWindowFocused(getMainWindow()),
		log: (domain, message, details) => void appLogger.info(domain, message, details),
	});
	assign({ soundAlertService });
	soundAlertService.attach();
	// 退出清理登记（before-quit 统一 runAll）
	quitCleanup.register("sound-alert", () => {
		soundAlertService?.detach();
		assign({ soundAlertService: null });
	});

	// 应用公告：无服务器拉取（仓库 announcements.json，jsDelivr → 内置镜像 → raw 兜底），
	// 2h 周期 + 启动抖动；快照变化推给主窗口，已读集合持久化在 userData。
	const announcementService = new AnnouncementService({
		userDataDir: app.getPath("userData"),
		appVersion: app.getVersion(),
		log: (domain, message, details) => void appLogger.info(domain, message, details),
		onSnapshot: (state) => {
			// 推送前判空 + isDestroyed：窗口销毁后 send 会抛
			const win = getMainWindow();
			if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.announcementChanged, state);
		},
	});
	assign({ announcementService });
	announcementService.start();
	registerAnnouncementIpc(() => announcementService);
	// 退出清理登记（before-quit 统一 runAll）：停定时器，避免退出阶段仍触发拉取
	quitCleanup.register("announcement", () => {
		announcementService?.stop();
		assign({ announcementService: null });
	});
}
