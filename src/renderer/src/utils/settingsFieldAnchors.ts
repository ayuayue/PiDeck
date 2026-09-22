import type { SettingsTabId } from "../atoms";
import type { TranslationKey } from "../i18n";

/**
 * 设置项级锚点清单 —— 命令面板（Ctrl+P）的「搜到某个**具体设置项**就跳过去」。
 *
 * 为什么必须是静态清单、不能运行时收集：
 * 设置页各 tab 是 lazy 渲染的（同时只挂载一个），运行时注册表只能看到当前 tab 的项，
 * 而命令面板要能搜到**任意** tab 里的项 —— 只能静态登记。
 *
 * 与源码的对应关系：每条 `slug` 必须对应源码里
 *   - `SettingRow / SettingSwitchRow / SettingTextarea` 的 `anchor={slug}`，或
 *   - `SettingsSection` 的 `id="settings-section-<slug>"`
 * 这条约定由 `tests/settingsFieldAnchors.test.mjs` 断言。**这是必须的**：写了索引却
 * 忘了加锚点，用户搜到后点进去会因为 `getElementById` 返回 null 而**静默不动** ——
 * 没有报错、没有提示，是最难自查的一类失效。
 *
 * 覆盖范围是增量的：这里只登记已实际标注锚点的项，其余 tab 仍可整页跳转（tab 级命令）。
 * 新增设置项时：先加 anchor，再来这里加一行，跑测试即可确认对齐。
 */
export type SettingsFieldAnchor = {
	/** 所属设置 tab：命令面板选中后先切到这个 tab，再滚到锚点 */
	tab: SettingsTabId;
	/** 锚点 slug，对应 DOM 上的 `id="settings-section-<slug>"` */
	slug: string;
	/** 该项标题的 i18n key（命令面板显示的名字；与页面上那行标题同源，不会张冠李戴） */
	labelKey: TranslationKey;
	/** 搜索别名：字段英文名、常见口语、相邻概念，补足「中文标题搜不到」的场景 */
	keywords: readonly string[];
};

