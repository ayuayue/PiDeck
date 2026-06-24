import { app, BrowserWindow, screen } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";
import type { PetWindowCaps } from "../../shared/types";

/**
 * PetWindow —— 透明置顶悬浮窗（三端，设计文档第 5 节）。
 *
 * 单只宠物的桌面悬浮窗：透明无边框、置顶、跳过任务栏/Dock、可拖拽。
 * macOS 用 type:"panel"（NSPanel）原生支持浮在其他应用的全屏之上（Electron #34388）。
 * 三端差异通过 detectPetWindowCaps() 探测，渲染层据此选择渲染形态。
 *
 * 位置持久化到 userData/pet-position.json；超出屏幕边界则回退右下角默认位。
 */

export function detectPetWindowCaps(): PetWindowCaps {
	switch (process.platform) {
		case "darwin":
			return { transparent: true, clickThrough: true, freePosition: true };
		case "win32":
			return { transparent: true, clickThrough: true, freePosition: true };
		default: {
			const wayland = !!process.env.WAYLAND_DISPLAY;
			return {
				transparent: !wayland,
				clickThrough: true,
				freePosition: !wayland,
			};
		}
	}
}

/** 1x 基准尺寸（petScale=1 时的窗口 CSS 像素），等比缩放后传给 BrowserWindow */
const BASE_WIDTH = 160;
const BASE_HEIGHT = 176;

function positionFilePath() {
	return join(app.getPath("userData"), "pet-position.json");
}

type PersistedPosition = { x: number; y: number; displayId?: string };

async function loadPersistedPosition(): Promise<PersistedPosition | null> {
	try {
		const raw = await readFile(positionFilePath(), "utf8");
		const parsed = JSON.parse(raw) as PersistedPosition;
		if (typeof parsed.x === "number" && typeof parsed.y === "number") return parsed;
		return null;
	} catch {
		return null;
	}
}

async function savePersistedPosition(bounds: { x: number; y: number }) {
	try {
		await mkdir(app.getPath("userData"), { recursive: true });
		await writeFile(positionFilePath(), JSON.stringify(bounds, null, 2), "utf8");
	} catch {
		// 位置保存失败不影响宠物运行
	}
}

export class PetWindow {
	private petWindow: BrowserWindow | null = null;

	get window(): BrowserWindow | null {
		return this.petWindow;
	}

	get exists(): boolean {
		return !!this.petWindow && !this.petWindow.isDestroyed();
	}

	async create(scale = 1): Promise<BrowserWindow> {
		if (this.exists) return this.petWindow!;

		const w = Math.round(BASE_WIDTH * scale);
		const h = Math.round(BASE_HEIGHT * scale);

		const caps = detectPetWindowCaps();
		const isMac = process.platform === "darwin";

		const persisted = await loadPersistedPosition();
		const activeDisplay = screen.getDisplayMatching(
			persisted
				? { x: persisted.x, y: persisted.y, width: w, height: h }
				: { x: 0, y: 0, width: w, height: h },
		);
		const workArea = activeDisplay.workArea;
		const x = persisted?.x ?? workArea.x + workArea.width - w - 24;
		const y = persisted?.y ?? workArea.y + workArea.height - h - 24;

		// macOS：「panel」类型（NSPanel）原生支持浮在其他应用的原生全屏之上（Electron #34388）。
		// 无需手动 setVisibleOnAllWorkspaces / setFullScreenable / app.dock.hide。
		const panelOptions = isMac ? { type: "panel" as const } : {};

		this.petWindow = new BrowserWindow({
			width: w,
			height: h,
			x,
			y,
			...panelOptions,
			frame: false,
			transparent: caps.transparent,
			resizable: false,
			maximizable: false,
			fullscreenable: false,
			hasShadow: false,
			skipTaskbar: true,
			alwaysOnTop: true,
			backgroundColor: "#00000000",
			webPreferences: {
				preload: join(__dirname, "../preload/index.js"),
				// 用独立 partition 的 session，使下方 CSP 仅作用于宠物窗，不污染主窗口共享的默认 session
				partition: "persist:pet",
				sandbox: false,
				contextIsolation: true,
				nodeIntegration: false,
			},
		});

		// 复用现有跨平台置顶层级（index.ts:1232 已验证三端 floating 映射到各系统置顶层级）
		this.petWindow.setAlwaysOnTop(true, "floating");

		// 拖拽结束保存位置
		this.petWindow.on("moved", () => {
			if (!this.petWindow || this.petWindow.isDestroyed()) return;
			const bounds = this.petWindow.getBounds();
			void savePersistedPosition({ x: bounds.x, y: bounds.y });
		});

		// 仅生产环境给宠物窗 session 加 CSP，主窗不受影响（dev 模式 Vite 需注入 inline script 做 HMR，加 CSP 会被拦截）。
		if (!is.dev) {
			this.petWindow.webContents.session.webRequest.onHeadersReceived((details, cb) => {
				cb({
					responseHeaders: {
						...details.responseHeaders,
						"Content-Security-Policy": [
							"default-src 'self'; img-src 'self' file: data:; script-src 'self'; style-src 'self' 'unsafe-inline'",
						],
					},
				});
			});
		}

		if (is.dev && process.env.ELECTRON_RENDERER_URL) {
			await this.petWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/pet.html`);
		} else {
			await this.petWindow.loadFile(join(__dirname, "../renderer/pet.html"));
		}

		// macOS panel 类型：showInactive 不影响其他应用焦点，保持宠物非激活
		if (isMac) {
			this.petWindow.showInactive();
		}

		return this.petWindow;
	}

	destroy() {
		if (this.petWindow && !this.petWindow.isDestroyed()) {
			this.petWindow.destroy();
		}
		this.petWindow = null;
	}

	moveTo(x: number, y: number) {
		if (!this.exists) return;
		this.petWindow!.setPosition(Math.round(x), Math.round(y));
		void savePersistedPosition({ x, y });
	}

	setAlwaysOnTop(value: boolean) {
		if (!this.exists) return;
		this.petWindow!.setAlwaysOnTop(value, "floating");
	}

	/** 缩放宠物窗（不重建，直接 setSize），放缩后检查是否超出屏幕边界 */
	resize(scale: number) {
		if (!this.exists) return;
		const w = Math.round(BASE_WIDTH * scale);
		const h = Math.round(BASE_HEIGHT * scale);
		this.petWindow!.setSize(w, h);
		// 缩放后可能越界，回钳到可见区域
		const [x, y] = this.petWindow!.getPosition();
		const display = screen.getDisplayMatching({ x, y, width: w, height: h });
		const wa = display.workArea;
		this.petWindow!.setPosition(
			Math.min(x, wa.x + wa.width - w - 8),
			Math.min(y, wa.y + wa.height - h - 8),
		);
	}

	show() {
		if (!this.exists) return;
		// macOS panel 类型用 showInactive 避免抢夺焦点
		if (process.platform === "darwin") {
			this.petWindow!.showInactive();
		} else {
			this.petWindow!.show();
		}
	}
	hide() {
		if (!this.exists) return;
		this.petWindow!.hide();
	}
}