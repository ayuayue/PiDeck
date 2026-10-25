import { app, BrowserWindow, ipcMain, nativeTheme, screen } from "electron";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { ipcChannels } from "../../shared/ipc";
import { preparePreloadPath } from "../preloadPath";
import { rendererHeapAdditionalArguments } from "../v8HeapLimits";
import { readElectronChromiumSandboxPreference } from "../settings/SettingsStore";
import type { SettingsStore } from "../settings/SettingsStore";
import { resolveAppColorScheme } from "../../shared/themeSchedule";
import type { AgentManager } from "../pi/AgentManager";
import type { ProjectStore } from "../projects/ProjectStore";
import { getAppLogger } from "../logging/sharedLogger";

/** 极简浮窗尺寸：状态总览 + 快捷输入 + 最近会话，刚好一屏放得下。 */
export const MINI_OVERLAY_W = 480;
export const MINI_OVERLAY_H = 640;

/** 极简浮窗状态快照：渲染层据此渲染状态区、快捷输入与最近会话列表。 */
// 类型定义在 shared/types/miniOverlay.ts（shared/types.ts barrel re-export）：
// 渲染层 tsconfig 不含 src/main，hook/surface 从 shared 引用；此处 re-export 保持 preload 既有引用路径兼容。
import type { MiniOverlayState } from "../../shared/types/miniOverlay";
export type { MiniOverlayState, MiniOverlaySessionRef } from "../../shared/types/miniOverlay";

export interface MiniOverlayWindowDeps {
	settingsStore: SettingsStore;
	agentManager: AgentManager;
	projectStore: ProjectStore;
	/** 跳转到会话（复用 tray/pet 的 focusMainWindow + queueFocusTarget 链路）。 */
	onJumpToSession: (sessionId: string, projectId: string) => void;
	/** 快捷输入：创建草稿会话并发送 prompt。 */
	onQuickPrompt: (projectId: string, text: string) => Promise<{ ok: boolean; message?: string }>;
	/** 退出浮窗：关闭悬浮球模式，回主窗口。 */
	onExit?: () => void;
	/** 收起浮窗：回悬浮球，保持悬浮球模式。 */
	onCollapse?: () => void;
	/** 切换到任务模式：隐藏小窗（不回悬浮球），主窗口以 quick-task 紧凑形态打开。 */
	onSwitchToQuickTask?: (projectPath?: string) => Promise<void>;
}

/**
 * MiniOverlayWindow —— 悬浮球点击展开的极简浮窗。
 * 480×640 无框窗口：顶部状态总览（运行中/活跃数）+ 快捷输入框 + 最近会话列表 + 底部工具行。
 * 主窗口隐藏时仍可独立工作（agent 状态经 AgentManager 订阅推送）。
 * 窗口边界感（投影/圆角）交给系统 DWM，与任务模式（主窗口紧凑形态）同款，不用透明窗口自绘。
 */
export class MiniOverlayWindow {
	private win: BrowserWindow | null = null;
	private readonly deps: MiniOverlayWindowDeps;
	private removeAgentStateListener: (() => void) | null = null;
	private destroyed = false;
	/** collapse/hide 时抑制 onExit（避免主动收起也退出悬浮球模式） */
	private suppressOnExit = false;

	constructor(deps: MiniOverlayWindowDeps) {
		this.deps = deps;
	}

	isActive(): boolean {
		return this.win !== null && !this.win.isDestroyed();
	}

