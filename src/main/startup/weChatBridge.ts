import { app, type BrowserWindow } from "electron";
import { isLocalProject } from "../../shared/projectLocation";
import type { SessionRuntimeBindingGateway } from "../feishu/FeishuBridge";
import { registerWeChatIpc } from "../ipc/wechatIpc";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectStore } from "../projects/ProjectStore";
import { WeChatService } from "../wechat/WeChatService";

/**
 * 微信 iLink 桥接启动装配（自 index.ts 的 `app.whenReady()` 装配体就地外移，语句顺序与搬迁前一致）：
 * 服务构造 → 回填槽位 → IPC 注册 → 启用态自启（fire-and-forget）。
 *
 * 飞书 IPC 注册仍留在 index.ts：`tests/portableUserData.test.mjs` 用 `registerFeishuIpc({`
 * 相对 `registerIpc()` / `createWindow()` 的**源码位置**断言启动顺序，跨文件后位置不再可比。
 */
export interface WeChatBridgeContext {
	readonly appLogger: AppLogger;
	readonly getMainWindow: () => BrowserWindow | null;
	readonly projectStore: ProjectStore;
	/** 桥接建会话的统一闸门（index.ts 的 imSessionRuntimeBindings，飞书与微信共用同一实例）。 */
	readonly imSessionRuntimeBindings: SessionRuntimeBindingGateway;
	/** index.ts 的 currentMainProcessLocale：微信文案 locale，与设置同源。 */
	readonly currentMainProcessLocale: () => string;
	/** 回写微信服务单例（index.ts 的 wechatServiceRef.current = ...）。 */
	assign(patch: { wechatService?: WeChatService | null }): void;
}

/** 微信 iLink 桥接：服务构造 + IPC 注册 + 启用态自启（fire-and-forget）。 */
export function startWeChatBridge(ctx: WeChatBridgeContext): void {
	const { appLogger, getMainWindow, projectStore, imSessionRuntimeBindings, currentMainProcessLocale, assign } = ctx;
	// 微信 iLink 桥接：与飞书同构，但登录方式是扫码，且必须等界面就绪才能展示二维码。
	// 服务在这里建好并登记退出清理；启用状态下的实际连接由 start() 发起（fire-and-forget，
	// 失败只进日志/状态，不得阻断启动）。
	// 微信桥只在本机项目上建会话（与飞书同口径）：远端项目没有可交给本机 node:fs 的 cwd，
	// 把远端项目放进选择器会让 /new 之类指令直接撞 UNSUPPORTED_PROJECT_LOCATION。
	const wechatProjects = () =>
		projectStore
			.list()
			.filter(isLocalProject)
			.map((project) => ({ id: project.id, name: project.name }));
	const wechatService = new WeChatService({
		getProjects: wechatProjects,
		runtimeBindings: imSessionRuntimeBindings,
		getLocale: currentMainProcessLocale,
		getWindow: getMainWindow,
		botAgent: `PiDeck/${app.getVersion()}`,
		logger: (level, message, detail) => {
			if (level === "warn" || level === "error") void appLogger?.warn("wechat", message, detail);
			else void appLogger?.info("wechat", message, detail);
		},
	});
	assign({ wechatService });
	registerWeChatIpc({
		getMainWindow,
		wechatService,
		// 与 WeChatService 同一个只列本机项目的视图，避免 IPC 与桥看到不同的项目集。
		getProjects: wechatProjects,
	});
	void wechatService.start().catch((error: unknown) => {
		void appLogger?.warn("wechat", "WeChat bridge autostart failed", error);
	});
}
