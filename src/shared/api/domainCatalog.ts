/**
 * 统一接口聚合层 · 域清单（DOMAIN_CATALOG）。
 *
 * 纯契约层：只描述「域 → 分组 / Manager / main 侧注册文件 / preload 命名空间 / 通道前缀」
 * 的静态映射，不 import 运行时代码。行数据由通道面探针推导（锚定数字见 TEST-PLAN §0），非手写臆测。
 * 守卫测试 tests/unifiedApiDomainCatalog.test.mjs
 * 校验：id 唯一且 kebab-case、62 行、每行 channelPrefix ⊆ shared/ipc.ts 实际 85 前缀、
 * 两表并集认领全部 85 前缀与 71 命名空间（F1-4/5/6）、红线行 aggregation === "redline"（F1-7）。
 * 2026-10-16 合并刷新：随 dev 演进补 acp/wechat/host-plugins/pideck-mcp/videogen/notice-history
 * 六行（+7 前缀 +6 命名空间，探针口径同 §0），sessions/config 收口组同步补新方法。
 *
 * 命名空间认领的唯一冻结例外（伴生行，F1-6 例外表）：settings 由 settings/web 两行认领
 * （web:status → settings.webServiceStatus，systemIpc.ts:1752）、sessions 由 sessions/dsh
 * 两行认领（dsh:* 与 dsh-runtime:* 的渲染面就是 sessions 命名空间的 DSH 方法组）。
 * ipcFile 为 src/main/ 内相对路径，多对多（一个前缀的 handler 可能分布在多个文件）。
 */
import type { DomainCatalogEntry } from "./domainTypes";

