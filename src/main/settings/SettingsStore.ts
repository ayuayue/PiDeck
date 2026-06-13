import { app, BrowserWindow, Menu } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppSettings } from "../../shared/types";

const defaultSettings: AppSettings = {
  useNativeTitleBar: true,
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
    return {
      frame: useNative,
      titleBarStyle: useNative ? "default" as const : "hidden" as const,
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
}
