import type { PiDesktopApi } from "../../preload";
import { createDefaultExternalEditorSettings } from "../../shared/types";
import type {
	AgentTab,
	AppSettings,
	ChatMessage,
	FileTreeNode,
	Project,
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

let previewAgentTitle: string | null = null;

function getAgents(): AgentTab[] {
	return [
		{
			id: "preview-agent",
			projectId: "builtin-chat",
			cwd: projects[0].path,
			title: previewAgentTitle ?? t("preview.agentTitle"),
			status: "idle",
			sessionId: "preview",
			createdAt: now,
		},
	];
}

function getMessages(): ChatMessage[] {
	return [
		{
			id: "m1",
			agentId: "preview-agent",
			role: "user",
			text: t("preview.userPrompt"),
			timestamp: now - 120000,
		},
		{
			id: "m2",
			agentId: "preview-agent",
			role: "assistant",
			text: t("preview.assistantText"),
			timestamp: now - 90000,
		},
		{
			id: "m3",
			agentId: "preview-agent",
			role: "tool",
			text: "✓ read done",
			timestamp: now - 60000,
			meta: { detailText: t("preview.toolDetail") },
		},
	];
}

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
	theme: "system",
	lightBackground: "white",
	language: "system",
	piEnvironmentChecked: true,
	enableGitManagement: true,
	gitCommitMessagePrompt: "",
	closeToTray: true,
	enableNotifications: true,
	// showThinking 由 pi agent 的 hideThinkingBlock 控制，运行时从主进程加载
	showThinking: true,
	showDevTools: false,
	piProxyEnabled: false,
	piProxyUrl: "http://127.0.0.1:7890",
	piProxyBypass: "localhost,127.0.0.1,::1",
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
	contentMaxWidth: 1400,
	maxEditorFileSizeMB: 5,
	externalEditors: createDefaultExternalEditorSettings(),

	// 桌面宠物默认关闭
	petEnabled: false,
	petId: "clawd",
	petAlwaysOnTop: true,
	petScale: 0.8,
	petPatrolEnabled: true,
	petPatrolPauseMin: 5,
	favoriteModels: [],

	fontSize: "default",
	uiFontSize: null,
	chatFontSize: null,
	inputFontSize: null,
	zoomFactor: 1,
	fontFamilyBase: "system",
	fontFamilyBaseCustom: "",
	fontFamilyMono: "commit-mono",
	fontFamilyMonoCustom: "",
	disableUpdateCheck: false,
};