	async show(): Promise<void> {
		if (this.destroyed || this.win) return;
		const sourcePreloadPath = join(__dirname, "../preload/index.js");
		const preloadPath = await preparePreloadPath(sourcePreloadPath, "mini-overlay-preload.js");
		const display = screen.getPrimaryDisplay();
		const { workArea } = display;
		// 与主窗口同源的主题底色：透明窗口在部分 Windows 环境会退化为生硬色块，非透明实底更稳。
		const miniSettings = this.deps.settingsStore.get();
		const isDarkTheme =
			resolveAppColorScheme({
				theme: miniSettings.theme,
				themeScheduleLightStart: miniSettings.themeScheduleLightStart,
				themeScheduleDarkStart: miniSettings.themeScheduleDarkStart,
				systemPrefersDark: nativeTheme.shouldUseDarkColors,
			}) === "dark";
		this.win = new BrowserWindow({
			width: MINI_OVERLAY_W,
			height: MINI_OVERLAY_H,
			// 贴屏幕右缘，不留 24px 间隙；窗口边界感（投影/圆角）交给系统 DWM，与任务模式一致。
			x: workArea.x + workArea.width - MINI_OVERLAY_W,
			y: workArea.y + Math.floor((workArea.height - MINI_OVERLAY_H) / 2),
			frame: false,
			backgroundColor: isDarkTheme ? "#121212" : "#f8f8f5",
			resizable: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			show: false,
			webPreferences: {
				preload: preloadPath,
				contextIsolation: true,
				nodeIntegration: false,
				sandbox: readElectronChromiumSandboxPreference(),
				additionalArguments: rendererHeapAdditionalArguments(),
			},
		});
		this.win.setMenu(null);
		// 跟随悬浮球「固定在最上方」设置：开关只控层级，也决定主窗口回来时浮窗是否收起。
		const alwaysOnTop = this.deps.settingsStore.get().floatingBallAlwaysOnTop !== false;
		this.win.setAlwaysOnTop(alwaysOnTop, "floating");
		this.win.on("closed", () => {
			this.win = null;
			this.removeAgentStateListener?.();
			this.removeAgentStateListener = null;
			// 只有用户主动关闭（点 X 按钮）才退出悬浮球模式；collapse/hide 不触发
			if (!this.suppressOnExit) this.deps.onExit?.();
			this.suppressOnExit = false;
		});
		this.win.once("ready-to-show", () => {
			this.win?.show();
			this.win?.focus();
			this.pushState();
		});
		if (is.dev && process.env.ELECTRON_RENDERER_URL) {
			await this.win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/index.html?mini-overlay=1`);
		} else {
			await this.win.loadFile(join(__dirname, "../renderer/index.html"), { query: { "mini-overlay": "1" } });
		}
		this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		this.win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
			getAppLogger()?.error("mini-overlay", "Mini overlay load failed", { errorCode, errorDescription, url: validatedURL });
		});
		this.removeAgentStateListener = this.deps.agentManager.addStateListener(() => this.pushState());
		this.registerIpcHandlers();
	}

	hide(): void {
		this.suppressOnExit = true;
		if (this.win && !this.win.isDestroyed()) {
			this.win.close();
		}
		this.win = null;
		this.removeAgentStateListener?.();
		this.removeAgentStateListener = null;
	}

	/** 流式 runtime 事件转发：浮窗是独立渲染进程，收不到主窗口的 sessions:runtime-event，
	 *  必须单独发一份，否则会话页只有打开瞬间的快照（失焦重建后才看到全部输出）。 */
	sendRuntimeEvent(event: unknown): void {
		if (this.win && !this.win.isDestroyed()) {
			this.win.webContents.send(ipcChannels.sessionsRuntimeEvent, event);
		}
	}

	destroy(): void {
		this.destroyed = true;
		this.hide();
	}

	/** 组装快照与 win 解耦：pushState 与 mini-overlay:get-state handler 共用，避免初始推送竞态。 */
	private buildState(): MiniOverlayState {
		const tabs = this.deps.agentManager.list();
		const running = tabs.filter((t) => t.status === "running");
		const settings = this.deps.settingsStore.get();
		const toSessionRef = (t: (typeof tabs)[number]) => ({ id: t.sessionId ?? t.id, title: t.title ?? "未命名", projectId: t.projectId, isRunning: t.status === "running" });
		// 活动会话 = 全部打开中（非 closed）的会话，对齐桌面端 tab 列表：运行中的排最前，其余按创建时间降序；
		// 若只列 running，没跑任务时区块整体消失，用户失去进入已打开会话的入口。
		const openTabs = tabs.filter((t) => t.status !== "closed");
		const byRecency = (a: (typeof tabs)[number], b: (typeof tabs)[number]) => (b.createdAt ?? 0) - (a.createdAt ?? 0);
		return {
			visible: true,
			runningCount: running.length,
			activeCount: openTabs.length,
			activeSessions: [...openTabs.filter((t) => t.status === "running").sort(byRecency), ...openTabs.filter((t) => t.status !== "running").sort(byRecency)].map(toSessionRef),
			recentSessions: openTabs.sort(byRecency).slice(0, 5).map(toSessionRef),
			projects: this.deps.projectStore.list().map((p) => ({ id: p.id, name: p.name, path: p.path })),
			// 浮窗与主窗口共用渲染层 i18n：显式 zh-TW 下发繁体；system/pseudo 等沿用历史行为（zh-CN）。
			locale: settings.language === "zh-TW" ? "zh-TW" : settings.language === "en-US" ? "en-US" : "zh-CN",
		};
	}

	private pushState(): void {
		if (!this.win || this.win.isDestroyed()) return;
		this.win.webContents.send(ipcChannels.miniOverlayState, this.buildState());
	}

	private registerIpcHandlers(): void {
		const win = this.win;
		if (!win) return;
		ipcMain.removeHandler(ipcChannels.miniOverlayGetState);
		ipcMain.handle(ipcChannels.miniOverlayGetState, (event) => {
			if (event.sender !== win.webContents) return null;
			return this.buildState();
		});
		ipcMain.removeHandler(ipcChannels.miniOverlayJumpToSession);
		ipcMain.handle(ipcChannels.miniOverlayJumpToSession, (event, sessionId: string, projectId: string) => {
			if (event.sender !== win.webContents) return;
			if (typeof sessionId !== "string" || typeof projectId !== "string") return;
			this.deps.onJumpToSession(sessionId, projectId);
			this.hide();
		});
		ipcMain.removeHandler(ipcChannels.miniOverlayQuickPrompt);
		ipcMain.handle(ipcChannels.miniOverlayQuickPrompt, async (event, projectId: string, text: string) => {
			if (event.sender !== win.webContents) return { ok: false, message: "forbidden" };
			if (typeof projectId !== "string" || typeof text !== "string") return { ok: false, message: "invalid input" };
			const result = await this.deps.onQuickPrompt(projectId, text);
			if (result.ok) this.hide();
			return result;
		});
		ipcMain.removeHandler(ipcChannels.miniOverlayClose);
		ipcMain.handle(ipcChannels.miniOverlayClose, (event) => {
			if (event.sender !== win.webContents) return;
			this.hide();
			// 关闭浮窗后退出悬浮球模式（回主窗口）
			this.deps.onExit?.();
		});
		ipcMain.removeHandler(ipcChannels.miniOverlayCollapse);
		ipcMain.handle(ipcChannels.miniOverlayCollapse, (event) => {
			if (event.sender !== win.webContents) return;
			this.hide();
			// 收起浮窗后回悬浮球（保持悬浮球模式）
			this.deps.onCollapse?.();
		});
		ipcMain.removeHandler(ipcChannels.miniOverlaySwitchToQuickTask);
		ipcMain.handle(ipcChannels.miniOverlaySwitchToQuickTask, async (event, projectPath?: string) => {
			if (event.sender !== win.webContents) return;
			if (projectPath !== undefined && typeof projectPath !== "string") return;
			this.hide();
			// 切换到任务模式：不回悬浮球（与 onExpandCompact 一致，悬浮球同时隐藏）
			await this.deps.onSwitchToQuickTask?.(projectPath);
		});
	}
}
