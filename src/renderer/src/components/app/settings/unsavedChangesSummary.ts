import { t, type TranslationKey } from "../../../i18n";

/**
 * 设置关闭确认里要指出「哪个 tab 的哪一项」，且**列出全部**变更项（不再是只点第一条）。
 * 字段按设置页从左到右、从上到下排列，而不是 dirty Set 的插入顺序——
 * 用户可能先改外观再改语言，但「常用设置」里的项更容易对上导航。
 */

export type SettingsUnsavedTabId =
	| "common"
	| "appearance"
	| "proxy"
	| "web"
	| "editors"
	| "git"
	| "dev"
	| "im"
	| "pet"
	| "sound"
	| "storage"
	| "usage"
	| "process"
	| "vision"
	| "imagegen";

/** 单条变更项：tab 名 + 字段名（均为 i18n key，渲染时再翻译）。 */
export type SettingsUnsavedItem = {
	tabKey: TranslationKey;
	itemKey: TranslationKey;
};

export type SettingsUnsavedSummary = {
	/** 完整去重后的变更项列表（按设置页 tab/字段目录顺序）。 */
	items: SettingsUnsavedItem[];
	/** 变更项总数（恒等于 items.length）。 */
	totalCount: number;
};

type FieldCatalogEntry = {
	field: string;
	tab: SettingsUnsavedTabId;
	itemKey: TranslationKey;
};

const TAB_LABEL_KEYS: Record<SettingsUnsavedTabId, TranslationKey> = {
	common: "settings.tabs.common",
	appearance: "settings.tabs.appearance",
	proxy: "settings.tabs.proxy",
	web: "settings.tabs.web",
	editors: "settings.tabs.editors",
	git: "settings.tabs.git",
	dev: "settings.tabs.dev",
	im: "settings.tabs.im",
	pet: "settings.tabs.pet",
	sound: "settings.tabs.sound",
	storage: "settings.tabs.storage",
	usage: "settings.tabs.usage",
	process: "settings.tabs.process",
	vision: "settings.tabs.vision",
	imagegen: "settings.tabs.imagegen",
};

/**
 * 同一控件会同时改多个 AppSettings key 时合成一项，避免「Git 摘要模型」显示成两项。
 */
