import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import type { AgentBackend, AvailableModel, MiniOverlayState, ResolvedLaunchDefaults, SessionLaunchPreferences, SessionModelPreference, SessionRecord } from "../../../shared/types";
import { createSessionModelPreference } from "../../../shared/modelDisplayName";
import { currentSessionAtom, effectiveAgentBackendAtom, projectInventoryAtom } from "../atoms";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";

export type MiniOverlayWorkspaceOptions = {
	activeProjectId?: string;
	onCreateSession: (projectId: string, preferences: SessionLaunchPreferences, backend: AgentBackend) => Promise<SessionRecord | undefined>;
	onOpenSession: (projectId: string, sessionId: string) => Promise<string | undefined>;
};

/** 浮窗导航持久化 key：浮窗是独立渲染进程且 hide 即销毁，导航状态必须落 localStorage 才能跨重建保留。
 *  同源下与主窗口共享存储，用 miniOverlay: 前缀隔离，只存最后浏览的会话页。 */
const MINI_OVERLAY_WORKSPACE_KEY = "miniOverlay:workspace";

interface PersistedMiniOverlayWorkspace {
	view: "home" | "new" | "session";
	sessionId?: string;
	projectId?: string;
}

/** 恢复目标（仅会话页）：字段必填，避免使用处再收窄。 */
interface RestorableSessionTarget {
	view: "session";
	sessionId: string;
	projectId: string;
}

function readPersistedWorkspace(): RestorableSessionTarget | null {
	try {
		const raw = window.localStorage.getItem(MINI_OVERLAY_WORKSPACE_KEY);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return null;
		const record = parsed as Partial<PersistedMiniOverlayWorkspace>;
		if (record.view !== "session" || typeof record.sessionId !== "string" || typeof record.projectId !== "string") return null;
		return { view: "session", sessionId: record.sessionId, projectId: record.projectId };
	} catch {
		return null;
	}
}

