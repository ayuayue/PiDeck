import { app, BrowserWindow, screen } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import type { PetWindowCaps } from "../../shared/types";
import { preparePreloadPath } from "../preloadPath";

/** 三端宠物窗能力探测；Wayland 降级 */
export function detectPetWindowCaps(): PetWindowCaps {
	if (process.platform === "darwin" || process.platform === "win32") {
		return { transparent: true, clickThrough: true, freePosition: true };
	}
	const ozonePlatform = getOzonePlatform();
	const wayland = ozonePlatform === "wayland" || (!ozonePlatform && !!process.env.WAYLAND_DISPLAY);
	return { transparent: !wayland, clickThrough: true, freePosition: !wayland };
}

const BASE_W = 160, BASE_H = 176;

function posPath() { return join(app.getPath("userData"), "pet-position.json"); }

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
	} catch { return null; }
}

async function savePos(bounds: { x: number; y: number }) {
	try {
		await mkdir(app.getPath("userData"), { recursive: true });
		await writeFile(posPath(), JSON.stringify(bounds, null, 2), "utf8");
	} catch { /* 保存失败不影响宠物运行 */ }
}

export class PetWindow {
	private win: BrowserWindow | null = null;
	/** 宠物窗口的业务目标尺寸；移动时不能信任当前 bounds，避免透明窗拖动后尺寸漂移被继续保留。 */
	private targetSize = { width: BASE_W, height: BASE_H };
	/** 位置持久化防抖：巡游每 50ms 移动一次，避免高频写盘拖慢主进程 */
	private sizeGuardTimer: NodeJS.Timeout | null = null;
	private saveTimer: NodeJS.Timeout | null = null;
	private pendingPos: { x: number; y: number } | null = null;

	get window(): BrowserWindow | null { return this.win; }
	get exists(): boolean { return !!this.win && !this.win.isDestroyed(); }

	async create(scale = 1) {
		if (this.exists) return this.win!;

		const w = Math.round(BASE_W * scale), h = Math.round(BASE_H * scale);
		this.targetSize = { width: Math.max(w, 1), height: Math.max(h, 1) };
		const caps = detectPetWindowCaps();
		const isMac = process.platform === "darwin";

		const persisted = await loadPos();
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
			width: w, height: h, x, y,
			...(isMac ? { type: "panel" as const } : {}),
			frame: false, transparent: caps.transparent, resizable: false,
			maximizable: false, fullscreenable: false, hasShadow: false,
			skipTaskbar: true, alwaysOnTop: true, backgroundColor: "#00000000",
			webPreferences: {
				preload: preloadPath,
				partition: "persist:pet",
				sandbox: false, contextIsolation: true, nodeIntegration: false,
			},
		});
		this.win.webContents.on("preload-error", (_event, failedPreloadPath, error) => {
			console.warn("[PetWindow] preload failed", {
				preloadPath: failedPreloadPath,
				sourcePreloadPath,
				message: error.message,
				stack: error.stack,
			});
		});

		this.win.setAlwaysOnTop(true, "floating");
		// moved 高频触发（巡游每 50ms 一次、拖拽每次 pointermove 一次），
		// 直接落盘会拖慢主进程、间接放大 tick 抖动。这里防抖 400ms 合并写盘。
		this.win.on("moved", () => {
			if (!this.exists) return;
			const b = this.win!.getBounds();
			this.pendingPos = { x: b.x, y: b.y };
			if (this.saveTimer) return;
			this.saveTimer = setTimeout(() => {
				this.saveTimer = null;
				if (this.pendingPos) { const p = this.pendingPos; this.pendingPos = null; void savePos(p); }
			}, 400);
		});

		if (!is.dev) {
			this.win.webContents.session.webRequest.onHeadersReceived((details, cb) => {
				cb({ responseHeaders: { ...details.responseHeaders, "Content-Security-Policy": ["default-src 'self'; img-src 'self' file: data:; script-src 'self'; style-src 'self' 'unsafe-inline'"] } });
			});
		}

		const devRendererUrl = shouldUseDevRendererUrl()
			? process.env.ELECTRON_RENDERER_URL
			: undefined;
		const url = devRendererUrl ? `${devRendererUrl}/pet.html` : join(__dirname, "../renderer/pet.html");
		await (devRendererUrl ? this.win.loadURL(url) : this.win.loadFile(url));

		// 启动尺寸校正守护（每 5 秒检查），解决透明窗口在部分平台拖拽后尺寸漂移
		this.startSizeGuard();

		if (isMac) this.win.showInactive();
		return this.win;
	}

	destroy() {
		this.stopSizeGuard();
		if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
		// 销毁前先保存挂起的位置，否则设置页开关后重开可能回到默认位置
		if (this.pendingPos) {
			void savePos(this.pendingPos);
			this.pendingPos = null;
		}
		if (this.win && !this.win.isDestroyed()) this.win.destroy();
		this.win = null;
	}

	moveTo(x: number, y: number) {
		if (!this.exists) return;
		// 透明/无边框窗口在高频移动时，当前 bounds 可能已经被系统拖拽/合成器误放大。
		// 因此移动时永远使用业务目标尺寸，而不是 this.win.getSize() 读到的漂移尺寸。
		this.win!.setBounds({
			x: Math.round(x),
			y: Math.round(y),
			width: this.targetSize.width,
			height: this.targetSize.height,
		});
		void savePos({ x, y });
	}

	/** 将当前窗口拉回业务目标尺寸，用于拖拽结束后纠正系统合成器造成的尺寸漂移。 */
	ensureTargetSize() {
		if (!this.exists) return;
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
		this.sizeGuardTimer = setInterval(() => {
			if (!this.exists) { this.stopSizeGuard(); return; }
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

	setAlwaysOnTop(v: boolean) { if (this.exists) this.win!.setAlwaysOnTop(v, "floating"); }

	resize(scale: number) {
		if (!this.exists) return;
		const w = Math.round(BASE_W * scale), h = Math.round(BASE_H * scale);
		this.targetSize = { width: Math.max(w, 1), height: Math.max(h, 1) };
		const [cx, cy] = this.win!.getPosition();
		const wa = screen.getDisplayMatching({ x: cx, y: cy, width: w, height: h }).workArea;
		// 使用 setBounds（含当前位置）替代 setSize，避免缩小尺寸时在 resizable:false 窗口上失效
		this.win!.setBounds({ x: cx, y: cy, width: this.targetSize.width, height: this.targetSize.height });
		// 缩小后需要调整位置，确保窗口不超出屏幕边界
		const nx = Math.min(cx, wa.x + wa.width - w - 8);
		const ny = Math.min(cy, wa.y + wa.height - h - 8);
		if (nx !== cx || ny !== cy) this.moveTo(nx, ny);
	}

	show() { if (this.exists) process.platform === "darwin" ? this.win!.showInactive() : this.win!.show(); }
	hide() { if (this.exists) this.win!.hide(); }
}
