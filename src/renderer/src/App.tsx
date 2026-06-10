import {
	Fragment,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	Settings,
	Sliders,
	ChevronLeft,
	ChevronRight,
	ChevronDown,
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
import { getComposerEnterIntent } from "./composerBehavior";
import {
	pruneTerminalDockState,
	setTerminalDockCollapsed,
	setTerminalDockOpen,
	type TerminalDockStateByAgent,
} from "./terminalDockState";
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
	ProjectAvatar,
	ProjectContextMenu,
	PromptSuggestions,
	RpcLogModal,
	SessionHistoryModal,
	SessionStatus,
	SessionFileSummary,
	SettingsModal,
	ThinkingBubble,
	ThinkingPicker,
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
	FeedbackEnvironment,
	ChatMessage,
	CodexImportReport,
	CodexSessionSummary,
	FileTreeNode,
	GitBranchInfo,
	ImageContent,
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
	if (isChatProject(project)) return "Chat";
	const normalizedPath = project.path.replace(/\\/g, "/").replace(/\/+$/, "");
	return normalizedPath.split("/").pop() || project.name || project.path;
}

function isChatProject(project?: Project) {
	return project?.kind === "chat";
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

function migrateAgentRecord<T>(
	current: Record<string, T>,
	replacementById: Map<string, string>,
	liveIds: Set<string>,
) {
	const next: Record<string, T> = {};
	for (const [agentId, value] of Object.entries(current)) {
		const nextAgentId = replacementById.get(agentId) ?? agentId;
		if (liveIds.has(nextAgentId)) next[nextAgentId] = value;
	}
	return next;
}

export function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [draggingProjectId, setDraggingProjectId] = useState<string>();
	const [dragOverProjectId, setDragOverProjectId] = useState<string>();
	const [agents, setAgents] = useState<AgentTab[]>([]);
	const [pendingAgents, setPendingAgents] = useState<AgentTab[]>([]);
	const [activeProjectId, setActiveProjectId] = useState<string>();
	const [activeAgentId, setActiveAgentId] = useState<string>();
	const activeAgentIdRef = useRef<string | undefined>(activeAgentId);
	activeAgentIdRef.current = activeAgentId;
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
	const [thinkingPickerOpen, setThinkingPickerOpen] = useState(false);
	const [sendBehaviorMenuOpen, setSendBehaviorMenuOpen] = useState(false);
	const [switchingBranch, setSwitchingBranch] = useState<string | null>(null);
	const [promptByAgent, setPromptByAgent] = useState<Record<string, string>>({});
	/** 当前进行的操作类型，用于按钮 loading 状态 */
	const [loadingAction, setLoadingAction] = useState<null | "restart">(null);
	/** 键盘上下键切换的历史消息列表 */
	const [messageHistory, setMessageHistory] = useState<string[]>([]);
	/** 当前在历史中的索引，-1 表示新输入；用 ref 确保键盘事件回调中读取到最新的值 */
	const historyIndexRef = useRef(-1);
	const [attachedImagesByAgent, setAttachedImagesByAgent] = useState<
		Record<string, ImageContent[]>
	>({});
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
	/** 每轮回答完成后固化的文件修改摘要，key 为 assistant message id，便于卡片贴在对应回答后。 */
	const [turnFileSummaryByMessage, setTurnFileSummaryByMessage] = useState<
		Record<string, SessionModifiedFile[]>
	>({});
	// 记录每轮回答开始前已有的修改文件累计状态，用增量差异避免聊天卡片重复展示历史会话文件。
	const turnFileBaselineByAgentRef = useRef<
		Record<string, Map<string, SessionModifiedFile>>
	>({});
	const finalizedTurnByAgentRef = useRef<Record<string, string | null>>({});
	const agentStatusByAgentRef = useRef<Record<string, AgentTab["status"]>>({});
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
	const [agentActionLoading, setAgentActionLoading] = useState<"copy" | "export" | null>(null);
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
	const [feedbackOpen, setFeedbackOpen] = useState(false);
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
	const [terminalDockStateByAgent, setTerminalDockStateByAgent] =
		useState<TerminalDockStateByAgent>({});
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
	const projectDragPreventClickRef = useRef(false);

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
	const prompt = activeAgentId ? (promptByAgent[activeAgentId] ?? "") : "";
	const attachedImages = activeAgentId
		? (attachedImagesByAgent[activeAgentId] ?? [])
		: [];

	function setPrompt(value: string | ((current: string) => string)) {
		const targetAgentId = activeAgentIdRef.current;
		if (!targetAgentId) return;
		setPromptByAgent((current) => {
			const previous = current[targetAgentId] ?? "";
			const nextValue =
				typeof value === "function" ? value(previous) : value;
			if (!nextValue) {
				const next = { ...current };
				delete next[targetAgentId];
				return next;
			}
			return {
				...current,
				[targetAgentId]: nextValue,
			};
		});
	}

	function setAttachedImages(
		value: ImageContent[] | ((current: ImageContent[]) => ImageContent[]),
	) {
		if (!activeAgentId) return;
		setAttachedImagesByAgent((current) => {
			const previous = current[activeAgentId] ?? [];
			const nextValue =
				typeof value === "function" ? value(previous) : value;
			if (nextValue.length === 0) {
				const next = { ...current };
				delete next[activeAgentId];
				return next;
			}
			return {
				...current,
				[activeAgentId]: nextValue,
			};
		});
	}
	const terminalDockState = activeAgentId
		? terminalDockStateByAgent[activeAgentId]
		: undefined;
	// 终端打开/折叠状态按 agent 隔离，避免切换项目/agent 后丢失当前终端 UI 状态。
	const terminalOpen = Boolean(terminalDockState?.open);
	const terminalCollapsed = Boolean(terminalDockState?.collapsed);
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
	const canReorderProjects = search.trim().length === 0;

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
			const pendingReplacementById = new Map(
				previousPendingAgents
					.map((pending) => {
						const replacement = nextAgents.find((agent) =>
							isReplacementForPendingAgent(agent, pending),
						);
						return replacement ? [pending.id, replacement.id] : undefined;
					})
					.filter((entry): entry is [string, string] => Boolean(entry)),
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
			const draftIds = new Set([
				...nextAgents.map((agent) => agent.id),
				...remainingPendingAgents.map((agent) => agent.id),
			]);
			setTerminalDockStateByAgent((current) =>
				pruneTerminalDockState(current, activeIds),
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
			setPromptByAgent((current) =>
				migrateAgentRecord(current, pendingReplacementById, draftIds),
			);
			setAttachedImagesByAgent((current) =>
				migrateAgentRecord(current, pendingReplacementById, draftIds),
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

	useEffect(() => {
		const activeIds = new Set(displayAgents.map((agent) => agent.id));
		setTerminalDockStateByAgent((current) =>
			pruneTerminalDockState(current, activeIds),
		);
	}, [displayAgents]);

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
			const previousStatus = agentStatusByAgentRef.current[agent.id];
			if (agent.status === "running") {
				if (previousStatus !== "running") {
					sessionStartByAgentRef.current[agent.id] = Date.now();
					// Files 面板展示会话总览；聊天流只展示本轮回答新增触达的文件。
					// 基线记录累计行数而不是仅记录路径：同一个文件在后续回答再次被编辑时也要显示。
					turnFileBaselineByAgentRef.current[agent.id] = new Map(
						modifiedFiles.map((file) => [file.path, file]),
					);
					finalizedTurnByAgentRef.current[agent.id] = null;
				}
			} else if (agent.status === "idle") {
				const start = sessionStartByAgentRef.current[agent.id];
				if (start) {
					setSessionDurationByAgent((d) => ({
						...d,
						[agent.id]: Date.now() - start,
					}));
				}
				if (modifiedFiles.length > 0) {
					// 会话级摘要仍保留给右侧 Files 面板作为总览，但不再渲染到聊天底部。
					setSessionFileSummaryByAgent((current) => ({
						...current,
						[agent.id]: modifiedFiles,
					}));
				}

				const lastAssistantMessage = [...(messagesByAgent[agent.id] ?? [])]
					.reverse()
					.find((message) => message.role === "assistant");
				const baseline =
					turnFileBaselineByAgentRef.current[agent.id] ??
					new Map<string, SessionModifiedFile>();
				const turnModifiedFiles = modifiedFiles
					.map<SessionModifiedFile | null>((file) => {
						const baselineFile = baseline.get(file.path);
						const changedLines = Math.max(
							0,
							(file.changedLines ?? 0) - (baselineFile?.changedLines ?? 0),
						);
						return changedLines > 0 || !baselineFile
							? { ...file, changedLines }
							: null;
					})
					.filter((file): file is SessionModifiedFile => Boolean(file));

				if (
					lastAssistantMessage &&
					turnModifiedFiles.length > 0 &&
					finalizedTurnByAgentRef.current[agent.id] !== lastAssistantMessage.id
				) {
					finalizedTurnByAgentRef.current[agent.id] = lastAssistantMessage.id;
					setTurnFileSummaryByMessage((current) => ({
						...current,
						[lastAssistantMessage.id]: turnModifiedFiles,
					}));
				}
			}
			agentStatusByAgentRef.current[agent.id] = agent.status;
		}
	}, [displayAgents, activeAgentId, modifiedFiles, messagesByAgent]);

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

	useEffect(() => {
		if (!activeProjectId) return;
		let stopped = false;
		const refreshGitInfo = async () => {
			try {
				const next = await api.git.branches(activeProjectId);
				if (stopped) return;
				// 分支可能在外部终端/IDE 中切换，轮询只在状态真的变化时更新，避免不必要重渲染。
				setGitInfo((current) =>
					current.current === next.current &&
					current.branches.join("\n") === next.branches.join("\n")
						? current
						: next,
				);
			} catch {
				if (!stopped) setGitInfo({ current: null, branches: [] });
			}
		};
		const timer = window.setInterval(refreshGitInfo, 4000);
		return () => {
			stopped = true;
			window.clearInterval(timer);
		};
	}, [activeProjectId]);

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

	function showToast(message: string, duration = 3500) {
		setToast(message);
		window.setTimeout(() => setToast(null), duration);
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
				showToast("当前已是最新版本");
			}
		} catch (error) {
			if (source === "manual") {
				const message = error instanceof Error ? error.message : String(error);
				setSettingsNotice(`检查更新失败：${message}`);
				setUpdateError(message);
				showToast("检查更新失败");
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

	async function refreshFiles(projectId = activeProjectId) {
		if (!projectId) return;
		const next = await api.files.list(projectId);
		setFiles(next);
		showToast("文件列表已刷新", 1800);
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

	async function copySession(filePath: string, projectId = sessionsProjectId ?? activeProjectId) {
		if (!projectId) return;
		const result = await api.sessions.copy(projectId, filePath);
		if (result.cancelled) {
			showToast("复制会话已取消");
			return;
		}
		showToast("已通过 pi RPC 复制会话");
		await refreshSessions(projectId);
	}

	async function exportHistorySession(session: SessionSummary) {
		const projectId = sessionsProjectId ?? activeProjectId;
		if (!projectId) return;
		const result = await api.sessions.exportHtml(projectId, session.filePath);
		showToast(`已导出：${result.path}`, 3500);
	}

	async function deleteHistorySession(session: SessionSummary) {
		await api.sessions.delete(session.filePath);
		showToast("已删除会话", 2200);
		await refreshSessions(sessionsProjectId ?? activeProjectId);
	}

	async function cloneAgentSession(agentId: string) {
		setAgentActionLoading("copy");
		try {
			const result = await api.agents.cloneSession(agentId);
			if (result?.cancelled) {
				showToast("复制会话已取消");
				return;
			}
			showToast("已通过 pi RPC 复制当前会话");
			await refreshRuntimeState(agentId);
			await refreshSessions(activeProjectId);
		} finally {
			setAgentActionLoading(null);
			setAgentMenu(null);
		}
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

	async function reorderProjects(sourceProjectId: string, targetProjectId: string) {
		if (!canReorderProjects || sourceProjectId === targetProjectId) return;
		const sourceProject = projects.find((project) => project.id === sourceProjectId);
		const targetProject = projects.find((project) => project.id === targetProjectId);
		if (isChatProject(sourceProject) || isChatProject(targetProject)) return;
		const sourceIndex = projects.findIndex((project) => project.id === sourceProjectId);
		const targetIndex = projects.findIndex((project) => project.id === targetProjectId);
		if (sourceIndex === -1 || targetIndex === -1) return;

		const previousProjects = projects;
		const nextProjects = [...projects];
		const [movedProject] = nextProjects.splice(sourceIndex, 1);
		const targetIndexAfterRemoval = nextProjects.findIndex(
			(project) => project.id === targetProjectId,
		);
		const insertIndex =
			sourceIndex < targetIndex ? targetIndexAfterRemoval + 1 : targetIndexAfterRemoval;
		nextProjects.splice(insertIndex, 0, movedProject);
		setProjects(nextProjects);

		try {
			const savedProjects = await api.projects.reorder(
				nextProjects.map((project) => project.id),
			);
			setProjects(savedProjects);
		} catch (error) {
			setProjects(previousProjects);
			showToast(
				`项目排序保存失败：${error instanceof Error ? error.message : String(error)}`,
				4000,
			);
		}
	}

	function handleProjectDragStart(
		event: React.DragEvent<HTMLButtonElement>,
		projectId: string,
	) {
		if (!canReorderProjects) {
			event.preventDefault();
			return;
		}
		setDraggingProjectId(projectId);
		event.dataTransfer.effectAllowed = "move";
		event.dataTransfer.setData("text/plain", projectId);
	}

	function handleProjectDragOver(
		event: React.DragEvent<HTMLButtonElement>,
		projectId: string,
	) {
		if (!draggingProjectId || draggingProjectId === projectId) return;
		if (isChatProject(projects.find((project) => project.id === projectId))) return;
		event.preventDefault();
		event.dataTransfer.dropEffect = "move";
		setDragOverProjectId(projectId);
	}

	function handleProjectDragLeave(projectId: string) {
		setDragOverProjectId((current) => (current === projectId ? undefined : current));
	}

	function finishProjectDrag() {
		setDraggingProjectId(undefined);
		setDragOverProjectId(undefined);
	}

	async function handleProjectDrop(
		event: React.DragEvent<HTMLButtonElement>,
		targetProjectId: string,
	) {
		event.preventDefault();
		const sourceProjectId =
			event.dataTransfer.getData("text/plain") || draggingProjectId;
		finishProjectDrag();
		if (!sourceProjectId || sourceProjectId === targetProjectId) return;
		projectDragPreventClickRef.current = true;
		window.setTimeout(() => {
			projectDragPreventClickRef.current = false;
		}, 0);
		await reorderProjects(sourceProjectId, targetProjectId);
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
			setActiveAgentId((current) =>
				current === pendingTab.id ? tab.id : current,
			);
			setActiveAgentByProject((current) =>
				current[projectId] === pendingTab.id
					? {
							...current,
							[projectId]: tab.id,
						}
					: current,
			);
			setPromptByAgent((current) => {
				const draft = current[pendingTab.id];
				if (draft == null) return current;
				const next = { ...current, [tab.id]: draft };
				delete next[pendingTab.id];
				return next;
			});
			setAttachedImagesByAgent((current) => {
				const draft = current[pendingTab.id];
				if (draft == null) return current;
				const next = { ...current, [tab.id]: draft };
				delete next[pendingTab.id];
				return next;
			});
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
				if (current[projectId] !== pendingTab.id) return current;
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

	async function selectThinking(level: string) {
		if (!activeAgentId || isPendingAgentId(activeAgentId)) return;
		try {
			// 使用 setThinking 明确落到用户选择的档位，避免 cycle 模式需要反复点击才能到目标级别。
			const state = await api.agents.setThinking(activeAgentId, level);
			setRuntimeStateByAgent((current) => ({
				...current,
				[activeAgentId]: state,
			}));
			setThinkingPickerOpen(false);
			// pi runtime 会按模型能力 clamp thinking level；对比实际状态，避免用户误以为已运行在不支持的档位。
			if (state.thinkingLevel && state.thinkingLevel !== level) {
				showToast(`当前模型不支持 ${level}，已回退为 ${state.thinkingLevel}`);
			}
		} catch (error) {
			showToast(`切换思考级别失败：${error instanceof Error ? error.message : String(error)}`);
		}
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
		await api.agents.abort(agentId);
		void refreshRuntimeState(agentId);
	}

	async function exportAgentHtml(agentId: string) {
		if (isPendingAgentId(agentId)) return;
		setAgentActionLoading("export");
		try {
			const result = await api.agents.exportHtml(agentId);
			setToast(`已导出：${result.path}`);
			setTimeout(() => setToast(null), 3500);
		} finally {
			setAgentActionLoading(null);
			setAgentMenu(null);
		}
	}

	function setTerminalOpenForAgent(agentId: string, open: boolean) {
		setTerminalDockStateByAgent((current) =>
			setTerminalDockOpen(current, agentId, open),
		);
	}

	function setTerminalCollapsedForAgent(agentId: string, collapsed: boolean) {
		setTerminalDockStateByAgent((current) =>
			setTerminalDockCollapsed(current, agentId, collapsed),
		);
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
		const enterIntent = getComposerEnterIntent(event, settings.sendShortcut);
		if (enterIntent === "send") {
			event.preventDefault();
			void sendPrompt();
		} else if (enterIntent === "newline") {
			// 让 textarea 自己处理换行，保持输入体验接近普通聊天软件。
			return;
		}
	}

	/** 判断 agent 是否处于忙碌状态（正在处理消息或流式输出中） */
	const isAgentStarting = activeAgent?.status === "starting";
	const composerDisabled = !activeAgent || isAgentStarting;
	const isAgentBusy = Boolean(
		activeAgent &&
			(activeAgent.status === "running" || activeRuntimeState?.isStreaming),
	);

	async function sendPrompt() {
		if (
			isAgentStarting ||
			!activeAgentId ||
			(!prompt.trim() && attachedImages.length === 0)
		)
			return;
		const message = prompt;
		const images = attachedImages.length > 0 ? attachedImages : undefined;
		// 发送前先保留快照，再立即清空 composer；运行中发送会走官方 steer 队列，
		// 由 pi runtime 保证在当前工具调用结束后、下一次 LLM 调用前注入。
		setPrompt("");
		setAttachedImages([]);
		setSuggestionsOpen(false);
		setSendBehaviorMenuOpen(false);
		await submitPromptSnapshot(activeAgentId, message, images);
	}

	async function sendPromptAsFollowUp() {
		if (
			isAgentStarting ||
			!activeAgentId ||
			(!prompt.trim() && attachedImages.length === 0)
		)
			return;
		const message = prompt;
		const images = attachedImages.length > 0 ? attachedImages : undefined;
		setPrompt("");
		setAttachedImages([]);
		setSuggestionsOpen(false);
		setSendBehaviorMenuOpen(false);
		await submitPromptSnapshot(activeAgentId, message, images, "followUp");
	}

	async function submitPromptSnapshot(
		agentId: string,
		message: string,
		images?: ImageContent[],
		streamingBehavior?: "steer" | "followUp",
	) {
		// 这里接收快照参数，让 composer 发送和历史消息“重新发送”共享同一条路径。
		// Agent 忙碌时显式使用官方 streamingBehavior=steer：消息会进入 pi 的运行中队列，
		// 而不是留在 desktop 本地等整个 agent idle 后再发送。
		const behavior = streamingBehavior ?? (isAgentBusy ? "steer" : undefined);
		await api.agents.prompt({
			agentId,
			message,
			images,
			...(behavior ? { streamingBehavior: behavior } : {}),
		});
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
		setSwitchingBranch(branch);
		try {
			const next = await api.git.checkout(activeProjectId, branch);
			setGitInfo(next);
		} catch (error) {
			showToast(`切换分支失败：${error instanceof Error ? error.message : String(error)}`);
			// 失败后主动刷新一次，覆盖 git 拒绝切换或外部同时切换导致的 UI 状态偏差。
			const refreshed = await api.git
				.branches(activeProjectId)
				.catch(() => ({ current: null, branches: [] }));
			setGitInfo(refreshed);
		} finally {
			setSwitchingBranch(null);
		}
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
							className="icon-button feedback-icon"
							title="问题反馈"
							onClick={() => setFeedbackOpen(true)}
						>
							<Info size={17} />
						</button>
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
						const projectIsChat = isChatProject(project);
						const canDragProject = canReorderProjects && !projectIsChat;
						const projectAgents = filteredAgents.filter(
							(agent) => agent.projectId === project.id,
						);
						const isCollapsed = collapsedProjects.has(project.id);
						const isDraggingProject = draggingProjectId === project.id;
						const isProjectDropTarget = dragOverProjectId === project.id;
						const projectRowClass = [
							project.id === activeProjectId && !activeAgentId
								? "conversation active"
								: "conversation",
							canDragProject ? "project-draggable" : "",
							projectIsChat ? "chat-project" : "",
							isDraggingProject ? "dragging" : "",
							isProjectDropTarget ? "drag-over" : "",
						]
							.filter(Boolean)
							.join(" ");
						return (
							<div
								key={project.id}
								className={`project-group${projectIsChat ? " chat-project-group" : ""}`}
							>
								<button
									className={projectRowClass}
									draggable={canDragProject}
									onDragStart={(event) =>
										handleProjectDragStart(event, project.id)
									}
									onDragOver={(event) =>
										handleProjectDragOver(event, project.id)
									}
									onDragLeave={() => handleProjectDragLeave(project.id)}
									onDrop={(event) => void handleProjectDrop(event, project.id)}
									onDragEnd={finishProjectDrag}
									onContextMenu={(event) => {
										event.preventDefault();
										setProjectMenu({
											x: event.clientX,
											y: event.clientY,
											project,
										});
									}}
									onClick={() => {
										if (projectDragPreventClickRef.current) return;
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
										setActiveAgentId(undefined);
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
										{projectIsChat && (
											<p className="chat-project-guide">
												内置对话区，不需要选择项目目录
											</p>
										)}
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
											title={
												projectIsChat
													? "Chat 是固定置顶的内置对话区；会话写入应用用户目录，不需要先添加项目。"
													: "点击历史按钮可打开历史会话；右键项目可导入 Codex 会话或删除目录记录；点击项目可切换或折叠该目录的 Agent。"
											}
											onClick={(event) => event.stopPropagation()}
										>
											<Info size={14} />
										</span>
										{!projectIsChat && (
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
										)}
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
								<BranchSelector
									gitInfo={gitInfo}
									switchingBranch={switchingBranch}
									onSwitch={switchBranch}
								/>
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
										fileSummariesByMessage={turnFileSummaryByMessage}
									/>
								) : item.kind === "tool-group" ? (
									<ToolGroup key={item.id} group={item} />
								) : (
									<Fragment key={item.message.id}>
										<ChatBubble
											message={item.message}
											onPreviewImage={setPreviewImage}
											onOpenExternal={(url) => api.app.openExternal(url)}
											onResendUserMessage={resendUserMessage}
											showThinking={settings.showThinking}
										/>
										{item.message.role === "assistant" &&
											turnFileSummaryByMessage[item.message.id]?.length > 0 && (
												<SessionFileSummary
													files={turnFileSummaryByMessage[item.message.id]}
												/>
											)}
									</Fragment>
								),
							)}
							{isAwaitingAssistant && (
								<ThinkingBubble
									thinking={activeThinking}
									showThinking={settings.showThinking}
								/>
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
						collapsed={terminalCollapsed}
						height={terminalHeightByAgent[activeAgentId] ?? 220}
						terminal={api.terminal}
						onCollapsedChange={(collapsed) =>
							setTerminalCollapsedForAgent(activeAgentId, collapsed)
						}
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
					{/* 图片预览作为输入框上方的附件栏，避免占用 textarea 的可输入区域。 */}
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
										<X size={12} strokeWidth={2.4} />
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
							disabled={isAgentBusy || composerDisabled}
							onCycleModel={cycleModel}
							onPickModel={openModelPicker}
							onPickThinking={() => setThinkingPickerOpen(true)}
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
							disabled={composerDisabled}
							placeholder={
								isAgentStarting
									? "Agent 正在启动…"
									: !activeAgent
										? "请选择一个 Agent 后输入消息"
									: prompt.startsWith("!!")
									? "!!命令 — 直接执行，不写入上下文"
									: prompt.startsWith("!")
										? "!命令 — 直接执行 shell 命令"
										: settings.sendShortcut === "enter-send"
											? "输入消息，Enter 发送。/ 命令，@ 文件，! shell"
											: "输入消息，按设置的快捷键发送。/ 命令，@ 文件，! shell"
							}
						/>
						{suggestionsOpen && !composerDisabled && (
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
						<div className="composer-footer">
							<span className={composerMode ? "composer-mode-status" : ""}>
								{composerStatusText}
							</span>
							{activeAgent?.status === "running" && (
								<button className="stop-send" onClick={() => abortAgent()}>
									停止
								</button>
							)}
							<div className="send-button-group">
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
										? "加入指令"
										: "发送"}
								</button>
								{isAgentBusy && (prompt.trim() || attachedImages.length > 0) && (
									<div className="send-behavior-menu-wrap">
										<button
											className="send-behavior-toggle"
											title="选择运行中发送方式"
											onClick={() => setSendBehaviorMenuOpen((open) => !open)}
										>
											<ChevronDown size={14} />
										</button>
										{sendBehaviorMenuOpen && (
											<div className="send-behavior-menu">
												<button onClick={sendPrompt}>
													<strong>加入当前回合</strong>
													<span>steer · 下一次 LLM 调用前生效</span>
												</button>
												<button onClick={sendPromptAsFollowUp}>
													<strong>排队到下一轮</strong>
													<span>followUp · agent 停止后发送</span>
												</button>
											</div>
										)}
									</div>
								)}
							</div>
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
						onRefreshFiles={() => refreshFiles(activeProjectId)}
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
						onCopySession={(session) =>
							copySession(session.filePath, sessionsProjectId ?? activeProjectId)
						}
						onExportSession={exportHistorySession}
						onDeleteSession={deleteHistorySession}
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
					actionLoading={agentActionLoading}
					onClose={() => {
						if (!agentActionLoading) setAgentMenu(null);
					}}
					onActivate={() => {
						setActiveAgentId(agentMenu.agent.id);
						setActiveProjectId(agentMenu.agent.projectId);
						setAgentMenu(null);
					}}
					onExport={() => {
						void exportAgentHtml(agentMenu.agent.id);
					}}
					onCopySession={() => {
						void cloneAgentSession(agentMenu.agent.id);
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
					current={{
						provider: activeRuntimeState?.provider,
						modelId: activeRuntimeState?.modelId,
						modelName: activeRuntimeState?.modelName,
					}}
					onClose={() => setModelPickerOpen(false)}
					onPick={selectModel}
				/>
			)}
			{thinkingPickerOpen && (
				<ThinkingPicker
					current={activeRuntimeState?.thinkingLevel}
					onClose={() => setThinkingPickerOpen(false)}
					onPick={selectThinking}
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
					onClose={() => {
						setSettingsOpen(false);
						setSettingsNotice("");
					}}
					onChange={updateSettings}
				/>
			)}
			{feedbackOpen && (
				<FeedbackModal
					project={activeProject}
					appInfo={appInfo}
					onClose={() => setFeedbackOpen(false)}
					onCopy={() => showToast("反馈内容已复制")}
					onOpenExternal={(url) => api.app.openExternal(url)}
					loadEnvironment={api.app.feedbackEnvironment}
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
					onCopy={(session) => copySession(session.filePath, sessionsProject.id)}
					onExport={exportHistorySession}
					onDelete={deleteHistorySession}
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

function FeedbackModal({
	project,
	appInfo,
	onClose,
	onCopy,
	onOpenExternal,
	loadEnvironment,
}: {
	project?: Project;
	appInfo: AppInfo;
	onClose: () => void;
	onCopy: () => void;
	onOpenExternal: (url: string) => Promise<void>;
	loadEnvironment: () => Promise<FeedbackEnvironment>;
}) {
	const [description, setDescription] = useState("");
	const [steps, setSteps] = useState("");
	const [environment, setEnvironment] = useState<FeedbackEnvironment | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");

	useEffect(() => {
		let cancelled = false;
		loadEnvironment()
			.then((next) => {
				if (!cancelled) setEnvironment(next);
			})
			.catch((reason) => {
				if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
			})
			.finally(() => {
				if (!cancelled) setLoading(false);
			});
		return () => {
			cancelled = true;
		};
	}, [loadEnvironment]);

	const report = buildFeedbackReport({
		description,
		steps,
		project,
		environment,
		fallbackVersion: appInfo.version,
		environmentError: error,
	});
	const issueUrl = `https://github.com/ayuayue/pi-desktop/issues/new?title=${encodeURIComponent("问题反馈：")}&body=${encodeURIComponent(report)}`;
	const authorUrl = "https://github.com/ayuayue";

	async function copyReport() {
		await navigator.clipboard.writeText(report);
		onCopy();
	}

	return (
		<div className="modal-backdrop feedback-backdrop" onClick={onClose}>
			<section className="feedback-modal" onClick={(event) => event.stopPropagation()}>
				<div className="modal-header feedback-header">
					<div>
						<strong>问题反馈</strong>
						<small>
							填写问题后，可复制内容或打开 GitHub Issue；也可发送邮件到{" "}
							<strong className="feedback-email">chat@caoayu.eu.org</strong>
						</small>
					</div>
					<button className="modal-close-btn" onClick={onClose}>×</button>
				</div>
				<div className="feedback-body">
					<label>
						<span>遇到的问题</span>
						<textarea
							value={description}
							onChange={(event) => setDescription(event.target.value)}
							placeholder="例如：点击检测环境后提示未检测到 pi，但命令行里 pi --version 正常。"
						/>
					</label>
					<label>
						<span>复现步骤</span>
						<textarea
							value={steps}
							onChange={(event) => setSteps(event.target.value)}
							placeholder="1. 打开应用\n2. 点击配置管理左侧的问题反馈\n3. ..."
						/>
					</label>
					<div className="feedback-report-block">
						<div>
							<strong>将附带的环境信息</strong>
							<span>{loading ? "正在读取环境信息…" : "已生成，可在复制后自行删改。"}</span>
						</div>
						<pre>{report}</pre>
					</div>
				</div>
				<div className="feedback-actions">
					<button onClick={() => onOpenExternal(authorUrl)}>作者 GitHub</button>
					<button onClick={copyReport}>复制反馈内容</button>
					<button className="primary" onClick={() => onOpenExternal(issueUrl)}>
						打开 GitHub Issue
					</button>
				</div>
			</section>
		</div>
	);
}

function buildFeedbackReport(input: {
	description: string;
	steps: string;
	project?: Project;
	environment: FeedbackEnvironment | null;
	fallbackVersion: string;
	environmentError: string;
}) {
	const pi = input.environment?.pi;
	const projectPath = input.project?.path ? maskHomePath(input.project.path) : "未选择项目";
	// 反馈报告刻意只展示脱敏路径和运行时版本，避免把用户 home 目录、API key 或会话内容默认发出去。
	return [
		"## 问题描述",
		input.description.trim() || "（请描述你遇到的问题）",
		"",
		"## 复现步骤",
		input.steps.trim() || "（请写出尽量稳定的复现步骤）",
		"",
		"## 环境信息",
		`- pi-desktop: ${input.environment?.appVersion ?? input.fallbackVersion}`,
		`- 系统: ${input.environment ? `${input.environment.platform} ${input.environment.arch}` : "读取失败"}`,
		`- Electron: ${input.environment?.electronVersion ?? "-"}`,
		`- Chrome: ${input.environment?.chromeVersion ?? "-"}`,
		`- Node: ${input.environment?.nodeVersion ?? "-"}`,
		`- 当前项目: ${projectPath}`,
		`- pi 检测: ${pi ? (pi.installed ? "已检测到" : "未检测到") : "读取失败"}`,
		`- pi 命令: ${pi?.command ? maskHomePath(pi.command) : "-"}`,
		`- pi 版本: ${pi?.version || "-"}`,
		...(pi?.error ? [`- pi 错误: ${pi.error}`] : []),
		...(input.environmentError ? [`- 环境读取错误: ${input.environmentError}`] : []),
	].join("\n");
}

function maskHomePath(value: string) {
	return value.replace(/([A-Z]:\\Users\\)[^\\/]+/gi, "$1<user>").replace(/(\/Users\/)[^/]+/g, "$1<user>");
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
					<div className="update-notes markdown-body">
						{/* GitHub Release notes 通常是 Markdown；这里复用聊天渲染链路支持标题、列表、链接和代码块。 */}
						<ReactMarkdown remarkPlugins={[remarkGfm]}>
							{props.info.releaseNotes.trim() || "该版本没有填写发布日志。"}
						</ReactMarkdown>
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

