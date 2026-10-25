import type { SettingsFieldAnchor } from "./settingsFieldAnchors";

/**
 * 设置页「分区级」锚点清单 —— 命令面板（Ctrl+P）的「搜到一整块设置就跳过去」。
 *
 * 与 `settingsFieldAnchors.ts` 里的「单个设置项」是互补的两种粒度：
 *   - 设置项级（SettingRow 的 anchor）：用户明确知道自己在找哪个开关；
 *   - 分区级（SettingsSection 的 id，本文件）：用户只记得**功能名**
 *     （「闲置 Agent 内存优化」「CUA 桌面操作」「提示词增强」），不记得它在哪个 tab。
 *     新功能往往一次落成一整块设置，只登记设置项的话，这类方块在搜索里完全不存在。
 *
 * 登记规则：`slug` 必须对应源码里 `SettingsSection` 的 `id="settings-section-<slug>"`。
 * 例外只有一种 —— 分区标题与它所在 tab 同名时（Git、配置备份）不登记：
 * tab 级入口已经能把用户带到同一页，再放一条同名结果只会让搜索结果出现两条一样的标题
 * （例外清单见 `tests/settingsFieldAnchors.test.mjs` 的 SECTION_ID_EXEMPTIONS）。
 *
 * 该文件与设置项清单一样是**静态**的：设置页各 tab 懒渲染（同时只挂载一个），
 * 运行时收集只能看到当前 tab 的项，而命令面板要能搜到任意 tab 里的项。
 */
