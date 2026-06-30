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
	filesDelete: "files:delete",
	filesRename: "files:rename",
	sessionsList: "sessions:list",
	sessionsRename: "sessions:rename",
	sessionsCopy: "sessions:copy",
	sessionsExportHtml: "sessions:export-html",
	sessionsDelete: "sessions:delete",
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
	extensionsList: "extensions:list",
	extensionsUninstall: "extensions:uninstall",
	extensionsInstall: "extensions:install",
	extensionsToggle: "extensions:toggle",
	extensionsUpdate: "extensions:update",
	gitBranches: "git:branches",
	gitCheckout: "git:checkout",
	gitCreateBranch: "git:create-branch",
	gitOriginalContent: "git:original-content",
	gitChangedFiles: "git:changed-files",
	piCheck: "pi:check",
	piCheckCustom: "pi:check-custom",
	piUpdateCheck: "pi:update-check",
	piUpdate: "pi:update",
	appInfo: "app:info",
	appCheckUpdate: "app:check-update",
	appDownloadUpdate: "app:download-update",
	appInstallUpdate: "app:install-update",
	appUpdateProgress: "app:update-progress",
	appFeedbackEnvironment: "app:feedback-environment",
	appOpenExternal: "app:open-external",
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
	agentsList: "agents:list",
	agentsCreate: "agents:create",
	agentsRename: "agents:rename",
	agentsStop: "agents:stop",
	agentsPrompt: "agents:prompt",
	agentsAbort: "agents:abort",
	agentsExportHtml: "agents:export-html",
	agentsForkMessages: "agents:fork-messages",
	agentsForkSession: "agents:fork-session",
	agentsCloneSession: "agents:clone-session",
	agentsSwitchSession: "agents:switch-session",
	agentsReload: "agents:reload",
	agentsEditMessage: "agents:edit-message",
	agentsDeleteMessage: "agents:delete-message",
	agentsRestart: "agents:restart",
	agentsCompact: "agents:compact",
	agentsRuntimeState: "agents:runtime-state",
	agentsCycleModel: "agents:cycle-model",
	agentsAvailableModels: "agents:available-models",
	agentsSetModel: "agents:set-model",
	agentsCycleThinking: "agents:cycle-thinking",
	agentsSetThinking: "agents:set-thinking",
	agentsState: "agents:state",
	agentsEvent: "agents:event",
	agentsMessage: "agents:message",
	agentsLog: "agents:log",

	/** 流式思考内容更新，agent 忙碌时实时推送当前思考文本 */
	agentsThinking: "agents:thinking",

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
	/** 获取指定 Agent 绑定的飞书 Bot ID */
	feishuSessionBotGet: "feishu:session-bot-get",
	/** 设置指定 Agent 使用的飞书 Bot ID */
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

	// ── 调试工具 ──
	/** 设置面板 → 主进程：发送测试通知（调试弹窗样式） */
	petTestNotify: "pet:test-notify",
} as const;
