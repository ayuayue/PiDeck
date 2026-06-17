import { app, BrowserWindow, Menu } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings } from "../../shared/types";

const defaultSettings: AppSettings = {
  useNativeTitleBar: false,
  showNativeMenu: false,
  sendShortcut: "enter-send",
  theme: "system",
  language: "system",
  piEnvironmentChecked: false,
  closeToTray: true,
  enableNotifications: true,
  showThinking: true,
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
  maxEditorFileSizeMB: 5,
};

export class SettingsStore {
  private readonly filePath = join(app.getPath("userData"), "settings.json");
  private settings: AppSettings = { ...defaultSettings };

  async load() {
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.settings = { ...defaultSettings, ...(JSON.parse(raw) as Partial<AppSettings>) };
    } catch {
      this.settings = { ...defaultSettings };
    }
    // 检测并保存安装类型（首次启动或未记录时）
    await this.detectAndSaveInstallationType();
    this.applyMenu();
    return this.get();
  }

  get() {
    return { ...this.settings };
  }

  async update(patch: Partial<AppSettings>) {
    this.settings = { ...this.settings, ...patch };
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

  private async save() {
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.settings, null, 2), "utf8");
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
   * 只在首次启动（未记录）时检测，后续保持首次记录，
   * 避免覆盖用户从便携版迁移到安装版后的记录。
   */
  private async detectAndSaveInstallationType() {
    if (this.settings.installationType) {
      // 已有记录，不重复检测
      return;
    }

    let installationType: "portable" | "installed";

    // Windows: 通过 PORTABLE_EXECUTABLE_DIR 判断
    if (process.platform === "win32") {
      const isPortable = process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
      installationType = isPortable ? "portable" : "installed";
    } else {
      // macOS 和 Linux: electron-builder 不提供统一的环境变量来区分分发格式
      // DMG/AppImage/DEB 解压后都是普通应用目录，无法回溯原始格式
      // 统一标记为 installed（已安装/已部署）
      installationType = "installed";
    }

    this.settings.installationType = installationType;
    await this.save();
  }
}