export const SETTINGS_SECTION_ANCHORS = [
	{ tab: "appearance", slug: "appearance-theme-background", labelKey: "settings.sectionThemeBackground", keywords: ["主题", "背景", "背景图", "深色", "浅色", "theme", "background", "dark"] },
	{ tab: "appearance", slug: "appearance-fonts", labelKey: "settings.sectionFonts", keywords: ["字体", "字号", "界面字体", "font", "font size"] },
	{ tab: "appearance", slug: "appearance-chat-layout", labelKey: "settings.sectionChatLayout", keywords: ["聊天排版", "消息排版", "行距", "正文宽度", "chat layout", "spacing"] },
	{ tab: "appearance", slug: "appearance-window-style", labelKey: "settings.sectionWindowStyle", keywords: ["窗口样式", "标题栏", "圆角", "window style", "title bar"] },
	{ tab: "appearance", slug: "appearance-composer-features", labelKey: "settings.composer.title", keywords: ["输入框功能", "输入框工具", "输入框按钮", "输入框底栏", "模式选择器", "composer"] },
	{ tab: "common", slug: "common-session", labelKey: "settings.sectionSession", keywords: ["会话设置", "会话列表", "session"] },
	{ tab: "common", slug: "common-quick-messages-section", labelKey: "settings.quickMessagesSection", keywords: ["快捷消息", "常用语", "预设短语", "quick messages"] },
	{ tab: "common", slug: "common-reply-actions-section", labelKey: "settings.replyActionsSection", keywords: ["回复快捷操作", "回复动作", "reply actions"] },
	{ tab: "common", slug: "common-idle-agent", labelKey: "settings.idleAgentSection", keywords: ["闲置 agent", "内存优化", "内存占用", "idle agent", "memory"] },
	{ tab: "common", slug: "common-floating-ball", labelKey: "settings.floatingBallSection", keywords: ["悬浮球", "桌面悬浮", "floating ball"] },
	{ tab: "common", slug: "common-cua", labelKey: "settings.cuaSection", keywords: ["cua", "桌面操作", "电脑操作", "自动操作", "computer use"] },
	{ tab: "common", slug: "common-browser-agent", labelKey: "settings.browserAgentSection", keywords: ["浏览器 agent", "浏览器操作", "内置浏览器操作", "网页操作", "browser agent", "browser automation"] },
	{ tab: "common", slug: "common-shell-integration", labelKey: "settings.shellContextMenuSection", keywords: ["右键菜单", "资源管理器", "文件夹右键", "context menu", "explorer"] },
	{ tab: "common", slug: "common-window", labelKey: "settings.sectionWindow", keywords: ["窗口", "托盘", "关闭行为", "window", "tray"] },
	{ tab: "common", slug: "common-prompt-enhance", labelKey: "settings.enhance.section", keywords: ["提示词增强", "提示词优化", "prompt 增强", "enhance"] },
	{ tab: "common", slug: "common-prompt-suggestion", labelKey: "settings.promptSuggestion.section", keywords: ["输入预测", "下一句", "候选输入", "输入建议", "prompt suggestion", "prediction"] },
	{ tab: "common", slug: "common-selection-tool", labelKey: "settings.selectionTool.title", keywords: ["划词", "划词翻译", "选中文字", "翻译浮钮", "selection tool", "translate selection"] },
	{ tab: "common", slug: "common-voice-input", labelKey: "voice.settings.title", keywords: ["语音输入", "语音转写", "录音", "voice", "speech"] },
	{ tab: "notification", slug: "notification-channels", labelKey: "settings.notificationSection", keywords: ["通知", "系统通知", "事件通知", "notification"] },
	{ tab: "notification", slug: "notification-in-app", labelKey: "settings.inAppNotificationSection", keywords: ["应用内通知", "站内通知", "in-app notification"] },
	{ tab: "notification", slug: "notification-sound", labelKey: "settings.sound.title", keywords: ["声音提醒", "提示音", "sound", "audio"] },
	{ tab: "notification", slug: "notification-sound-events", labelKey: "settings.sound.eventsTitle", keywords: ["提醒事件", "声音事件", "哪些事件响", "events"] },
	{ tab: "notification", slug: "notification-sound-custom", labelKey: "settings.sound.customTitle", keywords: ["自定义音频", "自定义提示音", "音频文件", "custom sound"] },
	{ tab: "shortcuts", slug: "shortcuts-general", labelKey: "settings.shortcuts.groupGeneral", keywords: ["快捷键", "按键", "热键", "通用", "keybinding"] },
	{ tab: "shortcuts", slug: "shortcuts-dev", labelKey: "settings.shortcuts.groupDev", keywords: ["快捷键", "按键", "热键", "开发者", "keybinding", "dev"] },
	{ tab: "terminal", slug: "terminal-appearance", labelKey: "settings.terminal.appearance", keywords: ["终端配色", "终端主题", "光标", "配色与布局", "terminal theme"] },
	{ tab: "terminal", slug: "terminal-font", labelKey: "settings.terminal.font", keywords: ["终端字体", "终端字号", "font"] },
	{ tab: "terminal", slug: "terminal-behavior", labelKey: "settings.terminal.behavior", keywords: ["终端行为", "复制粘贴", "behavior"] },
	{ tab: "terminal", slug: "terminal-startup", labelKey: "settings.terminal.startup", keywords: ["终端启动", "启动命令", "初始命令", "startup", "shell"] },
	{ tab: "proxy", slug: "proxy-pi-agent", labelKey: "settings.piProxy", keywords: ["pi 代理", "agent 代理", "模型代理", "pi proxy"] },
	{ tab: "proxy", slug: "proxy-desktop", labelKey: "settings.desktopProxy", keywords: ["桌面端代理", "应用代理", "desktop proxy"] },
	{ tab: "pet", slug: "pet-preview", labelKey: "settings.pet.preview", keywords: ["动画预览", "预览", "宠物动画", "preview", "animation"] },
	{ tab: "vision", slug: "vision-general", labelKey: "settings.vision.section", keywords: ["视觉桥", "图片识别", "视觉", "vision bridge", "multimodal"] },
	{ tab: "vision", slug: "vision-config-file", labelKey: "settings.vision.configFile", keywords: ["视觉桥配置文件", "配置文件位置", "config file"] },
	{ tab: "vision", slug: "vision-logs", labelKey: "settings.vision.logSection", keywords: ["视觉桥日志", "运行记录", "诊断", "logs", "diagnostics"] },
	{ tab: "web", slug: "web-local-service", labelKey: "settings.webLocalService", keywords: ["局域网 web 服务", "端口", "webserver", "port", "lan"] },
	{ tab: "web", slug: "web-remote-access", labelKey: "settings.remote.title", keywords: ["外网访问", "远程访问", "内网穿透", "隧道", "tunnel", "remote"] },
	{ tab: "backup", slug: "backup-list", labelKey: "settings.backup.listTitle", keywords: ["备份列表", "快照", "恢复配置", "backup list", "snapshot", "restore"] },
	{ tab: "usage", slug: "usage-overview", labelKey: "usageStats.cards.title", keywords: ["累计概览", "总用量", "统计概览", "overview"] },
	{ tab: "usage", slug: "usage-heatmap", labelKey: "usageStats.heatmap.title", keywords: ["活跃热力图", "热力图", "活跃度", "heatmap"] },
	{ tab: "usage", slug: "usage-daily", labelKey: "usageStats.daily.title", keywords: ["每日用量", "按天", "daily"] },
	{ tab: "usage", slug: "usage-models", labelKey: "usageStats.models.title", keywords: ["模型用量", "按模型", "model usage"] },
	{ tab: "usage", slug: "usage-projects", labelKey: "usageStats.projects.title", keywords: ["项目用量", "按项目", "project usage"] },
	{ tab: "dev", slug: "dev-environment", labelKey: "settings.environment", keywords: ["环境", "环境检测", "environment"] },
	{ tab: "dev", slug: "dev-catalog", labelKey: "settings.catalogSectionTitle", keywords: ["模型目录", "目录", "catalog"] },
	{ tab: "dev", slug: "dev-updates", labelKey: "settings.sectionUpdates", keywords: ["版本与更新", "更新", "升级", "updates"] },
	{ tab: "dev", slug: "dev-data-env", labelKey: "settings.dataEnvSectionTitle", keywords: ["数据环境", "数据目录", "data"] },
	{ tab: "dev", slug: "dev-runtime", labelKey: "settings.sectionRuntime", keywords: ["运行", "运行时", "runtime"] },
	{ tab: "dev", slug: "dev-debug", labelKey: "settings.debug", keywords: ["调试", "debug"] },
	{ tab: "dev", slug: "dev-privacy", labelKey: "settings.privacy", keywords: ["隐私", "遥测", "privacy", "telemetry"] },
	{ tab: "storage", slug: "storage-items", labelKey: "settings.storage.items", keywords: ["清理项", "清理缓存", "清理", "释放空间", "缓存", "临时数据", "cleanup items", "storage actions"] },
	{ tab: "storage", slug: "storage-rpc-logs", labelKey: "settings.storage.rpcLogs", keywords: ["rpc 日志", "日志", "rpc logs"] },
	{ tab: "storage", slug: "storage-paste-files", labelKey: "settings.storage.pasteFiles", keywords: ["粘贴文件", "临时文件", "图片缓存", "paste files"] },
	{ tab: "storage", slug: "storage-notice-history", labelKey: "settings.storage.noticeHistory", keywords: ["通知历史", "公告历史", "notice history"] },
	{ tab: "storage", slug: "storage-app-logs", labelKey: "settings.storage.appLogs", keywords: ["应用日志", "日志文件", "app logs"] },
] as const satisfies readonly SettingsFieldAnchor[];
