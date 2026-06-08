import {
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent,
} from "react";
import {
	Settings,
	Sliders,
	ChevronLeft,
	ChevronRight,
	History,
	Info,
	Search,
	Play,
	Plus,
	Trash2,
	X,
} from "lucide-react";
import { createPreviewApi } from "./previewApi";
import { ConfigModal } from "./ConfigModal";
import { TerminalDock } from "./components/terminal/TerminalDock";
import {
	AgentAvatar,
	AgentRun,
	AgentContextMenu,
	BranchSelector,
	ChatBubble,
	CodexImportModal,
	ComposerToolbar,
	ConversationOutline,
	DrawerContent,
	EmptyState,
	EnvironmentDialog,
	FileContextMenu,
	ImagePreviewModal,
	LogoMark,
	ModelPicker,
	PendingBubble,
	ProjectAvatar,
	ProjectContextMenu,
	PromptSuggestions,
	RpcLogModal,
	SessionHistoryModal,
	SessionStatus,
	SessionFileSummary,
	SettingsModal,
	ThinkingBubble,
	ToolGroup,
	applySuggestion,
	buildOutline,
	buildSuggestionItems,
	clearSuggestionTrigger,
	displayPath,
	flattenFiles,
	groupToolMessages,
	matches,
	type DrawerPanel,
	type SessionModifiedFile,
} from "./components/app/AppParts";
import type {
	AgentRuntimeState,
	AgentTab,
	AppInfo,
	AppSettings,
	AppUpdateInfo,
	AvailableModel,
	ChatMessage,
	CodexImportReport,
	CodexSessionSummary,
	FileTreeNode,
	GitBranchInfo,
	ImageContent,
	PendingPrompt,
	PiCommand,
	PiInstallStatus,
	Project,
	SessionSummary,
	ThinkingUpdate,
} from "../../shared/types";

const api = window.piDesktop ?? createPreviewApi();
const COMPOSER_MIN_HEIGHT = 132;
const COMPOSER_DEFAULT_TERMINAL_HEIGHT = 220;
const COMPOSER_MIN_TIMELINE_HEIGHT = 160;

function countContentLines(value: unknown) {
	if (typeof value !== "string") return 0;
	if (!value) return 0;
	return value.split(/\r\n|\r|\n/).length;
}

function getToolChangedLineCount(toolName: string, args: any) {
	// 会话结束摘要只能使用 renderer 已收到的工具参数，不能重新 diff 工作区；
	// 这里按编辑/写入工具的输入估算“本次触达行数”，避免把用户在会话外的改动也计入。
	if (/edit/i.test(toolName)) {
		const edits = Array.isArray(args?.edits) ? args.edits : undefined;
		if (edits) {
			return edits.reduce((total: number, edit: any) => {
				const oldLines = countContentLines(edit?.oldText);
				const newLines = countContentLines(edit?.newText);
				return total + Math.max(oldLines, newLines);
			}, 0);
		}
		return Math.max(
			countContentLines(args?.oldText),
			countContentLines(args?.newText),
		);
	}
	if (/write|create/i.test(toolName)) {
		return countContentLines(args?.content ?? args?.text ?? args?.data);
	}
	return 0;
}

function displayProjectDirectoryName(project: Project) {
	const normalizedPath = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalizedPath.split("/").pop() || project.name || project.path;
}

function isReplacementForPendingAgent(agent: AgentTab, pending: AgentTab) {
	if (!pending.id.startsWith("pending-")) return false;
	if (agent.projectId !== pending.projectId || agent.cwd !== pending.cwd)
		return false;
	if (pending.sessionPath && agent.sessionPath === pending.sessionPath)
		return true;
	return agent.title === pending.title && agent.createdAt >= pending.createdAt - 1000;
}

function isPendingAgentId(agentId?: string) {
	return Boolean(agentId?.startsWith("pending-"));
}

