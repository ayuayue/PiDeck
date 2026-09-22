import { app, BrowserWindow, Menu } from "electron";
import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_IMAGE_GEN_OUTPUT_FORMAT, DEFAULT_IMAGE_GEN_SIZE, DEFAULT_IMAGE_GEN_WATERMARK, parseImageGenOutputFormat, parseImageGenSize, parseImageGenWatermark } from "../../shared/imageGenParams";
import { createDefaultExternalEditorSettings, createDefaultSoundAlertSettings, DEFAULT_PET_SCALE, normalizeSoundAlertSettings, type AppSettings } from "../../shared/types";
import { normalizePinnedSessionIds } from "../../shared/pinnedSessions";
import { parseBusySendDelivery } from "../../shared/busySendDelivery";
import { sanitizeShortcutOverrides } from "../../shared/shortcuts";
import { normalizeThemeSchedule } from "../../shared/themeSchedule";
import { normalizeQuickMessages } from "../../shared/quickMessages";
import { clampSessionTabMaxWidth, SESSION_TAB_MAX_WIDTH_DEFAULT } from "../../shared/sessionTabWidth";
import { getAppLogger } from "../logging/sharedLogger";
import { setConfiguredGitPath } from "../git/gitExecutable";
import { renameWithRetry } from "../utils/fsRetry";

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
	// 全局快捷键覆盖：空对象 = 全部走平台默认（见 shared/shortcuts.ts SHORTCUT_DEFS）
	shortcuts: {},
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
	// 默认关闭：标题请求会额外调用当前 pi 模型并消耗 token，避免用户无感知地产生用量。
	autoSessionTitle: false,
	// 忙碌时发送默认「插入当前回合」（对齐 pi 历史行为）；dsh 会话此前默认排队，
	// 统一后由本设置项决定，用户可在常用设置→会话中改回。
	busySendDelivery: "steer",
	// 快捷消息：**遗留字段**。新版本清单存在 userData/quick-messages.json（QuickMessageStore），
	// 出厂值在随包资源 quick-messages.default.json，不再硬编码。这里保留空数组作为默认值，
	// 旧数据（升级前用户改过的条目）仍会在读取时原样保留，供首次迁移作种子。
	quickMessages: [],
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
	// 空串 = 自动解析（PATH 中的 git → 各平台已知安装位置）；用户可在 Git 设置页显式指定。
	gitExecutablePath: "",
	dshRunnerNodePath: "",
	closeToTray: true,
	// 默认单实例：托盘隐藏后再次点击快捷方式会唤起原窗口，而不是再开一个进程
	singleInstance: true,
	enableNotifications: true,
	// 声音提醒默认开启（完成/异常），等待输入默认关闭（避免提问刷屏）
	soundAlert: createDefaultSoundAlertSettings(),
	// Ask 提问系统通知默认关闭：与通用通知解耦，避免非聚焦会话每次提问都打扰
	askNotificationEnabled: false,
	// 人文关怀提醒默认开启：用户可在设置中随时关闭
	agentCountReminderEnabled: true,
	// 公告通知默认开启：新公告弹 toast 提醒（弹出时机另有忙碌延迟控制）
	announcementNotificationEnabled: true,
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
	webServiceHost: "127.0.0.1",
	webServicePort: 8765,
	rpcTimeout: 600_000,
	linkOpenMode: "external",
	workspaceContentOpenMode: "split",
	contentMaxWidth: 1800,
	// 内容区宽度默认 80%：轻微留白兼顾阅读舒适（1826px 面板 → 内容 1461px）；
	// 分屏窄栏时由容器查询自动收敛，详见 foundation.css --chat-content-pct。
	chatContentWidthPct: 80,
	// 会话 Tab 最大宽度默认 104px：与旧硬编码 max-w-[104px] 一致，迁移零回归。
	sessionTabMaxWidth: SESSION_TAB_MAX_WIDTH_DEFAULT,
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
	// 提供商与模型显示开关默认全显示：隐藏列表为空 = 不隐藏任何提供商/模型
	hiddenProviders: [],
	hiddenModels: [],
	hiddenAuthProviders: [],
	// 供应商卡片自定义顺序：空数组 = 未自定义，按配置原序展示
	providerOrder: [],
	dshProviderOrder: [],

	// ── 扩展管理 ──
	/** 用户手动移除的内置扩展，启动时跳过自动部署 */
	removedBuiltInExtensions: [],
	/** 用户禁用的扩展（scope+source）；非空时 RPC 启动走白名单模式 */
	disabledExtensions: [],
	/** 白名单总开关：true 时不走 -e 注入，默认加载全部扩展（防御启动失败） */
	disableExtensionWhitelist: false,

	// ── 技能管理 ──
	/** 用户禁用的全局技能名（小写 name）；非空时 RPC 启动走 --no-skills + --skill 白名单 */
	disabledSkills: [],

	// ── 提示词模板管理 ──
	/** 用户禁用的全局提示词模板名（小写 name）；非空时 RPC 启动走 --no-prompt-templates + --prompt-template 白名单 */
	disabledPrompts: [],

	// 生图参数：记在 composer 底栏，跨会话复用；缺省不指定分辨率、不带水印
	imageGenSize: DEFAULT_IMAGE_GEN_SIZE,
	imageGenWatermark: DEFAULT_IMAGE_GEN_WATERMARK,
	imageGenOutputFormat: DEFAULT_IMAGE_GEN_OUTPUT_FORMAT,

	// ── 更新检测：检查永远自动；自动下载默认开启（v0.7.4 起取代 disableUpdateCheck）──
	autoDownloadUpdates: true,
	// 更新源：默认国内 AtomGit 源（第一首选）；用户可切 GitHub 官方源（见 updateSources.ts）
	updateSource: "atomgit",
	// 自定义镜像前缀（保留向下兼容字段），空串 = 未填
	customUpdateSourceUrl: "",

	// ── Agent 后端：默认 pi（经典后端），用户可在设置中切换为 dsh ──
	defaultAgentBackend: "pi",

	// ── DSH 外部会话：默认启动时只读扫磁盘入侧栏（不 boot host）──
	dshAutoImportSessions: true,

	// ── DSH host 手动停止：默认 false（按需自动启动）；用户在配置页停止后持久化，
	// 跨重启不再自动 fork（不想用 DSH 的用户不用反复停）──
	dshManualStopped: false,

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

