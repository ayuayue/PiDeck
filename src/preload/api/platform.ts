/**
 * preload platform 域：平台面：宿主插件 / MCP 桥 / 智能体记忆、剪贴板、小窗与桌面形态、pi 认证、数据环境、系统菜单与宠物窗。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe, clipboardSync } from "./ipcHelpers";
import type { ArchStatus, DiagnosticsSnapshot, FocusTargetPayload, HealthExportResult, HealthReport, PetAggregateState, PetManifest, PetNotification, PetWindowCaps, ProcessMetricsSnapshot } from "../../shared/types";
import type { DataEnvChoiceFailure, DataEnvChoiceResult, DataEnvInfo, DataEnvMode, ImportPreviewResult, ImportProgress, ImportStartResult } from "../../shared/types/dataEnv";
import type { HostPluginContext, HostPluginDesktopApi } from "../../shared/types/hostPlugin";
import type { PiDeckMcpDesktopApi } from "../../shared/types/piDeckMcp";

const hostPlugins: HostPluginDesktopApi = {
	list: () => ipcRenderer.invoke(ipcChannels.hostPluginsList),
	rescan: () => ipcRenderer.invoke(ipcChannels.hostPluginsRescan),
	setEnabled: (id, enabled, fingerprint) => ipcRenderer.invoke(ipcChannels.hostPluginsSetEnabled, id, enabled, fingerprint),
	openDirectory: () => ipcRenderer.invoke(ipcChannels.hostPluginsOpenDirectory),
	install: () => ipcRenderer.invoke(ipcChannels.hostPluginsInstall),
	installDirectory: () => ipcRenderer.invoke(ipcChannels.hostPluginsInstallDirectory),
	installGitHub: (url: string) => ipcRenderer.invoke(ipcChannels.hostPluginsInstallGitHub, url),
	searchMarket: (keyword: string) => ipcRenderer.invoke(ipcChannels.hostPluginsMarketSearch, keyword),
	scaffold: (input) => ipcRenderer.invoke(ipcChannels.hostPluginsScaffold, input),
	mount: (input) => ipcRenderer.invoke(ipcChannels.hostPluginsMount, input),
	update: (instanceId: string, context: HostPluginContext) => ipcRenderer.invoke(ipcChannels.hostPluginsUpdate, instanceId, context),
	unmount: (id) => ipcRenderer.invoke(ipcChannels.hostPluginsUnmount, id),
	remove: (id) => ipcRenderer.invoke(ipcChannels.hostPluginsRemove, id),
	onChanged: (callback) => subscribe(ipcChannels.hostPluginsChanged, callback),
	onNavigate: (callback) => subscribe(ipcChannels.hostPluginNavigate, callback),
	onOpenBrowser: (callback) => subscribe(ipcChannels.hostPluginOpenBrowser, callback),
};

const piDeckMcp: PiDeckMcpDesktopApi = {
	getState: () => ipcRenderer.invoke(ipcChannels.piDeckMcpState),
	setAccess: (input) => ipcRenderer.invoke(ipcChannels.piDeckMcpSetAccess, input),
	connection: () => ipcRenderer.invoke(ipcChannels.piDeckMcpConnection),
};

/**
 * 智能体记忆的设置页视图。返回值统一是 `{ok,value}` / `{ok:false,code}`，
 * 渲染层据此区分「操作失败（有稳定错误码）」和「IPC 层异常」，不需要解析错误文案。
 */