/** 小窗导航与新建草稿的唯一 owner；复用会话命令，不自建第二套激活/目录状态。 */
export function useMiniOverlayWorkspace(options: MiniOverlayWorkspaceOptions) {
	const projects = useAtomValue(projectInventoryAtom);
	const session = useAtomValue(currentSessionAtom);
	const backend = useAtomValue(effectiveAgentBackendAtom);
	const [view, setView] = useState<"home" | "new" | "session">(session ? "session" : "home");
	const [projectId, setProjectId] = useState(session?.projectId ?? options.activeProjectId);
	const [selectedModel, setSelectedModel] = useState<{ projectId?: string; backend: AgentBackend; model: SessionModelPreference }>();
	const [defaults, setDefaults] = useState<ResolvedLaunchDefaults>();
	const [recentSessions, setRecentSessions] = useState<SessionRecord[]>([]);
	const [recentLoading, setRecentLoading] = useState(false);
	const [recentFailed, setRecentFailed] = useState(false);
	/** 主进程推的运行中会话：与悬浮球角标同源，跨项目直达入口的数据源。 */
	const [activeSessions, setActiveSessions] = useState<MiniOverlayState["activeSessions"]>([]);
	const [creating, setCreating] = useState(false);
	const [openingSessionId, setOpeningSessionId] = useState<string>();
	const pendingRef = useRef(false);
	const mountedRef = useRef(true);
	const commandsRef = useRef(options);
	commandsRef.current = options;
	const previousSessionIdRef = useRef(session?.id);
	// 恢复未决期间抑制持久化写入，避免 bootstrap 激活的其他会话覆盖待恢复目标。
	const restorePendingRef = useRef(true);
	const project = projects.find((item) => item.id === projectId);
	// 点选只属于当前项目/后端，切目录不能带入另一项目的局部模型。
	const model = selectedModel?.projectId === projectId && selectedModel?.backend === backend ? selectedModel.model : undefined;

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// 运行中会话：先 getState 补齐订阅前可能错过的首推，再靠推送持续更新。
	useEffect(() => {
		let cancelled = false;
		const apply = (state: MiniOverlayState) => {
			if (!cancelled) setActiveSessions(state.activeSessions ?? []);
		};
		void desktopApi.miniOverlay
			.getState()
			.then((state) => {
				if (state) apply(state);
			})
			.catch(() => undefined);
		const off = desktopApi.miniOverlay.onStateChanged(apply);
		return () => {
			cancelled = true;
			off();
		};
	}, []);

	// 打开浮窗时恢复上次浏览的会话页：收起/重建后不回到主页，由用户手动点主页返回。
	useEffect(() => {
		const persisted = readPersistedWorkspace();
		if (!persisted || session?.id === persisted.sessionId) {
			restorePendingRef.current = false;
			return;
		}
		void commandsRef.current
			.onOpenSession(persisted.projectId, persisted.sessionId)
			.then((opened) => {
				if (opened && mountedRef.current) setView("session");
			})
			.catch(() => {
				// 会话/项目已不存在则留在主页，不提示。
			})
			.finally(() => {
				restorePendingRef.current = false;
			});
		// eslint-disable-next-line react-hooks/exhaustive-deps -- 仅 mount 时恢复一次，后续 session 变化由导航 effect 接管。
	}, []);

	// 按当前导航持久化：会话页记下会话身份；主页/新建页清除恢复目标（下次打开停主页）。
	useEffect(() => {
		if (restorePendingRef.current) return;
		try {
			const entry: PersistedMiniOverlayWorkspace = view === "session" && session ? { view: "session", sessionId: session.id, projectId: session.projectId } : { view: view === "new" ? "new" : "home" };
			window.localStorage.setItem(MINI_OVERLAY_WORKSPACE_KEY, JSON.stringify(entry));
		} catch {
			// 存储异常（隐私模式/配额）不影响导航本身。
		}
	}, [view, session?.id, session?.projectId]);

	useEffect(() => {
		if (session && session.id !== previousSessionIdRef.current) {
			setProjectId(session.projectId);
			setView("session");
		}
		previousSessionIdRef.current = session?.id;
	}, [session?.id, session?.projectId]);

	useEffect(() => {
		let cancelled = false;
		setDefaults(undefined);
		void desktopApi.sessions
			.resolveLaunchDefaults({ backend })
			.then((next) => {
				if (!cancelled) setDefaults(next);
			})
			.catch(() => {
				// 默认值展示失败不阻止创建；主进程仍按创建瞬间的配置解析。
			});
		return () => {
			cancelled = true;
		};
	}, [backend]);

	useEffect(() => {
		let cancelled = false;
		setRecentSessions([]);
		setRecentFailed(false);
		setRecentLoading(Boolean(projectId && !project?.missing && view === "home"));
		if (projectId && !project?.missing && view === "home") {
			void desktopApi.sessions
				.listCatalog(projectId)
				.then((records) => {
					if (cancelled) return;
					setRecentSessions(
						records
							.filter((item) => !item.parentSessionId && !item.parentSessionPath && !item.noSession)
							.sort((a, b) => b.updatedAt - a.updatedAt)
							.slice(0, 5),
					);
					setRecentLoading(false);
				})
				.catch(() => {
					if (cancelled) return;
					setRecentFailed(true);
					setRecentLoading(false);
				});
		}
		return () => {
			cancelled = true;
		};
	}, [projectId, project?.missing, view, session?.id]);

	const selectProject = useCallback((id: string) => {
		setProjectId(id);
		setSelectedModel(undefined);
	}, []);
	const selectModel = useCallback(
		(next: AvailableModel) => {
			setSelectedModel({ projectId, backend, model: createSessionModelPreference(next.provider, next.id, next.name) });
		},
		[projectId, backend],
	);
	const showNewSession = useCallback(() => {
		setSelectedModel(undefined);
		setView("new");
	}, []);
	const showHome = useCallback(() => setView("home"), []);
	const showSession = useCallback(() => {
		if (session) setView("session");
	}, [session]);

	const createSession = useCallback(async () => {
		if (!project || project.missing || pendingRef.current) return;
		pendingRef.current = true;
		setCreating(true);
		try {
			// 只有用户显式点选才传 model；只读预览的默认值不能固化成创建偏好。
			const record = await commandsRef.current.onCreateSession(project.id, model ? { model } : {}, backend);
			if (record && mountedRef.current) setView("session");
		} catch {
			if (mountedRef.current) showNotice(t("miniOverlay.createSessionFailed"), 4000, "error");
		} finally {
			pendingRef.current = false;
			if (mountedRef.current) setCreating(false);
		}
	}, [project, model, backend]);
	const openSession = useCallback(
		async (id: string) => {
			if (!project || project.missing || pendingRef.current) return;
			pendingRef.current = true;
			setOpeningSessionId(id);
			try {
				const opened = await commandsRef.current.onOpenSession(project.id, id);
				if (opened && mountedRef.current) setView("session");
			} catch {
				if (mountedRef.current) showNotice(t("miniOverlay.openSessionFailed"), 4000, "error");
			} finally {
				pendingRef.current = false;
				if (mountedRef.current) setOpeningSessionId(undefined);
			}
		},
		[project],
	);
	// 活动会话自带 projectId，不依赖主页当前选中的项目。
	const openActiveSession = useCallback(async (id: string, activeProjectId: string) => {
		if (pendingRef.current) return;
		pendingRef.current = true;
		setOpeningSessionId(id);
		try {
			const opened = await commandsRef.current.onOpenSession(activeProjectId, id);
			if (opened && mountedRef.current) setView("session");
		} catch {
			if (mountedRef.current) showNotice(t("miniOverlay.openSessionFailed"), 4000, "error");
		} finally {
			pendingRef.current = false;
			if (mountedRef.current) setOpeningSessionId(undefined);
		}
	}, []);

	return {
		view,
		projects,
		project,
		session,
		backend,
		displayModel: model ?? defaults?.model,
		selectedModel: model,
		recentSessions,
		recentLoading,
		recentFailed,
		activeSessions,
		creating,
		openingSessionId,
		selectProject,
		selectModel,
		clearModel: () => setSelectedModel(undefined),
		showNewSession,
		showHome,
		showSession,
		createSession,
		openSession,
		openActiveSession,
	};
}

export type MiniOverlayWorkspace = ReturnType<typeof useMiniOverlayWorkspace>;