export function createPreviewApi(): PiDesktopApi {
	const noop = (() => () => undefined) as any;
	const createTerminalTab = async (agentId: string) => {
		const tab: TerminalTab = {
			id: `preview-terminal-${terminalTabs.length + 1}`,
			agentId,
			title: `PowerShell ${terminalTabs.length + 1}`,
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
			onChanged: noop,
			listRoot: async () => projects,
			listWorktreeChildren: async () => [],
			toggleWorktreeEnabled: async () => projects[0],
			chooseChatPath: async () => null,
			setChatPath: async () => projects[0],
			listModels: async () => [],
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
			list: async () => files,
			open: async () => undefined,
			showInFolder: async () => undefined,
			readContent: async () => "",
			writeContent: async () => undefined,
			delete: async () => undefined,
			rename: async () => "",
			create: async () => "",
		},
		sessions: {
			list: async () => getSessions(),
			rename: async () => undefined,
			copy: async (_projectId, filePath) => ({
				cancelled: false,
				sessionPath: `${filePath}-copy`,
			}),
			exportHtml: async () => ({ path: "preview-session.html" }),
			delete: async () => undefined,
			// 预览模式下返回固定 mock 数据，真实环境由主进程从 JSONL 文件读取
			readMessages: async () => [
				{ role: "user", content: "Preview user message", timestamp: Date.now() - 60000 },
				{ role: "assistant", content: "Preview assistant response", timestamp: Date.now() - 30000 },
			],
			readSessionMeta: async () => ({}),
			readChatMessages: async () => [],
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
		git: {
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
				commit: async () => {},
				cherryPick: async () => {},
				revert: async () => {},
				reset: async () => {},
				dropCommit: async () => {},
				generateCommitMessage: async () => "",
				init: async () => {},
				push: async () => {},
				pull: async () => {},
				fetch: async () => {},
		},
		logs: {
			list: async () => [],
			clear: async () => undefined,
			openFolder: async () => undefined,
			getSize: async () => 0,
		},
		rpcLogs: {
			getSize: async () => 0,
			get: async () => [],
			clear: async () => undefined,
			setLogging: async () => false,
			getLogging: async () => false,
			openFile: async () => undefined,
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
				releasesUrl: "https://github.com/ayuayue/pi-desktop/releases",
				platform: "win32" as NodeJS.Platform,
				homeDir: "C:/Users/preview",
			}),
			preferredSystemLanguages: async () => navigator.languages?.length ? [...navigator.languages] : [navigator.language],
			checkUpdate: async () => ({
				currentVersion: "preview",
				latestVersion: "preview",
				hasUpdate: false,
				releaseName: "preview",
				releaseNotes: "",
				releaseUrl: "https://github.com/ayuayue/pi-desktop/releases",
				assets: [],
			}),
			downloadUpdate: async (asset) => ({
				filePath: asset.name,
				assetName: asset.name,
			}),
			installUpdate: async () => undefined,
			onUpdateProgress: () => () => undefined,
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
			openExternal: async () => undefined,
			restart: async () => undefined,
			rendererLog: async (level, scope, message, detail) => {
				console[level === "error" ? "error" : level === "warn" ? "warn" : "debug"](
					`[${scope}] ${message}`,
					detail,
				);
			},
			minimizeWindow: async () => undefined,
			toggleMaximizeWindow: async () => undefined,
			toggleAlwaysOnTopWindow: async () => false,
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
				],
				skills: [],
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
			update: async () => ({
				command: "pi update --extensions --no-approve",
				output: "Preview mode: extensions update output",
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
			testPiProxy: async () => ({
				success: true,
				url: "https://api.openai.com/v1/models",
				elapsedMs: 120,
				statusCode: 401,
				message: t("preview.proxyOk"),
			}),
			onApplyWindow: noop,
		},
		config: {
			getModels: async () => ({
				raw: '{"providers":{}}',
				parsed: { providers: {} },
			}),
			getAuth: async () => ({ raw: "{}", parsed: {} }),
			getSettings: async () => ({ raw: "{}", parsed: {} }),
			getTrust: async () => ({ raw: "{}", parsed: {} }),
			saveModels: async () => ({ valid: true }),
			saveAuth: async () => ({ valid: true }),
			saveSettings: async () => ({ valid: true }),
			saveRaw: async () => ({ valid: true }),
			export: async () =>
				JSON.stringify({
					version: 1,
					exportedAt: new Date().toISOString(),
					files: { "models.json": {}, "auth.json": {}, "settings.json": {} },
				}),
			import: async () => ({ valid: true }),
			fetchModels: async () => ({
				success: true,
				models: [
					{ id: "gpt-4o", name: "GPT-4o" },
					{ id: "gpt-4o-mini", name: "GPT-4o Mini" },
				],
			}),
			testProvider: async () => ({
				success: true,
				model: "gpt-4o-mini",
				snippet: "Hello! How can I help you today?",
				tokens: { input: 8, output: 7 },
				latencyMs: 320,
				requestUrl: "https://api.openai.com/v1/chat/completions",
				requestBody: '{"model":"gpt-4o-mini","messages":[{"role":"user","content":"Hi"}],"max_tokens":10}',
			}),
		},
		agents: {
			list: async () => getAgents(),
			create: async () => getAgents()[0],
			rename: async (agentId, name) => {
				const agent =
					getAgents().find((item) => item.id === agentId) ?? getAgents()[0];
				previewAgentTitle = name;
				agent.title = previewAgentTitle;
				return agent;
			},
			stop: async () => undefined,
			prompt: async () => ({ accepted: true }),
			abort: async () => undefined,
			exportHtml: async () => ({ path: "preview.html" }),
			getForkMessages: async () => [
				{ entryId: "preview-user-1", text: "Preview prompt" },
			],
			forkSession: async () => ({ text: "Preview prompt", cancelled: false }),
			cloneSession: async () => ({ cancelled: false }),
			switchSession: async () => ({ cancelled: false }),
			reload: async () => undefined,
			restart: async (agentId: string) => ({
				id: agentId,
				projectId: "preview",
				cwd: "/preview",
				title: previewAgentTitle ?? t("preview.agentTitle"),
				status: "idle" as const,
				createdAt: Date.now(),
			}),
			compact: async () => ({
				modelName: "Preview GPT",
				provider: "preview",
				modelId: "preview",
				thinkingLevel: "low",
				contextPercent: 5,
				contextTokens: 5000,
				contextWindow: 100000,
				cacheTotal: 53000000,
			}),
			runtimeState: async () => ({
				modelName: "Preview GPT",
				provider: "preview",
				modelId: "preview",
				thinkingLevel: "low",
				contextPercent: 12,
				contextTokens: 12000,
				contextWindow: 100000,
				cacheTotal: 53000000,
			}),
			cycleModel: async () => ({
				modelName: "Preview GPT",
				thinkingLevel: "low",
			}),
			availableModels: async () => [
				{ id: "preview", name: "Preview GPT", provider: "preview" },
			],
			setModel: async () => ({
				modelName: "Preview GPT",
				thinkingLevel: "low",
			}),
			refreshModels: async () => ({
				modelName: "Preview GPT",
				thinkingLevel: "low",
			}),
			cycleThinking: async () => ({
				modelName: "Preview GPT",
				thinkingLevel: "medium",
			}),
			setThinking: async (_agentId, level) => ({
				modelName: "Preview GPT",
				thinkingLevel: level,
			}),
			commands: async () => [
				{ name: "reload", description: "Reload runtime", source: "builtin" },
			],
			editMessage: async () => undefined,
			deleteMessage: async () => undefined,
			onState: noop,
			onFocusTarget: noop,
			onMessages: ((
				callback: (payload: {
					agentId: string;
					messages: ChatMessage[];
				}) => void,
			) => {
				setTimeout(() => callback({ agentId: "preview-agent", messages: getMessages() }), 0);
				return () => undefined;
			}) as any,
			onLog: noop,
			onThinking: noop,
			onRpcLog: noop,
			onRuntimeState: noop,
			onUiRequest: noop,
			sendUiResponse: async () => undefined,
			onTrustRequest: noop,
			respondTrustRequest: async () => undefined,
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
		terminal: {
			list: async (agentId) =>
				terminalTabs.filter((tab) => tab.agentId === agentId),
			ensure: async (agentId) => {
				const existing = terminalTabs.filter((tab) => tab.agentId === agentId);
				if (existing.length > 0) return existing;
				return [await createTerminalTab(agentId)];
			},
			create: createTerminalTab,
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
			sessionBotSet: async () => {},
		},
		dialog: {
			pickFiles: async () => [],
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
	};
}
