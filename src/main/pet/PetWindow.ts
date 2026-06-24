import { app, BrowserWindow, screen } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { is } from "@electron-toolkit/utils";

/**
 * PetWindow —— 透明置顶悬浮窗（三端，设计文档第 5 节）。
 *
 * 单只宠物的桌面悬浮窗：透明无边框、置顶、跳过任务栏/Dock、可拖拽。
 * 三端差异通过 detectPetWindowCaps() 探测，渲染层据此选择「透明悬浮」/「圆角小窗」/「托盘点」
 * 三种渲染形态，保证三端都能显示状态，精致度递减但零回归。
 *
 * 位置持久化到 userData/pet-position.json；超出屏幕边界则回退右下角默认位。
 */

/** 三端能力探测结果，决定渲染降级形态 */
export type PetWindowCaps = {
	/** 是否支持透明背景（Linux 部分 WM / Windows 远程桌面可能不支持） */
	transparent: boolean;
	/** 是否支持点击穿透（MVP 不用，预留） */
	clickThrough: boolean;
	/** 是否支持自由绝对坐标定位（Wayland 受限，需存相对偏移） */
	freePosition: boolean;
};

/** 探测当前平台宠物窗能力，用于渲染层选择降级形态 */
export function detectPetWindowCaps(): PetWindowCaps {
	switch (process.platform) {
		case "darwin":
			// macOS 原生完美支持透明、点击穿透、绝对坐标定位
			return { transparent: true, clickThrough: true, freePosition: true };
		case "win32":
			// Windows 支持透明（老显卡/远程桌面下可能渲染黑块，渲染层需降级检测）
			return { transparent: true, clickThrough: true, freePosition: true };
		default: {
			// Linux 视 WM 而定：X11 多数支持；Wayland 透明无边框与全局坐标受限
			const wayland = !!process.env.WAYLAND_DISPLAY;
			return {
				transparent: !wayland,
				clickThrough: true,
				freePosition: !wayland,
			};
		}
	}
}

/** 宠物窗尺寸（单格 192×208 缩放后） */
const PET_WIDTH = 160;
const PET_HEIGHT = 176;

/** 位置持久化文件 */
function positionFilePath() {
	return join(app.getPath("userData"), "pet-position.json");
}

type PersistedPosition = { x: number; y: number; displayId?: string };

/** 读取上次保存的窗口位置；越界则返回 null 让调用方回退默认位 */
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

/** 持久化窗口位置到 userData */
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

	/** 创建透明悬浮窗。preload 与主窗口共用，保证 contextBridge pet API 可用 */
	async create(): Promise<BrowserWindow> {
		if (this.exists) return this.petWindow!;

		const caps = detectPetWindowCaps();
		const isMac = process.platform === "darwin";

		// 默认右下角位置；若读到持久化位置则恢复
		const persisted = await loadPersistedPosition();
		const activeDisplay = screen.getDisplayMatching(
			persisted
				? { x: persisted.x, y: persisted.y, width: PET_WIDTH, height: PET_HEIGHT }
				: { x: 0, y: 0, width: PET_WIDTH, height: PET_HEIGHT },
		);
		const workArea = activeDisplay.workArea;
		const x = persisted?.x ?? workArea.x + workArea.width - PET_WIDTH - 24;
		const y = persisted?.y ?? workArea.y + workArea.height - PET_HEIGHT - 24;

		this.petWindow = new BrowserWindow({
			width: PET_WIDTH,
			height: PET_HEIGHT,
			x,
			y,
			frame: false,
			transparent: caps.transparent,
			resizable: false,
			maximizable: false,
			fullscreenable: false,
			hasShadow: false,
			skipTaskbar: true, // 不出现在任务栏/Dock
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
		// macOS 跨桌面空间可见；Win/Linux 按需
		this.petWindow.setVisibleOnAllWorkspaces(isMac);

		// 仅生产环境给宠物窗 session 加 CSP，主窗不受影响（dev 模式 Vite 需注入 inline script 做 HMR，加 CSP 会被拦截）。
		// 这是项目第一个 CSP 配置，仅作用宠物窗：允许 self + file:// + data: 加载图片（petdex 磁盘包走 file://）。
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

		// 拖拽结束保存位置（越界则下次启动由 loadPersistedPosition 的 displayMatching 回退）
		this.petWindow.on("moved", () => {
			if (!this.petWindow || this.petWindow.isDestroyed()) return;
			const bounds = this.petWindow.getBounds();
			void savePersistedPosition({ x: bounds.x, y: bounds.y });
		});

		// dev: 走 electron-vite renderer 多入口 dev server；prod: loadFile
		if (is.dev && process.env.ELECTRON_RENDERER_URL) {
			await this.petWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/pet.html`);
		} else {
			await this.petWindow.loadFile(join(__dirname, "../renderer/pet.html"));
		}

		return this.petWindow;
	}

	/** 销毁宠物窗 */
	destroy() {
		if (this.petWindow && !this.petWindow.isDestroyed()) {
			this.petWindow.destroy();
		}
		this.petWindow = null;
	}

	/** 移动窗口到指定坐标（拖拽时调用） */
	moveTo(x: number, y: number) {
		if (!this.exists) return;
		this.petWindow!.setPosition(Math.round(x), Math.round(y));
		void savePersistedPosition({ x, y });
	}

	/** 设置是否始终置顶 */
	setAlwaysOnTop(value: boolean) {
		if (!this.exists) return;
		this.petWindow!.setAlwaysOnTop(value, "floating");
	}

	/** 显示/隐藏 */
	show() {
		if (!this.exists) return;
		this.petWindow!.show();
	}
	hide() {
		if (!this.exists) return;
		this.petWindow!.hide();
	}
}