/**
 * 系统级划词浮窗：单个无边框透明 BrowserWindow（宽 440；折叠 46 / 展开 280），跟随光标弹出。
 *
 * 职责边界：只管窗口生命周期/定位/加载与「把捕获载荷推给渲染层」；
 * 取词在 systemSelectionReader，快捷键与去重在 SelectionToolService，
 * IPC 在 ipc/selectionToolIpc.ts。装配层（main/index.ts）只创建实例并注入 preload 路径。
 *
 * 生命周期约定（AGENTS.md「生命周期配对」）：
 * - 窗口惰性创建：首次 show 才创建，之后复用（隐藏不等于销毁）；
 * - 'closed'（用户/系统关闭）→ 清引用并通知 onClosed，下次 show 重新创建；
 * - dispose()（退出应用）→ 摘掉 blur 监听并 destroy，之后 show/hide 全部 no-op；
 * - 'blur' → 自动收起：划词浮窗必须让目标应用能立刻继续操作。
 *
 * 平台/安全：contextIsolation=true + nodeIntegration=false + 与主窗口同一份 preload
 * （desktopApi）；Chromium sandbox 跟随用户设置（与浮球/宠物窗口同源读取），
 * 不新开一套开关。transparent 窗口在 Windows 上必须显式 backgroundColor '#00000000'，
 * 否则透明区域会渲染成黑底。
 */
import { join } from "node:path";
import { BrowserWindow, app, screen } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { SelectionToolShowPayload, SelectionToolWindowState } from "../../shared/types/selectionTool";
import type { AppLogger } from "../logging/AppLogger";
import { readElectronChromiumSandboxPreference } from "../settings/SettingsStore";
import { SELECTION_TOOL_AUTO_HIDE_MS, SELECTION_TOOL_SCREEN_MARGIN, SELECTION_TOOL_WINDOW_COLLAPSED_HEIGHT, SELECTION_TOOL_WINDOW_COLLAPSED_WIDTH, SELECTION_TOOL_WINDOW_WIDTH, clampSelectionToolPosition } from "./selectionToolBounds";
import type { SelectionToolResizeInput } from "../../shared/types/selectionTool";

export type SelectionToolWindowDeps = {
	/** preload 绝对路径：装配层用 preparePreloadPath(join(__dirname, "../preload/index.js"), "selection-tool-preload.js") 解析。 */
	preloadPath: string;
	/** 主进程应用日志器；窗口加载/定位失败只落日志，不阻断全局快捷键。 */
	logger?: Pick<AppLogger, "error" | "warn"> | null;
	/** 测试/特殊装配覆盖：非空时强制按该 dev server URL 加载渲染页。 */
	devRendererUrl?: string | null;
};

export class SelectionToolWindow {
	private win: BrowserWindow | null = null;
	/** 当前窗口的首次加载 Promise：show 必须等渲染层就绪后再推载荷（提前 send 会丢事件）。 */
	private loadPromise: Promise<void> | null = null;
	private disposed = false;
	/** 渲染页加载失败过：下次 show 重新创建窗口（否则会一直复用一个空白页）。 */
	private loadFailed = false;
	/** 非聚焦弹出的自动收起定时器：Magpie 式浮条不能抢走目标应用焦点，也不能永久悬停。 */
	private autoHideTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly stateListeners = new Set<(state: SelectionToolWindowState) => void>();
	private readonly closedListeners = new Set<() => void>();

	constructor(private readonly deps: SelectionToolWindowDeps) {}

	/** 当前可见性（IPC selection-tool:get-state 与「再按快捷键收起」共用同一判定）。 */
	getState(): SelectionToolWindowState {
		const win = this.win;
		return { visible: Boolean(win && !win.isDestroyed() && win.isVisible()) };
	}

	/** 可见性监听（装配层可转发给主窗口；返回退订函数，与注册成对）。 */
	onStateChanged(listener: (state: SelectionToolWindowState) => void): () => void {
		this.stateListeners.add(listener);
		return () => {
			this.stateListeners.delete(listener);
		};
	}

	/** 窗口被销毁（非 dispose）时的通知：装配层可据此做一次性收尾。 */
	onClosed(listener: () => void): () => void {
		this.closedListeners.add(listener);
		return () => {
			this.closedListeners.delete(listener);
		};
	}

	/**
	 * 预热：应用启动后调用一次可把首次弹出延迟从「创建 + 加载」降到只剩 show，
	 * 快捷键响应更跟手；失败不影响后续 show（会重新创建）。
	 */
	async warmUp(): Promise<void> {
		if (this.disposed) return;
		this.dropFailedWindow();
		const win = this.ensureWindow();
		if (!win) return;
		await this.loadPromise;
	}

