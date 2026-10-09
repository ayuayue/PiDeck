import { app, BrowserWindow, screen } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import type { AppFontSizeMode, PetWindowCaps } from "../../shared/types";
import { PET_BASE_H, PET_BASE_W, clampToWorkArea, keepFeetCenter, petLayout, toNormalLayoutPosition, type Size2D } from "../../shared/petNotificationLayout";
import { preparePreloadPath } from "../preloadPath";
import { rendererHeapAdditionalArguments } from "../v8HeapLimits";
import { readElectronChromiumSandboxPreference } from "../settings/SettingsStore";
import { getAppLogger } from "../logging/sharedLogger";
import { PET_WINDOW_PARTITION } from "./petSpriteProtocol";

/** 三端宠物窗能力探测；Linux 只有明确 X11 时启用透明与绝对定位。 */
export function detectPetWindowCaps(): PetWindowCaps {
	if (process.platform === "darwin" || process.platform === "win32") {
		return { transparent: true, clickThrough: true, freePosition: true };
	}
	const ozonePlatform = getOzonePlatform();
	if (ozonePlatform === "x11") {
		return { transparent: true, clickThrough: true, freePosition: true };
	}
	if (ozonePlatform === "wayland") {
		return { transparent: false, clickThrough: true, freePosition: false };
	}
	const sessionType = process.env.XDG_SESSION_TYPE?.trim().toLowerCase();
	const x11 = sessionType === "x11" || (!process.env.WAYLAND_DISPLAY && !!process.env.DISPLAY);
	return { transparent: x11, clickThrough: true, freePosition: x11 };
}

function posPath() {
	return join(app.getPath("userData"), "pet-position.json");
}

function getOzonePlatform() {
	const fromArgv = process.argv.find((arg) => arg.startsWith("--ozone-platform="));
	if (fromArgv) return fromArgv.split("=", 2)[1]?.trim().toLowerCase();
	const fromCommandLine = app.commandLine.getSwitchValue("ozone-platform");
	return fromCommandLine ? fromCommandLine.trim().toLowerCase() : "";
}

function shouldUseDevRendererUrl() {
	return is.dev && !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL);
}

async function loadPos(): Promise<{ x: number; y: number } | null> {
	try {
		const raw = await readFile(posPath(), "utf8");
		const p = JSON.parse(raw);
		return typeof p.x === "number" && typeof p.y === "number" ? p : null;
	} catch {
		return null;
	}
}

async function savePos(bounds: { x: number; y: number }) {
	try {
		await mkdir(app.getPath("userData"), { recursive: true });
		await writeFile(posPath(), JSON.stringify(bounds, null, 2), "utf8");
	} catch {
		/* 保存失败不影响宠物运行 */
	}
}

/**
 * persist:pet partition 上的 CSP 响应头改写是否已注册。
 * Electron webRequest 监听返回 void 且不可移除；开关宠物会重建 PetWindow，
 * 必须只注册一次，否则每次开关都在共享 partition 上累积一份监听（2026-10 泄漏修复）。
 * 该改写在 partition 级生效，与窗口实例无关，注册一次即可。
 */
let petCspHeaderInstalled = false;

/**
 * PetWindow —— 宠物悬浮窗。
 * 窗口几何由 shared/petNotificationLayout 统一推导：普通布局只有精灵区域，
 * 通知可见时扩展出头顶气泡槽位；尺寸切换以「精灵脚底中心」为稳定锚点。
 * pet-position.json 始终保存普通布局坐标，保证旧位置文件语义不变。
 */
export class PetWindow {
	private win: BrowserWindow | null = null;
	/** 宠物窗口的业务目标尺寸；移动时不能信任当前 bounds，避免透明窗拖动后尺寸漂移被继续保留。 */
	private targetSize = { width: PET_BASE_W, height: PET_BASE_H };
	/** 位置持久化防抖：巡游每 50ms 移动一次，避免高频写盘拖慢主进程 */
	private sizeGuardTimer: NodeJS.Timeout | null = null;
	private saveTimer: NodeJS.Timeout | null = null;
	private pendingPos: { x: number; y: number } | null = null;

