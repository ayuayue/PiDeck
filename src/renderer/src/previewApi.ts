import type { PiDesktopApi } from "../../preload";
import {
	createDefaultExternalEditorSettings,
	createDefaultSecurityConfig,
	createDefaultSoundAlertSettings,
	DEFAULT_PET_SCALE,
} from "../../shared/types";
import type {
	AppSettings,
	FileTreeNode,
	Project,
	SessionRecord,
	SessionSummary,
	TerminalDataEvent,
	TerminalExitEvent,
	TerminalTab,
} from "../../shared/types";
import { t } from "./i18n";

const now = Date.now();

const projects: Project[] = [
	{
		id: "builtin-chat",
		name: "Chat",
		path: "C:/Users/14012/AppData/Roaming/pi-desktop/chat-workspace",
		lastOpenedAt: now,
		pinned: true,
		sortOrder: -1,
		kind: "chat",
	},
	{
		id: "preview-project",
		name: "preview-project",
		path: "C:/Users/14012/preview-project",
		lastOpenedAt: now,
		sortOrder: 0,
	},
];

const files: FileTreeNode[] = [
	{
		name: "src",
		path: "C:/Users/14012/preview-project/src",
		relativePath: "src",
		type: "directory",
		children: [
			{
				name: "App.tsx",
				path: "C:/Users/14012/preview-project/src/App.tsx",
				relativePath: "src/App.tsx",
				type: "file",
			},
		],
	},
	{
		name: "README.md",
		path: "C:/Users/14012/preview-project/README.md",
		relativePath: "README.md",
		type: "file",
	},
];

function findPreviewDirectory(
	nodes: FileTreeNode[],
	directory: string,
): FileTreeNode | undefined {
	for (const node of nodes) {
		if (node.type === "directory" && node.path === directory) return node;
		if (node.children) {
			const nested = findPreviewDirectory(node.children, directory);
			if (nested) return nested;
		}
	}
	return undefined;
}

function getSessions(): SessionSummary[] {
	return [
		{
			id: "s1",
			filePath: "preview.jsonl",
			projectPath: projects[0].path,
			name: t("preview.sessionName"),
			preview: t("preview.sessionPreview"),
			updatedAt: now,
			messageCount: 3,
		},
	];
}

const terminalTabs: TerminalTab[] = [];
const terminalDataListeners = new Set<(payload: TerminalDataEvent) => void>();
const terminalExitListeners = new Set<(payload: TerminalExitEvent) => void>();