	/** 弹窗：定位到光标附近 → 等渲染层加载完 → 推送捕获载荷 → showInactive 显示（不抢焦点）。永不抛。 */
	async show(payload: SelectionToolShowPayload): Promise<void> {
		if (this.disposed) return;
		this.dropFailedWindow();
		const win = this.ensureWindow();
		if (!win) return;
		try {
			// 每次新的复制/快捷键触发都从折叠浮条开始，避免上一轮展开尺寸残留。
			try {
				win.setContentSize(SELECTION_TOOL_WINDOW_COLLAPSED_WIDTH, SELECTION_TOOL_WINDOW_COLLAPSED_HEIGHT);
			} catch {
				// 窗口尚未完成初始化：保持既有尺寸即可，渲染层挂载后会再请求一次。
			}
			this.applyCursorPosition(win);
			await this.loadPromise;
			if (this.disposed || win.isDestroyed()) return;
			// 先订阅后推送的时序由渲染层保证（selection-tool/main.tsx 在 React 挂载前订阅），
			// 这里只需等 did-finish-load：模块脚本此时已执行完。
			win.webContents.send(ipcChannels.selectionToolCaptured, payload);
			// showInactive：复制即触发时绝不把焦点从目标应用抢走（Magpie 的「never steals focus」）。
			// 用户点击浮窗后会自然获得焦点，失焦仍走 blur 收起；未点击则靠定时器兜底。
			if (!win.isVisible()) win.showInactive();
			this.armAutoHide();
			this.notifyStateChanged();
		} catch (error) {
			this.deps.logger?.error("selection-tool", "Failed to show selection tool window", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** 收起浮窗（Escape / 关闭按钮 / 失去焦点 / 再次按快捷键）；不可见时是纯 no-op。 */
	hide(): void {
		const win = this.win;
		if (!win || win.isDestroyed() || !win.isVisible()) return;
		this.clearAutoHide();
		win.hide();
		this.notifyStateChanged();
	}

	/** 退出应用：注销监听并销毁窗口；之后再调用 show/hide 都是 no-op。 */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.loadFailed = false;
		this.clearAutoHide();
		this.stateListeners.clear();
		this.closedListeners.clear();
		const win = this.win;
		this.win = null;
		this.loadPromise = null;
		if (!win || win.isDestroyed()) return;
		win.removeAllListeners("blur");
		win.removeAllListeners("closed");
		win.destroy();
	}

	private ensureWindow(): BrowserWindow | null {
		const existing = this.win;
		if (existing && !existing.isDestroyed()) return existing;
		try {
			const win = new BrowserWindow({
				width: SELECTION_TOOL_WINDOW_COLLAPSED_WIDTH,
				// 初始只给折叠浮条高度；点开翻译后由渲染层请求展开到结果面板尺寸。
				height: SELECTION_TOOL_WINDOW_COLLAPSED_HEIGHT,
				show: false,
				frame: false,
				transparent: true,
				// 固定尺寸：内容按 440×280 设计，允许拖动改变大小只会让布局错位。
				resizable: false,
				movable: true,
				minimizable: false,
				maximizable: false,
				fullscreenable: false,
				skipTaskbar: true,
				alwaysOnTop: true,
				backgroundColor: "#00000000",
				webPreferences: {
					preload: this.deps.preloadPath,
					contextIsolation: true,
					nodeIntegration: false,
					// 与浮球/宠物等独立窗口同源：跟随用户设置，不在这里另起开关。
					sandbox: readElectronChromiumSandboxPreference(),
					spellcheck: false,
				},
			});
			win.setMenu(null);
			// 'floating' 层级：足够盖住普通窗口，又不会像 screen-saver 那样压住系统弹窗。
			win.setAlwaysOnTop(true, "floating");
			// macOS 全屏应用占独立 Space：允许浮窗跨 Space 显示，否则全屏场景下快捷键等于失效。
			if (process.platform === "darwin") win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
			win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
			win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
				this.deps.logger?.error("selection-tool", "Selection tool window failed to load", { errorCode, errorDescription, url: validatedURL });
			});
			win.on("blur", () => this.hide());
			win.on("closed", () => {
				if (this.win !== win) return;
				this.clearAutoHide();
				this.win = null;
				this.loadPromise = null;
				for (const listener of this.closedListeners) listener();
			});
			this.win = win;
			this.loadPromise = this.loadRenderer(win);
			return win;
		} catch (error) {
			this.deps.logger?.error("selection-tool", "Failed to create selection tool window", { error: error instanceof Error ? error.message : String(error) });
			return null;
		}
	}

