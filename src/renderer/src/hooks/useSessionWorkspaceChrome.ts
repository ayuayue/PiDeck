import { useCallback, useEffect, useRef, useState } from "react";
import { useAtomValue, useSetAtom, useStore } from "jotai";
import { currentSessionIdAtom, projectInventoryByIdAtom, sessionRecordByIdAtomFamily, sessionRecordsAtom, sessionTabIdsAtom } from "../atoms";
import { cycleSessionTab, openPermanentSessionTab, openPreviewSessionTab, togglePinSessionTab, type SessionTabOpenMode } from "../utils/sessionTabs";
import { GUIDE_BOOTSTRAP_SESSION_ID } from "../utils/chatSessionBootstrap";
import { buildSessionTabBarEntries, flattenSessionTabBarEntries, reorderSessionTabsByDisplayOrder, GROUP_COLOR_VALUES } from "../utils/sessionTabGroups";
import { buildSplitLayoutFromDrop, edgeToOrientation, insertRootPaneFromDrop, nestSplitPaneFromDrop, replaceSplitPaneFromDrop, resolveSplitAfterClose, resolveSplitHostSessionId, splitLayoutSessionIds, type SessionSplitDropTarget, type SessionSplitLayout } from "../utils/sessionSplitEdge";
import { desktopApi } from "../desktopApi";
import { buildSessionIdAliasMap, remapSessionIds } from "../../../shared/sessionIdAliases";
import { isRendererVirtualSessionId } from "../../../shared/rendererVirtualSessionId";
import type { FocusTargetPayload } from "../../../shared/types";

const PINNED_TABS_STORAGE_KEY = "pideck.pinnedSessionTabIds";
const SPLIT_GROUP_COLLAPSED_KEY = "pideck.splitGroupCollapsed";
const SPLIT_GROUP_CONFIG_KEY = "pideck.splitGroupConfig";
/** 分屏组默认颜色（色板第一个，蓝色）——直接取共用色板，避免第三份副本 */
export const SPLIT_GROUP_DEFAULT_COLOR = GROUP_COLOR_VALUES[0];

export type SessionWorkspaceFocusHandlers = {
	/** 切换当前会话焦点（不改 Tab 预览/常驻状态） */
	focusSession: (projectId: string, sessionId: string) => void;
	/** 无剩余 Tab 时回到项目空态 */
	focusProject: (projectId: string) => void;
	/** 文件夹右键打开未收录目录：弹确认框引导新增项目（App 注入） */
	focusOpenProjectPath?: (path: string) => void;
};

/**
 * #354：先把 Tab 列表/置顶里的归并历史 ID 迁移到存活 ID，再剔除**确认已删除**的记录。
 *
 * 删除判据是「本次运行加载过（`seenSessionIds`）且当前 `sessionRecords` 里已不在」：项目目录按需
 * 加载，启动首帧的空记录表和尚未展开的项目都不代表记录被删，不能凭它们清掉用户的置顶/Tab。
 * 无变化时返回原引用，让 React state 去抖与 localStorage 写入都不白跑。
 */
export function migrateAndPruneSessionTabIds(current: string[], aliases: ReadonlyMap<string, string>, sessionRecords: Readonly<Record<string, unknown>>, seenSessionIds: ReadonlySet<string>): string[] {
	const remapped = remapSessionIds(current, aliases);
	const next = remapped.filter((id) => !isRendererVirtualSessionId(id) && (!seenSessionIds.has(id) || Boolean(sessionRecords[id])));
	return remapped === current && next.length === current.length ? current : next;
}

/**
 * 会话工作区 chrome：Tab 列表 / 预览 / Pin / 分屏 / 拖拽落点。
 *
 * 与「选中哪个会话」正交——选中由 useSessionActions 负责；本 hook 只登记/维护
 * 顶栏与分屏布局。App 只做装配，不写 chrome 业务分支。
 */
