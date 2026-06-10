import type { PiDesktopApi } from "../../preload";
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

const agents: AgentTab[] = [
	{
		id: "preview-agent",
		projectId: "builtin-chat",
		cwd: projects[0].path,
		title: "预览会话",
		status: "idle",
		sessionId: "preview",
		createdAt: now,
	},
];

const messages: ChatMessage[] = [
	{
		id: "m1",
		agentId: "preview-agent",
		role: "user",
		text: "帮我总结一下这个项目",
		timestamp: now - 120000,
	},
	{
		id: "m2",
		agentId: "preview-agent",
		role: "assistant",
		text: "## 项目概览\n\n这是浏览器预览模式，用来检查 UI 响应式布局。\n\n- 支持 Markdown\n- 支持消息定位\n- 支持工具详情展开",
		timestamp: now - 90000,
	},
	{
		id: "m3",
		agentId: "preview-agent",
		role: "tool",
		text: "✓ read done",
		timestamp: now - 60000,
		meta: { detailText: "工具：read\n状态：完成\n结果：预览模式工具调用详情" },
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

const sessions: SessionSummary[] = [
	{
		id: "s1",
		filePath: "preview.jsonl",
		projectPath: projects[0].path,
		name: "预览历史会话",
		preview: "这里展示历史会话摘要",
		updatedAt: now,
		messageCount: 3,
	},
];

const terminalTabs: TerminalTab[] = [];
const terminalDataListeners = new Set<(payload: TerminalDataEvent) => void>();
const terminalExitListeners = new Set<(payload: TerminalExitEvent) => void>();

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
		projects: {
			list: async () => projects,
			add: async () => projects[0],
			remove: async () => projects,
			reorder: async (projectIds) => {
				projects.sort((a, b) => projectIds.indexOf(a.id) - projectIds.indexOf(b.id));
				return projects;
			},
			onChanged: noop,
		},
		files: {
			list: async () => files,
			open: async () => undefined,
			showInFolder: async () => undefined,
		},
		sessions: {
			list: async () => sessions,
			rename: async () => undefined,
			copy: async (_projectId, filePath) => ({
				cancelled: false,
				sessionPath: `${filePath}-copy`,
			}),
			exportHtml: async () => ({ path: "preview-session.html" }),
			delete: async () => undefined,
		},
		codexSessions: {
			scan: async () => [],
			import: async () => ({ results: [], imported: 0, failed: 0 }),
		},
		git: {
			branches: async () => ({ current: "main", branches: ["main", "dev"] }),
			checkout: async (_projectId, branch) => ({
				current: branch,
				branches: ["main", "dev"],
			}),
		},
		pi: {
			check: async () => ({
				installed: true,
				command: "pi",
				version: "preview",
				searchedDirs: [],
			}),
		},
		app: {
			info: async () => ({
				version: "preview",
				releasesUrl: "https://github.com/ayuayue/pi-desktop/releases",
			}),
			checkUpdate: async () => ({
				currentVersion: "preview",
				latestVersion: "preview",
				hasUpdate: false,
				releaseName: "preview",
				releaseNotes: "",
				releaseUrl: "https://github.com/ayuayue/pi-desktop/releases",
				assets: [],
			}),
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
			toggleDevTools: async () => false,
		},
		settings: {
			get: async (): Promise<AppSettings> => ({
				useNativeTitleBar: true,
				showNativeMenu: false,
				sendShortcut: "enter-send",
				piEnvironmentChecked: true,
				closeToTray: true,
				enableNotifications: true,
				showThinking: true,
				showDevTools: false,
				piProxyEnabled: false,
				piProxyUrl: "http://127.0.0.1:7890",
				piProxyBypass: "localhost,127.0.0.1,::1",
				desktopProxyEnabled: false,
				desktopProxyUrl: "http://127.0.0.1:7890",
				desktopProxyBypass: "localhost,127.0.0.1,::1",
			}),
			update: async (patch): Promise<AppSettings> => ({
				useNativeTitleBar: true,
				showNativeMenu: false,
				sendShortcut: "enter-send",
				piEnvironmentChecked: true,
				closeToTray: true,
				enableNotifications: true,
				showThinking: true,
				showDevTools: false,
				piProxyEnabled: false,
				piProxyUrl: "http://127.0.0.1:7890",
				piProxyBypass: "localhost,127.0.0.1,::1",
				desktopProxyEnabled: false,
				desktopProxyUrl: "http://127.0.0.1:7890",
				desktopProxyBypass: "localhost,127.0.0.1,::1",
				...patch,
			}),
			testPiProxy: async () => ({
				success: true,
				url: "https://api.openai.com/v1/models",
				elapsedMs: 120,
				statusCode: 401,
				message: "代理可用，目标返回 HTTP 401",
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
			list: async () => agents,
			create: async () => agents[0],
			stop: async () => undefined,
			prompt: async () => undefined,
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
				title: "Preview Agent",
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
			onState: noop,
			onMessages: ((
				callback: (payload: {
					agentId: string;
					messages: ChatMessage[];
				}) => void,
			) => {
				setTimeout(() => callback({ agentId: "preview-agent", messages }), 0);
				return () => undefined;
			}) as any,
			onLog: noop,
			onThinking: noop,
			onRpcLog: noop,
			onRuntimeState: noop,
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
	};
}
