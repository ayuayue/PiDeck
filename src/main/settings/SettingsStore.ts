import { app, BrowserWindow, Menu } from "electron";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultExternalEditorSettings, type AppSettings } from "../../shared/types";

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
  showThinking: true,
  showDevTools: false,
  piProxyEnabled: false,
  piProxyUrl: "http://127.0.0.1:7890",
  piProxyBypass: "localhost,127.0.0.1,::1",
  desktopProxyEnabled: false,
  desktopProxyUrl: "http://127.0.0.1:7890",
  desktopProxyBypass: "localhost,127.0.0.1,::1",
  customPiPath: "",
  webServiceEnabled: false,
  webServiceHost: "0.0.0.0",
  webServicePort: 8765,
  rpcTimeout: 600_000,
  linkOpenMode: "external",
  contentMaxWidth: 1400,
  maxEditorFileSizeMB: 5,
  externalEditors: createDefaultExternalEditorSettings(),

  // 妗岄潰瀹犵墿榛樿鍏抽棴锛氬叧闂悗搴旂敤涓庣幇鐘跺畬鍏ㄤ竴鑷达紝闆跺洖褰掗闄?
  petEnabled: false,
  petId: "clawd",
  petAlwaysOnTop: true,
  petScale: 0.8,
  // 宸℃父榛樿寮€鍚細瀹犵墿 idle 鏃惰嚜鍔ㄦ部灞忓箷搴曢儴宸﹀彸璧板姩锛屼笟鍔℃€佸嚭鐜板嵆璁╀綅
  petPatrolEnabled: true,
  // 宸℃父纰拌竟鍚?idle 鍋滈】榛樿 5 鍒嗛挓
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
    // 姣忔鍚姩閮芥牎鍑嗗畨瑁呯被鍨嬶細Windows 渚挎惡鐗堢敱 electron-builder 娉ㄥ叆杩愯鏃剁幆澧冨彉閲?
    // 璇ヤ俊鍙锋瘮鏃?settings 鏇村彲淇?鍙慨姝ｇ敤鎴蜂粠瀹夎鐗?鏃х増鏈縼绉诲悗娈嬬暀鐨?installed 璁板綍銆?
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
    // 鑿滃崟灞炰簬 Electron 澶栧３璁剧疆锛屼笉褰卞搷 pi agent锛涢粯璁ら殣钘忎互鑾峰緱鏇存帴杩戠嫭绔嬪伐鍏风殑瑙傛劅銆?
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
    // Electron 鐨?frame 涓嶈兘杩愯鏃舵棤鍒锋柊鍒囨崲锛涜缃〉淇濆瓨鍚庢彁绀虹敤鎴烽噸鍚敓鏁堛€?
    window.webContents.send("settings:apply-window", this.get());
  }

  /**
   * 妫€鏌?rpcTimeout 鏄惁灏忎簬 600 绉掞紙600000ms锛夛紝鑻ユ槸鍒欒嚜鍔ㄦ彁鍗囪嚦 600 绉掋€?
   * 鍦ㄥ簲鐢ㄥ惎鍔ㄥ悗寮傛鎵ц锛岄伩鍏嶇敤鎴烽厤缃殑杩囧皬瓒呮椂瀵艰嚧 RPC 璋冪敤棰戠箒瓒呮椂銆?
   */
  async ensureRpcTimeoutMinimum() {
    if (this.settings.rpcTimeout < 600_000) {
      await this.update({ rpcTimeout: 600_000 });
    }
  }

  private async save() {
    await mkdir(app.getPath("userData"), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.settings, null, 2), "utf8");
  }

  /**
   * 妫€娴嬪苟淇濆瓨瀹夎绫诲瀷銆?
   * 
   * Windows:
   *   - PORTABLE_EXECUTABLE_DIR 瀛樺湪 鈫?portable锛堜究鎼虹増 .exe锛?
   *   - 鍚﹀垯 鈫?installed锛圢SIS 瀹夎鐗堟垨鍏朵粬锛?
   * 
   * macOS/Linux:
   *   - 鐢变簬 electron-builder 涓嶄负 dmg/AppImage 绛夎缃壒娈婄幆澧冨彉閲忥紝
   *     涓旇В鍘嬪悗鐨勫簲鐢ㄦ棤娉曞垽鏂師濮嬪垎鍙戞牸寮忥紝缁熶竴鏍囪涓?installed銆?
   *   - 鐢ㄦ埛浠?ZIP 鎵嬪姩瑙ｅ帇鐨勬儏鍐垫棤娉曞尯鍒嗭紝瑙嗕负宸插畨瑁呫€?
   * 
   * Windows 渚挎惡鐗堢殑鐜鍙橀噺鏄繍琛屾椂浜嬪疄,蹇呴』鍏佽瑕嗙洊鏃х殑鎸佷箙鍖栧€硷紱
   * 鍚﹀垯鐢ㄦ埛鏇剧粡琚褰曚负 installed 鍚?渚挎惡鐗堜細涓€鐩存帹鑽愬畨瑁呯増鏇存柊鍖呫€?
   */
  private async detectAndSaveInstallationType() {
    let installationType: "portable" | "installed";

    // Windows: electron-builder portable 鐩爣浼氬湪杩愯鏃舵敞鍏?PORTABLE_EXECUTABLE_DIR銆?
    if (process.platform === "win32") {
      const isPortable = process.env.PORTABLE_EXECUTABLE_DIR !== undefined;
      installationType = isPortable ? "portable" : "installed";
    } else {
      // macOS 鍜?Linux: electron-builder 涓嶆彁渚涚粺涓€鐜鍙橀噺鍖哄垎鍘熷鍒嗗彂鏍煎紡銆?
      installationType = "installed";
    }

    if (this.settings.installationType === installationType) return;

    this.settings.installationType = installationType;
    await this.save();
  }
}