	/** 加载渲染页：失败只落日志（下次 show 重新 load），Promise 永不 reject。 */
	private async loadRenderer(win: BrowserWindow): Promise<void> {
		const devUrl = this.resolveDevRendererUrl();
		try {
			if (devUrl) {
				await win.loadURL(`${devUrl}/selection-tool.html`);
			} else {
				// 打包后主进程在 out/main，渲染产物在 out/renderer（与其它独立窗口同一相对路径）。
				await win.loadFile(join(__dirname, "../renderer/selection-tool.html"));
			}
		} catch (error) {
			// 标记失败：下次 show 重新创建窗口（dev server 重启/打包路径修正后能自愈）。
			this.loadFailed = true;
			this.deps.logger?.error("selection-tool", "Selection tool renderer load rejected", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** 丢弃加载失败的窗口：先清引用再销毁，避免 'closed' 处理器再通知一遍装配层。 */
	private dropFailedWindow(): void {
		if (!this.loadFailed) return;
		this.loadFailed = false;
		const win = this.win;
		this.win = null;
		this.loadPromise = null;
		if (!win || win.isDestroyed()) return;
		win.removeAllListeners("closed");
		win.destroy();
	}

	/** dev 判定与其它窗口一致：未打包 + 有 ELECTRON_RENDERER_URL 二者同时成立（与 is.dev 等价，少一个仅 dev 用的依赖）。 */
	private resolveDevRendererUrl(): string | null {
		if (this.deps.devRendererUrl) return this.deps.devRendererUrl;
		if (app.isPackaged) return null;
		const url = process.env.ELECTRON_RENDERER_URL;
		return url && url.trim() ? url : null;
	}

	private applyCursorPosition(win: BrowserWindow): void {
		const cursor = screen.getCursorScreenPoint();
		const display = screen.getDisplayNearestPoint(cursor);
		const position = clampSelectionToolPosition({ cursor, workArea: display.workArea, size: { width: SELECTION_TOOL_WINDOW_COLLAPSED_WIDTH, height: SELECTION_TOOL_WINDOW_COLLAPSED_HEIGHT } });
		win.setPosition(position.x, position.y, false);
	}

	/** 渲染层折叠/展开时调整窗口高度；宽度固定，尺寸变化后把窗口夹回当前显示器工作区。 */
	resize(input: SelectionToolResizeInput): void {
		const win = this.win;
		if (!win || win.isDestroyed()) return;
		const width = Math.round(Math.min(560, Math.max(320, input.width)));
		const height = Math.round(Math.min(600, Math.max(SELECTION_TOOL_WINDOW_COLLAPSED_HEIGHT, input.height)));
		try {
			win.setContentSize(width, height);
			const bounds = win.getBounds();
			const workArea = screen.getDisplayMatching(bounds).workArea;
			// 用请求尺寸而不是 getBounds()：Windows 上 setContentSize 后 bounds 可能同一 tick 还未刷新，
			// 用旧高度夹紧会让展开面板底部超出工作区。
			const maxX = Math.max(workArea.x + SELECTION_TOOL_SCREEN_MARGIN, workArea.x + workArea.width - SELECTION_TOOL_SCREEN_MARGIN - width);
			const maxY = Math.max(workArea.y + SELECTION_TOOL_SCREEN_MARGIN, workArea.y + workArea.height - SELECTION_TOOL_SCREEN_MARGIN - height);
			const x = Math.min(Math.max(bounds.x, workArea.x + SELECTION_TOOL_SCREEN_MARGIN), maxX);
			const y = Math.min(Math.max(bounds.y, workArea.y + SELECTION_TOOL_SCREEN_MARGIN), maxY);
			if (x !== bounds.x || y !== bounds.y) win.setPosition(x, y, false);
			// 展开后重新计时：即使用户还没点进窗口，也给足阅读/操作时间。
			if (win.isVisible()) this.armAutoHide();
		} catch (error) {
			this.deps.logger?.warn("selection-tool", "Failed to resize selection tool window", { error: error instanceof Error ? error.message : String(error) });
		}
	}

	/** 非聚焦弹出后 30s 自动收起；期间用户点击浮窗获得焦点，失焦时 blur 会立即收起。 */
	private armAutoHide(): void {
		this.clearAutoHide();
		this.autoHideTimer = setTimeout(() => {
			this.autoHideTimer = null;
			const win = this.win;
			if (!win || win.isDestroyed() || win.isFocused()) return;
			this.hide();
		}, SELECTION_TOOL_AUTO_HIDE_MS);
	}

	private clearAutoHide(): void {
		if (!this.autoHideTimer) return;
		clearTimeout(this.autoHideTimer);
		this.autoHideTimer = null;
	}

	private notifyStateChanged(): void {
		const state = this.getState();
		const win = this.win;
		if (win && !win.isDestroyed()) win.webContents.send(ipcChannels.selectionToolStateChanged, state);
		for (const listener of this.stateListeners) listener(state);
	}
}