export function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [agents, setAgents] = useState<AgentTab[]>([]);
	const [pendingAgents, setPendingAgents] = useState<AgentTab[]>([]);
	const [activeProjectId, setActiveProjectId] = useState<string>();
	const [activeAgentId, setActiveAgentId] = useState<string>();
	const [collapsedProjects, setCollapsedProjects] = useState<Set<string>>(
		new Set(),
	);
	const [activeAgentByProject, setActiveAgentByProject] = useState<
		Record<string, string>
	>({});
	const [messagesByAgent, setMessagesByAgent] = useState<
		Record<string, ChatMessage[]>
	>({});
	const [files, setFiles] = useState<FileTreeNode[]>([]);
	const [sessions, setSessions] = useState<SessionSummary[]>([]);
	const [gitInfo, setGitInfo] = useState<GitBranchInfo>({
		current: null,
		branches: [],
	});
	const [commands, setCommands] = useState<PiCommand[]>([]);
	const [runtimeStateByAgent, setRuntimeStateByAgent] = useState<
		Record<string, AgentRuntimeState>
	>({});
	const [availableModels, setAvailableModels] = useState<AvailableModel[]>([]);
	const [modelPickerOpen, setModelPickerOpen] = useState(false);
	const [prompt, setPrompt] = useState("");
	/** 当前进行的操作类型，用于按钮 loading 状态 */
	const [loadingAction, setLoadingAction] = useState<null | "restart">(null);
	/** 键盘上下键切换的历史消息列表 */
	const [messageHistory, setMessageHistory] = useState<string[]>([]);
	/** 当前在历史中的索引，-1 表示新输入；用 ref 确保键盘事件回调中读取到最新的值 */
	const historyIndexRef = useRef(-1);
	const [attachedImages, setAttachedImages] = useState<ImageContent[]>([]);
	const [pendingPrompts, setPendingPrompts] = useState<PendingPrompt[]>([]);
	const [previewImage, setPreviewImage] = useState<ImageContent | null>(null);
	/** 当前 agent 流式思考的实时文本，agent_end 时清空 */
	const [streamingThinking, setStreamingThinking] = useState<
		Record<string, string>
	>({});
	/** 每个 agent 最后一次会话的开始时间（status 变为 running 时记录），用 ref 避免 effect 闭包陈旧 */
	const sessionStartByAgentRef = useRef<Record<string, number>>({});
	/** 每个 agent 最后一次会话的总时长（ms），仅在会话结束后更新 */
	const [sessionDurationByAgent, setSessionDurationByAgent] = useState<
		Record<string, number>
	>({});
	/** 会话结束后固化的文件修改摘要；新一轮运行时继续展示上一轮结果，避免完成信息被隐藏。 */
	const [sessionFileSummaryByAgent, setSessionFileSummaryByAgent] = useState<
		Record<string, SessionModifiedFile[]>
	>({});
	/** RPC 日志，用于调试 */
	const [rpcLogs, setRpcLogs] = useState<
		Array<{
			id: string;
			agentId: string;
			direction: string;
			summary: string;
			data?: unknown;
			time: number;
		}>
	>([]);
	const [_logs, setLogs] = useState<string[]>([]); // 写入式调试日志，仅用于 onLog/onError 捕获
	const [search, setSearch] = useState("");
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
	const [selectedSuggestionIndex, setSelectedSuggestionIndex] = useState(0);
	const [fileMenu, setFileMenu] = useState<{
		x: number;
		y: number;
		node: FileTreeNode;
	} | null>(null);
	const [agentMenu, setAgentMenu] = useState<{
		x: number;
		y: number;
		agent: AgentTab;
	} | null>(null);
	const [projectMenu, setProjectMenu] = useState<{
		x: number;
		y: number;
		project: Project;
	} | null>(null);
	const [codexImportProject, setCodexImportProject] = useState<Project | null>(
		null,
	);
	const [codexImportSessions, setCodexImportSessions] = useState<
		CodexSessionSummary[]
	>([]);
	const [codexImportSelected, setCodexImportSelected] = useState<string[]>([]);
	const [codexImportLoading, setCodexImportLoading] = useState(false);
	const [codexImportRunning, setCodexImportRunning] = useState(false);
	const [codexImportReport, setCodexImportReport] =
		useState<CodexImportReport | null>(null);
	const [toast, setToast] = useState<string | null>(null);
	const [compacting, setCompacting] = useState(false);
	const [drawer, setDrawer] = useState<DrawerPanel | null>(null);
	const [sessionsProjectId, setSessionsProjectId] = useState<string>();
	const [sessionHistoryLoading, setSessionHistoryLoading] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [updateInfo, setUpdateInfo] = useState<AppUpdateInfo | null>(null);
	const [updateError, setUpdateError] = useState<string | null>(null);
	const [updateChecking, setUpdateChecking] = useState(false);
	const [configOpen, setConfigOpen] = useState(false);
	const [_debugOpen, _setDebugOpen] = useState(false);
	/** RPC 日志弹窗目标 agent */
	const [rpcLogAgentId, setRpcLogAgentId] = useState<string | null>(null);

	const [settings, setSettings] = useState<AppSettings>({
		useNativeTitleBar: true,
		showNativeMenu: false,
		sendShortcut: "enter-send",
		piEnvironmentChecked: false,
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
	});
	const [settingsNotice, setSettingsNotice] = useState("");
	const [piProxyNotice, setPiProxyNotice] = useState("");
	const [piProxyNoticeTone, setPiProxyNoticeTone] = useState<
		"info" | "success" | "error"
	>("info");
	const [piStatus, setPiStatus] = useState<PiInstallStatus | null>(null);
	const [piProxyChecking, setPiProxyChecking] = useState(false);
	const [appInfo, setAppInfo] = useState<AppInfo>({
		version: "-",
		releasesUrl: "https://github.com/ayuayue/pi-desktop/releases",
	});
	const [piChecking, setPiChecking] = useState(false);
	const [environmentDialog, setEnvironmentDialog] = useState(false);
	const [listWidth, setListWidth] = useState(260);
	const [drawerWidth, setDrawerWidth] = useState(360);
	const [composerHeight, setComposerHeight] = useState(COMPOSER_MIN_HEIGHT);
	const [composerAutoHeight, setComposerAutoHeight] = useState(
		COMPOSER_MIN_HEIGHT,
	);
	const [terminalOpenByAgent, setTerminalOpenByAgent] = useState<
		Record<string, boolean>
	>({});
	const [terminalHeightByAgent, setTerminalHeightByAgent] = useState<
		Record<string, number>
	>({});
	const [listCollapsed, setListCollapsed] = useState(false);
	const [drawerCollapsed, setDrawerCollapsed] = useState(false);
	const [drawerPinnedByAgent, setDrawerPinnedByAgent] = useState<
		Record<string, DrawerPanel>
	>({});
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const chatPaneRef = useRef<HTMLElement | null>(null);
	const chatHeaderRef = useRef<HTMLElement | null>(null);
	const composerRef = useRef<HTMLElement | null>(null);
	const timelineRef = useRef<HTMLElement | null>(null);
	const composerBoxRef = useRef<HTMLDivElement | null>(null);
	const composerTextareaRef = useRef<HTMLTextAreaElement | null>(null);
	const pendingAgentsRef = useRef<AgentTab[]>([]);

	const activeProject = projects.find(
		(project) => project.id === activeProjectId,
	);
	const sessionsProject = projects.find(
		(project) => project.id === sessionsProjectId,
	);
	const displayAgents = useMemo(() => {
		const realIds = new Set(agents.map((agent) => agent.id));
		return [
			...agents,
			...pendingAgents.filter(
				(agent) =>
					!realIds.has(agent.id) &&
					!agents.some((realAgent) =>
						isReplacementForPendingAgent(realAgent, agent),
					),
			),
		];
	}, [agents, pendingAgents]);
	const activeAgent = displayAgents.find((agent) => agent.id === activeAgentId);
	// 终端展开状态按 agent 隔离，避免切换项目/agent 时把别人的终端 UI 一并带过去。
	const terminalOpen = activeAgentId
		? Boolean(terminalOpenByAgent[activeAgentId])
		: false;
	const drawerPinnedPanel = activeAgentId
		? drawerPinnedByAgent[activeAgentId]
		: undefined;
	const drawerPinned = Boolean(drawerPinnedPanel);
	const activeMessages = activeAgentId
		? (messagesByAgent[activeAgentId] ?? [])
		: [];
	const activeRuntimeState = activeAgentId
		? runtimeStateByAgent[activeAgentId]
		: undefined;
	const renderedMessages = useMemo(
		() => groupToolMessages(activeMessages),
		[activeMessages],
	);
	const isAwaitingAssistant = Boolean(
		activeAgent &&
			(activeAgent.status === "running" || activeRuntimeState?.isStreaming) &&
			activeMessages.at(-1)?.role !== "assistant",
	);
	/** 当前活跃 agent 的实时思考文本 */
	const activeThinking = activeAgentId
		? (streamingThinking[activeAgentId] ?? "")
		: "";
	const activeTerminalHeight = activeAgentId
		? (terminalHeightByAgent[activeAgentId] ?? COMPOSER_DEFAULT_TERMINAL_HEIGHT)
		: COMPOSER_DEFAULT_TERMINAL_HEIGHT;
	const resolvedComposerHeight = Math.max(composerHeight, composerAutoHeight);
	const composerMode =
		prompt.startsWith("!!") ? "silent-shell" : prompt.startsWith("!") ? "shell" : null;
	const composerStatusText =
		composerMode === "silent-shell"
			? "静默命令：直接执行，不写入上下文"
			: composerMode === "shell"
				? "Shell 命令：直接执行当前输入"
				: drawer === "files"
					? "右侧面板可查看文件"
					: drawer === "sessions"
						? `右侧面板正在显示 ${sessionsProject?.name ?? "项目"} 的历史会话`
					: (activeAgent?.sessionPath ?? "");

	useEffect(() => {
		if (!drawerPinnedPanel) return;
		if (drawer !== drawerPinnedPanel) setDrawer(drawerPinnedPanel);
		if (drawerCollapsed) setDrawerCollapsed(false);
	}, [drawer, drawerCollapsed, drawerPinnedPanel]);

	/** 当前会话中 agent 修改过的文件（从 tool 消息 meta 中提取） */
	const modifiedFiles = useMemo(() => {
		const byPath = new Map<string, SessionModifiedFile>();
		for (const msg of activeMessages) {
			if (msg.role !== "tool") continue;
			const toolName: string | undefined = msg.meta?.toolName as
				| string
				| undefined;
			const args: any = msg.meta?.args;
			const status: string = String(msg.meta?.status ?? "done");
			// 只收集文件写入/编辑类的工具调用，作为右侧 Files 与会话结束摘要的统一数据源。
			if (!toolName || !/write|edit|create/i.test(toolName)) continue;
			const filePath =
				typeof args?.filePath === "string"
					? args.filePath
					: typeof args?.path === "string"
						? args.path
						: typeof args?.file === "string"
							? args.file
							: typeof args?.fileName === "string"
								? args.fileName
								: undefined;
			if (!filePath) continue;
			const previous = byPath.get(filePath);
			byPath.set(filePath, {
				path: filePath,
				toolName: previous?.toolName ?? toolName,
				status: status === "running" ? "running" : (previous?.status ?? status),
				changedLines:
					(previous?.changedLines ?? 0) + getToolChangedLineCount(toolName, args),
			});
		}
		return Array.from(byPath.values());
	}, [activeMessages]);
	const finalizedModifiedFiles = activeAgentId
		? (sessionFileSummaryByAgent[activeAgentId] ?? [])
		: [];
	const shouldShowSessionFileSummary = finalizedModifiedFiles.length > 0;
	const outlineItems = useMemo(
		() => buildOutline(activeMessages),
		[activeMessages],
	);
	const flatFiles = useMemo(() => flattenFiles(files), [files]);
	const suggestionItems = useMemo(
		() => buildSuggestionItems(prompt, commands, flatFiles),
		[prompt, commands, flatFiles],
	);
	const visibleAgents = useMemo(
		() =>
			displayAgents.filter((agent) =>
				matches(agent.title + agent.cwd + (agent.sessionId ?? ""), search),
			),
		[displayAgents, search],
	);
	const filteredAgents = visibleAgents;
	const filteredProjects = useMemo(
		() =>
			projects.filter((project) =>
				matches(project.name + project.path, search),
			),
		[projects, search],
	);

	useEffect(() => {
		window.setTimeout(() => void refreshProjects(), 0);
		window.setTimeout(() => void api.agents.list().then(setAgents), 0);
		void api.app
			.info()
			.then(setAppInfo)
			.catch(() => undefined);
		void api.settings.get().then((next) => {
			setSettings(next);
			if (!next.piEnvironmentChecked) {
				// 首次检测延后一帧启动，先让主界面完成绘制，避免 packaged app 打开时出现几秒白屏。
				window.setTimeout(() => void checkPiInstall("startup"), 300);
			}
		});

		const offProjects = api.projects.onChanged((next) => {
			setProjects(next);
			if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
		});
		const offState = api.agents.onState((nextAgents) => {
			const previousPendingAgents = pendingAgentsRef.current;
			const remainingPendingAgents = previousPendingAgents.filter(
				(pending) =>
					!nextAgents.some((agent) =>
						isReplacementForPendingAgent(agent, pending),
					),
			);
			if (remainingPendingAgents.length !== previousPendingAgents.length) {
				pendingAgentsRef.current = remainingPendingAgents;
				setPendingAgents(remainingPendingAgents);
			}
			setAgents(nextAgents);
			setActiveAgentId((current) => {
				if (!current) return undefined;
				if (nextAgents.some((agent) => agent.id === current)) return current;
				const pendingAgent = previousPendingAgents.find(
					(agent) => agent.id === current,
				);
				const replacement = pendingAgent
					? nextAgents.find((agent) =>
							isReplacementForPendingAgent(agent, pendingAgent),
						)
					: undefined;
				if (replacement) return replacement.id;
				return pendingAgent ? current : undefined;
			});
			const activeIds = new Set(nextAgents.map((agent) => agent.id));
			setTerminalOpenByAgent((current) =>
				Object.fromEntries(
					Object.entries(current).filter(([agentId]) => activeIds.has(agentId)),
				),
			);
			setTerminalHeightByAgent((current) =>
				Object.fromEntries(
					Object.entries(current).filter(([agentId]) => activeIds.has(agentId)),
				),
			);
			setDrawerPinnedByAgent((current) =>
				Object.fromEntries(
					Object.entries(current).filter(([agentId]) => activeIds.has(agentId)),
				),
			);
		});
		const offMessages = api.agents.onMessages((payload) =>
			setMessagesByAgent((current) => ({
				...current,
				[payload.agentId]: payload.messages,
			})),
		);
		const offLog = api.agents.onLog((payload) =>
			setLogs((current) => [
				...current.slice(-200),
				`[${payload.agentId.slice(0, 8)}] ${payload.text}`,
			]),
		);
		const offSettings = api.settings.onApplyWindow(() =>
			setSettingsNotice("标题栏样式需要重启应用后生效。"),
		);
		// 监听后端主动推送的 runtimeState 更新（如 agent_end 时重置 isStreaming），
		// 确保前端 isAgentBusy 判断基于最新状态，排队 flush 能正常触发。
		const offRuntimeState = api.agents.onRuntimeState((payload) =>
			setRuntimeStateByAgent((current) => ({
				...current,
				[payload.agentId]: payload.state,
			})),
		);
		// 监听流式思考内容更新，用于在 agent 响应前展示推理过程
		const offThinking = api.agents.onThinking((payload: ThinkingUpdate) =>
			setStreamingThinking((current) => ({
				...current,
				[payload.agentId]: payload.thinking,
			})),
		);
		// 监听 RPC 日志，保留最近 2000 条用于调试；message_update 高频事件很多，
		// 200 条很容易在一次长响应中被刷掉，但仍设置上限避免 renderer 内存无限增长。
		const offRpcLog = api.agents.onRpcLog((payload) =>
			setRpcLogs((current) => [
				...current.slice(-1999),
				{
					id: crypto.randomUUID(),
					agentId: payload.agentId,
					direction: payload.direction,
					summary: payload.summary,
					data: payload.data,
					time: Date.now(),
				},
			]),
		);

		return () => {
			offProjects();
			offState();
			offMessages();
			offLog();
			offSettings();
			offRuntimeState();
			offThinking();
			offRpcLog();
		};
	}, []);

	useEffect(() => {
		const timer = window.setInterval(
			() => void checkAppUpdate("auto"),
			1000 * 60 * 60 * 6,
		);
		window.setTimeout(() => void checkAppUpdate("auto"), 5000);
		return () => window.clearInterval(timer);
	}, []);

	useEffect(() => {
		if (activeAgentId && !isPendingAgentId(activeAgentId))
			void refreshRuntimeState(activeAgentId);
	}, [activeAgentId]);

	function getComposerMaxHeight() {
		const chatPane = chatPaneRef.current;
		const header = chatHeaderRef.current;
		const composer = composerRef.current;
		const box = composerBoxRef.current;
		if (!chatPane || !header || !composer || !box) {
			const reservedTerminalHeight = terminalOpen ? activeTerminalHeight : 0;
			return Math.max(
				180,
				window.innerHeight - 78 - COMPOSER_MIN_TIMELINE_HEIGHT - 52 - reservedTerminalHeight,
			);
		}

		const reservedTerminalHeight = terminalOpen ? activeTerminalHeight : 0;
		const composerChrome = Math.max(0, composer.offsetHeight - box.offsetHeight);
		// 输入框最大高度取决于聊天区域还剩多少可用空间，而不是固定视口比例；
		// 否则窗口变窄后软换行变多，最小窗口下会比内容需要的高度更早触顶。
		return Math.max(
			180,
			chatPane.clientHeight -
				header.offsetHeight -
				COMPOSER_MIN_TIMELINE_HEIGHT -
				reservedTerminalHeight -
				composerChrome,
		);
	}

	function clampComposerHeight(height: number) {
		const maxHeight = getComposerMaxHeight();
		return Math.min(maxHeight, Math.max(COMPOSER_MIN_HEIGHT, height));
	}

	function ensureComposerTailVisible() {
		const textarea = composerTextareaRef.current;
		if (!textarea || document.activeElement !== textarea) return;
		const selectionAtEnd =
			textarea.selectionStart === textarea.value.length &&
			textarea.selectionEnd === textarea.value.length;
		if (!selectionAtEnd) return;
		requestAnimationFrame(() => {
			const current = composerTextareaRef.current;
			if (!current) return;
			current.scrollTop = current.scrollHeight;
		});
	}

	function syncComposerAutoHeight() {
		const box = composerBoxRef.current;
		const textarea = composerTextareaRef.current;
		if (!box || !textarea) return;

		// 宽度变化会改变软换行位置，textarea 的 scrollHeight 才是当前内容真实需要的高度。
		// 这里减去 chrome 高度（顶部留白/工具条/底部状态条），把问题修在布局源头而不是靠用户手动拖。
		const chromeHeight = box.offsetHeight - textarea.clientHeight;
		const nextHeight = clampComposerHeight(textarea.scrollHeight + chromeHeight);
		setComposerAutoHeight((current) =>
			Math.abs(current - nextHeight) <= 1 ? current : nextHeight,
		);
		ensureComposerTailVisible();
	}

	useEffect(() => {
		let frame = 0;
		const scheduleSync = () => {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				setComposerHeight((current) => clampComposerHeight(current));
				syncComposerAutoHeight();
			});
		};

		const box = composerBoxRef.current;
		const observer =
			box &&
			new ResizeObserver((entries) => {
				const entry = entries[0];
				if (!entry) return;
				scheduleSync();
			});
		if (box) observer?.observe(box);

		window.addEventListener("resize", scheduleSync);
		scheduleSync();
		return () => {
			cancelAnimationFrame(frame);
			window.removeEventListener("resize", scheduleSync);
			observer?.disconnect();
		};
	}, [activeAgentId]);

	useEffect(() => {
		const frame = requestAnimationFrame(() => {
			setComposerHeight((current) => clampComposerHeight(current));
			syncComposerAutoHeight();
		});
		return () => cancelAnimationFrame(frame);
	}, [
		prompt,
		activeAgentId,
		listCollapsed,
		drawerCollapsed,
		drawer,
		terminalOpen,
		activeTerminalHeight,
	]);

	useEffect(() => {
		if (activeProjectId && activeAgentId)
			setActiveAgentByProject((current) => ({
				...current,
				[activeProjectId]: activeAgentId,
			}));
	}, [activeProjectId, activeAgentId]);

	useEffect(() => {
		if (activeAgentId && !isPendingAgentId(activeAgentId))
			void api.agents
				.commands(activeAgentId)
				.then(setCommands)
				.catch(() => setCommands([]));
		else setCommands([]);
	}, [activeAgentId]);

	useEffect(() => {
		setSelectedSuggestionIndex(0);
	}, [suggestionItems.length]);

	useEffect(() => {
		const timeline = timelineRef.current;
		if (!timeline) return;
		// 历史会话加载后默认跳到最新消息，符合聊天软件的阅读习惯，避免用户手动滚动到底部。
		requestAnimationFrame(() => {
			timeline.scrollTop = timeline.scrollHeight;
		});
	}, [activeAgentId, activeMessages.length]);

	// 追踪 agent 会话开始/结束时间，计算会话时长
	useEffect(() => {
		for (const agent of displayAgents) {
			if (agent.id !== activeAgentId) continue;
			if (agent.status === "running") {
				sessionStartByAgentRef.current[agent.id] = Date.now();
			} else if (agent.status === "idle") {
				const start = sessionStartByAgentRef.current[agent.id];
				if (start) {
					setSessionDurationByAgent((d) => ({
						...d,
						[agent.id]: Date.now() - start,
					}));
				}
				if (modifiedFiles.length > 0) {
					// 会话结束时才固化摘要：运行中的临时工具状态不打扰聊天流，
					// 同时新一轮 prompt 开始后仍保留上一轮完成结果。
					setSessionFileSummaryByAgent((current) => ({
						...current,
						[agent.id]: modifiedFiles,
					}));
				}
			}
		}
	}, [displayAgents, activeAgentId, modifiedFiles]);

	// 监听用户发送消息的编辑事件，将消息填入输入框
	useEffect(() => {
		const handler = (event: Event) => {
			const detail = (event as CustomEvent<{ text: string }>).detail;
			if (detail?.text) {
				setPrompt(detail.text);
				// 自动聚焦到输入框
				requestAnimationFrame(() => {
					document
						.querySelector<HTMLTextAreaElement>(".composer-box textarea")
						?.focus();
				});
			}
		};
		window.addEventListener("user-message-edit", handler);
		return () => window.removeEventListener("user-message-edit", handler);
	}, []);

	useEffect(() => {
		if (!activeProjectId) {
			setFiles([]);
			setSessions([]);
			setGitInfo({ current: null, branches: [] });
			return;
		}
		const currentAgentBelongsToProject =
			activeAgentId &&
			displayAgents.some(
				(agent) =>
					agent.id === activeAgentId && agent.projectId === activeProjectId,
			);
		if (!currentAgentBelongsToProject) {
			const rememberedAgent = activeAgentByProject[activeProjectId];
			const fallbackAgent = displayAgents.find(
				(agent) => agent.projectId === activeProjectId,
			)?.id;
			setActiveAgentId(
				rememberedAgent &&
					displayAgents.some((agent) => agent.id === rememberedAgent)
					? rememberedAgent
					: fallbackAgent,
			);
		}

		setExpandedDirs(new Set());
		void api.files
			.list(activeProjectId)
			.then(setFiles)
			.catch((error) => setLogs((current) => [...current, String(error)]));
		void api.git
			.branches(activeProjectId)
			.then(setGitInfo)
			.catch(() => setGitInfo({ current: null, branches: [] }));
	}, [activeProjectId, displayAgents.length]);

	async function checkPiInstall(source: "startup" | "manual" = "manual") {
		setSettingsOpen(false);
		setPiChecking(true);
		setEnvironmentDialog(true);
		try {
			const next = await api.pi.check();
			setPiStatus(next);
			if (next.installed && source === "startup") {
				// 首次启动检测通过后落盘，后续启动不再阻塞/打扰；用户仍可在设置里手动重新检测。
				const saved = await api.settings.update({ piEnvironmentChecked: true });
				setSettings(saved);
				window.setTimeout(() => setEnvironmentDialog(false), 3000);
			}
			if (next.installed && source === "manual")
				window.setTimeout(() => setEnvironmentDialog(false), 3000);
		} finally {
			setPiChecking(false);
		}
	}

	async function checkAppUpdate(source: "auto" | "manual" = "manual") {
		if (updateChecking) return;
		setUpdateChecking(true);
		try {
			const next = await api.app.checkUpdate();
			if (next.hasUpdate) {
				setUpdateInfo(next);
			} else if (source === "manual") {
				setSettingsNotice(`当前已是最新版本 v${next.currentVersion}。`);
				setToast("当前已是最新版本");
			}
		} catch (error) {
			if (source === "manual") {
				const message = error instanceof Error ? error.message : String(error);
				setSettingsNotice(`检查更新失败：${message}`);
				setUpdateError(message);
				setToast("检查更新失败");
			}
		} finally {
			setUpdateChecking(false);
		}
	}

	async function refreshProjects() {
		const next = await api.projects.list();
		setProjects(next);
		if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
	}

	async function refreshSessions(projectId = activeProjectId) {
		const next = await api.sessions.list(projectId);
		setSessions(next);
	}

	async function refreshSessionHistory(projectId = sessionsProjectId) {
		if (!projectId) return;
		setSessionHistoryLoading(true);
		try {
			// 项目历史弹框内的刷新需要显式进入 loading 状态；否则刷新很快完成时用户会误以为按钮没有响应。
			await refreshSessions(projectId);
		} finally {
			setSessionHistoryLoading(false);
		}
	}

	async function openProjectSessions(project: Project) {
		setProjectMenu(null);
		setActiveProjectId(project.id);
		setSessionsProjectId(project.id);
		setSessions([]);
		setDrawer((current) => (current === "sessions" ? null : current));
		await refreshSessionHistory(project.id);
	}

	async function openHistorySession(session: SessionSummary) {
		const projectId = sessionsProjectId;
		if (!projectId) return;
		setSessionsProjectId(undefined);
		setSessions([]);
		await createAgent(projectId, session.filePath, session.name || "历史会话");
	}

	async function renameHistorySession(filePath: string, newName: string) {
		await api.sessions.rename(filePath, newName);
		if (sessionsProjectId) await refreshSessions(sessionsProjectId);
	}

	async function openCodexImport(project: Project) {
		setProjectMenu(null);
		setCodexImportProject(project);
		setCodexImportReport(null);
		setCodexImportSessions([]);
		setCodexImportSelected([]);
		await scanCodexSessions(project);
	}

	async function scanCodexSessions(
		project = codexImportProject,
		clearReport = true,
	) {
		if (!project) return;
		setCodexImportLoading(true);
		if (clearReport) setCodexImportReport(null);
		try {
			const next = await api.codexSessions.scan(project.id);
			setCodexImportSessions(next);
			// 默认不自动勾选任何会话，避免用户未确认时批量覆盖已导入历史。
			setCodexImportSelected([]);
		} catch (error) {
			setToast(
				`扫描 Codex 会话失败：${error instanceof Error ? error.message : String(error)}`,
			);
			setTimeout(() => setToast(null), 4000);
		} finally {
			setCodexImportLoading(false);
		}
	}

	function toggleCodexSession(sourcePath: string) {
		setCodexImportSelected((current) =>
			current.includes(sourcePath)
				? current.filter((item) => item !== sourcePath)
				: [...current, sourcePath],
		);
	}

	function toggleAllCodexSessions() {
		const allPaths = codexImportSessions.map((session) => session.sourcePath);
		setCodexImportSelected((current) =>
			allPaths.length > 0 && allPaths.every((path) => current.includes(path))
				? []
				: allPaths,
		);
	}

	async function importCodexSessions() {
		if (!codexImportProject || codexImportSelected.length === 0) return;
		setCodexImportRunning(true);
		setCodexImportReport(null);
		try {
			const report = await api.codexSessions.import(
				codexImportProject.id,
				codexImportSelected,
			);
			setCodexImportReport(report);
			await scanCodexSessions(codexImportProject, false);
			if (sessionsProjectId === codexImportProject.id)
				await refreshSessions(codexImportProject.id);
			setToast(`Codex 会话导入完成：${report.imported} 成功，${report.failed} 失败`);
			setTimeout(() => setToast(null), 3500);
		} catch (error) {
			setToast(
				`导入 Codex 会话失败：${error instanceof Error ? error.message : String(error)}`,
			);
			setTimeout(() => setToast(null), 4000);
		} finally {
			setCodexImportRunning(false);
		}
	}

	async function addProject() {
		const project = await api.projects.add();
		if (!project) return;
		await refreshProjects();
		setActiveProjectId(project.id);
		setActiveAgentId(undefined);
	}

	function updateAfterProjectRemoved(removedProjectId: string, next: Project[]) {
		if (activeProjectId === removedProjectId) {
			setActiveProjectId(next[0]?.id);
			setActiveAgentId(undefined);
		}
		if (sessionsProjectId === removedProjectId) {
			setSessionsProjectId(undefined);
			if (drawer === "sessions") setDrawer(null);
		}
	}

	async function createAgent(
		projectId = activeProjectId,
		sessionPath?: string,
		title?: string,
	) {
		if (!projectId) return;
		const project = projects.find((item) => item.id === projectId);
		if (!project) return;
		const existing = sessionPath
			? displayAgents.find((agent) => agent.sessionPath === sessionPath)
			: undefined;
		if (existing) {
			setActiveProjectId(existing.projectId);
			setActiveAgentId(existing.id);
			setDrawer(null);
			return;
		}
		const previousAgentId = activeAgentId;
		const pendingTab: AgentTab = {
			id: `pending-${Date.now()}-${Math.random().toString(36).slice(2)}`,
			projectId,
			cwd: project.path,
			title: title || `${project.name} agent`,
			status: "starting",
			sessionPath,
			createdAt: Date.now(),
		};
		pendingAgentsRef.current = [...pendingAgentsRef.current, pendingTab];
		setPendingAgents(pendingAgentsRef.current);
		setActiveProjectId(projectId);
		setActiveAgentId(pendingTab.id);
		setActiveAgentByProject((current) => ({
			...current,
			[projectId]: pendingTab.id,
		}));
		// 立即关闭抽屉，避免等待 agent 加载期间列表仍然显示
		setDrawer(null);
		try {
			const tab = await api.agents.create({ projectId, sessionPath, title });
			pendingAgentsRef.current = pendingAgentsRef.current.filter(
				(agent) => agent.id !== pendingTab.id,
			);
			setPendingAgents(pendingAgentsRef.current);
			setActiveAgentId(tab.id);
			setActiveAgentByProject((current) => ({
				...current,
				[projectId]: tab.id,
			}));
			void refreshRuntimeState(tab.id);
		} catch (e) {
			pendingAgentsRef.current = pendingAgentsRef.current.filter(
				(agent) => agent.id !== pendingTab.id,
			);
			setPendingAgents(pendingAgentsRef.current);
			setActiveAgentId((current) =>
				current === pendingTab.id ? previousAgentId : current,
			);
			setActiveAgentByProject((current) => {
				const next = { ...current };
				if (previousAgentId) next[projectId] = previousAgentId;
				else delete next[projectId];
				return next;
			});
			// 创建失败时由 main process 上报错误，前端仅回退乐观占位，避免停留在不存在的 agent。
		}
	}

	async function refreshRuntimeState(agentId = activeAgentId) {
		if (!agentId || isPendingAgentId(agentId)) return;
		const state = await api.agents.runtimeState(agentId).catch(() => undefined);
		if (state)
			setRuntimeStateByAgent((current) => ({ ...current, [agentId]: state }));
	}

	async function cycleModel() {
		if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
		const state = await api.agents.cycleModel(activeAgentId);
		setRuntimeStateByAgent((current) => ({
			...current,
			[activeAgentId]: state,
		}));
	}

	async function openModelPicker() {
		if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
		const models = await api.agents.availableModels(activeAgentId);
		setAvailableModels(models);
		setModelPickerOpen(true);
	}

	async function selectModel(model: AvailableModel) {
		if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
		const state = await api.agents.setModel(
			activeAgentId,
			model.provider,
			model.id,
		);
		setRuntimeStateByAgent((current) => ({
			...current,
			[activeAgentId]: state,
		}));
		setModelPickerOpen(false);
	}

	async function cycleThinking() {
		if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
		const state = await api.agents.cycleThinking(activeAgentId);
		setRuntimeStateByAgent((current) => ({
			...current,
			[activeAgentId]: state,
		}));
	}

	async function compactAgent() {
		if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
		setCompacting(true);
		try {
			const state = await api.agents.compact(activeAgentId);
			setRuntimeStateByAgent((current) => ({
				...current,
				[activeAgentId]: state,
			}));
		} finally {
			setCompacting(false);
		}
	}

	async function closeAgent(agentId: string) {
		if (isPendingAgentId(agentId)) return;
		await api.agents.stop(agentId);
	}

	async function abortAgent(agentId = activeAgentId) {
		if (!agentId || isPendingAgentId(agentId)) return;
		// 用户主动停止时清空排队消息，避免 agent 空闲后自动发送已取消的内容
		clearPendingPrompts();
		await api.agents.abort(agentId);
		void refreshRuntimeState(agentId);
	}

	async function exportAgentHtml(agentId: string) {
		if (isPendingAgentId(agentId)) return;
		const result = await api.agents.exportHtml(agentId);
		setToast(`已导出：${result.path}`);
		setTimeout(() => setToast(null), 3500);
	}

	function setTerminalOpenForAgent(agentId: string, open: boolean) {
		setTerminalOpenByAgent((current) => ({
			...current,
			[agentId]: open,
		}));
	}

	function handleComposerKeyDown(
		event: React.KeyboardEvent<HTMLTextAreaElement>,
	) {
		if (suggestionsOpen && suggestionItems.length > 0) {
			if (event.key === "ArrowDown") {
				event.preventDefault();
				setSelectedSuggestionIndex((index) =>
					Math.min(index + 1, suggestionItems.length - 1),
				);
				return;
			}
			if (event.key === "ArrowUp") {
				event.preventDefault();
				setSelectedSuggestionIndex((index) => Math.max(index - 1, 0));
				return;
			}
			if (event.key === "Enter") {
				event.preventDefault();
				const selected =
					suggestionItems[
						Math.min(selectedSuggestionIndex, suggestionItems.length - 1)
					];
				if (selected) {
					setPrompt((current) => applySuggestion(current, selected.value));
					setSuggestionsOpen(false);
				}
				return;
			}
			if (event.key === "Escape") {
				event.preventDefault();
				setPrompt((current) => clearSuggestionTrigger(current));
				setSuggestionsOpen(false);
				return;
			}
		}

		if (event.key === "Escape") {
			setPrompt((current) => clearSuggestionTrigger(current));
			setSuggestionsOpen(false);
		}
		// 上下键切换历史消息：类似 CLI，将之前发送过的消息填入输入框
		if (
			event.key === "ArrowUp" &&
			!event.shiftKey &&
			!event.ctrlKey &&
			!event.metaKey
		) {
			event.preventDefault();
			const idx = historyIndexRef.current;
			const nextIndex = Math.min(idx + 1, messageHistory.length - 1);
			if (nextIndex !== idx && messageHistory[nextIndex]) {
				setPrompt(messageHistory[nextIndex]);
				historyIndexRef.current = nextIndex;
			}
			return;
		}
		if (
			event.key === "ArrowDown" &&
			!event.shiftKey &&
			!event.ctrlKey &&
			!event.metaKey
		) {
			event.preventDefault();
			const idx = historyIndexRef.current;
			if (idx > 0) {
				const nextIndex = idx - 1;
				setPrompt(messageHistory[nextIndex]);
				historyIndexRef.current = nextIndex;
			} else if (idx === 0) {
				// 回到最顶上时清空输入框
				setPrompt("");
				historyIndexRef.current = -1;
			}
			return;
		}
		if (event.key !== "Enter") return;

		const shouldSend =
			settings.sendShortcut === "enter-send"
				? !event.ctrlKey && !event.metaKey && !event.shiftKey
				: settings.sendShortcut === "ctrl-enter-send"
					? event.ctrlKey || event.metaKey
					: event.shiftKey;

		const shouldInsertNewline =
			settings.sendShortcut === "enter-send"
				? event.ctrlKey || event.metaKey || event.shiftKey
				: !shouldSend;

		if (shouldSend) {
			event.preventDefault();
			void sendPrompt();
		} else if (shouldInsertNewline) {
			// 让 textarea 自己处理换行，保持输入体验接近普通聊天软件。
			return;
		}
	}

	/** 判断 agent 是否处于忙碌状态（正在处理消息或流式输出中） */
	const isAgentStarting = activeAgent?.status === "starting";
	const isAgentBusy = Boolean(
		activeAgent &&
			(activeAgent.status === "running" || activeRuntimeState?.isStreaming),
	);

	// Agent 从忙碌变为空闲时，自动发送排队中的消息（只发当前 agent 的）
	useEffect(() => {
		if (
			!isAgentStarting &&
			!isAgentBusy &&
			pendingPrompts.length > 0 &&
			activeAgentId &&
			!isPendingAgentId(activeAgentId)
		) {
			void flushPendingQueue();
		}
	}, [isAgentStarting, isAgentBusy, pendingPrompts.length, activeAgentId]);

	async function sendPrompt() {
		if (
			isAgentStarting ||
			!activeAgentId ||
			(!prompt.trim() && attachedImages.length === 0)
		)
			return;
		const message = prompt;
		const images = attachedImages.length > 0 ? attachedImages : undefined;
		// 发送前先保留快照，再立即清空 composer；这样普通发送和排队发送
		// 都能给用户明确反馈，同时失败时不会影响已捕获的待发送内容。
		setPrompt("");
		setAttachedImages([]);
		setSuggestionsOpen(false);
		await submitPromptSnapshot(activeAgentId, message, images);
	}

	async function submitPromptSnapshot(
		agentId: string,
		message: string,
		images?: ImageContent[],
	) {
		// Agent 忙碌时，消息加入本地排队，等 agent 空闲后自动发送。
		// 这里接收快照参数，让 composer 发送和历史消息“重新发送”共享同一条路径。
		if (isAgentBusy) {
			const pending: PendingPrompt = {
				id: crypto.randomUUID(),
				agentId,
				message,
				images,
				enqueuedAt: Date.now(),
			};
			setPendingPrompts((prev) => [...prev, pending]);
			recordMessageHistory(message);
			return;
		}

		await api.agents.prompt({ agentId, message, images });
		recordMessageHistory(message);
	}

	function recordMessageHistory(message: string) {
		if (message.trim()) {
			setMessageHistory((current) => [message.trim(), ...current]);
			historyIndexRef.current = -1;
		}
	}

	function resendUserMessage(message: ChatMessage) {
		if (!activeAgentId || message.agentId !== activeAgentId) return;
		// “重新发送”按原消息快照再次提交，不修改输入框，图片也复用原始 base64 内容。
		void submitPromptSnapshot(activeAgentId, message.text, message.images);
	}

	/**
	 * Agent 空闲后，发送排队中属于当前 agent 的消息。
	 * 逐条处理：先发、成功后移除；失败保留在队列中。
	 */
	async function flushPendingQueue() {
		if (!activeAgentId) return;
		// 取快照，不清空队列 — 发完成功后才逐条移除，避免过程中异常导致消息永久丢失
		const snapshot = pendingPrompts.filter((p) => p.agentId === activeAgentId);
		if (snapshot.length === 0) return;

		// 从 UI 中清掉排队中的状态（这些消息正在发送）
		setPendingPrompts((prev) =>
			prev.filter((p) => p.agentId !== activeAgentId),
		);

		for (const item of snapshot) {
			try {
				await api.agents.prompt({
					agentId: activeAgentId,
					message: item.message,
					images: item.images,
					streamingBehavior: "steer",
				});
			} catch (error) {
				// 发送失败时回退到队列，用户可手动取消
				setPendingPrompts((prev) => [...prev, item]);
				setToast(
					`排队消息发送失败：${error instanceof Error ? error.message : String(error)}`,
				);
				setTimeout(() => setToast(null), 4000);
			}
		}
	}

	/** 取消排队中的单条消息 */
	function cancelPendingPrompt(id: string) {
		setPendingPrompts((prev) => prev.filter((p) => p.id !== id));
	}

	/** 清空所有排队消息 */
	function clearPendingPrompts() {
		setPendingPrompts([]);
	}

	/**
	 * 处理图片文件，转为 pi RPC 可识别的 ImageContent。
	 * 大图会压缩到最长边 2000px，避免 base64 过大导致 RPC 传输和模型上下文成本上升。
	 */
	async function processImageFile(file: File): Promise<ImageContent | null> {
		const maxSize = 10 * 1024 * 1024; // 原始文件 10MB 限制，避免误粘超大图片卡住渲染进程
		if (file.size > maxSize) {
			setToast("图片过大，最大支持 10MB");
			setTimeout(() => setToast(null), 3000);
			return null;
		}

		const validTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
		if (!validTypes.includes(file.type)) {
			setToast("不支持的图片格式，请使用 PNG/JPEG/GIF/WebP");
			setTimeout(() => setToast(null), 3000);
			return null;
		}

		// GIF 可能是动图，canvas 压缩会丢失动画；保留原始数据。
		if (file.type === "image/gif") return fileToImageContent(file);
		return resizeImageFile(file, 2000, 0.86).catch(() =>
			fileToImageContent(file),
		);
	}

	function fileToImageContent(file: File): Promise<ImageContent> {
		return new Promise((resolve) => {
			const reader = new FileReader();
			reader.onload = () =>
				resolve(dataUrlToImageContent(String(reader.result), file.type));
			reader.readAsDataURL(file);
		});
	}

	function dataUrlToImageContent(
		dataUrl: string,
		fallbackMimeType: string,
	): ImageContent {
		const [meta, data = ""] = dataUrl.split(",");
		const mimeType = meta.match(/^data:(.*?);base64$/)?.[1] || fallbackMimeType;
		return { type: "image", data, mimeType };
	}

	function resizeImageFile(
		file: File,
		maxEdge: number,
		quality: number,
	): Promise<ImageContent> {
		return new Promise((resolve, reject) => {
			const reader = new FileReader();
			reader.onerror = () => reject(reader.error);
			reader.onload = () => {
				const image = new Image();
				image.onerror = reject;
				image.onload = () => {
					const scale = Math.min(
						1,
						maxEdge / Math.max(image.width, image.height),
					);
					const width = Math.max(1, Math.round(image.width * scale));
					const height = Math.max(1, Math.round(image.height * scale));
					const canvas = document.createElement("canvas");
					canvas.width = width;
					canvas.height = height;
					canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
					// JPEG 更省 token/传输体积；透明 PNG/WebP 保持 PNG，避免截图透明区域变黑。
					const outputType =
						file.type === "image/png" ? "image/png" : "image/jpeg";
					resolve(
						dataUrlToImageContent(
							canvas.toDataURL(outputType, quality),
							outputType,
						),
					);
				};
				image.src = String(reader.result);
			};
			reader.readAsDataURL(file);
		});
	}

	/** 处理粘贴事件：从剪贴板提取图片 */
	async function handlePaste(event: React.ClipboardEvent) {
		const items = Array.from(event.clipboardData.items);
		for (const item of items) {
			if (item.type.startsWith("image/")) {
				event.preventDefault();
				const file = item.getAsFile();
				if (file) {
					const image = await processImageFile(file);
					if (image) {
						setAttachedImages((prev) => [...prev, image]);
					}
				}
				return;
			}
		}
	}

	/** 处理拖拽事件：支持拖入图片 */
	async function handleDrop(event: React.DragEvent) {
		event.preventDefault();
		const files = Array.from(event.dataTransfer.files);
		for (const file of files) {
			if (file.type.startsWith("image/")) {
				const image = await processImageFile(file);
				if (image) {
					setAttachedImages((prev) => [...prev, image]);
				}
			}
		}
	}

	function handleDragOver(event: React.DragEvent) {
		event.preventDefault();
	}

	/** 移除已附加的图片 */
	function removeImage(index: number) {
		setAttachedImages((prev) => prev.filter((_, i) => i !== index));
	}

	/** 清空所有附加图片 */
	function clearImages() {
		setAttachedImages([]);
	}

	async function updateSettings(patch: Partial<AppSettings>) {
		const next = await api.settings.update(patch);
		setSettings(next);
		let notice = "设置已保存。";
		if (
			"piProxyEnabled" in patch ||
			"piProxyUrl" in patch ||
			"piProxyBypass" in patch
		) {
			notice = next.piProxyEnabled
				? "pi agent 代理设置已保存；新建或重启 agent 后生效。"
				: "pi agent 代理已关闭。";
			setPiProxyNoticeTone("info");
			setPiProxyNotice(
				next.piProxyEnabled
					? "代理设置已保存；新建或重启 agent 后生效。"
					: "",
			);
		}
		if (
			"desktopProxyEnabled" in patch ||
			"desktopProxyUrl" in patch ||
			"desktopProxyBypass" in patch
		) {
			notice = next.desktopProxyEnabled
				? "桌面端代理设置已保存；模型拉取和模型测试会使用该代理。"
				: "桌面端代理已关闭。";
		}
		if ("sendShortcut" in patch) {
			notice = "发送快捷键设置已保存。";
		}
		if ("useNativeTitleBar" in patch) {
			notice = "标题栏样式已保存，重启应用后生效。";
		}
		setSettingsNotice(notice);
	}

	async function testPiProxy() {
		setPiProxyChecking(true);
		setPiProxyNoticeTone("info");
		setPiProxyNotice("正在检测 pi agent 代理...");
		try {
			const result = await api.settings.testPiProxy();
			setPiProxyNoticeTone(result.success ? "success" : "error");
			setPiProxyNotice(
				result.success
					? `${result.message ?? "代理可用"}，耗时 ${result.elapsedMs}ms。`
					: `代理检测失败：${result.error ?? "未知错误"}`,
			);
		} catch (error) {
			setPiProxyNoticeTone("error");
			setPiProxyNotice(
				`代理检测失败：${error instanceof Error ? error.message : String(error)}`,
			);
		} finally {
			setPiProxyChecking(false);
		}
	}

	async function switchBranch(branch: string) {
		if (!activeProjectId || !branch || branch === gitInfo.current) return;
		const next = await api.git.checkout(activeProjectId, branch);
		setGitInfo(next);
	}

	function openDrawer(panel: DrawerPanel) {
		if (drawerPinned && panel !== drawerPinnedPanel) return;
		if (panel === "sessions" && activeProjectId) {
			setSessionsProjectId(activeProjectId);
			void refreshSessions(activeProjectId);
		}
		setDrawer((current) => {
			if (current === panel) return drawerPinned ? current : null;
			return panel;
		});
	}

	function closeDrawer() {
		if (drawerPinned) return;
		setDrawer(null);
	}

	function collapseDrawer() {
		if (drawerPinned) return;
		setDrawerCollapsed(true);
	}

	function toggleDrawerPinned() {
		if (!activeAgentId || !drawer) return;
		setDrawerPinnedByAgent((current) => {
			const next = { ...current };
			if (next[activeAgentId]) delete next[activeAgentId];
			else next[activeAgentId] = drawer;
			return next;
		});
	}

	function toggleDirectory(path: string) {
		// 文件树默认折叠，只有用户显式展开目录才显示子项，避免大仓库一打开就产生视觉噪音。
		setExpandedDirs((current) => {
			const next = new Set(current);
			if (next.has(path)) next.delete(path);
			else next.add(path);
			return next;
		});
	}

	function startResize(target: "list" | "drawer", event: PointerEvent) {
		const startX = event.clientX;
		const startListWidth = listCollapsed ? 68 : listWidth;
		const startDrawerWidth = drawerCollapsed ? 0 : drawerWidth;
		let frame = 0;

		function onMove(moveEvent: globalThis.PointerEvent) {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const delta = moveEvent.clientX - startX;
				if (target === "list") {
					const next = Math.min(440, Math.max(160, startListWidth + delta));
					setListCollapsed(next <= 170);
					setListWidth(next);
				} else {
					const minDrawerWidth = drawerPinned ? 220 : 180;
					const next = Math.min(
						560,
						Math.max(minDrawerWidth, startDrawerWidth - delta),
					);
					setDrawerCollapsed(!drawerPinned && next <= 190);
					setDrawerWidth(next);
				}
			});
		}

		function onUp() {
			cancelAnimationFrame(frame);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			document.body.classList.remove("is-resizing");
		}

		document.body.classList.add("is-resizing");
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	function startComposerResize(event: PointerEvent) {
		const startY = event.clientY;
		const startHeight = resolvedComposerHeight;
		let frame = 0;

		function onMove(moveEvent: globalThis.PointerEvent) {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const maxHeight = getComposerMaxHeight();
				// 拖动的是输入区顶部边线，鼠标向上意味着输入区变高；限制最大高度避免挤压会话阅读区域。
				// 实际高度由手动高度和自动内容高度共同决定；拖到最大后自动高度也会变大，
				// 因此手动缩小时必须同步覆盖 autoHeight，否则 Math.max 会继续把输入框顶在最大高度。
				const next = Math.min(
					maxHeight,
					Math.max(COMPOSER_MIN_HEIGHT, startHeight + startY - moveEvent.clientY),
				);
				setComposerHeight(next);
				setComposerAutoHeight(next);
			});
		}

		function onUp() {
			cancelAnimationFrame(frame);
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onUp);
			document.body.classList.remove("is-composer-resizing");
		}

		document.body.classList.add("is-composer-resizing");
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onUp);
	}

	return (
		<div
			className={[
				"wechat-shell",
				drawer ? "drawer-open" : "",
				listCollapsed ? "list-collapsed" : "",
				drawerCollapsed ? "drawer-collapsed" : "",
			]
				.filter(Boolean)
				.join(" ")}
			style={
				{
					"--list-width": `${listCollapsed ? 68 : listWidth}px`,
					"--drawer-width": `${drawerCollapsed ? 0 : drawerWidth}px`,
				} as React.CSSProperties
			}
		>
			<aside className="chat-list-pane">
				<div className="list-toolbar">
					<div className="app-badge">
						<LogoMark />
						<span>Pi-π</span>
					</div>
					<div className="toolbar-actions">
						<button
							className="icon-button config-icon"
							title="配置管理"
							onClick={() => setConfigOpen(true)}
						>
							<Sliders size={17} />
						</button>
						<button
							className="icon-button settings-icon"
							title="设置"
							onClick={() => setSettingsOpen(true)}
						>
							<Settings size={17} />
						</button>
					</div>
				</div>
				<button
					className="collapse-button list-collapse"
					title={listCollapsed ? "展开列表" : "折叠列表"}
					onClick={() => setListCollapsed((value) => !value)}
				>
					{listCollapsed ? (
						<ChevronRight size={16} />
					) : (
						<ChevronLeft size={16} />
					)}
				</button>

				<div className="search-row">
					<div className="search-box">
						<span className="search-icon">
							<Search size={14} />
						</span>
						<input
							value={search}
							onChange={(event) => setSearch(event.target.value)}
							placeholder="搜索"
						/>
					</div>
					<button className="round-add" onClick={addProject}>
						<Plus size={18} />
					</button>
				</div>

				<div className="conversation-list">
					{filteredProjects.map((project) => {
						const projectDirectoryName = displayProjectDirectoryName(project);
						const projectAgents = filteredAgents.filter(
							(agent) => agent.projectId === project.id,
						);
						const isCollapsed = collapsedProjects.has(project.id);
						return (
							<div key={project.id} className="project-group">
								<button
									className={
										project.id === activeProjectId && !activeAgentId
										? "conversation active"
										: "conversation"
									}
									onContextMenu={(event) => {
										event.preventDefault();
										setProjectMenu({
											x: event.clientX,
											y: event.clientY,
											project,
										});
									}}
									onClick={() => {
										// 有 agent 时，点击整个项目行切换折叠状态
										if (projectAgents.length > 0) {
											setCollapsedProjects((prev) => {
												const next = new Set(prev);
												if (next.has(project.id)) next.delete(project.id);
												else next.add(project.id);
												return next;
											});
										}
										setActiveProjectId(project.id);
										setActiveAgentId(
											activeAgentByProject[project.id] ??
												displayAgents.find(
													(agent) => agent.projectId === project.id,
												)?.id,
										);
									}}
								>
									<span
										className={`project-fold${isCollapsed ? " folded" : ""}${projectAgents.length > 0 ? " has-agents" : ""}`}
										title={isCollapsed ? "展开" : "折叠"}
									>
										<Play size={12} />
									</span>
									<ProjectAvatar name={projectDirectoryName} />
									<div className="conversation-body">
										<div className="conversation-title">
											<strong title={project.path}>{projectDirectoryName}</strong>
										</div>
									</div>
									<span className="project-row-actions">
										<span
											className="project-action"
											title="历史会话"
											onClick={(event) => {
												event.stopPropagation();
												void openProjectSessions(project);
											}}
										>
											<History size={14} />
										</span>
										<span
											className="project-info"
											title="点击历史按钮可打开历史会话；右键项目可导入 Codex 会话或删除目录记录；点击项目可切换或折叠该目录的 Agent。"
											onClick={(event) => event.stopPropagation()}
										>
											<Info size={14} />
										</span>
										<span
											className="project-action project-delete"
											title="删除目录记录"
											onClick={async (event) => {
												event.stopPropagation();
												const next = await api.projects.remove(project.id);
												setProjects(next);
												updateAfterProjectRemoved(project.id, next);
											}}
										>
											<Trash2 size={14} />
										</span>
									</span>
								</button>
								{!isCollapsed &&
									projectAgents.map((agent) => (
										<button
											key={agent.id}
											className={
												agent.id === activeAgentId
													? "conversation agent-row active"
													: "conversation agent-row"
											}
											onContextMenu={(event) => {
												event.preventDefault();
												setAgentMenu({
													x: event.clientX,
													y: event.clientY,
													agent,
												});
											}}
											onClick={() => {
												setActiveProjectId(project.id);
												setActiveAgentId(agent.id);
											}}
										>
											<AgentAvatar status={agent.status} />
											<div className="conversation-body">
												<div className="conversation-title">
													<strong>{agent.title}</strong>
												</div>
											</div>
											<span
												className="conversation-close"
												onClick={(event) => {
													event.stopPropagation();
													void closeAgent(agent.id);
												}}
											>
												<X size={13} />
											</span>
										</button>
									))}
							</div>
						);
					})}
				</div>
			</aside>

			<div
				className="splitter splitter-left"
				onPointerDown={(event) => startResize("list", event)}
			/>

			<main ref={chatPaneRef} className="chat-pane">
				<header ref={chatHeaderRef} className="chat-header">
					<div className="chat-title-block">
						<strong
							title={activeAgent?.title ?? activeProject?.name ?? "pi desktop"}
						>
							{activeAgent?.title ?? activeProject?.name ?? "pi desktop"}
						</strong>
						<span
							title={
								activeAgent
									? `${activeAgent.status} · ${activeProject?.path ?? activeAgent.cwd}`
									: "选择项目并创建 Agent"
							}
						>
							{activeAgent
								? `${activeAgent.status} · ${displayPath(activeProject?.path ?? activeAgent.cwd)}`
								: "选择项目并创建 Agent"}
						</span>
						<SessionStatus
							state={activeRuntimeState}
							duration={
								activeAgentId
									? sessionDurationByAgent[activeAgentId]
									: undefined
							}
						/>
					</div>
					<div
						className={`chat-header-actions${activeAgent?.status === "starting" ? " loading" : ""}`}
					>
						<>
							<div className="header-action-group branch-group">
								<BranchSelector gitInfo={gitInfo} onSwitch={switchBranch} />
							</div>
							<div className="header-action-group session-group">
								<button
									className="primary-action"
									disabled={!activeProjectId || isAgentStarting}
									onClick={() => createAgent()}
									title="Start a new pi session"
								>
									New Session
								</button>
								<button
									disabled={!activeAgentId || activeAgent?.status !== "running"}
									onClick={() => abortAgent()}
								>
									Stop
								</button>
								<button
									disabled={
										!activeAgentId ||
										activeAgent?.status === "starting" ||
										!!loadingAction
									}
									title="重启 Agent 进程，重新加载配置文件（provider、API key 等）"
									onClick={async () => {
										if (!activeAgentId) return;
										setLoadingAction("restart");
										try {
											const tab = await api.agents.restart(activeAgentId);
											setActiveAgentId(tab.id);
											void refreshRuntimeState(tab.id);
										} finally {
											setLoadingAction(null);
										}
									}}
								>
									{loadingAction === "restart" ? "Restarting…" : "Restart"}
								</button>
							</div>
							<div className="header-action-group panel-group">
								<button
									className={drawer === "files" ? "active" : ""}
									disabled={isAgentStarting}
									onClick={() => {
										setDrawerCollapsed(false);
										openDrawer("files");
									}}
								>
									Files
								</button>
								<button
									className={terminalOpen ? "active" : ""}
									disabled={!activeAgentId || isAgentStarting}
									onClick={() => {
										if (!activeAgentId) return;
										setTerminalOpenForAgent(activeAgentId, !terminalOpen);
									}}
									title="显示或隐藏当前 Agent 的终端"
								>
									Terminal
								</button>
							</div>
						</>
					</div>
				</header>

				<section className="message-timeline" ref={timelineRef}>
					{activeAgent?.status === "starting" && (
						<div className="history-loading">
							<div className="loader" />
							<span>正在启动 Agent…</span>
						</div>
					)}
					{!activeAgent && (
						<EmptyState
							hasProject={Boolean(activeProjectId)}
							onCreate={() => createAgent()}
						/>
					)}
					{activeAgent && (
						<div className="message-list">
							{renderedMessages.map((item) =>
								item.kind === "agent-run" ? (
									<AgentRun
										key={item.id}
										run={item}
										onPreviewImage={setPreviewImage}
										onOpenExternal={(url) => api.app.openExternal(url)}
										onResendUserMessage={resendUserMessage}
										showThinking={settings.showThinking}
									/>
								) : item.kind === "tool-group" ? (
									<ToolGroup key={item.id} group={item} />
								) : (
									<ChatBubble
										key={item.message.id}
										message={item.message}
										onPreviewImage={setPreviewImage}
										onOpenExternal={(url) => api.app.openExternal(url)}
										onResendUserMessage={resendUserMessage}
										showThinking={settings.showThinking}
									/>
								),
							)}
							{isAwaitingAssistant && (
								<ThinkingBubble
									thinking={activeThinking}
									showThinking={settings.showThinking}
								/>
							)}
							{pendingPrompts.map((prompt) => (
								<PendingBubble
									key={prompt.id}
									pending={prompt}
									onCancel={() => cancelPendingPrompt(prompt.id)}
								/>
							))}
							{shouldShowSessionFileSummary && (
								<SessionFileSummary files={finalizedModifiedFiles} />
							)}
						</div>
					)}
					{outlineItems.length > 1 && (
						<ConversationOutline
							items={outlineItems}
							onJump={(id) =>
								document
									.querySelector(`[data-message-id="${CSS.escape(id)}"]`)
									?.scrollIntoView({ behavior: "smooth", block: "start" })
							}
						/>
					)}
				</section>

				{terminalOpen && activeAgentId && (
					<TerminalDock
						agentId={activeAgentId}
						height={terminalHeightByAgent[activeAgentId] ?? 220}
						terminal={api.terminal}
						onHeightChange={(height) =>
							setTerminalHeightByAgent((current) => ({
								...current,
								[activeAgentId]: height,
							}))
						}
						onClose={() => setTerminalOpenForAgent(activeAgentId, false)}
					/>
				)}

				<footer ref={composerRef} className="composer">
					<div
						ref={composerBoxRef}
						className={`composer-box ${
							prompt.startsWith("!!")
								? "shell-silent-mode"
								: prompt.startsWith("!")
									? "shell-mode"
									: ""
						}`}
						style={{ height: resolvedComposerHeight }}
					>
						<div
							className="composer-resize-handle"
							title="拖动调整输入框高度"
							onPointerDown={startComposerResize}
						/>
						<ComposerToolbar
							state={activeRuntimeState}
							compacting={compacting}
							disabled={isAgentBusy || isAgentStarting}
							onCycleModel={cycleModel}
							onPickModel={openModelPicker}
							onCycleThinking={cycleThinking}
							onCompact={compactAgent}
						/>
						<textarea
							ref={composerTextareaRef}
							wrap="soft"
							value={prompt}
							className={
								prompt.startsWith("!!")
									? "bang-bang"
									: prompt.startsWith("!")
										? "bang"
										: ""
							}
							onFocus={() => setSuggestionsOpen(true)}
							onChange={(event) => {
								setPrompt(event.target.value);
								setSuggestionsOpen(true);
							}}
							onKeyDown={handleComposerKeyDown}
							onPaste={handlePaste}
							onDrop={handleDrop}
							onDragOver={handleDragOver}
							disabled={isAgentStarting}
							placeholder={
								isAgentStarting
									? "Agent 正在启动…"
									: prompt.startsWith("!!")
									? "!!命令 — 直接执行，不写入上下文"
									: prompt.startsWith("!")
										? "!命令 — 直接执行 shell 命令"
										: settings.sendShortcut === "enter-send"
											? "输入消息，Enter 发送。/ 命令，@ 文件，! shell"
											: "输入消息，按设置的快捷键发送。/ 命令，@ 文件，! shell"
							}
						/>
						{suggestionsOpen && !isAgentStarting && (
							<PromptSuggestions
								prompt={prompt}
								items={suggestionItems}
								selectedIndex={selectedSuggestionIndex}
								onSelectedIndexChange={setSelectedSuggestionIndex}
								onClose={() => {
									setPrompt((current) => clearSuggestionTrigger(current));
									setSuggestionsOpen(false);
									requestAnimationFrame(() => {
										document
											.querySelector<HTMLTextAreaElement>(".composer-box textarea")
											?.focus();
									});
								}}
								onPick={(value) => {
									setPrompt((current) => applySuggestion(current, value));
									setSuggestionsOpen(false);
									requestAnimationFrame(() => {
										document
											.querySelector<HTMLTextAreaElement>(".composer-box textarea")
											?.focus();
									});
								}}
							/>
						)}
						{/* 图片预览区域：显示已附加的图片，支持单个或批量移除 */}
						{attachedImages.length > 0 && (
							<div className="image-preview-area">
								{attachedImages.map((img, index) => (
									<div key={index} className="image-preview-item">
										<img
											src={`data:${img.mimeType};base64,${img.data}`}
											alt={`图片 ${index + 1}`}
										
											onClick={() => setPreviewImage(img)}
											style={{ cursor: "pointer" }}
										/>
										<button
											className="image-remove-btn"
											onClick={() => removeImage(index)}
											title="移除图片"
										>
											×
										</button>
									</div>
								))}
								<button
									className="image-clear-btn"
									onClick={clearImages}
									title="清空所有图片"
								>
									清空
								</button>
							</div>
						)}
						<div className="composer-footer">
							<span className={composerMode ? "composer-mode-status" : ""}>
								{composerStatusText}
							</span>
							{activeAgent?.status === "running" && (
								<button className="stop-send" onClick={() => abortAgent()}>
									停止
								</button>
							)}
							<button
								disabled={
									isAgentStarting ||
									!activeAgentId ||
									(!prompt.trim() && attachedImages.length === 0)
								}
								className={
									isAgentBusy && (prompt.trim() || attachedImages.length > 0)
										? "queue-send"
										: ""
								}
								onClick={sendPrompt}
							>
								{isAgentBusy && (prompt.trim() || attachedImages.length > 0)
									? "排队发送"
									: pendingPrompts.length > 0
										? `发送 (${pendingPrompts.length} 排队中)`
										: "发送"}
							</button>
						</div>
					</div>
				</footer>
			</main>

			{drawer && !drawerCollapsed && (
				<div
					className="splitter splitter-right"
					onPointerDown={(event) => startResize("drawer", event)}
				/>
			)}
			{drawer && !drawerCollapsed && (
				<aside className="detail-drawer">
					<DrawerContent
						panel={drawer}
						project={drawer === "sessions" ? sessionsProject : undefined}
						files={files}
						sessions={sessions}
						modifiedFiles={modifiedFiles}
						expandedDirs={expandedDirs}
						onToggleDirectory={toggleDirectory}
						pinned={drawerPinned}
						onTogglePin={toggleDrawerPinned}
						onCollapse={collapseDrawer}
						onClose={closeDrawer}
						onFileContextMenu={(node, x, y) => setFileMenu({ node, x, y })}
						onRefreshSessions={() =>
							refreshSessions(sessionsProjectId ?? activeProjectId)
						}
						onOpenSession={(session) =>
							createAgent(
								sessionsProjectId ?? activeProjectId,
								session.filePath,
								session.name || "历史会话",
							)
						}
						onRenameSession={async (filePath, newName) => {
							await api.sessions.rename(filePath, newName);
							await refreshSessions(sessionsProjectId ?? activeProjectId);
						}}
					/>
				</aside>
			)}
			{drawer && drawerCollapsed && (
				<button
					className="drawer-restore"
					title="展开右侧面板"
					onClick={() => setDrawerCollapsed(false)}
				>
					<ChevronLeft size={16} />
				</button>
			)}
			{fileMenu && (
				<FileContextMenu
					menu={fileMenu}
					onClose={() => setFileMenu(null)}
					onOpen={() => {
						void api.files.open(fileMenu.node.path);
						setFileMenu(null);
					}}
					onReveal={() => {
						void api.files.showInFolder(fileMenu.node.path);
						setFileMenu(null);
					}}
					onAttach={() => {
						setPrompt(
							(current) =>
								`${current}${current.endsWith(" ") || current.length === 0 ? "" : " "}@${fileMenu.node.relativePath} `,
						);
						setFileMenu(null);
					}}
				/>
			)}
			{projectMenu && (
				<ProjectContextMenu
					menu={projectMenu}
					onClose={() => setProjectMenu(null)}
					onOpenSessions={() => openProjectSessions(projectMenu.project)}
					onImportCodexSessions={() => openCodexImport(projectMenu.project)}
					onRemoveProject={async () => {
						const project = projectMenu.project;
						setProjectMenu(null);
						const next = await api.projects.remove(project.id);
						setProjects(next);
						updateAfterProjectRemoved(project.id, next);
					}}
				/>
			)}
			{agentMenu && (
				<AgentContextMenu
					menu={agentMenu}
					onClose={() => setAgentMenu(null)}
					onActivate={() => {
						setActiveAgentId(agentMenu.agent.id);
						setActiveProjectId(agentMenu.agent.projectId);
						setAgentMenu(null);
					}}
					onExport={() => {
						void exportAgentHtml(agentMenu.agent.id);
						setAgentMenu(null);
					}}
					onShowLogs={() => {
						setRpcLogAgentId(agentMenu.agent.id);
						setAgentMenu(null);
					}}
					onCloseAgent={() => {
						void closeAgent(agentMenu.agent.id);
						setAgentMenu(null);
					}}
				/>
			)}
			{/* RPC 日志弹窗 */}
			{rpcLogAgentId && (
				<RpcLogModal
					logs={rpcLogs.filter((l) => l.agentId === rpcLogAgentId)}
					onClose={() => setRpcLogAgentId(null)}
				/>
			)}
			{toast && <div className="toast">{toast}</div>}
			{environmentDialog && (
				<EnvironmentDialog
					status={piStatus}
					checking={piChecking}
					onClose={() => setEnvironmentDialog(false)}
					onRecheck={() => checkPiInstall("manual")}
					onOpenInstallDocs={() =>
						api.app.openExternal(
							"https://pi.dev/docs/latest/quickstart#install",
						)
					}
				/>
			)}
			{modelPickerOpen && (
				<ModelPicker
					models={availableModels}
					onClose={() => setModelPickerOpen(false)}
					onPick={selectModel}
				/>
			)}
			{settingsOpen && (
				<SettingsModal
					settings={settings}
					notice={settingsNotice}
					piStatus={piStatus}
					piChecking={piChecking}
					piProxyChecking={piProxyChecking}
					piProxyNotice={piProxyNotice}
					piProxyNoticeTone={piProxyNoticeTone}
					appInfo={appInfo}
					onCheckPi={() => checkPiInstall("manual")}
					onTestPiProxy={() => testPiProxy()}
					onCheckUpdate={() => checkAppUpdate("manual")}
					onToggleDevTools={async () => {
						const opened = await api.app.toggleDevTools();
						setSettingsNotice(
							opened ? "开发者控制台已打开。" : "开发者控制台已关闭。",
						);
					}}
					onClose={() => setSettingsOpen(false)}
					onChange={updateSettings}
				/>
			)}
			{updateInfo && (
				<UpdateModal
					info={updateInfo}
					checking={updateChecking}
					onClose={() => setUpdateInfo(null)}
					onOpenRelease={() => api.app.openExternal(updateInfo.releaseUrl)}
					onDownload={() =>
						api.app.openExternal(
							updateInfo.recommendedAsset?.url ?? updateInfo.releaseUrl,
						)
					}
				/>
			)}
			{updateError && (
				<UpdateErrorModal
					message={updateError}
					releasesUrl={appInfo.releasesUrl}
					onClose={() => setUpdateError(null)}
					onOpenRelease={() => api.app.openExternal(appInfo.releasesUrl)}
				/>
			)}
			{previewImage && (
				<ImagePreviewModal
					image={previewImage}
					onClose={() => setPreviewImage(null)}
				/>
			)}
			{codexImportProject && (
				<CodexImportModal
					project={codexImportProject}
					sessions={codexImportSessions}
					selectedPaths={codexImportSelected}
					loading={codexImportLoading}
					importing={codexImportRunning}
					report={codexImportReport}
					onClose={() => {
						setCodexImportProject(null);
						setCodexImportReport(null);
					}}
					onRefresh={() => scanCodexSessions()}
					onToggle={toggleCodexSession}
					onToggleAll={toggleAllCodexSessions}
					onImport={importCodexSessions}
				/>
			)}
			{sessionsProject && (
				<SessionHistoryModal
					project={sessionsProject}
					sessions={sessions}
					loading={sessionHistoryLoading}
					onClose={() => {
						setSessionsProjectId(undefined);
						setSessions([]);
					}}
					onRefresh={() => refreshSessionHistory(sessionsProject.id)}
					onOpen={openHistorySession}
					onRename={renameHistorySession}
				/>
			)}
			<ConfigModal
				open={configOpen}
				onClose={() => setConfigOpen(false)}
				onSaved={() => {
					// 配置保存后不再自动 reload，用户可通过 Restart 按钮手动重载
				}}
			/>
		</div>
	);
}

