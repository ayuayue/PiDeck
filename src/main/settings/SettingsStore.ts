import { app, BrowserWindow, Menu } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createDefaultExternalEditorSettings, type AppSettings } from "../../shared/types";

/** 桌面端 settings.json（userData），与 pi agent settings 分离 */
function desktopSettingsPath() {
	return join(app.getPath("userData"), "settings.json");
}

/** pi agent 的 settings.json 路径（~/.pi/agent/settings.json） */
function piAgentSettingsPath() {
	return join(app.getPath("home"), ".pi", "agent", "settings.json");
}

/** 同步读取桌面 settings.json（app.ready 前可用）。文件缺失时返回空对象。 */
function readDesktopSettingsSync(): Partial<AppSettings> {
	try {
		const raw = readFileSync(desktopSettingsPath(), "utf8");
		return JSON.parse(raw) as Partial<AppSettings>;
	} catch {
		return {};
	}
}

/**
 * 在 app.ready 之前同步读取 Chromium 沙箱偏好。
 * `no-sandbox` 必须在 ready 前 append，否则本进程已无法改 Chromium 启动参数。
 * 缺省 false：保持历史兼容（Windows 安全软件/旧驱动）。
 */
export function readElectronChromiumSandboxPreference(): boolean {
	return readDesktopSettingsSync().electronChromiumSandbox === true;
}

/**
 * 在 app.ready 之前同步读取单实例偏好。
 * 版本级单实例锁必须在 ready 前申请（见 main/singleInstance.ts）。
 * 缺省 true：同一版本再次打开时复用窗口；不同版本始终可并行。
 */
export function readSingleInstancePreference(): boolean {
	const value = readDesktopSettingsSync().singleInstance;
	// 未配置时默认开启单实例；只有显式 false 才允许同版本多开。
	return value !== false;
}

/**
 * 在 app.ready 之前同步读取桌面宠物开关（启动时快照）。
 * Linux 的 XWayland 兼容层（见 main/linuxDisplayBackend.ts，#108）必须在 ready 前
 * 决定是否强制 ozone-platform=x11，而宠物是该兼容层的唯一受益者，故以此为准。
 * 缺省 false：未启用宠物的 Linux 用户走原生显示后端，主窗口不受兼容层影响。
 */
export function readPetEnabledPreference(): boolean {
	return readDesktopSettingsSync().petEnabled === true;
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
  accent: "default",
	themeSkin: "classic-green",
	customThemeOverrides: {},
	backgroundImage: "",
	backgroundImageOpacity: 0.8,
  language: "system",
  // 默认最大化：与历史 createWindow 在 ready-to-show 后 maximize() 的行为一致
  // （1480×960 只是最大化前的兜底尺寸，不是最终展示态）
  startupWindowMode: "last",
  piEnvironmentChecked: false,
  enableGitManagement: true,
  gitCommitMessagePrompt: `请根据以下 git diff 生成一条中文 git commit message。

变更描述：
{diff}

Gitmoji 对应关系：
✨ feat - 新功能
🐛 fix - Bug 修复
📚 docs - 文档更新
💎 style - 代码格式
♻️ refactor - 重构
🧪 test - 测试
🔧 chore - 构建/工具

要求：
1. 使用对应的 Gitmoji 开头
2. 第一行简要说明修改的模块和做了什么
3. 后续用 - 列出具体变更点
4. 直接输出 commit 消息，不要解释`,
  // 默认不指定模型，避免升级后在用户尚未配置 provider 时隐式调用错误模型。
  gitCommitMessageProvider: "",
  gitCommitMessageModel: "",
  closeToTray: true,
  // 默认单实例：托盘隐藏后再次点击快捷方式会唤起原窗口，而不是再开一个进程
  singleInstance: true,
  enableNotifications: true,
  showThinking: readPiAgentShowThinking() ?? true,
  showDevTools: false,
  // 默认关闭 Chromium 沙箱：与历史 Windows no-sandbox 兼容策略一致
  electronChromiumSandbox: false,
  piProxyEnabled: false,
  piProxyUrl: "http://127.0.0.1:7890",
  piProxyBypass: "localhost,127.0.0.1,::1",
  desktopProxyEnabled: false,
  desktopProxyUrl: "http://127.0.0.1:7890",
  desktopProxyBypass: "localhost,127.0.0.1,::1",
  customPiPath: "",
  wslEnabled: false,
  wslDistro: "Ubuntu",
  wslUser: "root",
  telemetryEnabled: true,
  webServiceEnabled: false,
  webServiceHost: "0.0.0.0",
  webServicePort: 8765,
  rpcTimeout: 600_000,
  linkOpenMode: "external",
  contentMaxWidth: 1800,
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

  // ── 扩展管理 ──
  /** 用户手动移除的内置扩展，启动时跳过自动部署 */
  removedBuiltInExtensions: [],

  // ── 更新检测：默认正常检测，用户可手动关闭忽略更新 ──
  disableUpdateCheck: false,

  // ── Agent 启动诊断/加速：offline 默认开；扩展/技能默认加载 ──
  piRpcOffline: true,
  piRpcNoExtensions: false,
  piRpcNoSkills: false,

  // ── 实验性渲染（#115）：Streamdown 已转正为唯一 markdown 引擎（迁移自 react-markdown） ──
  useWebContentsViewBrowser: false,

  // 字体配置：默认使用系统字体；霞鹜文楷作为可选字体保留。
  fontSize: "medium",
  uiFontSize: null,
  chatFontSize: null,
  inputFontSize: null,
  zoomFactor: 1,
  fontFamilyBase: "system",
  fontFamilyBaseCustom: "",
  fontFamilyMono: "commit-mono",
  fontFamilyMonoCustom: "",
};

export class SettingsStore {
  private readonly filePath = desktopSettingsPath();
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
    Menu.setApplicationMenu(null);
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
      // 系统标题栏模式下红绿灯由 macOS 控制，不设置避免与侧栏 logo 重叠。
      ...(!useNative && isMac ? { trafficLightPosition: { x: 14, y: 14 } as const } : {}),
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
