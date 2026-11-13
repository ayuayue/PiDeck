import { session, type BrowserWindow } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { ShortcutInput } from "../../shared/shortcuts";
import { isShortcutInput } from "../appShortcuts";
import { BROWSER_PANEL_PARTITION, isAllowedBrowserPanelUrl } from "../browser/browserSecurity";
import type { BrowserAgentService } from "../browser/BrowserAgentService";
import { toggleMainWindowDevTools } from "../devTools";
import type { AppLogger } from "../logging/AppLogger";
import { HOST_PLUGIN_SCHEME } from "../plugins/hostPluginPolicy";
import { hostPluginPartitionId, hostPluginWebviewBridge } from "../plugins/hostPluginWebviewPolicy";
import { rendererHeapAdditionalArguments } from "../v8HeapLimits";

/**
 * 浏览器面板 webview 宿主管线（自 index.ts 就地外移，行为零变化）：partition 权限/导航默认拒绝、
 * will-attach-webview 加固、did-attach-webview 之后把 guest 交给浏览器 Agent 并转发全局快捷键。
 *
 * 依赖一律走 getter：本模块在模块加载期就被 mainWindowDeps 引用，appLogger / browserAgentService
 * 都在 whenReady 装配阶段才赋值。
 */
export interface BrowserPanelHostContext {
	readonly getAppLogger: () => AppLogger;
	readonly getBrowserAgentService: () => BrowserAgentService | null;
	readonly handleWindowZoomShortcut: (input: ShortcutInput) => boolean;
	readonly openExternalUrl: (url: string, forceSystem?: boolean) => Promise<void>;
}

/**
 * 浏览器面板 partition 上的导航白名单拦截是否已注册。
 * Electron webRequest 监听返回 void 且不可移除；macOS activate 重建窗口会重复调用
 * configureBrowserPanelWebviewHost，必须只注册一次，否则每次重建都在共享 partition
 * 上累积一份回调（2026-10 泄漏修复）。
 */
let browserPanelRequestInstalled = false;