const agentMemory = {
	status: () => ipcRenderer.invoke(ipcChannels.agentMemoryStatus) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<import("../../shared/types/agentMemory").AgentMemoryStatus>>,
	clearIndex: () => ipcRenderer.invoke(ipcChannels.agentMemoryClearIndex) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<{ removed: number }>>,
	exportBundle: (selection?: string[] | null) => ipcRenderer.invoke(ipcChannels.agentMemoryExport, { selection: selection ?? null }) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<import("../../shared/types/agentMemory").AgentMemoryExportOutcome>>,
	previewBundle: (filePath?: string) => ipcRenderer.invoke(ipcChannels.agentMemoryPreview, filePath ? { filePath } : {}) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<import("../../shared/types/agentMemory").AgentMemoryBundlePeekOutcome>>,
	importBundle: (options?: import("../../shared/types/agentMemory").AgentMemoryImportOptions) => ipcRenderer.invoke(ipcChannels.agentMemoryImport, options ?? {}) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<import("../../shared/types/agentMemory").AgentMemoryImportResult>>,
	list: () => ipcRenderer.invoke(ipcChannels.agentMemoryList) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<import("../../shared/types/agentMemory").AgentMemoryEntryList>>,
	deleteEntry: (input: { target: string; projectId?: string; key: string }) => ipcRenderer.invoke(ipcChannels.agentMemoryDeleteEntry, input) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<{ removed: number }>>,
	deleteEntries: (items: import("../../shared/types/agentMemory").AgentMemoryEntryRef[]) => ipcRenderer.invoke(ipcChannels.agentMemoryDeleteEntries, items) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<import("../../shared/types/agentMemory").AgentMemoryDeleteOutcome>>,
	restoreEntry: (input: { target: string; projectId?: string; content: string; category?: string }) => ipcRenderer.invoke(ipcChannels.agentMemoryRestoreEntry, input) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<{ restored: boolean }>>,
	revealRoot: () => ipcRenderer.invoke(ipcChannels.agentMemoryRevealRoot) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<null>>,
	standingRead: () => ipcRenderer.invoke(ipcChannels.agentMemoryStandingRead) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<string>>,
	standingWrite: (input: { content: string }) => ipcRenderer.invoke(ipcChannels.agentMemoryStandingWrite, input) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<{ chars: number }>>,
	renameDevice: (name: string) => ipcRenderer.invoke(ipcChannels.agentMemoryRenameDevice, name) as Promise<import("../../shared/types/agentMemory").AgentMemoryResult<{ id: string; name: string }>>,
};

