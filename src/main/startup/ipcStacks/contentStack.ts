import { app } from "electron";
import { join } from "node:path";
import { QUICK_MESSAGES_DEFAULT_RESOURCE_NAME, QUICK_MESSAGES_FILE_NAME, REPLY_ACTIONS_DEFAULT_RESOURCE_NAME, REPLY_ACTIONS_FILE_NAME } from "../../../shared/quickMessages";
import { registerBuiltInExtensionIpc } from "../../ipc/builtInExtensionIpc";
import { registerCatalogIpc } from "../../ipc/catalogIpc";
import { registerQuickMessagesIpc } from "../../ipc/quickMessagesIpc";
import { registerReplyActionsIpc } from "../../ipc/replyActionsIpc";
import type { BuiltInExtensionsUpdater } from "../../extensions/builtInExtensionsUpdater";
import type { PiAiCatalogUpdater } from "../../pi/PiAiCatalogUpdater";
import type { AppLogger } from "../../logging/AppLogger";
import type { SettingsStore } from "../../settings/SettingsStore";
import type { UpdateService } from "../../update/UpdateService";
import { QuickMessageStore } from "../../quickmessages/QuickMessageStore";
import { ReplyActionRuleStore } from "../../replyactions/ReplyActionRuleStore";

export interface ContentStackContext {
	readonly appLogger: AppLogger;
	readonly builtInExtensionsUpdater: BuiltInExtensionsUpdater;
	readonly catalogUpdater: PiAiCatalogUpdater;
	readonly getUpdateService: () => UpdateService | null;
	readonly settingsStore: SettingsStore;
}

/**
 * catalog / 快捷消息 / 回复动作 / 内置扩展热更新 IPC 装配（自 index.ts 的 registerIpc 逐段外移，行为零变化）。
 *
 * 两个用户可编辑清单 store 只在这里使用，随注册一起搬入；catalog 更新回调取当前 UpdateService
 * （它在本段之前构造，闭包里读到的是同一实例）。调用顺序与搬迁前完全一致。
 */
export function registerContentStack(ctx: ContentStackContext): void {
	const { appLogger, builtInExtensionsUpdater, catalogUpdater, getUpdateService, settingsStore } = ctx;

	registerCatalogIpc(catalogUpdater, {
		// 设置页手动更新/还原后立刻用同一条链路重取结论：否则「有新版本」提示与侧栏红点
		// 要等到下一轮定时检查（默认 2h）才消失，用户看到的是「更新成功了但状态没变」。
		onCatalogChanged: () => void getUpdateService()?.refreshCatalogSnapshot(),
	});
	// 快捷消息：唯一数据源是用户配置文件（可手工编辑），出厂清单来自随包资源文件。
	// 两个路径只在此处解析，避免“读 A 写 B”的漂移（与 extensions 覆盖层同源的教训）。
	const quickMessageStore = new QuickMessageStore({
		getConfigPath: () => join(app.getPath("userData"), QUICK_MESSAGES_FILE_NAME),
		getDefaultConfigPath: () => (app.isPackaged ? join(process.resourcesPath, QUICK_MESSAGES_DEFAULT_RESOURCE_NAME) : join(app.getAppPath(), "resources", QUICK_MESSAGES_DEFAULT_RESOURCE_NAME)),
		// 旧版本把清单存在 settings.json：仅作首次种子化来源，升级后用户的已改条目不能丢。
		getLegacyItems: () => settingsStore.get().quickMessages,
		log: (scope, message, detail) => void appLogger.info(scope, message, detail),
	});
	registerQuickMessagesIpc(quickMessageStore, (scope, message, detail) => void appLogger.info(scope, message, detail));
	// 回复快捷操作：最新回复尾部的建议条，规则可由用户编辑（userData/reply-actions.json），
	// 出厂规则来自随包资源 reply-actions.default.json（提交/推送/重试/继续等常用工程操作）。
	const replyActionRuleStore = new ReplyActionRuleStore({
		getConfigPath: () => join(app.getPath("userData"), REPLY_ACTIONS_FILE_NAME),
		getDefaultConfigPath: () => (app.isPackaged ? join(process.resourcesPath, REPLY_ACTIONS_DEFAULT_RESOURCE_NAME) : join(app.getAppPath(), "resources", REPLY_ACTIONS_DEFAULT_RESOURCE_NAME)),
		log: (scope, message, detail) => void appLogger.info(scope, message, detail),
	});
	registerReplyActionsIpc(replyActionRuleStore, (scope, message, detail) => void appLogger.info(scope, message, detail));
	registerBuiltInExtensionIpc(builtInExtensionsUpdater);
}