export function useSessionWorkspaceChrome(options: { currentSessionId: string | undefined; activeProjectId: string | undefined }) {
	const { currentSessionId, activeProjectId } = options;
	const store = useStore();
	const sessionTabIds = useAtomValue(sessionTabIdsAtom);
	const setSessionTabIds = useSetAtom(sessionTabIdsAtom);
	const sessionRecords = useAtomValue(sessionRecordsAtom);

	const focusHandlersRef = useRef<SessionWorkspaceFocusHandlers>({
		focusSession: () => undefined,
		focusProject: () => undefined,
	});

	const [pinnedSessionTabIds, setPinnedSessionTabIds] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem(PINNED_TABS_STORAGE_KEY);
			const parsed = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string" && !isRendererVirtualSessionId(id)) : [];
		} catch {
			return [];
		}
	});
	const [previewSessionTabId, setPreviewSessionTabId] = useState<string | null>(null);
	/** 本次运行加载过的会话记录 id：Tab/pin 只清理「见过又消失」的项，详见下方清理 effect。 */
	const seenSessionIdsRef = useRef<Set<string>>(new Set());
	const [splitLayout, setSplitLayout] = useState<SessionSplitLayout | null>(null);
	const [draggingSessionId, setDraggingSessionId] = useState<string | null>(null);
	/** 分屏组胶囊在 Tab 栏的收起状态（持久化） */
	const [splitGroupCollapsed, setSplitGroupCollapsed] = useState<boolean>(() => {
		try {
			return localStorage.getItem(SPLIT_GROUP_COLLAPSED_KEY) === "1";
		} catch {
			return false;
		}
	});
	/** 分屏组自定义配置（名称/颜色，持久化；重启后重新分屏时沿用） */
	const [splitGroupConfig, setSplitGroupConfig] = useState<{
		name: string;
		color: string;
	}>(() => {
		try {
			const raw = localStorage.getItem(SPLIT_GROUP_CONFIG_KEY);
			const parsed = raw ? JSON.parse(raw) : null;
			if (parsed && typeof parsed.name === "string" && typeof parsed.color === "string") {
				return { name: parsed.name, color: parsed.color };
			}
		} catch {
			// 配置损坏时回退默认
		}
		return { name: "", color: SPLIT_GROUP_DEFAULT_COLOR };
	});

	// 最新快照：供 drop/close 回调避免闭包陈旧
	const tabsSnapshotRef = useRef({
		tabs: sessionTabIds,
		pinned: pinnedSessionTabIds,
		previewId: previewSessionTabId,
		split: splitLayout,
		currentSessionId,
		activeProjectId,
	});
	tabsSnapshotRef.current = {
		tabs: sessionTabIds,
		pinned: pinnedSessionTabIds,
		previewId: previewSessionTabId,
		split: splitLayout,
		currentSessionId,
		activeProjectId,
	};

	useEffect(() => {
		try {
			localStorage.setItem(PINNED_TABS_STORAGE_KEY, JSON.stringify(pinnedSessionTabIds));
		} catch {
			// 持久化失败不影响功能
		}
	}, [pinnedSessionTabIds]);

	// 会话记录消失时清理 Tab / pin / preview / 分屏。
	// #354：先按 catalog 归并别名把持久化的稳定 ID 引用（Tab 列表 / Tab 置顶 / 预览）迁移到
	// 存活 ID 再做存在性清理——否则被归并掉的历史 ID 会被当成「记录已删除」，用户在迁移
	// 之前就丢掉置顶并把清理结果写回 localStorage。
	// 清理只在「见过这条记录（本次运行加载过它的项目）」时才删；分屏布局不参与：它只活在内存里。
	useEffect(() => {
		for (const id of Object.keys(sessionRecords)) seenSessionIdsRef.current.add(id);
		const aliases = buildSessionIdAliasMap(Object.values(sessionRecords));
		setSessionTabIds((current) => migrateAndPruneSessionTabIds(current, aliases, sessionRecords, seenSessionIdsRef.current));
		setPinnedSessionTabIds((current) => migrateAndPruneSessionTabIds(current, aliases, sessionRecords, seenSessionIdsRef.current));
		setPreviewSessionTabId((current) => {
			const migrated = current ? (aliases.get(current) ?? current) : current;
			return migrated && !sessionRecords[migrated] ? null : migrated;
		});
		setSplitLayout((layout) => {
			// 任一栏会话记录消失则整个退出分屏（存活栏会话由 closeTab 的
			// resolveSplitAfterClose 负责晋升单栏，这里只处理记录删除的场景）
			if (!layout) return layout;
			const ids = splitLayoutSessionIds(layout);
			return ids.every((id) => Boolean(sessionRecords[id])) ? layout : null;
		});
	}, [sessionRecords, setSessionTabIds]);

	// 主进程「跳转目标」推送（系统通知点击 / 桌面宠物点击 / 文件夹右键打开项目）：
	// - sessionId：解析 record 后交给 App 注入的 focus handler 切换焦点。冷启动点击通知时
	//   catalog 可能尚未加载完，小间隔重试（最长约 3 秒）直到能解析到会话记录，避免首帧竞态丢目标。
	// - projectId：右键打开已收录目录，直接选中项目（引导页）。
	// - projectPath：右键打开未收录目录，交给 App 弹确认框走新增项目流程。
	useEffect(() => {
		let disposed = false;
		const focusBySessionId = (sessionId: string) => {
			const tryFocus = (attempt: number) => {
				if (disposed) return;
				const record = store.get(sessionRecordByIdAtomFamily(sessionId));
				if (record) {
					focusHandlersRef.current.focusSession(record.projectId, sessionId);
					return;
				}
				if (attempt < 6) window.setTimeout(() => tryFocus(attempt + 1), 500);
			};
			tryFocus(0);
		};
		const handleFocusTarget = (target: FocusTargetPayload) => {
			if ("projectId" in target) {
				focusHandlersRef.current.focusProject(target.projectId);
				return;
			}
			if ("projectPath" in target) {
				focusHandlersRef.current.focusOpenProjectPath?.(target.projectPath);
				return;
			}
			focusBySessionId(target.sessionId);
		};
		const unsubscribe = window.piDesktop.pet.onFocusTarget((target) => {
			handleFocusTarget(target);
		});
		// 冷启动/页面加载期间点击通知/右键菜单：主进程直接 send 会在监听注册前丢失，
		// 挂载后主动拉取一次 pending 目标（与事件推送共用同一解析/重试逻辑）。
		void window.piDesktop.pet.getPendingFocusTarget?.().then((target) => {
			if (disposed || !target) return;
			handleFocusTarget(target);
		});
		return () => {
			disposed = true;
			unsubscribe();
		};
	}, [store]);

	/** 由 App 在 session actions 就绪后注入；写 ref 避免与 actions 形成 hook 环依赖 */
	const bindFocusHandlers = useCallback((handlers: SessionWorkspaceFocusHandlers) => {
		focusHandlersRef.current = handlers;
	}, []);

	/** 在 App / 侧栏边界登记 Tab（preview / permanent）；与 selectSession 解耦 */
	const registerOpenSession = useCallback(
		(sessionId: string, mode: SessionTabOpenMode = "permanent") => {
			if (isRendererVirtualSessionId(sessionId)) return;
			const { tabs, pinned, previewId } = tabsSnapshotRef.current;
			// 虚拟引导 Tab 只承载空态输入框；真实会话打开后替换它，不留下“未命名”空 Tab。
			const tabsWithoutGuide = sessionId === GUIDE_BOOTSTRAP_SESSION_ID ? tabs : tabs.filter((id) => id !== GUIDE_BOOTSTRAP_SESSION_ID);
			const result = mode === "preview" ? openPreviewSessionTab(tabsWithoutGuide, pinned, previewId, sessionId) : openPermanentSessionTab(tabsWithoutGuide, pinned, previewId, sessionId);
			// 已打开的常驻 Tab 复用原数组：相同引用写 jotai 会被 Object.is 跳过。
			setSessionTabIds(result.tabs);
			setPreviewSessionTabId((current) => (current === result.previewId ? current : result.previewId));
		},
		[setSessionTabIds],
	);

	const promotePreview = useCallback(
		(sessionId: string) => {
			registerOpenSession(sessionId, "permanent");
		},
		[registerOpenSession],
	);

	/**
	 * 一次关掉一组 Tab。归档/删除父会话时必须批量关，因为连续调用 closeTab
	 * 会读到同一份 tabsSnapshotRef，第二下仍按「未关」的旧列表算邻居。
	 * 焦点规则与单 Tab 关闭一致：当前会话被关掉才切邻居 / 分屏幸存者 / 项目空态。
	 */
	const closeTabs = useCallback(
		(sessionIds: string[]) => {
			if (sessionIds.length === 0) return;
			const closing = new Set(sessionIds);
			const snap = tabsSnapshotRef.current;
			const remaining = snap.tabs.filter((id) => !closing.has(id));
			setSessionTabIds(remaining);
			if (snap.previewId && closing.has(snap.previewId)) setPreviewSessionTabId(null);

			let layout = snap.split;
			let soloSessionId: string | undefined;
			if (layout) {
				for (const sessionId of sessionIds) {
					if (!layout) break;
					const resolved = resolveSplitAfterClose(layout, sessionId);
					if (!resolved) {
						layout = null;
						soloSessionId = undefined;
						break;
					}
					if ("soloSessionId" in resolved) {
						// 唯一幸存者也在关闭集合里时，分屏整体消失，不能再把焦点交给它。
						if (closing.has(resolved.soloSessionId)) {
							layout = null;
							soloSessionId = undefined;
						} else {
							layout = null;
							soloSessionId = resolved.soloSessionId;
						}
						break;
					}
					layout = resolved.layout;
				}
				setSplitLayout(layout);
			}

			const currentId = snap.currentSessionId;
			if (!currentId || !closing.has(currentId)) return;

			if (soloSessionId && remaining.includes(soloSessionId)) {
				const record = store.get(sessionRecordByIdAtomFamily(soloSessionId));
				if (record) {
					focusHandlersRef.current.focusSession(record.projectId, soloSessionId);
					return;
				}
			}

			if (layout && remaining.length > 0) {
				const splitSurvivors = splitLayoutSessionIds(layout).filter((id) => remaining.includes(id));
				if (splitSurvivors.length > 0) {
					const record = store.get(sessionRecordByIdAtomFamily(splitSurvivors[0]));
					if (record) {
						focusHandlersRef.current.focusSession(record.projectId, splitSurvivors[0]);
						return;
					}
				}
			}

			if (remaining.length > 0) {
				const index = snap.tabs.indexOf(currentId);
				const next = remaining[Math.min(Math.max(index, 0), remaining.length - 1)];
				const record = store.get(sessionRecordByIdAtomFamily(next));
				if (record) focusHandlersRef.current.focusSession(record.projectId, next);
			} else if (snap.activeProjectId) {
				focusHandlersRef.current.focusProject(snap.activeProjectId);
			}
		},
		[setSessionTabIds, store],
	);

	const closeTab = useCallback(
		(sessionId: string) => {
			closeTabs([sessionId]);
		},
		[closeTabs],
	);

	const closeOtherTabs = useCallback(
		(sessionId: string) => {
			setSessionTabIds((current) => current.filter((id) => id === sessionId));
			setPreviewSessionTabId((current) => (current && current !== sessionId ? null : current));
			setSplitLayout(null);
		},
		[setSessionTabIds],
	);

	const closeAllTabs = useCallback(() => {
		setSessionTabIds([]);
		setPreviewSessionTabId(null);
		setSplitLayout(null);
		const projectId = tabsSnapshotRef.current.activeProjectId;
		if (projectId) focusHandlersRef.current.focusProject(projectId);
	}, [setSessionTabIds]);

	const togglePin = useCallback(
		(sessionId: string) => {
			if (isRendererVirtualSessionId(sessionId)) return;
			const { tabs, pinned, previewId } = tabsSnapshotRef.current;
			const next = togglePinSessionTab(tabs, pinned, sessionId);
			setSessionTabIds(next.tabs);
			setPinnedSessionTabIds(next.pinned);
			// Pin 与预览互斥：钉住时升格为常驻视觉
			if (previewId === sessionId) setPreviewSessionTabId(null);
		},
		[setSessionTabIds],
	);

	// 拖拽排序：落点来自「屏幕上看到的顺序」，写回时也必须按显示顺序换算 ——
	// 底层 tabs 是打开顺序，分组函数会把同项目的会话聚拢，直接改 tabs 会出现
	// 「内部数组变了、画面没动」（issue #453 根因二）。无法表达（跨项目插队）时返回 null，
	// 不写任何状态，避免静默改坏内部顺序。
	const reorderTab = useCallback(
		(sourceId: string, targetId: string, position: "before" | "after") => {
			const { tabs, pinned, split } = tabsSnapshotRef.current;
			const records = store.get(sessionRecordsAtom);
			const projects = store.get(projectInventoryByIdAtom);
			const next = reorderSessionTabsByDisplayOrder(
				tabs,
				pinned,
				split ? splitLayoutSessionIds(split) : [],
				(sessionId) => {
					const projectId = records[sessionId]?.projectId;
					if (!projectId) return undefined;
					return { projectId, name: projects[projectId]?.name };
				},
				sourceId,
				targetId,
				position,
			);
			if (!next) return;
			setSessionTabIds(next.tabs);
			setPinnedSessionTabIds(next.pinned);
		},
		[setSessionTabIds, store],
	);

	useEffect(() => {
		try {
			localStorage.setItem(SPLIT_GROUP_COLLAPSED_KEY, splitGroupCollapsed ? "1" : "0");
		} catch {
			// 持久化失败不影响功能
		}
	}, [splitGroupCollapsed]);

	useEffect(() => {
		try {
			localStorage.setItem(SPLIT_GROUP_CONFIG_KEY, JSON.stringify(splitGroupConfig));
		} catch {
			// 持久化失败不影响功能
		}
	}, [splitGroupConfig]);

	/**
	 * 顶栏 Tab 单击：只切焦点。分屏外会话聚焦时由视图投影决定呈现——
	 * 焦点会话不在布局中 → 全屏 solo 显示，分屏布局保留（不再自动替换进分屏）。
	 */
	const selectTab = useCallback(
		(sessionId: string) => {
			const record = store.get(sessionRecordByIdAtomFamily(sessionId));
			if (!record) return;
			focusHandlersRef.current.focusSession(record.projectId, sessionId);
		},
		[store],
	);

	// Ctrl(+Shift)+Tab 循环切换会话标签页：主进程 before-input-event 命中后广播
	// appShortcutTriggered，这里按「标签栏显示顺序」算目标并复用 selectTab 只切焦点（不改
	// 预览/Pin 状态）。循环顺序必须来自共享 selector：底层 tabs 数组是「打开顺序」，多项目
	// 混排 + 分屏折叠后与显示顺序不同（issue #346），直接喂 tabs 会跳到屏幕上不相邻的 Tab。
	// 快照取 ref（每次 render 同步），避免 useCallback 闭包拿到过期的 Tab/Pin/分屏列表。
	// 声明在 selectTab 之后：useCallback 的 deps 同步求值，先引用会撞 TDZ。
	const cycleTabsOnShortcut = useCallback(
		(id: string) => {
			if (id !== "cycleSessionTabs" && id !== "cycleSessionTabsReverse") return;
			const { tabs, pinned, split } = tabsSnapshotRef.current;
			const records = store.get(sessionRecordsAtom);
			const projects = store.get(projectInventoryByIdAtom);
			const displayOrder = flattenSessionTabBarEntries(
				buildSessionTabBarEntries(tabs, pinned, split ? splitLayoutSessionIds(split) : [], (sessionId) => {
					const projectId = records[sessionId]?.projectId;
					if (!projectId) return undefined;
					return { projectId, name: projects[projectId]?.name };
				}),
			);
			const target = cycleSessionTab(displayOrder, store.get(currentSessionIdAtom), id === "cycleSessionTabs" ? 1 : -1);
			if (target) selectTab(target);
		},
		[store, selectTab],
	);

	useEffect(() => desktopApi.app.onShortcutTriggered(cycleTabsOnShortcut), [cycleTabsOnShortcut]);

	const dropSplit = useCallback(
		(draggedSessionId: string, target: SessionSplitDropTarget) => {
			setDraggingSessionId(null);
			const snap = tabsSnapshotRef.current;

			// 分屏拖入 → 常驻（用 snapshot，避免 stale tabs）；侧栏拖入尚未在 Tab 栏的会话也要先登记
			const permanent = openPermanentSessionTab(snap.tabs, snap.pinned, snap.previewId, draggedSessionId);
			setSessionTabIds(permanent.tabs);
			setPreviewSessionTabId(permanent.previewId);

			const layout = snap.split;
			// 视图 solo（无布局，或布局存在但焦点会话不在布局中）→ 根层双栏（旧布局随拖拽重组丢弃）
			const inLayout = layout ? splitLayoutSessionIds(layout).includes(target.sessionId) : false;
			if (!layout || !inLayout) {
				// 单栏：拖到唯一会话面板边缘 → 根层双栏。
				// 宿主 = 被拖命中的面板；拖当前会话自己时退化为 Tab 栏另一会话（否则当前 Tab 无法分屏）
				if (target.kind !== "session-edge") return;
				const hostSessionId = resolveSplitHostSessionId({
					draggedSessionId,
					hitSessionId: target.sessionId,
					tabIds: permanent.tabs,
				});
				if (!hostSessionId) return;
				const next = buildSplitLayoutFromDrop({
					hostSessionId,
					draggedSessionId,
					edge: target.edge,
				});
				if (next) {
					setSplitLayout(next);
				}
				return;
			}

			// 已分屏：中心 → 替换命中会话；边缘按方向分派——
			// 与根层同向 → 根层插入（真三栏）；与根层垂直 → 切分该面板（终端式）
			const next =
				target.kind === "session-center"
					? replaceSplitPaneFromDrop({
							layout,
							draggedSessionId,
							sessionId: target.sessionId,
						})
					: edgeToOrientation(target.edge) === layout.orientation
						? insertRootPaneFromDrop({
								layout,
								draggedSessionId,
								sessionId: target.sessionId,
								edge: target.edge,
							})
						: nestSplitPaneFromDrop({
								layout,
								draggedSessionId,
								sessionId: target.sessionId,
								edge: target.edge,
							});
			if (next) {
				setSplitLayout(next);
				// 中心替换了当前聚焦会话：焦点迁到拖入会话，避免「替换聚焦面板后焦点悬空」
				if (target.kind === "session-center" && target.sessionId === snap.currentSessionId) {
					const record = store.get(sessionRecordByIdAtomFamily(draggedSessionId));
					if (record) {
						focusHandlersRef.current.focusSession(record.projectId, draggedSessionId);
					}
				}
			}
		},
		[setSessionTabIds, store],
	);

	const beginDrag = useCallback((sessionId: string) => {
		setDraggingSessionId(sessionId);
	}, []);

	const endDrag = useCallback(() => {
		setDraggingSessionId(null);
	}, []);

	/**
	 * 面板级退出分屏（全屏按钮）：把指定会话从布局中永久移除，
	 * 同组兄弟会话合并占据其位置，其他根层面板不受影响。
	 * 焦点保持在退出会话（若当前焦点是它）→ 视图投影自动全屏显示；
	 * 点其 Tab 只聚焦（不再自动回归分屏），想重新分屏时拖拽即可。
	 */
	const exitSplit = useCallback((sessionId: string) => {
		const layout = tabsSnapshotRef.current.split;
		if (!layout || !splitLayoutSessionIds(layout).includes(sessionId)) return;
		const resolved = resolveSplitAfterClose(layout, sessionId);
		if (!resolved) {
			setSplitLayout(null);
		} else if ("soloSessionId" in resolved) {
			setSplitLayout(null);
		} else {
			setSplitLayout(resolved.layout);
		}
	}, []);

	return {
		// state
		sessionTabIds,
		pinnedSessionTabIds,
		previewSessionTabId,
		splitLayout,
		draggingSessionId,
		splitGroupCollapsed,
		// wiring
		bindFocusHandlers,
		registerOpenSession,
		// commands
		promotePreview,
		closeTabs,
		closeTab,
		closeOtherTabs,
		closeAllTabs,
		togglePin,
		reorderTab,
		selectTab,
		dropSplit,
		beginDrag,
		endDrag,
		exitSplit,
		/** 取消分屏：全部会话退出分屏布局（会话保留为普通 Tab） */
		exitAllSplit: () => setSplitLayout(null),
		toggleSplitGroupCollapsed: () => setSplitGroupCollapsed((v) => !v),
		setSplitGroupConfig,
		splitGroupConfig,
	};
}

export type SessionWorkspaceChrome = ReturnType<typeof useSessionWorkspaceChrome>;