	private scale = 1;
	private fontMode: AppFontSizeMode = "medium";
	private notificationVisible = false;

	get window(): BrowserWindow | null {
		return this.win;
	}
	get exists(): boolean {
		return !!this.win && !this.win.isDestroyed();
	}

	/** 当前布局（含通知槽位状态） */
	private get layout() {
		return petLayout({ scale: this.scale, fontMode: this.fontMode, notificationVisible: this.notificationVisible });
	}

	async create(scale = 1, fontMode: AppFontSizeMode = "medium") {
		if (this.exists) return this.win!;

		this.scale = Math.max(0.1, scale);
		this.fontMode = fontMode;
		this.notificationVisible = false;
		const layout = this.layout;
		const w = layout.windowW,
			h = layout.windowH;
		this.targetSize = { width: Math.max(w, 1), height: Math.max(h, 1) };
		const caps = detectPetWindowCaps();
		const isMac = process.platform === "darwin";

		const persisted = caps.freePosition ? await loadPos() : null;
		// 若保存位置匹配某个显示器，以该显示器计算落点；否则（多屏热插拔/位置越界）用主显示器
		const display = screen.getDisplayMatching(persisted ? { x: persisted.x, y: persisted.y, width: w, height: h } : { x: 0, y: 0, width: w, height: h });
		const wa = display.workArea;
		// 有保存位置时，钳制到 workArea 内确保窗口完全可见，避免多屏热插拔后宠物落在屏幕外
		const maxX = wa.x + wa.width - w - 8;
		const maxY = wa.y + wa.height - h - 8;
		const rawX = persisted?.x ?? wa.x + wa.width - w - 24;
		const rawY = persisted?.y ?? wa.y + wa.height - h - 24;
		const x = Math.round(Math.min(maxX, Math.max(wa.x, rawX)));
		const y = Math.round(Math.min(maxY, Math.max(wa.y, rawY)));
		const sourcePreloadPath = join(__dirname, "../preload/index.js");
		const preloadPath = await preparePreloadPath(sourcePreloadPath, "pet-preload.js");

		this.win = new BrowserWindow({
			width: w,
			height: h,
			...(caps.freePosition ? { x, y } : {}),
			...(isMac ? { type: "panel" as const } : {}),
			frame: false,
			transparent: caps.transparent,
			resizable: false,
			maximizable: false,
			fullscreenable: false,
			hasShadow: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			backgroundColor: caps.transparent ? "#00000000" : "#eef0f3",
			webPreferences: {
				preload: preloadPath,
				partition: PET_WINDOW_PARTITION,
				// 与主窗口共用开发设置里的 Chromium 沙箱偏好，避免宠物窗单独写死 false。
				sandbox: readElectronChromiumSandboxPreference(),
				contextIsolation: true,
				nodeIntegration: false,
				// 宠物永远浮在桌面、几乎不获焦。默认 backgroundThrottling 会把后台 rAF
				// 掐到约 1fps 甚至停在第一帧，表现为 idle/running 都静止。
				backgroundThrottling: false,
				// 与主窗口同档：不跟吃主进程的 384MB V8 堆上限（#213）
				additionalArguments: rendererHeapAdditionalArguments(),
			},
		});
		this.win.webContents.on("preload-error", (_event, failedPreloadPath, error) => {
			const detail = {
				preloadPath: failedPreloadPath,
				sourcePreloadPath,
				message: error.message,
			};
			// 全透明窗口是宠物「开了没显示」的最隐蔽形态：preload/加载/渲染任意一环失败
			// 都表现为透明窗口，必须全部落日志（2026-08 排查教训：pet 窗口曾是日志盲区）
			console.warn("[PetWindow] preload failed", detail);
			getAppLogger()?.error("pet", "Pet window preload failed", detail);
		});

		// 渲染层诊断：pet.html/资源加载失败、渲染进程崩溃、页面 console 错误，全部进 app 日志
		this.win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL) => {
			getAppLogger()?.error("pet", "Pet window load failed", { errorCode, errorDescription, url: validatedURL });
		});
		this.win.webContents.on("render-process-gone", (_event, details) => {
			getAppLogger()?.error("pet", "Pet renderer process gone", { reason: details.reason, exitCode: details.exitCode });
		});
		this.win.webContents.on("console-message", (event) => {
			if (!["warning", "error"].includes(event.level)) return;
			getAppLogger()?.warn("pet", `Pet renderer ${event.level}: ${event.message}`, {
				line: event.lineNumber,
				sourceId: event.sourceId,
			});
		});
		this.win.webContents.once("did-finish-load", () => {
			getAppLogger()?.info("pet", "Pet window loaded", { url: this.win!.webContents.getURL() });
		});

		this.win.setAlwaysOnTop(true, "floating");
		if (caps.freePosition) {
			// moved 高频触发（巡游每 50ms 一次、拖拽每次 pointermove 一次、reflow 一次），
			// 直接落盘会拖慢主进程、间接放大 tick 抖动。这里防抖 400ms 合并写盘。
			// reflow 的 setBounds 也会触发 moved：保存的是换算回普通布局后的实际位置，语义一致，无需特判。
			this.win.on("moved", () => {
				if (!this.exists) return;
				const b = this.win!.getBounds();
				this.schedulePersistPosition(this.toNormalPos(b));
			});
		}

		if (!is.dev) {
			// 幂等注册：webRequest 监听不可移除，重复 create 会累积（见模块级 petCspHeaderInstalled 注释）
			if (!petCspHeaderInstalled) {
				petCspHeaderInstalled = true;
				this.win.webContents.session.webRequest.onHeadersReceived((details, cb) => {
					cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": ["default-src 'self'; img-src 'self' file: data: pideck-pet:; script-src 'self'; style-src 'self' 'unsafe-inline'"] } });
				});
			}
		}

		const devRendererUrl = shouldUseDevRendererUrl() ? process.env.ELECTRON_RENDERER_URL : undefined;
		const url = devRendererUrl ? `${devRendererUrl}/pet.html` : join(__dirname, "../renderer/pet.html");
		await (devRendererUrl ? this.win.loadURL(url) : this.win.loadFile(url));

		// 绝对定位可用时才校正尺寸；Wayland 的位置和大小由合成器管理。
		if (caps.freePosition) this.startSizeGuard();

		if (isMac) this.win.showInactive();
		return this.win;
	}

	destroy() {
		this.stopSizeGuard();
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		// 销毁前先保存挂起的位置，否则设置页开关后重开可能回到默认位置
		if (this.pendingPos) {
			void savePos(this.pendingPos);
			this.pendingPos = null;
		}
		if (this.win && !this.win.isDestroyed()) this.win.destroy();
		this.win = null;
	}

	/** 把位置交给统一防抖路径持久化：moved 事件与 moveTo 共用。
	 * moveTo 是巡游/拖拽的高频入口（PetPatrol tick 每 50ms 一次），若在这里直接
	 * savePos 落盘，写盘频率会达到 20 次/秒，完全绕过 400ms 防抖。
	 * 只更新 pendingPos + 复用防抖 timer；最后一次位置最迟在防抖窗口或 destroy 时落盘。 */
	private schedulePersistPosition(pos: { x: number; y: number }) {
		this.pendingPos = pos;
		if (this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			if (this.pendingPos) {
				const p = this.pendingPos;
				this.pendingPos = null;
				void savePos(p);
			}
		}, 400);
	}

	/** 把任意布局的窗口 bounds 换算成普通布局左上角（持久化格式） */
	private toNormalPos(b: { x: number; y: number; width: number; height: number }): { x: number; y: number } {
		const normal = petLayout({ scale: this.scale, fontMode: this.fontMode, notificationVisible: false });
		return toNormalLayoutPosition({ x: b.x, y: b.y }, { width: b.width, height: b.height }, { width: normal.windowW, height: normal.windowH });
	}

	/**
	 * 按当前布局状态重算窗口尺寸与位置：保持精灵脚底中心不变，并整体钳制到 workArea。
	 * 自由定位平台用 setBounds；Wayland 等受限平台由合成器管理位置，只 setSize。
	 */
	private reflow() {
		if (!this.exists) return;
		const layout = this.layout;
		this.targetSize = { width: Math.max(layout.windowW, 1), height: Math.max(layout.windowH, 1) };
		if (!detectPetWindowCaps().freePosition) {
			this.win!.setSize(this.targetSize.width, this.targetSize.height);
			return;
		}
		const [x, y] = this.win!.getPosition();
		const [w, h] = this.win!.getSize();
		const next = keepFeetCenter({ x, y, width: w, height: h }, { width: layout.windowW, height: layout.windowH });
		const wa = screen.getDisplayMatching({ x: next.x, y: next.y, width: layout.windowW, height: layout.windowH }).workArea;
		const clamped = clampToWorkArea({ ...next, width: layout.windowW, height: layout.windowH }, wa);
		this.win!.setBounds({ x: clamped.x, y: clamped.y, width: layout.windowW, height: layout.windowH });
	}

	/** 宠物缩放变化（保持脚底锚点） */
	resize(scale: number) {
		if (!this.exists) return;
		const next = Math.max(0.1, scale);
		if (next === this.scale) return;
		this.scale = next;
		this.reflow();
	}

	/** 有效 UI 字号档位变化（气泡槽位高度随字号变化） */
	setFontMode(fontMode: AppFontSizeMode) {
		if (!this.exists || fontMode === this.fontMode) return;
		this.fontMode = fontMode;
		this.reflow();
	}

	/** 提醒可见性变化：进入提醒扩展出头顶气泡槽位，退出恢复普通布局 */
	setNotificationVisible(visible: boolean) {
		if (!this.exists || visible === this.notificationVisible) return;
		this.notificationVisible = visible;
		this.reflow();
	}

	moveTo(x: number, y: number) {
		if (!this.exists || !detectPetWindowCaps().freePosition) return;
		// 透明/无边框窗口在高频移动时，当前 bounds 可能已经被系统拖拽/合成器误放大。
		// 因此移动时永远使用业务目标尺寸，而不是 this.win.getSize() 读到的漂移尺寸。
		this.win!.setBounds({
			x: Math.round(x),
			y: Math.round(y),
			width: this.targetSize.width,
			height: this.targetSize.height,
		});
		// 持久化统一换算为普通布局位置（通知展示期间拖拽不污染位置文件语义），走防抖路径
		const [w, h] = this.win!.getSize();
		this.schedulePersistPosition(this.toNormalPos({ x, y, width: w, height: h }));
	}

	/** 将当前窗口拉回业务目标尺寸，用于拖拽结束后纠正系统合成器造成的尺寸漂移。 */
	ensureTargetSize() {
		if (!this.exists || !detectPetWindowCaps().freePosition) return;
		const [x, y] = this.win!.getPosition();
		this.win!.setBounds({
			x,
			y,
			width: this.targetSize.width,
			height: this.targetSize.height,
		});
	}

	/** 启动定时校正：每 5 秒检查一次窗口尺寸，偏离目标尺寸时强制纠正，
	 *  解决某些平台透明窗口拖拽后尺寸漂移问题。 */
	startSizeGuard() {
		this.stopSizeGuard();
		if (!detectPetWindowCaps().freePosition) return;
		this.sizeGuardTimer = setInterval(() => {
			if (!this.exists) {
				this.stopSizeGuard();
				return;
			}
			const [w, h] = this.win!.getSize();
			if (w !== this.targetSize.width || h !== this.targetSize.height) {
				this.ensureTargetSize();
			}
		}, 5000);
	}

	stopSizeGuard() {
		if (this.sizeGuardTimer) {
			clearInterval(this.sizeGuardTimer);
			this.sizeGuardTimer = null;
		}
	}

	setAlwaysOnTop(v: boolean) {
		if (this.exists) this.win!.setAlwaysOnTop(v, "floating");
	}

	show() {
		if (this.exists) process.platform === "darwin" ? this.win!.showInactive() : this.win!.show();
	}
	hide() {
		if (this.exists) this.win!.hide();
	}
}
