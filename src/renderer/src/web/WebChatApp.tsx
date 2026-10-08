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
import type { AgentBackend, AvailableModel } from "../../../shared/types";
import { createSessionModelPreference } from "../../../shared/modelDisplayName";
import { t } from "@/i18n";
import { WebSidebar, type WebSessionRowAction } from "./WebSidebar";
import { WebHeader, type WebHeaderStatus } from "./WebHeader";
import { WebTimeline } from "./WebTimeline";
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
import { abortRuntime, cloneRuntime, compactRuntime, copySession, deleteSession, downloadSessionHtml, editRuntimeMessage, deleteRuntimeMessage, prepareResend, renameSession, restartRuntime } from "./webApi";
import { fetchRuntimeContextUsage, setRuntimePermission } from "./webApi";
import { sessionUiMessagesToMarkdown } from "./webMarkdown";
import { removeMessageOptimistic, replaceMessageTextOptimistic } from "./webMessageOptimistic";
import { WebSessionStrips } from "./WebSessionStrips";
import { WebFilePreview, type WebFilePreviewTarget } from "./WebFilePreview";
import { WebSearchDialog } from "./WebSearchDialog";
import { WebSkillsExtensionsDialog } from "./WebSkillsExtensionsDialog";
import { applyWebTheme, readStoredWebTheme, resolveWebTheme, storeWebTheme, systemPrefersDark, type ResolvedWebTheme, type WebThemePreference } from "./webTheme";
import { registerWebServiceWorker, usePwaInstall } from "./webPwa";
import { decideStreamRecovery } from "./webStreamRecovery";
import { useExternalSessionStream } from "./webExternalStream";
import { useWebStateEvents } from "./webStateEvents";
import type { AgentUiResponse } from "../../../shared/types";
import type { WebProject, WebRuntime, WebState, WebContextUsage } from "./webTypes";

