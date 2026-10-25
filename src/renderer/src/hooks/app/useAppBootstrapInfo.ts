import { useEffect, useState } from "react";
import { useAtomValue } from "jotai";
import { detectRendererPlatform } from "../../lib/detectRendererPlatform";
import { appDisplayNameAtom } from "../../atoms/app-ui-atoms";
import { composeAppTitle } from "../../../../shared/appTitle";
import type { AppInfo } from "../../../../shared/types";

/** desktopApi 的最小切片：本 hook 只需要 app 域两个查询 */
type AppInfoApi = {
	app: {
		preferredSystemLanguages: () => Promise<string[]>;
		info: () => Promise<AppInfo>;
	};
};

/**
 * 应用自描述信息域：版本/平台/目录（appInfo）与系统语言（systemLanguage）。
 * - appInfo 首帧用同步平台探测兜底，避免 Mac 在 IPC 返回前误画 Win 窗口按钮；
 * - document.title 与主进程建窗标题同源（composeAppTitle）：显示名称 + 开发态功能分支名，
 *   Electron 的原生窗口标题跟随 document.title，所以这里就是任务栏 / Alt-Tab 上的名字。
 */
export function useAppBootstrapInfo(api: AppInfoApi): { appInfo: AppInfo; systemLanguage: string | null } {
	const [appInfo, setAppInfo] = useState<AppInfo>({
		version: "-",
		releasesUrl: "https://github.com/ayuayue/PiDeck/releases",
		// 同步判定，避免 Mac 首帧在 appInfo IPC 返回前误画 Win 窗口按钮
		platform: detectRendererPlatform(),
		homeDir: "",
		userDataDir: "",
	});
	const [systemLanguage, setSystemLanguage] = useState<string | null>(null);
	// 应用显示名称（设置里的品牌名）由 App.tsx 写入 atom，改了要即时反映到标题
	const displayName = useAtomValue(appDisplayNameAtom);

	useEffect(() => {
		void api.app
			.preferredSystemLanguages()
			.then((languages) => setSystemLanguage(languages.find((language) => typeof language === "string" && language.trim()) ?? null))
			.catch(() => setSystemLanguage(null));
		void api.app
			.info()
			.then((info) => setAppInfo(info))
			.catch(() => undefined);
	}, [api]);

	// 标题与主进程建窗同源（composeAppTitle）：显示名称或开发态分支名任一变化都重算。
	// Electron 的原生窗口标题跟随 document.title（page-title-updated），因此这里就是任务栏/Alt-Tab 的标题。
	useEffect(() => {
		document.title = composeAppTitle(displayName, appInfo.devBranch);
	}, [appInfo.devBranch, displayName]);

	return { appInfo, systemLanguage };
}
