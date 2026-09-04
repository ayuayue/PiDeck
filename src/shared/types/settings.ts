import type { AgentBackend } from "./agent";
import type { BusySendDelivery } from "../busySendDelivery";
import type { ExternalEditorSettings } from "./project";
import type { SecurityConfig } from "./security";

export type SendShortcutMode =
	| "enter-send"
	| "ctrl-enter-send"
	| "shift-enter-send";

export type AppThemeMode = "system" | "light" | "dark" | "schedule";
/** 主题色预设：data-accent 属性驱动 foundation.css 的 accent/logo 变量 */
export type AppAccentMode = "default" | "green" | "blue" | "purple" | "amber" | "rose";
/**
 * 外观主题（皮肤）：覆盖表面/边框/文字色板 + 自带推荐主色，明暗自适应。
 * 内置主题在 themePresets.ts SKIN_PRESETS 定义；custom 由 customThemeOverrides 驱动。
 * classic-green 为出厂默认（中性黑白灰）；fresh-green 为全屏绿色主题（表面带绿色调）。
 */
export type AppSkinId =
	| "classic-green"
	| "fresh-green"
	| "graphite"
	| "sea-blue"
	| "warm-beige"
	| "custom";
export type AppLanguageMode = "system" | "zh-CN" | "en-US" | "pseudo";
export type LinkOpenMode = "external" | "internal";

/** 主进程枚举出的可用于手机访问 Web 服务的局域网入口。 */
export type WebNetworkAddress = {
	address: string;
	interfaceName: string;
	cidr: string | null;
	isPrivate: boolean;
};
/** 文件/Git Diff 在中间栏的默认打开方式：分屏与会话并排，或占满中间栏 */
export type WorkspaceContentOpenMode = "split" | "maximize";
/** 会话 Tab 打开模式：preview=单击为临时预览（发消息后自动晋升常驻），permanent=单击即常驻共存 */
export type SessionTabOpenMode = "preview" | "permanent";
export type AppFontSizeMode = "compact" | "default" | "medium" | "large" | "xlarge";

/** 宠物缩放默认值：0.3 = 设置滑块 30%。出厂 100% 太大，新用户/缺省回退都用此值。 */
export const DEFAULT_PET_SCALE = 0.3;
export type AppFontBaseMode = "system" | "sans" | "serif" | "custom";
export type AppFontMonoMode = "system-mono" | "custom";
/** 主窗口启动尺寸预设：last=上次关闭时的窗口大小（读不到时顺延默认）；fullscreen 占满屏幕，maximized 最大化，其余为固定窗口 */
export type StartupWindowMode =
	| "last"
	| "fullscreen"
	| "maximized"
	| "normal-large"
	| "normal-medium"
	| "normal-compact";

	/**
 * 一条扩展禁用记录：作用域区分 user/project 同名 source 的独立状态。
 * scope 与 PiExtensionSummary.scope 对齐（user=全局 pi，project=项目 .pi）。
 */
export type DisabledExtensionEntry = {
	scope: "user" | "project" | "unknown";
	source: string;
};

