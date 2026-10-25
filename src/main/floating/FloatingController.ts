import { app, BrowserWindow, ipcMain, Menu, screen, type MenuItemConstructorOptions } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import { ipcChannels } from "../../shared/ipc";
import { mainProcessT, normalizeMainProcessLocale, type MainProcessLocale } from "../../shared/i18n/mainProcessCopy";
import { preparePreloadPath } from "../preloadPath";
import { rendererHeapAdditionalArguments } from "../v8HeapLimits";
import { readElectronChromiumSandboxPreference } from "../settings/SettingsStore";
import type { SettingsStore } from "../settings/SettingsStore";
import { getAppLogger } from "../logging/sharedLogger";

/** 悬浮球尺寸（圆形 64px，与工作台主窗口无关）。 */
export const FLOATER_SIZE = 64;
/** 文字气泡与圆环都必须落在透明窗口内，不能只按圆形 Logo 的宽度建窗。 */
const FLOATER_WINDOW_W = 224;
const FLOATER_WINDOW_H = 104;

function posPath(): string {
	return join(app.getPath("userData"), "floater-position.json");
}

interface FloaterPos {
	x: number;
	y: number;
}

async function loadPos(): Promise<FloaterPos | null> {
	try {
		const raw = await readFile(posPath(), "utf8");
		const parsed = JSON.parse(raw);
		if (Number.isFinite(parsed.x) && Number.isFinite(parsed.y)) return parsed;
		return null;
	} catch {
		return null;
	}
}

async function savePos(bounds: FloaterPos): Promise<void> {
	try {
		await mkdir(app.getPath("userData"), { recursive: true });
		await writeFile(posPath(), JSON.stringify(bounds, null, 2), "utf8");
	} catch {
		/* 保存失败不影响运行 */
	}
}

/** 悬浮球状态快照：渲染层据此渲染状态气泡与 Logo。 */
export interface FloatingBallState {
	visible: boolean;
	alwaysOnTop: boolean;
	snapToEdge: boolean;
	expandTarget: "mini" | "compact";
	/** 是否显示运行中任务数量角标（跟随设置热更）。 */
	showRunningBadge: boolean;
	activeCount: number;
	runningCount: number;
	recentTitles: string[];
	locale: MainProcessLocale;
}

export interface FloatingControllerDeps {
	settingsStore: SettingsStore;
	/** 主窗口引用（隐藏/显示主窗口）。 */
	getMainWindow: () => BrowserWindow | null;
	/** 点击悬浮球展开 mini 浮窗：主进程只负责转发，由 useQuickTask 或 mini overlay 接管。 */
	onExpandMini: () => Promise<void>;
	/** 点击悬浮球展开 compact 紧凑模式。 */
	onExpandCompact: () => Promise<void>;
	/** 显示主窗口并退出悬浮模式。 */
	onShowMainWindow: () => void;
	/** 订阅 agent 状态变化（返回 unsubscribe）。 */
	addAgentStateListener: (listener: (tabs: Array<{ id: string; status: string; title?: string }>) => void) => () => void;
	/** 当前活跃 agent 数。 */
	getActiveAgentCount: () => number;
	/** 当前运行中 agent 数。 */
	getRunningAgentCount: () => number;
	/** 最近运行中的 agent 标题（最多 3 个，用于悬浮球气泡）。 */
	getRecentRunningTitles: () => string[];
}

/**
 * FloatingController —— 悬浮球生命周期管理。
 * 主窗口隐藏后，屏幕角落常驻一个 64px 圆形悬浮球；
 * 单击展开（mini 浮窗 / compact 紧凑模式），右键切换展开目标或退出悬浮模式。
 * 位置持久化到 floater-position.json，重启后恢复。
 */
export class FloatingController {
	private win: BrowserWindow | null = null;
	private readonly deps: FloatingControllerDeps;
	private removeAgentStateListener: (() => void) | null = null;
	private state: FloatingBallState;
	private destroyed = false;

	constructor(deps: FloatingControllerDeps) {
		this.deps = deps;
		const settings = deps.settingsStore.get();
		this.state = {
			visible: false,
			alwaysOnTop: settings.floatingBallAlwaysOnTop ?? true,
			snapToEdge: settings.floatingBallSnapToEdge ?? true,
			expandTarget: settings.floatingBallExpandTarget ?? "mini",
			showRunningBadge: settings.floatingBallShowRunningBadge ?? true,
			activeCount: 0,
			runningCount: 0,
			recentTitles: [],
			locale: normalizeMainProcessLocale(settings.language),
		};
	}

	/** 进入悬浮模式：隐藏主窗口，显示悬浮球。 */
	async enter(): Promise<void> {
		if (this.destroyed) return;
		const settings = this.deps.settingsStore.get();
		if (!settings.floatingBallEnabled) return;
		const mainWin = this.deps.getMainWindow();
		if (mainWin && !mainWin.isDestroyed()) {
			mainWin.hide();
		}
		await this.show();
	}

