import { app, BrowserWindow, Menu } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  DEFAULT_IMAGE_GEN_OUTPUT_FORMAT,
  DEFAULT_IMAGE_GEN_SIZE,
  DEFAULT_IMAGE_GEN_WATERMARK,
  parseImageGenOutputFormat,
  parseImageGenSize,
  parseImageGenWatermark,
} from "../../shared/imageGenParams";
import { createDefaultExternalEditorSettings, DEFAULT_PET_SCALE, type AppSettings } from "../../shared/types";
import { normalizePinnedSessionIds } from "../../shared/pinnedSessions";
import { parseBusySendDelivery } from "../../shared/busySendDelivery";
import { normalizeThemeSchedule } from "../../shared/themeSchedule";
import { getAppLogger } from "../logging/sharedLogger";

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
  themeScheduleLightStart: "07:00",
  themeScheduleDarkStart: "19:00",
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
  sessionTabOpenMode: "preview",
  // 默认开启：标题请求由内置扩展在首轮结束后独立异步执行，不进入主 agent 上下文。
  autoSessionTitle: true,
  // 忙碌时发送默认「插入当前回合」（对齐 pi 历史行为）；dsh 会话此前默认排队，
  // 统一后由本设置项决定，用户可在常用设置→会话中改回。
  busySendDelivery: "steer",
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
  // Ask 提问系统通知默认关闭：与通用通知解耦，避免非聚焦会话每次提问都打扰
  askNotificationEnabled: false,
  // 人文关怀提醒默认开启：用户可在设置中随时关闭
  agentCountReminderEnabled: true,
  showThinking: readPiAgentShowThinking() ?? true,
  // 流式对话设置：默认自动展开中间过程（思考/工具详情随最新轮流式展开）；
  // 新一轮开始默认收起非最新轮（含手动展开的），用户可在设置中关闭。
  expandInterimDuringStream: true,
  collapsePrevRunsOnNewTurn: true,
  showDevTools: false,
  developerDiagnostics: false,
  // 默认关闭 Chromium 沙箱：与历史 Windows no-sandbox 兼容策略一致
  electronChromiumSandbox: false,
  piProxyEnabled: false,
  piProxyUrl: "http://127.0.0.1:7890",
  piProxyBypass: "localhost,127.0.0.1,::1",
  piProxyProviders: [],
  piProxyModels: [],
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
  workspaceContentOpenMode: "split",
  contentMaxWidth: 1800,
  // 内容区宽度默认 80%：轻微留白兼顾阅读舒适（1826px 面板 → 内容 1461px）；
  // 分屏窄栏时由容器查询自动收敛，详见 foundation.css --chat-content-pct。
  chatContentWidthPct: 80,
  maxEditorFileSizeMB: 5,
  externalEditors: createDefaultExternalEditorSettings(),

  // 桌面宠物默认关闭：关闭后应用与现状完全一致，零回归风险
  petEnabled: false,
  petId: "clawd",
  petAlwaysOnTop: true,
  petScale: DEFAULT_PET_SCALE,
  // 巡游默认开启：宠物 idle 时自动沿屏幕底部左右走动，业务态出现即让位
  petPatrolEnabled: true,
  // 巡游碰边后 idle 停顿默认 5 分钟
  petPatrolPauseMin: 5,

  // ── 闲置 agent 内存优化：自动释放长时间闲置的 agent 进程 ──
  // 默认开启；保留最近闲置的 5 个；连续闲置 1 小时（60 分钟）才可释放
  idleAgentAutoRelease: true,
  idleAgentKeepCount: 5,
  idleAgentTimeoutMin: 60,

  favoriteModels: [],

  // ── 扩展管理 ──
  /** 用户手动移除的内置扩展，启动时跳过自动部署 */
  removedBuiltInExtensions: [],
  /** 用户禁用的扩展（scope+source）；非空时 RPC 启动走白名单模式 */
  disabledExtensions: [],
  /** 白名单总开关：true 时不走 -e 注入，默认加载全部扩展（防御启动失败） */
  disableExtensionWhitelist: false,

  // 生图参数：记在 composer 底栏，跨会话复用；缺省不指定分辨率、不带水印
  imageGenSize: DEFAULT_IMAGE_GEN_SIZE,
  imageGenWatermark: DEFAULT_IMAGE_GEN_WATERMARK,
  imageGenOutputFormat: DEFAULT_IMAGE_GEN_OUTPUT_FORMAT,

  // ── 更新检测：检查永远自动；自动下载默认开启（v0.7.4 起取代 disableUpdateCheck）──
  autoDownloadUpdates: true,
  // 更新源：默认 GitHub 官方；国内用户可切镜像前缀代理（见 updateSources.ts）
  updateSource: "github",
  // 自定义镜像前缀（updateSource=custom 时生效），空串 = 未填
  customUpdateSourceUrl: "",

  // ── Agent 后端：默认 pi（经典后端），用户可在设置中切换为 dsh ──
  defaultAgentBackend: "pi",

  // ── DSH 外部会话：默认启动时只读扫磁盘入侧栏（不 boot host）──
  dshAutoImportSessions: true,

  // ── Agent 启动诊断/加速：offline 默认关（保证 pi 启动时模型目录走网络刷新，
  // 用户新增/更新的模型能实时出现在模型列表）；扩展/技能默认加载 ──
  piRpcOffline: false,
  piRpcNoExtensions: false,
  piRpcNoSkills: false,

  // 字体配置：默认使用系统字体；用户可通过自定义字体设置修改。
  // 出厂默认取 "default" 档：与 CSS token 基线（:root 无覆盖时）一致，
  // 避免「默认」档位名与实际出厂外观错位（旧默认 medium 比 default 大一档）。
  fontSize: "default",
  uiFontSize: null,
  chatFontSize: null,
  inputFontSize: null,
  zoomFactor: 1,
  fontFamilyBase: "system",
  fontFamilyBaseCustom: "",
  fontFamilyMono: "system-mono",
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
      // 新增布尔开关按旧 settings.json 的缺省/脏数据回落，避免字符串值让 UI 或 pi env 误判。
      if (typeof this.settings.autoSessionTitle !== "boolean") {
        this.settings.autoSessionTitle = defaultSettings.autoSessionTitle;
      }
      // 兼容迁移：内置 CommitMono 字体已移除（打包瘦身），旧设置里的 "commit-mono"
      // 不再存在于 AppFontMonoMode 枚举，统一回退到系统等宽字体，避免类型漂移。
      // 注意：磁盘 JSON 是无类型的，旧值可能是已删除的枚举项，先拓宽为 string 再比较。
      const persistedMonoFont: string = this.settings.fontFamilyMono;
      if (persistedMonoFont === "commit-mono") {
        this.settings.fontFamilyMono = "system-mono";
      }
      // 忙碌时投递行为来自旧 JSON 时可能是任意值；回落默认，避免发送链路带着坏语义。
      this.settings.busySendDelivery = parseBusySendDelivery(this.settings.busySendDelivery);
      // 兼容迁移：旧版 contentMaxWidth(px) → chatContentWidthPct(%)。
      // 语义从「最大宽度 px」变为「占面板百分比」，无法精确换算（面板宽度可变），
      // 用线性映射保留旧值感觉：800→60%、1400→84%、1800(不限)→100%。
      this.migrateContentWidth();
      // 兼容迁移：按供应商/模型过滤的代理白名单，旧数据缺省为 []（不按名单过滤，保持全局行为）。
      this.normalizePiProxyProviders();
      this.normalizePiProxyModels();
      // 生图尺寸/水印来自旧 JSON 时可能非法；回落默认，避免底栏和下一次请求带着坏值。
      this.settings.imageGenSize =
        parseImageGenSize(this.settings.imageGenSize) ?? DEFAULT_IMAGE_GEN_SIZE;
      this.settings.imageGenWatermark = parseImageGenWatermark(
        this.settings.imageGenWatermark,
        DEFAULT_IMAGE_GEN_WATERMARK,
      );
      this.settings.imageGenOutputFormat =
        parseImageGenOutputFormat(this.settings.imageGenOutputFormat) ?? DEFAULT_IMAGE_GEN_OUTPUT_FORMAT;
      this.settings.theme = this.normalizeThemeMode(this.settings.theme);
      const schedule = normalizeThemeSchedule({
        lightStart: this.settings.themeScheduleLightStart,
        darkStart: this.settings.themeScheduleDarkStart,
      });
      this.settings.themeScheduleLightStart = schedule.lightStart;
      this.settings.themeScheduleDarkStart = schedule.darkStart;
      // 置顶状态只接受稳定、非空的 SessionRecord id；旧设置缺省时自然回落为空。
      this.settings.pinnedSessionIds = normalizePinnedSessionIds(parsed.pinnedSessionIds);
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

  /**
   * 旧版 contentMaxWidth(px) → chatContentWidthPct(%) 迁移：
   * - 新字段已存在（已迁移/用户已设置）→ 不动作；
   * - 否则按旧 px 线性映射到 60–100%（1800=不限→100%，800→60%），写回持久化。
   */
  private migrateContentWidth() {
    const pct = this.settings.chatContentWidthPct;
    if (typeof pct === "number" && Number.isFinite(pct)) return;
    const legacyPx = this.settings.contentMaxWidth;
    let mapped = 100;
    if (typeof legacyPx === "number" && legacyPx > 0 && legacyPx < 1800) {
      // 线性映射：px∈[800,1800) → pct∈[60,100)，其余（≤0 或 ≥1800=不限）→ 100
      mapped = Math.min(100, Math.max(60, Math.round(((legacyPx - 800) / 1000) * 40 + 60)));
    }
    this.settings.chatContentWidthPct = mapped;
    void this.save().catch(() => undefined);
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
    // 按供应商/模型代理白名单变更时做规范化（去重去空白），避免非法值写入磁盘。
    if ("piProxyProviders" in safePatch) {
      safePatch.piProxyProviders = normalizeProxyList(safePatch.piProxyProviders);
    }
    if ("piProxyModels" in safePatch) {
      safePatch.piProxyModels = normalizeProxyList(safePatch.piProxyModels);
    }
    // IPC 入参不可信：自动标题开关只接受布尔值，非法值保持原有设置。
    if ("autoSessionTitle" in safePatch && typeof safePatch.autoSessionTitle !== "boolean") {
      delete safePatch.autoSessionTitle;
    }
    // 更新源 id 归一化（只允许已知枚举，防手改/脏值污染 feed URL）；自定义源地址仅接受字符串。
    if ("updateSource" in safePatch) {
      const candidate = safePatch.updateSource;
      const known =
        typeof candidate === "string" &&
        (candidate === "github" ||
          candidate === "ghfast" ||
          candidate === "ghproxy-net" ||
          candidate === "ghproxy-cxkpro" ||
          candidate === "custom");
      if (known) safePatch.updateSource = candidate;
      else delete safePatch.updateSource;
    }
    if ("customUpdateSourceUrl" in safePatch && typeof safePatch.customUpdateSourceUrl !== "string") {
      delete safePatch.customUpdateSourceUrl;
    }
    // lastUsedModel 只接受 { provider, modelId } 双字符串（渲染层发送时才写，入参不可信）。
    // 值相同（含非法被丢弃后无变更）直接早退：发送每条消息都会调用，避免高频无效写盘与审计刷屏。
    if ("lastUsedModel" in safePatch) {
      const candidate = safePatch.lastUsedModel;
      if (
        candidate &&
        typeof candidate === "object" &&
        typeof candidate.provider === "string" &&
        candidate.provider.length > 0 &&
        typeof candidate.modelId === "string" &&
        candidate.modelId.length > 0
      ) {
        safePatch.lastUsedModel = { provider: candidate.provider, modelId: candidate.modelId };
      } else {
        delete safePatch.lastUsedModel;
      }
      const prev = this.settings.lastUsedModel;
      const next = safePatch.lastUsedModel;
      if (!next || (prev && prev.provider === next.provider && prev.modelId === next.modelId)) {
        return this.get();
      }
    }
    // 忙碌时投递行为来自渲染层，非法值丢掉，避免发送链路带着坏语义。
    if ("busySendDelivery" in safePatch) {
      safePatch.busySendDelivery = parseBusySendDelivery(safePatch.busySendDelivery);
    }
    if ("pinnedSessionIds" in safePatch) {
      safePatch.pinnedSessionIds = normalizePinnedSessionIds(safePatch.pinnedSessionIds);
    }
    // 闲置 agent 释放参数来自渲染层，钳制到合理范围避免非法值（0/负数/超大）写入磁盘
    if ("idleAgentKeepCount" in safePatch) {
      const n = Math.floor(Number(safePatch.idleAgentKeepCount));
      safePatch.idleAgentKeepCount = Number.isFinite(n) ? Math.min(20, Math.max(1, n)) : 5;
    }
    if ("idleAgentTimeoutMin" in safePatch) {
      const n = Math.floor(Number(safePatch.idleAgentTimeoutMin));
      safePatch.idleAgentTimeoutMin = Number.isFinite(n) ? Math.min(24 * 60, Math.max(1, n)) : 60;
    }
    this.settings = { ...this.settings, ...safePatch };
    // 生图字段来自渲染层，非法值丢掉，避免下次请求带坏 size/watermark。
    if ("imageGenSize" in safePatch) {
      this.settings.imageGenSize =
        parseImageGenSize(this.settings.imageGenSize) ?? DEFAULT_IMAGE_GEN_SIZE;
    }
    if ("imageGenWatermark" in safePatch) {
      this.settings.imageGenWatermark = parseImageGenWatermark(
        this.settings.imageGenWatermark,
        DEFAULT_IMAGE_GEN_WATERMARK,
      );
    }
    if ("imageGenOutputFormat" in safePatch) {
      this.settings.imageGenOutputFormat =
        parseImageGenOutputFormat(this.settings.imageGenOutputFormat) ?? DEFAULT_IMAGE_GEN_OUTPUT_FORMAT;
    }
    if ("theme" in safePatch) {
      this.settings.theme = this.normalizeThemeMode(this.settings.theme);
    }
    if (
      "theme" in safePatch
      || "themeScheduleLightStart" in safePatch
      || "themeScheduleDarkStart" in safePatch
    ) {
      const schedule = normalizeThemeSchedule({
        lightStart: this.settings.themeScheduleLightStart,
        darkStart: this.settings.themeScheduleDarkStart,
      });
      this.settings.themeScheduleLightStart = schedule.lightStart;
      this.settings.themeScheduleDarkStart = schedule.darkStart;
    }
    await this.save();
    this.applyMenu();
    // 配置变更审计（统一在此留痕，覆盖 IPC 与 pet/extension/editors 等所有直写路径）：
    // 只记变更的 key 列表，不记值——避免 proxyUrl 等敏感内容落盘；值变更回查用 save 前的内存态
    void getAppLogger()?.info("settings", "Settings updated", { keys: Object.keys(safePatch) });
    return this.get();
  }

  /** 规范化按供应商代理白名单：去重、去空白、过滤非字符串。 */
  private normalizePiProxyProviders() {
    this.settings.piProxyProviders = normalizeProxyList(this.settings.piProxyProviders);
  }

  /** 规范化按模型代理白名单：去重、去空白、过滤非字符串（旧数据缺省为 []）。 */
  private normalizePiProxyModels() {
    this.settings.piProxyModels = normalizeProxyList(this.settings.piProxyModels);
  }

  /** 旧磁盘可能没有 schedule；非法值回落到 system，避免 data-theme 写成未知值。 */
  private normalizeThemeMode(theme: AppSettings["theme"]): AppSettings["theme"] {
    if (theme === "light" || theme === "dark" || theme === "system" || theme === "schedule") {
      return theme;
    }
    return "system";
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

/**
 * 归一化代理白名单（供应商/模型共用）：过滤非字符串、去空白、去重、保留顺序。
 * 非法值（非数组）一律回落空数组，避免坏数据写入磁盘。
 */
function normalizeProxyList(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const dedup = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "string") continue;
    const trimmed = item.trim();
    if (!trimmed) continue;
    dedup.add(trimmed);
  }
  return [...dedup];
}