/**
 * updateSource 一次性迁移（v0.7.5 默认源 github → atomgit）：
 *
 * 背景：v0.7.5 把更新源默认值从 "github" 改为 "atomgit"（国内加速源第一首选），
 * 但设置对象是整体持久化的——旧用户 settings.json 里已写死 "github"，
 * spread 合并后仍会盖掉新默认值，永远享受不到 AtomGit 镜像。
 *
 * 规则（一次性，尊重用户后续选择）：
 * - 已迁移过（标记位 true）→ 不再改动，用户显式保存的 "github" 永远生效；
 * - 从未持久化过更新源（旧字段缺省，新装用户）→ 直接用新默认 atomgit，无需迁移；
 * - 持久化过 "github" 且未迁移 → 补迁移为 "atomgit" 并写标记，此后用户改回 github 不再干预。
 *
 * 纯函数直接改传入对象并返回是否发生了迁移：SettingsStore 依赖 electron，
 * node --test 无法直接 import 该模块，抽成纯函数才能做行为级单测。
 */
export function migrateUpdateSourceToAtomgit(settings: { updateSource?: unknown; updateSourceAtomgitMigrated?: unknown }): boolean {
	if (settings.updateSourceAtomgitMigrated === true) return false;
	if (settings.updateSource !== "github") return false;
	settings.updateSource = "atomgit";
	settings.updateSourceAtomgitMigrated = true;
	return true;
}

/** 供应商卡片自定义顺序的落盘上限：只防脏数组无限膨胀，正常配置远低于此值 */
const MAX_PROVIDER_ORDER_ENTRIES = 200;

export class SettingsStore {
	private readonly filePath = desktopSettingsPath();
	private settings: AppSettings = { ...defaultSettings };

	/** 保存串行链：迁移钩子与 IPC 快速连续 update 不得交叉写同一文件（撕裂/乱序）。 */
	private saveChain: Promise<void> = Promise.resolve();