export type AppSettings = {
	useNativeTitleBar: boolean;
	showNativeMenu: boolean;
	sendShortcut: SendShortcutMode;
	/** 界面主题：system 跟随系统；schedule 按本地时钟在浅色/暗色之间切换 */
	theme: AppThemeMode;
	/** 跟随时间：浅色开始（HH:mm，含）。仅 theme=schedule 时生效。 */
	themeScheduleLightStart: string;
	/** 跟随时间：暗色开始（HH:mm，含）。仅 theme=schedule 时生效。 */
	themeScheduleDarkStart: string;
	/** 主题色（accent）预设，data-accent 驱动；新增预设只需扩充 AppAccentMode 与色板 */
	accent: AppAccentMode;
	/** 皮肤（换肤）：内置预设见 themePresets.ts SKIN_PRESETS；custom 走 customThemeOverrides */
	themeSkin: AppSkinId;
	/** 自定义主题：CSS 变量名 → 值（键不含 -- 前缀），叠加在内置皮肤之上 */
	customThemeOverrides: Record<string, string>;
	/** 背景图文件名（userData/backgrounds/ 目录下），空串=不启用 */
	backgroundImage: string;
	/** 背景图可见度 0-1：0=背景色完全遮住图片，1=图片全显；面板/弹层会按语义分档透出 */
	backgroundImageOpacity: number;
	/** 界面语言，system 跟随系统语言；pseudo 用于长文案布局压力测试 */
	language: AppLanguageMode;
	/** 启动时主窗口尺寸预设，默认 last（上次窗口大小，读不到时顺延 maximized） */
	startupWindowMode: StartupWindowMode;
	piEnvironmentChecked: boolean;
	/** 最近一次 pi 环境检测成功的结果缓存（命令路径 + 版本），打开设置直接显示，不重复检测 */
	piInstall?: { command: string; version: string };
	/** 会话 Tab 打开模式：preview=单击为临时预览（发消息后自动晋升常驻），permanent=单击即常驻共存 */
	sessionTabOpenMode: SessionTabOpenMode;
	/**
	 * 是否在首轮 agent 成功结束后，用当前 pi 模型异步生成会话标题。
	 * 默认开启；设置只在新建或重启 Agent 进程时注入，关闭不影响已有会话的主 agent。
	 */
	autoSessionTitle: boolean;
	/**
	 * Agent 忙碌时发送消息的默认投递行为。
	 * "steer"=插入当前回合（模型在本次回合内尽快看到）；"followUp"=排队，当前回合结束后自动发送。
	 * 仅决定渲染层入队后的默认投递语义；pi/dsh 主进程各自映射到 wire 协议
	 * （pi streamingBehavior / DSH sessions.prompt mode）。缺省 "steer"，解析见 shared/busySendDelivery.ts。
	 */
	busySendDelivery: BusySendDelivery;
	/** 是否启用会话右侧的 Git 源代码管理入口与面板，默认开启以保持升级前行为。 */
	enableGitManagement: boolean;
	/** Git 提交摘要生成提示词模板，{diff} 会被替换为实际 diff 内容 */
	gitCommitMessagePrompt: string;
	/** Git 提交摘要使用的 pi provider；为空时生成前提示用户配置 */
	gitCommitMessageProvider: string;
	/** Git 提交摘要使用的模型 ID；为空时生成前提示用户配置 */
	gitCommitMessageModel: string;
	/** 关闭窗口时隐藏到系统托盘而不是退出 */
	closeToTray: boolean;
	/**
	 * 单实例模式：再次打开应用时复用已有窗口（托盘隐藏也会唤起）。
	 * 默认 true；关闭后允许同时跑多个 PiDeck 进程。
	 */
	singleInstance: boolean;
	/** 会话结束时发送系统通知 */
	enableNotifications: boolean;
	/**
	 * 非聚焦会话收到 Ask 提问（select/confirm/input/editor/batch_ask）时发送系统通知。
	 * 默认关闭：与通用 enableNotifications 解耦，用户可单独控制提问提醒，避免打扰。
	 */
	askNotificationEnabled: boolean;
	/** 激活 Agent 数量提醒（人文关怀）：激活数达到阈值时，启动时提示关闭空闲会话释放内存。默认开启。 */
	agentCountReminderEnabled: boolean;
	/** 是否在会话中显示模型思考过程，默认开启 */
	showThinking: boolean;
	/**
	 * 流式对话时是否自动展开中间过程（思考/工具详情）。
	 * false（默认）：对话过程中保持折叠（历史轮与最新轮都不自动撑开），手动展开的仍可查看；
	 * true：最新轮流式输出时自动展开。手动开合状态始终优先于本设置。
	 */
	expandInterimDuringStream: boolean;
	/**
	 * 新一轮（用户发送新消息）开始时自动收起上一轮展开的中间过程，节省渲染资源。
	 * true（默认）：发送新消息后收起所有非最新轮（含手动展开的）；false：保持现状。
	 */
	collapsePrevRunsOnNewTurn: boolean;
	/** 是否开启开发者控制台（DevTools） */
	showDevTools: boolean;
	/**
	 * 开发诊断：内存 CSV、事件循环延迟、关键路径耗时。
	 * 默认 false（生产零开销）；打开后写入 userData/diagnostics/，设置页可看快照。
	 * 用来追查「点开会话整窗卡死」这类主进程阻塞，不必改环境变量重启。
	 */
	developerDiagnostics: boolean;
	/**
	 * Electron Chromium 渲染进程沙箱（与 pi Agent 无关）。
	 * false（默认）：关闭沙箱，兼容 Windows 安全软件/旧 GPU 驱动；
	 * true：启用 Chromium 沙箱，需重启 PiDeck 后生效。
	 */
	electronChromiumSandbox: boolean;
	/** 是否给 pi agent 子进程注入代理环境变量，不影响 desktop 自身网络请求 */
	piProxyEnabled: boolean;
	/** pi agent 使用的代理地址，例如 http://127.0.0.1:7890 */
	piProxyUrl: string;
	/** pi agent 代理绕过列表，对应 NO_PROXY 环境变量 */
	piProxyBypass: string;
	/**
	 * @deprecated 旧版「按供应商走代理」白名单（2026-03 被 piProxyModels 模型级白名单取代，
	 * 设置 UI 已移除供应商选项）。字段保留并以供应商名单兜底读取：升级前已配置的旧数据仍生效，
	 * 避免行为突变（见 sessionProxyPolicy 的 resolveListedProxyMode）。供应商名与 models.json 的 provider key 一致。
	 */
	piProxyProviders: string[];
	/**
	 * 按模型过滤的 pi 代理白名单（比 piProxyProviders 更细的粒度）：非空时仅名单内模型强制走代理
	 * （复用 piProxyUrl），名单外强制直连；空数组 = 不按模型过滤（回落供应商名单 / 全局设置）。
	 * 条目格式为 `provider/modelId`（如 "openai/gpt-4o"），与会话记录 model.provider + model.modelId 拼接一致，
	 * 避免不同 provider 下同名模型互相误伤；新建会话首条请求即按模型自动匹配代理，无需先激活再手动切。
	 */
	piProxyModels: string[];
	/** 是否给桌面端自身网络请求启用代理，不影响已启动的 pi agent 子进程 */
	desktopProxyEnabled: boolean;
	/** 桌面端自身网络请求使用的代理地址，例如 http://127.0.0.1:7890 */
	desktopProxyUrl: string;
	/** 桌面端代理绕过列表，对应 Electron proxyBypassRules */
	desktopProxyBypass: string;
	/** 用户手动指定的 pi CLI 命令路径，自动检测不到时用于兜底 */
	customPiPath: string;

	/** 是否发送匿名、低频、最小字段的使用统计 */
	telemetryEnabled: boolean;
	/** 是否开启局域网 Web 服务 */
	webServiceEnabled: boolean;
	/** Web 服务监听地址，默认 0.0.0.0 允许局域网访问 */
	webServiceHost: string;
	/** Web 服务监听端口 */
	webServicePort: number;
	/** 本地生成的匿名安装标识，不包含账号、路径或机器名 */
	telemetryInstallId?: string;
	/** 最近一次发送 app_heartbeat 的本地日期，格式 YYYY-MM-DD */
	telemetryLastHeartbeatDate?: string;
	/** 应用安装类型：portable（便携版）或 installed（安装版），启动时自动检测并持久化 */
	installationType?: "portable" | "installed";
	/** RPC 调用超时时间（毫秒），默认 600000（10 分钟），用于长时间运行的命令 */
	rpcTimeout: number;
	/** 外部链接打开方式：external 使用系统默认浏览器，internal 使用应用内独立窗口 */
	linkOpenMode: LinkOpenMode;
	/**
	 * 从文件树 / Git 打开文件或 Diff 时，中间栏默认布局。
	 * split=与会话分屏；maximize=占满中间栏（会话暂时收起，不进侧栏）。
	 */
	workspaceContentOpenMode: WorkspaceContentOpenMode;
	/**
	 * 内容区最大宽度（px），0 表示不限制（填满 chat-pane）。用于限制消息行宽，左右留白。
	 * @deprecated 由 chatContentWidthPct 取代：保留字段以兼容旧 settings.json，新代码不再读取。
	 */
	contentMaxWidth: number;
	/**
	 * 聊天内容区宽度占聊天面板的百分比（60–100，100=无留白全宽）。
	 * 消息与输入框共享同一留白（--chat-content-pct），分屏窄栏时由容器查询自动收敛到 100%。
	 */
	chatContentWidthPct: number;
	/** 编辑器最大文件大小（MB），超过此大小的文件不加载编辑器。默认 5MB。 */
	maxEditorFileSizeMB: number;
	/** 外部编辑器配置：首次异步检测后保存，用户可在设置中手动覆盖路径。 */
	externalEditors: ExternalEditorSettings;
	/** 是否启用 WSL fallback：在 Windows 自动检测不到 pi 时，尝试从 WSL 启动 pi */
	wslEnabled: boolean;
	/** WSL 发行版名称，如 Debian、Ubuntu */
	wslDistro: string;
	/** WSL 用户名，如 piuser */
	wslUser: string;

	// ── 桌面宠物（全局聚合单宠，默认关闭，不破坏现状） ──
	/** 是否启用桌面宠物悬浮窗，默认 false：关闭后应用与现状完全一致 */
	petEnabled: boolean;
	/** 当前选中的宠物包 id，默认内置水獭 */
	petId: string;
	/** 宠物窗是否始终置顶，默认 true */
	petAlwaysOnTop: boolean;
	/** 宠物缩放比例 0.3-2.0，默认 DEFAULT_PET_SCALE(0.3=30%)，控制窗口与 sprite 渲染尺寸 */
	petScale: number;
	/** 是否启用 idle 巡游（无任务时沿屏幕底部左右走动），默认 true；
	 *  巡游为低优先级 UI 行为，running/failed/review/逗弄 时自动让位。 */
	petPatrolEnabled: boolean;
	/** 巡游碰边后 idle 停顿时长（分钟），默认 5，范围 1–30 */
	petPatrolPauseMin: number;

	// ── 闲置 Agent 内存优化：自动释放长时间闲置的 agent 进程，降低多会话内存占用 ──
	/** 是否自动释放闲置 agent，默认 true：开关关闭后闲置 agent 常驻内存不释放 */
	idleAgentAutoRelease: boolean;
	/** 保留的闲置 agent 数量，默认 5：超出该数量的闲置 agent（且满足闲置时长）按闲置最久优先释放 */
	idleAgentKeepCount: number;
	/** 闲置判定时长（分钟），默认 60：agent 连续闲置超过该时长才可被释放 */
	idleAgentTimeoutMin: number;

	// ── 模型收藏：ModelPicker 中用 ☆ 标记，收藏的模型在列表中置顶 ──
	/** 收藏的模型 ID 列表 */
	favoriteModels: string[];

	// ── 新会话默认模型：记录用户最后一次实际使用的供应商/模型 ──
	/**
	 * 用户最后一次发送消息时使用的模型（主进程在 sendPrompt 接受时自动记录）。
	 * 为「新会话默认」提供 lastUsed 语义——新会话默认 = 上次真正用过的供应商/模型，
	 * 而非固定配置。可选以兼容旧 settings.json；模型被删除后由解析器校验存在性自动回退。
	 */
	lastUsedModel?: { provider: string; modelId: string };

	// ── 字体配置：沿用主题机制实时生效，写入 documentElement token ──
	/** 全局字号基准档位；未单独设置各区域时，所有字号 token 均由此推导 */
	fontSize: AppFontSizeMode;
	/** UI 字号覆盖；null 表示跟随 fontSize。控制 sidebar、按钮、列表、弹窗等 */
	uiFontSize: AppFontSizeMode | null;
	/** 会话正文字号覆盖；null 表示跟随 fontSize。控制用户消息与助手回复 */
	chatFontSize: AppFontSizeMode | null;
	/** 输入框字号覆盖；null 表示跟随 fontSize。控制 composer 输入区 */
	inputFontSize: AppFontSizeMode | null;
	/** 全局窗口缩放比例，1 为 100%；通过 webContents.setZoomFactor 生效 */
	zoomFactor: number;
	/** UI 基础字体预设，默认使用系统字体；system 跟随系统字体栈；custom 时使用 fontFamilyBaseCustom */
	fontFamilyBase: AppFontBaseMode;
	/** fontFamilyBase=custom 时的自定义字体族栈，原样写入 CSS font-family */
	fontFamilyBaseCustom: string;
	/** 等宽字体预设，system-mono 跟随系统等宽字体；custom 时使用 fontFamilyMonoCustom */
	fontFamilyMono: AppFontMonoMode;
	/** fontFamilyMono=custom 时的自定义字体族栈，原样写入 CSS font-family */
	fontFamilyMonoCustom: string;

	// ── 更新检测 ──
	/**
	 * v0.7.4 起检查永远自动（不再提供「禁用版本检测」开关）；
	 * 旧数据中的 disableUpdateCheck 字段被忽略（读取时不再消费）。
	 */
	/**
	 * 是否自动下载新版本（发现新版本后直接后台下载安装包，完成后提示重启安装）。
	 * 默认 true；关闭后仅提示有更新，手动点「立即下载」。
	 */
	autoDownloadUpdates: boolean;
	/** 上次后台检查完成时间（毫秒时间戳）；缺省 = 从未检查。 */
	updateLastCheckAt?: number;
	/** 最近一次“已提示过”的 PiDeck 版本（弹窗关闭后写入，用于“每版本只弹一次”）；缺省 = 未提示过任何版本。 */
	updateNotifiedVersion?: string;
	/** 用户跳过的 PiDeck 版本（该版本不再主动提示，手动检测仍可查看）；缺省 = 未跳过。 */
	updateSkippedVersion?: string;
	/** 最近一次“已提示过”的 Pi CLI 版本；缺省 = 未提示过。 */
	updatePiNotifiedVersion?: string;

	// ── Agent 后端 ──
	/**
	 * 新建会话的默认后端（侧栏「+」/ 引导页 / 并行问询共用）。
	 * "pi" = 经典 pi CLI 后端；"dsh" = DeepSeek Harness 内嵌后端。
	 * 缺省 "pi"（2026-12 兼容期调整：默认回归 pi，用户可在设置中切换为 dsh）。
	 */
	defaultAgentBackend: AgentBackend;

	// ── Agent 启动诊断/加速（开发设置） ──
	/**
	 * 启动 pi RPC 时附加 --offline，跳过 pi 启动期模型目录网络刷新。
	 * 桌面端模型列表来自本地 models.json，默认开启以加快冷启动。
	 */
	piRpcOffline: boolean;
	/**
	 * 启动 pi RPC 时附加 --no-extensions，跳过扩展发现与加载。
	 * 用于排查「坏扩展导致 RPC 起不来」；开启后 todo/plan/ask 等扩展不可用。
	 */
	piRpcNoExtensions: boolean;
	/**
	 * 启动 pi RPC 时附加 --no-skills，跳过 skills 发现与加载。
	 * 用于排查/加速；开启后技能命令与 skill 相关能力不可用。
	 */
	piRpcNoSkills: boolean;

	// ── 侧栏 UI 状态 ──
	/**
	 * 左侧边栏的展开宽度（px）。可选以兼容旧 settings.json；渲染层仍以 localStorage
	 * 作首屏缓存，应用设置作为跨 renderer origin 的可靠恢复来源。
	 */
	sidebarWidth?: number;
	/**
	 * 右侧工作区抽屉的展开宽度（px）。可选以兼容旧 settings.json，取值由渲染层 clamp。
	 */
	drawerWidth?: number;
	/**
	 * 左侧边栏处于展开状态的项目 id 列表（含 builtin-chat）。
	 * 写入 settings.json，避免 dev 模式强杀进程时 localStorage 来不及落盘而丢失。
	 * 缺省时由渲染层按「仅展开 chat」处理。
	 */
	sidebarExpandedProjectIds?: string[];
	/**
	 * 侧栏 活动/聊天/项目分段。可选以兼容旧 settings.json；localStorage 作首屏缓存，
	 * settings.json 作跨 renderer origin / dev 强杀的可靠恢复来源。缺省为 chats。
	 */
	sidebarNavTab?: "active" | "chats" | "projects";
	/**
	 * 侧栏中置顶的会话记录 id。SessionRecord.id 跨重启稳定；缺失或已删除的 id
	 * 在展示时安全忽略，避免修改 pi 会话文件或把短生命周期 agentId 持久化。
	 */
	pinnedSessionIds?: string[];

	// ── 扩展管理 ──
	/**
	 * 用户手动移除（或因三方冲突自动让位）的内置扩展列表（如 pi-deck-todo.ts）。
	 * 下次启动跳过自动部署，并清理用户目录残留文件，避免 pi 仍加载导致工具冲突。
	 */
	removedBuiltInExtensions: string[];

	/**
	 * 用户禁用的扩展列表（source 标识 + 作用域），存储于 PiDeck 自身设置（不写 pi settings）。
	 * pi 0.82.x 不识别 settings.json 的 disabledExtensions，禁用只能靠 PiDeck 启动 RPC 时
	 * 切「白名单模式」：--no-extensions + 逐条 -e 注入未禁用扩展实现（见 enabledExtensionResolver）。
	 * 列表为空 = 白名单关闭，pi 自动发现全部扩展（兼容用户在 PiDeck 外手动安装的扩展）。
	 */
	disabledExtensions: DisabledExtensionEntry[];

	/**
	 * 白名单模式总开关（默认 false = 启用白名单机制）。
	 * true = 不走 -e 注入，pi 按默认方式加载全部扩展（禁用列表暂不生效），
	 * 用于防御个别扩展的 -e 注入 / 白名单枚举导致 RPC 启动失败的情况。
	 */
	disableExtensionWhitelist: boolean;

	// ── 生图模式（composer 底栏记忆，不是独立设置页） ──
	/** 生图尺寸：unset=不发送 size；或 OpenAI WxH / 火山 1K/2K/4K */
	imageGenSize: string;
	/** 生图水印：火山方舟 watermark；默认 false（用户显式打开才带） */
	imageGenWatermark: boolean;
	/** 生图文件编码：火山 output_format png|jpeg；默认 png */
	imageGenOutputFormat: string;

	// ── 安全管理 ──
	/**
	 * 安全管理配置（等级/工具动作/目录边界/会话覆盖）。
	 * 缺省 undefined：由 SecurityStore.normalizeConfig 并入默认值（enabled=true 安全门启用，默认等级 off）。
	 * 变更后主进程会把策略快照写入 userData/security-policy.json 供 pi-deck-security-gate 扩展消费。
	 */
	securityConfig?: SecurityConfig;

	// ── DSH 后端 ──
	/**
	 * DSH_HOME 覆盖目录：用户自己的 DSH 配置目录（如 ~/.dsh）。
	 * 缺省 undefined/空串：自动使用用户真实 ~/.dsh（与 dsh CLI 行为一致，
	 * 配置/凭证/会话全在同一处，不复制）；目录不存在时启动时自动创建。
	 * 实现见 DshHost.resolveDshHomeDir。启动预热前变更会被新 host 读取；
	 * 已运行时切换需重启 host。
	 */
	dshHomeDir?: string;

	/**
	 * DSH runtime 下载源索引地址（覆盖默认 GitHub Release 资产）。
	 * 用于镜像/内网分发：索引是 dsh-runtime-releases.json，条目里给出 tarball 直链与 sha256。
	 * 缺省/空串 = 用内置默认地址。sha256 校验始终生效，镜像也不能绕过。
	 */
	dshRuntimeIndexUrl?: string;

	/**
	 * DSH 审批自动放行：开启后 DSH 会话的工具/命令审批（approval/requested）
	 * 自动应答 allowed-once，不再弹出确认。
	 * 缺省 undefined/false：保持人工审批（会话内 Ask 弹窗）。
	 * 运行时读取（每次审批即时生效），无需重启 DSH host。
	 */
	dshApprovalAutoAllow?: boolean;

	/**
	 * DSH 外部会话自动导入：应用启动后只读扫描 DSH_HOME/sessions，把其他工具
	 * （dsh-web 等）创建的、catalog 尚未映射的根会话写入侧栏（按会话自己的 cwd
	 * 匹配或注册项目；没有 cwd 的才进入「外部会话」兑底项目）。缺省 true。
	 * 不启动 host、不 attach，避免与 dsh-web 抢同一份 DSH_HOME。
	 * 关闭后不再把外部会话写入侧栏（无手动导入入口）。
	 */
	dshAutoImportSessions?: boolean;

};