export const DOMAIN_CATALOG = [
	// ── core ────────────────────────────────────────────────────────────────────
	// 裁决：standby 预热池（例外三，StandbyAgentPool，AgentManager 内部，开关 settings.standbyRuntimeEnabled）
	// 与模型快照端点（例外二，ModelTraceServer，数据只落本地日志与 modelTrace:* 只读入口）
	// 宿主于 pi 运行时域，无独立通道前缀/命名空间；红线含义 = 门面只透传、禁止扩成通用
	// pi/模型 API 桥（AGENTS.md 核心边界）。
	{ id: "pi", group: "core", manager: "AgentManager（pi RPC 运行时宿主；pi 安装/路径检查面注册在 systemIpc.ts）", ipcFile: ["systemIpc.ts"], preloadNamespaces: ["pi"], channelPrefix: ["pi"], aggregation: "redline" },
	// 裁决：agents:* 运行时事件
	// 总线经 sessions:runtime-event 信封（sourceChannel 字段）推送给 sessions.onRuntimeEvent，
	// 故 agents 前缀由本行认领；例外 agents:rpc-log 由 rpc-logs 行认领。
	{
		id: "sessions",
		group: "core",
		subdomains: ["catalog", "runtime", "import", "rewind"],
		manager: "SessionCatalog + SessionScanner + SessionRuntimeCoordinator + SessionFileEditor/SessionHistoryReader/RewindCheckpointCoordinator",
		ipcFile: ["ipc/sessionIpc.ts", "index.ts"],
		preloadNamespaces: ["sessions"],
		channelPrefix: ["sessions", "agents"],
		aggregation: "consolidate",
	},
	// 裁决（伴生行）：DSH 插件体系红线（RESEARCH §4.7：DSH 域既有能力，非 PiDeck 自有扩展
	// 点，禁止当作 PiDeck 扩展机制暴露）。dsh:* 与 dsh-runtime:* 共 50 通道的渲染面是 sessions
	// 命名空间的 DSH 方法组（preload 的 sessions.*Dsh* 方法），无独立命名空间，故本行伴生
	// 认领 sessions（F1-6 冻结例外表）；红线 = 门面不聚合、只透传 sessions 引用。
	{ id: "dsh", group: "core", manager: "DshHost + DshAgentManager + DshApiClient + DshPluginInstallService + DshRuntimeInstaller/DshRuntimeManager", ipcFile: ["ipc/sessionIpc.ts"], preloadNamespaces: ["sessions"], channelPrefix: ["dsh", "dsh-runtime"], aggregation: "redline" },
	{ id: "security", group: "core", manager: "SecurityStore", ipcFile: ["ipc/securityIpc.ts"], preloadNamespaces: ["security"], channelPrefix: ["security"], aggregation: "aggregate" },
	{ id: "system", group: "core", manager: "系统信息与运行时检查（systemIpc 汇聚面）", ipcFile: ["ipc/systemIpc.ts"], preloadNamespaces: ["system"], channelPrefix: ["system"], aggregation: "aggregate" },
	// 裁决：ipcChannels.appGetChannel 的值是 "update:get-channel"（键名与通道域前缀不一致，
	// 命名沿用不纠正 R4），update 前缀由本行认领；renderer:log → app.rendererLog；
	// preload:ready/preload:error 为 preload→main 生命周期信号（systemIpc.ts 消费），非渲染面方法。
	{ id: "app", group: "core", manager: "应用生命周期（systemIpc 汇聚面）", ipcFile: ["ipc/systemIpc.ts"], preloadNamespaces: ["app"], channelPrefix: ["app", "update", "renderer", "preload"], aggregation: "aggregate" },
	{ id: "logs", group: "core", manager: "AppLogger", ipcFile: ["ipc/systemIpc.ts"], preloadNamespaces: ["logs"], channelPrefix: ["logs"], aggregation: "aggregate" },
	{ id: "rpc-logs", group: "core", manager: "RpcLogger + ModelTraceStore + RpcLogLiveBroadcaster", ipcFile: ["ipc/systemIpc.ts"], preloadNamespaces: ["rpcLogs"], channelPrefix: ["rpc-logs"], aggregation: "aggregate" },
	// ── workspace ───────────────────────────────────────────────────────────────
	{ id: "projects", group: "workspace", manager: "ProjectStore", ipcFile: ["ipc/projectsIpc.ts", "ipc/systemIpc.ts"], preloadNamespaces: ["projects"], channelPrefix: ["projects", "user-data-migration"], aggregation: "aggregate" },
	{ id: "project-resources", group: "workspace", manager: "ProjectResourceManager", ipcFile: ["ipc/projectResourceIpc.ts"], preloadNamespaces: ["projectResources"], channelPrefix: ["project-resources"], aggregation: "aggregate" },
	{ id: "git", group: "workspace", manager: "GitService + WorktreeService + GitRefsWatcher", ipcFile: ["ipc/gitIpc.ts"], preloadNamespaces: ["git"], channelPrefix: ["git"], aggregation: "aggregate" },
	{ id: "terminal", group: "workspace", manager: "TerminalSessionManager", ipcFile: ["ipc/terminalIpc.ts"], preloadNamespaces: ["terminal"], channelPrefix: ["terminal"], aggregation: "aggregate" },
	{ id: "editors", group: "workspace", manager: "外部编辑器检测", ipcFile: ["ipc/editorsIpc.ts"], preloadNamespaces: ["editors"], channelPrefix: ["editors"], aggregation: "aggregate" },
	{ id: "browser", group: "workspace", manager: "main/browser/（webview 宿主与导航白名单）", ipcFile: ["ipc/filesIpc.ts"], preloadNamespaces: ["browser"], channelPrefix: ["browser"], aggregation: "aggregate" },
	{ id: "files", group: "workspace", manager: "文件抽屉读写", ipcFile: ["ipc/filesIpc.ts"], preloadNamespaces: ["files"], channelPrefix: ["files"], aggregation: "aggregate" },
	// 基线补齐：local-image 通道与 localImage 命名空间（Markdown 图片保存/复制走 IPC 读字节，
	// 避免 fetch pideck-file:// 被拦）在 2026-10-20 的 markdown 重构提交已落地，但域清单漏行，
	// F1-4/F1-6 反向闭合在 dev 上常红；本行只做认领，不改任何运行时行为。
	{ id: "local-image", group: "workspace", manager: "本地图片字节读取（Markdown 图片保存/复制）", ipcFile: ["ipc/localImageIpc.ts"], preloadNamespaces: ["localImage"], channelPrefix: ["local-image"], aggregation: "aggregate" },
	{ id: "clipboard", group: "workspace", manager: "剪贴板（sendSync 同步读）", ipcFile: ["ipc/clipboardIpc.ts"], preloadNamespaces: ["clipboard"], channelPrefix: ["clipboard"], aggregation: "aggregate" },
	{ id: "paste-files", group: "workspace", manager: "粘贴文件收集", ipcFile: ["ipc/pasteFilesIpc.ts"], preloadNamespaces: ["pasteFiles"], channelPrefix: ["paste-files"], aggregation: "aggregate" },
	{ id: "wsl", group: "workspace", manager: "WslPaths", ipcFile: ["ipc/systemIpc.ts"], preloadNamespaces: ["wsl"], channelPrefix: ["wsl"], aggregation: "aggregate" },
	{ id: "data-env", group: "workspace", manager: "数据环境（userData 目录切换）", ipcFile: ["ipc/dataEnvIpc.ts"], preloadNamespaces: ["dataEnv"], channelPrefix: ["data-env"], aggregation: "aggregate" },
	{ id: "resource-import", group: "workspace", manager: "资源导入", ipcFile: ["ipc/resourceImportIpc.ts"], preloadNamespaces: ["resourceImport"], channelPrefix: ["resource-import"], aggregation: "aggregate" },
	{ id: "quick-task", group: "workspace", manager: "QuickTaskController", ipcFile: ["ipc/quickTaskIpc.ts"], preloadNamespaces: ["quickTask"], channelPrefix: ["quick-task"], aggregation: "aggregate" },
	{ id: "scratch-pad", group: "workspace", manager: "便签（ScratchPadStore）", ipcFile: ["ipc/scratchPadIpc.ts"], preloadNamespaces: ["scratchPad"], channelPrefix: ["scratch-pad"], aggregation: "aggregate" },
	{ id: "shell-menu", group: "workspace", manager: "Shell 上下文菜单", ipcFile: ["ipc/shellMenuIpc.ts"], preloadNamespaces: ["shellMenu"], channelPrefix: ["shell-menu"], aggregation: "aggregate" },
	// 裁决：pickBackgroundImage/removeBackgroundImage 的值域是 backgrounds:*（backgroundsIpc.ts），
	// dialog:pick-files 在 filesIpc.ts，两者同由 dialog 命名空间消费，故 backgrounds 前缀归本行。
	// wallpaper-engine:*（选工坊目录/列表/校验）同属壁纸选择、同由 dialog 命名空间消费，一并归本行。
	{ id: "dialog", group: "workspace", manager: "系统文件选择器（无独立 Manager，dialog 命名空间消费）", ipcFile: ["ipc/filesIpc.ts", "ipc/backgroundsIpc.ts", "ipc/wallpaperEngineIpc.ts"], preloadNamespaces: ["dialog"], channelPrefix: ["dialog", "backgrounds", "wallpaper-engine"], aggregation: "aggregate" },
	{ id: "reply-actions", group: "workspace", manager: "快捷回复动作", ipcFile: ["ipc/replyActionsIpc.ts"], preloadNamespaces: ["replyActions"], channelPrefix: ["reply-actions"], aggregation: "aggregate" },
	// ── content ─────────────────────────────────────────────────────────────────
	{ id: "prompts", group: "content", manager: "PromptManager + XuePromptManager", ipcFile: ["ipc/storeIpc.ts"], preloadNamespaces: ["prompts"], channelPrefix: ["prompts"], aggregation: "aggregate" },
	{ id: "prompt-store", group: "content", manager: "promptStoreUpdater（提示词模板检索与导入）", ipcFile: ["ipc/storeIpc.ts"], preloadNamespaces: ["promptStore"], channelPrefix: ["prompt-store"], aggregation: "aggregate" },
	{ id: "yao-prompts", group: "content", manager: "YaoPromptsService", ipcFile: ["ipc/storeIpc.ts"], preloadNamespaces: ["yaoPrompts"], channelPrefix: ["yao-prompts"], aggregation: "aggregate" },
	{ id: "skills", group: "content", manager: "SkillManager + skillStoreUpdater", ipcFile: ["ipc/systemIpc.ts"], preloadNamespaces: ["skills"], channelPrefix: ["skills"], aggregation: "aggregate" },
	// 裁决（RESEARCH 勘误）：skill-store:* 2 通道由 skillStore 独立命名空间承载，handler 在
	// storeIpc.ts（skillStoreSearch/skillStoreImport），与 content-store 行（prompts-store/skills-store
	// 两通道域，handler 在 contentStoreIpc.ts）是两条不同通道域，不得混入 contentStore 命名空间。
	{ id: "skill-store", group: "content", manager: "skillStoreUpdater（技能商店条目检索与导入）", ipcFile: ["ipc/storeIpc.ts"], preloadNamespaces: ["skillStore"], channelPrefix: ["skill-store"], aggregation: "aggregate" },
	{ id: "skill-hub", group: "content", manager: "SkillHub 检索与安装", ipcFile: ["ipc/storeIpc.ts"], preloadNamespaces: ["skillHub"], channelPrefix: ["skill-hub"], aggregation: "aggregate" },
	{ id: "content-store", group: "content", manager: "BuiltinContentUpdater（prompts-store/skills-store 两通道域共用同一更新器）", ipcFile: ["ipc/contentStoreIpc.ts"], preloadNamespaces: ["contentStore"], channelPrefix: ["prompts-store", "skills-store"], aggregation: "aggregate" },
	{ id: "extensions", group: "content", manager: "ExtensionManager + BuiltInExtensionsUpdater", ipcFile: ["ipc/storeIpc.ts", "ipc/builtInExtensionIpc.ts"], preloadNamespaces: ["extensions"], channelPrefix: ["extensions"], aggregation: "aggregate" },
	// 收藏：PiDeck 本地快照（<userData>/favorites.json），不动会话文件、不是 pi 能力，
	// 因此按普通内容域聚合；正文只在收藏动作发生时由渲染层快照提交。
	{ id: "favorites", group: "content", manager: "FavoritesStore（<userData>/favorites.json）", ipcFile: ["ipc/favoritesIpc.ts"], preloadNamespaces: ["favorites"], channelPrefix: ["favorites"], aggregation: "aggregate" },
	{ id: "imagegen", group: "content", manager: "ImagegenService + 三个图存储 Store", ipcFile: ["ipc/imagegenIpc.ts"], preloadNamespaces: ["imagegen"], channelPrefix: ["imagegen"], aggregation: "aggregate" },
	{ id: "videogen", group: "content", manager: "VideoJobRunner + IlinkClient + VideoJobStore/VideoBlobStore/VideoSessionStore/VideoGenConfigStore", ipcFile: ["ipc/videogenIpc.ts"], preloadNamespaces: ["videogen"], channelPrefix: ["videogen"], aggregation: "aggregate" },
	// ── config ──────────────────────────────────────────────────────────────────
	{ id: "settings", group: "config", manager: "SettingsStore + VisionBridgeConfigManager", ipcFile: ["ipc/systemIpc.ts"], preloadNamespaces: ["settings"], channelPrefix: ["settings"], aggregation: "aggregate" },
	// 裁决：config 行认领 config/mcp/pi-resources/vision 四前缀（config 命名空间 47 方法 =
	// config:35 + mcp:4 + pi-resources:2 + vision:6）；config-backup 前缀与 configBackups
	// 命名空间（7 方法）归 config-backup 行，不进本行（F1-6 双认领违例）。
	{
		id: "config",
		group: "config",
		manager: "ConfigManager + ConfigBackupManager + PiResourceConfigService + TokenDance 三 Store",
		ipcFile: ["ipc/systemIpc.ts", "ipc/backupIpc.ts", "ipc/visionIpc.ts"],
		preloadNamespaces: ["config"],
		channelPrefix: ["config", "mcp", "pi-resources", "vision"],
		aggregation: "consolidate",
	},
	{ id: "config-backup", group: "config", manager: "ConfigBackupManager", ipcFile: ["ipc/backupIpc.ts"], preloadNamespaces: ["configBackups"], channelPrefix: ["config-backup"], aggregation: "aggregate" },
	{ id: "custom-themes", group: "config", manager: "自定义主题包读写", ipcFile: ["ipc/themesIpc.ts"], preloadNamespaces: ["customThemes"], channelPrefix: ["themes"], aggregation: "aggregate" },
	{ id: "catalog", group: "config", manager: "PiAiCatalogUpdater（模型目录更新，分支白名单 main/dev）", ipcFile: ["ipc/catalogIpc.ts"], preloadNamespaces: ["catalog"], channelPrefix: ["catalog"], aggregation: "aggregate" },
	{ id: "pi-auth", group: "config", manager: "PiAuthService（NDJSON 子进程 pi-auth-host.mjs）", ipcFile: ["ipc/piAuthIpc.ts"], preloadNamespaces: ["piAuth"], channelPrefix: ["pi-auth"], aggregation: "redline" },
	// ── integration ─────────────────────────────────────────────────────────────
	{ id: "feishu", group: "integration", manager: "FeishuBridge/FeishuConnection/CardStream", ipcFile: ["ipc/feishuIpc.ts"], preloadNamespaces: ["feishu"], channelPrefix: ["feishu"], aggregation: "aggregate" },
	// 裁决（伴生行）：web:status → settings.webServiceStatus（systemIpc.ts:1752）、
	// settings:restart-web-service 同属 settings 命名空间，故 web 前缀由本行认领、
	// 命名空间伴生认领 settings（F1-6 冻结例外表）。
	{ id: "web", group: "integration", manager: "WebServiceManager + WebEventStream/WebWorkspaceRoutes/WebI18n/WebNetwork", ipcFile: ["ipc/systemIpc.ts"], preloadNamespaces: ["settings"], channelPrefix: ["web"], aggregation: "aggregate" },
	{ id: "enhance", group: "integration", manager: "EnhancePromptService（常驻 sidecar pi-enhance-host.mjs）", ipcFile: ["ipc/enhanceIpc.ts"], preloadNamespaces: ["enhance"], channelPrefix: ["enhance"], aggregation: "redline" },
	// 裁决：输入预测（suggest:*）。与 enhance 同一侧车协议但**独立实例**（AGENTS.md 例外四：
	// 三个消费者共享「新 run 打断旧 run」语义，共用实例会让预测打断增强），因此单独一行、
	// 单独 redline：systemPrompt/userText 只由主进程常量注入，渲染层禁传。
	{ id: "prompt-suggestion", group: "integration", manager: "EnhancePromptService（prompt-suggestion 独立实例，systemPrompt 由主进程常量注入）", ipcFile: ["ipc/promptSuggestionIpc.ts"], preloadNamespaces: ["suggestion"], channelPrefix: ["suggest"], aggregation: "redline" },
	// 裁决：智能体（AgentProfileStore + AgentInvokeService）。一次性调用复用 enhance 侧车
	// 协议但走独立 EnhancePromptService 实例（AGENTS.md 例外四）：systemPrompt 只由主进程按
	// agentId 解析、渲染层禁传；本行按普通域聚合（配置 CRUD + 市场设置 + 一次性调用入口），
	// invoke 通道的红线约束由 AGENTS.md 例外四与 agentInvokeIpc 边界校验兜住，不扩成通用模型桥。
	{
		id: "agent-profiles",
		group: "integration",
		manager: "AgentProfileStore + AgentInvokeService（划词工具一次性调用，复用 pi-enhance-host sidecar 独立实例）",
		ipcFile: ["ipc/agentProfileIpc.ts", "ipc/agentInvokeIpc.ts"],
		preloadNamespaces: ["agentProfiles"],
		channelPrefix: ["agent-profiles"],
		aggregation: "aggregate",
	},
	// 裁决：系统级划词浮窗（SelectionToolWindow + SelectionToolService）。独立 BrowserWindow
	// 复用主 preload（同一份 desktopApi），凭据/模型调用都走 agent-profiles:invoke 既有红线通道；
	// 本行只认领浮窗自身的状态/隐藏/回填通道，不做任何聚合扩展。
	{ id: "selection-tool", group: "integration", manager: "SelectionToolService + SelectionToolWindow（全局快捷键 + 系统级划词浮窗）", ipcFile: ["ipc/selectionToolIpc.ts"], preloadNamespaces: ["selectionTool"], channelPrefix: ["selection-tool"], aggregation: "aggregate" },
	{ id: "channel-switch", group: "integration", manager: "ChannelSwitchService + UpdateService（更新通道切换）", ipcFile: ["ipc/channelSwitchIpc.ts"], preloadNamespaces: ["channelSwitch"], channelPrefix: ["channel-switch"], aggregation: "aggregate" },
	{ id: "cua", group: "integration", manager: "CuaEngine + CuaGate + McpHttpHost + CuaService", ipcFile: ["ipc/cuaIpc.ts"], preloadNamespaces: ["cua"], channelPrefix: ["cua"], aggregation: "aggregate" },
	{ id: "usage-stats", group: "integration", manager: "用量统计", ipcFile: ["ipc/usageStatsIpc.ts"], preloadNamespaces: ["usageStats"], channelPrefix: ["usage-stats"], aggregation: "aggregate" },
	{ id: "voice-transcription", group: "integration", manager: "语音转写（5 类协作组件）", ipcFile: ["ipc/voiceTranscriptionIpc.ts"], preloadNamespaces: ["voiceTranscription"], channelPrefix: ["voice-transcription"], aggregation: "aggregate" },
	{ id: "automation", group: "integration", manager: "AutomationStore + AutomationScheduler + RunCoordinator", ipcFile: ["ipc/automationIpc.ts"], preloadNamespaces: ["automation"], channelPrefix: ["automation"], aggregation: "aggregate" },
	{ id: "acp", group: "integration", manager: "AcpAgentManager + AcpConnection/AcpProcessHost + AcpMessageSnapshotStore（外部 ACP CLI agent 接入）", ipcFile: ["ipc/acpIpc.ts"], preloadNamespaces: ["acp"], channelPrefix: ["acp"], aggregation: "aggregate" },
	{ id: "wechat", group: "integration", manager: "WeChatBridge + WeChatService/WeChatLogin", ipcFile: ["ipc/wechatIpc.ts"], preloadNamespaces: ["wechat"], channelPrefix: ["wechat"], aggregation: "aggregate" },
	{ id: "host-plugins", group: "integration", manager: "HostPluginManager + HostPluginService + HostPluginWebviewBridge", ipcFile: ["ipc/hostPluginsIpc.ts"], preloadNamespaces: ["hostPlugins"], channelPrefix: ["host-plugin", "host-plugins"], aggregation: "aggregate" },
	{ id: "pideck-mcp", group: "integration", manager: "PiDeckMcpService（PiDeck 对外 MCP 服务）", ipcFile: ["ipc/piDeckMcpIpc.ts"], preloadNamespaces: ["piDeckMcp"], channelPrefix: ["pideck-mcp"], aggregation: "aggregate" },
	// ── shell ───────────────────────────────────────────────────────────────────
	{ id: "pet", group: "shell", manager: "PetSystem + PetWindow/PetPackageManager/PetPatrol/PetStateBridge", ipcFile: ["pet/index.ts", "index.ts"], preloadNamespaces: ["pet"], channelPrefix: ["pet"], aggregation: "aggregate" },
	{ id: "floating-ball", group: "shell", manager: "FloatingController", ipcFile: ["ipc/floatingIpc.ts"], preloadNamespaces: ["floatingBall"], channelPrefix: ["floating-ball"], aggregation: "aggregate" },
	{ id: "mini-overlay", group: "shell", manager: "MiniOverlayWindow", ipcFile: ["floating/MiniOverlayWindow.ts"], preloadNamespaces: ["miniOverlay"], channelPrefix: ["mini-overlay"], aggregation: "aggregate" },
	{ id: "sounds", group: "shell", manager: "音效（自定义音效导入/删除）", ipcFile: ["ipc/soundIpc.ts"], preloadNamespaces: ["sounds"], channelPrefix: ["sounds"], aggregation: "aggregate" },
	{ id: "announcements", group: "shell", manager: "AnnouncementService", ipcFile: ["ipc/announcementIpc.ts"], preloadNamespaces: ["announcements"], channelPrefix: ["announcement"], aggregation: "aggregate" },
	{ id: "quick-messages", group: "shell", manager: "快捷消息", ipcFile: ["ipc/quickMessagesIpc.ts"], preloadNamespaces: ["quickMessages"], channelPrefix: ["quick-messages"], aggregation: "aggregate" },
	{ id: "notice-history", group: "shell", manager: "NoticeHistoryStore（公告已读历史）", ipcFile: ["ipc/noticeHistoryIpc.ts"], preloadNamespaces: ["noticeHistory"], channelPrefix: ["notice-history"], aggregation: "aggregate" },
] as const satisfies readonly DomainCatalogEntry[];

export type DomainId = (typeof DOMAIN_CATALOG)[number]["id"];