	async load() {
		// 主文件解析失败（撕裂写/外部改坏）时回退上一次原子保存留下的 .bak：
		// 直接重置默认值会静默丢掉用户的全部设置（代理/编辑器/快捷键/置顶等）。
		// .bak 也不可用（全新安装/首次保存前）才用默认值。
		const persisted = await this.readPersistedSettings();
		if (persisted === null) {
			this.settings = { ...defaultSettings };
		} else {
			const parsed = persisted;
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
			// 公告通知开关同理：旧配置缺字段回落 true（默认开启），脏数据（字符串等）也回落。
			if (typeof this.settings.announcementNotificationEnabled !== "boolean") {
				this.settings.announcementNotificationEnabled = defaultSettings.announcementNotificationEnabled;
			}
			// 兼容迁移：内置 CommitMono 字体已移除（打包瘦身），旧设置里的 "commit-mono"
			// 不再存在于 AppFontMonoMode 枚举，统一回退到系统等宽字体，避免类型漂移。
			// 注意：磁盘 JSON 是无类型的，旧值可能是已删除的枚举项，先拓宽为 string 再比较。
			const persistedMonoFont: string = this.settings.fontFamilyMono;
			if (persistedMonoFont === "commit-mono") {
				this.settings.fontFamilyMono = "system-mono";
			}
			// 兼容迁移：更新源默认 github → atomgit（一次性，写标记后尊重用户显式选择）。
			if (migrateUpdateSourceToAtomgit(this.settings)) {
				// 迁移后立即落盘：防止后续任一次保存把未迁移状态写回（与宽度迁移同策略）
				void this.save().catch(() => undefined);
			}
			// 忙碌时投递行为来自旧 JSON 时可能是任意值；回落默认，避免发送链路带着坏语义。
			this.settings.busySendDelivery = parseBusySendDelivery(this.settings.busySendDelivery);
			// 兼容迁移：旧版 contentMaxWidth(px) → chatContentWidthPct(%)。
			// 语义从「最大宽度 px」变为「占面板百分比」，无法精确换算（面板宽度可变），
			// 用线性映射保留旧值感觉：800→60%、1400→84%、1800(不限)→100%。
			this.migrateContentWidth();
			// 会话 Tab 最大宽度：磁盘 JSON 无类型，手工改坏（非数字/超界）时钳回合法区间。
			this.settings.sessionTabMaxWidth = clampSessionTabMaxWidth(this.settings.sessionTabMaxWidth);
			// 兼容迁移：全局用量自动查询开关已删除（改为每个 provider 徽章/弹窗里的开关）。
			this.migrateRemovedUsageAutoQuerySwitch();
			// 兼容迁移：按供应商/模型过滤的代理白名单，旧数据缺省为 []（不按名单过滤，保持全局行为）。
			this.normalizePiProxyProviders();
			this.normalizePiProxyModels();
			// 生图尺寸/水印来自旧 JSON 时可能非法；回落默认，避免底栏和下一次请求带着坏值。
			this.settings.imageGenSize = parseImageGenSize(this.settings.imageGenSize) ?? DEFAULT_IMAGE_GEN_SIZE;
			this.settings.imageGenWatermark = parseImageGenWatermark(this.settings.imageGenWatermark, DEFAULT_IMAGE_GEN_WATERMARK);
			this.settings.imageGenOutputFormat = parseImageGenOutputFormat(this.settings.imageGenOutputFormat) ?? DEFAULT_IMAGE_GEN_OUTPUT_FORMAT;
			this.settings.theme = this.normalizeThemeMode(this.settings.theme);
			const schedule = normalizeThemeSchedule({
				lightStart: this.settings.themeScheduleLightStart,
				darkStart: this.settings.themeScheduleDarkStart,
			});
			this.settings.themeScheduleLightStart = schedule.lightStart;
			this.settings.themeScheduleDarkStart = schedule.darkStart;
			// 置顶状态只接受稳定、非空的 SessionRecord id；旧设置缺省时自然回落为空。
			this.settings.pinnedSessionIds = normalizePinnedSessionIds(parsed.pinnedSessionIds);
			// 声音提醒来自旧 JSON 时可能缺字段/非法；统一归一化（旧数据自动获得默认配置）。
			this.settings.soundAlert = normalizeSoundAlertSettings(parsed.soundAlert);
			// git 可执行文件路径来自旧 JSON 时可能是脏值（非字符串）；回落空串（自动解析），
			// 避免 spawn 拿到非字符串路径把整个 Git 面板打挂。
			this.settings.gitExecutablePath = typeof parsed.gitExecutablePath === "string" ? parsed.gitExecutablePath.trim() : "";
			this.settings.dshRunnerNodePath = typeof parsed.dshRunnerNodePath === "string" ? parsed.dshRunnerNodePath.trim() : "";
			// DSH 手动停止标记来自旧 JSON 时可能是脏值（字符串等）；非布尔一律回落 false，
			// 否则一个 "true" 字符串会让 host 永远起不来，且 UI 开关状态不可信。
			if (typeof this.settings.dshManualStopped !== "boolean") {
				this.settings.dshManualStopped = false;
			}
			// 快捷键覆盖来自旧 settings.json 时可能是脏值（未知 id / 非法 accelerator）；
			// 统一清洗，坏条目回落平台默认，避免主进程匹配读到无效键。
			this.settings.shortcuts = sanitizeShortcutOverrides(parsed.shortcuts, process.platform);
			// 快捷消息来自旧 JSON 时可能是脏值（非数组/含空白与重复项/超长）：统一清洗，
			// 避免把脏值当成迁移种子写进配置文件；缺字段回落空数组（“没有旧数据”），
			// 不要在这里注入出厂清单——出厂清单改由随包资源文件提供。
			this.settings.quickMessages = normalizeQuickMessages(parsed.quickMessages);
		}
		// showThinking 不再作为可持久化的独立配置项，完全跟随 pi agent 的 hideThinkingBlock。
		// 启动时重新读取以确保每次启动都使用最新值，而非缓存的 defaultSettings。
		const computedShowThinking = readPiAgentShowThinking();
		if (computedShowThinking !== undefined) {
			this.settings.showThinking = computedShowThinking;
		}
		// git 可执行文件：每次 load 都把持久化值灌进子进程解析器，
		// 覆盖冷启动、备份恢复等所有 reload 路径（保存路径由 settings:update 同步）。
		setConfiguredGitPath(this.settings.gitExecutablePath);
		// 每次启动都校准安装类型：Windows 便携版由 electron-builder 注入运行时环境变量,
		// 该信号比旧 settings 更可信,可修正用户从安装版/旧版本迁移后残留的 installed 记录。
		await this.detectAndSaveInstallationType();
		this.applyMenu();
		return this.get();
	}