// ── 桌面宠物类型 ──

/** 宠物聚合动画状态；映射到 spritesheet 的行号。
 *  前 7 个为业务态（由 PetStateBridge 聚合 Agent 状态产出）；
 *  running-right / running-left / review 为本期启用的预留行——
 *  巡游方向帧由 PetPatrol 引擎直接推送，review 由「任务完成」转换触发。 */
export type PetMode =
	| "idle"
	| "running"
	| "failed"
	| "waiting"
	| "waving"
	| "hidden"
	| "jumping"
	| "running-right" // 行1 巡游向右（PetPatrol 驱动）
	| "running-left" // 行2 巡游向左（PetPatrol 驱动）
	| "review"; // 行8 任务完成庆祝（running→idle 转换触发）

/** 多 Agent 聚合后的全局宠物状态，由 PetStateBridge 计算并推送给宠物窗 */
export type PetAggregateState = {
	mode: PetMode;
	/** 当前 running 的 Agent 数 */
	runningCount: number;
	/** 当前 error 的 Agent 数（>0 则 mode=failed，优先级最高） */
	errorCount: number;
	/** 点击宠物跳转目标 Agent id；无活跃 Agent 时为 null */
	activeAgentId: string | null;
	timestamp: number;
};

/** 宠物包清单项，合并内置包与 petdex 社区包后去重得到 */
export type PetManifest = {
	id: string;
	displayName: string;
	description?: string;
	/** 来源：builtin 随应用打包，petdex 扫描自 ~/.codex/pets/ */
	source: "builtin" | "petdex";
	/** 渲染层可加载的 spritesheet URL（pideck-pet:// 协议，主进程按需读文件，非 base64 大字符串） */
	spritesheetUrl: string;
};