function UpdateModal(props: {
	info: AppUpdateInfo;
	checking: boolean;
	onClose: () => void;
	onDownload: () => void;
	onOpenRelease: () => void;
}) {
	return (
		<div className="modal-backdrop update-backdrop">
			<section className="update-modal">
				<div className="modal-header">
					<strong>发现新版本 v{props.info.latestVersion}</strong>
					<button onClick={props.onClose}>×</button>
				</div>
				<div className="update-body">
					<p className="update-version-line">
						当前版本 v{props.info.currentVersion}，最新版本 v
						{props.info.latestVersion}
					</p>
					{props.info.recommendedAsset && (
						<p className="update-asset-line">
							推荐下载：{props.info.recommendedAsset.name}
						</p>
					)}
					<div className="update-notes">
						{props.info.releaseNotes.trim() || "该版本没有填写发布日志。"}
					</div>
				</div>
				<div className="update-actions">
					<button onClick={props.onOpenRelease}>打开 Release</button>
					<button className="primary" disabled={props.checking} onClick={props.onDownload}>
						用浏览器下载
					</button>
				</div>
			</section>
		</div>
	);
}

function UpdateErrorModal(props: {
	message: string;
	releasesUrl: string;
	onClose: () => void;
	onOpenRelease: () => void;
}) {
	return (
		<div className="modal-backdrop update-backdrop">
			<section className="update-modal update-error-modal">
				<div className="modal-header">
					<strong>检查更新失败</strong>
					<button onClick={props.onClose}>×</button>
				</div>
				<div className="update-body">
					<p className="update-version-line">
						无法连接 GitHub Release。国内网络环境下 GitHub 可能不可达，
						你可以稍后重试，或在设置的“代理设置”里配置桌面端代理后再次检查。
					</p>
					<div className="update-error-detail">错误信息：{props.message}</div>
					<p className="update-asset-line">
						也可以直接在浏览器打开 Release 页面手动查看和下载：
						<br />
						<span>{props.releasesUrl}</span>
					</p>
				</div>
				<div className="update-actions">
					<button onClick={props.onClose}>关闭</button>
					<button className="primary" onClick={props.onOpenRelease}>
						打开 Release 页面
					</button>
				</div>
			</section>
		</div>
	);
}

