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
import { createPreviewApi } from "./previewApi";
import type {
	AgentRuntimeState,
	AgentTab,
	AppInfo,
	AppSettings,
	AvailableModel,
	ChatMessage,
	FileTreeNode,
	GitBranchInfo,
	PiCommand,
	PiInstallStatus,
	Project,
	SessionSummary,
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
	const [_logs, setLogs] = useState<string[]>([]); // 写入式调试日志，仅用于 onLog/onError 捕获
	const [search, setSearch] = useState("");
	const [suggestionsOpen, setSuggestionsOpen] = useState(false);
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
	const [agentLoading, setAgentLoading] = useState<{ text: string } | null>(
		null,
	);
	const [settings, setSettings] = useState<AppSettings>({
		useNativeTitleBar: true,
		showNativeMenu: false,
		sendShortcut: "enter-send",
		piEnvironmentChecked: false,
		closeToTray: true,
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
	const outlineItems = useMemo(
		() => buildOutline(activeMessages),
		[activeMessages],
	);
	const flatFiles = useMemo(() => flattenFiles(files), [files]);
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

		return () => {
			offProjects();
			offState();
			offMessages();
			offLog();
			offSettings();
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
		const timeline = timelineRef.current;
		if (!timeline) return;
		// 历史会话加载后默认跳到最新消息，符合聊天软件的阅读习惯，避免用户手动滚动到底部。
		requestAnimationFrame(() => {
			timeline.scrollTop = timeline.scrollHeight;
		});
	}, [activeAgentId, activeMessages.length]);

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
		setAgentLoading({
			text: sessionPath ? "正在打开历史会话…" : "正在创建 Agent…",
		});
		// 立即关闭抽屉，避免等待 agent 加载期间列表仍然显示
		setDrawer(null);
		try {
			const tab = await api.agents.create({ projectId, sessionPath, title });
			setActiveAgentId(tab.id);
			void refreshRuntimeState(tab.id);
		} finally {
			setAgentLoading(null);
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
		if (event.key === "Escape") {
			setPrompt((current) => clearSuggestionTrigger(current));
			setSuggestionsOpen(false);
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

	async function sendPrompt() {
		if (!activeAgentId || !prompt.trim()) return;
		const message = prompt;
		setPrompt("");
		await api.agents.prompt({ agentId: activeAgentId, message });
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
						<span>pi</span>
					</div>
					<button
						className="icon-button"
						title="设置"
						onClick={() => setSettingsOpen(true)}
					>
						⚙
					</button>
				</div>
				<button
					className="collapse-button list-collapse"
					title={listCollapsed ? "展开列表" : "折叠列表"}
					onClick={() => setListCollapsed((value) => !value)}
				>
					{listCollapsed ? "›" : "‹"}
				</button>

				<div className="search-row">
					<div className="search-box">
						<span>⌕</span>
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
										setActiveProjectId(project.id);
										setActiveAgentId(
											activeAgentByProject[project.id] ??
												agents.find((agent) => agent.projectId === project.id)
													?.id,
										);
									}}
								>
									<span
										className={`project-fold${isCollapsed ? " folded" : ""}`}
										title={isCollapsed ? "展开" : "折叠"}
										onClick={(event) => {
											event.stopPropagation();
											setCollapsedProjects((prev) => {
												const next = new Set(prev);
												if (next.has(project.id)) next.delete(project.id);
												else next.add(project.id);
												return next;
											});
										}}
									>
										▶
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
						<SessionStatus state={activeRuntimeState} />
					</div>
					<div className={`chat-header-actions${agentLoading ? " loading" : ""}`}>
						{!agentLoading && (
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
										disabled={!activeAgentId}
										onClick={() =>
											activeAgentId &&
											api.agents.prompt({
												agentId: activeAgentId,
												message: "/reload",
											})
										}
									>
										Reload
									</button>
									<button
										disabled={!activeAgentId || !!agentLoading}
										title="重启 Agent 进程，重新加载配置文件（provider、API key 等）"
										onClick={async () => {
											if (!activeAgentId) return;
											setAgentLoading({ text: "正在重启 Agent…" });
											try {
												const tab = await api.agents.restart(activeAgentId);
												setActiveAgentId(tab.id);
												void refreshRuntimeState(tab.id);
											} finally {
												setAgentLoading(null);
											}
										}}
									>
										Restart
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
						)}
					</div>
				</header>

				<section className="message-timeline" ref={timelineRef}>
					{agentLoading && (
						<div className="history-loading">
							<div className="loader" />
							<span>{agentLoading.text}</span>
						</div>
					)}
					{!agentLoading && !activeAgent && (
						<EmptyState
							hasProject={Boolean(activeProjectId)}
							onCreate={() => createAgent()}
						/>
					)}
					{!agentLoading && activeAgent && (
						<div className="message-list">
							{renderedMessages.map((item) =>
								item.kind === "tool-group" ? (
									<ToolGroup key={item.id} group={item} />
								) : (
									<ChatBubble key={item.message.id} message={item.message} />
								),
							)}
							{isAwaitingAssistant && <ThinkingBubble />}
						</div>
					)}
					{!agentLoading && outlineItems.length > 1 && (
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

				{!agentLoading && (
				<footer className="composer">
					<div className="composer-box" style={{ height: composerHeight }}>
						<div
							className="composer-resize-handle"
							title="拖动调整输入框高度"
							onPointerDown={startComposerResize}
						/>
						<ComposerToolbar
							state={activeRuntimeState}
							compacting={compacting}
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
						{(prompt.startsWith("!") || prompt.startsWith("/")) && (
							<div
								className={`composer-mode-hint ${
									prompt.startsWith("!!")
										? "mode-bang-bang"
										: prompt.startsWith("!")
											? "mode-bang"
											: "mode-slash"
								}`}
							>
								{prompt.startsWith("!!")
									? "⚡ 静默执行"
									: prompt.startsWith("!")
										? ">_ 执行命令"
										: "⌘ 斜杠命令"}
							</div>
						)}
						{suggestionsOpen && (
							<PromptSuggestions
								prompt={prompt}
								commands={commands}
								files={flatFiles}
								onClose={() => {
									setPrompt((current) => clearSuggestionTrigger(current));
									setSuggestionsOpen(false);
								}}
								onPick={(value) => {
									setPrompt((current) => applySuggestion(current, value));
									setSuggestionsOpen(false);
								}}
							/>
						)}
						<div className="composer-footer">
							<span>
								{drawer
									? "右侧面板可查看文件或恢复历史会话"
									: (activeAgent?.sessionPath ?? "")}
							</span>
							{activeAgent?.status === "running" && (
								<button className="stop-send" onClick={() => abortAgent()}>
									停止
								</button>
							)}
							<button
								disabled={!activeAgentId || !prompt.trim()}
								onClick={sendPrompt}
							>
								发送
							</button>
						</div>
					</div>
				</footer>
				)}
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
						›
					</button>
					<DrawerContent
						panel={drawer}
						files={files}
						sessions={sessions}
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
					onCloseAgent={() => {
						void closeAgent(agentMenu.agent.id);
						setAgentMenu(null);
					}}
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

function SessionStatus(props: { state?: AgentRuntimeState }) {
	if (!props.state) return null;
	return (
		<div className="session-status">
			<span className="model-chip">
				{props.state.modelName ?? props.state.modelId ?? "model"}
			</span>
			<span>think: {props.state.thinkingLevel ?? "-"}</span>
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
	onCycleModel: () => void;
	onPickModel: () => void;
	onCycleThinking: () => void;
	onCompact: () => void;
}) {
	const ctxPercent = props.state?.contextPercent;
	const showCompact = ctxPercent != null && ctxPercent > 30;
	return (
		<div className="composer-toolbar">
			<button onClick={props.onPickModel}>
				Model: {props.state?.modelName ?? "-"}
			</button>
			<button onClick={props.onCycleModel}>Cycle Model</button>
			<button onClick={props.onCycleThinking}>
				Think: {props.state?.thinkingLevel ?? "-"}
			</button>
			{showCompact && (
				<button
					className={props.state?.isCompacting || props.compacting ? "compacting" : ""}
					disabled={props.state?.isCompacting || props.compacting || !!props.state?.isStreaming}
					title={
						`上下文: ${ctxPercent.toFixed(1)}% — 点击压缩上下文释放空间`
					}
					onClick={props.onCompact}
				>
					{props.state?.isCompacting || props.compacting ? "压缩中…" : `Compact ${ctxPercent.toFixed(0)}%`}
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

	if (props.gitInfo.branches.length === 0) return null;
	const current = props.gitInfo.current ?? "";

	return (
		<div className="branch-select" ref={ref}>
			<button
				className="branch-trigger"
				onClick={() => setOpen((v) => !v)}
				title={`当前分支: ${current}`}
			>
				<span className="branch-icon">⑂</span>
				<span className="branch-label" title={current}>
					{current}
				</span>
				<span className={`branch-chevron${open ? " open" : ""}`}>▾</span>
			</button>
			{open && (
				<div className="branch-dropdown">
					{props.gitInfo.branches.map((branch) => (
						<button
							key={branch}
							className={branch === current ? "active" : ""}
							onClick={() => {
								props.onSwitch(branch);
								setOpen(false);
							}}
						>
							<span className="branch-item-icon">
								{branch === current ? "✓" : "⑂"}
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
				<svg viewBox="140 140 520 520" width="40" height="40" aria-hidden="true">
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

type RenderMessage = { kind: "message"; message: ChatMessage } | ToolGroupItem;

type ToolGroupItem = {
	kind: "tool-group";
	id: string;
	messages: ChatMessage[];
};

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

function ThinkingBubble() {
	return (
		<article className="chat-message assistant thinking-message">
			<div className="msg-avatar">P</div>
			<div className="msg-content">
				<div className="msg-name">
					<span>pi</span>
					<time>正在响应</time>
				</div>
				<div className="msg-bubble typing-bubble">
					<span /> <span /> <span />
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
	const running = props.group.messages.some(
		(message) => message.meta?.status === "running",
	);
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

function ChatBubble(props: { message: ChatMessage }) {
	const { message } = props;
	const [expanded, setExpanded] = useState(false);
	const isUser = message.role === "user";
	const isTool = message.role === "tool";
	const label = message.role === "assistant" ? "pi" : message.role;
	const detailText =
		typeof message.meta?.detailText === "string"
			? message.meta.detailText
			: JSON.stringify(message.meta ?? {}, null, 2);
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
				<div className="msg-bubble markdown-body">
					<ReactMarkdown
						remarkPlugins={[remarkGfm]}
						components={{ pre: CodeBlock, a: MarkdownLink }}
					>
						{message.text}
					</ReactMarkdown>
					{expanded && <pre className="tool-detail">{detailText}</pre>}
				</div>
				<div className="msg-actions">
					<button
						onClick={() =>
							navigator.clipboard.writeText(
								expanded && isTool ? detailText : message.text,
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
	const firstLine =
		text
			.replace(/```[\s\S]*?```/g, " ")
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find(Boolean) ?? "";
	return firstLine.length > 34 ? `${firstLine.slice(0, 34)}…` : firstLine;
}

function ConversationOutline(props: {
	items: Array<{ id: string; role: string; title: string; time: string }>;
	onJump: (id: string) => void;
}) {
	return (
		<div className="outline-hover">
			<button className="outline-trigger" title="会话定位">
				☰
			</button>
			<nav className="conversation-outline">
				<div className="outline-title">会话定位</div>
				{props.items.slice(-10).map((item) => (
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
			</nav>
		</div>
	);
}

function DrawerContent(props: {
	panel: DrawerPanel;
	files: FileTreeNode[];
	sessions: SessionSummary[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onClose: () => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
	onRefreshSessions: () => void;
	onOpenSession: (session: SessionSummary) => void;
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
				/>
			)}
		</>
	);
}

function FilesPanel(props: {
	files: FileTreeNode[];
	expandedDirs: Set<string>;
	onToggleDirectory: (path: string) => void;
	onFileContextMenu: (node: FileTreeNode, x: number, y: number) => void;
}) {
	return (
		<div className="files-panel">
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
				<span>{expanded ? "▾" : "▸"}</span>
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
}) {
	return (
		<div className="sessions-panel">
			<div className="panel-action-row">
				<span>{props.sessions.length} sessions</span>
				<button onClick={props.onRefresh}>刷新</button>
			</div>
			{props.sessions.map((session) => (
				<button
					key={session.filePath}
					className="session-card"
					onClick={() => props.onOpen(session)}
					title={session.filePath}
				>
					<strong>{session.name || "Untitled"}</strong>
					<small>
						{new Date(session.updatedAt).toLocaleString()} ·{" "}
						{session.messageCount} messages
					</small>
					<p>{session.preview}</p>
				</button>
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

// pi 内置斜杠命令，get_commands 只返回扩展注册的命令，这些需要手动补充
// 排除 desktop 已有独立 UI 入口的：/new（New Session 按钮）、/model（模型选择器）、
// /resume（历史会话抽屉）、/fork（不太需要），/name 可在历史会话列表操作。
const BUILTIN_COMMANDS: PiCommand[] = [
	{ name: "name", description: "设置当前会话名称", source: "builtin" },
	{ name: "session", description: "显示会话文件、ID、消息数、token 和费用", source: "builtin" },
	{ name: "tree", description: "会话树导航，跳转到任意节点", source: "builtin" },
	{ name: "clone", description: "复制当前分支到新会话", source: "builtin" },
	{ name: "compact", description: "压缩上下文，可选自定义提示词", source: "builtin" },
	{ name: "copy", description: "复制最后一条回复到剪贴板", source: "builtin" },
	{ name: "export", description: "导出会话为 HTML 文件", source: "builtin" },
	{ name: "share", description: "上传为 GitHub Gist 私密链接", source: "builtin" },
	{ name: "settings", description: "打开 pi 设置", source: "builtin" },
	{ name: "reload", description: "重载扩展、技能和配置", source: "builtin" },
	{ name: "hotkeys", description: "显示所有快捷键", source: "builtin" },
	{ name: "login", description: "管理 OAuth 或 API key 认证", source: "builtin" },
	{ name: "logout", description: "退出登录", source: "builtin" },
];

function PromptSuggestions(props: {
	prompt: string;
	commands: PiCommand[];
	files: FileTreeNode[];
	onClose: () => void;
	onPick: (value: string) => void;
}) {
	// 合并内置命令和 pi 返回的扩展命令，去重（扩展命令优先）
	const allCommands = useMemo(() => {
		const names = new Set(props.commands.map((c) => c.name));
		const extras = BUILTIN_COMMANDS.filter((c) => !names.has(c.name));
		return [...props.commands, ...extras];
	}, [props.commands]);

	const tail = props.prompt.split(/\s/).at(-1) ?? "";
	if (tail.startsWith("/")) {
		const keyword = tail.slice(1).toLowerCase();
		const commands = allCommands
			.filter((command) => command.name.toLowerCase().includes(keyword))
			.slice(0, 10);
		if (commands.length === 0) return null;
		return (
			<div className="suggestions">
				<button className="suggestion-close" onClick={props.onClose}>
					关闭
				</button>
				{commands.map((command) => (
					<button
						key={command.name}
						onClick={() => props.onPick(`/${command.name}`)}
					>
						<strong>/{command.name}</strong>
						<span>{command.description}</span>
					</button>
				))}
			</div>
		);
	}
	if (tail.startsWith("@")) {
		const keyword = tail.slice(1).toLowerCase();
		const files = props.files
			.map((file) => ({
				file,
				score:
					fuzzyScore(file.relativePath, keyword) +
					fuzzyScore(file.name, keyword) * 2,
			}))
			.filter((item) => item.score > 0 || !keyword)
			.sort((a, b) => b.score - a.score)
			.slice(0, 8)
			.map((item) => item.file);
		if (files.length === 0) return null;
		return (
			<div className="suggestions">
				<button className="suggestion-close" onClick={props.onClose}>
					关闭
				</button>
				{files.map((file) => (
					<button
						key={file.path}
						onClick={() => props.onPick(`@${file.relativePath}`)}
					>
						<strong>@{file.name}</strong>
						<span>{file.relativePath}</span>
					</button>
				))}
			</div>
		);
	}
	return null;
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
		<div className="modal-backdrop" onClick={props.onClose}>
			<div
				className="settings-modal"
				onClick={(event) => event.stopPropagation()}
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
					<p>{props.notice || "标题栏设置保存后需要重启应用生效。"}</p>
				</div>
			</div>
		</div>
	);
}