/** 三端宠物窗能力探测结果（设计文档第 5.2 节降级形态） */
export type PetWindowCaps = {
	/** 是否支持透明背景（Linux 部分 WM 不支持） */
	transparent: boolean;
	/** 是否支持点击穿透（MVP 不用，预留） */
	clickThrough: boolean;
	/** 是否支持自由绝对坐标定位（Wayland 受限） */
	freePosition: boolean;
};

/** 宠物通知气泡：出错/完成/等待操作时在宠物头顶弹出。
 *  waiting 为持久化提醒（等待用户回应），直到主进程推送 null 才消失；
 *  error/done 由主进程计时 4 秒后推送 null 自动消失。
 *  text 为完整文案（兼容），title/status 供 renderer 分段着色：标题黑色 + 状态词状态色。 */
export type PetNotification = {
	type: "error" | "done" | "waiting";
	text: string;
	/** 关联的 Agent id（waiting/error 必有，done 尽量带） */
	agentId?: string;
	timestamp: number;
	/** true：不自动消失，直到主进程推送 null 清理（等待操作类） */
	persistent?: boolean;
	/** Agent 标题（黑色段）；缺省时 renderer 退化为整行单色绘制 */
	title?: string;
	/** 已翻译的状态词，如「已完成」（状态色段）；缺省时退化为整行单色绘制 */
	status?: string;
};
