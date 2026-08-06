export const ipcChannels = {
	projectsList: "projects:list",
	projectsAdd: "projects:add",
	projectsRemove: "projects:remove",
	projectsReorder: "projects:reorder",
	projectsChanged: "projects:changed",
	projectResourcesList: "project-resources:list",
	projectResourcesCreateSkill: "project-resources:create-skill",
	projectResourcesDeleteSkill: "project-resources:delete-skill",
	projectResourcesToggleSkill: "project-resources:toggle-skill",
	projectResourcesDeleteExtension: "project-resources:delete-extension",
	projectResourcesToggleExtension: "project-resources:toggle-extension",
	projectResourcesRenameSkill: "project-resources:rename-skill",
	projectsListRoot: "projects:list-root",
	projectsListWorktreeChildren: "projects:list-worktree-children",
	projectsToggleWorktreeEnabled: "projects:toggle-worktree-enabled",
	// 选择聊天记录目录（系统文件选择器，默认当前聊天目录）
	projectsChooseChatPath: "projects:choose-chat-path",
	// 设置聊天记录目录并持久化
	projectsSetChatPath: "projects:set-chat-path",
	editorsList: "editors:list",
	editorsRedetect: "editors:redetect",
	editorsUpdate: "editors:update",
	editorsChooseExecutable: "editors:choose-executable",
	editorsOpenProject: "editors:open-project",
	filesList: "files:list",
	filesOpen: "files:open",
	filesShowInFolder: "files:show-in-folder",
	filesReadContent: "files:read-content",
	filesWriteContent: "files:write-content",
	filesCreate: "files:create",
	filesDelete: "files:delete",
	filesRename: "files:rename",
	/** 复制来源路径到目标目录（支持文件和目录递归） */
	filesCopy: "files:copy",
	/** 移动来源路径到目标目录（同设备 rename，跨设备 cp+rm） */
	filesMove: "files:move",
	/** 读取文件返回 base64 编码的数据 URL，用于图片等二进制文件 */
	filesReadBase64: "files:read-base64",
	sessionsList: "sessions:list",
	/** Session-first catalog APIs. */
	sessionsCatalogList: "sessions:catalog-list",
	/** 后台扫描完成后主进程 → 渲染层的推送（目录缓存已合并，渲染层应重新拉取）。 */
	sessionsCatalogRefreshed: "sessions:catalog-refreshed",
	sessionsCatalogCreateDraft: "sessions:catalog-create-draft",
	/** Starts an in-memory `--no-session` conversation. */
	sessionsCreateAnonymous: "sessions:create-anonymous",
	sessionsCatalogUpdate: "sessions:catalog-update",
	sessionsCatalogDelete: "sessions:catalog-delete",
	sessionsCatalogReadMessages: "sessions:catalog-read-messages",
	sessionsCatalogReadMessagePage: "sessions:catalog-read-message-page",
	sessionsCatalogReadReferenceMessages: "sessions:catalog-read-reference-messages",
	sessionsCatalogCopy: "sessions:catalog-copy",
	sessionsCatalogExportHtml: "sessions:catalog-export-html",
	sessionsSendPrompt: "sessions:send-prompt",
	sessionsRuntimeEvent: "sessions:runtime-event",
	sessionsUiResponse: "sessions:ui-response",
	sessionsRuntimeList: "sessions:runtime-list",
	sessionsRuntimeActivate: "sessions:runtime-activate",
	sessionsRuntimeStop: "sessions:runtime-stop",
	sessionsRuntimeAbort: "sessions:runtime-abort",
	sessionsRuntimeRestart: "sessions:runtime-restart",
	sessionsRuntimeCompact: "sessions:runtime-compact",
	sessionsRuntimeState: "sessions:runtime-state",
	sessionsRuntimeCommands: "sessions:runtime-commands",
	sessionsRuntimeExportHtml: "sessions:runtime-export-html",
	sessionsRuntimeEditMessage: "sessions:runtime-edit-message",
	sessionsRuntimeDeleteMessage: "sessions:runtime-delete-message",
	sessionsRuntimePrepareResend: "sessions:runtime-prepare-resend",
	sessionsRuntimeSetModel: "sessions:runtime-set-model",
	sessionsRuntimeSetThinking: "sessions:runtime-set-thinking",
	sessionsRuntimeClone: "sessions:runtime-clone",
	// 从用户消息 fork 新会话（pi /fork）；与 clone 不同，会按 entryId 裁剪会话树
	sessionsRuntimeGetForkMessages: "sessions:runtime-get-fork-messages",
	sessionsRuntimeFork: "sessions:runtime-fork",
	/** 渲染层汇报当前聚焦的会话（用于非聚焦会话 Ask 请求的桌面通知） */
	sessionsSetFocusedSession: "sessions:set-focused-session",
	codexSessionsScan: "codex-sessions:scan",
	codexSessionsImport: "codex-sessions:import",
	claudeSessionsScan: "claude-sessions:scan",
	claudeSessionsImport: "claude-sessions:import",
	openCodeSessionsScan: "opencode-sessions:scan",
	openCodeSessionsImport: "opencode-sessions:import",
	settingsGet: "settings:get",
	settingsUpdate: "settings:update",
	settingsTestPiProxy: "settings:test-pi-proxy",
	settingsApplyWindow: "settings:apply-window",
	skillsList: "skills:list",
	skillsCreate: "skills:create",
	skillsToggle: "skills:toggle",
	skillsDelete: "skills:delete",
	skillsOpenFolder: "skills:open-folder",
	skillsRename: "skills:rename",
	promptsList: "prompts:list",
	promptsCreate: "prompts:create",
	promptsDelete: "prompts:delete",
	promptsOpenFolder: "prompts:open-folder",
	promptsEdit: "prompts:edit",
	promptsListByProject: "prompts:list-by-project",
	promptsCreateInProject: "prompts:create-in-project",
	promptsDeleteInProject: "prompts:delete-in-project",
	promptsRename: "prompts:rename",
	promptsRenameInProject: "prompts:rename-in-project",
	promptStoreSearch: "prompt-store:search",
	promptStoreGet: "prompt-store:get",
	promptStoreImport: "prompt-store:import",
	yaoPromptsList: "yao-prompts:list",
	yaoPromptsDetail: "yao-prompts:detail",
	yaoPromptsImport: "yao-prompts:import",
	skillStoreSearch: "skill-store:search",
	skillStoreGet: "skill-store:get",
	skillStoreImport: "skill-store:import",
	// SkillHub（api.skillhub.cn）
	skillHubSearch: "skill-hub:search",
	skillHubDetail: "skill-hub:detail",
	skillHubInstall: "skill-hub:install",
	extensionsList: "extensions:list",
	extensionsUninstall: "extensions:uninstall",
	extensionsInstall: "extensions:install",
	extensionsToggle: "extensions:toggle",
	extensionsRemoveBuiltIn: "extensions:remove-built-in",
	extensionsRestoreBuiltIn: "extensions:restore-built-in",
	extensionsUpdate: "extensions:update",
	gitBranches: "git:branches",
	gitCheckout: "git:checkout",
	gitCreateBranch: "git:create-branch",
	gitOriginalContent: "git:original-content",
	gitWorktreeList: "git:worktree-list",
	gitWorktreeCreate: "git:worktree-create",
	gitWorktreeRemove: "git:worktree-remove",
	gitCommitLog: "git:commit-log",
	gitRefs: "git:refs",
	gitBranchCompare: "git:branch-compare",
	gitCommitDetail: "git:commit-detail",
	gitCommitFileDiff: "git:commit-file-diff",
	gitDiffFileBetween: "git:diff-file-between",
	gitStatus: "git:status",
	gitWorkspaceFileDiff: "git:workspace-file-diff",
	gitStage: "git:stage",
	gitUnstage: "git:unstage",
	gitDiscard: "git:discard",
	gitCommit: "git:commit",
	gitCherryPick: "git:cherry-pick",
	gitRevert: "git:revert",
	gitPush: "git:push",
	gitPull: "git:pull",
	gitReset: "git:reset",
	gitDropCommit: "git:drop-commit",
	gitGenerateCommitMessage: "git:generate-commit-message",
	gitInit: "git:init",
	gitFetch: "git:fetch",
	piCheck: "pi:check",
	piCheckCustom: "pi:check-custom",
	/** 获取已安装的 WSL 发行版列表（仅 Windows） */
	wslListDistros: "wsl:list-distros",
	/** 验证 WSL 连接：检查 distro + user 是否可达，以及 pi 是否已安装 */
	wslValidateConnection: "wsl:validate-connection",
	piUpdateCheck: "pi:update-check",
	piUpdate: "pi:update",
	/** 在系统终端中执行安装命令（npm install）并返回结果 */
	piExecInstall: "pi:exec-install",
	/** 检查 npm 是否可用 */
	piCheckNpm: "pi:check-npm",
	appInfo: "app:info",
	appPreferredSystemLanguages: "app:preferred-system-languages",
	appCheckUpdate: "app:check-update",
	appDownloadUpdate: "app:download-update",
	appInstallUpdate: "app:install-update",
	appUpdateProgress: "app:update-progress",
	appFeedbackEnvironment: "app:feedback-environment",
	appOpenExternal: "app:open-external",
	appOpenInBrowser: "app:open-in-browser",
	appRestart: "app:restart",
	preloadReady: "preload:ready",
	preloadError: "preload:error",
	rendererLog: "renderer:log",
	logsList: "logs:list",
	logsClear: "logs:clear",
	logsOpenFolder: "logs:open-folder",
	/** 获取 app 日志文件总大小 */
	logsSize: "logs:get-size",
	/** 获取 RPC 日志文件总大小 */
	rpcLogsGetSize: "rpc-logs:get-size",
	/** 从文件读取 RPC 日志 */
	rpcLogsGet: "rpc-logs:get",
	/** 清空 RPC 日志 */
	rpcLogsClear: "rpc-logs:clear",
	rpcLoggingSet: "rpc-logs:logging-set",
	rpcLoggingGet: "rpc-logs:logging-get",
	rpcLogsOpenFile: "rpc-logs:open-file",

	appWindowMinimize: "app:window-minimize",
	appWindowToggleMaximize: "app:window-toggle-maximize",
	appWindowToggleAlwaysOnTop: "app:window-toggle-always-on-top",
	appWindowClose: "app:window-close",
	agentsRuntimeState: "agents:runtime-state",
	agentsState: "agents:state",
	projectsListModels: "projects:list-models",
	agentsEvent: "agents:event",
	agentsMessage: "agents:message",
	agentsLog: "agents:log",

	/** 流式思考内容更新，agent 忙碌时实时推送当前思考文本 */
	agentsThinking: "agents:thinking",

	/**
	 * 主进程 → 渲染进程的轻量 toast 通知（如 abort 已请求停止）。
	 * 避免把瞬时状态反馈写成会话时间线里的系统卡片。
	 */
	agentsNotice: "agents:notice",

	/** Agent Extension UI 协议：主进程 → 渲染进程，推送扩展的 UI 请求（select/confirm/input/editor） */
	agentsUiRequest: "agents:ui-request",
	/** 项目信任确认：主进程 → 渲染进程，启动 Agent 前请求用户对含 .pi 资源的项目做信任决策 */
	projectsTrustRequest: "projects:trust-request",
	/** 项目信任确认：渲染进程 → 主进程，回传用户的信任选择（trust-remember/trust-session/deny） */
	projectsTrustResponse: "projects:trust-response",

	configGetModels: "config:get-models",
	configGetAuth: "config:get-auth",
	configGetSettings: "config:get-settings",
	configGetTrust: "config:get-trust",
	configSaveModels: "config:save-models",
	configSaveAuth: "config:save-auth",
	configSaveSettings: "config:save-settings",
	configSaveRaw: "config:save-raw",
	configExport: "config:export",
	configImport: "config:import",
	/** 从 provider 的 baseUrl + apiKey 拉取可用模型列表 */
	configFetchModels: "config:fetch-models",
	/** 快速测试 provider 连接：发送一条最小请求验证 baseUrl/apiKey/模型 是否正常 */
	configTestProvider: "config:test-provider",

	/** 切换开发者控制台 */
	appToggleDevTools: "app:toggle-devtools",

	/** RPC 日志，用于调试 */
	agentsRpcLog: "agents:rpc-log",

	terminalList: "terminal:list",
	terminalEnsure: "terminal:ensure",
	terminalCreate: "terminal:create",
	terminalInput: "terminal:input",
	terminalResize: "terminal:resize",
	terminalClose: "terminal:close",
	terminalData: "terminal:data",
	terminalExit: "terminal:exit",
	terminalShells: "terminal:shells",

	// ===== 飞书桥接 =====
	feishuConnect: "feishu:connect",
	/** 临时连接（不保存 bot 配置），用于首次添加 Bot 时先验证后保存 */
	feishuConnectTemp: "feishu:connect-temp",
	feishuDisconnect: "feishu:disconnect",
	feishuStatus: "feishu:status",
	feishuStatusRequest: "feishu:status-request",
	feishuBotsList: "feishu:bots-list",
	feishuBotAdd: "feishu:bot-add",
	feishuBotRemove: "feishu:bot-remove",
	feishuBotConfig: "feishu:bot-config",
	feishuBotSecret: "feishu:bot-secret",
	feishuTestConnection: "feishu:test-connection",
	feishuBindingsList: "feishu:bindings-list",
	feishuBindingRemove: "feishu:binding-remove",
	feishuBindingUpdate: "feishu:binding-update",
	feishuBindingsChanged: "feishu:bindings-changed",
	feishuBotsChanged: "feishu:bots-changed",
	feishuMessages: "feishu:messages",
	feishuQrCode: "feishu:qr-code",
	feishuConnectByBot: "feishu:connect-by-bot",
	/** Pi 创建会话时触发飞书自动拉群 */
	feishuAutoGroup: "feishu:auto-group",
	/** 获取指定稳定 Session 绑定的飞书 Bot ID */
	feishuSessionBotGet: "feishu:session-bot-get",
	/** 设置指定稳定 Session 使用的飞书 Bot ID */
	feishuSessionBotSet: "feishu:session-bot-set",
	/** 飞书 /whoami 结果推回前端 */
	feishuWhoamiResult: "feishu:whoami-result",

	// ===== 桌面宠物（全局聚合单宠） =====
	/** 主进程 → 宠物窗：推送聚合状态 */
	petState: "pet:state",
	/** 宠物窗/设置页 → 主进程：列出可用宠物包 */
	petList: "pet:list",
	/** 设置页 → 主进程：开关宠物 */
	petSetEnabled: "pet:set-enabled",
	/** 设置页 → 主进程：切换当前宠物 */
	petSetId: "pet:set-id",
	/** 宠物窗 → 主进程：拖拽移动窗口位置 */
	petMoveWindow: "pet:move-window",
	/** 宠物窗 → 主进程：拖拽相对位移（连续 screenX 差值，避免 DPI 坐标单位混用） */
	petMoveBy: "pet:move-by",
	/** 宠物窗 → 主进程：点击宠物跳转活跃 Agent */
	petFocusAgent: "pet:focus-agent",
	/** 主进程 → 主窗口：点击宠物后通知主窗切换到活跃 Agent tab */
	petFocusAgentTarget: "pet:focus-agent-target",
	/** 主进程 → 宠物窗：推送当前选中宠物的 manifest（含 spritesheetUrl），切换宠物时热加载 */
	petCurrentSprite: "pet:current-sprite",
	/** 宠物窗 → 主进程：拉取当前选中宠物的 manifest（挂载时主动拉取，避免推送竞态丢失） */
	petGetCurrent: "pet:get-current",
	/** 主进程 → 宠物窗：推送通知气泡（出错/完成时宠物头顶弹窗） */
	petNotify: "pet:notify",
	/** 设置页 → 主进程 → 宠物窗：预览动画行（测试用） */
	petPreviewMode: "pet:preview-mode",
	/** 主进程 → 宠物窗：推送窗口能力探测结果（透明/穿透/自由定位） ★ 降级形态渲染 */
	petCaps: "pet:caps",
	/** 宠物窗 → 主进程：双击宠物触发逗弄（注入一次 jumping 后恢复真实态） */
	petTease: "pet:tease",
	/** 宠物窗 → 主进程：拖拽起止通知（开始时暂停巡游，避免松手后 tick 命中反向边界瞬移） */
	petDragState: "pet:drag-state",
	/** 宠物窗 → 主进程：React 已挂载且 IPC 监听器已注册，主进程可安全推送初始状态 */
	petReady: "pet:ready",
	/** 宠物窗 → 主进程：请求显示右键上下文菜单 */
	petContextMenu: "pet:context-menu",

	// ===== Scratch Pad（草稿本/多草稿） =====
	scratchPadList: "scratch-pad:list",
	scratchPadCreate: "scratch-pad:create",
	scratchPadDelete: "scratch-pad:delete",
	scratchPadLoad: "scratch-pad:load",
	scratchPadSave: "scratch-pad:save",
	scratchPadExport: "scratch-pad:export",

	// ── 调试工具 ──
	/** 设置面板 → 主进程：发送测试通知（调试弹窗样式） */
	petTestNotify: "pet:test-notify",

	// ===== 系统文件选择器 =====
	dialogPickFiles: "dialog:pick-files",
	/** 换肤背景图：选图复制到 userData/backgrounds/（返回文件名，空串=取消） */
	pickBackgroundImage: "backgrounds:pick",
	/** 删除背景图文件 */
	removeBackgroundImage: "backgrounds:remove",

	// ===== 内置浏览器 =====
	browserOpenExternal: "browser:open-external",

	// ===== 内置浏览器（WebContentsView 管线，#115 U4 灰度） =====
	browserViewShow: "browser-view:show",
	browserViewHide: "browser-view:hide",
	browserViewSetBounds: "browser-view:set-bounds",
	browserViewNavigate: "browser-view:navigate",
	browserViewAction: "browser-view:action",
	/** 主进程 → 渲染层：导航/加载状态推送 */
	browserViewState: "browser-view:state",
	/** 主进程 → 渲染层：页面请求新窗口（target=_blank / window.open） */
	browserViewNewWindow: "browser-view:new-window",

} as const;