export const SETTINGS_FIELD_ANCHORS: readonly SettingsFieldAnchor[] = [
	// ── 开发设置 ──────────────────────────────────────────────────────
	{
		tab: "dev",
		slug: "dev-pi-source",
		labelKey: "settings.piSource.label",
		keywords: ["pi 来源", "wsl", "windows 原生", "运行环境", "pi source"],
	},
	{
		tab: "dev",
		slug: "dev-wsl-config",
		labelKey: "settings.wsl.distro",
		keywords: ["wsl", "发行版", "distro", "子系统", "linux 用户", "wsl user"],
	},
	{
		tab: "dev",
		slug: "dev-custom-pi-path",
		labelKey: "settings.customPiPath",
		keywords: ["pi 路径", "自定义路径", "pi path", "nvm", "fnm", "找不到 pi"],
	},
	{
		tab: "dev",
		slug: "dsh-runner-node",
		labelKey: "settings.dshRunnerNode",
		keywords: ["dsh", "runner node", "node 路径", "沙箱 node", "本机 node"],
	},
	{
		tab: "dev",
		slug: "dev-auto-download-updates",
		labelKey: "settings.autoDownloadUpdates",
		keywords: ["自动下载", "更新", "auto download", "升级", "新版本"],
	},
	{
		tab: "dev",
		slug: "dev-rpc-timeout",
		labelKey: "settings.rpcTimeout",
		keywords: ["rpc 超时", "超时", "timeout", "rpcTimeout", "等太久", "请求超时"],
	},
	{
		tab: "dev",
		slug: "dev-max-editor-file-size",
		labelKey: "settings.maxEditorFileSize",
		keywords: ["大文件", "编辑器文件大小", "max editor file size", "打开大文件"],
	},
	{
		tab: "dev",
		slug: "dev-electron-sandbox",
		labelKey: "settings.electronSandbox",
		keywords: ["沙箱", "sandbox", "chromium", "electron sandbox", "安全沙箱"],
	},
	{
		tab: "dev",
		slug: "dev-pi-rpc",
		labelKey: "settings.piRpcStartup",
		keywords: ["pi rpc 启动参数", "启动参数", "rpc 参数"],
	},
	{
		tab: "dev",
		slug: "dev-pi-rpc-offline",
		labelKey: "settings.piRpcOffline",
		keywords: ["离线", "offline", "pi rpc offline", "断网"],
	},
	{
		tab: "dev",
		slug: "dev-pi-rpc-no-extensions",
		labelKey: "settings.piRpcNoExtensions",
		keywords: ["禁用扩展", "不加载扩展", "extensions", "扩展加载失败", "跳过扩展"],
	},
	{
		tab: "dev",
		slug: "dev-pi-rpc-no-skills",
		labelKey: "settings.piRpcNoSkills",
		keywords: ["禁用技能", "不加载技能", "skills", "跳过技能"],
	},
	{
		tab: "dev",
		slug: "dev-restart-app",
		labelKey: "settings.restartApp",
		keywords: ["重启应用", "重启 pideck", "restart", "重开"],
	},
	{
		tab: "dev",
		slug: "dev-devtools",
		labelKey: "settings.devTools",
		keywords: ["开发者工具", "devtools", "控制台", "调试工具", "f12"],
	},
	{
		tab: "dev",
		slug: "dev-open-data-dir",
		labelKey: "settings.openDataDir",
		keywords: ["数据目录", "userData", "打开目录", "配置目录", "缓存目录"],
	},
	{
		tab: "dev",
		slug: "dev-telemetry",
		labelKey: "settings.telemetry",
		keywords: ["遥测", "telemetry", "匿名统计", "上报", "隐私"],
	},

	// ── 常用设置 ──────────────────────────────────────────────────────
	{
		tab: "common",
		slug: "common-quick-messages",
		labelKey: "settings.quickMessages",
		keywords: ["快捷消息", "常用消息", "常用语", "一键发送", "继续", "提交", "推送", "quick message", "quick messages"],
	},
	{
		tab: "common",
		slug: "common-session-tab-open-mode",
		labelKey: "settings.sessionTabOpenMode",
		keywords: ["会话标签打开方式", "预览", "固定标签", "tab 打开模式", "preview"],
	},
	{
		tab: "common",
		slug: "common-auto-session-title",
		labelKey: "settings.autoSessionTitle",
		keywords: ["自动命名", "会话标题", "auto title", "起名"],
	},
	{
		tab: "common",
		slug: "common-send-shortcut",
		labelKey: "settings.inputShortcut",
		keywords: ["发送快捷键", "回车发送", "send shortcut", "输入框快捷键", "ctrl enter"],
	},
	{
		tab: "common",
		slug: "common-default-agent-backend",
		labelKey: "settings.defaultAgentBackend",
		keywords: ["默认后端", "pi", "dsh", "backend", "默认 agent"],
	},
	{
		tab: "common",
		slug: "common-expand-interim-during-stream",
		labelKey: "settings.expandInterimDuringStream",
		keywords: ["流式展开", "中间步骤", "interim", "展开思考"],
	},
	{
		tab: "common",
		slug: "common-collapse-prev-runs",
		labelKey: "settings.collapsePrevRunsOnNewTurn",
		keywords: ["折叠历史轮次", "折叠", "collapse", "上一轮", "收起"],
	},
	{
		tab: "common",
		slug: "common-idle-agent-auto-release",
		labelKey: "settings.idleAgentAutoRelease",
		keywords: ["闲置释放", "内存优化", "idle", "自动关闭 agent", "省内存"],
	},
	{
		tab: "common",
		slug: "common-idle-agent-keep-count",
		labelKey: "settings.idleAgentKeepCount",
		keywords: ["保留数量", "keep count", "闲置保留", "最多保留"],
	},
	{
		tab: "common",
		slug: "common-idle-agent-timeout",
		labelKey: "settings.idleAgentTimeoutMin",
		keywords: ["闲置超时", "idle timeout", "多久释放", "闲置时长"],
	},
	{
		tab: "common",
		slug: "common-shell-context-menu",
		labelKey: "settings.shellContextMenu",
		keywords: ["右键菜单", "资源管理器", "context menu", "shell", "系统右键"],
	},
	{
		tab: "common",
		slug: "common-close-to-tray",
		labelKey: "settings.closeToTray",
		keywords: ["托盘", "关闭到托盘", "tray", "最小化到托盘", "后台运行"],
	},
	{
		tab: "common",
		slug: "common-single-instance",
		labelKey: "settings.singleInstance",
		keywords: ["单实例", "single instance", "多开", "重复启动"],
	},

	// ── 外观设置 ──────────────────────────────────────────────────────
	{
		tab: "appearance",
		slug: "appearance-background-image-opacity",
		labelKey: "settings.backgroundImageOpacity",
		keywords: ["背景图透明度", "壁纸", "background opacity", "背景可见度"],
	},
	{
		tab: "appearance",
		slug: "appearance-font-size-per-area",
		labelKey: "settings.fontSizePerArea",
		keywords: ["分区字号", "分别设置字号", "字体大小", "per area font", "字号"],
	},
	{
		tab: "appearance",
		slug: "appearance-content-width",
		labelKey: "settings.contentWidthPct",
		keywords: ["内容宽度", "聊天区宽度", "content width", "宽度占比"],
	},
	{
		tab: "appearance",
		slug: "appearance-native-title-bar",
		labelKey: "settings.nativeTitleBar",
		keywords: ["原生标题栏", "标题栏", "title bar", "窗口标题"],
	},
	{
		tab: "appearance",
		slug: "appearance-native-menu",
		labelKey: "settings.nativeMenu",
		keywords: ["原生菜单", "菜单栏", "native menu", "窗口菜单"],
	},

	// ── Git ──────────────────────────────────────────────────────────
	{
		tab: "git",
		slug: "git-management",
		labelKey: "settings.gitManagement",
		keywords: ["git 面板", "git 管理", "版本控制", "侧栏 git", "git"],
	},
	{
		tab: "git",
		slug: "git-commit-message-prompt",
		labelKey: "settings.gitCommitMessagePrompt",
		keywords: ["提交信息提示词", "commit message", "生成提交信息", "prompt"],
	},

	// ── 通知 ─────────────────────────────────────────────────────────
	{
		tab: "notification",
		slug: "notification-enable",
		labelKey: "settings.enableNotifications",
		keywords: ["通知", "系统通知", "notification", "提醒"],
	},
	{
		tab: "notification",
		slug: "notification-ask",
		labelKey: "settings.askNotification",
		keywords: ["提问通知", "需要回答", "ask notification", "等待输入"],
	},
	{
		tab: "notification",
		slug: "notification-agent-count",
		labelKey: "settings.agentCountReminder",
		keywords: ["会话数量提醒", "agent 数量", "数量提醒", "太多会话"],
	},
	{
		tab: "notification",
		slug: "notification-announcement",
		labelKey: "settings.announcementNotification",
		keywords: ["公告通知", "announcement", "官方公告"],
	},

	// ── 局域网 Web 服务 ───────────────────────────────────────────────
	{
		tab: "web",
		slug: "web-enable-service",
		labelKey: "settings.enableWebService",
		keywords: ["局域网访问", "web 服务", "手机访问", "lan", "远程访问", "web"],
	},

	// ── 代理 ─────────────────────────────────────────────────────────
	{
		tab: "proxy",
		slug: "proxy-enable-pi",
		labelKey: "settings.enablePiProxy",
		keywords: ["pi 代理", "模型代理", "网络代理", "proxy", "翻墙", "走代理"],
	},
	{
		tab: "proxy",
		slug: "proxy-enable-desktop",
		labelKey: "settings.enableDesktopProxy",
		keywords: ["桌面代理", "应用代理", "desktop proxy", "全局代理", "更新代理"],
	},
] as const satisfies readonly SettingsFieldAnchor[];

/**
 * 全部锚点 slug 的字面量联合。
 *
 * 存在意义：让 `SettingsFocusTarget.section` 在**编译期**就拦住拼错的锚点。
 * 深链写错一个字符，运行时只会「页面滚到空气」——useSettingsFocus 找不到元素后
 * 2 秒静默放弃，既不报错也无提示，类型检查是唯一能在提交前发现它的关口。
 * （`as const satisfies` 同时保证 labelKey 必须是真实存在的 TranslationKey。）
 */
export type SettingsFieldAnchorSlug = (typeof SETTINGS_FIELD_ANCHORS)[number]["slug"];
