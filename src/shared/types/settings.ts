import type { AgentBackend } from "./agent";
import type { AcpToolConfig } from "./acp";
import type { SessionSortModeId } from "./session";
import type { BusySendDelivery } from "../busySendDelivery";
import { SESSION_TAB_MAX_WIDTH_DEFAULT } from "../sessionTabWidth";
import { createDefaultExternalEditorSettings, type ExternalEditorSettings } from "./project";
import type { SecurityConfig } from "./security";
import type { CustomThemeSnapshot } from "../customThemes";
import { createDefaultSoundAlertSettings, type SoundAlertSettings } from "./soundAlert";

export type SendShortcutMode = "enter-send" | "ctrl-enter-send" | "shift-enter-send";

export type AppThemeMode = "system" | "light" | "dark" | "schedule";
/** 主题色预设：data-accent 属性驱动 foundation.css 的 accent/logo 变量 */
export type AppAccentMode = "default" | "green" | "blue" | "purple" | "amber" | "rose";
/**
 * 外观主题（皮肤）：覆盖表面/边框/文字色板 + 自带推荐主色，明暗自适应。
 * 内置主题在 themePresets.ts SKIN_PRESETS 定义；custom 由 customThemeOverrides 驱动。
 * classic-green 为出厂默认（中性黑白灰）；fresh-green 为全屏绿色主题（表面带绿色调）。
 */
export type AppSkinId = "classic-green" | "fresh-green" | "graphite" | "sea-blue" | "warm-beige" | "custom";
/** Logo 风格：pi-tui = pi 官方 TUI 三色像素标（coral/blue/yellow，默认）；classic = PiDeck 四块拼图 π（显式选择） */
export type LogoStyle = "classic" | "pi-tui";

/** 解析 logo 风格：仅 "classic" 视为显式选择经典；其余（null/undefined/未知旧值）一律回落默认 pi-tui。主进程窗口图标与渲染层 UI 共用。 */
export function resolveLogoStyle(value: string | null | undefined): LogoStyle {
	return value === "classic" ? "classic" : "pi-tui";
}
export type AppLanguageMode = "system" | "zh-CN" | "zh-TW" | "en-US" | "pseudo";

/**
 * 判断语言标签是否属于繁体中文（zh-TW / zh-HK / zh-MO 与 zh-Hant-*）。
 * 主进程与渲染层共用同一份判定：大小写与下划线都要归一，因为「system」模式下拿到的
 * 既可能是 Electron 的 app.getLocale()（zh-TW）也可能是浏览器的 navigator.language（zh-Hant-TW）。
 */
export function isTraditionalChineseLanguageTag(language: string): boolean {
	const normalized = language.trim().replace(/_/g, "-").toLowerCase();
	return normalized.includes("hant") || /^zh-(tw|hk|mo)\b/.test(normalized);
}
export type LinkOpenMode = "external" | "internal";

/** 主进程枚举出的可用于手机访问 Web 服务的局域网入口。 */
export type WebNetworkAddress = {
	address: string;
	interfaceName: string;
	cidr: string | null;
	isPrivate: boolean;
	family: "IPv4" | "IPv6";
};
/** 文件/Git Diff 在中间栏的默认打开方式：分屏与会话并排，或占满中间栏 */
export type WorkspaceContentOpenMode = "split" | "maximize";
/** 会话 Tab 打开模式：preview=单击为临时预览（发消息后自动晋升常驻），permanent=单击即常驻共存 */
export type SessionTabOpenMode = "preview" | "permanent";
export type AppFontSizeMode = "compact" | "medium" | "large" | "xlarge";

/** 更新源：atomgit = 国内 AtomGit 源（默认首选）；github = 官方 GitHub Release。 */
export type UpdateSourceId = "atomgit" | "github";

/** 内置镜像体检状态：ok=检测+下载预检全通；slow=通但实测速度低于阈值；broken=失败/超时/响应异常。 */
export type MirrorHealthStatus = "ok" | "slow" | "broken";

/** 单镜像体检结果（主进程探测，经 IPC 透传给设置页「更新源」展示）。 */
export type MirrorHealthResult = {
	id: UpdateSourceId;
	status: MirrorHealthStatus;
	/** latest.yml 响应耗时（ms）。 */
	latencyMs: number;
	/** Range 分片实测速度（KB/s）；探测失败时为 0。 */
	speedKBps: number;
	/** broken 原因摘要（不含敏感信息）。 */
	error?: string;
	/** 探测完成时间戳（ms）。 */
	checkedAt: number;
};

/** 宠物缩放默认值：0.3 = 设置滑块 30%。出厂 100% 太大，新用户/缺省回退都用此值。 */
export const DEFAULT_PET_SCALE = 0.3;
/** toast 展示时长（ms）出厂值：全局统一时长，与渲染层 notice.ts 常量一致。 */
export const DEFAULT_TOAST_DURATION_MS = 4000;
/**
 * toast 时长「常驻（不自动消失）」哨兵值。
 * 必须用有限数：设置落盘走 settings.json，`JSON.stringify(Infinity)` 会变成 null，
 * 升级后读回即丢失。渲染层在 configureNoticeDefaults 里把哨兵映射回 POSITIVE_INFINITY。
 */
export const TOAST_DURATION_STICKY_MS = -1;
export type AppFontBaseMode = "system" | "sans" | "serif" | "custom";
export type AppFontMonoMode = "system-mono" | "custom";

