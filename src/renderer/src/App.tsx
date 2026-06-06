import {
	isValidElement,
	useEffect,
	useMemo,
	useRef,
	useState,
	type PointerEvent,
	type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
	Settings,
	Sliders,
	ChevronLeft,
	ChevronRight,
	ChevronDown,
	Search,
	Play,
	Check,
	GitBranch,
	Brain,
} from "lucide-react";
import { createPreviewApi } from "./previewApi";
import { ConfigModal } from "./ConfigModal";
import type {
	AgentRuntimeState,
	AgentTab,
	AppInfo,
	AppSettings,
	AvailableModel,
	ChatMessage,
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

type DrawerPanel = "files" | "sessions";

const api = window.piDesktop ?? createPreviewApi();

export function App() {
	const [projects, setProjects] = useState<Project[]>([]);
	const [agents, setAgents] = useState<AgentTab[]>([]);
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
	/** RPC 日志，用于调试 */
	const [rpcLogs, setRpcLogs] = useState<
		Array<{
			id: string;
			agentId: string;
			direction: string;
			summary: string;
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
	const [toast, setToast] = useState<string | null>(null);
	const [compacting, setCompacting] = useState(false);
	const [drawer, setDrawer] = useState<DrawerPanel | null>(null);
	const [settingsOpen, setSettingsOpen] = useState(false);
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
	});
	const [settingsNotice, setSettingsNotice] = useState("");
	const [piStatus, setPiStatus] = useState<PiInstallStatus | null>(null);
	const [appInfo, setAppInfo] = useState<AppInfo>({
		version: "-",
		releasesUrl: "https://github.com/ayuayue/pi-desktop/releases",
	});
	const [piChecking, setPiChecking] = useState(false);
	const [environmentDialog, setEnvironmentDialog] = useState(false);
	const [listWidth, setListWidth] = useState(260);
	const [drawerWidth, setDrawerWidth] = useState(360);
	const [composerHeight, setComposerHeight] = useState(132);
	const [listCollapsed, setListCollapsed] = useState(false);
	const [drawerCollapsed, setDrawerCollapsed] = useState(false);
	const [expandedDirs, setExpandedDirs] = useState<Set<string>>(new Set());
	const timelineRef = useRef<HTMLElement | null>(null);

	const activeProject = projects.find(
		(project) => project.id === activeProjectId,
	);
	const activeAgent = agents.find((agent) => agent.id === activeAgentId);
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
	const composerMode =
		prompt.startsWith("!!") ? "silent-shell" : prompt.startsWith("!") ? "shell" : null;
	const composerStatusText =
		composerMode === "silent-shell"
			? "静默命令：直接执行，不写入上下文"
			: composerMode === "shell"
				? "Shell 命令：直接执行当前输入"
				: drawer
					? "右侧面板可查看文件或恢复历史会话"
					: (activeAgent?.sessionPath ?? "");
	/** 当前会话中 agent 修改过的文件（从 tool 消息 meta 中提取） */
	const modifiedFiles = useMemo(() => {
		const seen = new Set<string>();
		const result: { path: string; toolName: string; status: string }[] = [];
		for (const msg of activeMessages) {
			if (msg.role !== "tool") continue;
			const toolName: string | undefined = msg.meta?.toolName as
				| string
				| undefined;
			const args: any = msg.meta?.args;
			const status: string = String(msg.meta?.status ?? "done");
			// 只收集文件写入/编辑类的工具调用
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
			if (!filePath || seen.has(filePath)) continue;
			seen.add(filePath);
			result.push({ path: filePath, toolName, status });
		}
		return result;
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
			agents.filter((agent) =>
				matches(agent.title + agent.cwd + (agent.sessionId ?? ""), search),
			),
		[agents, search],
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
			setAgents(nextAgents);
			setActiveAgentId((current) =>
				current && nextAgents.some((agent) => agent.id === current)
					? current
					: undefined,
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
		// 监听 RPC 日志，保留最近 200 条用于调试
		const offRpcLog = api.agents.onRpcLog((payload) =>
			setRpcLogs((current) => [
				...current.slice(-199),
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
		if (activeAgentId) void refreshRuntimeState(activeAgentId);
	}, [activeAgentId]);

	useEffect(() => {
		if (activeProjectId && activeAgentId)
			setActiveAgentByProject((current) => ({
				...current,
				[activeProjectId]: activeAgentId,
			}));
	}, [activeProjectId, activeAgentId]);

	useEffect(() => {
		if (activeAgentId)
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
		for (const agent of agents) {
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
			}
		}
	}, [agents, activeAgentId]);

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
		const rememberedAgent = activeAgentByProject[activeProjectId];
		const fallbackAgent = agents.find(
			(agent) => agent.projectId === activeProjectId,
		)?.id;
		setActiveAgentId(
			rememberedAgent && agents.some((agent) => agent.id === rememberedAgent)
				? rememberedAgent
				: fallbackAgent,
		);

		setExpandedDirs(new Set());
		void api.files
			.list(activeProjectId)
			.then(setFiles)
			.catch((error) => setLogs((current) => [...current, String(error)]));
		void api.git
			.branches(activeProjectId)
			.then(setGitInfo)
			.catch(() => setGitInfo({ current: null, branches: [] }));
		void refreshSessions(activeProjectId);
	}, [activeProjectId, agents.length]);

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

	async function refreshProjects() {
		const next = await api.projects.list();
		setProjects(next);
		if (!activeProjectId && next.length > 0) setActiveProjectId(next[0].id);
	}

	async function refreshSessions(projectId = activeProjectId) {
		const next = await api.sessions.list(projectId);
		setSessions(next);
	}

	async function addProject() {
		const project = await api.projects.add();
		if (!project) return;
		await refreshProjects();
		setActiveProjectId(project.id);
		setActiveAgentId(undefined);
	}

	async function createAgent(
		projectId = activeProjectId,
		sessionPath?: string,
		title?: string,
	) {
		if (!projectId) return;
		const existing = sessionPath
			? agents.find((agent) => agent.sessionPath === sessionPath)
			: undefined;
		if (existing) {
			setActiveAgentId(existing.id);
			setDrawer(null);
			return;
		}
		// 立即关闭抽屉，避免等待 agent 加载期间列表仍然显示
		setDrawer(null);
		try {
			const tab = await api.agents.create({ projectId, sessionPath, title });
			setActiveAgentId(tab.id);
			void refreshRuntimeState(tab.id);
		} catch (e) {
			// 创建失败时由 main process 上报错误，前端仅静默处理
		}
	}

	async function refreshRuntimeState(agentId = activeAgentId) {
		if (!agentId) return;
		const state = await api.agents.runtimeState(agentId).catch(() => undefined);
		if (state)
			setRuntimeStateByAgent((current) => ({ ...current, [agentId]: state }));
	}

	async function cycleModel() {
		if (!activeAgentId) return;
		const state = await api.agents.cycleModel(activeAgentId);
		setRuntimeStateByAgent((current) => ({
			...current,
			[activeAgentId]: state,
		}));
	}

	async function openModelPicker() {
		if (!activeAgentId) return;
		const models = await api.agents.availableModels(activeAgentId);
		setAvailableModels(models);
		setModelPickerOpen(true);
	}

	async function selectModel(model: AvailableModel) {
		if (!activeAgentId) return;
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
		if (!activeAgentId) return;
		const state = await api.agents.cycleThinking(activeAgentId);
		setRuntimeStateByAgent((current) => ({
			...current,
			[activeAgentId]: state,
		}));
	}

	async function compactAgent() {
		if (!activeAgentId) return;
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
		await api.agents.stop(agentId);
	}

	async function abortAgent(agentId = activeAgentId) {
		if (!agentId) return;
		// 用户主动停止时清空排队消息，避免 agent 空闲后自动发送已取消的内容
		clearPendingPrompts();
		await api.agents.abort(agentId);
		void refreshRuntimeState(agentId);
	}

	async function exportAgentHtml(agentId: string) {
		const result = await api.agents.exportHtml(agentId);
		setToast(`已导出：${result.path}`);
		setTimeout(() => setToast(null), 3500);
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
	const isAgentBusy = Boolean(
		activeAgent &&
			(activeAgent.status === "running" || activeRuntimeState?.isStreaming),
	);

	// Agent 从忙碌变为空闲时，自动发送排队中的消息（只发当前 agent 的）
	useEffect(() => {
		if (!isAgentBusy && pendingPrompts.length > 0 && activeAgentId) {
			void flushPendingQueue();
		}
	}, [isAgentBusy, pendingPrompts.length, activeAgentId]);

	async function sendPrompt() {
		if (!activeAgentId || (!prompt.trim() && attachedImages.length === 0))
			return;
		const message = prompt;
		const images = attachedImages.length > 0 ? attachedImages : undefined;
		// 发送前先保留快照，再立即清空 composer；这样普通发送、排队发送和 /codex
		// 都能给用户明确反馈，同时失败时不会影响已捕获的待发送内容。
		setPrompt("");
		setAttachedImages([]);
		setSuggestionsOpen(false);

		// /codex 命令：直接调用 Codex CLI，不走 pi
		if (message.trim().startsWith("/codex")) {
			const codexPrompt = message.replace(/^\/codex\s*/, "").trim();
			if (!codexPrompt) {
				setToast("用法：/codex <问题>");
				setTimeout(() => setToast(null), 3000);
				return;
			}
			const cwd = activeAgent?.cwd ?? "";
			// Codex 通过 --cd 获取工作目录，prompt 里只给简洁指令
			const contextPrompt = [
				"请简洁回答，不要输出工具调用过程。",
				"",
				codexPrompt,
			].join("\n");

			// 插入用户消息
			const userMsg: ChatMessage = {
				id: crypto.randomUUID(),
				agentId: activeAgentId,
				role: "user",
				text: message,
				timestamp: Date.now(),
			};
			setMessagesByAgent((prev) => ({
				...prev,
				[activeAgentId]: [...(prev[activeAgentId] ?? []), userMsg],
			}));

			// 插入加载中占位
			const loadingId = crypto.randomUUID();
			const loadingMsg: ChatMessage = {
				id: loadingId,
				agentId: activeAgentId,
				role: "assistant",
				text: "🤖 Codex 思考中…",
				timestamp: Date.now(),
				meta: { source: "codex", loading: true },
			};
			setMessagesByAgent((prev) => ({
				...prev,
				[activeAgentId]: [
					...(prev[activeAgentId] ?? []),
					loadingMsg,
				],
			}));

			try {
				const result = await api.agents.codexExec(cwd, contextPrompt);
				const responseText = result.error
					? `❌ Codex 错误：${result.error}`
					: result.text || "(Codex 无输出)";

				// 替换加载占位为实际结果
				setMessagesByAgent((prev) => {
					const msgs = [...(prev[activeAgentId] ?? [])];
					const idx = msgs.findIndex((m) => m.id === loadingId);
					if (idx >= 0) {
						msgs[idx] = {
							id: loadingId,
							agentId: activeAgentId,
							role: "assistant",
							text: responseText,
							timestamp: Date.now(),
							meta: { source: "codex" },
						};
					}
					return { ...prev, [activeAgentId]: msgs };
				});
			} catch (e) {
				const errText = `❌ Codex 调用失败：${e instanceof Error ? e.message : String(e)}`;
				setMessagesByAgent((prev) => {
					const msgs = [...(prev[activeAgentId] ?? [])];
					const idx = msgs.findIndex((m) => m.id === loadingId);
					if (idx >= 0) {
						msgs[idx] = {
							id: loadingId,
							agentId: activeAgentId,
							role: "assistant",
							text: errText,
							timestamp: Date.now(),
							meta: { source: "codex" },
						};
					}
					return { ...prev, [activeAgentId]: msgs };
				});
			}
			return;
		}

		// Agent 忙碌时，消息加入本地排队，等 agent 空闲后自动发送。
		// 输入框已在上方清空，避免用户误以为消息还未被接收。
		if (isAgentBusy) {
			const pending: PendingPrompt = {
				id: crypto.randomUUID(),
				agentId: activeAgentId,
				message,
				images,
				enqueuedAt: Date.now(),
			};
			setPendingPrompts((prev) => [...prev, pending]);
			if (message) {
				setMessageHistory((current) => [message.trim(), ...current]);
				historyIndexRef.current = -1;
			}
			return;
		}

		await api.agents.prompt({ agentId: activeAgentId, message, images });
		// 发送成功后记录到历史，供上下键切换复用
		if (message) {
			setMessageHistory((current) => [message.trim(), ...current]);
			historyIndexRef.current = -1;
		}
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
	}

	async function switchBranch(branch: string) {
		if (!activeProjectId || !branch || branch === gitInfo.current) return;
		const next = await api.git.checkout(activeProjectId, branch);
		setGitInfo(next);
	}

	function openDrawer(panel: DrawerPanel) {
		setDrawer((current) => (current === panel ? null : panel));
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
					const next = Math.min(560, Math.max(180, startDrawerWidth - delta));
					setDrawerCollapsed(next <= 190);
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
		const startHeight = composerHeight;
		let frame = 0;

		function onMove(moveEvent: globalThis.PointerEvent) {
			cancelAnimationFrame(frame);
			frame = requestAnimationFrame(() => {
				const maxHeight = Math.max(180, Math.floor(window.innerHeight * 0.42));
				// 拖动的是输入区顶部边线，鼠标向上意味着输入区变高；限制最大高度避免挤压会话阅读区域。
				const next = Math.min(
					maxHeight,
					Math.max(132, startHeight + startY - moveEvent.clientY),
				);
				setComposerHeight(next);
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
						＋
					</button>
				</div>

				<div className="conversation-list">
					{filteredProjects.map((project) => {
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
												agents.find((agent) => agent.projectId === project.id)
													?.id,
										);
									}}
								>
									<span
										className={`project-fold${isCollapsed ? " folded" : ""}${projectAgents.length > 0 ? " has-agents" : ""}`}
										title={isCollapsed ? "展开" : "折叠"}
									>
										<Play size={12} />
									</span>
									<ProjectAvatar name={project.name} />
									<div className="conversation-body">
										<div className="conversation-title">
											<strong>{project.name}</strong>
											<span>项目</span>
										</div>
										<p>{displayPath(project.path)}</p>
									</div>
									<span
										className="conversation-close"
										title="删除目录记录"
										onClick={async (event) => {
											event.stopPropagation();
											const next = await api.projects.remove(project.id);
											setProjects(next);
											if (activeProjectId === project.id) {
												setActiveProjectId(next[0]?.id);
												setActiveAgentId(undefined);
											}
										}}
									>
										×
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
													<span className={agent.status}>{agent.status}</span>
												</div>
												<p>
													{agent.sessionId
														? `session ${agent.sessionId}`
														: displayPath(agent.cwd)}
												</p>
											</div>
											<span
												className="conversation-close"
												onClick={(event) => {
													event.stopPropagation();
													void closeAgent(agent.id);
												}}
											>
												×
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

			<main className="chat-pane">
				<header className="chat-header">
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
									disabled={!activeProjectId}
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
									onClick={() => {
										setDrawerCollapsed(false);
										openDrawer("files");
									}}
								>
									Files
								</button>
								<button
									className={drawer === "sessions" ? "active" : ""}
									onClick={() => {
										setDrawerCollapsed(false);
										openDrawer("sessions");
									}}
								>
									History
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
								item.kind === "tool-group" ? (
									<ToolGroup key={item.id} group={item} />
								) : (
									<ChatBubble
										key={item.message.id}
										message={item.message}
										onPreviewImage={setPreviewImage}
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

				<footer className="composer">
					<div
						className={`composer-box ${
							prompt.startsWith("!!")
								? "shell-silent-mode"
								: prompt.startsWith("!")
									? "shell-mode"
									: ""
						}`}
						style={{ height: composerHeight }}
					>
						<div
							className="composer-resize-handle"
							title="拖动调整输入框高度"
							onPointerDown={startComposerResize}
						/>
						<ComposerToolbar
							state={activeRuntimeState}
							compacting={compacting}
							disabled={isAgentBusy}
							onCycleModel={cycleModel}
							onPickModel={openModelPicker}
							onCycleThinking={cycleThinking}
							onCompact={compactAgent}
						/>
						<textarea
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
							placeholder={
								prompt.startsWith("!!")
									? "!!命令 — 直接执行，不写入上下文"
									: prompt.startsWith("!")
										? "!命令 — 直接执行 shell 命令"
										: settings.sendShortcut === "enter-send"
											? "输入消息，Enter 发送。/ 命令，@ 文件，! shell"
											: "输入消息，按设置的快捷键发送。/ 命令，@ 文件，! shell"
							}
						/>
						{suggestionsOpen && (
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
					<button
						className="collapse-button drawer-collapse"
						title="折叠面板"
						onClick={() => setDrawerCollapsed(true)}
					>
						<ChevronRight size={16} />
					</button>
					<DrawerContent
						panel={drawer}
						files={files}
						sessions={sessions}
						modifiedFiles={modifiedFiles}
						expandedDirs={expandedDirs}
						onToggleDirectory={toggleDirectory}
						onClose={() => setDrawer(null)}
						onFileContextMenu={(node, x, y) => setFileMenu({ node, x, y })}
						onRefreshSessions={() => refreshSessions()}
						onOpenSession={(session) =>
							createAgent(
								activeProjectId,
								session.filePath,
								session.name || "历史会话",
							)
						}
						onRenameSession={async (filePath, newName) => {
							await api.sessions.rename(filePath, newName);
							await refreshSessions();
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
					{drawer === "files" ? "文件" : "历史"}
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
					appInfo={appInfo}
					onCheckPi={() => checkPiInstall("manual")}
					onCheckUpdate={() => api.app.openExternal(appInfo.releasesUrl)}
					onClose={() => setSettingsOpen(false)}
					onChange={updateSettings}
				/>
			)}
			{previewImage && (
				<ImagePreviewModal
					image={previewImage}
					onClose={() => setPreviewImage(null)}
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

function EnvironmentDialog(props: {
	status: PiInstallStatus | null;
	checking: boolean;
	onClose: () => void;
	onRecheck: () => void;
}) {
	const installed = props.status?.installed;
	const searchedDirs = props.status?.searchedDirs.slice(0, 16) ?? [];
	return (
		<div className="modal-backdrop environment-backdrop">
			<section className="environment-modal">
				<div className="modal-header">
					<strong>pi 环境检测</strong>
					<button onClick={props.onClose}>×</button>
				</div>
				<div className="environment-body">
					{props.checking ? (
						<div className="check-row">
							<div className="loader" />
							<span>正在检测 pi CLI…</span>
						</div>
					) : installed ? (
						<div className="env-success">
							<strong>检测通过</strong>
							<span>
								已找到 {props.status?.command}{" "}
								{props.status?.version ? `(${props.status.version})` : ""}
							</span>
							<small>窗口将在 3 秒后自动关闭。</small>
						</div>
					) : (
						<>
							<p className="lead">
								没有检测到可用的 <strong>pi</strong>{" "}
								命令。你仍可浏览项目，但创建 agent 前需要先安装并配置 pi CLI。
							</p>
							<div className="setup-steps">
								<div>
									<strong>打开官方安装指引</strong>
									<span>请按 pi 官方 quickstart 安装并配置 CLI。</span>
									<button
										onClick={() =>
											api.app.openExternal(
												"https://pi.dev/docs/latest/quickstart#install",
											)
										}
									>
										打开安装文档
									</button>
								</div>
								<div>
									<strong>配置后重新检测</strong>
									<span>安装完成后重新打开应用，或点击下方“重新检测”。</span>
								</div>
							</div>
							{props.status?.error && (
								<pre className="onboarding-error">{props.status.error}</pre>
							)}
						</>
					)}
				</div>
				<div className="environment-footer">
					<button onClick={props.onRecheck} disabled={props.checking}>
						重新检测
					</button>
				</div>
				<div className="searched-paths">
					<strong>检测路径</strong>
					{searchedDirs.length > 0 ? (
						<ul>
							{searchedDirs.map((dir) => (
								<li key={dir}>{dir}</li>
							))}
						</ul>
					) : (
						<span>检测完成后显示已搜索路径。</span>
					)}
				</div>
			</section>
		</div>
	);
}

function SessionStatus(props: {
	state?: AgentRuntimeState;
	duration?: number;
}) {
	if (!props.state) return null;
	return (
		<div className="session-status">
			<span className="model-chip">
				{props.state.provider ? `${props.state.provider}/` : ""}{props.state.modelName ?? props.state.modelId ?? "model"}
			</span>
			<span>think: {props.state.thinkingLevel ?? "-"}</span>
			{props.duration != null && (
				<span title="本次会话耗时">⏱ {formatDuration(props.duration)}</span>
			)}
			{props.state.contextPercent != null && (
				<span>
					ctx:{" "}
					{props.state.contextPercent?.toFixed?.(1) ??
						props.state.contextPercent}
					% / {formatCompact(props.state.contextWindow)}
				</span>
			)}
			{props.state.cacheTotal != null && (
				<span>cache: {formatCompact(props.state.cacheTotal)}</span>
			)}
		</div>
	);
}

function ComposerToolbar(props: {
	state?: AgentRuntimeState;
	compacting: boolean;
	disabled?: boolean;
	onCycleModel: () => void;
	onPickModel: () => void;
	onCycleThinking: () => void;
	onCompact: () => void;
}) {
	const ctxPercent = props.state?.contextPercent;
	const showCompact = ctxPercent != null && ctxPercent > 30;
	return (
		<div className="composer-toolbar">
			<button onClick={props.onPickModel} disabled={props.disabled}>
				Model: {props.state?.provider ? `${props.state.provider}/` : ""}{props.state?.modelName ?? "-"}
			</button>
			<button onClick={props.onCycleModel} disabled={props.disabled}>
				Cycle Model
			</button>
			<button onClick={props.onCycleThinking} disabled={props.disabled}>
				Think: {props.state?.thinkingLevel ?? "-"}
			</button>
			{showCompact && (
				<button
					className={
						props.state?.isCompacting || props.compacting ? "compacting" : ""
					}
					disabled={
						props.state?.isCompacting ||
						props.compacting ||
						!!props.state?.isStreaming
					}
					title={`上下文: ${ctxPercent.toFixed(1)}% — 点击压缩上下文释放空间`}
					onClick={props.onCompact}
				>
					{props.state?.isCompacting || props.compacting
						? "压缩中…"
						: `Compact ${ctxPercent.toFixed(0)}%`}
				</button>
			)}
		</div>
	);
}

function ModelPicker(props: {
	models: AvailableModel[];
	onClose: () => void;
	onPick: (model: AvailableModel) => void;
}) {
	return (
		<div className="modal-backdrop" onClick={props.onClose}>
			<div
				className="model-picker"
				onClick={(event) => event.stopPropagation()}
			>
				<div className="modal-header">
					<strong>选择模型</strong>
					<button onClick={props.onClose}>×</button>
				</div>
				<div className="model-list">
					{props.models.map((model) => (
						<button
							key={`${model.provider}/${model.id}`}
							onClick={() => props.onPick(model)}
						>
							<strong>{model.name ?? model.id}</strong>
							<span>
								{model.provider}/{model.id}
							</span>
						</button>
					))}
				</div>
			</div>
		</div>
	);
}

function formatCompact(value?: number | null) {
	if (value == null) return "-";
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
	return String(value);
}

function BranchSelector(props: {
	gitInfo: GitBranchInfo;
	onSwitch: (branch: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement>(null);

	// 点击外部区域自动关闭下拉
	useEffect(() => {
		if (!open) return;
		const handler = (event: MouseEvent) => {
			if (ref.current && !ref.current.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, [open]);

	const current = props.gitInfo.current ?? "";
	const branches = props.gitInfo.branches;

	// 无分支信息时不渲染
	if (!current && branches.length === 0) return null;

	return (
		<div className="branch-select" ref={ref}>
			<button
				className="branch-trigger"
				onClick={() => setOpen((v) => !v)}
				title={`当前分支: ${current}，共 ${branches.length} 个分支`}
			>
				<span className="branch-icon">
					<GitBranch size={14} />
				</span>
				<span className="branch-label" title={current}>
					{current || "detached"}
				</span>
				<span className="branch-badge">{branches.length}</span>
				<span className={`branch-chevron${open ? " open" : ""}`}>
					<ChevronDown size={12} />
				</span>
			</button>
			{open && (
				<div className="branch-dropdown">
					{branches.length <= 1 && (
						<div className="branch-empty-hint">仅此一个分支</div>
					)}
					{branches.map((branch) => (
						<button
							key={branch}
							className={branch === current ? "active" : ""}
							onClick={() => {
								if (branch !== current) props.onSwitch(branch);
								setOpen(false);
							}}
						>
							<span className="branch-item-icon">
								{branch === current ? (
									<Check size={14} className="branch-check" />
								) : (
									<GitBranch size={14} />
								)}
							</span>
							<span className="branch-item-label" title={branch}>
								{branch}
							</span>
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function LogoMark() {
	return (
		<div className="logo-mark" aria-label="pi desktop logo">
			<svg viewBox="140 140 520 520" width="22" height="22" aria-hidden="true">
				<path
					fill="#fff"
					fillRule="evenodd"
					d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
				/>
				<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
			</svg>
		</div>
	);
}

function ProjectAvatar(props: { name: string }) {
	// 项目名以 . 开头时，首字符头像会只显示一个点；跳过前导点/空白，保证隐藏目录也能显示可识别的业务名称首字母。
	const avatarText =
		props.name
			.replace(/^[.\s]+/, "")
			.slice(0, 1)
			.toUpperCase() || "π";
	return (
		<div className="conversation-avatar project-avatar">
			<span>{avatarText}</span>
		</div>
	);
}

function AgentAvatar(props: { status: string }) {
	return (
		<div className={`conversation-avatar agent-avatar ${props.status}`}>
			<svg viewBox="140 140 520 520" width="28" height="28" aria-hidden="true">
				<path
					fill="#fff"
					fillRule="evenodd"
					d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
				/>
				<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
			</svg>
		</div>
	);
}

function matches(value: string, keyword: string) {
	return (
		!keyword.trim() ||
		value.toLowerCase().includes(keyword.trim().toLowerCase())
	);
}

function displayPath(path?: string) {
	if (!path) return "";
	const home = getHomePathPrefix();
	const normalized = path.replace(/\\/g, "/");
	const friendly =
		home && normalized.toLowerCase().startsWith(home.toLowerCase())
			? `~${normalized.slice(home.length)}`
			: normalized;
	return friendly.length > 36 ? `…${friendly.slice(-35)}` : friendly;
}

function getHomePathPrefix() {
	// 浏览器侧无法直接读取 OS home；从常见 Windows 用户路径中提取到 /Users/name，其他路径保持原样。
	const match = location.href.match(/file:\/\/\/([A-Za-z]:\/Users\/[^/]+)/i);
	return match?.[1] ?? "C:/Users/14012";
}

function EmptyState(props: { hasProject: boolean; onCreate: () => void }) {
	return (
		<div className="empty-state">
			<div className="empty-logo">
				<svg
					viewBox="140 140 520 520"
					width="40"
					height="40"
					aria-hidden="true"
				>
					<path
						fill="#fff"
						fillRule="evenodd"
						d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
					/>
					<path fill="#fff" d="M517.36 400H634.72V634.72H517.36Z" />
				</svg>
			</div>
			<h2>开始一个 pi agent</h2>
			<p>
				{props.hasProject
					? "创建 agent 后即可开始对话。"
					: "先从左侧添加项目目录。"}
			</p>
			{props.hasProject && (
				<button onClick={props.onCreate}>Create Agent</button>
			)}
		</div>
	);
}

type ToolGroupItem = {
	kind: "tool-group";
	id: string;
	messages: ChatMessage[];
};

type RenderMessage = { kind: "message"; message: ChatMessage } | ToolGroupItem;

function groupToolMessages(messages: ChatMessage[]): RenderMessage[] {
	const result: RenderMessage[] = [];
	let current: ChatMessage[] = [];

	function flush() {
		if (current.length === 0) return;
		// 同一轮问答里的连续 tool 消息聚合显示，减少工具调用刷屏；详情仍保留在每条 tool 的 meta 里可展开查看。
		result.push({
			kind: "tool-group",
			id: current.map((message) => message.id).join("|"),
			messages: current,
		});
		current = [];
	}

	for (const message of messages) {
		if (message.role === "tool") current.push(message);
		else {
			flush();
			result.push({ kind: "message", message });
		}
	}
	flush();
	return result;
}

function ThinkingBubble(props: { thinking?: string; showThinking?: boolean }) {
	const hasThinking =
		props.showThinking && props.thinking && props.thinking.length > 0;
	const [expanded, setExpanded] = useState(false);
	const previewLen = 200;
	const needsTruncate = (props.thinking?.length ?? 0) > previewLen;
	const displayText =
		expanded || !needsTruncate
			? (props.thinking ?? "")
			: (props.thinking ?? "").slice(0, previewLen) + "…";

	return (
		<article className="chat-message assistant thinking-message">
			<div className="msg-avatar">P</div>
			<div className="msg-content">
				<div className="msg-name">
					<span>pi</span>
					<time>{hasThinking ? "思考中" : "正在响应"}</time>
				</div>
				{hasThinking && (
					<div className="thinking-block streaming">
						<div className="thinking-header">
							<Brain size={14} />
							<span>思考过程</span>
						</div>
						<div className="thinking-content">{displayText}</div>
						{needsTruncate && (
							<button
								className="thinking-toggle"
								onClick={() => setExpanded((v) => !v)}
							>
								{expanded ? "收起" : "展开全部"}
							</button>
						)}
					</div>
				)}
				{!hasThinking && (
					<div className="msg-bubble typing-bubble">
						<span /> <span /> <span />
					</div>
				)}
			</div>
		</article>
	);
}

function PendingBubble(props: {
	pending: PendingPrompt;
	onCancel: () => void;
}) {
	const { pending } = props;
	const cleanText = stripAnsi(pending.message);
	return (
		<article className="chat-message mine pending-message">
			<div className="msg-avatar">我</div>
			<div className="msg-content">
				<div className="msg-name">
					<span>我</span>
					<time>
						<span className="pending-indicator" />
						排队中
					</time>
				</div>
				<div className="msg-bubble">
					{pending.images && pending.images.length > 0 && (
						<div className="message-images">
							{pending.images.map((img, index) => (
								<img
									key={index}
									src={`data:${img.mimeType};base64,${img.data}`}
									alt={`图片 ${index + 1}`}
									className="message-image"
								/>
							))}
						</div>
					)}
					<div className="user-message-text">{cleanText}</div>
				</div>
				<div className="msg-actions">
					<button onClick={props.onCancel}>取消排队</button>
				</div>
			</div>
		</article>
	);
}

function ToolGroup(props: { group: ToolGroupItem }) {
	const [expanded, setExpanded] = useState(false);
	const visible = expanded
		? props.group.messages
		: props.group.messages.slice(0, 3);
	// 工具启动消息永远保留 status "running"，所以需要检查最后一条消息的状态来判断是否还在执行中
	const running =
		props.group.messages.length > 0 &&
		props.group.messages[props.group.messages.length - 1].meta?.status ===
			"running";
	const failed = props.group.messages.some(
		(message) =>
			message.meta?.status === "error" || message.meta?.isError === true,
	);
	return (
		<article className="tool-group" data-message-id={props.group.id}>
			<button
				className="tool-group-header"
				onClick={() => setExpanded((value) => !value)}
			>
				<span>
					{running ? "工具调用中" : failed ? "工具调用有错误" : "工具调用"}
				</span>
				<strong>{props.group.messages.length} 条</strong>
				<em>{expanded ? "收起" : "展开"}</em>
			</button>
			<div className="tool-group-list">
				{visible.map((message) => (
					<ToolSummary key={message.id} message={message} />
				))}
				{!expanded && props.group.messages.length > visible.length && (
					<div className="tool-more">
						还有 {props.group.messages.length - visible.length}{" "}
						条工具调用，点击展开查看
					</div>
				)}
			</div>
		</article>
	);
}

function ToolSummary(props: { message: ChatMessage }) {
	const [expanded, setExpanded] = useState(false);
	const detailText =
		typeof props.message.meta?.detailText === "string"
			? props.message.meta.detailText
			: JSON.stringify(props.message.meta ?? {}, null, 2);
	return (
		<div className={`tool-summary ${String(props.message.meta?.status ?? "")}`}>
			<div>
				<strong>{props.message.text}</strong>
				<small>{formatTime(props.message.timestamp)}</small>
			</div>
			<button onClick={() => setExpanded((value) => !value)}>
				{expanded ? "收起" : "详情"}
			</button>
			{expanded && <pre className="tool-detail">{detailText}</pre>}
		</div>
	);
}

function ImagePreviewModal(props: {
	image: ImageContent;
	onClose: () => void;
}) {
	return (
		<div className="image-preview-modal" onClick={props.onClose}>
			<button className="image-preview-close" onClick={props.onClose}>
				×
			</button>
			<img
				src={`data:${props.image.mimeType};base64,${props.image.data}`}
				alt="图片预览"
				onClick={(event) => event.stopPropagation()}
			/>
		</div>
	);
}

// ANSI 转义码正则：匹配 \x1b[...m 等终端颜色/样式序列
const ANSI_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

/** 去除 pi 输出中的 ANSI 终端转义码，避免在 React UI 中显示原始 \e[38;5;109m 等文本 */
function stripAnsi(text: string): string {
	return text.replace(ANSI_RE, "");
}

function ChatBubble(props: {
	message: ChatMessage;
	onPreviewImage: (image: ImageContent) => void;
	showThinking?: boolean;
}) {
	const { message } = props;
	const [expanded, setExpanded] = useState(false);
	const isUser = message.role === "user";
	const isTool = message.role === "tool";
	const isAssistant = message.role === "assistant";
	const hasThinking =
		isAssistant &&
		props.showThinking &&
		message.thinking &&
		message.thinking.length > 0;
	const [thinkingExpanded, setThinkingExpanded] = useState(false);
	const thinkingPreviewLen = 200;
	const thinkingNeedsTruncate =
		(message.thinking?.length ?? 0) > thinkingPreviewLen;
	const thinkingDisplayText =
		thinkingExpanded || !thinkingNeedsTruncate
			? (message.thinking ?? "")
			: (message.thinking ?? "").slice(0, thinkingPreviewLen) + "…";
	const label = message.role === "assistant" ? "pi" : message.role;
	const detailText =
		typeof message.meta?.detailText === "string"
			? message.meta.detailText
			: JSON.stringify(message.meta ?? {}, null, 2);
	// 过滤 ANSI 转义码，pi 终端输出的颜色序列在桌面 UI 中无意义
	const cleanText = stripAnsi(message.text);
	const cleanDetail = stripAnsi(detailText);
	return (
		<article
			data-message-id={message.id}
			className={isUser ? "chat-message mine" : `chat-message ${message.role}`}
		>
			<div className="msg-avatar">
				{isUser ? "我" : label.slice(0, 1).toUpperCase()}
			</div>
			<div className="msg-content">
				<div className="msg-name">
					<span>{label}</span>
					<time>{formatTime(message.timestamp)}</time>
				</div>
				<div className={`msg-bubble ${isUser ? "" : "markdown-body"}`}>
					{/* 思考内容展示：可折叠，默认收起长文本 */}
					{hasThinking && (
						<div className="thinking-block">
							<div
								className="thinking-header"
								onClick={() => setThinkingExpanded((v) => !v)}
							>
								<Brain size={14} />
								<span>思考过程</span>
								<em>{thinkingExpanded ? "收起" : "展开"}</em>
							</div>
							{thinkingExpanded && (
								<div className="thinking-content">{thinkingDisplayText}</div>
							)}
						</div>
					)}
					{/* 显示消息中附加的图片 */}
					{message.images && message.images.length > 0 && (
						<div className="message-images">
							{message.images.map((img, index) => (
								<img
									key={index}
									src={`data:${img.mimeType};base64,${img.data}`}
									alt={`图片 ${index + 1}`}
									className="message-image"
									onClick={() => props.onPreviewImage(img)}
								/>
							))}
						</div>
					)}
					{/* 用户消息使用纯文本显示，避免特殊字符被 markdown 解释导致渲染异常 */}
					{isUser ? (
						<div className="user-message-text">{cleanText}</div>
					) : (
						<ReactMarkdown
							remarkPlugins={[remarkGfm]}
							components={{ pre: CodeBlock, a: MarkdownLink }}
						>
							{cleanText}
						</ReactMarkdown>
					)}
					{expanded && <pre className="tool-detail">{cleanDetail}</pre>}
				</div>
				<div className="msg-actions">
					<button
						onClick={() =>
							navigator.clipboard.writeText(
								expanded && isTool ? cleanDetail : cleanText,
							)
						}
					>
						复制
					</button>
					{isTool && (
						<button onClick={() => setExpanded((value) => !value)}>
							{expanded ? "收起详情" : "查看详情"}
						</button>
					)}
					{isUser && (
						<button
							onClick={() => {
								const text = message.text;
								// 通过 InputEvent 设置输入框内容，复用 composer 现有的编辑流程
								document
									.querySelector<HTMLTextAreaElement>(".composer-box textarea")
									?.focus();
								// 触发自定义事件让 App 层处理编辑
								window.dispatchEvent(
									new CustomEvent("user-message-edit", {
										detail: { text },
									}),
								);
							}}
						>
							编辑
						</button>
					)}
				</div>
			</div>
		</article>
	);
}

function CodeBlock(props: React.HTMLAttributes<HTMLPreElement>) {
	const text = extractText(props.children);
	return (
		<div className="code-block-wrap">
			<button
				className="code-copy"
				onClick={() => navigator.clipboard.writeText(text)}
			>
				复制代码
			</button>
			<pre {...props}>{props.children}</pre>
		</div>
	);
}

/** Markdown 内的链接默认会在 Electron 窗口内导航，这里拦截点击统一用系统浏览器打开。 */
function MarkdownLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
	const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
		e.preventDefault();
		if (props.href) void api.app.openExternal(props.href);
	};
	return <a {...props} onClick={handleClick} />;
}

function extractText(node: ReactNode): string {
	if (typeof node === "string" || typeof node === "number") return String(node);
	if (Array.isArray(node)) return node.map(extractText).join("");
	if (isValidElement<{ children?: ReactNode }>(node))
		return extractText(node.props.children);
	return "";
}

/** 将毫秒数格式化为短可读形式，如 "3.2s" "1m23s" */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}.${Math.floor((ms % 1000) / 100)}s`;
	const minutes = Math.floor(seconds / 60);
	const remaining = seconds % 60;
	return remaining > 0 ? `${minutes}m${remaining}s` : `${minutes}m`;
}

function formatTime(timestamp: number) {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
	});
}

function buildOutline(messages: ChatMessage[]) {
	return messages
		.filter(
			(message) => message.role === "user" || message.role === "assistant",
		)
		.map((message) => ({
			id: message.id,
			role: message.role,
			title: summarizeMessage(message.text),
			time: formatTime(message.timestamp),
		}))
		.filter((item) => item.title);
}

function summarizeMessage(text: string) {
	// 过滤 ANSI 转义码，避免 outline 标题显示乱码
	const cleaned = text.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
	const firstLine =
		cleaned
			.replace(/```[\s\S]*?```/g, " ")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return firstLine.length > 48 ? `${firstLine.slice(0, 48)}…` : firstLine;
}

function RpcLogModal(props: {
	logs: Array<{
		id: string;
		agentId: string;
		direction: string;
		summary: string;
		time: number;
		data?: unknown;
	}>;
	onClose: () => void;
}) {
	const panelRef = useRef<HTMLDivElement>(null);
	const [expandedId, setExpandedId] = useState<string | null>(null);
	const visibleLogs = props.logs.slice(-200);

	useEffect(() => {
		const el = panelRef.current;
		if (el) el.scrollTop = el.scrollHeight;
	}, [props.logs.length]);

	return (
		<div className="modal-backdrop" onClick={props.onClose}>
			<div className="rpc-log-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<strong>RPC 日志 · {props.logs.length} 条</strong>
					<div className="modal-header-actions">
						<button onClick={props.onClose}>×</button>
					</div>
				</div>
				<div className="rpc-log-list" ref={panelRef}>
					{visibleLogs.map((log) => (
						<div key={log.id} className="rpc-log-entry-wrap">
							<div
								className={`rpc-log-entry ${log.direction === "send" ? "log-send" : "log-recv"}`}
								onClick={() =>
									setExpandedId(expandedId === log.id ? null : log.id)
								}
							>
								<time>
									{new Date(log.time).toLocaleTimeString(undefined, {
										hour: "2-digit",
										minute: "2-digit",
										second: "2-digit",
									})}
								</time>
								<span className="log-direction">
									{log.direction === "send" ? "→" : "←"}
								</span>
								<span className="log-summary">{log.summary}</span>
							</div>
							{expandedId === log.id && log.data != null && (
								<pre className="rpc-log-detail">
									{JSON.stringify(log.data, null, 2)}
								</pre>
							)}
						</div>
					))}
					{visibleLogs.length === 0 && (
						<div className="rpc-log-empty">
							暂无日志，发送消息后会记录 RPC 通信
						</div>
					)}
				</div>
			</div>
		</div>
	);
}

function ConversationOutline(props: {
	items: Array<{ id: string; role: string; title: string; time: string }>;
	onJump: (id: string) => void;
}) {
	const [expanded, setExpanded] = useState(false);
	const visibleItems = expanded ? props.items : props.items.slice(-15);
	const hasMore = props.items.length > 15;
	return (
		<div className="outline-hover">
			<button
				className="outline-trigger"
				title={`会话定位 · ${props.items.length} 条`}
			>
				☰
			</button>
			<nav className="conversation-outline">
				<div className="outline-title">
					会话定位
					<span className="outline-count">{props.items.length}</span>
				</div>
				<div className="outline-list">
					{hasMore && !expanded && (
						<button
							className="outline-expand"
							onClick={() => setExpanded(true)}
						>
							显示全部 {props.items.length} 条
						</button>
					)}
					{visibleItems.map((item) => (
						<button
							key={item.id}
							className={
								item.role === "user" ? "outline-user" : "outline-assistant"
							}
							onClick={() => props.onJump(item.id)}
						>
							<strong>{item.title}</strong>
							<span>{item.time}</span>
						</button>
					))}
				</div>
			</nav>
		</div>
	);
}

function DrawerContent(props: {
	panel: DrawerPanel;
	files: FileTreeNode[];
	sessions: SessionSummary[];
	modifiedFiles: { path: string; toolName: string; status: string }[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onClose: () => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshSessions: () => void;
	onOpenSession: (session: SessionSummary) => void;
	onRenameSession: (filePath: string, newName: string) => void;
}) {
	const title = props.panel === "files" ? "文件" : "历史会话";
	return (
		<>
			<div className="drawer-header">
				<strong>{title}</strong>
				<button onClick={props.onClose}>×</button>
			</div>
			{props.panel === "files" && (
				<FilesPanel
					files={props.files}
					modifiedFiles={props.modifiedFiles}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onFileContextMenu={props.onFileContextMenu}
				/>
			)}
			{props.panel === "sessions" && (
				<SessionsPanel
					sessions={props.sessions}
					onRefresh={props.onRefreshSessions}
					onOpen={props.onOpenSession}
					onRename={props.onRenameSession}
				/>
			)}
		</>
	);
}

function FilesPanel(props: {
	files: FileTreeNode[];
	/** 当前会话中 agent 修改过的文件 */
	modifiedFiles: { path: string; toolName: string; status: string }[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
}) {
	return (
		<div className="files-panel">
			{props.modifiedFiles.length > 0 && (
				<div className="modified-files-section">
					<div className="modified-files-header">本次会话修改</div>
					{props.modifiedFiles.map((file) => {
						const fileName = file.path.split(/[/\\]/).pop() ?? file.path;
						const isRunning = file.status === "running";
						// 构造最小的 FileTreeNode 以复用右键菜单
						const fakeNode: FileTreeNode = {
							name: fileName,
							path: file.path,
							relativePath: file.path,
							type: "file",
						};
						return (
							<div
								key={file.path}
								className={`modified-file-row${isRunning ? " running" : ""}`}
								title={file.path}
								onContextMenu={(e) => {
									e.preventDefault();
									props.onFileContextMenu(fakeNode, e.clientX, e.clientY);
								}}
							>
								<span
									className={`modified-file-icon${isRunning ? "" : " done"}`}
								>
									{isRunning ? "◌" : "✓"}
								</span>
								<span className="modified-file-name">{fileName}</span>
								<span className="modified-file-tool">{file.toolName}</span>
							</div>
						);
					})}
				</div>
			)}
			{props.files.map((node) => (
				<FileNode
					key={node.path}
					node={node}
					expandedDirs={props.expandedDirs}
					onToggleDirectory={props.onToggleDirectory}
					onFileContextMenu={props.onFileContextMenu}
				/>
			))}
		</div>
	);
}

function FileNode(props: {
	node: FileTreeNode;
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
}) {
	const { node, expandedDirs, onToggleDirectory } = props;
	const expanded = expandedDirs.has(node.path);
	const menu = (event: React.MouseEvent) => {
		event.preventDefault();
		props.onFileContextMenu(node, event.clientX, event.clientY);
	};
	if (node.type === "file")
		return (
			<div className="file-node">
				<button className="file" title={node.relativePath} onContextMenu={menu}>
					<span>{fileIcon(node.name)}</span>
					{node.name}
				</button>
			</div>
		);
	return (
		<div className="file-node">
			<button
				className="directory"
				onClick={() => onToggleDirectory(node.path)}
				onContextMenu={menu}
				title={node.relativePath}
			>
				<span>
					{expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
				</span>
				{node.name}
			</button>
			{expanded && node.children && node.children.length > 0 && (
				<div className="file-children">
					{node.children.map((child) => (
						<FileNode
							key={child.path}
							node={child}
							expandedDirs={expandedDirs}
							onToggleDirectory={onToggleDirectory}
							onFileContextMenu={props.onFileContextMenu}
						/>
					))}
				</div>
			)}
		</div>
	);
}

function fileIcon(name: string) {
	if (/\.(ts|tsx|js|jsx)$/.test(name)) return "◇";
	if (/\.(md|mdx)$/.test(name)) return "M";
	if (/\.(json|yaml|yml)$/.test(name)) return "{}";
	return "·";
}

function SessionsPanel(props: {
	sessions: SessionSummary[];
	onRefresh: () => void;
	onOpen: (session: SessionSummary) => void;
	onRename: (filePath: string, newName: string) => void;
}) {
	const [renamingPath, setRenamingPath] = useState<string | null>(null);
	const [editValue, setEditValue] = useState("");
	const inputRef = useRef<HTMLInputElement>(null);

	function startRename(session: SessionSummary) {
		setRenamingPath(session.filePath);
		setEditValue(session.name || "");
		requestAnimationFrame(() => inputRef.current?.focus());
	}

	function confirmRename() {
		if (renamingPath && editValue.trim()) {
			props.onRename(renamingPath, editValue.trim());
		}
		setRenamingPath(null);
		setEditValue("");
	}

	return (
		<div className="sessions-panel">
			<div className="panel-action-row">
				<span>{props.sessions.length} sessions</span>
				<button onClick={props.onRefresh}>刷新</button>
			</div>
			{props.sessions.map((session) => (
				<div
					key={session.filePath}
					className="session-card"
					onContextMenu={(e) => {
						e.preventDefault();
						startRename(session);
					}}
				>
					{renamingPath === session.filePath ? (
						<div className="session-rename-row">
							<input
								ref={inputRef}
								value={editValue}
								onChange={(e) => setEditValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") confirmRename();
									if (e.key === "Escape") {
										setRenamingPath(null);
										setEditValue("");
									}
								}}
								onBlur={confirmRename}
								autoFocus
							/>
						</div>
					) : (
						<button
							className="session-card-inner"
							onClick={() => props.onOpen(session)}
							title={`${session.filePath} — 右键重命名`}
						>
							<strong>{session.name || "Untitled"}</strong>
							<small>
								{new Date(session.updatedAt).toLocaleString()} ·{" "}
								{session.messageCount} messages
							</small>
							<p>{session.preview}</p>
						</button>
					)}
				</div>
			))}
		</div>
	);
}

function flattenFiles(nodes: FileTreeNode[]): FileTreeNode[] {
	return nodes.flatMap((node) =>
		node.type === "file" ? [node] : flattenFiles(node.children ?? []),
	);
}

function applySuggestion(current: string, value: string) {
	const index = findTriggerIndex(current);
	if (index === -1) return `${current}${value} `;
	return `${current.slice(0, index)}${value} `;
}

function clearSuggestionTrigger(current: string) {
	const index = findTriggerIndex(current);
	if (index === -1) return current;
	return current.slice(0, index);
}

function findTriggerIndex(current: string) {
	const lastSlash = current.lastIndexOf("/");
	const lastAt = current.lastIndexOf("@");
	return Math.max(lastSlash, lastAt);
}

type SuggestionItem = {
	key: string;
	label: string;
	description: string;
	value: string;
};

function buildSuggestionItems(
	prompt: string,
	commands: PiCommand[],
	files: FileTreeNode[],
): SuggestionItem[] {
	const allCommands = mergeCommands(commands);
	const tail = prompt.split(/\s/).at(-1) ?? "";
	if (tail.startsWith("/")) {
		const keyword = tail.slice(1).toLowerCase();
		return allCommands
			.map((command, index) => ({ command, index }))
			.filter(({ command }) => command.name.toLowerCase().includes(keyword))
			.sort((a, b) => {
				const aPinned = PINNED_COMMAND_NAMES.has(a.command.name);
				const bPinned = PINNED_COMMAND_NAMES.has(b.command.name);
				if (aPinned !== bPinned) return aPinned ? -1 : 1;
				return a.index - b.index;
			})
			.map(({ command }) => ({
				key: command.name,
				label: `/${command.name}`,
				description: command.description ?? "",
				value: `/${command.name}`,
			}));
	}
	if (tail.startsWith("@")) {
		const keyword = tail.slice(1).toLowerCase();
		return files
			.map((file) => ({
				file,
				score:
					fuzzyScore(file.relativePath, keyword) +
					fuzzyScore(file.name, keyword) * 2,
			}))
			.filter((item) => item.score > 0 || !keyword)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((item) => ({
				key: item.file.path,
				label: `@${item.file.name}`,
				description: item.file.relativePath,
				value: `@${item.file.relativePath}`,
			}));
	}
	return [];
}

function mergeCommands(commands: PiCommand[]) {
	const visibleCommands = commands.filter(isVisibleDesktopCommand);
	const names = new Set(visibleCommands.map((command) => command.name));
	const extras = BUILTIN_COMMANDS.filter(
		(command) => !names.has(command.name) && isVisibleDesktopCommand(command),
	);
	return [...visibleCommands, ...extras];
}

const PINNED_COMMAND_NAMES = new Set(["codex"]);
const HIDDEN_DESKTOP_COMMAND_NAMES = new Set([
	"new",
	"model",
	"resume",
	"fork",
	"name",
]);

function isVisibleDesktopCommand(command: PiCommand) {
	return !HIDDEN_DESKTOP_COMMAND_NAMES.has(command.name.toLowerCase());
}

// pi 内置斜杠命令，get_commands 只返回扩展注册的命令，这些需要手动补充
// desktop 已有独立 UI 入口或在 desktop 中不适合执行的命令由 HIDDEN_DESKTOP_COMMAND_NAMES 统一过滤。
const BUILTIN_COMMANDS: PiCommand[] = [
	{
		name: "session",
		description: "显示会话文件、ID、消息数、token 和费用",
		source: "builtin",
	},
	{
		name: "tree",
		description: "会话树导航，跳转到任意节点",
		source: "builtin",
	},
	{ name: "clone", description: "复制当前分支到新会话", source: "builtin" },
	{
		name: "compact",
		description: "压缩上下文，可选自定义提示词",
		source: "builtin",
	},
	{ name: "copy", description: "复制最后一条回复到剪贴板", source: "builtin" },
	{ name: "export", description: "导出会话为 HTML 文件", source: "builtin" },
	{
		name: "share",
		description: "上传为 GitHub Gist 私密链接",
		source: "builtin",
	},
	{ name: "settings", description: "打开 pi 设置", source: "builtin" },
	{ name: "reload", description: "重载扩展、技能和配置", source: "builtin" },
	{ name: "hotkeys", description: "显示所有快捷键", source: "builtin" },
	{
		name: "login",
		description: "管理 OAuth 或 API key 认证",
		source: "builtin",
	},
	{ name: "logout", description: "退出登录", source: "builtin" },
	{
		name: "codex",
		description: "通过 Codex CLI 问答，例：/codex 这段代码有什么问题",
		source: "builtin",
	},
];

function PromptSuggestions(props: {
	prompt: string;
	items: SuggestionItem[];
	selectedIndex: number;
	onSelectedIndexChange: (index: number) => void;
	onClose: () => void;
	onPick: (value: string) => void;
}) {
	const listRef = useRef<HTMLDivElement>(null);
	const tail = props.prompt.split(/\s/).at(-1) ?? "";

	// 滚动到选中项
	useEffect(() => {
		const list = listRef.current;
		if (!list) return;
		const item = list.children[props.selectedIndex] as HTMLElement;
		if (item) {
			item.scrollIntoView({ block: "nearest" });
		}
	}, [props.selectedIndex]);

	if (props.items.length === 0) return null;

	return (
		<div className="command-palette">
			<div className="command-palette-header">
				<span>{tail.startsWith("/") ? "命令" : "文件"}</span>
				<button className="command-palette-close" onClick={props.onClose}>
					×
				</button>
			</div>
			<div className="command-palette-list" ref={listRef}>
				{props.items.map((item, index) => (
					<button
						key={item.key}
						className={`command-palette-item${index === props.selectedIndex ? " selected" : ""}`}
						onMouseEnter={() => props.onSelectedIndexChange(index)}
						onClick={() => props.onPick(item.value)}
					>
						<span className="command-palette-label">{item.label}</span>
						<span className="command-palette-desc">{item.description}</span>
					</button>
				))}
			</div>
			<div className="command-palette-footer">
				<span>↑↓ 选择</span>
				<span>Enter 确认</span>
				<span>Esc 关闭</span>
			</div>
		</div>
	);
}

function FileContextMenu(props: {
	menu: { x: number; y: number; node: FileTreeNode };
	onClose: () => void;
	onOpen: () => void;
	onReveal: () => void;
	onAttach: () => void;
}) {
	const isFile = props.menu.node.type === "file";
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: props.menu.x, top: props.menu.y }}
				onClick={(event) => event.stopPropagation()}
			>
				<button disabled={!isFile} onClick={props.onAttach}>
					加入对话引用
				</button>
				<button disabled={!isFile} onClick={props.onOpen}>
					默认方式打开
				</button>
				<button onClick={props.onReveal}>在文件夹中显示</button>
			</div>
		</div>
	);
}

function AgentContextMenu(props: {
	menu: { x: number; y: number; agent: AgentTab };
	onClose: () => void;
	onActivate: () => void;
	onExport: () => void;
	onShowLogs: () => void;
	onCloseAgent: () => void;
}) {
	return (
		<div className="context-backdrop" onClick={props.onClose}>
			<div
				className="context-menu"
				style={{ left: props.menu.x, top: props.menu.y }}
				onClick={(event) => event.stopPropagation()}
			>
				<button onClick={props.onActivate}>打开会话</button>
				<button onClick={props.onExport}>导出 HTML</button>
				<button onClick={props.onShowLogs}>RPC 日志</button>
				<button onClick={props.onCloseAgent}>关闭 Agent</button>
			</div>
		</div>
	);
}

function fuzzyScore(value: string, keyword: string) {
	if (!keyword) return 1;
	const text = value.toLowerCase();
	const query = keyword.toLowerCase();
	if (text.includes(query)) return 100 + query.length;
	let score = 0;
	let pos = 0;
	for (const ch of query) {
		const found = text.indexOf(ch, pos);
		if (found === -1) return 0;
		score += found === pos ? 8 : 2;
		pos = found + 1;
	}
	return score;
}

function SettingsModal(props: {
	settings: AppSettings;
	notice: string;
	piStatus: PiInstallStatus | null;
	piChecking: boolean;
	appInfo: AppInfo;
	onCheckPi: () => void;
	onCheckUpdate: () => void;
	onClose: () => void;
	onChange: (patch: Partial<AppSettings>) => void;
}) {
	return (
		<div className="modal-backdrop">
			<div
				className="settings-modal"
			>
				<div className="modal-header">
					<strong>设置</strong>
					<button onClick={props.onClose}>×</button>
				</div>
				<div className="settings-panel">
					<label>
						<input
							type="checkbox"
							checked={props.settings.useNativeTitleBar}
							onChange={(event) =>
								props.onChange({ useNativeTitleBar: event.target.checked })
							}
						/>{" "}
						使用原生标题栏
					</label>
					<label>
						<input
							type="checkbox"
							checked={props.settings.showNativeMenu}
							onChange={(event) =>
								props.onChange({ showNativeMenu: event.target.checked })
							}
						/>{" "}
						显示原生菜单
					</label>
					<label>
						<input
							type="checkbox"
							checked={props.settings.closeToTray}
							onChange={(event) =>
								props.onChange({ closeToTray: event.target.checked })
							}
						/>{" "}
						关闭窗口时隐藏到系统托盘
					</label>
					<label>
						<input
							type="checkbox"
							checked={props.settings.enableNotifications}
							onChange={(event) =>
								props.onChange({ enableNotifications: event.target.checked })
							}
						/>{" "}
						会话结束时发送系统通知
					</label>
					<label>
						<input
							type="checkbox"
							checked={props.settings.showThinking}
							onChange={(event) =>
								props.onChange({ showThinking: event.target.checked })
							}
						/>{" "}
						显示思考过程
						<small className="setting-hint">
							开启后可看到模型推理过程，帮助理解 agent 为什么“卡住”
						</small>
					</label>
					<div className="setting-field">
						<span>发送快捷键</span>
						<select
							value={props.settings.sendShortcut}
							onChange={(event) =>
								props.onChange({
									sendShortcut: event.target
										.value as AppSettings["sendShortcut"],
								})
							}
						>
							<option value="enter-send">
								Enter 发送，Ctrl/Shift+Enter 换行
							</option>
							<option value="ctrl-enter-send">
								Ctrl/⌘ + Enter 发送，Enter 换行
							</option>
							<option value="shift-enter-send">
								Shift + Enter 发送，Enter 换行
							</option>
						</select>
					</div>
					<div className="setting-row">
						<div>
							<strong>pi 环境</strong>
							<small>
								{props.piStatus
									? props.piStatus.installed
										? `已找到 ${props.piStatus.version ?? "pi"}`
										: "未检测到 pi CLI"
									: "检查 pi CLI 是否可用"}
							</small>
						</div>
						<button onClick={props.onCheckPi} disabled={props.piChecking}>
							{props.piChecking ? "检测中…" : "检测环境"}
						</button>
					</div>
					<div className="setting-row">
						<div>
							<strong>当前版本</strong>
							<small>v{props.appInfo.version}</small>
						</div>
						<button onClick={props.onCheckUpdate}>检测更新</button>
					</div>
					<div className="setting-row">
						<div>
							<strong>开发者控制台</strong>
							<small>打开 DevTools 查看控制台日志，排查问题</small>
						</div>
						<button onClick={() => void api.app.toggleDevTools()}>
							打开/关闭
						</button>
					</div>
					<p>{props.notice || "标题栏设置保存后需要重启应用生效。"}</p>
				</div>
			</div>
		</div>
	);
}