let previewSettings: AppSettings = {
	useNativeTitleBar: true,
	showNativeMenu: false,
	sendShortcut: "enter-send",
	defaultAgentBackend: "pi",
	theme: "system",
	themeScheduleLightStart: "07:00",
	themeScheduleDarkStart: "19:00",
	accent: "default",
	themeSkin: "classic-green",
	customThemeOverrides: {},
	backgroundImage: "",
	backgroundImageOpacity: 0.8,
	language: "system",
	startupWindowMode: "last",
	piEnvironmentChecked: true,
	/** 扩展禁用白名单：与 SettingsStore 默认一致，预览壳不启用白名单 */
	/** 扩展禁用白名单：与 SettingsStore 默认一致，预览壳不启用白名单 */
	disabledExtensions: [],
	disableExtensionWhitelist: false,
	sessionTabOpenMode: "preview",
	// 与 SettingsStore 默认一致：忙碌时发送默认「插入当前回合」
	busySendDelivery: "steer",
	enableGitManagement: true,
	gitCommitMessagePrompt: "",
	gitCommitMessageProvider: "",
	gitCommitMessageModel: "",
	closeToTray: true,
	singleInstance: true,
	enableNotifications: true,
	// 与主进程 SettingsStore 默认一致：首轮完成后由内置扩展异步生成标题
	autoSessionTitle: true,
	// Ask 提问系统通知默认关闭：与主进程 SettingsStore 默认一致
	askNotificationEnabled: false,
	// 人文关怀提醒开关：与主进程 SettingsStore 默认值保持一致（预览 mock 需覆盖 AppSettings 全部必填字段）
	agentCountReminderEnabled: true,
	// showThinking 由 pi agent 的 hideThinkingBlock 控制，运行时从主进程加载
	showThinking: true,
	// 流式对话行为：与主进程 SettingsStore 默认一致（预览窗口保持相同观感）
	expandInterimDuringStream: true,
	collapsePrevRunsOnNewTurn: true,
	showDevTools: false,
	developerDiagnostics: false,
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
	wslEnabled: false,
	wslDistro: "Ubuntu",
	wslUser: "root",
	telemetryEnabled: true,
	webServiceEnabled: false,
	webServiceHost: "0.0.0.0",
	webServicePort: 8765,
	rpcTimeout: 600_000,
	linkOpenMode: "external",
	workspaceContentOpenMode: "split",
	contentMaxWidth: 1800,
	chatContentWidthPct: 80,
	maxEditorFileSizeMB: 5,
	externalEditors: createDefaultExternalEditorSettings(),

	// 桌面宠物默认关闭
	petEnabled: false,
	petId: "clawd",
	petAlwaysOnTop: true,
	petScale: DEFAULT_PET_SCALE,
	petPatrolEnabled: true,
	petPatrolPauseMin: 5,
	// 闲置 agent 自动释放（预览模式不真实释放，仅保持设置项可用）
	idleAgentAutoRelease: true,
	idleAgentKeepCount: 5,
	idleAgentTimeoutMin: 60,
	favoriteModels: [],

	fontSize: "default",
	uiFontSize: null,
	chatFontSize: null,
	inputFontSize: null,
	zoomFactor: 1,
	fontFamilyBase: "system",
	fontFamilyBaseCustom: "",
	fontFamilyMono: "system-mono",
	fontFamilyMonoCustom: "",
	removedBuiltInExtensions: [],
	// 与主进程 defaultSettings 保持一致（预览壳不真实播放，仅保持设置项形状完整）
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

export function createPreviewApi(): PiDesktopApi {
	const noop = (() => () => undefined) as any;
	const clipboardStub: PiDesktopApi["clipboard"] = {
		// preview 模式无真实剪贴板；浏览器下 navigator.clipboard 为异步 API，
		// 与同步接口不匹配，因此返回空串，右键粘贴菜单静默无操作
		readText: () => "",
		readHtml: () => "",
		readImage: () => "",
		writeImage: async () => false,
		writeText: async () => false,
	};
	const createTerminalTab = async (agentId: string, shell?: string, cwd?: string) => {
		const shellName = shell ?? "powershell";
		const displayName = shellName === "git-bash" ? "Git Bash" : shellName === "bash" ? "bash" : shellName === "cmd" ? "cmd" : "PowerShell";
		const tab: TerminalTab = {
			id: `preview-terminal-${terminalTabs.length + 1}`,
			agentId,
			ownerKey: `agent:${agentId}`,
			title: `${displayName} ${terminalTabs.length + 1}`,
			cwd: "C:/Users/14012/preview-project",
			shell: "powershell",
			createdAt: Date.now(),
		};
		terminalTabs.push(tab);
		setTimeout(() => {
			for (const listener of terminalDataListeners) {
				listener({
					tabId: tab.id,
					data: "Windows PowerShell\r\nPS C:\\\\Users\\\\14012\\\\preview-project> ",
				});
			}
		}, 0);
		return tab;
	};
	return {
		clipboard: clipboardStub,
		// 进程监控预览桩：返回空快照，仅供预览模式不崩溃
		system: {
			getProcessMetrics: async () => ({
				agents: [],
				totalAgentBytes: 0,
				sampledAt: Date.now(),
			}),
			stopAgent: async () => undefined,
			getDiagnosticsSnapshot: async () => ({
				enabled: false,
				sampledAt: Date.now(),
				main: {
					rssBytes: 0,
					heapUsedBytes: 0,
					heapTotalBytes: 0,
					externalBytes: 0,
					arrayBuffersBytes: 0,
				},
				eventLoopLagMs: 0,
				eventLoopLagMaxMs: 0,
				memoryProfilePath: null,
				timingsPath: null,
				recentTimings: [],
			}),
			openDiagnosticsFolder: async () => undefined,
			// 环境体检预览桩：返回空报告，仅供预览模式不崩溃
			healthCheck: async () => ({
				generatedAt: Date.now(),
				environment: {
					appVersion: "preview",
					platform: "win32",
					arch: "",
					osVersion: "",
					locale: "",
					timezone: "",
					electronVersion: "",
					chromeVersion: "",
					nodeVersion: "",
					installMode: "dev",
					userDataDir: "",
					logsDir: "",
					appRssBytes: 0,
					appHeapUsedBytes: 0,
					systemTotalMemoryBytes: 0,
					systemFreeMemoryBytes: 0,
					dataDirFreeBytes: 0,
					flags: {
						wslEnabled: false,
						wslDistro: "",
						piProxyEnabled: false,
						desktopProxyEnabled: false,
						piProxyConfigured: false,
						chromiumSandbox: false,
						developerDiagnostics: false,
						webServiceEnabled: false,
						customPiPathConfigured: false,
					},
					pi: { installed: false, searchedDirs: [] },
				},
				checks: [],
				logSummary: { total: 0, error: 0, warn: 0, todayError: 0, todayWarn: 0, recent: [] },
				logFiles: [],
			}),
			healthExportReport: async () => ({ ok: true, canceled: false, path: "preview" }),
			healthExportBundle: async () => ({ ok: true, canceled: false, path: "preview" }),
		},
		editors: {
			list: async () => [],
			redetect: async () => ({ ...previewSettings }),
			update: async (_editorId, patch) => {
				previewSettings = {
					...previewSettings,
					externalEditors: {
						...previewSettings.externalEditors,
						[_editorId]: {
							...previewSettings.externalEditors[_editorId],
							...patch,
							updatedAt: Date.now(),
						},
					},
				};
				return { ...previewSettings };
			},
			chooseExecutable: async () => null,
			openProject: async () => undefined,
		},
		projects: {
			list: async () => projects,
			add: async () => projects[0],
			remove: async () => projects,
			reorder: async (projectIds) => {
				projects.sort((a, b) => projectIds.indexOf(a.id) - projectIds.indexOf(b.id));
				return projects;
			},
			rename: async () => projects,
			onChanged: noop,
			listRoot: async () => projects,
			listWorktreeChildren: async () => [],
			toggleWorktreeEnabled: async () => projects[0],
			chooseChatPath: async () => null,
			setChatPath: async () => projects[0],
			listModels: async () => [],
			// 预览 iframe 不需要真实模型目录：构造一个恒空报告（无失败原因），
			// 与真实通道的 ModelListReport 形状保持一致，避免类型分叉。
			listModelsReport: async () => ({
				models: [],
				ok: false,
				reason: null,
				version: null,
				detail: "",
				source: "none" as const,
				at: Date.now(),
			}),
			getModelSpec: async () => null,
			onTrustRequest: noop,
			respondTrustRequest: async () => undefined,
		},
		projectResources: {
			list: async () => ({ skills: [], extensions: [] }),
			createSkill: async (input) => ({
				id: `project-pi:${input.name}`,
				name: input.name,
				description: input.description,
				path: `C:/Users/preview/project/.pi/skills/${input.name}/SKILL.md`,
				dir: `C:/Users/preview/project/.pi/skills/${input.name}`,
				sourceId: "project-pi" as const,
				sourceLabel: ".pi/skills",
				type: "directory" as const,
				enabled: true,
				valid: true,
				warnings: [],
			}),
			deleteSkill: async () => undefined,
			deleteExtension: async () => undefined,
			toggleExtension: async () => undefined,
			renameSkill: async (_projectId, _skillPath, newName) => ({
				id: `project-pi:${newName}`,
				name: newName,
				description: "",
				path: `C:/Users/preview/project/.pi/skills/${newName}/SKILL.md`,
				dir: `C:/Users/preview/project/.pi/skills/${newName}`,
				sourceId: "project-pi" as const,
				sourceLabel: ".pi/skills",
				type: "directory" as const,
				enabled: true,
				valid: true,
				warnings: [],
			}),
		toggleSkill: async (_projectId, _skillPath, enabled) => ({
				id: "project-pi:preview-toggle",
				name: "preview-skill",
				description: "",
				path: "C:/Users/preview/project/.pi/skills/preview-skill/SKILL.md",
				dir: "C:/Users/preview/project/.pi/skills/preview-skill",
				sourceId: "project-pi" as const,
				sourceLabel: ".pi/skills",
				type: "directory" as const,
				enabled,
				valid: true,
				warnings: [],
			}),
		},
		files: {
			list: async (_projectId, options) => {
				if (options?.directory) {
					const match = findPreviewDirectory(files, options.directory);
					return match?.children ?? [];
				}
				return files;
			},
			open: async () => undefined,
			showInFolder: async () => undefined,
			// 预览模式无主进程：不检测文件管理器（打开方式下拉不显示该入口）
			detectFileManager: async () => null,
			openFileManager: async () => undefined,
			readContent: async () => "",
			// 预览模式无法 stat 真实磁盘：返回空数组，校验方按「未知」处理维持链接现状
			pathsExist: async () => [],
			readBase64: async () => "",
			create: async () => "/mock/created",
			writeContent: async () => undefined,
			delete: async () => undefined,
			rename: async () => "",
			copy: async () => [],
			move: async () => [],
			getPathForFile: () => "",
			getClipboardPaths: () => [],
		},
		pasteFiles: {
			// 预览/浏览器模式无主进程：拒绝写盘（调用方会走「按文本粘贴」回退）
			write: async () => {
				throw new Error("preview mode: paste file write is not available");
			},
			delete: async () => undefined,
			cleanup: async () => 0,
		},
		dialog: {
			pickFiles: async () => [],
			pickBackgroundImage: async () => "",
			removeBackgroundImage: async () => undefined,
		},
		sessions: {
			list: async () => getSessions(),
			// 预览模式无 DSH host：空预设目录满足接口契约
			listDshAgentPresets: async () => [],
			getDshDefaultModel: async () => undefined,
			// 预览模式无主进程配置可解析：无启动默认（底栏不预选，不影响其它功能）
			resolveLaunchDefaults: async () => ({}),
			getDshSessionPath: async () => undefined,
			searchDshSessions: async () => [],
			createDshGoal: async () => undefined,
			runDshGoalAction: async () => undefined,
			listDshSubagents: async () => [],
			readDshSubagentHistory: async () => ({ messages: [], hasMore: false }),
			listSessionSubagents: async () => [],
			listSessionFileChanges: async () => [],
			listSessionTodo: async () => undefined,
			listDshSkills: async () => [],
			listDshOrphans: async () => [],
			listDshForeignSessions: async () => [],
			importDshForeignSession: async () => {
				throw new Error("preview mode: DSH session import is not available");
			},
			syncDshForeignSessions: async () => ({ imported: 0, skipped: 0 }),
			listArchivedDshSessions: async () => [],
			unarchiveDshSession: async () => true,
			deleteArchivedDshSession: async () => true,
			listDshDynamicPlugins: async () => [],
			listDshStaticPlugins: async () => [],
			installDshPlugin: async () => undefined,
			runDshPlugin: async () => undefined,
			stopDshPlugin: async () => undefined,
			uninstallDshPlugin: async () => undefined,
			listCatalog: async (projectId, _options?: { scan?: boolean }): Promise<SessionRecord[]> => getSessions().map((session) => ({
				id: `preview-record:${session.id}`,
				projectId,
				title: session.name || "Preview session",
				source: session.source || "pi",
				environment: session.wsl ? "wsl" : "native",
				filePath: session.filePath,
				parentSessionPath: session.parentSessionPath,
				projectPath: session.projectPath,
				preview: session.preview,
				messageCount: session.messageCount,
				status: "active",
				createdAt: session.updatedAt,
				updatedAt: session.updatedAt,
				wsl: session.wsl,
			})),
			// 预览模式无后台扫描推送：返回空退订函数满足接口契约
			onCatalogRefreshed: () => () => undefined,
			createDraft: async (input): Promise<SessionRecord> => ({
				id: `preview-draft:${input.projectId}`,
				projectId: input.projectId,
				title: input.title || "New session",
				source: "pi",
				environment: "native",
				preview: "",
				messageCount: 0,
				status: "draft",
				model: input.model,
				thinkingLevel: input.thinkingLevel,
				createdAt: now,
				updatedAt: now,
			}),
			createAnonymous: async (input) => ({
				session: {
					id: `preview-anonymous:${input.projectId}`,
					projectId: input.projectId,
					title: input.title || "Anonymous chat",
					noSession: true,
					source: "pi",
					environment: "native",
					preview: "",
					messageCount: 0,
					status: "active",
					createdAt: now,
					updatedAt: now,
				},
				runtime: {
					sessionId: `preview-anonymous:${input.projectId}`,
					agentId: "preview-anonymous-agent",
					runtimeGeneration: 1,
					projectId: input.projectId,
					cwd: projects.find((project) => project.id === input.projectId)?.path || "",
					status: "idle",
					createdAt: now,
					noSession: true,
				},
			}),
			updateRecord: async (sessionId, patch): Promise<SessionRecord> => ({
				id: sessionId,
				projectId: projects[0].id,
				title: patch.title || "Preview session",
				source: "pi",
				environment: "native",
				preview: "",
				messageCount: 0,
				status: "draft",
				model: patch.model ?? undefined,
				thinkingLevel: patch.thinkingLevel ?? undefined,
				createdAt: now,
				updatedAt: now,
			}),
			deleteRecord: async () => true,
			archiveRecord: async () => true,
			unarchiveRecord: async () => true,
			listArchived: async () => [],
			deleteArchivedRecord: async () => true,
			copyRecord: async (sessionId) => ({
				cancelled: false,
				targetSessionId: `${sessionId}:copy`,
			}),
			exportRecordHtml: async () => ({ path: "preview-session.html" }),
			readRecordMessages: async () => [],
			readRecordMessagePage: async () => ({ messages: [], total: 0, nextBefore: null }),
			editCatalogMessage: async () => ({ ok: true as const, value: undefined }),
			deleteCatalogMessage: async () => ({ ok: true as const, value: undefined }),
			prepareCatalogResend: async () => ({ ok: true as const, value: { text: "" } }),
			readProcessEvents: async () => [],
			readDshSystemPrompt: async () => undefined,
			readMessageFullText: async () => ({ text: "" }),
			readReferenceMessages: async () => [
				{ role: "user", content: "Preview user message", timestamp: Date.now() - 60000 },
				{ role: "assistant", content: "Preview assistant response", timestamp: Date.now() - 30000 },
			],
			sendPrompt: async (input) => ({
				accepted: true,
				sessionId: input.sessionId,
				requestId: input.requestId,
				agentId: "preview-agent",
				sessionPath: "C:/Users/preview/.pi/session.jsonl",
				runtimeGeneration: 1,
			}),
			sendUiResponse: async () => undefined,
			onRuntimeEvent: noop,
			listRuntimes: async () => [],
			activateRuntime: async () => ({
				ok: false,
				error: { code: "SESSION_NOT_FOUND", debugDetails: "preview runtime activation is disabled" },
			}),
			stopRuntime: async (target) => ({ ok: true, value: target }),
			abortRuntime: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			restartRuntime: async (target) => ({
				ok: true,
				value: {
					previousTarget: target,
					runtime: {
						...target,
						projectId: projects[0].id,
						cwd: projects[0].path,
						status: "idle" as const,
						createdAt: now,
					},
					session: {
						id: target.sessionId,
						projectId: projects[0].id,
						title: "Preview session",
						source: "pi" as const,
						environment: "native" as const,
						preview: "",
						messageCount: 0,
						status: "active" as const,
						createdAt: now,
						updatedAt: now,
					},
				},
			}),
			compactRuntime: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			getRuntimeForkMessages: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			forkRuntimeSession: async (target) => ({
				ok: true,
				value: { cancelled: false, text: "", targetSessionId: `${target.sessionId}:fork` },
			}),
			listDshModels: async () => [],
			discoverDshModels: async () => [],
			listDshProviders: async () => [],
			getDshStatus: async () => ({
				started: false,
				homeDir: "",
				bootError: null,
			}),
			// 预览环境无 DSH 后端：按未安装处理（UI 走安装引导，不裸报错）。
			getDshRuntimeStatus: async () => ({ state: "notInstalled" as const }),
			onDshRuntimeStatusChanged: () => () => {},
			installDshRuntime: async () => ({ ok: false, error: "unavailable in preview" }),
			importDshRuntimeFile: async () => ({ ok: false, error: "unavailable in preview" }),
			uninstallDshRuntime: async () => ({ ok: false, error: "unavailable in preview" }),
			onDshRuntimeInstallProgress: () => () => {},
			describeDshSettings: async () => ({ writable: false, hasDocument: false, namespaces: [] }),
			updateDshSettings: async () => undefined,
			mutateDshSettings: async () => undefined,
			describeDshCredentials: async () => ({}),
			setDshCredential: async () => undefined,
			unsetDshCredential: async () => undefined,
			readDshCredential: async () => undefined,
			openDshDocument: async () => undefined,
			restartDshHost: async () => true,
			setFocusedSession: async () => undefined,
			getRuntimeState: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			listRuntimeCommands: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			listRuntimeModels: async (target) => ({
				ok: true,
				value: { target, value: [] },
			}),
			listRuntimeThinkingLevels: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			exportRuntimeHtml: async (target) => ({
				ok: true,
				value: { target, value: { path: "preview-session.html" } },
			}),
			editRuntimeMessage: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			deleteRuntimeMessage: async (target) => ({
				ok: true,
				value: { target, value: undefined },
			}),
			listRewindCheckpoints: async (target) => ({
				ok: true,
				value: { target, value: { items: [], hasMore: false } },
			}),
			getRewindCheckpointDiff: async (target) => ({
				ok: true,
				value: { target, value: "" },
			}),
			restoreRewindCheckpoint: async (target) => ({
				ok: true,
				value: { target, value: { filesRestored: true } },
			}),
			prepareRuntimeResend: async (target) => ({
				ok: true,
				value: { target, value: { text: "" } },
			}),
			setRuntimeModel: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			setRuntimeThinking: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			setRuntimePermission: async (target) => ({
				ok: true,
				value: { target, value: {} },
			}),
			cloneRuntime: async (target) => ({
				ok: true,
				value: { targetSessionId: `${target.sessionId}:copy` },
			}),
		},
		usageStats: {
			detect: async () => ({
				installed: false,
				logPath: null,
				recordCount: null,
				firstRecordAt: null,
				lastRecordAt: null,
			}),
			refresh: async () => ({
				fullRescan: false,
				parsedRecords: 0,
				skippedLines: 0,
			}),
			get: async () => null as unknown as import("../../shared/types").UsageAggregated,
		},
		codexSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		claudeSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		openCodeSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		zcodeSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		git: {
			listRepos: async () => [],
			branches: async () => ({ current: "main", branches: ["main", "dev"] }),
			checkout: async (_projectId, branch) => ({
				current: branch,
				branches: ["main", "dev"],
			}),
			createBranch: async (_projectId, branchName) => ({
				current: branchName,
				branches: ["main", "dev", branchName],
			}),
			// 预览环境无真实 Git，返回空原始内容，差异左侧显示为空。
			originalContent: async () => "",
			worktreeList: async () => [],
			worktreeCreate: async (_projectId, branchName) => ({
				path: `/tmp/worktree/${branchName}`,
				branch: branchName,
			}),
			worktreeRemove: async () => true,
				commitLog: async () => [],
				refs: async () => [],
				branchCompare: async () => ({ files: [], ahead: 0, behind: 0 }),
				commitDetail: async () => null,
				commitFileDiff: async () => null,
				diffFileBetween: async () => "",
				status: async () => ({ merge: [], index: [], workingTree: [], untracked: [] }),
				workspaceFileDiff: async () => null,
				stage: async () => {},
				unstage: async () => {},
				discard: async () => {},
				discardFiles: async () => {},
				commit: async () => {},
				cherryPick: async () => {},
				revert: async () => {},
				reset: async () => {},
				dropCommit: async () => {},
				generateCommitMessage: async () => ({ ok: true, message: "" }),
				init: async () => {},
			pull: async () => {},
			push: async () => {},
			fetch: async () => undefined,
			// 预览环境无真实远程：恒返回 null（不显示 push/pull 角标）
			aheadBehind: async () => null,
			deleteFiles: async () => {},
		},
		logs: {
			list: async () => [],
			listPage: async () => ({ entries: [], total: 0, page: 0, pageSize: 50, hasMore: false }),
			clear: async () => undefined,
			openFolder: async () => undefined,
			getSize: async () => 0,
		},
		rpcLogs: {
			getSize: async () => 0,
			get: async () => [],
			getLive: async () => [],
			save: async () => [],
			onLog: (_callback: unknown) => () => {},
			clear: async () => undefined,
			setLogging: async () => false,
			getLogging: async () => false,
		},
		pi: {
			check: async () => ({
				installed: true,
				command: "pi",
				version: "preview",
				searchedDirs: [],
			}),
			checkCustom: async (_path) => ({
				installed: true,
				command: _path,
				version: "preview",
				searchedDirs: [],
			}),
			checkUpdate: async () => ({
				currentVersion: "preview",
				latestVersion: "preview",
				hasUpdate: false,
			}),
			update: async () => ({
				command: "pi update pi --no-approve",
				output: "Preview mode: pi update output",
				updated: false,
			}),
			execInstall: async (_command) => ({
				success: true,
				exitCode: 0,
				stdout: "preview: exec install output",
				stderr: "",
			}),
			checkNpm: async () => ({
				available: true,
				version: "preview",
			}),
		},
		wsl: {
			listDistros: async () => ["Ubuntu", "Debian"],
			validateConnection: async (_distro, _user) => ({
				ok: true,
				whoami: "preview",
				piVersion: "preview",
				error: "",
			}),
		},
		app: {
			info: async () => ({
				version: "preview",
				releasesUrl: "https://github.com/ayuayue/PiDeck/releases",
				platform: "win32" as NodeJS.Platform,
				homeDir: "C:/Users/preview",
				userDataDir: "C:/Users/preview/AppData/Roaming/pi-desktop",
			}),
			preferredSystemLanguages: async () => navigator.languages?.length ? [...navigator.languages] : [navigator.language],
			networkAddresses: async () => [{ address: "192.168.1.100", interfaceName: "Wi-Fi", cidr: "192.168.1.100/24", isPrivate: true }],
			checkUpdate: async () => undefined,
			onUpdateStatus: () => () => undefined,
			getUpdateStatus: async () => null,
			notifyUpdateSeen: async () => undefined,
			skipUpdateVersion: async () => undefined,
			downloadUpdate: async () => undefined,
			installUpdate: async () => undefined,
			checkUpdateMirrors: async () => [
				{ id: "ghfast", status: "ok", latencyMs: 1200, speedKBps: 1780, checkedAt: Date.now() },
				{ id: "ghproxy-net", status: "slow", latencyMs: 2000, speedKBps: 262, checkedAt: Date.now() },
				{ id: "ghproxy-cxkpro", status: "ok", latencyMs: 1100, speedKBps: 13800, checkedAt: Date.now() },
			],
			onOpenInBrowser: () => () => undefined,
			feedbackEnvironment: async () => ({
				appVersion: "preview",
				platform: "win32",
				arch: "x64",
				electronVersion: "preview",
				chromeVersion: "preview",
				nodeVersion: "preview",
				pi: {
					installed: true,
					command: "pi",
					version: "preview",
					searchedDirs: [],
				},
			}),
			getFeedbackProjectContext: async (_projectId: string) => ({
				projectId: _projectId,
				projectName: "preview",
				agentsMd: "",
				agentsMdTruncated: false,
				skills: [],
			}),
			openExternal: async () => undefined,
			restart: async () => undefined,
			quit: async () => undefined,
			openDataDir: async () => ({ ok: true }),
			rendererLog: async (level, scope, message, detail) => {
				console[level === "error" ? "error" : level === "warn" ? "warn" : "debug"](
					`[${scope}] ${message}`,
					detail,
				);
			},
			minimizeWindow: async () => undefined,
			toggleMaximizeWindow: async () => false,
			isWindowMaximized: async () => false,
			onWindowMaximizedChange: () => () => undefined,
			toggleAlwaysOnTopWindow: async () => false,
			isWindowAlwaysOnTop: async () => false,
			closeWindow: async () => undefined,
			toggleDevTools: async () => false,
		},
		skills: {
			list: async () => ({
				locations: [
					{
						id: "pi-global" as const,
						label: "~/.pi/agent/skills",
						path: "C:/Users/preview/.pi/agent/skills",
						rootMarkdownEnabled: true,
					},
					{
						id: "agents-global" as const,
						label: "~/.agents/skills",
						path: "C:/Users/preview/.agents/skills",
						rootMarkdownEnabled: false,
					},
				],
				skills: [
					{
						id: "pi-global:preview-skill",
						name: "preview-skill",
						description: "A preview skill",
						path: "C:/Users/preview/.pi/agent/skills/preview-skill/SKILL.md",
						dir: "C:/Users/preview/.pi/agent/skills/preview-skill",
						sourceId: "pi-global" as const,
						sourceLabel: "~/.pi/agent/skills",
						type: "directory" as const,
						enabled: true,
						valid: true,
						warnings: [],
					},
				],
			}),
			readContent: async (_path) => ({
				content: "# preview-skill\n\nPreview skill body used by the browser preview layout.",
			}),
			create: async (input) => ({
				id: `pi-global:${input.name}`,
				name: input.name,
				description: input.description,
				path: `C:/Users/preview/.pi/agent/skills/${input.name}/SKILL.md`,
				dir: `C:/Users/preview/.pi/agent/skills/${input.name}`,
				sourceId: input.locationId,
				sourceLabel: "~/.pi/agent/skills",
				type: "directory" as const,
				enabled: true,
				valid: true,
				warnings: [],
			}),
			toggle: async (path, enabled) => ({
				id: `pi-global:${path}`,
				name: "preview-skill",
				description: "Preview skill",
				path,
				dir: path.replace(/[/\\]SKILL\.md$/, ""),
				sourceId: "pi-global" as const,
				sourceLabel: "~/.pi/agent/skills",
				type: "directory" as const,
				enabled,
				valid: true,
				warnings: [],
			}),
			delete: async () => undefined,
			openFolder: async () => undefined,
			rename: async (_skillPath, newName) => ({
				id: `pi-global:preview/${newName}/SKILL.md`,
				name: newName,
				description: "Preview skill",
				path: `C:/Users/preview/.pi/agent/skills/${newName}/SKILL.md`,
				dir: `C:/Users/preview/.pi/agent/skills/${newName}`,
				sourceId: "pi-global" as const,
				sourceLabel: "~/.pi/agent/skills",
				type: "directory" as const,
				enabled: true,
				valid: true,
				warnings: [],
			}),
		},
		extensions: {
			list: async (_forceRefresh = false) => ({
				extensions: [
					{
						id: "user:npm:preview-extension",
						source: "npm:preview-extension",
						path: "C:/Users/preview/.pi/agent/npm/node_modules/preview-extension",
						scope: "user" as const,
					},
				],
				raw: "User packages:\n  npm:preview-extension\n    C:/Users/preview/.pi/agent/npm/node_modules/preview-extension\n",
			}),
			uninstall: async () => undefined,
			install: async (_source: string) => "",
			toggle: async () => undefined,
			setWhitelistDisabled: async () => undefined,
			removeBuiltIn: async () => undefined,
			restoreBuiltIn: async () => undefined,
			update: async () => ({
				command: "pi update --extensions --no-approve",
				output: "Preview mode: extensions update output",
				updated: false,
			}),
			updateOne: async (_source: string) => ({
				command: "pi update <source>",
				output: "Preview mode: extension update-one output",
				updated: false,
			}),
		},
		prompts: {
			list: async () => ({ templates: [], globalDir: "C:/Users/preview/.pi/agent/prompts" }),
			create: async (input) => ({
				name: input.name,
				path: `C:/Users/preview/.pi/agent/prompts/${input.name}.md`,
				description: input.description,
				content: `---\ndescription: ${input.description}\n---\n`,
				userCreated: true,
			}),
			delete: async () => undefined,
			openFolder: async () => undefined,
			edit: async (_filePath, _content?) => "---\ndescription: Preview\n---\n\nPreview content",
			listByProject: async () => ({ templates: [], globalDir: "" }),
			createInProject: async (_projectPath, input) => ({
				name: input.name,
				path: `project://${_projectPath}/.pi/prompts/${input.name}.md`,
				description: input.description,
				content: `---\ndescription: ${input.description}\n---\n`,
				userCreated: true,
				scope: "project",
			}),
			deleteFromProject: async () => undefined,
			rename: async (_oldName, newName) => ({
				name: newName,
				path: `C:/Users/preview/.pi/agent/prompts/${newName}.md`,
				description: "Renamed prompt",
				content: `---\ndescription: Renamed prompt\n---\n`,
				userCreated: true,
			}),
			renameInProject: async (_projectPath, _oldName, newName) => ({
				name: newName,
				path: `project://${_projectPath}/.pi/prompts/${newName}.md`,
				description: "Renamed project prompt",
				content: `---\ndescription: Renamed project prompt\n---\n`,
				userCreated: true,
				scope: "project",
			}),
		},
		promptStore: {
			search: async (_query, _opts) => ({ query: _query ?? "", count: 0, prompts: [] }),
			get: async (_id) => ({ id: _id, title: "", description: "", content: "", type: "TEXT", author: "", category: "", tags: [], votes: 0, createdAt: "" }),
			import: async (data) => ({
				name: data.title.toLowerCase().replace(/[^\w-]+/g, "-"),
				path: `C:/Users/preview/.pi/agent/prompts/${data.title.toLowerCase().replace(/[^\w-]+/g, "-")}.md`,
				description: data.description,
				content: data.content,
				userCreated: true,
			}),
		},
		yaoPrompts: {
			list: async () => ({ categories: [], prompts: [], repoPath: "" }),
			detail: async () => ({ title: "", description: "", promptContent: "", fullContent: "" }),
			import: async (_slug, _category) => ({
				name: _slug,
				path: `C:/Users/preview/.pi/agent/prompts/${_slug}.md`,
				description: "Preview import",
				content: "Preview content",
				userCreated: true,
			}),
		},
		skillStore: {
			search: async () => ({ query: "", count: 0, prompts: [] }),
			import: async (data, _locationId) => ({
				name: data.title.toLowerCase().replace(/[^\w-]+/g, "-"),
				path: `C:/Users/preview/.pi/agent/skills/${data.title.toLowerCase().replace(/[^\w-]+/g, "-")}/SKILL.md`,
				description: data.description,
				enabled: true,
				valid: true,
				warnings: [],
				id: `pi-global:preview`,
				dir: "",
				sourceId: "pi-global",
				sourceLabel: "Preview",
				type: "directory",
			}),
		},
		skillHub: {
			search: async () => ({ query: "", total: 0, items: [] }),
			detail: async () => null,
			install: async (slug) => ({ success: true, slug, installDir: "", message: "Preview install" }),
		},
		settings: {
			get: async (): Promise<AppSettings> => ({ ...previewSettings }),
			update: async (patch): Promise<AppSettings> => {
				previewSettings = { ...previewSettings, ...patch };
				return { ...previewSettings };
			},
			restartWebService: async () => undefined,
			testPiProxy: async () => ({
				success: true,
				url: "https://api.openai.com/v1/models",
				elapsedMs: 120,
				statusCode: 401,
				message: t("preview.proxyOk"),
			}),
			onApplyWindow: noop,
		},
		security: {
			getConfig: async () => createDefaultSecurityConfig(),
			updateConfig: async () => ({
				ok: true,
				config: createDefaultSecurityConfig(),
			}),
			setSessionLevel: async () => ({
				ok: true,
				config: createDefaultSecurityConfig(),
			}),
		},
		config: {
			previewProviderMigration: async () => ({ direction: "pi-to-dsh" as const, providers: [] }),
			applyProviderMigration: async (direction, provider) => ({
				ok: true,
				provider,
				direction,
				copiedKey: false,
				wroteViaHost: false,
			}),
			getModels: async () => ({
				raw: '{"providers":{}}',
				parsed: { providers: {} },
			}),
			getAuth: async () => ({ raw: "{}", parsed: {} }),
			getSettings: async () => ({ raw: "{}", parsed: {} }),
			getTrust: async () => ({ raw: "{}", parsed: {} }),
			getMcp: async () => ({
				writablePath: "",
				writableFile: { mcpServers: {} },
				writableRaw: "{\n  \"mcpServers\": {}\n}\n",
				layers: [],
				servers: [],
			}),
			saveMcp: async () => ({ valid: true }),
			probeMcp: async () => ({ ok: true, transport: "stdio" as const, detail: "preview" }),
			// 预览模式无真实 pi 配置目录，返回占位（源文件页不显示路径行）。
			getConfigDir: async () => "",
			saveModels: async () => ({ valid: true, modelLoadOk: true, modelCount: 2, modelLoadReason: null, modelLoadDetail: "" }),
			saveAuth: async () => ({ valid: true }),
			saveSettings: async () => ({ valid: true }),
			saveRaw: async () => ({ valid: true }),
			export: async () =>
				JSON.stringify({
					version: 1,
					exportedAt: new Date().toISOString(),
					files: { "models.json": {}, "auth.json": {}, "settings.json": {}, "mcp.json": { mcpServers: {} } },
				}),
			import: async () => ({ valid: true }),
			fetchModels: async () => ({
				success: true,
				models: [
					{ id: "gpt-4o", name: "GPT-4o" },
					{ id: "gpt-4o-mini", name: "GPT-4o Mini" },
				],
			}),
			// 设计预览：内置 TokenDance 目录返回空（不触真实网络）
			getTokendanceModels: async () => ({ models: [], fromCache: false, at: 0 }),
			tokendanceAuthStart: async () => ({ ok: false, error: "preview" }),
			tokendanceAuthExchange: async () => ({ ok: false, error: "preview" }),
			installTokendance: async () => ({ ok: false, modelCount: 0, piSaved: false, dshSaved: false, error: "preview" }),
			testProvider: async () => ({
				success: true,
				model: "gpt-4o-mini",
				snippet: "Hello! How can I help you today?",
				tokens: { input: 8, output: 7 },
				latencyMs: 320,
			}),
			visionGetConfig: async () => ({
				config: null,
				configDir: "/tmp/preview/.pi/agent",
			}),
			visionSaveConfig: async () => ({ ok: true }),
			visionGetLog: async () => ({ exists: false, size: 0, content: "", truncated: false }),
			visionClearLog: async () => ({ ok: true }),
			visionGetEvents: async () => ({ exists: false, size: 0, events: [], truncated: false }),
			visionClearEvents: async () => ({ ok: true }),
			fetchUsage: async () => ({
				success: false,
				error: "preview",
			}),
			getUsageProbes: async () => ({ recognized: null, templates: [], errors: [] }),
			usageRecognized: async () => ({ recognized: false }),
			saveUsageProbes: async () => ({ ok: false, error: "preview" }),
			testUsageProbe: async () => ({ success: false, error: "preview" }),
			installUsageSkill: async () => ({ success: false, error: "preview" }),
			installImageGenSkill: async () => ({ success: false, error: "preview" }),
		},
		pet: {
			onState: noop,
			list: async () => [
			{ id: "clawd", displayName: "Clawd", source: "builtin", spritesheetUrl: "" },
		],
			setEnabled: async () => undefined,
			setId: async () => undefined,
			moveWindow: async () => undefined,
			moveBy: async () => undefined,
			ready: () => undefined,
			contextMenu: async () => undefined,
			focusAgent: async () => undefined,
			onFocusTarget: noop,
			getPendingFocusTarget: async () => null,
			onSprite: noop,
			onNotify: noop,
			setPreviewMode: async () => undefined,
			onPreviewMode: noop,
			onCaps: noop,
			testNotify: async () => undefined,
			tease: async () => undefined,
			setDragging: async () => undefined,
			getCurrent: async () => ({ id: "clawd", displayName: "Clawd", source: "builtin", spritesheetUrl: "" }),
		},
		sounds: {
			// 预览模式：不真实播放，事件订阅空操作（保持 PiDesktopApi 形状完整）
			onPlay: noop,
			listCustom: async () => [],
			importCustom: async () => ({ ok: false, error: "canceled" as const }),
			removeCustom: async () => false,
		},
		terminal: {
			// 预览模式只按归属键过滤：agent 目标用 agentId，project 目标用项目 id
			list: async (target) =>
				terminalTabs.filter((tab) => tab.agentId === (target.kind === "agent" ? target.agentId : target.projectId)),
			ensure: async (target) => {
				const key = target.kind === "agent" ? target.agentId : target.projectId;
				const existing = terminalTabs.filter((tab) => tab.agentId === key);
				if (existing.length > 0) return existing;
				return [await createTerminalTab(key)];
			},
			create: (target) => createTerminalTab(target.kind === "agent" ? target.agentId : target.projectId),
			input: async (tabId, data) => {
				for (const listener of terminalDataListeners) {
					listener({ tabId, data });
				}
			},
			resize: async () => undefined,
			close: async (tabId) => {
				const index = terminalTabs.findIndex((tab) => tab.id === tabId);
				if (index >= 0) terminalTabs.splice(index, 1);
			},
			onData: (callback) => {
				terminalDataListeners.add(callback);
				return () => {
					terminalDataListeners.delete(callback);
				};
			},
			onExit: (callback) => {
				terminalExitListeners.add(callback);
				return () => {
					terminalExitListeners.delete(callback);
				};
			},
			shells: async () => [
				{ shell: "powershell", label: "PowerShell", available: true },
				{ shell: "pwsh", label: "pwsh", available: true },
				{ shell: "cmd", label: "cmd", available: true },
			],
		},
		feishu: {
			connect: async () => ({ success: true, message: "预览模式" }),
			connectTemp: async () => ({ success: false, message: "预览模式不支持" }),
			disconnect: async () => ({ success: true }),
			connectByBot: async () => ({ success: false, message: "预览模式不支持" }),
			statusRequest: async () => ({ status: "disconnected" as const, activeBindings: 0 }),
			onStatus: () => () => {},
			botsList: async () => [],
			botAdd: async () => ({ success: false, error: "预览模式不支持" }),
			botRemove: async () => false,
			botConfig: async () => undefined,
			botSecret: async () => "",
			testConnection: async () => ({ success: false, message: "预览模式不支持" }),
			bindingsList: async () => [],
			bindingRemove: async () => false,
			bindingUpdate: async () => undefined,
			onMessages: () => () => {},
			onBindingsChanged: () => () => {},
			onBotsChanged: () => () => {},
			onWhoamiResult: () => () => {},
			sessionBotGet: async () => null,
			sessionBotSet: async () => ({ success: true }),
		},
		browser: {
			openExternal: async () => {},
		},
		scratchPad: {
			list: async () => [],
			create: async () => ({ id: "", name: "", path: "", createdAt: 0, updatedAt: 0 }),
			delete: async () => {},
			load: async () => ({ content: "", lastEditedAt: 0, cursorPosition: 0 }),
			save: async () => {},
			export: async () => false,
		},

		// 生图预览桩：预览模式不联网，直接返回未配置
		imagegen: {
			generate: async (_request) => ({ ok: false, error: "notConfigured" }),
			getConfig: async () => ({ providers: [], activeProviderId: "", activeModel: "" }),
			saveConfig: async (config) => ({ ok: true, config }),
		},
		voiceTranscription: {
			getConfig: async () => ({
				baseUrl: "https://api.openai.com/v1",
				model: "whisper-1",
				language: "",
				hasApiKey: false,
			}),
			saveConfig: async (config) => ({
				ok: true,
				config: {
					baseUrl: config.baseUrl,
					model: config.model,
					language: config.language,
					hasApiKey: false,
				},
			}),
			transcribe: async () => ({ ok: false, error: "notConfigured" }),
			cancel: async () => {},
		},
		// 模型目录预览桩：无内置目录可读，返回「不可用」空态，仅供预览不崩溃
		catalog: {
			status: async () => ({ builtin: null, overlay: null, hasOverlayFiles: false, hasBackup: false }),
			check: async () => ({ ok: false, code: "network", message: "preview stub" }),
			updateFromGithub: async () => ({ ok: false, code: "network", message: "preview stub" }),
			restore: async () => ({ ok: true }),
			restorePrevious: async () => ({ ok: false, code: "no-backup", message: "preview stub" }),
			openFile: async () => undefined,
		},
	};
}
