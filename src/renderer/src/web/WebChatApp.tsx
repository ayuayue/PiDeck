/**
 * WebChatApp — PiDeck Web 服务 React 前端（A2）重构后的组合根。
 *
 * 数据层保持原有架构：
 * - useChat + DefaultChatTransport 消费 /api/chat 流式（AI SDK v7 UIMessageStream）
 * - /api/events SSE 接收项目/会话/运行态变更推送；fetchState 轮询降级为低频兑底；
 *   外部流订阅（useExternalSessionStream）实时渲染桌面端/其他设备发起的回复
 * - 历史消息按会话注入 useChat；useChat 切换 id 会重建 Chat 实例（不保留
 *   上一会话消息），因此本组件持有自己的 per-session 消息缓存，
 *   切回会话时直接从缓存恢复，避免重复拉取与闪空。
 *
 * UI 层与桌面端对齐：WebSidebar / WebHeader / WebTimeline / WebComposer，
 * 复用桌面设计 token、shadcn 组件、lucide 图标与 timeline/surfaces 样式类。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import type { UIMessage } from "ai";
import type { AgentBackend, AvailableModel, SessionRuntimeTarget } from "../../../shared/types";
import { createSessionModelPreference } from "../../../shared/modelDisplayName";
import { t } from "@/i18n";
import { WebSidebar, type WebSessionRowAction } from "./WebSidebar";
import { WebHeader, type WebHeaderStatus } from "./WebHeader";
import { WebTimeline, uiMessageImages, uiMessageText } from "./WebTimeline";
import { forkPromptText, isLastUserMessageIn, resolveWebForkEntryId } from "./webForkMutation";
import { WebComposer } from "./WebComposer";
import { WebDshToolsPanel } from "./WebDshToolsPanel";
import { WebBranchBar } from "./WebBranchBar";
import { sessionFromPath, sessionPath } from "./webSessionRoute";
import { WebWorkspaceDrawer } from "./WebWorkspaceDrawer";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui-shadcn/alert-dialog";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui-shadcn/dialog";
import { Button } from "@/components/ui-shadcn/button";
import { Input } from "@/components/ui-shadcn/input";
import { chatMessagesToUiMessages, createProject, createSession, deleteProject, fetchMessagePage, fetchModels, fetchState, getWebAuthHeaders, respondToUi, setRuntimeModel, setRuntimeThinking, updateSessionRecord } from "./webApi";
import { abortRuntime, cloneRuntime, compactRuntime, copySession, deleteSession, downloadSessionHtml, editRuntimeMessage, deleteRuntimeMessage, prepareResend, renameSession, restartRuntime, activateRuntime, forkRuntimeSession, getForkMessages } from "./webApi";
import { fetchRuntimeContextUsage, setRuntimePermission } from "./webApi";
import { dataUrlToFilePart } from "./webMessageParts";
import { shouldFlushQueuedPrompt } from "./webQueueFlush";
import { sessionUiMessagesToMarkdown } from "./webMarkdown";
import { removeMessageOptimistic, replaceMessageTextOptimistic } from "./webMessageOptimistic";
import { WebSessionStrips } from "./WebSessionStrips";

/** 搜索命中落在未加载历史里时，最多向前补拉多少页（每页一个历史窗口，约 9 轮）。 */
const MAX_SEARCH_JUMP_PAGES = 5;
import { WebFilePreview, type WebFilePreviewTarget } from "./WebFilePreview";
import { WebSearchDialog } from "./WebSearchDialog";
import { WebSkillsExtensionsDialog } from "./WebSkillsExtensionsDialog";
import { applyWebTheme, nextWebTheme, readStoredWebTheme, resolveWebTheme, storeWebTheme, systemPrefersDark, type ResolvedWebTheme, type WebThemePreference } from "./webTheme";
import { registerWebServiceWorker, usePwaInstall } from "./webPwa";
import { decideStreamRecovery } from "./webStreamRecovery";
import { useWebHeaderAutoHide } from "./useWebHeaderAutoHide";
import { resolveComposerHidden } from "./composerCollapse";
import { useIsMobileViewport } from "./useIsMobileViewport";
import { useExternalSessionStream } from "./webExternalStream";
import { useWebStateEvents } from "./webStateEvents";
import type { AgentUiResponse } from "../../../shared/types";
import type { WebProject, WebRuntime, WebState, WebContextUsage } from "./webTypes";

/** 分页元数据：已加载消息总数 + 更早一页的游标。 */
type HistoryMeta = {
	total: number;
	nextBefore: number | null;
};

/** 待发送队列项：回合进行中提交的消息暂存于此，本轮结束后按序投递。 */
type WebQueuedPrompt = {
	id: string;
	text: string;
	/** 图片 data URL（已压缩）；投递时转 file parts。 */
	images: string[];
	/** 计划模式等隐藏指令，随 body 透传后端。 */
	agentMessage?: string;
};