/** 终端配色主题 id：inherit 是实现概念（跟随应用明暗取 pi-soft 亮/暗版），其余为固定配色 */
export type TerminalThemeId = "inherit" | "solarized-light" | "solarized-dark" | "one-dark" | "monokai";
/** 关闭终端标签的确认策略：never=从不问；running=有前台进程才问；always=总问 */
export type TerminalConfirmCloseMode = "never" | "running" | "always";
/** xterm 光标形状 */
export type TerminalCursorStyle = "block" | "bar" | "underline";
/** 主窗口启动尺寸预设：last=上次关闭时的窗口大小（读不到时顺延默认）；fullscreen 占满屏幕，maximized 最大化，其余为固定窗口 */
export type StartupWindowMode = "last" | "fullscreen" | "maximized" | "normal-large" | "normal-medium" | "normal-compact";

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
	/**
	 * 提示词增强用的模型；null/缺省 = 跟随会话模型（记录 > 引导页 > 部署/主进程默认）。
	 * 非法形态（缺字段/非字符串）在 SettingsStore.update 时归一为 null。
	 */
	enhanceModel?: { provider: string; modelId: string } | null;
	/**
	 * 全局快捷键用户覆盖：ShortcutId → accelerator（Electron 语法子集，见 shared/shortcuts.ts）。
	 * 缺省键 = 平台默认值（macOS ⌘, 打开设置 / F12 开发者工具等）；设置页「快捷键管理」
	 * 修改后写这里，主进程 before-input-event 匹配实时读取（无需重启）。
	 * 可选以兼容旧 settings.json；未知 id / 非法 accelerator 的条目在保存时丢弃。
	 */
	shortcuts?: Record<string, string>;
	/** 界面主题：system 跟随系统；schedule 按本地时钟在浅色/暗色之间切换 */
	theme: AppThemeMode;
	/** 跟随时间：浅色开始（HH:mm，含）。仅 theme=schedule 时生效。 */
	themeScheduleLightStart: string;
	/** 跟随时间：暗色开始（HH:mm，含）。仅 theme=schedule 时生效。 */
	themeScheduleDarkStart: string;
	/** 主题色（accent）预设，data-accent 驱动；新增预设只需扩充 AppAccentMode 与色板 */
	accent: AppAccentMode;
	/** 皮肤（换肤）：内置预设见 themePresets.ts SKIN_PRESETS；custom 走 customThemeOverrides/customTheme */
	themeSkin: AppSkinId;
	/** Logo 风格：可选以兼容旧 settings.json，缺省按 classic 处理；启动画面经 localStorage 提前生效 */
	logoStyle?: LogoStyle;
	/** 自定义主题：CSS 变量名 → 值（键不含 -- 前缀），叠加在内置皮肤之上 */
	customThemeOverrides: Record<string, string>;
	/**
	 * 自定义主题包快照（设置页「自定义主题」应用时写入）：优先于 customThemeOverrides，
	 * 按当前亮暗选档注入；切换回内置皮肤时清除。快照内嵌于设置文件，主题文件被删后观感不丢。
	 */
	customTheme?: CustomThemeSnapshot;
	/** 背景图文件名（userData/backgrounds/ 目录下），空串=不启用 */
	backgroundImage: string;
	/** 背景图可见度 0-1：0=背景色完全遮住图片，1=图片全显；面板/弹层会按语义分档透出 */
	backgroundImageOpacity: number;
	/** 界面语言，system 跟随系统语言；pseudo 用于长文案布局压力测试 */
	language: AppLanguageMode;
	/** 启动时主窗口几何预设，默认 last（上次窗口位置和大小，读不到时顺延 maximized） */
	startupWindowMode: StartupWindowMode;
	piEnvironmentChecked: boolean;
	/** 最近一次 pi 环境检测成功的结果缓存（命令路径 + 版本），打开设置直接显示，不重复检测 */
	piInstall?: { command: string; version: string };
	/** 会话 Tab 打开模式：preview=单击为临时预览（发消息后自动晋升常驻），permanent=单击即常驻共存 */
	sessionTabOpenMode: SessionTabOpenMode;
	/**
	 * 是否在首轮 agent 成功结束后，用当前 pi 模型异步生成会话标题。
	 * 默认开启，让侧栏自动获得可读标题；会额外消耗一次模型调用和少量 token（设置说明已写明）。
	 * 设置只在新建或重启 Agent 进程时注入，关闭不影响已有会话的主 agent。
	 */
	autoSessionTitle: boolean;
	/**
	 * Agent 忙碌时发送消息的默认投递行为。
	 * "steer"=插入当前回合（模型在本次回合内尽快看到）；"followUp"=排队，当前回合结束后自动发送。
	 * 仅决定渲染层入队后的默认投递语义；pi/dsh 主进程各自映射到 wire 协议
	 * （pi streamingBehavior / DSH sessions.prompt mode）。缺省 "steer"，解析见 shared/busySendDelivery.ts。
	 */
	busySendDelivery: BusySendDelivery;
	/**
	 * **遗留字段**：输入框底栏「快捷消息」的条目曾存在这里。
	 * 现已改为独立配置文件 userData/quick-messages.json（主进程 QuickMessageStore，读写都操作该文件），
	 * 出厂清单在随包资源 resources/quick-messages.default.json。
	 * 保留此字段只为升级时作「首次迁移种子」：用户升级后已改过的条目不能丢；
	 * 渲染层不再读写它（改走 quickMessages:get / quickMessages:save）。
	 */
	quickMessages: string[];
	/** 是否启用会话右侧的 Git 源代码管理入口与面板，默认开启以保持升级前行为。 */
	enableGitManagement: boolean;
	/** Git 提交摘要生成提示词模板，{diff} 会被替换为实际 diff 内容 */
	gitCommitMessagePrompt: string;
	/** Git 提交摘要使用的 pi provider；为空时生成前提示用户配置 */
	gitCommitMessageProvider: string;
	/** Git 提交摘要使用的模型 ID；为空时生成前提示用户配置 */
	gitCommitMessageModel: string;
	/**
	 * Git 可执行文件绝对路径（如 C:\Program Files\Git\cmd\git.exe）。
	 * 为空表示自动解析：优先 PATH 中的 git，回退到各平台已知安装位置。
	 * 用户显式配置后，所有 git 子进程（含 worktree）都使用该路径。
	 */
	gitExecutablePath: string;
	/**
	 * DSH 沙箱 runner 用的本机 Node 绝对路径（Windows 必须是 CUI node.exe）。
	 * 空串 = 自动探测 PATH / 版本管理器 / 应用数据目录里的专用副本。
	 * 不随包分发，避免安装包再涨 ~86MB；可在开发设置里一键下载到 userData。
	 */
	dshRunnerNodePath: string;
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
	 * 声音提醒（会话完成/异常/等待输入时播放提示音）。
	 * 独立于系统通知 enableNotifications：通知关闭仍可只听声音，反之亦然。
	 * 缺省用 DEFAULT_SOUND_ALERT_SETTINGS（见 shared/types/soundAlert.ts）。
	 */
	soundAlert: SoundAlertSettings;
	/**
	 * 非聚焦会话收到 Ask 提问（select/confirm/input/editor/batch_ask）时发送系统通知。
	 * 默认关闭：与通用 enableNotifications 解耦，用户可单独控制提问提醒，避免打扰。
	 */
	askNotificationEnabled: boolean;
	/** 激活 Agent 数量提醒（人文关怀）：激活数达到阈值时，启动时提示关闭空闲会话释放内存。默认开启。 */
	agentCountReminderEnabled: boolean;
	/**
	 * 公告通知：拉取到新未读公告时在右上角弹 toast 提醒（默认开启）。
	 * 关闭后仅保留侧栏公告入口的红点（公告中心随时可看），不再主动弹窗；
	 * 弹出时机由渲染层忙碌检测控制（输入中/模态打开/窗口隐藏时延迟），与本开关解耦。
	 */
	announcementNotificationEnabled: boolean;
	/**
	 * 应用内 toast 的展示时长（ms），全局统一口径：所有提示（含调用方显式传入的时长、
	 * error/warning/question 档）都按此值停留，只有调用方要求「常驻」的提示不受影响。
	 * 起因是扩展 ctx.ui.notify 等提示硬编码 1500ms，用户普遍反馈来不及看。
	 * 取值：有限正数毫秒（主进程钳制 1000–60000）或 TOAST_DURATION_STICKY_MS(-1)=常驻；
	 * 非法值读取时钳回默认。渲染层把哨兵映射为 Number.POSITIVE_INFINITY。
	 */
	toastDurationMs: number;
	/** 是否在会话中显示模型思考过程，默认开启 */
	showThinking: boolean;
	/**
	 * 流式对话时是否自动展开中间过程（思考/工具详情）。
	 * false（默认）：对话过程中保持折叠（历史轮与最新轮都不自动撑开），手动展开的仍可查看；
	 * true：最新轮流式输出时自动展开。手动开合状态始终优先于本设置。
	 */
	expandInterimDuringStream: boolean;
	/**
	 * 时间线是否按「过程组」显示（实验特性）。
	 * true（默认）：一轮里连续的思考与工具调用合并成过程组，点开组头才展开明细；
	 * false：保持平铺显示（连续思考/工具调用逐条铺开）。
	 */
	processGroupDisplay: boolean;
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
	/** 用户手动指定的 pi CLI 命令路径，自动检测不到时用于兜底；同时也是「当前使用」的指针 */
	customPiPath: string;
	/**
	 * 用户自己添加的 pi 候选路径（设置页列表里可随时切换）。
	 * 与 customPiPath 的分工：本字段只是“备选池”，只影响列表展示与切换；
	 * 真正生效的永远只有 customPiPath 那一条——启动 pi / 更新 / 扩展管理都只读它。
	 */
	piCustomPaths: string[];

	/** 是否发送匿名、低频、最小字段的使用统计 */
	telemetryEnabled: boolean;
	/** 是否开启局域网 Web 服务 */
	webServiceEnabled: boolean;
	/**
	 * Web 服务监听地址。默认 0.0.0.0（绑定到所有网卡）：同网段任意主机可访问，
	 * 需配合 webServiceRequiresAuth 强制令牌校验，避免未授权调用。
	 */
	webServiceHost: string;
	/** Web 服务监听端口 */
	webServicePort: number;
	/**
	 * 鉴权开关。开 = 所有 /api/*（/api/health 除外）需携带访问令牌，环回地址也不例外；
	 * 默认 true，与默认 0.0.0.0 绑定配合，阻断局域网未授权访问。
	 */
	webServiceRequiresAuth: boolean;
	/**
	 * 固定访问令牌。持久化：重启服务/应用不换新，远程设备已保存的链接不失效；
	 * 缺省时首次启动自动生成并回写。可由设置页手动修改或重新生成。
	 */
	webServiceToken?: string;
	/** 令牌生成/最后修改时刻（epoch ms），过期计时的基准；不随重启重置 */
	webServiceTokenGeneratedAt?: number;
	/** 令牌有效期（ms），0 = 永不过期（默认）；从 generatedAt 起算，到期后请求 401 */
	webServiceTokenExpiresIn?: number;
	/**
	 * cloudflared 隧道传输协议：http2 = TCP 443（默认，规避国内 UDP QoS 限速）、
	 * quic = UDP、auto = cloudflared 自行回退。用户环境差异大，允许调整。
	 */
	webRemoteCloudflaredProtocol?: WebRemoteCloudflaredProtocol;
	/** cloudflared 额外启动参数（空白切分后数组直传子进程，无 shell 注入面）；如 "--edge-ip-version 6" */
	webRemoteCloudflaredExtraArgs?: string;
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
	/**
	 * 会话 Tab 最大宽度（px，80–400，默认 104=旧硬编码值）。仅封顶不设下限宽度：
	 * Tab 按内容收缩（w-fit），短标题的 Tab 不受影响；有前置徽标时上限另加
	 * SESSION_TAB_BADGE_EXTRA_WIDTH（28px，旧 132px 差值）。外观设置滑杆可调。
	 */
	/** Navigation presentation only; does not change session identities. */
	navigationMode: "tabs" | "simple";
	sessionTabMaxWidth: number;
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

	// ── 悬浮球（floater）：主窗口隐藏后屏幕角落的常驻小圆点，点开进入小任务浮窗/工作台 ──
	/** 是否启用悬浮球，默认 false：开启后主窗口可隐藏为 64px 悬浮球，不挡屏 */
	floatingBallEnabled: boolean;
	/** 悬浮球点击后的展开目标：mini=极简浮窗（状态+快捷输入+最近会话），compact=小任务紧凑模式（主窗口紧凑化） */
	floatingBallExpandTarget: "mini" | "compact";
	/** 悬浮球是否始终置顶，默认 true */
	floatingBallAlwaysOnTop: boolean;
	/** 悬浮球是否显示运行中任务数量角标，默认 true：关闭后球面不再叠加数字徽章 */
	floatingBallShowRunningBadge: boolean;
	/** 悬浮球边缘吸附：拖动松手后是否自动贴到屏幕左右边缘，默认 true */
	floatingBallSnapToEdge: boolean;

	// ── 闲置 Agent 内存优化：自动释放长时间闲置的 agent 进程，降低多会话内存占用 ──
	/** 是否自动释放闲置 agent，默认 true：开关关闭后闲置 agent 常驻内存不释放 */
	idleAgentAutoRelease: boolean;
	/** 保留的闲置 agent 数量，默认 5：超出该数量的闲置 agent（且满足闲置时长）按闲置最久优先释放 */
	idleAgentKeepCount: number;
	/** 闲置判定时长（分钟），默认 60：agent 连续闲置超过该时长才可被释放 */
	idleAgentTimeoutMin: number;

	// ── standby 预热池：空闲时预先启动一个已握手的 pi 进程，新建/草稿会话激活近即时 ──
	/** 是否启用 standby 预热（默认 true）：每项目最多一个，约 300MB 内存，10 分钟未使用自动回收。
	 *  修改后只影响下一次预热/认领（进程 spawn 参数无法热更，指纹不匹配自动回退正常创建）。 */
	standbyRuntimeEnabled?: boolean;

	// ── CUA（Computer Use Agent）：让 Agent 观察屏幕并注入鼠标/键盘输入 ──
	/**
	 * 是否启用 CUA 能力，默认 false。
	 * 开启后主进程才会监听本地 MCP HTTP 端点并把 `pideck-cua` 写入
	 * ~/.pi/agent/mcp.json；关闭时不监听、不改动 pi 配置（默认姿态为「关」）。
	 * 真实输入受全局/会话杀开关保护；关闭自动审批后，每次写操作需显式确认。
	 */
	cuaEnabled: boolean;
	/**
	 * CUA 免审批（自动放行），默认 true；保留用户显式关闭的选择。
	 * 开启后写操作（点击/输入/滚动）跳过逐次审批对话框直接执行；
	 * 全局/会话杀开关仍然生效（关掉 CUA 仍一律拒绝）。风险自担型开关。
	 */
	cuaAutoApprove: boolean;

	// ── 模型收藏：ModelPicker 中用 ☆ 标记，收藏的模型在列表中置顶 ──
	/** 收藏的模型 ID 列表 */
	favoriteModels: string[];

	// ── 提供商与模型显示开关：隐藏后模型页卡片列表与模型选择器都不再展示 ──
	/**
	 * 用户主动隐藏的提供商 key 列表（与 models.json 的 provider key 一致）。
	 * 隐藏后：Pi 模型页卡片移入页面底部「已隐藏」折叠区，模型选择器不再显示其模型；
	 * 配置本身不删除，恢复显示即可继续使用。可选以兼容旧 settings.json。
	 */
	hiddenProviders?: string[];
	/**
	 * 用户主动隐藏的模型标识列表（格式为 "provider/modelId"）。
	 * 隐藏后：配置页移入该 provider 下的「已隐藏模型」折叠区，模型选择器不再显示；
	 * 配置本身不删除，恢复显示即可继续使用。可选以兼容旧 settings.json。
	 */
	hiddenModels?: string[];
	/**
	 * 用户主动隐藏的认证供应商 key 列表（与 auth.json 的 provider key 一致）。
	 * 隐藏后：Pi 认证页卡片移入页面底部「已隐藏」折叠区；
	 * 配置本身不删除（仍正常保存于 auth.json 并供 pi 加载），恢复显示即可继续展开编辑。可选以兼容旧 settings.json。
	 */
	hiddenAuthProviders?: string[];

	// ── 功能模块显示开关：外观设置里按需收起不用的模块 UI 入口 ──
	/**
	 * 用户主动隐藏的功能模块 id 列表（清单与语义见 shared/hiddenModules.ts）。
	 * 隐藏后：对应设置 tab 从侧栏消失；`dsh` 还会收起配置管理的 DSH 分页与新建会话的 DSH 选项，
	 * `imagegen` 还会收起输入框的生图入口。只隐藏入口，不清配置、不停已启用的后台功能；
	 * 命令面板仍可搜到并一键恢复显示。默认 `[]` 全部显示；可选以兼容旧 settings.json。
	 */
	hiddenModules?: string[];

	/**
	 * 用户主动隐藏的输入框功能入口 id 列表（清单与语义见 shared/composerFeatures.ts）。
	 * 可关项：提示词增强/语音输入/快捷消息/权限/Git 分支；只隐藏入口，不停功能与快捷键。
	 * 默认 `[]` 全部显示；可选以兼容旧 settings.json。
	 */
	hiddenComposerFeatures?: string[];

	// ── 供应商卡片排序：用户在模型页拖拽/上移下移后写入的自定义顺序 ──
	/**
	 * Pi 模型页供应商卡片的用户自定义顺序（provider key 数组，与 models.json 一致）。
	 * 只影响展示顺序，不改动 models.json；未列出的 provider 保持配置原序追加在后
	 * （新增/改名的 provider 因此不会被顶到最前）。可选以兼容旧 settings.json。
	 */
	providerOrder?: string[];
	/**
	 * DSH 模型页供应商卡片的用户自定义顺序（llm-pi-ai providers 的 provider 名数组）。
	 * 语义同 providerOrder；与 Pi 侧分开存放，避免两套配置互相污染顺序。
	 */
	dshProviderOrder?: string[];

	// ── 模型选择器分组排序：记录最近使用的供应商 ──
	/**
	 * 最近使用的供应商 ID 列表（最新在前，最多 8 个），主进程在 sendPrompt 接受时自动记录，
	 * 与 lastUsedModel 同点写入。模型选择器按此优先排列供应商分组：最近用过的排最前，
	 * 没记录过的供应商仍按内置置顶 + 字母序。可选以兼容旧 settings.json。
	 * 注意：被 providerOrder 显式排序过的供应商不再参与最近置顶（自定义顺序优先），
	 * 此处只对「没自定义排过序」的供应商生效。
	 */
	recentProviders?: string[];

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
	/**
	 * 会话 Tab 栏字号覆盖；null 表示跟随 uiFontSize（而非 fontSize）。
	 * 为什么回落界面轨：Tab 标题历史上吃的是界面轨的 --font-size-micro，
	 * 若回落全局字号，「只改过界面字号」的用户开启本开关后 Tab 会突变。
	 */
	tabBarFontSize: AppFontSizeMode | null;
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

	// ── 终端（外观/行为/启动）──
	/** 终端配色主题 id。inherit=跟随应用明暗（深色用 pi-soft 暗版） */
	terminalTheme: TerminalThemeId;
	/** 终端字号（px）。为 null 时跟随外观设置的 UI 字号档位 */
	terminalFontSize: number | null;
	/** 终端字体族自定义栈。空串时使用 --font-family-mono（外观设置的代码字体） */
	terminalFontFamily: string;
	/** 终端滚动回放行数上限（下次新开终端生效） */
	terminalScrollback: number;
	/** 光标形状 */
	terminalCursorStyle: TerminalCursorStyle;
	/** 光标是否闪烁 */
	terminalCursorBlink: boolean;
	/** 选区变化时是否自动复制到系统剪贴板 */
	terminalCopyOnSelect: boolean;
	/** 终端内容区上下内边距（px） */
	terminalPaddingY: number;
	/** 关闭终端标签时的确认策略 */
	terminalConfirmClose: TerminalConfirmCloseMode;
	/** 可选的终端启动命令：非空时新终端在 shell 启动后立即执行该命令 */
	terminalStartupCommand: string;

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
	/**
	 * 更新源："github" 走 GitHub Release 官方源（app-update.yml 原生链路）；
	 * 其余为国内镜像前缀代理（generic provider 拼 releases/latest/download）；
	 * "custom" 用 customUpdateSourceUrl 的镜像前缀。
	 * 默认 "atomgit"（v0.7.5 起，国内加速源为第一首选）。
	 */
	updateSource: UpdateSourceId;
	/** updateSource="custom" 时的镜像前缀（如 https://mirror.example.com），拼接规则见 updateSources.ts。 */
	customUpdateSourceUrl: string;
	/**
	 * updateSource 一次性迁移标记：v0.7.5 将默认源从 github 切为 atomgit 时，
	 * 对已持久化过 "github" 的旧用户补一次迁移到 atomgit；置 true 后永不重复迁移，
	 * 用户后续显式改回 github 会被尊重。缺省 = 未迁移（仅旧 settings.json 会出现）。
	 */
	updateSourceAtomgitMigrated?: boolean;
	/** 上次后台检查完成时间（毫秒时间戳）；缺省 = 从未检查。 */
	updateLastCheckAt?: number;
	/** 最近一次“已提示过”的 PiDeck 版本（弹窗关闭后写入，用于“每版本只弹一次”）；缺省 = 未提示过任何版本。 */
	updateNotifiedVersion?: string;
	/** 用户跳过的 PiDeck 版本（该版本不再主动提示，手动检测仍可查看）；缺省 = 未跳过。 */
	updateSkippedVersion?: string;
	/** 最近一次“已提示过”的 Pi CLI 版本；缺省 = 未提示过。 */
	updatePiNotifiedVersion?: string;
	/** 是否已看过「更新圆点」的首次解释气泡（coachmark 一次性教育标记）；缺省 = 未看过。 */
	updateDotHintSeen?: boolean;

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

	/**
	 * 项目会话列表排序模式（2027-03 开放排序规则）：updatedAt=最近活跃（历史默认）、
	 * createdAt=创建时间、title=标题。缺省/非法值回落 updatedAt；由渲染层策略目录
	 * （sessionSortModes）解释，主进程只存字符串不参与排序。
	 */
	sessionSortMode?: SessionSortModeId;

	// ── 会话导入 ──
	/**
	 * Kimi Work（kimi-desktop 桌面版）daimon-share 数据目录的用户显式指定位置。
	 * undefined/空串 = 未指定，走探测链（kimi-desktop 的 daimon-storage.json →
	 * 默认安装位置 %APPDATA%/kimi-desktop/daimon-share）。用户在 Kimi Work 里把
	 * 数据目录自定义到任意盘符时，靠探测链自动找到；此项仅用于探测失败时的手动指定。
	 * 优先级最高，非空时不再读探测链。
	 */
	kimiWorkShareRoot?: string;

	// ── 扩展管理 ──
	/**
	 * 用户手动移除（或因三方冲突自动让位）的内置扩展列表（如 pi-deck-todo.ts）。
	 * 下次启动跳过自动部署，并清理用户目录残留文件，避免 pi 仍加载导致工具冲突。
	 */
	removedBuiltInExtensions: string[];

	/**
	 * 用户显式开启的「默认关闭」内置扩展（GUI 扩展桥/扩展点面板等 opt-in）。
	 * 这些扩展不进 removedBuiltInExtensions——默认不注入，列表存在才随 -e 注入。
	 */
	enabledBuiltInExtensions: string[];

	/**
	 * 旧版扩展禁用记录（source 标识 + 作用域）。
	 * 现代版本已改为写 pi 原生 `settings.json` 过滤规则；此字段仅由启动迁移读取并清理，
	 * 迁移完成前它仍会被扩展运行时查询与压缩归属启发式读取（见执行计划 A5）。
	 */
	disabledExtensions: DisabledExtensionEntry[];

	/**
	 * 用户禁用的全局技能名列表（与 SkillManager.list 的 name 去重键一致，比较时小写），
	 * 存储于 PiDeck 自身设置（不写 pi settings）。
	 * 现代版本已改为写 pi 原生 `settings.json` 过滤规则；此字段仅由启动迁移读取并清理。
	 * pi 的 frontmatter `disable-model-invocation` 只阻止模型自动调用，与「完全不加载」不同。
	 */
	disabledSkills: string[];

	/**
	 * 旧版提示词禁用记录（与 PromptManager.list 的 name 一致，比较时小写）。
	 * 现代版本已改为写 pi 原生 `settings.json` 过滤规则；此字段仅由启动迁移读取并清理。
	 */
	disabledPrompts: string[];

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
	 * 注意：DSH 官方约束「同一 DSH_HOME 只允许一个 host」，与 dsh CLI 共用默认目录
	 * 时两实例会互相覆盖状态；配置页概览据此给出 DSH_HOME 隔离提示（#189，判定见
	 * `src/main/dsh/dshHomeSharing.ts`）。
	 * 实现见 DshHost.resolveDshHomeDir。启动预热前变更会被新 host 读取；
	 * 已运行时切换需重启 host。
	 */
	dshHomeDir?: string;

	/**
	 * DSH runtime 下载源索引地址（覆盖默认 AtomGit/GitHub latest 应用 Release）。
	 * 用于镜像/内网分发：索引是分平台 `dsh-runtime-<platform>-<arch>-releases.json`，
	 * 条目里给出 tarball 直链与 sha256。缺省/空串 = 跟随 settings.updateSource。
	 * sha256 校验始终生效，镜像也不能绕过。禁止指向独立 `dsh-runtime` tag。
	 */
	dshRuntimeIndexUrl?: string;

	/**
	 * DSH 沙箱 Node 24 下载源索引（覆盖默认 AtomGit/GitHub latest 应用 Release）。
	 * 缺省/空串 = 跟随 settings.updateSource。sha256 始终校验。
	 */
	dshRunnerNodeIndexUrl?: string;

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

	/**
	 * DSH host 是否被用户手动停止（不想让它运行）。
	 *
	 * 持久化跨应用重启：标记为真后，预热（startDshHostInBackground）、按需兜底
	 * （ensureStarted）、崩溃自动重启（DshHostProcess.restartAfterCrash）、runtime
	 * 磁盘操作后的 host 恢复等所有非用户显式发起的路径都不再 fork host。
	 * 只有用户在 DSH 配置页点「启动」才清除标记并重新 boot。
	 * 缺省 undefined/false：保持按需自动启动的历史语义。
	 */
	dshManualStopped?: boolean;

	/**
	 * DSH agent-team 实验预设（默认关）：开启后 DSH host 组合追加官方
	 * @deepseek-ai/dsh-experimental-agent-team-profile（启用 Team 域 spawn_teammate
	 * 等工具，并禁用 subagent/subagent_fork 工具——同一组合层后行覆盖先行）。
	 * 仅在 host fork 时读取（--dsh-agent-team=1）：变更后需重启 DSH host 生效，
	 * 对已运行会话不变。缺省 undefined/false = 完全等同现状（不注入任何行）。
	 */
	dshAgentTeamPreset?: boolean;

	/**
	 * DSH runtime 迁移提示是否已展示过（一次性提示的持久化闩，#317）。
	 *
	 * 渲染层展示「runtime 不在 + 存量 dsh 会话」提示前读取；展示后立即写 true，
	 * 跨重启不再重弹（否则每次启动都弹，提示变成骚扰）。缺省 undefined/false =
	 * 还没提示过。展示即置位而非「用户点过入口」：错过 toast 的用户仍可从设置页
	 * 的 DSH 安装引导进入，不为此保持打扰。
	 */
	dshRuntimeMigrationNoticeShown?: boolean;

	/**
	 * ACP agent CLI 工具登记表（backend=acp 会话的驱动器）：gemini --acp /
	 * opencode acp / kimi acp / codex-acp 等。数组保序（展示=登记顺序）；
	 * 删除工具后旧会话靠 acpSessionId 只读降级。缺省 undefined = 空表（无 ACP 工具）。
	 */
	acpTools?: AcpToolConfig[];
};