	/** 退出悬浮模式：显示主窗口，关闭悬浮球。 */
	async exit(): Promise<void> {
		this.deps.onShowMainWindow();
		this.hide();
	}

	isActive(): boolean {
		return this.state.visible;
	}

	getState(): FloatingBallState {
		return { ...this.state };
	}

	async show(): Promise<void> {
		if (this.destroyed || this.win) return;
		const settings = this.deps.settingsStore.get();
		getAppLogger()?.info("floating-ball", "show() called", { enabled: settings.floatingBallEnabled, destroyed: this.destroyed, hasWin: !!this.win });
		if (!settings.floatingBallEnabled) return;
		const savedPos = (await loadPos()) ?? this.defaultPos();
		// 显示器拔插、缩放变化或旧版离屏位置都要在建窗前恢复到当前工作区。
		const pos = this.constrainPosition(savedPos.x, savedPos.y, FLOATER_WINDOW_W, FLOATER_WINDOW_H, false);
		const sourcePreloadPath = join(__dirname, "../preload/index.js");
		const preloadPath = await preparePreloadPath(sourcePreloadPath, "floater-preload.js");
		this.win = new BrowserWindow({
			width: FLOATER_WINDOW_W,
			height: FLOATER_WINDOW_H,
			x: pos.x,
			y: pos.y,
			frame: false,
			transparent: true,
			resizable: false,
			skipTaskbar: true,
			alwaysOnTop: settings.floatingBallAlwaysOnTop,
			hasShadow: false,
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
		this.win.setAlwaysOnTop(settings.floatingBallAlwaysOnTop, "screen-saver");
		this.attachDragHandlers(this.win);
		this.win.on("closed", () => {
			this.win = null;
			this.state.visible = false;
		});
		this.win.once("ready-to-show", () => {
			getAppLogger()?.info("floating-ball", "ready-to-show fired");
			this.win?.show();
			this.state.visible = true;
			this.pushState();
		});
		this.win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
			getAppLogger()?.error("floating-ball", "Floater load failed", { errorCode, errorDescription, url: validatedURL });
		});
		this.win.webContents.on("did-finish-load", () => {
			getAppLogger()?.info("floating-ball", "did-finish-load");
		});
		if (is.dev && process.env.ELECTRON_RENDERER_URL) {
			await this.win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/floater.html`);
		} else {
			await this.win.loadFile(join(__dirname, "../renderer/floater.html"));
		}
		this.win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
		this.removeAgentStateListener = this.deps.addAgentStateListener(() => this.refreshAgentState());
		this.refreshAgentState();
	}

	hide(): void {
		if (this.win && !this.win.isDestroyed()) {
			this.win.close();
		}
		this.win = null;
		this.state.visible = false;
		this.removeAgentStateListener?.();
		this.removeAgentStateListener = null;
	}

	destroy(): void {
		this.destroyed = true;
		this.hide();
	}

	/** 设置变更热更（alwaysOnTop/snapToEdge/expandTarget/showRunningBadge）。 */
	onSettingsChanged(): void {
		const settings = this.deps.settingsStore.get();
		this.state.alwaysOnTop = settings.floatingBallAlwaysOnTop;
		this.state.snapToEdge = settings.floatingBallSnapToEdge;
		this.state.expandTarget = settings.floatingBallExpandTarget;
		this.state.showRunningBadge = settings.floatingBallShowRunningBadge ?? true;
		this.state.locale = normalizeMainProcessLocale(settings.language);
		if (this.win && !this.win.isDestroyed()) {
			this.win.setAlwaysOnTop(settings.floatingBallAlwaysOnTop, "screen-saver");
		}
		this.pushState();
	}

	/** 设置页 toggle：enabled 变化时 show/hide 悬浮球，并立即保存设置。 */
	async setEnabled(enabled: boolean): Promise<void> {
		await this.deps.settingsStore.update({ floatingBallEnabled: enabled });
		if (enabled) {
			await this.show();
		} else {
			this.hide();
		}
	}

	/** 设置页切换展开目标。 */
	setExpandTarget(target: "mini" | "compact"): void {
		this.state.expandTarget = target;
		void this.deps.settingsStore.update({ floatingBallExpandTarget: target });
		this.pushState();
	}

	/** 悬浮球点击：按当前 expandTarget 展开对应模式。 */
	handleClick(): void {
		if (this.state.expandTarget === "compact") {
			void this.deps.onExpandCompact();
		} else {
			void this.deps.onExpandMini();
		}
	}

	/** 悬浮球右键菜单。 */
	showContextMenu(): void {
		const expandTarget = this.state.expandTarget;
		const template: MenuItemConstructorOptions[] = [
			{
				label: mainProcessT(this.state.locale, "floater.expandMini"),
				type: "radio",
				checked: expandTarget === "mini",
				click: () => {
					this.state.expandTarget = "mini";
					void this.deps.settingsStore.update({ floatingBallExpandTarget: "mini" });
					this.pushState();
					this.deps.onExpandMini();
				},
			},
			{
				label: mainProcessT(this.state.locale, "floater.expandCompact"),
				type: "radio",
				checked: expandTarget === "compact",
				click: () => {
					this.state.expandTarget = "compact";
					void this.deps.settingsStore.update({ floatingBallExpandTarget: "compact" });
					this.pushState();
					this.deps.onExpandCompact();
				},
			},
			{ type: "separator" },
			{
				label: mainProcessT(this.state.locale, "floater.exitToWorkbench"),
				click: () => void this.exit(),
			},
			{ type: "separator" },
			{
				label: mainProcessT(this.state.locale, "floater.quit"),
				click: () => {
					this.destroy();
					app.quit();
				},
			},
		];
		const menu = Menu.buildFromTemplate(template);
		menu.popup({ window: this.win ?? undefined });
	}

	private refreshAgentState(): void {
		this.state.activeCount = this.deps.getActiveAgentCount();
		this.state.runningCount = this.deps.getRunningAgentCount();
		this.state.recentTitles = this.deps.getRecentRunningTitles().slice(0, 3);
		this.pushState();
	}

	private pushState(): void {
		if (this.win && !this.win.isDestroyed()) {
			this.win.webContents.send(ipcChannels.floatingBallState, this.state);
		}
	}

	private attachDragHandlers(win: BrowserWindow): void {
		let dragOffset: { x: number; y: number } | null = null;
		let dragStart: { x: number; y: number } | null = null;
		let moved = false;
		/** 开始、移动与结束都读 Electron DIP 光标；不能混用渲染层缩放后的 screenX/Y。 */
		const moveFromCursor = () => {
			if (!dragOffset || !dragStart) return;
			const cursor = screen.getCursorScreenPoint();
			if (Math.abs(cursor.x - dragStart.x) > 2 || Math.abs(cursor.y - dragStart.y) > 2) moved = true;
			win.setPosition(Math.round(cursor.x - dragOffset.x), Math.round(cursor.y - dragOffset.y));
		};
		ipcMain.removeHandler(ipcChannels.floatingBallDragStart);
		ipcMain.handle(ipcChannels.floatingBallDragStart, (event) => {
			if (event.sender !== win.webContents || win.isDestroyed()) return;
			const [boundsX, boundsY] = win.getPosition();
			const cursor = screen.getCursorScreenPoint();
			dragOffset = { x: cursor.x - boundsX, y: cursor.y - boundsY };
			dragStart = cursor;
			moved = false;
		});
		// rAF 只负责通知采样时机；坐标以宿主为准，避免 DPI/页面缩放与迟到事件累积漂移。
		ipcMain.removeHandler(ipcChannels.floatingBallDragMove);
		ipcMain.handle(ipcChannels.floatingBallDragMove, (event) => {
			if (event.sender !== win.webContents || win.isDestroyed()) return;
			moveFromCursor();
		});
		ipcMain.removeHandler(ipcChannels.floatingBallDragEnd);
		ipcMain.handle(ipcChannels.floatingBallDragEnd, (event) => {
			if (event.sender !== win.webContents || win.isDestroyed() || !dragOffset) return;
			// mouseup 前最后一帧可能被 renderer 取消，结束时补采样一次。
			moveFromCursor();
			dragOffset = null;
			dragStart = null;
			if (!moved) {
				this.handleClick();
				return;
			}
			const bounds = win.getBounds();
			const snap = this.deps.settingsStore.get().floatingBallSnapToEdge;
			const finalPos = this.constrainPosition(bounds.x, bounds.y, bounds.width, bounds.height, snap);
			win.setPosition(finalPos.x, finalPos.y);
			void savePos(finalPos);
		});
		ipcMain.removeHandler(ipcChannels.floatingBallContextMenu);
		ipcMain.handle(ipcChannels.floatingBallContextMenu, (event) => {
			if (event.sender !== win.webContents) return;
			this.showContextMenu();
		});
	}

	/** 按完整窗口尺寸约束到最近显示器；关闭贴边也保留离屏保护。 */
	private constrainPosition(x: number, y: number, width: number, height: number, snap: boolean): FloaterPos {
		const { workArea } = screen.getDisplayNearestPoint({ x: x + width / 2, y: y + height / 2 });
		const maxX = Math.max(workArea.x, workArea.x + workArea.width - width);
		const maxY = Math.max(workArea.y, workArea.y + workArea.height - height);
		const targetX = snap ? (x + width / 2 < workArea.x + workArea.width / 2 ? workArea.x : maxX) : x;
		return {
			x: Math.round(Math.max(workArea.x, Math.min(targetX, maxX))),
			y: Math.round(Math.max(workArea.y, Math.min(y, maxY))),
		};
	}

	private defaultPos(): FloaterPos {
		const display = screen.getPrimaryDisplay();
		const { workArea } = display;
		return {
			x: workArea.x + workArea.width - FLOATER_WINDOW_W - 24,
			y: workArea.y + Math.floor(workArea.height * 0.4),
		};
	}
}