export function WebChatApp() {
	const [state, setState] = useState<WebState>({
		projects: [],
		sessions: [],
		runtimes: [],
	});
	const [activeSessionId, setActiveSessionId] = useState<string>("");
	const [creatingProjectId, setCreatingProjectId] = useState<string>("");
	const [connected, setConnected] = useState(false);
	const [loadingMore, setLoadingMore] = useState(false);
	const [models, setModels] = useState<AvailableModel[]>([]);
	const [modelsRefreshing, setModelsRefreshing] = useState(false);
	// 模型选择器刷新按钮：绕过缓存重新拉取／api/models?force=1；失败保留旧列表，避免误清空。
	const refreshModels = async () => {
		setModelsRefreshing(true);
		try {
			setModels(await fetchModels(true));
		} catch {
			// 刷新失败保留上一次列表，仅结束转圈
		} finally {
			setModelsRefreshing(false);
		}
	};
	const [commandError, setCommandError] = useState<string | null>(null);
	// 首页（无会话）时选择的模型/思考级别：暂存为待用偏好，随下一次新建会话生效
	const [pendingModel, setPendingModel] = useState<{ provider: string; modelId: string; modelName: string } | null>(null);
	const [pendingThinkingLevel, setPendingThinkingLevel] = useState<string | null>(null);
	// 首页（无会话）时选择的后端：随下一次新建会话生效（对齐桌面 welcome 页语义）
	const [pendingBackend, setPendingBackend] = useState<AgentBackend | null>(null);
	// 手机端默认把聊天作为主画面，项目树通过抽屉按需打开，避免列表占满首屏。
	const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
	const [uiResponding, setUiResponding] = useState(false);
	// S6.3：DSH 工具面板（goals/subagents/skills）开关
	const [dshToolsOpen, setDshToolsOpen] = useState(false);
	// P1：workspace 抽屉 / 重命名 / 删除确认
	const [workspaceOpen, setWorkspaceOpen] = useState(false);
	const [renameDraft, setRenameDraft] = useState<{ sessionId: string; title: string } | null>(null);
	const [renameValue, setRenameValue] = useState("");
	const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
	// P2：composer 预填充（重发取回文本）；nonce 避免同文本重复触发
	const [prefill, setPrefill] = useState<{ text: string; nonce: number } | null>(null);
	// 消息编辑/删除乐观更新：进行中操作（气泡转状态指示）、删除退场动画目标、编辑成功闪环目标。
	// runtime 编辑/删除要走「停 agent → 改文件 → pi 重载」全链路（数秒），先本地落地再静默对齐服务端。
	const [pendingMessageAction, setPendingMessageAction] = useState<{ kind: "edit" | "delete" | "resend"; id: string } | null>(null);
	const [exitingMessageIds, setExitingMessageIds] = useState<ReadonlySet<string>>(new Set());
	const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
	const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// P2：上下文用量（随主轮询拉取 runtime state 子集）
	const [contextUsage, setContextUsage] = useState<WebContextUsage | undefined>(undefined);
	// 顶栏自动收起：状态机在 headerAutoHide（纯 step 函数），hook 只持有状态与上报
	const overlayOpenRef = useRef(false);
	const { hidden: headerHidden, reportScroll: handleTimelineScroll, reveal: revealHeader } = useWebHeaderAutoHide(() => overlayOpenRef.current);
	const mobileViewport = useIsMobileViewport();

	// ── 本组件自持的 per-session 消息缓存（useChat 切换 id 会重建 Chat 实例） ──
	const messagesBySessionRef = useRef<Record<string, UIMessage[]>>({});
	const loadedSessionsRef = useRef<Set<string>>(new Set());
	const historyMetaRef = useRef<Record<string, HistoryMeta>>({});
	// 本页「新建」的零消息草稿：后端切换仅对这类会话开放（复制/克隆/fork 与历史会话自带
	// 消息记录，后端不可切——消息归属创建时的后端，切了会让历史错位）。
	const webDraftSessionsRef = useRef<Set<string>>(new Set());
	// 会话消息刷新去重：同会话在途只发一次（切换 SWR / busy 收尾 / 手动刷新共用入口）
	const refreshingSessionsRef = useRef<Set<string>>(new Set());
	// 主轮询用：上一轮活跃会话 runtime 是否 busy，用于捕拿 busy→idle 边沿做收尾拉取
	const runtimeBusyPrevRef = useRef(false);
	const activeSessionIdRef = useRef<string>("");
	// 首页直发暂存：新建会话后等 useChat 实例切换完成，再投递首条消息（含图片）
	const pendingSendRef = useRef<{ sessionId: string; text: string; images?: string[]; agentMessage?: string } | null>(null);

	// useChat：sessionId 作为 chat id；切会话时 id 变化重建 Chat 实例
	const { messages, sendMessage, status, stop, setMessages, error, clearError } = useChat({
		id: activeSessionId,
		transport: new DefaultChatTransport({
			api: "/api/chat",
			headers: getWebAuthHeaders(),
		}),
	});

	const streaming = status === "submitted" || status === "streaming";

	// ── 第二批：主题 / PWA / 搜索 / SSE 断线恢复 ──
	const [themePreference, setThemePreference] = useState<WebThemePreference>(() => readStoredWebTheme());
	const [systemDark, setSystemDark] = useState(() => systemPrefersDark());
	const resolvedTheme: ResolvedWebTheme = resolveWebTheme(themePreference, systemDark);
	const [searchOpen, setSearchOpen] = useState(false);
	const [assetsOpen, setAssetsOpen] = useState(false);
	const [recoveryNotice, setRecoveryNotice] = useState<string | null>(null);
	// 令牌失效兑底：服务端轮换 token 后所有请求 401，轮询层只会默默 setConnected(false)，
	// 用户看到的是「一直断线」；这里显式提示需从桌面端重新扫码/打开新链接。
	const [authExpired, setAuthExpired] = useState(false);
	useEffect(() => {
		const onAuthFailed = () => setAuthExpired(true);
		window.addEventListener("pideck-web-auth-failed", onAuthFailed);
		return () => window.removeEventListener("pideck-web-auth-failed", onAuthFailed);
	}, []);
	const recoveryLastAttemptRef = useRef(0);
	const statusRef = useRef(status);
	statusRef.current = status;
	// runtime 忙态镜像：刷新页面/端口中断后 useChat 已回 ready 而 pi 仍在跑，
	// 恢复判定用它区分「真正空闲」与「脱节待追赶」（render 期赋值，在 activeRuntime 计算之后）。
	const activeRuntimeRef = useRef<WebRuntime | undefined>(undefined);
	const { canInstall, install } = usePwaInstall();

	// 主题：应用为与桌面同源的 data-theme 机制；跟随系统变化时重解析
	useEffect(() => {
		applyWebTheme(resolvedTheme);
	}, [resolvedTheme]);
	useEffect(() => {
		const media = window.matchMedia("(prefers-color-scheme: dark)");
		const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
		media.addEventListener("change", onChange);
		return () => media.removeEventListener("change", onChange);
	}, []);
	const cycleTheme = () => {
		// system → 跳到与当前解析结果相反的一档：系统此时是亮色却切到 light，用户看不到任何变化。
		const next: WebThemePreference = nextWebTheme(themePreference, resolvedTheme);
		setThemePreference(next);
		storeWebTheme(next);
	};

	// PWA：SW 注册一次（失败静默降级，不影响页面功能）
	useEffect(() => {
		registerWebServiceWorker();
	}, []);

	// ── 会话路由（URL ↔ activeSessionId）──
	// 刷新/分享/回退能回到同一会话；首次恢复前不回写 URL，避免落地页加载瞬间把 /s/<id> 冲掉。
	const routeRestoredRef = useRef(false);
	useEffect(() => {
		if (routeRestoredRef.current) return;
		const id = sessionFromPath(window.location.pathname);
		if (!id) {
			routeRestoredRef.current = true;
			return;
		}
		// 列表未拉到（空且未确认连通）时等待下一轮；确认后无此会话 → 死链，回根路径
		if (state.sessions.some((session) => session.id === id)) {
			setActiveSessionId(id);
			routeRestoredRef.current = true;
		} else if (state.sessions.length > 0 || connected) {
			window.history.replaceState(null, "", "/");
			routeRestoredRef.current = true;
		}
	}, [state.sessions, connected]);
	// 选中变化 → pushState（popstate 驱动的变化路径已一致，自然短路不回写）
	useEffect(() => {
		if (!routeRestoredRef.current) return;
		const desired = sessionPath(activeSessionId);
		if (window.location.pathname === desired) return;
		window.history.pushState(null, "", desired);
	}, [activeSessionId]);
	// 浏览器回退/前进：按 URL 恢复选中
	useEffect(() => {
		const onPopState = () => {
			setActiveSessionId(sessionFromPath(window.location.pathname));
		};
		window.addEventListener("popstate", onPopState);
		return () => window.removeEventListener("popstate", onPopState);
	}, []);

	// SSE 断线恢复：手机锁屏/切网/后台节流断流后，回前台/网络恢复/error 态时
	// 从磁盘拉最新消息窗口覆盖本地（pi 侧不受影响，见 webStreamRecovery.ts）
	const recoverFromDisk = async (notify: boolean) => {
		const sessionId = activeSessionIdRef.current;
		if (!sessionId) return;
		try {
			const page = await fetchMessagePage(sessionId);
			const history = chatMessagesToUiMessages(page.messages);
			messagesBySessionRef.current[sessionId] = history;
			historyMetaRef.current[sessionId] = { total: page.total, nextBefore: page.nextBefore };
			if (activeSessionIdRef.current === sessionId) setMessages(history);
			// 传输层错误（Network error / 断流）只代表「本端那条 SSE 断了」，不代表这轮失败：
			// 磁盘追赶拿到权威内容后必须清掉，否则手机切后台再回来会一直挂着红条。
			clearError();
			if (notify) {
				setRecoveryNotice(t("web.streamRecovered"));
				setTimeout(() => setRecoveryNotice(null), 4000);
			}
		} catch {
			if (notify) {
				setRecoveryNotice(t("web.streamRecoveryFailed"));
				setTimeout(() => setRecoveryNotice(null), 4000);
			}
		}
	};
	useEffect(() => {
		const maybeRecover = () => {
			const decision = decideStreamRecovery({
				status: statusRef.current,
				runtimeBusy: activeRuntimeRef.current?.status === "running" || activeRuntimeRef.current?.status === "starting",
				documentVisible: !document.hidden,
				online: navigator.onLine,
				lastAttemptAt: recoveryLastAttemptRef.current,
				now: Date.now(),
			});
			if (!decision.recover) return;
			recoveryLastAttemptRef.current = Date.now();
			void recoverFromDisk(decision.notify);
		};
		document.addEventListener("visibilitychange", maybeRecover);
		window.addEventListener("online", maybeRecover);
		// error 态（SSE 显式断流）立即尝试一次；防抖在 decideStreamRecovery 内
		if (status === "error") maybeRecover();
		return () => {
			document.removeEventListener("visibilitychange", maybeRecover);
			window.removeEventListener("online", maybeRecover);
		};
	}, [status]);

	// 回前台主动收掉死流：本端 /api/chat 的 SSE 是 POST 响应，后台断流后浏览器不会重放它，
	// 页面只能看到半截内容（或等到 error 态）。这里把这条死流停掉，交给外部流订阅接管——
	// 服务端回放本轮已产出的帧（见 WebEventStreamRouter.replayRun），页面从零重建完整一轮，
	// 与桌面端看到的工具卡/正文一致。只处理 streaming：响应已开始 = prompt 已投递；
	// submitted 阶段停掉可能把还没发出去的消息弄丢。隐藏时长门槛避开瞬时切窗。
	useEffect(() => {
		let hiddenAt = 0;
		const onVisibility = () => {
			if (document.visibilityState === "hidden") {
				hiddenAt = Date.now();
				return;
			}
			const hiddenFor = hiddenAt ? Date.now() - hiddenAt : 0;
			hiddenAt = 0;
			if (hiddenFor > 1000 && statusRef.current === "streaming") void stop();
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, [stop]);

	// Ctrl/Cmd+K：会话内搜索
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
				event.preventDefault();
				setSearchOpen(true);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const scrollToMessage = (messageId: string) => {
		document.getElementById(`web-msg-${messageId}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	/**
	 * 搜索命中跳转：全会话检索的命中可能落在「还没加载的历史页」里，直接 scrollIntoView
	 * 会静默失败（用户以为点了没反应）。这里按需向前翻页——最多补拉 MAX_SEARCH_JUMP_PAGES
	 * 页，每页之间等一帧让 React 提交，命中出现即滚动；仍找不到就停在已加载的最早一条。
	 */
	const jumpToSearchHit = async (messageId: string) => {
		if (!activeSessionId) return;
		for (let page = 0; page <= MAX_SEARCH_JUMP_PAGES; page += 1) {
			const target = document.getElementById(`web-msg-${messageId}`);
			if (target) {
				target.scrollIntoView({ behavior: "smooth", block: "start" });
				return;
			}
			const meta = historyMetaRef.current[activeSessionId];
			if (page === MAX_SEARCH_JUMP_PAGES || !meta || meta.nextBefore == null) return;
			await loadOlderMessages();
			// 等 React 提交这一页再检查（同帧内 DOM 还是旧的）
			await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
		}
	};

	// 移动端侧栏边缘手势：从左缘 28px 内起手右滑 56px 开抽屉（横向位移占优，不干扰纵向滚动）
	const edgeSwipeRef = useRef<{ x: number; y: number } | null>(null);
	const onMainTouchStart = (event: React.TouchEvent<HTMLElement>) => {
		if (mobileSidebarOpen) return;
		const touch = event.touches[0];
		if (touch.clientX <= 28) edgeSwipeRef.current = { x: touch.clientX, y: touch.clientY };
	};
	const onMainTouchMove = (event: React.TouchEvent<HTMLElement>) => {
		const start = edgeSwipeRef.current;
		if (!start) return;
		const touch = event.touches[0];
		const dx = touch.clientX - start.x;
		const dy = touch.clientY - start.y;
		if (dx > 56 && Math.abs(dx) > Math.abs(dy) * 1.5) {
			edgeSwipeRef.current = null;
			setMobileSidebarOpen(true);
		}
	};
	const onMainTouchEnd = () => {
		edgeSwipeRef.current = null;
	};

	activeSessionIdRef.current = activeSessionId;

	const runtimeFor = (sessionId: string) => state.runtimes.find((runtime) => runtime.sessionId === sessionId);
	const activeSession = state.sessions.find((session) => session.id === activeSessionId);
	const activeRuntime = activeSessionId ? runtimeFor(activeSessionId) : undefined;

	// ── 实时推送链路（对齐桌面端）──
	// 外部流订阅：桌面端/其他设备发起的回复实时打字机渲染；本端 useChat 发送期间关流，
	// 防双路渲染同一轮。runtimeBusy 供收尾兑底；onSettled 磁盘重拉权威终态（已有在途去重）。
	const runtimeBusy = activeRuntime?.status === "running" || activeRuntime?.status === "starting";
	const { liveMessage, externalStreaming } = useExternalSessionStream({
		sessionId: activeSessionId,
		enabled: Boolean(activeSessionId) && !streaming,
		runtimeBusy,
		onSettled: (sessionId) => refreshSessionMessages(sessionId),
	});
	// 状态事件：/api/events 推送到达 → 复用轮询的 refresh 路径拉一次快照
	// （去重/边沿检测只有一份实现）；连接断开时轮询自动回到高频节奏。
	const stateRefreshRef = useRef<((payload?: unknown) => void) | null>(null);
	// SSE state 事件自带完整状态载荷：直接透传给 refresh 复用（省一次 /api/state 往返），
	// 无载荷（畸形帧兜底）时 refresh 内部自行 fetchState。
	const stateEventsConnected = useWebStateEvents((payload) => {
		const refresh = stateRefreshRef.current;
		if (refresh) void refresh(payload);
	});
	activeRuntimeRef.current = activeRuntime;

	// 文件预览（第三批）：消息里的文件链接/strip 的 diff chip 都在此打开。项目信息走 ref
	// 快照，回调保持稳定身份——时间线 memo 不会因回调重建而重渲染，闭包也不会拿到过期会话。
	const [filePreview, setFilePreview] = useState<WebFilePreviewTarget | null>(null);
	const previewProjectRef = useRef<{ id: string; root: string } | null>(null);
	previewProjectRef.current = activeSession ? { id: activeSession.projectId, root: activeSession.projectPath ?? state.projects.find((project) => project.id === activeSession.projectId)?.path ?? "" } : null;
	const openFilePreview = useCallback((path: string, line?: number) => {
		const project = previewProjectRef.current;
		if (!project?.root) return;
		setFilePreview({ kind: "file", projectId: project.id, projectRoot: project.root, path, line });
	}, []);

	const overlayOpen = mobileSidebarOpen || searchOpen || assetsOpen || dshToolsOpen || workspaceOpen || filePreview != null || renameDraft != null || deleteConfirmId != null;
	useEffect(() => {
		overlayOpenRef.current = overlayOpen;
		if (overlayOpen) revealHeader();
	}, [overlayOpen, revealHeader]);
	useEffect(() => {
		revealHeader();
	}, [activeSessionId, revealHeader]);
	useEffect(() => {
		if (!mobileViewport) revealHeader();
	}, [mobileViewport, revealHeader]);
	// 顶栏收起后是 inert 的，键盘/读屏用户没有「滚一下」这个动作可用：任何按键或焦点进入都先露出
	useEffect(() => {
		if (!mobileViewport) return;
		const onKeyDown = () => revealHeader();
		const onFocusIn = () => revealHeader();
		window.addEventListener("keydown", onKeyDown, true);
		document.addEventListener("focusin", onFocusIn, true);
		return () => {
			window.removeEventListener("keydown", onKeyDown, true);
			document.removeEventListener("focusin", onFocusIn, true);
		};
	}, [mobileViewport, revealHeader]);
	const [nearBottom, setNearBottom] = useState(true);
	const [composerEngaged, setComposerEngaged] = useState(false);
	const handleNearBottomChange = useCallback((value: boolean) => setNearBottom(value), []);
	const handleComposerEngagedChange = useCallback((value: boolean) => setComposerEngaged(value), []);
	useEffect(() => {
		if (nearBottom) revealHeader();
	}, [nearBottom, revealHeader]);

	// 切换会话：stale-while-revalidate——缓存命中先展示旧快照立即渲染，再后台重拉磁盘
	// 最新（桌面端/其他端跑出的新消息不会漏）；未加载过的会话直接拉首页注入。
	useEffect(() => {
		if (!activeSessionId) return;
		if (loadedSessionsRef.current.has(activeSessionId)) {
			setMessages(messagesBySessionRef.current[activeSessionId] ?? []);
		}
		void refreshSessionMessages(activeSessionId);
	}, [activeSessionId, setMessages]);

	// 流式期间同步缓存：仅 streaming 时回写（空闲时 setMessages 来自历史恢复/分页，
	// 对应逻辑已各自写缓存；这里若无条件覆盖会把刚恢复的历史再次清空）
	useEffect(() => {
		if (!activeSessionId || !streaming) return;
		messagesBySessionRef.current[activeSessionId] = messages;
		loadedSessionsRef.current.add(activeSessionId);
	}, [messages, activeSessionId, streaming]);

	// 首页直发：useChat 随 activeSessionId 切换在渲染期重建实例（@ai-sdk/react 在 render 中
	// 直接替换 chatRef.current），因此本 effect 里拿到的 sendMessage 已属于新会话；
	// 用 sessionId 校验防止用户在创建期间切到其他会话后串台。
	useEffect(() => {
		const pending = pendingSendRef.current;
		if (!pending || pending.sessionId !== activeSessionId) return;
		if (streaming) return; // 新实例就绪（空闲）后才投递
		pendingSendRef.current = null;
		void sendMessage({ text: pending.text, files: pending.images?.map(dataUrlToFilePart) ?? [] }, { body: { ...(pending.agentMessage ? { agentMessage: pending.agentMessage } : {}) } });
	}, [activeSessionId, streaming, sendMessage]);

	// 模型列表是全局 pi 配置，草稿会话也需要先选模型再发送第一条消息。
	useEffect(() => {
		void fetchModels()
			.then(setModels)
			.catch(() => setModels([]));
	}, []);

	// 状态指纹（2027-02 性能治理）：SSE 断开兜底轮询的快档（流式 1s）里服务端每次
	// 都构建全新对象，直接 setState 会让 WebSidebar（非 memo、吃整个 state）每秒
	// 整列表重渲染——弱网手机端正是快档生效的时候。指纹覆盖全部 UI 可见字段
	//（会话标题/状态/updatedAt/模型/权限、runtime 三元组+状态、项目名、pendingUi
	// 清单），未变化则跳过 setState；SSE 推送路径同样受益。
	const lastStateFingerprintRef = useRef<string | null>(null);
	// 低频轮询项目/会话/运行态（3s；useChat 负责消息流，不参与轮询）
	useEffect(() => {
		let disposed = false;
		const fingerprintOf = (state: NonNullable<Awaited<ReturnType<typeof fetchState>>>): string =>
			[
				(state.projects ?? [])
					.map((project) => project.id + ":" + project.name + ":" + (project.lastOpenedAt ?? 0) + ":" + (project.pinned ? 1 : 0))
					.sort()
					.join(","),
				(state.sessions ?? [])
					.map((session) => session.id + ":" + session.title + ":" + session.status + ":" + (session.updatedAt ?? 0) + ":" + (session.model?.modelId ?? "") + ":" + (session.thinkingLevel ?? "") + ":" + (session.permissionPreset ?? ""))
					.sort()
					.join(","),
				(state.runtimes ?? [])
					.map((runtime) => runtime.sessionId + ":" + runtime.agentId + ":" + runtime.status + ":" + (runtime.runtimeGeneration ?? ""))
					.sort()
					.join(","),
				(state.pendingUiRequests ?? [])
					.map((request) => request.sessionId + ":" + request.requestId)
					.sort()
					.join(","),
			].join("|");
		// payload：SSE state 事件的现成载荷（/api/state 同构），有则免一次拉取。
		// 形状由服务端 serializePublicWebPayload 保证；这里只做最小字段防御（缺 runtimes 视为畸形，回退拉取）。
		const refresh = async (payload?: unknown) => {
			try {
				const next = payload && typeof payload === "object" && Array.isArray((payload as { runtimes?: unknown }).runtimes) ? (payload as NonNullable<Awaited<ReturnType<typeof fetchState>>>) : await fetchState();
				// null = 304 未变化：直接结束（连指纹比较都省了，state 引用保持不变）
				if (disposed || next === null) return;
				setConnected(true);
				const fingerprint = fingerprintOf(next);
				const unchanged = fingerprint === lastStateFingerprintRef.current;
				lastStateFingerprintRef.current = fingerprint;
				if (unchanged) {
					// 内容未变：不 setState（免整树重渲染）；脱节追赶的输入（runtime 状态）也未变，直接返回
					return;
				}
				setState(next);
				// 脱节追赶：useChat 已回 ready 但 runtime 仍在跑（刷新/断网后本轮 SSE 已死，
				// 恢复触发器只在 visibilitychange/online 时发）→ 借主轮询周期补拉磁盘快照，
				// 防抖在 decideStreamRecovery 内，脱节后每 5s 最多追一次直到 runtime 空闲。
				const runtimeStillBusy = (() => {
					const runtime = next.runtimes.find((entry) => entry.sessionId === activeSessionIdRef.current);
					return runtime?.status === "running" || runtime?.status === "starting";
				})();
				if (runtimeStillBusy) {
					runtimeBusyPrevRef.current = true;
					const decision = decideStreamRecovery({
						status: statusRef.current,
						runtimeBusy: true,
						documentVisible: !document.hidden,
						online: navigator.onLine,
						lastAttemptAt: recoveryLastAttemptRef.current,
						now: Date.now(),
					});
					if (decision.recover) {
						recoveryLastAttemptRef.current = Date.now();
						void recoverFromDisk(false);
					}
				} else if (runtimeBusyPrevRef.current) {
					// busy→idle 边沿：runtime 刚跑完（含桌面端发起的一轮），磁盘已有最终输出；
					// 若最后一段输出落在 5s 防抖窗口内会漏同步，这里无视防抖直接收尾拉一次。
					runtimeBusyPrevRef.current = false;
					void refreshSessionMessages(activeSessionIdRef.current);
				}
				// 初始页面保持空会话，让用户明确选择项目/会话；外部删除当前会话时也回到空状态。
				if (activeSessionIdRef.current && !next.sessions.some((session) => session.id === activeSessionIdRef.current)) {
					setActiveSessionId("");
				}
			} catch {
				if (!disposed) setConnected(false);
			}
		};
		void refresh();
		// 流式时 1s 一轮：ask 确认不能等 3s 才出现在手机上。
		// runtime 忙但 useChat 已 ready（脱节态）也走 1s：磁盘追赶频率由恢复防抖控制，
		// 高频轮询是为了 runtime 一空闲就收尾、状态圆点及时回落。
		// /api/events SSE 已连通时降为 30s 兑底：状态变更由推送即时驱动 refresh（上方赋值），
		// 轮询只负责捕捉推送间隙的漂移。
		stateRefreshRef.current = refresh;
		const runtimeBusyNow = activeRuntime?.status === "running" || activeRuntime?.status === "starting";
		const timer = setInterval(refresh, stateEventsConnected ? 30_000 : streaming || runtimeBusyNow ? 1000 : 3000);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
	}, [streaming, activeRuntime?.status, stateEventsConnected]);

	// P0：停止 = 客户端断流 + 尽力打断 pi runtime（有 agent 时）。两者都发：
	// stop() 只断 SSE，pi 会继续跑完；abortRuntime 才是真正的打断命令。
	const handleStop = () => {
		// 停止后不再自动投递排队消息（否则打断的下一秒就发出下一条，用户以为没停住）；
		// 队列条上标「已暂停」，用户再次发送即可恢复。
		if ((queuedBySession[activeSessionId] ?? []).length > 0) setQueuePausedBoth(true);
		stop();
		const runtime = activeSessionId ? runtimeFor(activeSessionId) : undefined;
		if (runtime) {
			void abortRuntime(runtime.sessionId, {
				sessionId: runtime.sessionId,
				agentId: runtime.agentId,
				runtimeGeneration: runtime.runtimeGeneration ?? 0,
			}).catch(() => {
				// runtime 已退出时静默（下次轮询会收敛状态）
			});
		}
	};

	// P2：发送携带图片附件（data URL，已压缩）；首页直发走 pending 队列。
	// 图片必须以 file parts 随 user 消息提交：服务端 /api/chat 只从消息 parts 提取图片
	// （extractChatImages），旧的自定义 body.images 字段服务端不读——图片从未真正送达 pi，
	// 乐观气泡也不渲染缩略图（uiMessageImages 只认 file parts）。两处一并修正。
	const handleSend = (text: string, images: string[], agentMessage?: string) => {
		if (!text.trim() && images.length === 0) return;
		// 用户主动发新消息 = 恢复自动投递（覆盖「停止后暂停」）
		queuePausedRef.current = false;
		if (!activeSessionId) {
			void sendFromHome(text, images, agentMessage);
			return;
		}
		// agentMessage：计划模式等隐藏指令（复用桌面 composer 通道），随 body 透传后端
		void sendMessage({ text, files: images.map(dataUrlToFilePart) }, { body: { ...(agentMessage ? { agentMessage } : {}) } });
	};

	// ── 排队消息（对齐桌面 followUp 队列语义）──────────────────────────────
	// pi 在回合进行中拒绝新 prompt（turnActive），所以 Web 端在客户端暂存、等回合结束再投递。
	// 队列按会话归属（切会话不丢），停止后暂停自动投递（避免「停止」后立刻又发出下一条）。
	const [queuedBySession, setQueuedBySession] = useState<Record<string, WebQueuedPrompt[]>>({});
	const queuePausedRef = useRef(false);
	const [queuePaused, setQueuePaused] = useState(false);
	const queueSeqRef = useRef(0);

	const setQueuePausedBoth = (paused: boolean) => {
		queuePausedRef.current = paused;
		setQueuePaused(paused);
	};

	const handleQueue = (text: string, images: string[], agentMessage?: string) => {
		const sessionId = activeSessionIdRef.current;
		if (!sessionId) return;
		if (!text.trim() && images.length === 0) return;
		queueSeqRef.current += 1;
		const item: WebQueuedPrompt = { id: `q-${Date.now()}-${queueSeqRef.current}`, text, images, agentMessage };
		setQueuedBySession((current) => ({ ...current, [sessionId]: [...(current[sessionId] ?? []), item] }));
		// 用户主动排队 = 解除暂停（他期待这些消息被发出）
		setQueuePausedBoth(false);
	};

	const handleRemoveQueued = (id: string) => {
		const sessionId = activeSessionIdRef.current;
		if (!sessionId) return;
		setQueuedBySession((current) => {
			const next = (current[sessionId] ?? []).filter((item) => item.id !== id);
			return { ...current, [sessionId]: next };
		});
	};

	// 队列消费：本轮结束（无流式、runtime 不在跑、无挂起 Ask）后按序投递下一条。
	// 只在当前会话消费（其他会话的队列休眠到切回去），与桌面「按会话归属」一致。
	const queueFlushingRef = useRef(false);
	useEffect(() => {
		const sessionId = activeSessionId;
		if (!sessionId) return;
		const queueForSession = queuedBySession[sessionId] ?? [];
		const flushable = shouldFlushQueuedPrompt({
			streaming,
			externalStreaming,
			runtimeStatus: activeRuntime?.status,
			// 挂起 Ask 时不自动发：用户正在回答提问，再叠一条消息会打乱对话
			hasPendingUiRequest: (state.pendingUiRequests ?? []).some((item) => item.sessionId === sessionId),
			paused: queuePausedRef.current,
			queuedCount: queueForSession.length,
			flushing: queueFlushingRef.current,
		});
		if (!flushable) return;
		const next = queueForSession[0];
		if (!next) return;
		queueFlushingRef.current = true;
		setQueuedBySession((current) => ({ ...current, [sessionId]: (current[sessionId] ?? []).slice(1) }));
		void sendMessage({ text: next.text, files: next.images.map(dataUrlToFilePart) }, { body: { ...(next.agentMessage ? { agentMessage: next.agentMessage } : {}) } }).then(
			() => {
				queueFlushingRef.current = false;
			},
			(error: unknown) => {
				queueFlushingRef.current = false;
				// 投递失败（pi 拒收/断线）：把这一条放回队首并暂停，让用户看得见、可重试或撤回——
				// 静默吞掉等于丢消息（队列条会直接从界面上消失）。
				setQueuedBySession((current) => ({ ...current, [sessionId]: [next, ...(current[sessionId] ?? [])] }));
				setQueuePausedBoth(true);
				setCommandError(error instanceof Error ? error.message : String(error));
			},
		);
	}, [activeSessionId, streaming, externalStreaming, activeRuntime?.status, state.pendingUiRequests, queuedBySession, sendMessage]);

	// 草稿期后端切换：无会话 → 暂存随下次新建生效；有会话 → 仅「本页新建零消息草稿」可写
	// catalog（历史/复制/克隆/fork 会话自带消息记录，切后端会让历史错位，一律拒绝）。
	// 切后端同时清空模型/思考偏好（pi 与 dsh/生图的模型目录不同，跨后端偏好无效）。
	const handleBackendChange = async (backend: AgentBackend) => {
		if (activeSession && (activeRuntime || backendSwitchLocked(activeSession.id))) return;
		if (!activeSession) {
			setPendingBackend(backend);
			setPendingModel(null);
			setPendingThinkingLevel(null);
			return;
		}
		setCommandError(null);
		try {
			await updateSessionRecord(activeSession.id, { backend, model: null, thinkingLevel: null });
			await refreshNow();
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	// 首页直发流程：优先内置 chat 项目（未配置项目时的兜底），否则取第一个项目；
	// 创建期间复用 creatingProjectId 短暂禁用输入，防止重复提交。
	const sendFromHome = async (text: string, images: string[], agentMessage?: string) => {
		const project = state.projects.find((candidate) => candidate.kind === "chat") ?? state.projects[0];
		if (!project) {
			setCommandError(t("web.sendNoProject"));
			return;
		}
		setCreatingProjectId(project.id);
		setCommandError(null);
		try {
			const id = await createSession(project.id, {
				...(pendingBackend ? { backend: pendingBackend } : {}),
				...(pendingModel ? { model: pendingModel } : {}),
				...(pendingThinkingLevel ? { thinkingLevel: pendingThinkingLevel } : {}),
			});
			markSessionLoaded(id, true);
			setActiveSessionId(id);
			setMobileSidebarOpen(false);
			// 会话 id 变化后 useChat 重建实例；等新实例就绪再投递（见上方 effect）
			pendingSendRef.current = { sessionId: id, text, images, ...(agentMessage ? { agentMessage } : {}) };
			await refreshNow();
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
			setConnected(false);
		} finally {
			setCreatingProjectId("");
		}
	};

	// 新会话无历史：预标记为已加载（空缓存），避免切过去时多余拉取。
	// freshDraft = 本页 createSession 新建的零消息草稿（复制/克隆/fork 不算，它们自带历史；
	// 标记只用于后端切换的开放判定，见 backendSwitchLocked）。
	const markSessionLoaded = (id: string, freshDraft = false) => {
		if (freshDraft) webDraftSessionsRef.current.add(id);
		loadedSessionsRef.current.add(id);
		messagesBySessionRef.current[id] = [];
		historyMetaRef.current[id] = { total: 0, nextBefore: null };
	};

	// 后端切换锁定：仅「本页新建且尚无任何消息」的草稿可切。已激活 runtime 的会话由调用方
	// 叠加锁定；历史会话（pi/DSH/生图）与复制/克隆/fork 出的会话一律锁死。
	const backendSwitchLocked = (sessionId: string) => !webDraftSessionsRef.current.has(sessionId) || (messagesBySessionRef.current[sessionId]?.length ?? 0) > 0 || (historyMetaRef.current[sessionId]?.total ?? 0) > 0;

	const handleCreateSession = async (projectId: string) => {
		setCreatingProjectId(projectId);
		setCommandError(null);
		try {
			const id = await createSession(projectId, {
				...(pendingBackend ? { backend: pendingBackend } : {}),
				...(pendingModel ? { model: pendingModel } : {}),
				...(pendingThinkingLevel ? { thinkingLevel: pendingThinkingLevel } : {}),
			});
			markSessionLoaded(id, true);
			setActiveSessionId(id);
			setMobileSidebarOpen(false);
			await refreshNow();
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
			setConnected(false);
		} finally {
			setCreatingProjectId("");
		}
	};

	const handleCreateProject = async (path: string): Promise<WebProject> => {
		setCommandError(null);
		try {
			const project = await createProject(path);
			await refreshNow();
			return project;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			setCommandError(message);
			throw error;
		}
	};

	const handleDeleteProject = async (projectId: string) => {
		setCommandError(null);
		try {
			const deletedSessions = state.sessions.filter((session) => session.projectId === projectId);
			await deleteProject(projectId);
			for (const session of deletedSessions) {
				delete messagesBySessionRef.current[session.id];
				delete historyMetaRef.current[session.id];
				loadedSessionsRef.current.delete(session.id);
			}
			setState((current) => ({
				...current,
				projects: current.projects.filter((project) => project.id !== projectId),
				sessions: current.sessions.filter((session) => session.projectId !== projectId),
				runtimes: current.runtimes.filter((runtime) => !deletedSessions.some((session) => session.id === runtime.sessionId)),
			}));
			if (deletedSessions.some((session) => session.id === activeSessionId)) {
				setActiveSessionId("");
			}
			setMobileSidebarOpen(false);
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const updateActiveSessionState = (patch: { model?: { provider: string; modelId: string; modelName?: string }; thinkingLevel?: string }) => {
		setState((current) => ({
			...current,
			sessions: current.sessions.map((session) => (session.id === activeSessionId ? { ...session, ...patch } : session)),
		}));
	};

	const handleModelChange = async (model: AvailableModel) => {
		if (!activeSessionId) {
			// 首页无会话：选择暂存为待用偏好，新建会话时生效
			setPendingModel(createSessionModelPreference(model.provider, model.id, model.name));
			return;
		}
		setCommandError(null);
		const selectedModel = createSessionModelPreference(model.provider, model.id, model.name);
		try {
			if (activeRuntime) {
				await setRuntimeModel(
					{
						sessionId: activeRuntime.sessionId,
						agentId: activeRuntime.agentId,
						runtimeGeneration: activeRuntime.runtimeGeneration ?? 0,
					},
					selectedModel.provider,
					selectedModel.modelId,
					selectedModel.modelName,
				);
			} else {
				await updateSessionRecord(activeSessionId, { model: selectedModel });
			}
			updateActiveSessionState({ model: selectedModel });
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const handleThinkingChange = async (level: string) => {
		if (!activeSessionId) {
			// 首页无会话：选择暂存为待用偏好，新建会话时生效
			setPendingThinkingLevel(level);
			return;
		}
		setCommandError(null);
		try {
			if (activeRuntime) {
				await setRuntimeThinking(
					{
						sessionId: activeRuntime.sessionId,
						agentId: activeRuntime.agentId,
						runtimeGeneration: activeRuntime.runtimeGeneration ?? 0,
					},
					level,
				);
			} else {
				await updateSessionRecord(activeSessionId, { thinkingLevel: level });
			}
			updateActiveSessionState({ thinkingLevel: level });
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const refreshNow = async () => {
		try {
			const next = await fetchState();
			// null = 304 未变化：保持现有 state 引用，避免无谓重渲染与下游 memo 失效
			if (next) setState(next);
			setConnected(true);
		} catch {
			setConnected(false);
		}
	};

	const handleRespondUi = async (response: AgentUiResponse) => {
		const request = (state.pendingUiRequests ?? []).find((item) => item.sessionId === activeSessionId);
		if (!request || uiResponding) return;
		setUiResponding(true);
		setCommandError(null);
		try {
			await respondToUi({
				sessionId: request.sessionId,
				requestId: request.requestId,
				agentId: request.agentId,
				runtimeGeneration: request.runtimeGeneration,
				response,
			});
			await refreshNow();
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		} finally {
			setUiResponding(false);
		}
	};

	/** 向前翻一页历史（线索按钮与搜索跳转共用）；失败保持现状，返回是否真的加了页。 */
	const loadOlderMessages = async (): Promise<boolean> => {
		if (!activeSessionId || loadingMore) return false;
		const meta = historyMetaRef.current[activeSessionId];
		if (!meta || meta.nextBefore == null) return false;
		setLoadingMore(true);
		try {
			const page = await fetchMessagePage(activeSessionId, meta.nextBefore);
			// 前插更早的消息：更新缓存与游标后，把「旧页 + 当前全部消息」重新注入
			historyMetaRef.current[activeSessionId] = {
				total: page.total,
				nextBefore: page.nextBefore,
			};
			const older = chatMessagesToUiMessages(page.messages);
			const merged = [...older, ...messagesBySessionRef.current[activeSessionId]];
			messagesBySessionRef.current[activeSessionId] = merged;
			setMessages(merged);
			return older.length > 0;
		} catch {
			// 分页失败保持现状
			return false;
		} finally {
			setLoadingMore(false);
		}
	};

	const handleLoadMore = async () => {
		// 流式期间不翻历史（与原先一致）：滚动锚点会跳，用户看不到自己在读的内容
		if (!activeSessionId || streaming) return;
		await loadOlderMessages();
	};

	// ── P1/P2/P3：会话、runtime 与消息操作（供 Header 溢出菜单 / 侧栏菜单 / 时间线 hover） ──

	/** 当前活跃会话的 runtime 命令目标（无 runtime 返回 undefined，入口按钮随之隐藏）。 */
	const activeTarget = activeRuntime
		? {
				sessionId: activeRuntime.sessionId,
				agentId: activeRuntime.agentId,
				runtimeGeneration: activeRuntime.runtimeGeneration ?? 0,
			}
		: undefined;

	/** 从磁盘重拉指定会话历史写缓存；活跃且 useChat 空闲时同步注入（streaming 中只更新缓存，不打断打字机）。 */
	const refreshSessionMessages = async (sessionId: string) => {
		if (!sessionId || refreshingSessionsRef.current.has(sessionId)) return;
		refreshingSessionsRef.current.add(sessionId);
		try {
			const page = await fetchMessagePage(sessionId);
			const history = chatMessagesToUiMessages(page.messages);
			messagesBySessionRef.current[sessionId] = history;
			historyMetaRef.current[sessionId] = { total: page.total, nextBefore: page.nextBefore };
			loadedSessionsRef.current.add(sessionId);
			// 仅活跃会话且非流式中才注入（避免切走后串台/打断 SSE 渲染）；
			// 流式结束后由 busy→idle 边沿收尾或下次切换时对齐。
			if (activeSessionIdRef.current === sessionId && statusRef.current === "ready") setMessages(history);
		} catch {
			// 刷新失败保持现状（下次轮询/操作会重试）；首次加载失败不标已加载，切回时自动重试
		} finally {
			refreshingSessionsRef.current.delete(sessionId);
		}
	};

	/** 重新拉取活跃会话历史（编辑/删除/压缩后刷新时间线）。 */
	const reloadActiveHistory = async () => {
		if (!activeSessionId) return;
		await refreshSessionMessages(activeSessionId);
	};

	/** 乐观更新本地时间线：改 per-session 缓存，目标仍是活跃会话时同步注入 useChat。 */
	const applyLocalMessages = (sessionId: string, updater: (messages: UIMessage[]) => UIMessage[]) => {
		const current = messagesBySessionRef.current[sessionId] ?? [];
		const next = updater(current);
		if (next === current) return;
		messagesBySessionRef.current[sessionId] = next;
		if (activeSessionIdRef.current === sessionId) setMessages(next);
	};

	const runSessionAction = async (action: WebSessionRowAction, sessionId: string) => {
		setCommandError(null);
		try {
			if (action === "rename") {
				const session = state.sessions.find((item) => item.id === sessionId);
				setRenameDraft({ sessionId, title: session?.title ?? "" });
				setRenameValue(session?.title ?? "");
				return;
			}
			if (action === "duplicate") {
				const newId = await copySession(sessionId);
				if (newId) markSessionLoaded(newId);
				await refreshNow();
				return;
			}
			if (action === "export") {
				await downloadSessionHtml(sessionId);
				return;
			}
			setDeleteConfirmId(sessionId);
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const confirmRename = async () => {
		if (!renameDraft) return;
		const title = renameValue.trim();
		if (!title) return;
		try {
			await renameSession(renameDraft.sessionId, title);
			setState((current) => ({ ...current, sessions: current.sessions.map((session) => (session.id === renameDraft.sessionId ? { ...session, title } : session)) }));
			setRenameDraft(null);
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const confirmDeleteSession = async () => {
		const sessionId = deleteConfirmId;
		if (!sessionId) return;
		setDeleteConfirmId(null);
		setCommandError(null);
		try {
			await deleteSession(sessionId);
			delete messagesBySessionRef.current[sessionId];
			delete historyMetaRef.current[sessionId];
			loadedSessionsRef.current.delete(sessionId);
			if (activeSessionIdRef.current === sessionId) setActiveSessionId("");
			await refreshNow();
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const runRuntimeAction = async (action: "restart" | "compact" | "clone") => {
		if (!activeTarget) return;
		setCommandError(null);
		try {
			if (action === "restart") {
				await restartRuntime(activeTarget.sessionId, activeTarget);
			} else if (action === "compact") {
				await compactRuntime(activeTarget.sessionId, activeTarget);
			} else {
				const cloned = await cloneRuntime(activeTarget.sessionId, activeTarget);
				const newId = typeof cloned.targetSessionId === "string" ? cloned.targetSessionId : "";
				if (newId) markSessionLoaded(newId);
				await refreshNow();
				if (newId) setActiveSessionId(newId);
				return;
			}
			await refreshNow();
			await reloadActiveHistory();
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const handleCopyMarkdown = async () => {
		if (!activeSessionId) return;
		const markdown = sessionUiMessagesToMarkdown(messagesBySessionRef.current[activeSessionId] ?? []);
		try {
			await navigator.clipboard.writeText(markdown || "");
		} catch {
			setCommandError(t("web.copyFailed"));
		}
	};

	/** fork 化重试（与桌面 runForkMutation 同构）：fork 到该消息 entry → 子会话以原文（重发）
	 * 或新文本（编辑）重发；旧会话打 supersededBy 从列表隐藏（文件保留，与桌面语义一致）。
	 * 策略（锚点解析/尾部判定/重投文本）在 webForkMutation.ts 纯函数层，此处只做接线与状态反馈。
	 * 失败时旧会话无恙（fork 前任何一步失败直接回滚 UI）；发送投递交给 pendingSendRef 机制
	 * （切到子会话空闲后自动 sendMessage，复用首页直发链路）。 */
	const runForkMutation = async (kind: "edit" | "resend", message: UIMessage, newText?: string) => {
		const sessionId = activeSessionIdRef.current;
		if (!sessionId || pendingMessageAction) return;
		setCommandError(null);
		setPendingMessageAction({ kind, id: message.id });
		try {
			// 冷会话：fork 是 runtime 命令，先激活（与桌面 activateRuntime 同源）；
			// 激活可能耗时数秒（pi 进程握手），期间气泡操作行显示进行中状态。
			let target = activeTarget;
			if (!target) target = await activateRuntime(sessionId);
			const entryId = await resolveWebForkEntryId(message, target, (t) => getForkMessages(sessionId, t));
			if (!entryId) {
				setCommandError(t("web.forkMissingEntryId"));
				return;
			}
			const result = await forkRuntimeSession(sessionId, target, entryId, {
				mutationFork: true,
				// 锚点不是最后一条用户消息 → 旧会话还有独属后续轮次，分支模式不隐藏（带 (fork) 后缀并存）
				branchMode: !isLastUserMessageIn(messagesBySessionRef.current[sessionId] ?? [], message.id),
			});
			if (result.cancelled) {
				setCommandError(t("web.forkCancelled"));
				return;
			}
			const newId = typeof result.targetSessionId === "string" ? result.targetSessionId : "";
			if (!newId) {
				setCommandError(t("web.forkMissingEntryId"));
				return;
			}
			const promptText = forkPromptText(kind, result, message, newText);
			const images = uiMessageImages(message);
			// 先切到子会话再排队投递：pendingSendRef 消费 effect 在会话就绪且空闲后自动 sendMessage
			markSessionLoaded(newId);
			await refreshNow();
			setActiveSessionId(newId);
			pendingSendRef.current = { sessionId: newId, text: promptText, images: images.length > 0 ? images : undefined };
		} catch (error) {
			// fork 前/中失败：旧会话无恙，刷新回服务端真相 + toast
			await reloadActiveHistory();
			setCommandError(error instanceof Error ? error.message : String(error));
		} finally {
			setPendingMessageAction(null);
		}
	};

	/** 查找消息（优先活跃 useChat 列表，回退历史缓存）——编辑/重发回调只常 messageId。 */
	const findActiveMessage = (messageId: string): UIMessage | undefined => {
		const live = messages.find((item) => item.id === messageId);
		if (live) return live;
		const cached = messagesBySessionRef.current[activeSessionIdRef.current];
		return cached?.find((item) => item.id === messageId);
	};

	const handleEditMessage = async (messageId: string, newText: string) => {
		if (pendingMessageAction) return;
		const message = findActiveMessage(messageId);
		if (!message) return;
		// pi 会话：fork 化（与桌面同语义，冷会话也可用——自动激活）；
		// DSH：保留原地编辑命令（runtime 必须存活）。
		if (activeSession?.backend !== "dsh") {
			await runForkMutation("edit", message, newText);
			return;
		}
		if (!activeTarget) return;
		setCommandError(null);
		setPendingMessageAction({ kind: "edit", id: messageId });
		// 乐观替换文本 + 确认色环：不等服务端回包（runtime 编辑要走 pi 重载，耗时数秒，干等旧文本就是本入口要修的问题）。
		applyLocalMessages(activeTarget.sessionId, (messages) => replaceMessageTextOptimistic(messages, messageId, newText));
		setFlashMessageId(messageId);
		if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
		flashTimerRef.current = setTimeout(() => setFlashMessageId(null), 1200);
		try {
			await editRuntimeMessage(activeTarget.sessionId, activeTarget, messageId, newText);
			// 服务端终态与乐观一致，静默对齐（顺带刷新 entryId 锚点），无视觉跳动。
			await reloadActiveHistory();
		} catch (error) {
			// 失败回滚到服务端真相
			await reloadActiveHistory();
			setCommandError(error instanceof Error ? error.message : String(error));
		} finally {
			setPendingMessageAction(null);
		}
	};

	const handleDeleteMessage = async (messageId: string) => {
		if (!activeTarget || pendingMessageAction) return;
		setCommandError(null);
		setPendingMessageAction({ kind: "delete", id: messageId });
		// 先播放退场动画，播完才从本地列表摘除（与服务端墓碑语义一致：只摘目标一条，回复保留）。
		setExitingMessageIds(new Set([messageId]));
		await new Promise((resolve) => setTimeout(resolve, 190));
		applyLocalMessages(activeTarget.sessionId, (messages) => removeMessageOptimistic(messages, messageId));
		setExitingMessageIds(new Set());
		try {
			await deleteRuntimeMessage(activeTarget.sessionId, activeTarget, messageId);
			await reloadActiveHistory();
		} catch (error) {
			// 失败回滚到服务端真相
			await reloadActiveHistory();
			setCommandError(error instanceof Error ? error.message : String(error));
		} finally {
			setPendingMessageAction(null);
		}
	};

	const handleResendMessage = async (messageId: string) => {
		if (pendingMessageAction) return;
		const message = findActiveMessage(messageId);
		if (!message) return;
		// pi 会话：fork 化重发（与桌面同语义；旧会话隐藏、子会话自动重投，冷会话也可用）；
		// DSH：保留 prepare-resend 填回 composer（DSH 无 fork 化命令）。
		if (activeSession?.backend !== "dsh") {
			await runForkMutation("resend", message);
			return;
		}
		if (!activeTarget) return;
		setCommandError(null);
		try {
			const prepared = await prepareResend(activeTarget.sessionId, activeTarget, messageId);
			setPrefill({ text: prepared.text ?? "", nonce: Date.now() });
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	const handlePermissionChange = async (preset: string) => {
		if (!activeTarget || !activeSessionId) return;
		setCommandError(null);
		try {
			await setRuntimePermission(activeTarget, preset);
			// 先乐观更新本地记录，事件流确认后由轮询收敛
			setState((current) => ({ ...current, sessions: current.sessions.map((session) => (session.id === activeSessionId ? { ...session, permissionPreset: preset } : session)) }));
		} catch (error) {
			setCommandError(error instanceof Error ? error.message : String(error));
		}
	};

	// P2：上下文用量随主轮询节奏拉取（活跃 runtime 存在时；无 runtime 清空圆环）
	useEffect(() => {
		if (!activeTarget) {
			setContextUsage(undefined);
			return;
		}
		let disposed = false;
		const load = async () => {
			try {
				const usage = await fetchRuntimeContextUsage(activeTarget.sessionId, activeTarget);
				if (!disposed) setContextUsage(usage);
			} catch {
				// runtime 退出/竞态时静默，下一轮轮询自然收敛
			}
		};
		void load();
		// 2027-02 性能审计治理：每次 load 都向 pi 子进程发 get_state + get_session_stats
		// 两个 RPC（还叠加会话文件缓存命中率扫描）。原先流式 1s/空闲 3s 永续轮询，
		// SSE 连通也不降档、页面隐藏也不停——生成期间对正在出 token 的 pi 稳定叠加
		// 2 RPC/s，空闲时只要手机挂着会话页就 3s 一次永久打扰。现在：
		// - document.hidden 跳过（回到前台由下一档补齐）；
		// - 流式 1s 保留（圆环要跟手）但 SSE 连通时放宽到 3s（状态推送兜底可感知翻转）；
		// - 空闲 3s → 10s（用量圆环不需要秒级新鲜度）。
		const intervalMs = streaming ? (stateEventsConnected ? 3000 : 1000) : 10_000;
		const timer = setInterval(() => {
			if (document.hidden) return;
			void load();
		}, intervalMs);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
		// activeTarget 每次渲染都是新对象，改用稳定原始字段做依赖
	}, [activeTarget?.sessionId, activeTarget?.agentId, activeTarget?.runtimeGeneration, streaming, stateEventsConnected]);

	// 头部运行态：流式优先；否则用轮询到的 runtime 状态兜底
	const headerStatus: WebHeaderStatus = (() => {
		if (streaming) return "running";
		const runtimeStatus = activeRuntime?.status;
		if (runtimeStatus === "starting") return "starting";
		if (runtimeStatus === "running") return "running";
		if (runtimeStatus === "error") return "error";
		return "idle";
	})();

	const activeMeta = activeSessionId ? historyMetaRef.current[activeSessionId] : undefined;
	const hasMoreHistory = Boolean(activeMeta && activeMeta.nextBefore != null && !streaming);
	const moreCount = activeMeta ? Math.max(0, activeMeta.total - messagesBySessionRef.current[activeSessionId]?.length) : 0;

	// 展示合并：外部流式消息作为最后一个 user 之后的新一轮 assistant 回复插入；
	// 深分页窗口里 user 消息被翻出视口时（lastUserIndex<0）退化为尾部追加，
	// 极端场景可能与窗口内旧尾巴短暂并存，收尾磁盘重拉后自然收敛。
	const lastUserIndex = liveMessage ? messages.map((message) => message.role).lastIndexOf("user") : -1;
	const timelineMessages = liveMessage && lastUserIndex >= 0 ? [...messages.slice(0, lastUserIndex + 1), liveMessage] : liveMessage ? [...messages, liveMessage] : messages;
	// 外部流已在渲染同一轮时不挂传输层错误条：断流后由外部流回放接管，
	// 两边同时显示会出现「Network error + 正文在输出」的错乱观感。
	const transportError = error && !externalStreaming && !liveMessage ? error.message : null;
	const combinedStreaming = streaming || externalStreaming;
	// 输入区的「回合占用」判定还要算上 runtime 仍在跑的情况（刷新页面/切后台回来后本端没在
	// 拉流、pi 却还在生成）：此时发送必须走排队而不是直接派发——pi 会以 turnActive 拒收，
	// 用户只会看到一条报错而消息丢失。时间线的流式指示仍只看 combinedStreaming。
	const composerTurnBusy = combinedStreaming || activeRuntime?.status === "running" || activeRuntime?.status === "starting";
	const composerHidden = resolveComposerHidden({ headerHidden, nearBottom, streaming: combinedStreaming, engaged: composerEngaged });

	return (
		<div className="app web-app wechat-shell flex h-[100dvh] w-full min-w-0 overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground [[data-bg-image=on]_&]:bg-transparent" data-header-hidden={headerHidden ? "on" : undefined}>
			<WebSidebar
				state={state}
				activeSessionId={activeSessionId}
				creatingProjectId={creatingProjectId}
				connected={connected}
				mobileOpen={mobileSidebarOpen}
				onCloseMobile={() => setMobileSidebarOpen(false)}
				onSelectSession={(sessionId) => {
					setActiveSessionId(sessionId);
					setMobileSidebarOpen(false);
				}}
				onSessionAction={(action, sessionId) => void runSessionAction(action, sessionId)}
				onCreateSession={(projectId) => void handleCreateSession(projectId)}
				onCreateProject={handleCreateProject}
				onDeleteProject={handleDeleteProject}
			/>
			<main className="chat-pane flex h-full min-w-0 flex-1 flex-col overflow-hidden bg-bg-panel" onTouchStart={onMainTouchStart} onTouchMove={onMainTouchMove} onTouchEnd={onMainTouchEnd} onTouchCancel={onMainTouchEnd}>
				<WebHeader
					headerHidden={headerHidden}
					title={activeSession?.title || t("web.chooseSession")}
					status={headerStatus}
					onOpenSidebar={() => setMobileSidebarOpen(true)}
					backend={activeSession?.backend}
					contextUsage={contextUsage}
					// 额度用量归属：优先 runtime 直报的供应商（跟随当次实际模型），退回会话记录的模型供应商；
					// 后端按会话后端走，DSH 会话才会用 dsh 链的用量探针。
					usageProvider={contextUsage?.provider ?? activeSession?.model?.provider}
					usageBackend={activeSession?.backend === "dsh" ? "dsh" : "pi"}
					permissionPreset={contextUsage?.permissionPreset ?? activeSession?.permissionPreset}
					actions={{
						onPermissionChange: activeSession?.backend === "dsh" ? (preset) => void handlePermissionChange(preset) : undefined,
						onOpenWorkspace: activeSession ? () => setWorkspaceOpen(true) : undefined,
						onRename: activeSessionId ? () => void runSessionAction("rename", activeSessionId) : undefined,
						onDuplicate: activeSessionId ? () => void runSessionAction("duplicate", activeSessionId) : undefined,
						onExportHtml: activeSessionId ? () => void runSessionAction("export", activeSessionId) : undefined,
						onCopyMarkdown: activeSessionId ? () => void handleCopyMarkdown() : undefined,
						onRefreshMessages: activeSessionId ? () => void refreshSessionMessages(activeSessionId) : undefined,
						onRestart: activeTarget ? () => void runRuntimeAction("restart") : undefined,
						onCompact: activeTarget ? () => void runRuntimeAction("compact") : undefined,
						onClone: activeTarget ? () => void runRuntimeAction("clone") : undefined,
						onDelete: activeSessionId ? () => void runSessionAction("delete", activeSessionId) : undefined,
					}}
					onOpenDshTools={() => setDshToolsOpen(true)}
					onOpenSearch={() => setSearchOpen(true)}
					themePreference={themePreference}
					resolvedTheme={resolvedTheme}
					onCycleTheme={cycleTheme}
					canInstall={canInstall}
					onInstall={() => void install()}
					onOpenAssets={() => setAssetsOpen(true)}
				/>
				{/* P3：fork 家族分支导航（家族只有一条会话时自渲染为 null） */}
				<WebBranchBar sessions={state.sessions} activeSessionId={activeSessionId} onSelect={(sessionId) => setActiveSessionId(sessionId)} />
				{/* 第二批：断线恢复提示（几秒后自动消失） */}
				{recoveryNotice ? <div className="border-b border-border bg-primary/10 px-3 py-1 text-center text-xs text-primary">{recoveryNotice}</div> : null}
				{/* 令牌失效提示：不会自愈，需用户从桌面端重新分享；重试仅覆盖「服务端已恢复同 token」的场景 */}
				{authExpired ? (
					<div className="flex items-center justify-center gap-2 border-b border-border bg-destructive/10 px-3 py-1.5 text-center text-xs text-destructive">
						<span>{t("web.authExpired")}</span>
						<Button variant="outline" size="sm" className="h-6 px-2 text-micro" onClick={() => window.location.reload()}>
							{t("web.authExpiredRetry")}
						</Button>
					</div>
				) : null}
				<WebTimeline
					messages={timelineMessages}
					hasActiveSession={Boolean(activeSession)}
					hasMoreHistory={hasMoreHistory}
					moreCount={moreCount}
					loadingMore={loadingMore}
					streaming={combinedStreaming}
					error={transportError ?? commandError}
					pendingUiRequest={(state.pendingUiRequests ?? []).find((item) => item.sessionId === activeSessionId)}
					uiResponding={uiResponding}
					onRespondUi={(response) => void handleRespondUi(response)}
					onLoadMore={() => void handleLoadMore()}
					onScrollTopChange={handleTimelineScroll}
					onNearBottomChange={handleNearBottomChange}
					canManageMessages={activeSession?.backend !== "dsh" || Boolean(activeTarget)}
					canDeleteMessage={Boolean(activeTarget)}
					pendingMessageAction={pendingMessageAction}
					exitingMessageIds={exitingMessageIds}
					flashMessageId={flashMessageId}
					onEditMessage={(messageId, newText) => void handleEditMessage(messageId, newText)}
					onDeleteMessage={(messageId) => void handleDeleteMessage(messageId)}
					onResendMessage={(messageId) => void handleResendMessage(messageId)}
					onOpenFile={openFilePreview}
				/>
				<WebSessionStrips sessionId={activeSessionId} />
				<WebComposer
					hasSession={Boolean(activeSessionId)}
					disabled={Boolean(creatingProjectId)}
					streaming={composerTurnBusy}
					prefill={prefill ?? undefined}
					onSend={handleSend}
					onStop={handleStop}
					backend={activeSession?.backend ?? pendingBackend ?? "pi"}
					backendLocked={activeSession ? Boolean(activeRuntime) || backendSwitchLocked(activeSession.id) : false}
					onBackendChange={(backend) => void handleBackendChange(backend)}
					model={activeSession?.model ?? pendingModel ?? undefined}
					models={models}
					refreshingModels={modelsRefreshing}
					onRefreshModels={() => void refreshModels()}
					onModelChange={(model) => void handleModelChange(model)}
					thinkingLevel={activeSession?.thinkingLevel ?? pendingThinkingLevel ?? undefined}
					onThinkingChange={(level) => void handleThinkingChange(level)}
					onFocusChange={(focused) => {
						if (focused) revealHeader();
					}}
					onEngagedChange={handleComposerEngagedChange}
					hidden={composerHidden}
					onQueue={handleQueue}
					queued={(queuedBySession[activeSessionId] ?? []).map((item) => ({ id: item.id, text: item.text, imageCount: item.images.length }))}
					onRemoveQueued={handleRemoveQueued}
					queuePaused={queuePaused}
					onResumeQueue={() => setQueuePausedBoth(false)}
				/>
			</main>
			{/* S6.3：DSH 工具面板（仅 dsh 会话头部按钮触发） */}
			{/* 第二批：会话内搜索（Ctrl+K）与技能/扩展面板 */}
			<WebSearchDialog open={searchOpen} onOpenChange={setSearchOpen} sessionId={activeSessionId} messages={messages} onJump={jumpToSearchHit} />
			<WebSkillsExtensionsDialog open={assetsOpen} onOpenChange={setAssetsOpen} />
			{dshToolsOpen && activeSessionId && <WebDshToolsPanel sessionId={activeSessionId} onClose={() => setDshToolsOpen(false)} />}
			{/* P3：工作区抽屉（Git 状态/diff + 文件浏览，projectId 来自活跃会话） */}
			{workspaceOpen && activeSession && <WebWorkspaceDrawer projectId={activeSession.projectId} open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} onOpenFile={openFilePreview} />}
			{/* 第三批：文件/diff 全屏预览（消息文件链接 + 文件变更 strip chip） */}
			{filePreview ? <WebFilePreview target={filePreview} onClose={() => setFilePreview(null)} /> : null}
			{/* P1：重命名会话对话框 */}
			<Dialog open={renameDraft != null} onOpenChange={(open) => (!open ? setRenameDraft(null) : undefined)}>
				<DialogContent className="max-w-sm">
					<DialogHeader>
						<DialogTitle>{t("web.renameTitle")}</DialogTitle>
					</DialogHeader>
					<Input value={renameValue} onChange={(event) => setRenameValue(event.target.value)} placeholder={t("web.renamePlaceholder")} onKeyDown={(event) => (event.key === "Enter" ? void confirmRename() : undefined)} />
					<DialogFooter>
						<Button type="button" variant="ghost" size="sm" onClick={() => setRenameDraft(null)}>
							{t("common.cancel")}
						</Button>
						<Button type="button" size="sm" disabled={!renameValue.trim()} onClick={() => void confirmRename()}>
							{t("common.confirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
			{/* P1：删除会话确认（不可恢复操作走 AlertDialog 双保险） */}
			<AlertDialog open={deleteConfirmId != null} onOpenChange={(open) => (!open ? setDeleteConfirmId(null) : undefined)}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("web.deleteSessionConfirmTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("web.deleteSessionConfirmBody")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
						<AlertDialogAction className="bg-danger text-danger-foreground hover:bg-danger/90" onClick={() => void confirmDeleteSession()}>
							{t("common.delete")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	);
}