const FIELD_CATALOG: readonly FieldCatalogEntry[] = [
	{ field: "language", tab: "common", itemKey: "settings.language" },
	{ field: "sessionTabOpenMode", tab: "common", itemKey: "settings.sessionTabOpenMode" },
	{ field: "autoSessionTitle", tab: "common", itemKey: "settings.autoSessionTitle" },
	{ field: "sendShortcut", tab: "common", itemKey: "settings.inputShortcut" },
	{ field: "defaultAgentBackend", tab: "common", itemKey: "settings.defaultAgentBackend" },
	{ field: "busySendDelivery", tab: "common", itemKey: "settings.busySendDelivery" },
	{ field: "linkOpenMode", tab: "common", itemKey: "settings.linkOpenMode" },
	{ field: "workspaceContentOpenMode", tab: "common", itemKey: "settings.workspaceContentOpenMode" },
	{ field: "expandInterimDuringStream", tab: "common", itemKey: "settings.expandInterimDuringStream" },
	{ field: "collapsePrevRunsOnNewTurn", tab: "common", itemKey: "settings.collapsePrevRunsOnNewTurn" },
	{ field: "idleAgentAutoRelease", tab: "common", itemKey: "settings.idleAgentAutoRelease" },
	{ field: "idleAgentKeepCount", tab: "common", itemKey: "settings.idleAgentKeepCount" },
	{ field: "idleAgentTimeoutMin", tab: "common", itemKey: "settings.idleAgentTimeoutMin" },
	{ field: "enableNotifications", tab: "common", itemKey: "settings.enableNotifications" },
	{ field: "askNotificationEnabled", tab: "common", itemKey: "settings.askNotification" },
	{ field: "agentCountReminderEnabled", tab: "common", itemKey: "settings.agentCountReminder" },
	{ field: "startupWindowMode", tab: "common", itemKey: "settings.startupWindowMode" },
	{ field: "closeToTray", tab: "common", itemKey: "settings.closeToTray" },
	{ field: "singleInstance", tab: "common", itemKey: "settings.singleInstance" },

	{ field: "theme", tab: "appearance", itemKey: "settings.theme" },
	{ field: "themeScheduleLightStart", tab: "appearance", itemKey: "settings.themeScheduleRange" },
	{ field: "themeScheduleDarkStart", tab: "appearance", itemKey: "settings.themeScheduleRange" },
	{ field: "accent", tab: "appearance", itemKey: "settings.accent" },
	// 外观主题选择器同时改 themeSkin + accent（主题自带主色），两项归并到同一摘要
	{ field: "themeSkin", tab: "appearance", itemKey: "settings.accent" },
	{ field: "backgroundImage", tab: "appearance", itemKey: "settings.backgroundImage" },
	{ field: "backgroundImageOpacity", tab: "appearance", itemKey: "settings.backgroundImage" },
	{ field: "zoomFactor", tab: "appearance", itemKey: "settings.zoomFactor" },
	{ field: "fontSize", tab: "appearance", itemKey: "settings.fontSize" },
	{ field: "uiFontSize", tab: "appearance", itemKey: "settings.uiFontSize" },
	{ field: "chatFontSize", tab: "appearance", itemKey: "settings.chatFontSize" },
	{ field: "inputFontSize", tab: "appearance", itemKey: "settings.inputFontSize" },
	{ field: "fontFamilyBase", tab: "appearance", itemKey: "settings.fontFamilyBase" },
	{ field: "fontFamilyBaseCustom", tab: "appearance", itemKey: "settings.fontFamilyBaseCustomField" },
	{ field: "fontFamilyMono", tab: "appearance", itemKey: "settings.fontFamilyMono" },
	{ field: "fontFamilyMonoCustom", tab: "appearance", itemKey: "settings.fontFamilyMonoCustomField" },
	{ field: "chatContentWidthPct", tab: "appearance", itemKey: "settings.contentWidthPct" },
	{ field: "contentMaxWidth", tab: "appearance", itemKey: "settings.contentWidthPct" },
	{ field: "useNativeTitleBar", tab: "appearance", itemKey: "settings.nativeTitleBar" },
	{ field: "showNativeMenu", tab: "appearance", itemKey: "settings.nativeMenu" },

	{ field: "piProxyEnabled", tab: "proxy", itemKey: "settings.enablePiProxy" },
	{ field: "piProxyUrl", tab: "proxy", itemKey: "settings.proxyUrl" },
	{ field: "piProxyBypass", tab: "proxy", itemKey: "settings.proxyBypass" },
	{ field: "piProxyModels", tab: "proxy", itemKey: "settings.piProxyModels" },
	{ field: "desktopProxyEnabled", tab: "proxy", itemKey: "settings.enableDesktopProxy" },
	{ field: "desktopProxyUrl", tab: "proxy", itemKey: "settings.proxyUrl" },
	{ field: "desktopProxyBypass", tab: "proxy", itemKey: "settings.proxyBypass" },

	// 宠物字段块在新侧栏顺序中位于「扩展集成」簇（dev 置底之前），
	// 目录顺序需与 settingsTabLayout 的展示顺序保持一致，
	// 关闭确认才能正确点名用户在页面上最先看到的那一项。
	{ field: "petEnabled", tab: "pet", itemKey: "settings.pet.enable" },
	{ field: "petAlwaysOnTop", tab: "pet", itemKey: "settings.pet.alwaysOnTop" },
	{ field: "petPatrolEnabled", tab: "pet", itemKey: "settings.pet.patrol" },
	{ field: "petPatrolPauseMin", tab: "pet", itemKey: "settings.pet.patrolPause" },
	{ field: "petScale", tab: "pet", itemKey: "settings.pet.scale" },
	{ field: "petId", tab: "pet", itemKey: "settings.pet.choose" },

	// 声音提醒：整块 soundAlert 归到「声音提醒」tab（目录顺序与 settingsTabLayout 一致）
	{ field: "soundAlert", tab: "sound", itemKey: "settings.sound.title" },

	{ field: "wslEnabled", tab: "dev", itemKey: "settings.piSource.label" },
	{ field: "wslDistro", tab: "dev", itemKey: "settings.wsl.distro" },
	{ field: "wslUser", tab: "dev", itemKey: "settings.wsl.user" },
	{ field: "customPiPath", tab: "dev", itemKey: "settings.customPiPath" },
	{ field: "autoDownloadUpdates", tab: "dev", itemKey: "settings.autoDownloadUpdates" },
	{ field: "rpcTimeout", tab: "dev", itemKey: "settings.rpcTimeout" },
	{ field: "maxEditorFileSizeMB", tab: "dev", itemKey: "settings.maxEditorFileSize" },
	{ field: "electronChromiumSandbox", tab: "dev", itemKey: "settings.electronSandbox" },
	{ field: "piRpcOffline", tab: "dev", itemKey: "settings.piRpcOffline" },
	{ field: "piRpcNoExtensions", tab: "dev", itemKey: "settings.piRpcNoExtensions" },
	{ field: "piRpcNoSkills", tab: "dev", itemKey: "settings.piRpcNoSkills" },
	{ field: "webServiceEnabled", tab: "web", itemKey: "settings.enableWebService" },
	{ field: "webServiceHost", tab: "web", itemKey: "settings.webServiceHost" },
	{ field: "webServicePort", tab: "web", itemKey: "settings.webServicePort" },
	{ field: "externalEditors", tab: "editors", itemKey: "settings.sectionEditors" },
	// Git 区块原在常用设置，随独立 tab 挪到「开发者」簇（web/editors 之后、dev 之前）
	{ field: "enableGitManagement", tab: "git", itemKey: "settings.gitManagement" },
	{ field: "gitCommitMessageProvider", tab: "git", itemKey: "settings.gitCommitMessageModel" },
	{ field: "gitCommitMessageModel", tab: "git", itemKey: "settings.gitCommitMessageModel" },
	{ field: "favoriteModels", tab: "git", itemKey: "settings.gitCommitMessageModel" },
	{ field: "gitCommitMessagePrompt", tab: "git", itemKey: "settings.gitCommitMessagePrompt" },
	{ field: "developerDiagnostics", tab: "dev", itemKey: "settings.developerDiagnostics" },
	{ field: "telemetryEnabled", tab: "dev", itemKey: "settings.telemetry" },
];