/** 分页元数据：已加载消息总数 + 更早一页的游标。 */
type HistoryMeta = {
	total: number;
	nextBefore: number | null;
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
	const [pendingMessageAction, setPendingMessageAction] = useState<{ kind: "edit" | "delete"; id: string } | null>(null);
	const [exitingMessageIds, setExitingMessageIds] = useState<ReadonlySet<string>>(new Set());
	const [flashMessageId, setFlashMessageId] = useState<string | null>(null);
	const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	// P2：上下文用量（随主轮询拉取 runtime state 子集）
	const [contextUsage, setContextUsage] = useState<WebContextUsage | undefined>(undefined);

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
	const pendingSendRef = useRef<{ sessionId: string; text: string; images?: string[] } | null>(null);

	// useChat：sessionId 作为 chat id；切会话时 id 变化重建 Chat 实例
	const { messages, sendMessage, status, stop, setMessages, error } = useChat({
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
		const next: WebThemePreference = themePreference === "light" ? "dark" : themePreference === "dark" ? "system" : "light";
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
	const stateRefreshRef = useRef<() => void>(() => {});
	const stateEventsConnected = useWebStateEvents(() => stateRefreshRef.current());
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
	const openDiffPreview = useCallback((path: string) => {
		const project = previewProjectRef.current;
		if (!project?.root) return;
		setFilePreview({ kind: "diff", projectId: project.id, projectRoot: project.root, path });
	}, []);

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
		void sendMessage({ text: pending.text }, { body: { images: pending.images ?? [] } });
	}, [activeSessionId, streaming, sendMessage]);

	// 模型列表是全局 pi 配置，草稿会话也需要先选模型再发送第一条消息。
	useEffect(() => {
		void fetchModels()
			.then(setModels)
			.catch(() => setModels([]));
	}, []);

	// 低频轮询项目/会话/运行态（3s；useChat 负责消息流，不参与轮询）
	useEffect(() => {
		let disposed = false;
		const refresh = async () => {
			try {
				const next = await fetchState();
				if (disposed) return;
				setState(next);
				setConnected(true);
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
	const handleSend = (text: string, images: string[]) => {
		if (!text.trim() && images.length === 0) return;
		if (!activeSessionId) {
			void sendFromHome(text, images);
			return;
		}
		void sendMessage({ text }, { body: { images } });
	};

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
	const sendFromHome = async (text: string, images: string[]) => {
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
			pendingSendRef.current = { sessionId: id, text, images };
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
			setState(await fetchState());
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

	const handleLoadMore = async () => {
		if (!activeSessionId || streaming || loadingMore) return;
		const meta = historyMetaRef.current[activeSessionId];
		if (!meta || meta.nextBefore == null) return;
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
		} catch {
			// 分页失败保持现状
		} finally {
			setLoadingMore(false);
		}
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
				const newId = cloned.session?.id;
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

	const handleEditMessage = async (messageId: string, newText: string) => {
		if (!activeTarget || pendingMessageAction) return;
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
		const timer = setInterval(load, streaming ? 1000 : 3000);
		return () => {
			disposed = true;
			clearInterval(timer);
		};
		// activeTarget 每次渲染都是新对象，改用稳定原始字段做依赖
	}, [activeTarget?.sessionId, activeTarget?.agentId, activeTarget?.runtimeGeneration, streaming]);

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
	const combinedStreaming = streaming || externalStreaming;

	return (
		<div className="app web-app wechat-shell flex h-[100dvh] w-full min-w-0 overflow-hidden bg-background pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] text-foreground [[data-bg-image=on]_&]:bg-transparent">
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
					title={activeSession?.title || t("web.chooseSession")}
					status={headerStatus}
					onOpenSidebar={() => setMobileSidebarOpen(true)}
					backend={activeSession?.backend}
					contextUsage={contextUsage}
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
				<WebTimeline
					messages={timelineMessages}
					hasActiveSession={Boolean(activeSession)}
					hasMoreHistory={hasMoreHistory}
					moreCount={moreCount}
					loadingMore={loadingMore}
					streaming={combinedStreaming}
					error={error?.message ?? commandError}
					pendingUiRequest={(state.pendingUiRequests ?? []).find((item) => item.sessionId === activeSessionId)}
					uiResponding={uiResponding}
					onRespondUi={(response) => void handleRespondUi(response)}
					onLoadMore={() => void handleLoadMore()}
					canManageMessages={Boolean(activeTarget)}
					pendingMessageAction={pendingMessageAction}
					exitingMessageIds={exitingMessageIds}
					flashMessageId={flashMessageId}
					onEditMessage={(messageId, newText) => void handleEditMessage(messageId, newText)}
					onDeleteMessage={(messageId) => void handleDeleteMessage(messageId)}
					onResendMessage={(messageId) => void handleResendMessage(messageId)}
					onOpenFile={openFilePreview}
				/>
				<WebSessionStrips sessionId={activeSessionId} onOpenFileChange={openDiffPreview} />
				<WebComposer
					disabled={Boolean(creatingProjectId)}
					streaming={combinedStreaming}
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
				/>
			</main>
			{/* S6.3：DSH 工具面板（仅 dsh 会话头部按钮触发） */}
			{/* 第二批：会话内搜索（Ctrl+K）与技能/扩展面板 */}
			<WebSearchDialog open={searchOpen} onOpenChange={setSearchOpen} messages={messages} onJump={scrollToMessage} />
			<WebSkillsExtensionsDialog open={assetsOpen} onOpenChange={setAssetsOpen} />
			{dshToolsOpen && activeSessionId && <WebDshToolsPanel sessionId={activeSessionId} onClose={() => setDshToolsOpen(false)} />}
			{/* P3：工作区抽屉（Git 状态/diff + 文件浏览，projectId 来自活跃会话） */}
			{workspaceOpen && activeSession && <WebWorkspaceDrawer projectId={activeSession.projectId} open={workspaceOpen} onClose={() => setWorkspaceOpen(false)} />}
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