export const platformApi = {
	agentMemory,
	piDeckMcp,
	hostPlugins,
	clipboard: {
		// 同步读取必须走主进程 sendSync：Electron 38 已废弃渲染进程/preload 直连 clipboard。
		readText: () => clipboardSync(ipcChannels.clipboardReadText, ""),
		readHtml: () => clipboardSync(ipcChannels.clipboardReadHtml, ""),
		readImage: () => clipboardSync(ipcChannels.clipboardReadImage, ""),
		/** 异步写入图片：data URL 可能较大，不能走 sendSync。 */
		writeImage: (dataUrl: string) => ipcRenderer.invoke(ipcChannels.clipboardWriteImage, dataUrl) as Promise<boolean>,
		/** 异步写入纯文本：诊断报告/AI 提示词可达数十 KB，直连 clipboard 在 Electron 38 已废弃。 */
		writeText: (value: string) => ipcRenderer.invoke(ipcChannels.clipboardWriteText, value) as Promise<boolean>,
	},
	quickTask: {
		getState: () => ipcRenderer.invoke(ipcChannels.quickTaskGetState) as Promise<import("../../shared/types/quickTask").QuickTaskState>,
		onChanged: (callback: (state: import("../../shared/types/quickTask").QuickTaskState) => void) => subscribe(ipcChannels.quickTaskChanged, callback),
		exit: () => ipcRenderer.invoke(ipcChannels.quickTaskExit) as Promise<void>,
		/** 任务模式 → 小窗：退出 quick-task 并展开极简浮窗。 */
		switchToMiniOverlay: () => ipcRenderer.invoke(ipcChannels.quickTaskSwitchToMiniOverlay) as Promise<void>,
	},
	floatingBall: {
		getState: () => ipcRenderer.invoke(ipcChannels.floatingBallGetState) as Promise<import("../../main/floating/FloatingController").FloatingBallState>,
		onStateChanged: (callback: (state: import("../../main/floating/FloatingController").FloatingBallState) => void) => subscribe(ipcChannels.floatingBallState, callback),
		enter: () => ipcRenderer.invoke(ipcChannels.floatingBallEnter) as Promise<void>,
		exit: () => ipcRenderer.invoke(ipcChannels.floatingBallExit) as Promise<void>,
		setEnabled: (enabled: boolean) => ipcRenderer.invoke(ipcChannels.floatingBallSetEnabled, enabled) as Promise<void>,
		setExpandTarget: (target: "mini" | "compact") => ipcRenderer.invoke(ipcChannels.floatingBallSetExpandTarget, target) as Promise<void>,
		dragStart: () => ipcRenderer.invoke(ipcChannels.floatingBallDragStart) as Promise<void>,
		dragMove: (x: number, y: number) => ipcRenderer.invoke(ipcChannels.floatingBallDragMove, x, y) as Promise<void>,
		dragEnd: () => ipcRenderer.invoke(ipcChannels.floatingBallDragEnd) as Promise<void>,
		contextMenu: () => ipcRenderer.invoke(ipcChannels.floatingBallContextMenu) as Promise<void>,
	},
	miniOverlay: {
		getState: () => ipcRenderer.invoke(ipcChannels.miniOverlayGetState) as Promise<import("../../main/floating/MiniOverlayWindow").MiniOverlayState | null>,
		onStateChanged: (callback: (state: import("../../main/floating/MiniOverlayWindow").MiniOverlayState) => void) => subscribe(ipcChannels.miniOverlayState, callback),
		jumpToSession: (sessionId: string, projectId: string) => ipcRenderer.invoke(ipcChannels.miniOverlayJumpToSession, sessionId, projectId) as Promise<void>,
		quickPrompt: (projectId: string, text: string) => ipcRenderer.invoke(ipcChannels.miniOverlayQuickPrompt, projectId, text) as Promise<{ ok: boolean; message?: string }>,
		close: () => ipcRenderer.invoke(ipcChannels.miniOverlayClose) as Promise<void>,
		collapse: () => ipcRenderer.invoke(ipcChannels.miniOverlayCollapse) as Promise<void>,
		/** 小窗 → 任务模式：隐藏小窗，主窗口以 quick-task 紧凑形态打开（projectPath 缺省用桌面）。 */
		switchToQuickTask: (projectPath?: string) => ipcRenderer.invoke(ipcChannels.miniOverlaySwitchToQuickTask, projectPath) as Promise<void>,
	} /**
	 * pi 供应商认证（`/login`）：pi 的登录只在它的 CLI 交互层存在，应用内登录走
	 * 这条例外通道（见 AGENTS.md「认证例外通道」）。调用方就是登录弹框。
	 */,
	piAuth: {
		listProviders: () => ipcRenderer.invoke(ipcChannels.piAuthListProviders) as Promise<{ ok: true; list: import("../../shared/types/piAuth").PiAuthProviderList } | { ok: false; errorKind: import("../../shared/types/piAuth").PiAuthErrorKind; error: string }>,
		login: (request: import("../../shared/types/piAuth").PiAuthLoginRequest) => ipcRenderer.invoke(ipcChannels.piAuthLogin, request) as Promise<import("../../shared/types/piAuth").PiAuthLoginResult>,
		/** 回填 pi 的提问（授权码/API key 等）；false = 提问已失效（取消或超时后迟到） */
		answerPrompt: (promptId: string, value: string) => ipcRenderer.invoke(ipcChannels.piAuthAnswerPrompt, { promptId, value }) as Promise<boolean>,
		cancel: () => ipcRenderer.invoke(ipcChannels.piAuthCancel) as Promise<boolean>,
		logout: (providerId: string) => ipcRenderer.invoke(ipcChannels.piAuthLogout, providerId) as Promise<import("../../shared/types/piAuth").PiAuthLogoutResult>,
		onFlowUpdate: (callback: (update: import("../../shared/types/piAuth").PiAuthFlowUpdate) => void) => subscribe(ipcChannels.piAuthFlowUpdate, callback),
	},
	// 数据环境（数据模式决策 / 目录归属校验）：chooseMode 只写决策指针，重启后 setPath 分流才生效。
	dataEnv: {
		getInfo: () => ipcRenderer.invoke(ipcChannels.dataEnvGetInfo) as Promise<DataEnvInfo>,
		chooseMode: (mode: DataEnvMode) => ipcRenderer.invoke(ipcChannels.dataEnvChooseMode, mode) as Promise<DataEnvChoiceResult | DataEnvChoiceFailure>,
		restart: () => ipcRenderer.invoke(ipcChannels.dataEnvRestart) as Promise<void>,
		confirmMismatch: (action: "continue" | "quit") => ipcRenderer.invoke(ipcChannels.dataEnvConfirmMismatch, action) as Promise<void>,
		onDecisionRequired: (callback: () => void) => subscribe(ipcChannels.dataEnvDecisionRequired, callback),
		onMismatchDetected: (callback: (payload: { dataModeInDir: DataEnvMode }) => void) => subscribe(ipcChannels.dataEnvMismatchDetected, callback),
		/** 数据导入（规格 §6 仅首启、仅正式→dev）：进度经 dataEnvImportProgress 推送，订阅返回退订函数。 */
		getImportPreview: () => ipcRenderer.invoke(ipcChannels.dataEnvGetImportPreview) as Promise<ImportPreviewResult>,
		importStart: () => ipcRenderer.invoke(ipcChannels.dataEnvImportStart) as Promise<ImportStartResult>,
		importCancel: () => ipcRenderer.invoke(ipcChannels.dataEnvImportCancel) as Promise<void>,
		onImportProgress: (callback: (progress: ImportProgress) => void) => subscribe(ipcChannels.dataEnvImportProgress, callback),
	},
	// 频道切换（跨通道查版本 → 下载 → 引导安装，规格 §3）：业务在 ChannelSwitchService，快照经 channelSwitchStateChanged 推送。
	channelSwitch: {
		query: () => ipcRenderer.invoke(ipcChannels.channelSwitchQuery) as Promise<import("../../shared/types/app").ChannelSwitchActionResult>,
		download: (asset: import("../../shared/types/app").TargetChannelRelease) => ipcRenderer.invoke(ipcChannels.channelSwitchDownload, asset) as Promise<import("../../shared/types/app").ChannelSwitchActionResult>,
		launch: (installerPath: string) => ipcRenderer.invoke(ipcChannels.channelSwitchLaunch, installerPath) as Promise<import("../../shared/types/app").ChannelSwitchActionResult>,
		getStatus: () => ipcRenderer.invoke(ipcChannels.channelSwitchGetStatus) as Promise<import("../../shared/types/app").ChannelSwitchSnapshot>,
		onStateChanged: (callback: (snapshot: import("../../shared/types/app").ChannelSwitchSnapshot) => void) => subscribe(ipcChannels.channelSwitchStateChanged, callback),
	},
	shellMenu: {
		getQuickTaskState: () => ipcRenderer.invoke(ipcChannels.shellMenuQuickTaskGetState) as Promise<{ supported: boolean; registered: boolean }>,
		setQuickTaskEnabled: (enabled: boolean) => ipcRenderer.invoke(ipcChannels.shellMenuQuickTaskSetEnabled, enabled) as Promise<{ supported: boolean; registered: boolean }>,
		/** 查询资源管理器右键菜单注册状态（非 Windows 返回 supported=false） */
		getState: () =>
			ipcRenderer.invoke(ipcChannels.shellMenuGetState) as Promise<{
				supported: boolean;
				registered: boolean;
			}>,
		/** 启用/取消「用 PiDeck 打开」右键菜单（HKCU 写入，portable 亦可用） */
		setEnabled: (enabled: boolean) =>
			ipcRenderer.invoke(ipcChannels.shellMenuSetEnabled, enabled) as Promise<{
				supported: boolean;
				registered: boolean;
			}>,
	},
	system: {
		/** 进程监控：拉取 Electron 各进程 + pi agent 子进程内存/CPU 快照 */
		getProcessMetrics: () => ipcRenderer.invoke(ipcChannels.processMetrics) as Promise<ProcessMetricsSnapshot>,
		/** 停止指定 pi agent（按 agentId），成功后刷新进程快照即可看到消失 */
		stopAgent: (agentId: string) => ipcRenderer.invoke(ipcChannels.stopAgent, agentId) as Promise<void>,
		/** 开发诊断快照：内存 / 事件循环延迟 / 最近关键耗时 */
		getDiagnosticsSnapshot: () => ipcRenderer.invoke(ipcChannels.diagnosticsSnapshot) as Promise<DiagnosticsSnapshot>,
		/** 运行架构检测：判断是否在 ARM 芯片上跑 x64 转译包（Rosetta），用于提示换原生包 */
		getArchStatus: () => ipcRenderer.invoke(ipcChannels.archStatus) as Promise<ArchStatus>,
		openDiagnosticsFolder: () => ipcRenderer.invoke(ipcChannels.diagnosticsOpenFolder) as Promise<void>,
		/** 环境体检：跑一次完整检查并返回脱敏报告。 */
		healthCheck: () => ipcRenderer.invoke(ipcChannels.healthCheck) as Promise<HealthReport>,
		/** 把 Markdown 报告保存到用户选择的路径。 */
		healthExportReport: (markdown: string, reportJson?: string) => ipcRenderer.invoke(ipcChannels.healthExportReport, markdown, reportJson) as Promise<HealthExportResult>,
		/** 把脱敏日志 + 报告 + 环境 JSON 打成 zip 保存到用户选择的路径。 */
		healthExportBundle: (markdown: string, reportJson: string) => ipcRenderer.invoke(ipcChannels.healthExportBundle, markdown, reportJson) as Promise<HealthExportResult>,
	},
	pet: {
		/** 宠物窗监听主进程推送的聚合状态 */
		onState: (callback: (state: PetAggregateState) => void) => subscribe(ipcChannels.petState, callback),
		/** 列出可用宠物包（内置 + petdex） */
		list: () => ipcRenderer.invoke(ipcChannels.petList) as Promise<PetManifest[]>,
		/** 开关宠物 */
		setEnabled: (value: boolean) => ipcRenderer.invoke(ipcChannels.petSetEnabled, value) as Promise<void>,
		/** 切换当前宠物 */
		setId: (id: string) => ipcRenderer.invoke(ipcChannels.petSetId, id) as Promise<void>,
		/** 拖拽移动宠物窗 */
		moveWindow: (pos: { x: number; y: number }) => ipcRenderer.invoke(ipcChannels.petMoveWindow, pos) as Promise<void>,
		/** 点击宠物跳转活跃 Agent */
		focusAgent: () => ipcRenderer.invoke(ipcChannels.petFocusAgent) as Promise<void>,
		onFocusTarget: (callback: (target: FocusTargetPayload) => void) => subscribe(ipcChannels.petFocusAgentTarget, callback),
		/** 冷启动/页面加载期间点击通知或右键菜单的跳转目标：挂载后主动拉取（一次性） */
		getPendingFocusTarget: () => ipcRenderer.invoke(ipcChannels.petGetFocusTargetPending) as Promise<FocusTargetPayload | null>,
		/** 主进程推送当前选中宠物的 manifest，据此加载 spritesheet */
		onSprite: (callback: (manifest: PetManifest) => void) => subscribe(ipcChannels.petCurrentSprite, callback),
		/** 挂载时主动拉取当前选中宠物 manifest（避免推送竞态） */
		getCurrent: () => ipcRenderer.invoke(ipcChannels.petGetCurrent) as Promise<PetManifest | null>,
		/** 主进程推送通知气泡（出错/完成/等待操作；null 表示清空当前提醒） */
		onNotify: (callback: (n: PetNotification | null) => void) => subscribe(ipcChannels.petNotify, callback),
		setPreviewMode: (mode: string) => ipcRenderer.invoke(ipcChannels.petPreviewMode, mode) as Promise<void>,
		onPreviewMode: (callback: (mode: string) => void) => subscribe(ipcChannels.petPreviewMode, callback),
		onCaps: (callback: (caps: PetWindowCaps) => void) => subscribe(ipcChannels.petCaps, callback),
		/** 调试：发送测试通知弹窗 */
		testNotify: (type: "error" | "done") => ipcRenderer.invoke(ipcChannels.petTestNotify, type) as Promise<void>,
		/** 双击宠物触发逗弄：主进程注入一次 jumping 后恢复真实聚合态 */
		tease: () => ipcRenderer.invoke(ipcChannels.petTease) as Promise<void>,
		/** 通知主进程拖拽起止：开始时暂停巡游，结束时若处于 idle 则恢复巡游 */
		setDragging: (dragging: boolean) => ipcRenderer.invoke(ipcChannels.petDragState, dragging) as Promise<void>,
		/** 拖拽相对位移（连续 screenX 差值），主进程读取当前窗口位置 + 增量 */
		moveBy: (delta: { dx: number; dy: number }) => ipcRenderer.invoke(ipcChannels.petMoveBy, delta) as Promise<void>,
		/** 通知主进程：宠物窗 React 已挂载，IPC 监听器已注册，可以安全推送初始状态 */
		ready: () => ipcRenderer.send(ipcChannels.petReady),
		/** 右键上下文菜单 */
		contextMenu: () => ipcRenderer.invoke(ipcChannels.petContextMenu) as Promise<void>,
	},
};