export function configureBrowserPanelWebviewHost(window: BrowserWindow, ctx: BrowserPanelHostContext): void {
	const { getAppLogger, getBrowserAgentService, handleWindowZoomShortcut, openExternalUrl } = ctx;
	const appLogger = getAppLogger();
	const browserPanelSession = session.fromPartition(BROWSER_PANEL_PARTITION);
	browserPanelSession.setPermissionCheckHandler(() => false);
	browserPanelSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
	browserPanelSession.setDevicePermissionHandler(() => false);
	if (!browserPanelRequestInstalled) {
		browserPanelRequestInstalled = true;
		browserPanelSession.webRequest.onBeforeRequest((details, callback) => {
			const isFrameNavigation = details.resourceType === "mainFrame" || details.resourceType === "subFrame";
			if (isFrameNavigation && !isAllowedBrowserPanelUrl(details.url)) {
				void appLogger.warn("browser", "Blocked unsafe webview frame request", {
					resourceType: details.resourceType,
					url: details.url,
				});
				callback({ cancel: true });
				return;
			}
			callback({});
		});
	}

	window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
		// 宿主插件面板：partition 形如 host-plugin:<instanceId>，由 HostPluginViewHost 签发；
		// 与内置浏览器不同，必须携带独立 preload（桥接 broker），其余安全档位与浏览器面板一致。
		const hostPluginId = hostPluginPartitionId(params.partition ?? "");
		if (hostPluginId) {
			const bridge = hostPluginWebviewBridge();
			if (!bridge || !bridge.hasLive(hostPluginId) || (params.src !== `${HOST_PLUGIN_SCHEME}://${hostPluginId}/` && !params.src?.startsWith(`${HOST_PLUGIN_SCHEME}://${hostPluginId}/`))) {
				event.preventDefault();
				void appLogger.warn("host-plugins", "Blocked host-plugin webview attachment", { instanceId: hostPluginId });
				return;
			}
			webPreferences.partition = params.partition;
			webPreferences.sandbox = true;
			webPreferences.additionalArguments = rendererHeapAdditionalArguments();
			webPreferences.nodeIntegration = false;
			webPreferences.nodeIntegrationInWorker = false;
			webPreferences.nodeIntegrationInSubFrames = false;
			webPreferences.contextIsolation = true;
			webPreferences.webSecurity = true;
			webPreferences.allowRunningInsecureContent = false;
			webPreferences.webviewTag = false;
			delete webPreferences.preload;
			delete (webPreferences as Record<string, unknown>).preloadURL;
			const pluginPreload = bridge.preloadPath();
			if (pluginPreload) webPreferences.preload = pluginPreload;
			delete params.preload;
			delete params.preloadURL;
			delete params.allowfileaccess;
			delete params.allowpopups;
			return;
		}
		const sourceUrl = params.src || "about:blank";
		if ((params.partition && params.partition !== BROWSER_PANEL_PARTITION) || !isAllowedBrowserPanelUrl(sourceUrl)) {
			event.preventDefault();
			void appLogger.warn("browser", "Blocked unsafe webview attachment", {
				sourceUrl,
				partition: params.partition,
			});
			return;
		}

		params.src = sourceUrl;
		params.partition = BROWSER_PANEL_PARTITION;
		delete params.preload;
		delete params.preloadURL;
		delete params.allowfileaccess;
		delete params.allowpopups;

		webPreferences.partition = BROWSER_PANEL_PARTITION;
		webPreferences.sandbox = true;
		// 内置浏览器是第三方页面，同样不能被主进程的 384MB 档位锁住（#213）
		webPreferences.additionalArguments = rendererHeapAdditionalArguments();
		webPreferences.nodeIntegration = false;
		webPreferences.nodeIntegrationInWorker = false;
		webPreferences.nodeIntegrationInSubFrames = false;
		webPreferences.contextIsolation = true;
		webPreferences.webSecurity = true;
		webPreferences.allowRunningInsecureContent = false;
		webPreferences.webviewTag = false;
		delete webPreferences.preload;
		delete (webPreferences as Record<string, unknown>).preloadURL;
	});

	window.webContents.on("did-attach-webview", (_event, guest) => {
		// 宿主插件 guest：绑定到实例表并接管生命周期；未登记的实例立即关闭。
		const pluginBridge = hostPluginWebviewBridge();
		if (pluginBridge) {
			const hostPluginId = pluginBridge.instanceForGuest(guest);
			if (hostPluginId) {
				pluginBridge.attachGuest(hostPluginId, guest);
				return;
			}
		}
		if (guest.session !== browserPanelSession) {
			void appLogger.warn("browser", "Closed webview with unexpected session");
			guest.close();
			return;
		}

		// 浏览器 Agent 需要留住 guest 引用（快照/点击/截图）；
		// 抽屉收起/全屏切换会销毁重建 guest，registry 允许重复登记并在 destroyed 时清理。
		getBrowserAgentService()?.attachGuest(guest);

		const blockUnsafeNavigation = (event: { url: string; preventDefault(): void }, phase: string) => {
			if (isAllowedBrowserPanelUrl(event.url)) return;
			event.preventDefault();
			void appLogger.warn("browser", "Blocked unsafe webview navigation", {
				phase,
				url: event.url,
			});
		};

		guest.on("will-frame-navigate", (event) => blockUnsafeNavigation(event, "navigate"));
		guest.on("will-redirect", (event) => blockUnsafeNavigation(event, "redirect"));
		guest.setWindowOpenHandler(({ url }) => {
			if (url !== "about:blank" && isAllowedBrowserPanelUrl(url)) {
				void openExternalUrl(url);
			} else if (!isAllowedBrowserPanelUrl(url)) {
				void appLogger.warn("browser", "Blocked unsafe webview window open", { url });
			}
			return { action: "deny" };
		});

		// webview guest 是独立 webContents，按键到不了主窗口的 before-input-event；
		// 转发全局快捷键到主窗口：窗口缩放、DevTools 开关、打开设置（唤起窗口并广播），
		// 键位按用户配置匹配（见 appShortcuts.ts / shared/shortcuts.ts）。
		guest.on("before-input-event", (event, input) => {
			if (isShortcutInput("openSettings", input)) {
				event.preventDefault();
				if (!window || window.isDestroyed()) return;
				if (!window.isVisible()) window.show();
				window.webContents.send(ipcChannels.appOpenSettings);
				return;
			}
			// 窗口缩放：命中后直接改主窗口 zoomFactor 并持久化；仅回推新比例同步设置态
			if (handleWindowZoomShortcut(input)) {
				event.preventDefault();
				return;
			}
			// Ctrl(+Shift)+Tab 在网页内无既有含义（浏览器里它就是切宿主 tab），
			// 内置浏览器里同样切 PiDeck 会话标签页。
			if (isShortcutInput("cycleSessionTabs", input)) {
				event.preventDefault();
				if (!window || window.isDestroyed()) return;
				window.webContents.send(ipcChannels.appShortcutTriggered, "cycleSessionTabs");
				return;
			}
			if (isShortcutInput("cycleSessionTabsReverse", input)) {
				event.preventDefault();
				if (!window || window.isDestroyed()) return;
				window.webContents.send(ipcChannels.appShortcutTriggered, "cycleSessionTabsReverse");
				return;
			}
			// Cmd/Ctrl+W 关闭当前会话标签页：目标会话与「回答中先弹确认」由渲染层判定，主进程只命中广播。
			if (isShortcutInput("closeSessionTab", input)) {
				event.preventDefault();
				if (!window || window.isDestroyed()) return;
				window.webContents.send(ipcChannels.appShortcutTriggered, "closeSessionTab");
				return;
			}
			if (!isShortcutInput("toggleDevTools", input)) return;
			event.preventDefault();
			toggleMainWindowDevTools(window);
		});
	});
}
