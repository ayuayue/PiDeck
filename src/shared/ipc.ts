export const ipcChannels = {
	projectsList: "projects:list",
	projectsAdd: "projects:add",
	projectsRemove: "projects:remove",
	projectsReorder: "projects:reorder",
	// 重命名项目显示名（仅改侧栏/标题 label，不改磁盘目录；聊天项目与 worktree 子项目拒绝）
	projectsRename: "projects:rename",
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
	/** 检测系统可用的文件管理器（打开方式下拉补充入口） */
	filesDetectFileManager: "files:detect-file-manager",
	/** 在系统文件管理器中打开目录 */
	filesOpenFileManager: "files:open-file-manager",
	filesReadContent: "files:read-content",
	/** 批量校验路径是否存在（fs.stat）：AI 回复内文件链接的存在性判定用 */
	filesPathsExist: "files:paths-exist",
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
	/** 粘贴大文本转文件：写入受管 paste 目录（项目 .pideck-paste/ 或 userData/paste-files/） */
	pasteFilesWrite: "paste-files:write",
	/** 移除粘贴文件 chip 时同步删除落盘文件（仅限 paste 目录内路径） */
	pasteFilesDelete: "paste-files:delete",
	/** 启动清理：删除超过保留期的粘贴文件（默认 7 天） */
	pasteFilesCleanup: "paste-files:cleanup",
	/** 模型目录（pi-ai-catalog）更新：查询内置/覆盖层状态 */
	catalogUpdateStatus: "catalog:update-status",
	/** 模型目录更新：检查远端（GitHub main 分支 manifest）是否有新版本 */
	catalogUpdateCheck: "catalog:update-check",
	/** 模型目录更新：从 GitHub（默认 main 分支）拉取并写入 userData 覆盖层 */
	catalogUpdateFromGithub: "catalog:update-from-github",
	/** 模型目录还原：删除覆盖层文件，回退到内置目录 */
	catalogUpdateRestore: "catalog:update-restore",
	/** 模型目录恢复：从 .bak 备份恢复上一个覆盖版 */
	catalogUpdateRestorePrevious: "catalog:update-restore-previous",
	/** 模型目录打开文件：用系统默认程序打开当前生效目录文件（覆盖层优先，否则内置） */
	catalogOpenFile: "catalog:open-file",
	sessionsList: "sessions:list",
	/** Session-first catalog APIs. */
	sessionsCatalogList: "sessions:catalog-list",
	/** 后台扫描完成后主进程 → 渲染层的推送（目录缓存已合并，渲染层应重新拉取）。 */
	sessionsCatalogRefreshed: "sessions:catalog-refreshed",
	sessionsCatalogCreateDraft: "sessions:catalog-create-draft",
	/** 引导页/新会话展示用：按当前 pi 配置解析「创建会话时会套用的默认模型/思考档位」。 */
	sessionsResolveLaunchDefaults: "sessions:resolve-launch-defaults",
	/** Starts an in-memory `--no-session` conversation. */
	sessionsCreateAnonymous: "sessions:create-anonymous",
	sessionsCatalogUpdate: "sessions:catalog-update",
	sessionsCatalogDelete: "sessions:catalog-delete",
	/** 归档会话：文件移入 .pideck-archive/ 并从目录移除 */
	sessionsCatalogArchive: "sessions:catalog-archive",
	/** 恢复归档会话：移回原路径并重新入目录 */
	sessionsCatalogUnarchive: "sessions:catalog-unarchive",
	/** 列出已归档会话摘要（恢复 UI 用） */
	sessionsCatalogListArchived: "sessions:catalog-list-archived",
	/** 永久删除已归档会话：归档区文件移入系统回收站并从索引移除（区别于恢复）。 */
	sessionsCatalogDeleteArchived: "sessions:catalog-delete-archived",
	sessionsCatalogReadMessages: "sessions:catalog-read-messages",
	sessionsCatalogReadMessagePage: "sessions:catalog-read-message-page",
	/** 会话 JSONL 过程事件（session/model/thinking/custom/compaction），供轨迹复盘，不进聊天时间线。 */
	sessionsCatalogReadProcessEvents: "sessions:catalog-read-process-events",
	/** pi-subagents 扩展子代理列表：合成 record、桥接快照、工具调用推导。 */
	sessionsListSubagents: "sessions:list-subagents",
	/** 会话级文件修改汇总：从会话文件全量显示消息聚合 write/edit/create/patch。 */
	sessionsListFileChanges: "sessions:list-file-changes",
	/** 会话级 todo 快照：从会话文件 pi-deck-todo custom 条目重建最新计划。 */
	sessionsListSessionTodo: "sessions:list-session-todo",
	/** DSH 会话轨迹系统提示（request/header 事件的 EpochHeader.system；非 DSH/无数据返回 undefined）。 */
	sessionsCatalogReadDshSystemPrompt: "sessions:catalog-read-dsh-system-prompt",
	sessionsCatalogReadReferenceMessages: "sessions:catalog-read-reference-messages",
	/** 按需读取单条消息完整文本（工具结果截断后的「查看完整输出」入口）。 */
	sessionsCatalogReadMessageFullText: "sessions:catalog-read-message-full-text",
	sessionsCatalogCopy: "sessions:catalog-copy",
	sessionsCatalogExportHtml: "sessions:catalog-export-html",
	/** 无 runtime 时直接改 pi JSONL（编辑消息）。运行中必须先停 Agent。 */
	sessionsCatalogEditMessage: "sessions:catalog-edit-message",
	/** 无 runtime 时直接改 pi JSONL（删除消息）。运行中必须先停 Agent。 */
	sessionsCatalogDeleteMessage: "sessions:catalog-delete-message",
	/** 无 runtime 时截断 pi JSONL 供重发。运行中必须先停 Agent。 */
	sessionsCatalogPrepareResend: "sessions:catalog-prepare-resend",
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
	/** rewind checkpoint（refs/pi-checkpoints，纯 git，跨后端）。 */
	sessionsRewindList: "sessions:rewind-list",
	sessionsRewindDiff: "sessions:rewind-diff",
	sessionsRewindRestore: "sessions:rewind-restore",
	/** 运行中 Agent 启动快照里的模型（get_available_models），用于判断新加模型要不要重启。 */
	sessionsRuntimeListModels: "sessions:runtime-list-models",
	/** Pi 当前模型支持的 thinking levels（get_available_thinking_levels）；旧 Pi 返回 undefined 由 UI 回退。 */
	sessionsRuntimeThinkingLevels: "sessions:runtime-thinking-levels",
	sessionsRuntimeExportHtml: "sessions:runtime-export-html",
	sessionsRuntimeEditMessage: "sessions:runtime-edit-message",
	sessionsRuntimeDeleteMessage: "sessions:runtime-delete-message",
	sessionsRuntimePrepareResend: "sessions:runtime-prepare-resend",
	sessionsRuntimeSetModel: "sessions:runtime-set-model",
	sessionsRuntimeSetThinking: "sessions:runtime-set-thinking",
	sessionsRuntimeSetPermission: "sessions:runtime-set-permission",
	sessionsRuntimeClone: "sessions:runtime-clone",
	// 从用户消息 fork 新会话（pi /fork）；与 clone 不同，会按 entryId 裁剪会话树
	sessionsRuntimeGetForkMessages: "sessions:runtime-get-fork-messages",
	sessionsRuntimeFork: "sessions:runtime-fork",
	/** 渲染层汇报当前聚焦的会话（用于非聚焦会话 Ask 请求的桌面通知） */
	sessionsSetFocusedSession: "sessions:set-focused-session",
	/** DSH 会话文件路径推导（渲染层右键「复制会话文件路径」；按 dshSessionId + cwd 计算 host 持久化路径）。 */
	sessionsGetDshSessionPath: "sessions:get-dsh-session-path",
	/** DSH 会话内容搜索（session.search；结果最多 20 会话，返回 sessionId + snippet）。 */
	sessionsSearchDsh: "sessions:search-dsh",
	/** DSH 创建目标（goal.create；objective 必填，maxGoalRounds 可选）。 */
	dshCreateGoal: "dsh:create-goal",
	/** DSH 目标操作（goal.pause/resume/complete/clear，按当前 goal CAS ref）。 */
	dshGoalAction: "dsh:goal-action",
	/** DSH 子代理列表（subagent.list 直接子代目录）。 */
	dshListSubagents: "dsh:list-subagents",
	/** DSH 子代理历史（subagent.history 只读 transcript）。 */
	dshSubagentHistory: "dsh:subagent-history",
	/** DSH 技能目录（skill.list 只读；/name 斜杠调用，G7）。 */
	dshListSkills: "dsh:list-skills",
	/** DSH 孤儿会话 id 列表（host 有但 catalog 无映射；G3/D11 清理提示用）。 */
	dshListOrphans: "dsh:list-orphans",
	/** DSH 外部会话清单（dsh-web 等其他工具创建的 host 根会话，跨工具导入用）。 */
	dshListForeignSessions: "dsh:list-foreign-sessions",
	/** DSH 外部会话导入（把 host 会话映射进 catalog，侧栏可见可加载）。 */
	dshImportForeignSession: "dsh:import-foreign-session",
	/** DSH 外部会话全量同步（自动发现：catalog 未映射的 host 根会话全部导入；返回导入/跳过统计）。 */
	dshSyncForeignSessions: "dsh:sync-foreign-sessions",
	/** DSH 归档区会话清单（G14：目录已移入 .pideck-archive 的 host 会话，恢复入口用）。 */
	dshListArchived: "dsh:list-archived",
	/** DSH 会话恢复（G14：目录按 manifest 移回 sessions 树并重建 catalog 记录）。 */
	dshUnarchive: "dsh:unarchive",
	/** DSH 永久删除已归档会话：归档目录移入系统回收站（区别于恢复）。 */
	dshDeleteArchived: "dsh:delete-archived",
	/** DSH 动态插件清单（G13 深化：进程内临时扩展，重启即失；按会话归属）。 */
	dshPluginList: "dsh:plugin-list",
	/** DSH 静态 Loader 条目清单（只读：moduleName/enabled/fiberPhase）。 */
	dshPluginStaticList: "dsh:plugin-static-list",
	/** DSH 动态插件安装（define：定义源码包，不运行）。 */
	dshPluginInstall: "dsh:plugin-install",
	/** DSH 动态插件运行（面板手势，requestId=null 无需审批）。 */
	dshPluginRun: "dsh:plugin-run",
	/** DSH 动态插件停止（保留全部包版本）。 */
	dshPluginStop: "dsh:plugin-stop",
	/** DSH 动态插件卸载（undefine：删除插件与全部包版本）。 */
	dshPluginUninstall: "dsh:plugin-uninstall",
	/** DSH host 级模型目录（llm.models），不依赖已启动的会话。 */
	dshListModels: "dsh:list-models",
	/** DSH 配置页模型发现（llm.discoverModels；只返回候选，不写配置）。 */
	dshDiscoverModels: "dsh:discover-models",
	/** DSH 可配置提供方目录（llm.providers：内置 catalog + 已注册路由；添加提供方用）。 */
	dshListProviders: "dsh:list-providers",
	/** DSH 配置管理页状态（host 启动状态 + 目录 + providers + 模型目录）。 */
	dshGetStatus: "dsh:get-status",
	/** DSH settings.describe（脱敏 namespace 视图 + schema，渲染配置表单）。 */
	dshConfigDescribe: "dsh:config-describe",
	/** DSH settings.update（合并 patch 到 namespace 用户层）。 */
	dshConfigUpdate: "dsh:config-update",
	/** DSH settings.mutate（路径级操作，支持 unset 删除 provider/字段；update 无法删除）。 */
	dshConfigMutate: "dsh:config-mutate",
	/** DSH settings.openDocument（把配置文档交给平台打开）。 */
	dshOpenDocument: "dsh:open-document",
	/** DSH host 重启（DSH_HOME 切换后立即生效；有活跃 DSH 会话时拒绝）。 */
	dshRestartHost: "dsh:restart-host",
	/** DSH credentials.describe（configured/source/writable，无值）。 */
	dshCredentialDescribe: "dsh:credential-describe",
	/** DSH credentials.set（写凭证值）。 */
	dshCredentialSet: "dsh:credential-set",
	/** DSH credentials.unset（删凭证）。 */
	dshCredentialUnset: "dsh:credential-unset",
	/** DSH 凭证明文读取（仅渲染层点「眼睛」时按 ref 取一次；DSH RPC 不回显值，由主进程读凭证文件/环境）。 */
	dshCredentialRead: "dsh:credential-read",
	/** DSH agent 预设目录（agentPreset.list：id/trust/isDefault/名称/描述）。 */
	dshAgentPresets: "dsh:agent-presets",
	/** DSH 部署默认模型选择（settings.yaml agent-default-model：provider/model/reasoningEffort）。 */
	dshDefaultModel: "dsh:default-model",
	/** DSH runtime 安装态查询（AgentRuntimeProvider 阶段 1：installed/notInstalled/broken 门控 UI）。 */
	dshRuntimeGetStatus: "dsh-runtime:get-status",
	/** DSH runtime 安装态变更推送（阶段 2 安装/卸载/版本切换时广播，订阅式）。 */
	dshRuntimeStatusChanged: "dsh-runtime:status-changed",
	/** 按需安装 DSH runtime（从下载源索引挑兼容版本；进度走 dsh-runtime:install-progress）。 */
	dshRuntimeInstall: "dsh-runtime:install",
	/** 从本地导入 runtime（.tgz 归档或已解压目录；离线 / 镜像不可达时的兜底）。 */
	dshRuntimeInstallLocal: "dsh-runtime:install-local",
	/** 卸载已安装的 DSH runtime。 */
	dshRuntimeUninstall: "dsh-runtime:uninstall",
	/** 安装进度推送（订阅式）。 */
	dshRuntimeInstallProgress: "dsh-runtime:install-progress",
	codexSessionsScan: "codex-sessions:scan",
	codexSessionsImport: "codex-sessions:import",
	claudeSessionsScan: "claude-sessions:scan",
	claudeSessionsImport: "claude-sessions:import",
	openCodeSessionsScan: "opencode-sessions:scan",
	openCodeSessionsImport: "opencode-sessions:import",
	settingsGet: "settings:get",
	settingsUpdate: "settings:update",
	/** 重启当前已启用的 Web 服务，不修改 Web 设置 */
	settingsRestartWebService: "settings:restart-web-service",
	settingsTestPiProxy: "settings:test-pi-proxy",
	settingsApplyWindow: "settings:apply-window",
	skillsList: "skills:list",
	skillsReadContent: "skills:read-content",
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
	extensionsSetWhitelistDisabled: "extensions:set-whitelist-disabled",
	extensionsRemoveBuiltIn: "extensions:remove-built-in",
	extensionsRestoreBuiltIn: "extensions:restore-built-in",
	extensionsUpdate: "extensions:update",
	extensionsUpdateOne: "extensions:update-one",
	/** 扫描项目目录内的独立 Git 仓库（根 + 嵌套），供侧栏切换 */
	gitListRepos: "git:list-repos",
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
	/** 按目录批量回滚未暂存资源，主进程会重新校验每个资源所属分组。 */
	gitDiscardFiles: "git:discard-files",
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
	/** 当前分支相对上游的提交差距（ahead/behind），驱动 push/pull 角标 */
	gitAheadBehind: "git:ahead-behind",
	/** 从磁盘删除变更文件（移入回收站，可恢复） */
	gitDeleteFiles: "git:delete-files",
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
	/** 获取当前机器的非回环 IPv4 网卡，供局域网 Web 服务二维码使用 */
	appNetworkAddresses: "app:network-addresses",
	appPreferredSystemLanguages: "app:preferred-system-languages",
	appCheckUpdate: "app:check-update",
	/** 手动下载已检测到的新版本（autoDownload 关闭时使用）。 */
	appDownloadUpdate: "app:download-update",
	/** 重启并安装已下载的更新（quitAndInstall）。 */
	appInstallUpdate: "app:install-update",
	/** 主进程后台更新检查快照推送（角标 + 每版本一次提示判定）。 */
	appUpdateStatusChanged: "app:update-status-changed",
	/** 记录已提示过的版本（每版本只提示一次）。 */
	appUpdateNotifySeen: "app:update-notify-seen",
	/** 跳过某版本（该版本不再主动提示）。 */
	appUpdateSkipVersion: "app:update-skip-version",
	/** 探测内置更新镜像的可用性与速度（设置页「更新源」自动体检用）。 */
	appCheckUpdateMirrors: "app:check-update-mirrors",
	appFeedbackEnvironment: "app:feedback-environment",
	/** 问题反馈「新建会话分析」：读取项目根 AGENTS.md（截断）与项目级技能列表。 */
	appFeedbackProjectContext: "app:feedback-project-context",
	appOpenExternal: "app:open-external",
	appOpenInBrowser: "app:open-in-browser",
	appRestart: "app:restart",
	/** 真正退出应用（置 isQuitting 后 app.quit）。异常页不能走 window-close：closeToTray 会把关窗吞成隐藏。 */
	appQuit: "app:quit",
	/** 在系统文件管理器中打开 PiDeck 数据目录（跨平台：explorer / Finder / xdg-open） */
	appOpenDataDir: "app:open-data-dir",
	/** 进程监控：拉取 Electron 各进程 + pi agent 子进程的内存/CPU 快照 */
	processMetrics: "system:process-metrics",
	/** 开发诊断快照（内存 / 事件循环延迟 / 最近关键耗时） */
	diagnosticsSnapshot: "system:diagnostics-snapshot",
	/** 打开 userData/diagnostics 目录 */
	diagnosticsOpenFolder: "system:diagnostics-open-folder",
	/** 进程监控里手动停止某个 pi agent（按 agentId 走 AgentManager 正常停止流程） */
	stopAgent: "system:stop-agent",
	/**
	 * 环境体检：采集版本/平台/内存磁盘/pi 安装状态/最近报错，产出脱敏的诊断报告。
	 * 与 system:diagnostics-snapshot（性能剖析）不是一回事，供「问题反馈」页一键排障。
	 */
	healthCheck: "system:health-check",
	/** 把体检报告（Markdown 形态）保存到用户选择的路径 */
	healthExportReport: "system:health-export-report",
	/** 把完整日志（脱敏）+ 报告 + 环境 JSON 打包成 zip 存到用户选择的路径 */
	healthExportBundle: "system:health-export-bundle",
	preloadReady: "preload:ready",
	preloadError: "preload:error",
	rendererLog: "renderer:log",
	logsList: "logs:list",
	logsListPage: "logs:list-page",
	logsClear: "logs:clear",
	logsOpenFolder: "logs:open-folder",
	/** 获取 app 日志文件总大小 */
	logsSize: "logs:get-size",
	/** 获取 RPC 日志文件总大小 */
	rpcLogsGetSize: "rpc-logs:get-size",
	/** 从文件读取 RPC 日志 */
	rpcLogsGet: "rpc-logs:get",
	/** 读取主进程实时环形缓冲（最近 N 条） */
	rpcLogsGetLive: "rpc-logs:get-live",
	/** 将弹窗条目合并写入自动日志文件（按 id 去重） */
	rpcLogsSave: "rpc-logs:save",
	/** 清空 RPC 日志 */
	rpcLogsClear: "rpc-logs:clear",
	rpcLoggingSet: "rpc-logs:logging-set",
	rpcLoggingGet: "rpc-logs:logging-get",

	appWindowMinimize: "app:window-minimize",
	appWindowToggleMaximize: "app:window-toggle-maximize",
	appWindowIsMaximized: "app:window-is-maximized",
	/** 主进程 → 渲染：最大化状态变化（含双击标题栏等非按钮路径） */
	appWindowMaximizedChanged: "app:window-maximized-changed",
	appWindowToggleAlwaysOnTop: "app:window-toggle-always-on-top",
	/** 读取主窗口当前是否置顶（渲染层初始化置顶按钮态用，避免硬编码 false） */
	appWindowIsAlwaysOnTop: "app:window-is-always-on-top",
	appWindowClose: "app:window-close",
	agentsRuntimeState: "agents:runtime-state",
	agentsState: "agents:state",
	projectsListModels: "projects:list-models",
	/** 模型列表诊断报告：模型数组 + 失败原因分类（版本过低/配置损坏/pi 未安装），
	 *  供模型选择器在列表为空时给出差异化引导；force=true 时绕过缓存重新 fork。 */
	projectsListModelsReport: "projects:list-models-report",
	/** 模型规格查询：pi-ai 内置目录按模型 id 精确匹配，中转站通用 */
	projectsGetModelSpec: "projects:get-model-spec",
	agentsEvent: "agents:event",
	agentsMessage: "agents:message",
	agentsLog: "agents:log",

	/** 流式思考内容更新，agent 忙碌时实时推送当前思考文本 */
	agentsThinking: "agents:thinking",

	/** 流式正文内容更新，agent 忙碌时实时推送累积正文（阶段1：独立于 messages 数组） */
	agentsTextStream: "agents:text-stream",

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

	/** 预览可互迁的单供应商（pi → DSH 或 DSH → pi）。 */
	configPreviewProviderMigration: "config:preview-provider-migration",
	/** 执行单供应商互迁（覆盖同名目标前由渲染层确认）。 */
	configApplyProviderMigration: "config:apply-provider-migration",
	configGetModels: "config:get-models",
	configGetAuth: "config:get-auth",
	configGetSettings: "config:get-settings",
	configGetTrust: "config:get-trust",
	/** 读取合并后的 MCP 服务列表 + Pi 可写层（pi-mcp-adapter mcp.json）。 */
	configGetMcp: "config:get-mcp",
	/** 整份写入 ~/.pi/agent/mcp.json（可视化保存）。 */
	configSaveMcp: "config:save-mcp",
	/** 轻量探测：stdio 命令是否在 PATH、HTTP URL 是否可达；不 spawn MCP SDK。 */
	configProbeMcp: "config:probe-mcp",
	/** 只读返回 pi 全局配置目录（渲染层展示源文件实际编辑位置）。 */
	configGetDir: "config:get-dir",
	configSaveModels: "config:save-models",
	configSaveAuth: "config:save-auth",
	configSaveSettings: "config:save-settings",
	configSaveRaw: "config:save-raw",
	configExport: "config:export",
	configImport: "config:import",
	/** 从 provider 的 baseUrl + apiKey 拉取可用模型列表 */
	configFetchModels: "config:fetch-models",
	/** 取内置 TokenDance 模型目录（live fetch + userData 缓存；force=true 强制刷新） */
	configGetTokendanceModels: "config:get-tokendance-models",
	configInstallTokendance: "config:install-tokendance",
	/** 启动 TokenDance OAuth 授权流程（PKCE S256 headless；返回授权 URL + flowId） */
	configTokendanceAuthStart: "config:tokendance-auth-start",
	/** 提交一次性授权 code 交换 TokenDance API Key（成功返回完整 key） */
	configTokendanceAuthExchange: "config:tokendance-auth-exchange",
	/** 快速测试 provider 连接：发送一条最小请求验证 baseUrl/apiKey/模型 是否正常 */
	configTestProvider: "config:test-provider",
	/** 查询 provider 用量/余额（主进程按 provider 名路由：门控 → 端点解析 → 模板探测） */
	configFetchUsage: "config:fetch-usage",
	/** 读取单个 provider 的用量查询配置（usage-probes.json）+ 内置模板自动识别 */
	configGetUsageProbes: "config:get-usage-probes",
	/** 轻量判断 provider 是否命中内置用量模板（零配置自动生效；渲染层据此隐藏「用量查询」配置按钮） */
	configUsageRecognized: "config:usage-recognized",
	/** 按 provider 合并保存用量查询配置（校验后落盘，保留其它 providers 与旧 probes） */
	configSaveUsageProbes: "config:save-usage-probes",
	/** 单条模板测试（模板 id + 覆盖字段；配置弹窗「测试」按钮，key 不出主进程） */
	configTestUsageProbe: "config:test-usage-probe",
	/** 安装内置「用量查询自定义」技能模板到 ~/.pi/agent/skills/usage-probe */
	configInstallUsageSkill: "config:install-usage-skill",
	/** 安装内置「图片生成」技能模板到 ~/.pi/agent/skills/image-gen */
	configInstallImageGenSkill: "config:install-image-gen-skill",

	// ===== 安全管理（SecurityStore + pi-deck-security-gate 扩展） =====
	/** 拉取完整安全配置（等级/默认等级/会话覆盖） */
	securityGetConfig: "security:get-config",
	/** 更新安全配置（校验 + 持久化 + 刷新策略快照） */
	securityUpdateConfig: "security:update-config",
	/** 设置单个会话的等级覆盖（levelId 为空 = 清除覆盖跟随全局） */
	securitySetSessionLevel: "security:set-session-level",

	/** 视觉桥：读取当前配置 + 可选模型列表 */
	visionGetConfig: "vision:get-config",
	/** 视觉桥：保存配置到 ~/.pi/agent/pi-deck-vision.json */
	visionSaveConfig: "vision:save-config",
	/** 视觉桥：读取运行日志（扩展写的 pi-deck-vision.log，诊断用） */
	visionGetLog: "vision:get-log",
	/** 视觉桥：读取结构化转换事件（pi-deck-vision-events.jsonl 尾部，会话渲染层展示请求详情） */
	visionGetEvents: "vision:get-events",
	/** 视觉桥：清空事件文件 */
	visionClearEvents: "vision:clear-events",
	/** 视觉桥：清空运行日志 */
	visionClearLog: "vision:clear-log",

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
	/** 主窗口 → 主进程：冷启动/页面加载期间点击通知的跳转目标可能因监听未就绪而丢失，
	 *  renderer 挂载后主动拉取一次（一次性，取走即清空） */
	petGetFocusTargetPending: "pet:get-focus-target-pending",
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

	// ===== 用量统计（usage-stats） =====
	usageStatsDetect: "usage-stats:detect",
	usageStatsRefresh: "usage-stats:refresh",
	usageStatsGet: "usage-stats:get",

	// ===== 生图（ImageGen） =====
	/** 生图：OpenAI 兼容 /images/generations，返回 base64 图片 */
	imagegenGenerate: "imagegen:generate",
	/** 读取独立生图配置（userData/imagegen.json，不进 pi models.json） */
	imagegenGetConfig: "imagegen:get-config",
	/** 保存独立生图配置（白名单校验后落盘） */
	imagegenSaveConfig: "imagegen:save-config",

	// ===== Composer voice transcription =====
	voiceTranscriptionGetConfig: "voice-transcription:get-config",
	voiceTranscriptionSaveConfig: "voice-transcription:save-config",
	voiceTranscriptionTranscribe: "voice-transcription:transcribe",
	voiceTranscriptionCancel: "voice-transcription:cancel",

	// ===== 系统剪贴板（必须走主进程；Electron 38 废弃渲染进程/preload 直连 clipboard） =====
	clipboardReadText: "clipboard:read-text",
	clipboardReadHtml: "clipboard:read-html",
	clipboardReadImage: "clipboard:read-image",
	clipboardReadFilePaths: "clipboard:read-file-paths",
	clipboardWriteImage: "clipboard:write-image",
	/**
	 * 写纯文本到系统剪贴板。诊断报告/AI 提示词可能上百 KB，
	 * 必须走主进程（渲染进程直连 clipboard 在 Electron 38 已废弃，大文本会静默失败）。
	 */
	clipboardWriteText: "clipboard:write-text",

} as const;
