import { useEffect } from "react";
import { useSetAtom } from "jotai";
import type { createStore } from "jotai";
import { announcementCenterOpenAtom, announcementNotificationEnabledAtom } from "../../atoms/announcement-atoms";
import { appDisplayNameAtom, customLogoAtom, logoStyleAtom } from "../../atoms/app-ui-atoms";
import { writeBootBrandCache } from "../../components/app/bootBrandCache";
import { LOGO_STYLE_STORAGE_KEY, resolveLogoStyle } from "../../components/app/piTuiLogoData";
import { resolveAppDisplayName } from "../../../../shared/types/settings";
import type { AppSettings } from "../../../../shared/types";

/**
 * 设置 → 渲染层镜像 atom / 开屏缓存的三条同步 effect：
 *
 * - logo 风格：LogoMark / 侧栏 / 关于弹层订阅 atom 即时切换；localStorage 让下次启动的
 *   启动画面（React 挂载前）就用同一风格，避免开屏闪回默认 pi-tui；
 * - 自定义品牌（显示名称 / 自定义 logo 图）：品牌区、关于弹层、空态 LogoMark 订阅即时切换。
 *   自定义图只在 custom 风格下进开屏缓存，切回内置风格时要清掉，否则开屏会残留旧图；
 * - 公告通知开关：通知调度与侧栏入口显隐共用同一数据源；关闭时顺带收起公告弹窗，
 *   避免重新开启后残留的 open=true 让弹窗自动弹开。
 */
export interface AppSettingsMirrorsDeps {
	settings: AppSettings;
	store: ReturnType<typeof createStore>;
}

export function useAppSettingsMirrors({ settings, store }: AppSettingsMirrorsDeps): void {
	// logo 风格 → 渲染层镜像 atom + localStorage 缓存：LogoMark/侧栏/关于弹层订阅 atom 即时切换；
	// localStorage 让下次启动的启动画面（React 挂载前）就能用同一风格，避免开屏闪回默认 pi-tui。
	const setLogoStyle = useSetAtom(logoStyleAtom);
	useEffect(() => {
		const logoStyle = resolveLogoStyle(settings.logoStyle);
		setLogoStyle(logoStyle);
		try {
			window.localStorage.setItem(LOGO_STYLE_STORAGE_KEY, logoStyle);
		} catch {
			// localStorage 不可用（隐私模式等）只影响启动画面回退 classic，不致命
		}
	}, [settings.logoStyle, setLogoStyle]);

	// 自定义品牌（显示名称 / 自定义 logo 图）→ 渲染层镜像 atom：品牌区、关于弹层、空态 LogoMark 订阅即时切换；
	// 同时写 localStorage 开屏缓存，让下次启动的开屏（React 挂载前）用同一套品牌值。
	// 自定义图只在 custom 风格下进缓存：切回内置风格时要把上一张图清掉，否则开屏会残留旧图。
	const setAppDisplayName = useSetAtom(appDisplayNameAtom);
	const setCustomLogo = useSetAtom(customLogoAtom);
	useEffect(() => {
		const displayName = resolveAppDisplayName(settings.appDisplayName);
		const customLogo = resolveLogoStyle(settings.logoStyle) === "custom" ? (settings.logoCustomImage ?? "") : "";
		setAppDisplayName(displayName);
		setCustomLogo(settings.logoCustomImage ?? "");
		writeBootBrandCache(displayName, customLogo);
	}, [settings.appDisplayName, settings.logoCustomImage, settings.logoStyle, setAppDisplayName, setCustomLogo]);

	// 公告通知开关 → 渲染层镜像 atom：通知调度与侧栏入口显隐共用同一数据源，
	// 设置保存后即时生效（settings.get 首拉与 onSettingsApplied 都经此处同步）
	const setAnnouncementNotifyEnabled = useSetAtom(announcementNotificationEnabledAtom);
	useEffect(() => {
		setAnnouncementNotifyEnabled(settings.announcementNotificationEnabled);
		// 关闭通知时若公告弹窗恰好开着（弹窗与设置弹窗互斥，理论少见），一并收起，
		// 避免重新开启后残留的 open=true 让弹窗自动弹开
		if (!settings.announcementNotificationEnabled) {
			store.set(announcementCenterOpenAtom, false);
		}
	}, [settings.announcementNotificationEnabled, setAnnouncementNotifyEnabled, store]);
}