/**
 * 令牌有效期可选值（ms）。0 = 永不过期（默认）；从 webServiceTokenGeneratedAt 起算。
 * 主进程 IPC 校验与 SettingsStore 清洗共用同一份枚举，避免两处口径漂移。
 */
export const WEB_TOKEN_EXPIRES_IN_CHOICES = [0, 3_600_000, 86_400_000, 604_800_000, 2_592_000_000] as const;

/** cloudflared 隧道传输协议枚举（webRemoteCloudflaredProtocol）；默认 http2（TCP，规避 UDP QoS 限速）。 */
export const WEB_REMOTE_CLOUDFLARED_PROTOCOLS = ["auto", "quic", "http2"] as const;
export type WebRemoteCloudflaredProtocol = (typeof WEB_REMOTE_CLOUDFLARED_PROTOCOLS)[number];

/**
 * 清洗用户输入的 cloudflared 额外参数：允许空格分隔多参数，但仅限可打印 ASCII（拒绝控制字符/非 ASCII），
 * 长度 ≤500；切分后 argv 直传子进程，无 shell 注入面。非法输入整体置空回退默认。
 */
export function sanitizeCloudflaredExtraArgs(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	if (!trimmed || trimmed.length > 500) return "";
	return /^[ -~]+$/.test(trimmed) ? trimmed : "";
}