const UNKNOWN_ITEM: FieldCatalogEntry = {
	field: "*",
	tab: "common",
	itemKey: "settings.unsavedUnknownItem",
};

function itemIdentity(tab: SettingsUnsavedTabId, itemKey: TranslationKey): string {
	return `${tab}\0${itemKey}`;
}

/**
 * 把 dirty 字段收成关闭确认要用的一条摘要。
 * visionDirty 不是 AppSettings 字段（写 pi-deck-vision.json），单独挂到视觉桥 tab。
 */
export function summarizeSettingsUnsavedChanges(input: {
	dirtyFields: Iterable<string>;
	visionDirty?: boolean;
	imageGenDirty?: boolean;
}): SettingsUnsavedSummary | null {
	const dirty = new Set(input.dirtyFields);
	const seen = new Set<string>();
	const items: Array<{ tab: SettingsUnsavedTabId; itemKey: TranslationKey }> = [];

	const push = (tab: SettingsUnsavedTabId, itemKey: TranslationKey) => {
		const id = itemIdentity(tab, itemKey);
		if (seen.has(id)) return;
		seen.add(id);
		items.push({ tab, itemKey });
	};

	for (const entry of FIELD_CATALOG) {
		if (!dirty.has(entry.field)) continue;
		dirty.delete(entry.field);
		push(entry.tab, entry.itemKey);
	}

	// 未建目录的内部字段（侧栏展开态等）不值得逐条点名，合成「其他选项」一项。
	if (dirty.size > 0) {
		push(UNKNOWN_ITEM.tab, UNKNOWN_ITEM.itemKey);
	}

	if (input.visionDirty) {
		push("vision", "settings.vision.section");
	}

	if (input.imageGenDirty) {
		push("imagegen", "settings.tabs.imagegen");
	}

	if (items.length === 0) return null;
	return {
		items: items.map((item) => ({
			tabKey: TAB_LABEL_KEYS[item.tab],
			itemKey: item.itemKey,
		})),
		totalCount: items.length,
	};
}

/** 左侧导航要打黄点的 tab：按字段目录归并，视觉桥草稿单独算 vision。 */
export function dirtySettingsTabIds(input: {
	dirtyFields: Iterable<string>;
	visionDirty?: boolean;
	imageGenDirty?: boolean;
}): Set<SettingsUnsavedTabId> {
	const dirty = new Set(input.dirtyFields);
	const tabs = new Set<SettingsUnsavedTabId>();
	for (const entry of FIELD_CATALOG) {
		if (dirty.has(entry.field)) tabs.add(entry.tab);
	}
	if (input.visionDirty) tabs.add("vision");
	if (input.imageGenDirty) tabs.add("imagegen");
	return tabs;
}

export function formatSettingsUnsavedMessage(
	summary: SettingsUnsavedSummary | null,
	translate: typeof t = t,
): string {
	if (!summary || summary.items.length === 0) return translate("settings.unsavedMessage");
	const first = summary.items[0];
	const tab = translate(first.tabKey);
	const item = translate(first.itemKey);
	if (summary.totalCount <= 1) {
		return translate("settings.unsavedMessageDetail", { tab, item });
	}
	return translate("settings.unsavedMessageMore", {
		tab,
		item,
		count: summary.totalCount,
	});
}