	/**
	 * 读主 settings.json；解析失败（撕裂写/外部改坏）时回退 .bak，两者都不可用返回 null。
	 * 只负责读与解析，不做任何规范化——normalize 逻辑保持在 load() 单一位置。
	 */
	private async readPersistedSettings(): Promise<Partial<AppSettings> | null> {
		try {
			return JSON.parse(await readFile(this.filePath, "utf8")) as Partial<AppSettings>;
		} catch {
			try {
				return JSON.parse(await readFile(`${this.filePath}.bak`, "utf8")) as Partial<AppSettings>;
			} catch {
				return null;
			}
		}
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

	/**
	 * 兼容迁移：全局「自动查询供应商用量」开关已删除。
	 *
	 * 为什么必须删：设置对象是整体持久化的——旧字段留在内存里，下一次任意保存都会把它
	 * 写回磁盘，用户永远看不到它被清掉；而它已不再被任何代码读取。删除后立即落盘一次。
	 * 磁盘 JSON 无类型，旧值先按 unknown 收窄再删。
	 */
	private migrateRemovedUsageAutoQuerySwitch() {
		const legacy = this.settings as unknown as Record<string, unknown>;
		if (!("providerUsageAutoQueryEnabled" in legacy)) return;
		delete legacy.providerUsageAutoQueryEnabled;
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
		// 会话 Tab 最大宽度：非有限数值直接丢弃（保持原设置），合法值钳到 80–400。
		if ("sessionTabMaxWidth" in safePatch) {
			if (typeof safePatch.sessionTabMaxWidth === "number" && Number.isFinite(safePatch.sessionTabMaxWidth)) {
				safePatch.sessionTabMaxWidth = clampSessionTabMaxWidth(safePatch.sessionTabMaxWidth);
			} else {
				delete safePatch.sessionTabMaxWidth;
			}
		}
		// 全局快捷键覆盖来自渲染层，入参不可信：只保留已知 id + 合法 accelerator 的条目。
		if ("shortcuts" in safePatch) {
			safePatch.shortcuts = sanitizeShortcutOverrides(safePatch.shortcuts, process.platform);
		}
		// 快捷消息清单已是遗留字段（渲染层不再发送，清单改走 quickMessages:* IPC + 独立配置文件）：
		// 仍然保留清洗，避免历史渲染层或手工改 settings.json 时把脏值写回去。
		if ("quickMessages" in safePatch) {
			safePatch.quickMessages = normalizeQuickMessages(safePatch.quickMessages);
		}
		// 更新源 id 归一化（只允许已知枚举：atomgit 第一首选，github 官方；其余历史值回退 atomgit）。
		if ("updateSource" in safePatch) {
			const candidate = safePatch.updateSource;
			const known = typeof candidate === "string" && (candidate === "atomgit" || candidate === "github");
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
			if (candidate && typeof candidate === "object" && typeof candidate.provider === "string" && candidate.provider.length > 0 && typeof candidate.modelId === "string" && candidate.modelId.length > 0) {
				safePatch.lastUsedModel = { provider: candidate.provider, modelId: candidate.modelId };
			} else {
				delete safePatch.lastUsedModel;
			}
			const prev = this.settings.lastUsedModel;
			const next = safePatch.lastUsedModel;
			if (!next || (prev && prev.provider === next.provider && prev.modelId === next.modelId)) {
				// 值相同（含非法被丢弃）则从本次 patch 中剔除，避免无意义写盘与审计刷屏；
				// 不能直接 return：同一次 update 可能还携带 recentProviders 等需要落盘的字段。
				delete safePatch.lastUsedModel;
			}
		}
		// recentProviders 只接受字符串数组（最新在前）：去重、去空、截断到 8 个。
		// 与 lastUsedModel 一样在 sendPrompt 接受时写入，入参不可信；旧数据缺省为 []（不排序）。
		// 内容无变化（含非法被清空后为空）从 patch 中剔除：发送每条消息都会调用，避免高频写盘。
		if ("recentProviders" in safePatch) {
			const candidate = safePatch.recentProviders;
			const cleaned: string[] = [];
			const seen = new Set<string>();
			if (Array.isArray(candidate)) {
				for (const item of candidate) {
					if (typeof item === "string" && item.length > 0 && !seen.has(item)) {
						seen.add(item);
						cleaned.push(item);
						if (cleaned.length >= 8) break;
					}
				}
			}
			const prev = this.settings.recentProviders ?? [];
			const unchanged = cleaned.length === prev.length && cleaned.every((item, index) => item === prev[index]);
			if (unchanged) delete safePatch.recentProviders;
			else safePatch.recentProviders = cleaned;
		}
		// 供应商卡片顺序来自渲染层拖拽/上移下移结果，入参不可信：只接受字符串数组，
		// 去重、去空、按上限截断。内容无变化时从 patch 中剔除——拖拽落在原位置、
		// 或上移下移撞到列表边界时都会产生「和当前顺序一致的数组」，没必要写盘与刷审计。
		for (const orderKey of ["providerOrder", "dshProviderOrder"] as const) {
			if (!(orderKey in safePatch)) continue;
			const candidate = safePatch[orderKey];
			const cleaned: string[] = [];
			const seen = new Set<string>();
			if (Array.isArray(candidate)) {
				for (const item of candidate) {
					if (typeof item === "string" && item.length > 0 && !seen.has(item)) {
						seen.add(item);
						cleaned.push(item);
						if (cleaned.length >= MAX_PROVIDER_ORDER_ENTRIES) break;
					}
				}
			}
			const prev = this.settings[orderKey] ?? [];
			const unchanged = cleaned.length === prev.length && cleaned.every((item, index) => item === prev[index]);
			if (unchanged) delete safePatch[orderKey];
			else safePatch[orderKey] = cleaned;
		}
		// 所有字段都被去重剔除后没有可写内容：直接返回，避免空 patch 仍触发一次写盘。
		if (Object.keys(safePatch).length === 0) {
			return this.get();
		}
		// 忙碌时投递行为来自渲染层，非法值丢掉，避免发送链路带着坏语义。
		if ("busySendDelivery" in safePatch) {
			safePatch.busySendDelivery = parseBusySendDelivery(safePatch.busySendDelivery);
		}
		if ("pinnedSessionIds" in safePatch) {
			safePatch.pinnedSessionIds = normalizePinnedSessionIds(safePatch.pinnedSessionIds);
		}
		// 声音提醒来自渲染层，入参不可信：缺字段/非法引用/越界音量一律回落默认。
		if ("soundAlert" in safePatch) {
			safePatch.soundAlert = normalizeSoundAlertSettings(safePatch.soundAlert);
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
		// DSH 手动停止标记来自渲染层，入参不可信：只接受布尔值，非法值不落盘，
		// 避免脏值把 host 永久锁死在「已停止」态。
		if ("dshManualStopped" in safePatch && typeof safePatch.dshManualStopped !== "boolean") {
			delete safePatch.dshManualStopped;
		}
		this.settings = { ...this.settings, ...safePatch };
		// 生图字段来自渲染层，非法值丢掉，避免下次请求带坏 size/watermark。
		if ("imageGenSize" in safePatch) {
			this.settings.imageGenSize = parseImageGenSize(this.settings.imageGenSize) ?? DEFAULT_IMAGE_GEN_SIZE;
		}
		if ("imageGenWatermark" in safePatch) {
			this.settings.imageGenWatermark = parseImageGenWatermark(this.settings.imageGenWatermark, DEFAULT_IMAGE_GEN_WATERMARK);
		}
		if ("imageGenOutputFormat" in safePatch) {
			this.settings.imageGenOutputFormat = parseImageGenOutputFormat(this.settings.imageGenOutputFormat) ?? DEFAULT_IMAGE_GEN_OUTPUT_FORMAT;
		}
		if ("theme" in safePatch) {
			this.settings.theme = this.normalizeThemeMode(this.settings.theme);
		}
		if ("theme" in safePatch || "themeScheduleLightStart" in safePatch || "themeScheduleDarkStart" in safePatch) {
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
			titleBarStyle: useNative ? ("default" as const) : isMac ? ("hiddenInset" as const) : ("hidden" as const),
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

	private save(): Promise<void> {
		// 串行化：把每次写盘接到上一次之后，避免并发 update 的 writeFile 交叉撕裂
		//（迁移钩子的 fire-and-forget save 与 IPC 快速连续 update 会并发触发）。
		const run = this.saveChain.catch(() => undefined).then(() => this.writeAtomic());
		this.saveChain = run;
		return run;
	}

	/**
	 * 原子写 settings.json：写 tmp 后 renameWithRetry 替换（Windows 杀软/索引器
	 * 瞬态 EPERM/EBUSY 退避重试，见 utils/fsRetry）。
	 * 替换前把当前版本复制为 .bak——load() 遇到主文件损坏时优先回退 .bak，
	 * 避免全部用户设置静默回默认。首启无旧文件时复制失败静默忽略（无备份可做）。
	 */
	private async writeAtomic(): Promise<void> {
		await mkdir(app.getPath("userData"), { recursive: true });
		// showThinking 由 pi agent 的 hideThinkingBlock 决定，不持久化到桌面 settings.json
		const { showThinking: _unused, ...persistable } = this.settings;
		const tmpPath = `${this.filePath}.tmp`;
		await writeFile(tmpPath, JSON.stringify(persistable, null, 2), "utf8");
		await copyFile(this.filePath, `${this.filePath}.bak`).catch(() => undefined);
		await renameWithRetry(tmpPath, this.filePath);
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
