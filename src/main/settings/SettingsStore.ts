import { app, BrowserWindow, Menu } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultExternalEditorSettings, type AppSettings } from "../../shared/types";

/** pi agent 的 settings.json 路径（~/.pi/agent/settings.json） */
function piAgentSettingsPath() {
	return join(app.getPath("home"), ".pi", "agent", "settings.json");
}

/**
 * 读取 pi agent 的 settings.json 并从中提取 showThinking（取 hideThinkingBlock 的反值）。
 * pi CLI 的 hideThinkingBlock 语义：true=隐藏思考，false=显示思考。
 * 桌面端 showThinking 语义：true=显示，false=隐藏。
 * 映射：showThinking = !hideThinkingBlock
 * 若 pi agent 文件不存在或 hideThinkingBlock 未设置，返回 undefined。
 */
function readPiAgentShowThinking(): boolean | undefined {
	try {
		const agentRaw = readFileSync(piAgentSettingsPath(), "utf8");
		const agentSettings = JSON.parse(agentRaw) as Record<string, unknown>;
		if (typeof agentSettings.hideThinkingBlock === "boolean") {
			return !agentSettings.hideThinkingBlock;
		}
	} catch {
		// 文件不存在或解析失败，静默忽略
	}
	return undefined;
}

const defaultSettings: AppSettings = {
  useNativeTitleBar: false,
  showNativeMenu: false,
  sendShortcut: "enter-send",
  theme: "system",
  lightBackground: "white",
  language: "system",
  piEnvironmentChecked: false,
  closeToTray: true,
  enableNotifications: true,
  showThinking: readPiAgentShowThinking() ?? true,
  showDevTools: false,
  piProxyEnabled: false,
  piProxyUrl: "http://127.0.0.1:7890",
  piProxyBypass: "localhost,127.0.0.1,::1",
  desktopProxyEnabled: false,
  desktopProxyUrl: "http://127.0.0.1:7890",
  desktopProxyBypass: "localhost,127.0.0.1,::1",
  customPiPath: "",
  telemetryEnabled: true,
  webServiceEnabled: false,
  webServiceHost: "0.0.0.0",
  webServicePort: 8765,
  rpcTimeout: 600_000,
  linkOpenMode: "external",
  contentMaxWidth: 1400,
  maxEditorFileSizeMB: 5,
  externalEditors: createDefaultExternalEditorSettings(),

  // 桌面宠物默认关闭：关闭后应用与现状完全一致，零回归风险
  petEnabled: false,
  petId: "clawd",
  petAlwaysOnTop: true,
  petScale: 0.8,
  // 巡游默认开启：宠物 idle 时自动沿屏幕底部左右走动，业务态出现即让位
  petPatrolEnabled: true,
  // 巡游碰边后 idle 停顿默认 5 分钟
  petPatrolPauseMin: 5,
  favoriteModels: [],
};

export class SettingsStore {
  private readonly filePath = join(app.getPath("userData"), "settings.json");
  private settings: AppSettings = { ...defaultSettings };

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<AppSettings>;
      this.settings = {
        ...defaultSettings,
        ...parsed,
        externalEditors: {
          ...createDefaultExternalEditorSettings(),
          ...(parsed.externalEditors ?? {}),
        },
      };
    } catch {
      this.settings = { ...defaultSettings };
    }
    // showThinking 不再作为可持久化的独立配置项，完全跟随 pi agent 的 hideThinkingBlock。
    // 启动时重新读取以确保每次启动都使用最新值，而非缓存的 defaultSettings。
    const computedShowThinking = readPiAgentShowThinking();
    if (computedShowThinking !== undefined) {
      this.settings.showThinking = computedShowThinking;
    }
    // 每次启动都校准安装类型：Windows 便携版由 electron-builder 注入运行时环境变量,
    // 该信号比旧 settings 更可信,可修正用户从安装版/旧版本迁移后残留的 installed 记录。
    await this.detectAndSaveInstallationType();
    this.applyMenu();
    return this.get();
  }

  get() {
    // showThinking 由 pi agent 的 hideThinkingBlock 动态决定，每次 get() 都重新读取
    const computed = readPiAgentShowThinking();
    if (computed !== undefined) {
      return { ...this.settings, showThinking: computed };
    }
    return { ...this.settings };
  }

  async update(patch: Partial<AppSettings>) {
    // showThinking 完全由 pi agent 的 hideThinkingBlock 控制，不允许通过桌面设置修改
    const { showThinking: _, ...safePatch } = patch;
    this.settings = { ...this.settings, ...safePatch };
    await this.save();
    this.applyMenu();
    return this.get();
  }

  applyMenu() {
    // 菜单属于 Electron 外壳设置，不影响 pi agent；默认隐藏以获得更接近独立工具的观感。
    if (this.settings.showNativeMenu) {
      Menu.setApplicationMenu(null);
    } else {
      Menu.setApplicationMenu(null);
    }
  }

  createWindowOptions() {
    const useNative = this.settings.useNativeTitleBar;
    const isMac = process.platform === "darwin";
    return {
      frame: useNative,
      titleBarStyle: useNative
        ? "default" as const
        : isMac
          ? "hiddenInset" as const
          : "hidden" as const,
      trafficLightPosition: { x: 14, y: 14 },
    };
  }

  notifyTitleBarChange(window: BrowserWindow | null) {
    if (!window || window.isDestroyed()) return;
    // Electron 的 frame 不能运行时无刷新切换；设置页保存后提示用户重启生效。
    window.webContents.send("settings:apply-window", this.get());
  }

  /**
   * 检查 rpcTimeout 是否小于 600 秒（600000ms），若是则自动提升至 600 秒。
   * 在应用启动后异步执行，避免用户配置的过小超时导致 RPC 调用频繁超时。
   */
  async ensureRpcTimeoutMinimum() {
    if (this.settings.rpcTimeout < 600_000) {
      await this.update({ rpcTimeout: 600_000 });
    }
  }

  private async save() {
    await mkdir(app.getPath("userData"), { recursive: true });
    // showThinking 由 pi agent 的 hideThinkingBlock 决定，不持久化到桌面 settings.json
    const { showThinking: _unused, ...persistable } = this.settings;
    await writeFile(this.filePath, JSON.stringify(persistable, null, 2), "utf8");
  }

  /**
   * 检测并保存安装类型。
   * 
   * Windows:
   *   - PORTABLE_EXECUTABLE_DIR 存在 → portable（便携版 .exe）
   *   - 否则 → installed（NSIS 安装版或其他）
   * 
   * macOS/Linux:
   *   - 由于 electron-builder 不为 dmg/AppImage 等设置特殊环境变量，
   *     且解压后的应用无法判断原始分发格式，统一标记为 installed。
   *   - 用户从 ZIP 手动解压的情况无法区分，视为已安装。
   * 
   * Windows 便携版的环境变量是运行时事实,必须允许覆盖旧的持久化值；
   * 否则用户曾经被记录为 installed 后,便携版会一直推荐安装版更新包。
   */
  private async detectAndSaveInstallationType() {
    let installationType: "portable" | "installed";

    // Windows: electron-builder portable 目标会在运行时注入 PORTABLE_EXECUTABLE_DIR。
    if (process.platform === "win32") {
      const isPortable = process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
      installationType = isPortable ? "portable" : "installed";
    } else {
      // macOS 和 Linux: electron-builder 不提供统一环境变量区分原始分发格式。
      installationType = "installed";
    }

    if (this.settings.installationType === installationType) return;

    this.settings.installationType = installationType;
    await this.save();
  }
}
