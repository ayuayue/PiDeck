import type { SettingsTabId } from "../atoms";
import type { TranslationKey } from "../i18n";
import { SETTINGS_SECTION_ANCHORS } from "./settingsSectionAnchors";

/**
 * 设置项级锚点清单 —— 命令面板（Ctrl+P）的「搜到某个**具体设置项**就跳过去」。
 *
 * 为什么必须是静态清单、不能运行时收集：
 * 设置页各 tab 是 lazy 渲染的（同时只挂载一个），运行时注册表只能看到当前 tab 的项，
 * 而命令面板要能搜到**任意** tab 里的项 —— 只能静态登记。
 *
 * 与源码的对应关系：本文件的每条 `slug` 必须对应源码里 `SettingRow / SettingSwitchRow /
 * SettingTextarea` 的 `anchor={slug}`；分区级锚点（`SettingsSection` 的 id）在
 * `settingsSectionAnchors.ts`，规则见那边。
 * 这条约定由 `tests/settingsFieldAnchors.test.mjs` 断言。**这是必须的**：写了索引却
 * 忘了加锚点，用户搜到后点进去会因为 `getElementById` 返回 null 而**静默不动** ——
 * 没有报错、没有提示，是最难自查的一类失效。
 *
 * 覆盖范围（两种粒度都登记，后者在 settingsSectionAnchors.ts）：
 *   - **单个设置项**（SettingRow 等上的 anchor，如 `appearance-session-status-placement`）；
 *   - **整块分区**（SettingsSection 的 id，如 `common-floating-ball`、`common-cua`）。
 * 分区粒度是必要的：新功能往往先落成一整块设置，用户只记得功能名（「闲置 Agent 内存优化」），
 * 不记得它在哪个 tab；只登记设置项的话，这类方块在搜索里完全不存在。
 * 例外：分区标题与所在 tab 同名（Git、配置备份）时不登记 —— tab 级入口已覆盖。
 * 并非每个设置行都有 anchor（全量约六成没有）：这些行靠**所在分区**锚点覆盖，
 * 搜到的是那块设置而不是那一行 —— 加新行时优先补 anchor，区块整体新增时补分区 id 即可。
 *
 * 增删设置后：先给行加 anchor / 区块加 id，再到对应清单文件加一行，跑 `node --test tests/settingsFieldAnchors.test.mjs`。
 * 测试是双向的：既拦「索引里写了、源码里没写」（搜到却跳不动），也拦「源码里有、索引里没登记」
 * （页面里有、搜索里搜不到）—— 后者正是历史上漏得最多的一类。
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

const SETTINGS_ROW_ANCHORS = [
	{ tab: "appearance", slug: "appearance-navigation-mode", labelKey: "settings.navigationMode", keywords: ["简洁模式", "标签模式", "simple", "navigation"] },
	{
		tab: "appearance",
		slug: "appearance-session-status-placement",
		labelKey: "settings.sessionStatusPlacement",
		keywords: ["待办", "修改文件", "子代理", "右侧边栏", "输入框上方", "会话状态", "todo", "subagents", "changed files", "sidebar"],
	},
	{
		tab: "appearance",
		slug: "appearance-session-tab-width",
		labelKey: "settings.sessionTabMaxWidth",
		keywords: ["会话标签宽度", "标签页宽度", "标签最大宽度", "session tab width", "tab 宽度上限"],
	},
	{
		tab: "notification",
		slug: "notification-toast-duration",
		labelKey: "settings.toastDuration",
		keywords: ["toast", "通知时长", "提示消失", "弹出太快", "notification duration"],
	},
	// ── 终端 ──────────────────────────────────────────────────────
	{
		tab: "terminal",
		slug: "terminal-font-size",
		labelKey: "settings.terminal.fontSize",
		keywords: ["终端字号", "字号", "字体大小", "terminal font size", "font size"],
	},
	{
		tab: "terminal",
		slug: "terminal-font-family",
		labelKey: "settings.terminal.fontFamily",
		keywords: ["终端字体", "等宽字体", "字体", "terminal font", "font family", "monospace"],
	},
	{
		tab: "terminal",
		slug: "terminal-padding-y",
		labelKey: "settings.terminal.paddingY",
		keywords: ["内边距", "终端边距", "间距", "terminal padding", "padding"],
	},
	{
		tab: "terminal",
		slug: "terminal-scrollback",
		labelKey: "settings.terminal.scrollback",
		keywords: ["回滚", "滚动上限", "历史行数", "scrollback", "terminal history"],
	},
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
		slug: "dev-data-env-mode",
		labelKey: "settings.dataEnvCurrentMode",
		keywords: ["数据模式", "stable 通道", "dev 通道", "双通道", "数据目录模式", "data env"],
	},
	{
		tab: "dev",
		slug: "dev-pi-installations",
		// 原「自定义 pi 路径」输入框已并入这块列表（检测到的安装 + 我添加的路径），
		// 锚点必须跟着走：留在旧 id 上会让命令面板点进去静默无反应。
		labelKey: "settings.piInstallationsTitle",
		keywords: ["pi 路径", "自定义路径", "pi path", "nvm", "fnm", "找不到 pi", "多个 pi", "选择 pi", "浏览"],
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
		slug: "dev-catalog-auto-update",
		labelKey: "settings.catalogAutoUpdate",
		keywords: ["模型目录", "目录自动更新", "自动更新", "pi-ai", "catalog", "auto update"],
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
		slug: "dev-standby-runtime",
		labelKey: "settings.standbyRuntimeEnabled",
		keywords: ["预热", "standby", "常驻进程", "启动加速", "运行时池", "prewarm"],
	},
	{
		tab: "dev",
		slug: "dev-clear-pi-check-flag",
		labelKey: "environment.clearCheckFlag",
		keywords: ["重置检测标记", "重新检测环境", "环境检测", "clear check flag"],
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
	{ tab: "common", slug: "common-tps-display-mode", labelKey: "settings.tpsDisplayMode", keywords: ["tps", "流式", "端到端", "生成速度", "streaming", "end-to-end", "throughput"] },
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
		slug: "common-process-group-display",
		labelKey: "settings.processGroupDisplay",
		keywords: ["过程组", "分组显示", "process group", "平铺", "实验特性"],
	},
	{
		tab: "common",
		slug: "common-reply-actions",
		labelKey: "settings.replyActions",
		keywords: ["回复操作", "快捷回复", "一键回复", "reply actions", "消息动作"],
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
		slug: "common-standby-runtime-enabled",
		labelKey: "settings.standbyRuntimeEnabled",
		keywords: ["预热", "standby", "常驻进程", "启动加速", "运行时池", "prewarm"],
	},
	{
		tab: "common",
		slug: "common-shell-context-menu",
		labelKey: "settings.shellContextMenu",
		keywords: ["右键菜单", "资源管理器", "context menu", "shell", "系统右键"],
	},
	{
		tab: "common",
		slug: "common-quick-task-menu",
		labelKey: "quickTask.menuTitle",
		keywords: ["快捷任务", "小任务", "右键发起", "资源管理器菜单", "quick task"],
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
	{
		tab: "common",
		slug: "common-floating-ball-enabled",
		labelKey: "settings.floatingBallEnabled",
		keywords: ["悬浮球", "浮动球", "常驻浮窗", "小圆点", "floating ball"],
	},
	{
		tab: "common",
		slug: "common-floating-ball-always-on-top",
		labelKey: "settings.floatingBallAlwaysOnTop",
		keywords: ["悬浮球置顶", "总是置顶", "浮窗层级", "always on top", "floating ball"],
	},
	{
		tab: "common",
		slug: "common-floating-ball-show-running-badge",
		labelKey: "settings.floatingBallShowRunningBadge",
		keywords: ["悬浮球角标", "运行中标记", "红点", "running badge", "floating ball"],
	},
	{
		tab: "common",
		slug: "common-floating-ball-snap-to-edge",
		labelKey: "settings.floatingBallSnapToEdge",
		keywords: ["悬浮球吸附", "贴边", "靠边停靠", "snap to edge", "floating ball"],
	},
	{
		tab: "common",
		slug: "common-floating-ball-expand-target",
		labelKey: "settings.floatingBallExpandTarget",
		keywords: ["悬浮球展开", "点开目标", "小任务浮窗", "工作台", "expand target", "floating ball"],
	},
	{
		tab: "common",
		slug: "common-cua-enabled",
		labelKey: "settings.cuaEnabled",
		keywords: ["cua", "桌面操作", "电脑操作", "模拟点击", "desktop automation"],
	},
	{
		tab: "common",
		slug: "common-cua-auto-approve",
		labelKey: "settings.cuaAutoApprove",
		keywords: ["自动审批", "免确认", "cua 审批", "auto approve", "绕过弹窗"],
	},
	{
		tab: "common",
		slug: "common-browser-agent-enabled",
		labelKey: "settings.browserAgentEnabled",
		keywords: ["浏览器 agent", "内置浏览器", "网页操作", "browser agent", "browser automation"],
	},
	{
		tab: "common",
		slug: "common-browser-agent-auto-approve",
		labelKey: "settings.browserAgentAutoApprove",
		keywords: ["浏览器免审批", "网页自动点击", "browser auto approve"],
	},
	{
		tab: "common",
		slug: "common-prompt-suggestion-enabled",
		labelKey: "settings.promptSuggestion.enabled",
		keywords: ["输入预测", "下一句", "输入建议", "候选输入", "prompt suggestion", "prediction"],
	},
	{
		tab: "common",
		slug: "common-selection-tool-enabled",
		labelKey: "settings.selectionTool.enabled",
		keywords: ["划词", "应用内划词", "选中文字", "划词浮钮", "selection tool", "translate selection"],
	},
	{
		tab: "common",
		slug: "common-selection-tool-agent",
		labelKey: "settings.selectionTool.defaultAgent",
		keywords: ["默认智能体", "划词智能体", "翻译智能体", "翻译官", "default agent", "selection agent"],
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
		slug: "appearance-wallpaper-engine",
		labelKey: "settings.wallpaperEngine",
		keywords: ["动态壁纸", "视频壁纸", "壁纸引擎", "wallpaper engine", "video wallpaper", "workshop"],
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
		slug: "appearance-scroll-on-send",
		labelKey: "settings.scrollToLatestOnSend",
		keywords: ["发送后滚动", "自动滚动", "回到底部", "滚动到最新", "scroll to bottom", "auto scroll", "send scroll"],
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
	{
		tab: "appearance",
		slug: "appearance-modules",
		labelKey: "settings.modules.title",
		keywords: ["隐藏模块", "功能模块", "隐藏", "显示模块", "hide", "modules", "收起", "dsh", "飞书", "桌宠", "生图", "功能提示", "响应提示", "tips", "定时任务", "智能体", "automation", "agents"],
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
		slug: "notification-unfocused-only",
		labelKey: "settings.alertOnlyWhenUnfocused",
		keywords: ["仅失焦提醒", "前台不提醒", "前台不响铃", "窗口焦点", "响铃打扰", "静音前台", "unfocused", "window focus", "quiet when focused"],
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
	{
		tab: "web",
		slug: "web-use-token-auth",
		labelKey: "settings.webUseTokenAuth",
		keywords: ["访问令牌", "token 鉴权", "密码保护", "web 鉴权", "access token"],
	},
	{
		tab: "web",
		slug: "web-fixed-token",
		labelKey: "settings.webFixedTokenLabel",
		keywords: ["固定令牌", "自定义令牌", "token 内容", "fixed token"],
	},
	{
		tab: "web",
		slug: "web-token-expires",
		labelKey: "settings.webTokenExpiresInLabel",
		keywords: ["令牌有效期", "token 过期", "多久过期", "token expires"],
	},
	{
		tab: "web",
		slug: "web-remote-access-guide",
		labelKey: "settings.remote.guideRowTitle",
		keywords: ["外网访问", "远程访问指南", "cloudflared", "tailscale", "穿透", "隧道"],
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
 * 命令面板实际消费的全量清单：设置项（本文件）+ 设置分区（settingsSectionAnchors.ts）。
 *
 * 用 `as const` 保留字面量元组类型（而不是直接标注 `readonly SettingsFieldAnchor[]`）：
 * 下面的 SettingsFieldAnchorSlug 要靠它推导出 slug 的字面量联合，标注成宽类型会把它
 * 退化成 string，深链的编译期校验随之失效。
 */
export const SETTINGS_FIELD_ANCHORS = [...SETTINGS_ROW_ANCHORS, ...SETTINGS_SECTION_ANCHORS] as const satisfies readonly SettingsFieldAnchor[];

/**
 * 全部锚点 slug 的字面量联合。
 *
 * 存在意义：让 `SettingsFocusTarget.section` 在**编译期**就拦住拼错的锚点。
 * 深链写错一个字符，运行时只会「页面滚到空气」——useSettingsFocus 找不到元素后
 * 2 秒静默放弃，既不报错也无提示，类型检查是唯一能在提交前发现它的关口。
 * （`satisfies` 同时保证 labelKey 必须是真实存在的 TranslationKey。）
 */
export type SettingsFieldAnchorSlug = (typeof SETTINGS_FIELD_ANCHORS)[number]["slug"];