/**
 * 手动设置令牌的形状约束：8-128 个可打印非空白 ASCII（不含空格，避免 URL 拼接歧义）。
 * 自动生成的 UUID 天然满足；用户自定义串在此拦截，超界回落未设置。
 */
export function isValidWebTokenShape(value: string): boolean {
	return /^[!-~]{8,128}$/.test(value);
}

/**
 * Web 服务运行时状态；token 持久化固定（见 AppSettings.webServiceToken），重启不换新。
 * requiresAuth 反映用户设置 webServiceRequiresAuth 的清洗结果，缺省视为 true。
 * 渲染层设置页二维码/令牌提示据此附上访问令牌；tokenExpiresAt 供「剩余有效期」展示（null = 永不过期）。
 */
export type WebServiceStatusInfo = {
	running: boolean;
	host: string;
	port: number;
	token: string;
	requiresAuth: boolean;
	tokenExpiresAt: number | null;
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

/**
 * 渲染层 AppSettings 首屏默认值（App.tsx 在主进程 settings.get 返回前使用）。
 * 口径必须与 main SettingsStore 的 defaultSettings 保持一致：新增设置项时两边同步补，
 * 避免首屏默认与真实默认不一致造成启动闪烁。
 */
export function createDefaultAppSettings(): AppSettings {
	return {
		useNativeTitleBar: true,
		showNativeMenu: false,
		sendShortcut: "enter-send",
		defaultAgentBackend: "pi",
		theme: "system",
		themeScheduleLightStart: "07:00",
		themeScheduleDarkStart: "19:00",
		accent: "default",
		themeSkin: "classic-green",
		logoStyle: "pi-tui",
		customThemeOverrides: {},
		backgroundImage: "",
		backgroundImageOpacity: 0.8,
		language: "system",
		startupWindowMode: "last",
		piEnvironmentChecked: false,
		/** 扩展禁用白名单：与 SettingsStore 默认一致，空数组 = 不启用白名单（首屏未拉到真实设置前的默认值） */
		disabledExtensions: [],
		enabledBuiltInExtensions: [],
		/** 技能禁用列表：与 SettingsStore 默认一致，空数组 = 不启用技能白名单 */
		disabledSkills: [],
		/** 提示词模板禁用列表：与 SettingsStore 默认一致，空数组 = 不启用模板白名单 */
		disabledPrompts: [],
		sessionTabOpenMode: "preview",
		// 与 main SettingsStore 默认一致：标题生成默认开启，侧栏不再全是「新会话」
		autoSessionTitle: true,
		// 与 main SettingsStore 默认一致：忙碌时发送默认「插入当前回合」
		busySendDelivery: "steer",
		// 遗留字段：快捷消息已改存独立配置文件 userData/quick-messages.json（见 useQuickMessages），
		// 这里保留字段只为满足 AppSettings 类型，内容不再被读取。
		quickMessages: [],
		enableGitManagement: true,
		gitCommitMessagePrompt: "请根据以下 git diff 生成一条中文 git commit message。\n\n变更描述：\n{diff}\n\nGitmoji 对应关系：\n✨ feat - 新功能\n🐛 fix - Bug 修复\n📚 docs - 文档更新\n💎 style - 代码格式\n♻️ refactor - 重构\n🧪 test - 测试\n🔧 chore - 构建/工具",
		gitCommitMessageProvider: "",
		gitCommitMessageModel: "",
		gitExecutablePath: "",
		dshRunnerNodePath: "",
		closeToTray: true,
		singleInstance: true,
		enableNotifications: true,
		// Ask 提问系统通知默认关闭：与主进程 SettingsStore 默认一致（默认不打扰）
		askNotificationEnabled: false,
		// 人文关怀提醒默认开启：与主进程 SettingsStore 默认一致，首屏未拉到真实设置前不关闭提醒
		agentCountReminderEnabled: true,
		// 公告通知默认开启：与主进程 SettingsStore 默认一致，首屏未拉到真实设置前不误关提醒
		announcementNotificationEnabled: true,
		// toast 展示时长：与主进程 defaultSettings 同源（全局统一口径）
		toastDurationMs: DEFAULT_TOAST_DURATION_MS,
		// showThinking 由 pi agent 的 hideThinkingBlock 控制，启动后从主进程加载的真实值会覆盖此处
		showThinking: true,
		// 流式对话行为：默认自动展开中间过程（与 SettingsStore 一致）
		expandInterimDuringStream: true,
		// 过程组显示默认开启：与主进程 SettingsStore 默认一致，首屏即按过程组渲染
		processGroupDisplay: true,
		showDevTools: false,
		developerDiagnostics: false,
		// Electron Chromium 沙箱默认关，与主进程历史兼容策略一致
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
		piCustomPaths: [],
		wslEnabled: false,
		wslDistro: "Ubuntu",
		wslUser: "root",
		telemetryEnabled: true,
		webServiceEnabled: false,
		webServiceHost: "0.0.0.0",
		webServicePort: 8765,
		webServiceRequiresAuth: true,
		rpcTimeout: 600_000,
		linkOpenMode: "external",
		workspaceContentOpenMode: "split",
		contentMaxWidth: 1800,
		chatContentWidthPct: 80,
		navigationMode: "tabs",
		sessionTabMaxWidth: SESSION_TAB_MAX_WIDTH_DEFAULT,
		maxEditorFileSizeMB: 5,
		externalEditors: createDefaultExternalEditorSettings(),

		// 桌面宠物默认关闭：关闭后应用与现状完全一致，零回归
		petEnabled: false,
		petId: "clawd",
		petAlwaysOnTop: true,
		petScale: DEFAULT_PET_SCALE,
		petPatrolEnabled: true,
		petPatrolPauseMin: 5,
		// 悬浮球默认关闭：开启后主窗口可隐藏为小圆点，不影响现状
		floatingBallEnabled: false,
		floatingBallExpandTarget: "mini",
		floatingBallAlwaysOnTop: true,
		floatingBallShowRunningBadge: true,
		floatingBallSnapToEdge: true,
		// 闲置 agent 自动释放：与 main SettingsStore 默认值保持一致，避免启动时闪烁
		idleAgentAutoRelease: true,
		idleAgentKeepCount: 5,
		idleAgentTimeoutMin: 60,
		standbyRuntimeEnabled: true,
		cuaEnabled: false,
		cuaAutoApprove: true,
		favoriteModels: [],

		// 字体配置：与 main SettingsStore 默认值保持一致，避免启动时闪烁
		fontSize: "medium",
		uiFontSize: null,
		tabBarFontSize: null,
		chatFontSize: null,
		inputFontSize: null,
		zoomFactor: 1,
		fontFamilyBase: "system",
		fontFamilyBaseCustom: "",
		fontFamilyMono: "system-mono",
		fontFamilyMonoCustom: "",
		// 终端外观/行为默认值：主题 inherit 保持 pi-soft 跟随明暗行为，
		// scrollback 与 TerminalDock 历史硬编码 5000 一致（升级后行为不变）。
		terminalTheme: "inherit",
		terminalFontSize: null,
		terminalFontFamily: "",
		terminalScrollback: 5000,
		terminalCursorStyle: "block",
		terminalCursorBlink: true,
		terminalCopyOnSelect: false,
		terminalPaddingY: 8,
		terminalConfirmClose: "running",
		terminalStartupCommand: "",
		removedBuiltInExtensions: [],
		// 声音提醒：与主进程 defaultSettings 保持一致（完成/异常开、等待输入关）
		soundAlert: createDefaultSoundAlertSettings(),
		imageGenSize: "unset",
		imageGenWatermark: false,
		imageGenOutputFormat: "png",
		autoDownloadUpdates: true,
		// 与主进程 defaultSettings 保持一致：更新源默认 GitHub 官方，自定义镜像前缀留空
		updateSource: "github",
		customUpdateSourceUrl: "",
		// 与主进程 defaultSettings 保持一致：offline 默认关，让模型目录随启动刷新
		piRpcOffline: false,
		piRpcNoExtensions: false,
		piRpcNoSkills: false,
	};
}
