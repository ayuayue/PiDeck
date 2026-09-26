import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { useAtom, useSetAtom } from "jotai";
import { ArrowDownToLine, ArrowUpFromLine, Check, ChevronDown, ChevronsDownUp, ChevronsUpDown, ClipboardPaste, FileCode2, FolderGit2, GitBranch, Loader2, Plus, RefreshCw, RotateCcw, Sparkles } from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui-shadcn/context-menu";
import { ConfirmDialog } from "./AppParts";
import { dismissNotice, showNotice, type NoticeId } from "../../utils/notice";
import { writeClipboard } from "../../utils/clipboard";
import { htmlToPlainText, readClipboardHtmlConsistent, readClipboardText } from "../../utils/clipboard";
import { deepEqual } from "../../utils/deepEqual";
import type { BranchDiffResult, CommitDetail, CommitEntry, GitAheadBehind, GitChangedFile, GitDiscardResource, GitResource, GitResourceGroupType, GitResourceGroups, ProjectFileTarget } from "../../../../shared/types";
import { GitStatus } from "../../../../shared/types";
import { EMPTY_GIT_COMMIT_COMPOSER, gitCommitComposerByScopeAtom, gitCommitScopeKey, openSettingsAtom, patchGitCommitComposer, type GitCommitComposerState } from "../../atoms";
import { t } from "../../i18n";
import { fileNameOnly, FileTree, getCollapsibleChangeDirs, ResourceGroup, ResourceRow } from "./git/GitResourceTree";
import { GitCompactFilter, PaneHeader } from "./git/GitPanelControls";
import { SourceControlGraph } from "./git/GitGraph";
import { getViewportBoundMenuPlacement } from "./git/floatingMenuPosition";
import { Input } from "../ui-shadcn/input";
import { Progress } from "../ui-shadcn/progress";
import { Textarea } from "../ui-shadcn/textarea";
import { Label } from "../../components/ui-shadcn/label";

/** 与主进程 quickGenerate 60s 上限对齐：面板进度条按此时长爬升，避免用户误以为卡住。 */
const COMMIT_GEN_TIMEOUT_MS = 60_000;

/** 错误 toast 必须有正文：showNotice 会丢掉空串，失败就会看起来像“没反应”。 */
function commitGenNoticeText(message: string | undefined, fallback: string) {
	const text = String(message ?? "").trim();
	return text || fallback;
}

/**
 * 剥离 Electron IPC 与 execFile 包装前缀，保留 git 自己的报错文本。
 * 例："Error invoking remote method 'git:push': Error: Command failed: git push\nfatal: ..."
 *   → "fatal: The current branch ... has no upstream branch ..."
 * 剥离后为空（二次包装吃掉全部信息）时由调用方用本地化兜底文案，避免 toast 空白。
 */
function gitOperationErrorText(caught: unknown): string {
	return errorMessage(caught)
		.replace(/^Error invoking remote method '[^']+':\s*/i, "")
		.replace(/^Error:\s+Command failed:\s+[^\n]*\n?/i, "")
		.trim();
}

/** 首次推送 "no upstream branch" 的识别：此类失败给“设置上游”引导而非裸报错。 */
const NO_UPSTREAM_RE = /no upstream branch/i;

/** 操作失败 toast 的稳定 id：同仓库同操作连发时顶掉旧条，避免堆一排。 */
function gitErrorToastId(scopeKey: string, kind: "push" | "pull" | "commit"): NoticeId {
	return `git-op:${kind}:${scopeKey}`;
}

/** 按仓库锁生成：切项目不能清组件 ref，否则旧请求还在飞、新仓库又会被误拦。 */
const inflightCommitGenScopes = new Set<string>();

function commitGenToastId(scopeKey: string): NoticeId {
	return `git-commit-gen:${scopeKey}`;
}

function showCommitGenProgressToast(scopeKey: string) {
	// 稳定 id：切走再回来是更新同一条，而不是再堆一条；面板卸载后 finish 也能按 id 关掉。
	showNotice(t("git.generateCommitMessageProgress"), Number.POSITIVE_INFINITY, undefined, undefined, undefined, commitGenToastId(scopeKey));
}

/** 生成结束：解锁、收进度 toast、把结果写回该仓库的 composer（与当前正在看哪个项目无关）。 */
function finishCommitGen(scopeKey: string, patch: Partial<GitCommitComposerState> = {}) {
	inflightCommitGenScopes.delete(scopeKey);
	dismissNotice(commitGenToastId(scopeKey));
	patchGitCommitComposer(scopeKey, { generating: false, startedAt: undefined, ...patch });
}

type GitPanelProps = {
	projectId: string;
	/**
	 * 当前操作的仓库身份。多仓切换时 projectId 不变，用此项让 status/mutation 序号失效并清空面板。
	 * 未传时等同 projectId，单仓行为与改前一致。
	 */
	repoScopeKey?: string;
	/** 多仓模式中的仓库标题；不传时保持单仓面板的完整布局。 */
	repositoryLabel?: string;
	/**
	 * 多仓拆分：changesOnly 只渲染该仓变更区（按内容自适应，不抢 Graph/Compare 高度）；
	 * historyOnly 只渲染全局一份 Graph + Compare。默认完整三栏。
	 */
	layout?: "full" | "changesOnly" | "historyOnly";
	/** 多仓共享 Graph/Compare 时的仓库下拉；仅 historyOnly 传入。 */
	historyRepoPath?: string;
	historyRepoOptions?: { value: string; label: string }[];
	onSelectHistoryRepo?: (path: string) => void;
	commitLog: (projectId: string, options?: { maxEntries?: number; ref?: string; allBranches?: boolean }) => Promise<CommitEntry[]>;
	/** 与当前图谱过滤一致的提交总数（不分页），供源代码管理图标题徽章使用。 */
	commitCount: (projectId: string, options?: { ref?: string; allBranches?: boolean }) => Promise<number>;
	commitDetail: (projectId: string, ref: string) => Promise<CommitDetail | null>;
	onOpenCommitFileDiff: (commit: CommitEntry, file: GitChangedFile) => void | Promise<void>;
	onOpenWorkspaceFileDiff: (group: GitResourceGroupType, target: ProjectFileTarget) => void | Promise<void>;
	/** 行内“打开文件”按钮：在编辑器面板打开该文件 */
	onOpenFile?: (target: ProjectFileTarget) => void;
	branchCompare: (projectId: string, base: string, target: string) => Promise<BranchDiffResult>;
	getStatus: (projectId: string) => Promise<GitResourceGroups>;
	stageFiles: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
	unstageFiles: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
	discardFile: (projectId: string, group: "workingTree" | "untracked", target: ProjectFileTarget) => Promise<void>;
	/** 目录级批量回滚；主进程在同一状态快照中校验路径，避免逐文件 IPC 竞态。 */
	discardFiles: (projectId: string, resources: GitDiscardResource[]) => Promise<void>;
	commit: (projectId: string, message: string) => Promise<void>;
	branches: string[];
	currentBranch: string | null;
	/** 切换分支 */
	onSwitchBranch?: (branch: string) => void;
	/** 创建新分支 */
	onCreateBranch?: (branchName: string) => void;
	cherryPick?: (projectId: string, hash: string) => Promise<void>;
	revert?: (projectId: string, hash: string) => Promise<void>;
	reset?: (projectId: string, hash: string, mode: "soft" | "mixed" | "hard") => Promise<void>;
	dropCommit?: (projectId: string, hash: string) => Promise<void>;
	/** AI 生成提交摘要 */
	generateCommitMessage?: (projectId: string, stagedPaths?: string[]) => Promise<import("../../../../shared/types").GitGenerateCommitMessageResult>;
	/** 初始化 Git 仓库 */
	gitInit?: (projectId: string) => Promise<void>;
	/** Push：将当前分支推送到远程 */
	push?: (projectId: string) => Promise<void>;
	/** Pull：从远程拉取并合并到当前分支 */
	pull?: (projectId: string) => Promise<void>;
	/** Fetch：刷新远程跟踪引用，供定时轮询 ahead/behind 角标 */
	fetch?: (projectId: string) => Promise<void>;
	/** 当前分支相对上游的提交差距；无上游返回 null（不显示角标） */
	aheadBehind?: (projectId: string) => Promise<GitAheadBehind | null>;
	/**
	 * 订阅本仓库的 refs 变化（commit/push/fetch/切分支），返回 watchId 供事件过滤。
	 * 与 unwatchRefs 成对：面板卸载/切仓库时必须退订，否则主进程监听句柄会留到退出。
	 */
	watchRefs?: (projectId: string) => Promise<string>;
	unwatchRefs?: (watchId: string) => Promise<void>;
	/** refs 变化推送订阅（返回值退订）；payload 为 watchId */
	onRefsChanged?: (listener: (watchId: string) => void) => () => void;
	/** 从磁盘删除变更文件（移入回收站） */
	deleteFiles?: (projectId: string, targets: ProjectFileTarget[]) => Promise<void>;
};

type PaneId = "changes" | "graph" | "compare";
type PaneHeights = Record<PaneId, number>;
type PaneOpenState = Record<PaneId, boolean>;
type PaneState = { heights: PaneHeights; open: PaneOpenState };
type SmartCommitPreference = {
	enableSmartCommit: boolean;
	suggestSmartCommit: boolean;
};

const EMPTY_GROUPS: GitResourceGroups = {
	merge: [],
	index: [],
	workingTree: [],
	untracked: [],
};
const PANE_IDS: PaneId[] = ["changes", "graph", "compare"];
const PANE_MIN_BODY_HEIGHT = 24;
// 头部实际高度 h-8 = 32px（Tailwind rem 基准 16px）。早期按 26px 预算：
// 折叠时溢出 6px 被 overflow-hidden 裁掉，折叠按钮视觉偏下且底部被切。
const PANE_HEADER_HEIGHT = 32;
/* 分支栏大约高度，用于 fitPaneHeights 中从可用空间预减，避免未计入分支栏高度导致 pane body 溢出 */
const BRANCH_BAR_HEIGHT = 36;
const PANE_RESIZE_STEP = 20;
const PANE_RESIZE_LARGE_STEP = 60;

function visiblePaneIds(open: PaneOpenState, layout: NonNullable<GitPanelProps["layout"]> = "full"): PaneId[] {
	return PANE_IDS.filter((id) => {
		if (layout === "historyOnly" && id === "changes") return false;
		if (layout === "changesOnly" && id !== "changes") return false;
		return open[id];
	});
}

function resizePair(state: PaneState, beforeId: PaneId, afterId: PaneId, beforeHeight: number, afterHeight: number): PaneState {
	return {
		...state,
		heights: {
			...state.heights,
			[beforeId]: Math.max(PANE_MIN_BODY_HEIGHT, Math.round(beforeHeight)),
			[afterId]: Math.max(PANE_MIN_BODY_HEIGHT, Math.round(afterHeight)),
		},
	};
}

/**
 * Allocate every visible body against the real drawer budget. Collapsed panes still
 * consume their header row; the last visible pane receives spare room, matching the
 * way VS Code keeps its view container filled without destroying persisted sizes.
 */
function fitPaneHeights(state: PaneState, availableHeight: number, chromeHeight = BRANCH_BAR_HEIGHT, layout: NonNullable<GitPanelProps["layout"]> = "full"): PaneHeights {
	const visible = visiblePaneIds(state.open, layout);
	const heights = { ...state.heights };
	if (!visible.length) return heights;

	const bodyBudget = Math.max(PANE_MIN_BODY_HEIGHT * visible.length, availableHeight - PANE_IDS.length * PANE_HEADER_HEIGHT - chromeHeight);
	const requestedTotal = visible.reduce((sum, id) => sum + heights[id], 0);
	if (requestedTotal < bodyBudget) {
		// 仅当只有一个 pane 可见时才把剩余空间灌入该 pane（保持 VS Code SCM 视图行为）；
		// 多个 pane 同时可见时保持各自请求高度，多余空间由抽屉底部自然留白，
		// 避免第一个 pane 过度膨胀把后续 pane 挤出可视区。
		if (visible.length === 1) {
			heights[visible[0]] += bodyBudget - requestedTotal;
		}
		return heights;
	}
	if (requestedTotal === bodyBudget) return heights;

	const minimumTotal = PANE_MIN_BODY_HEIGHT * visible.length;
	const distributable = Math.max(0, bodyBudget - minimumTotal);
	const requestedAboveMinimum = visible.reduce((sum, id) => sum + Math.max(0, heights[id] - PANE_MIN_BODY_HEIGHT), 0);
	for (const id of visible) {
		const requested = Math.max(0, heights[id] - PANE_MIN_BODY_HEIGHT);
		heights[id] = PANE_MIN_BODY_HEIGHT + (requestedAboveMinimum > 0 ? Math.round((distributable * requested) / requestedAboveMinimum) : 0);
	}
	return heights;
}

function adjacentVisiblePane(open: PaneOpenState, pane: PaneId, direction: -1 | 1): PaneId | null {
	const start = PANE_IDS.indexOf(pane);
	for (let index = start + direction; index >= 0 && index < PANE_IDS.length; index += direction) {
		const candidate = PANE_IDS[index];
		if (open[candidate]) return candidate;
	}
	return null;
}

function paneStateStorageKey(projectId: string, repoScopeKey: string, layout: NonNullable<GitPanelProps["layout"]> = "full"): string {
	// 多仓同时挂载时，项目级 key 会让其中一个面板覆盖另一个的折叠和高度偏好。
	// historyOnly 必须与各仓 changesOnly 隔离，否则共享 Graph 会把某个仓的折叠态写回去。
	const suffix = layout === "full" ? "v4" : `v4-${layout}`;
	return `pideck:git-panel:${projectId}:${encodeURIComponent(repoScopeKey)}:pane-state:${suffix}`;
}

/**
 * push/pull 角标（ahead/behind）持久化 key：按项目 + 仓库隔离。
 *
 * 为什么持久化：角标来自 git fetch 远程 + 对比，属于慢操作（网络往返）。
 * 切会话 tab / 关抽屉再开会让 GitPanel 卸载重挂，若不缓存，每次回来角标都要
 * 从 0 重新等一轮 fetch；缓存后重挂先秒显上次结果，再后台刷新校正。
 */
function aheadBehindStorageKey(projectId: string, repoScopeKey: string): string {
	return `pideck:git-panel:${projectId}:${encodeURIComponent(repoScopeKey)}:ahead-behind:v1`;
}

/** 读取上次缓存的 ahead/behind 角标；无缓存或格式非法返回 null（视为无角标）。 */
function readAheadBehindCache(projectId: string, repoScopeKey: string): GitAheadBehind | null {
	try {
		const raw = localStorage.getItem(aheadBehindStorageKey(projectId, repoScopeKey));
		if (!raw) return null;
		const value = JSON.parse(raw) as Partial<GitAheadBehind> | null;
		// 只信任数字字段：缓存可能被旧版本/手改损坏，非法时按无缓存处理
		if (value && typeof value.ahead === "number" && Number.isFinite(value.ahead) && typeof value.behind === "number" && Number.isFinite(value.behind)) {
			return { ahead: value.ahead, behind: value.behind };
		}
		return null;
	} catch {
		return null;
	}
}

/** 写入 ahead/behind 角标缓存；存储不可用时静默跳过（本轮会话仍可用）。 */
function writeAheadBehindCache(projectId: string, repoScopeKey: string, value: GitAheadBehind | null): void {
	try {
		if (value === null) {
			localStorage.removeItem(aheadBehindStorageKey(projectId, repoScopeKey));
			return;
		}
		localStorage.setItem(aheadBehindStorageKey(projectId, repoScopeKey), JSON.stringify(value));
	} catch {
		// 预览/无存储环境不持久化，不影响本轮会话内展示
	}
}

function smartCommitStorageKey(projectId: string): string {
	return `pideck:git-panel:${projectId}:smart-commit:v1`;
}

function readSmartCommitPreference(projectId: string): SmartCommitPreference {
	try {
		const value = JSON.parse(localStorage.getItem(smartCommitStorageKey(projectId)) ?? "null") as Partial<SmartCommitPreference> | null;
		return {
			enableSmartCommit: value?.enableSmartCommit === true,
			// VS Code defaults suggestSmartCommit to true until the user chooses Never.
			suggestSmartCommit: value?.suggestSmartCommit !== false,
		};
	} catch {
		return { enableSmartCommit: false, suggestSmartCommit: true };
	}
}

function writeSmartCommitPreference(projectId: string, value: SmartCommitPreference): void {
	try {
		localStorage.setItem(smartCommitStorageKey(projectId), JSON.stringify(value));
	} catch {
		// The choice remains valid for this renderer session when storage is unavailable.
	}
}

function defaultPaneState(): PaneState {
	return {
		heights: { changes: 100, graph: 200, compare: 160 },
		open: { changes: true, graph: false, compare: false },
	};
}

function readPaneState(projectId: string, repoScopeKey: string, layout: NonNullable<GitPanelProps["layout"]> = "full"): PaneState {
	const fallback = defaultPaneState();
	try {
		const raw = localStorage.getItem(paneStateStorageKey(projectId, repoScopeKey, layout));
		if (!raw) return fallback;
		const value = JSON.parse(raw) as Partial<PaneState>;
		const heights = PANE_IDS.reduce((result, id) => {
			const height = value.heights?.[id];
			result[id] = typeof height === "number" && Number.isFinite(height) ? Math.max(PANE_MIN_BODY_HEIGHT, Math.round(height)) : fallback.heights[id];
			return result;
		}, {} as PaneHeights);
		const open = PANE_IDS.reduce((result, id) => {
			result[id] = typeof value.open?.[id] === "boolean" ? value.open[id] : fallback.open[id];
			return result;
		}, {} as PaneOpenState);
		return { heights, open };
	} catch {
		return fallback;
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function PaneSash(props: { before: PaneId; after: PaneId; beforeHeight: number; afterHeight: number; onResize: (beforeHeight: number, afterHeight: number) => void }) {
	const frameRef = useRef<number | undefined>(undefined);
	const pendingHeightsRef = useRef<{ before: number; after: number } | null>(null);

	const flushPendingHeights = () => {
		if (frameRef.current !== undefined) {
			cancelAnimationFrame(frameRef.current);
			frameRef.current = undefined;
		}
		const pending = pendingHeightsRef.current;
		pendingHeightsRef.current = null;
		if (pending) props.onResize(pending.before, pending.after);
	};

	const scheduleHeights = (before: number, after: number) => {
		pendingHeightsRef.current = { before, after };
		if (frameRef.current !== undefined) return;
		frameRef.current = requestAnimationFrame(() => {
			frameRef.current = undefined;
			const pending = pendingHeightsRef.current;
			pendingHeightsRef.current = null;
			if (pending) props.onResize(pending.before, pending.after);
		});
	};

	const startResize = (event: ReactPointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		const startY = event.clientY;
		const startBeforeHeight = props.beforeHeight;
		const startAfterHeight = props.afterHeight;
		event.currentTarget.setPointerCapture?.(event.pointerId);
		const onMove = (moveEvent: PointerEvent) => {
			const requestedBefore = startBeforeHeight + moveEvent.clientY - startY;
			const before = Math.max(PANE_MIN_BODY_HEIGHT, Math.min(requestedBefore, startBeforeHeight + startAfterHeight - PANE_MIN_BODY_HEIGHT));
			const after = startBeforeHeight + startAfterHeight - before;
			scheduleHeights(before, after);
		};
		const onEnd = () => {
			flushPendingHeights();
			window.removeEventListener("pointermove", onMove);
			window.removeEventListener("pointerup", onEnd);
			window.removeEventListener("pointercancel", onEnd);
			document.body.classList.remove("is-git-pane-resizing");
		};
		document.body.classList.add("is-git-pane-resizing");
		window.addEventListener("pointermove", onMove);
		window.addEventListener("pointerup", onEnd);
		window.addEventListener("pointercancel", onEnd);
	};

	const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
		const step = event.shiftKey ? PANE_RESIZE_LARGE_STEP : PANE_RESIZE_STEP;
		if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
		event.preventDefault();
		const direction = event.key === "ArrowUp" ? -1 : 1;
		const requestedBefore = props.beforeHeight + direction * step;
		const before = Math.max(PANE_MIN_BODY_HEIGHT, Math.min(requestedBefore, props.beforeHeight + props.afterHeight - PANE_MIN_BODY_HEIGHT));
		const after = props.beforeHeight + props.afterHeight - before;
		props.onResize(before, after);
	};

	return (
		<div
			className="git-pane-sash relative z-[1] box-border h-1.5 shrink-0 basis-1.5 -my-[3px] cursor-row-resize touch-none before:absolute before:top-0.5 before:right-0 before:left-0 before:h-px before:bg-[var(--git-panel-border)] before:transition-[background-color,height] before:duration-150 hover:before:h-0.5 hover:before:bg-[var(--color-accent)] focus-visible:before:h-0.5 focus-visible:before:bg-[var(--color-accent)]"
			role="separator"
			tabIndex={0}
			aria-orientation="horizontal"
			aria-label={t("git.resizePanes")}
			aria-valuemin={PANE_MIN_BODY_HEIGHT}
			aria-valuemax={Math.max(PANE_MIN_BODY_HEIGHT, props.beforeHeight + props.afterHeight - PANE_MIN_BODY_HEIGHT)}
			aria-valuenow={props.beforeHeight}
			data-before={props.before}
			data-after={props.after}
			onPointerDown={startResize}
			onKeyDown={onKeyDown}
		/>
	);
}

export function GitPanel(props: GitPanelProps) {
	const panelRef = useRef<HTMLDivElement>(null);
	// Missing-model guidance opens Common settings directly at the Git summary section.
	const openSettings = useSetAtom(openSettingsAtom);
	const repoScopeKey = props.repoScopeKey ?? props.projectId;
	const composerScopeKey = gitCommitScopeKey(props.projectId, repoScopeKey);
	const [composerByScope, setComposerByScope] = useAtom(gitCommitComposerByScopeAtom);
	const composer = composerByScope[composerScopeKey] ?? EMPTY_GIT_COMMIT_COMPOSER;
	const commitMessage = composer.message;
	const commitGenLoading = composer.generating;
	const setCommitMessage = useCallback(
		(value: string | ((current: string) => string)) => {
			setComposerByScope((all) => {
				const prev = all[composerScopeKey] ?? EMPTY_GIT_COMMIT_COMPOSER;
				const message = typeof value === "function" ? value(prev.message) : value;
				return { ...all, [composerScopeKey]: { ...prev, message } };
			});
		},
		[composerScopeKey, setComposerByScope],
	);
	const layout = props.layout ?? "full";
	const paneIdPrefix = useId();
	// GitDrawerHost 会随外层 App 的流式渲染重跑，并为同一仓库重新创建函数包装器。
	// 这些 ref 只跟踪最新实现，避免 API 函数身份变化被误判为仓库变化。
	const projectIdRef = useRef(props.projectId);
	projectIdRef.current = props.projectId;
	const repoScopeKeyRef = useRef(repoScopeKey);
	repoScopeKeyRef.current = repoScopeKey;
	const getStatusRef = useRef(props.getStatus);
	getStatusRef.current = props.getStatus;
	const fetchRef = useRef(props.fetch);
	fetchRef.current = props.fetch;
	const aheadBehindRef = useRef(props.aheadBehind);
	aheadBehindRef.current = props.aheadBehind;
	// 角标读取串行化：心跳与手动刷新可能同时要读，慢仓库（大历史 / 网络盘）单次 rev-list
	// 超过一轮时会把 git 子进程一轮一轮叠起来，而旧结果反正会被作用域守卫丢弃。
	const aheadBehindInFlightRef = useRef<Promise<void> | null>(null);
	// 已写入 localStorage 的角标快照：值没变就不重复写（localStorage 是渲染线程同步存储，
	// 5 秒一次的无效写入既占主线程也没意义）。key 带上作用域，切项目/仓库时自然失效。
	const aheadBehindPersistedRef = useRef<{ key: string; value: GitAheadBehind | null } | null>(null);
	// historyOnly 没有独立仓库标题；changesOnly 把仓库名并进分支栏，不再额外预留标题高度。
	const panelChromeHeight = layout === "historyOnly" ? 0 : BRANCH_BAR_HEIGHT;
	const statusRequestRef = useRef(0);
	const statusRunningRequestRef = useRef<{
		projectId: string;
		repoScopeKey: string;
		request: number;
	} | null>(null);
	const mutationRequestRef = useRef(0);
	const mutationRunningRef = useRef(false);
	const [availableHeight, setAvailableHeight] = useState(720);
	const [groups, setGroups] = useState<GitResourceGroups>(EMPTY_GROUPS);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const commitInputRef = useRef<HTMLTextAreaElement | null>(null);
	/** 右键“粘贴”在光标处插入文本：受控组件用 setRangeText 不触发 onChange，
	 *  手动拼 next 值 + 恢复光标位置（rAF 等重渲染后再定位） */
	const pasteIntoCommitInput = (text: string) => {
		if (!text) return;
		const el = commitInputRef.current;
		const start = el?.selectionStart ?? commitMessage.length;
		const end = el?.selectionEnd ?? commitMessage.length;
		const next = commitMessage.slice(0, start) + text + commitMessage.slice(end);
		setCommitMessage(next);
		requestAnimationFrame(() => {
			el?.focus();
			el?.setSelectionRange(start + text.length, start + text.length);
		});
	};
	/** 原样粘贴：剪贴板有 HTML 时保留段落/换行结构转纯文本，否则直接读纯文本 */
	/** 粘贴：剪贴板有 HTML 时保留段落/换行结构转纯文本（textarea 只能纯文本），否则直接读纯文本 */
	const pasteCommitClipboard = () => {
		// 只接受与当前纯文本同源的 HTML（剪贴板残留问题见 readClipboardHtmlConsistent）
		const html = readClipboardHtmlConsistent();
		pasteIntoCommitInput(html ? htmlToPlainText(html) : readClipboardText());
	};
	const [committing, setCommitting] = useState(false);
	const [pushing, setPushing] = useState(false);
	const [pulling, setPulling] = useState(false);
	const [mutating, setMutating] = useState(false);
	const [notAGitRepo, setNotAGitRepo] = useState(false);
	const [gitNotInstalled, setGitNotInstalled] = useState(false);
	const [initializing, setInitializing] = useState(false);
	const [smartCommitPreference, setSmartCommitPreference] = useState<SmartCommitPreference>(() => readSmartCommitPreference(props.projectId));
	const [showSmartCommitPrompt, setShowSmartCommitPrompt] = useState(false);
	const [discardTarget, setDiscardTarget] = useState<{
		group: "workingTree" | "untracked";
		target: ProjectFileTarget;
	} | null>(null);
	const [directoryDiscardTarget, setDirectoryDiscardTarget] = useState<{
		resources: GitDiscardResource[];
		label: string;
	} | null>(null);
	/** 右键“删除文件”确认目标 */
	const [deleteTarget, setDeleteTarget] = useState<ProjectFileTarget | null>(null);
	/** 当前分支相对上游的提交差距：ahead 显示在 push、behind 显示在 pull */
	const [aheadBehind, setAheadBehind] = useState<GitAheadBehind | null>(null);
	const [resourceOpen, setResourceOpen] = useState({
		merge: true,
		staged: true,
		changes: true,
	});
	/** 变更文件树的目录折叠态（merge/staged/working 共享，供「收起/展开全部」） */
	const [collapsedChangeDirs, setCollapsedChangeDirs] = useState<Set<string>>(() => new Set());
	const [paneState, setPaneState] = useState<PaneState>(() => readPaneState(props.projectId, repoScopeKey, layout));

	useEffect(() => {
		const element = panelRef.current;
		if (!element) return;
		const updateHeight = () => setAvailableHeight(Math.max(PANE_MIN_BODY_HEIGHT, Math.round(element.clientHeight)));
		updateHeight();
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", updateHeight);
			return () => window.removeEventListener("resize", updateHeight);
		}
		const observer = new ResizeObserver(updateHeight);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	useEffect(() => {
		// 项目切换会复用同一个 GitPanel 实例；递增序号让旧项目进行中的 status/mutation 结果失效。
		statusRequestRef.current += 1;
		mutationRequestRef.current += 1;
		const next = readPaneState(props.projectId, repoScopeKey, layout);
		setPaneState({
			...next,
			// historyOnly 底部按内容收缩：不能用自身 clientHeight 回填，否则一展开就被反向压扁。
			heights: layout === "historyOnly" ? next.heights : fitPaneHeights(next, availableHeight, panelChromeHeight, layout),
		});
		setGroups(EMPTY_GROUPS);
		setError(null);
		setCommitting(false);
		// push/pull 与 commit 同属 mutation：旧请求被序号作废后，其 finally 的守卫
		// （mutationRequest === mutationRequestRef.current）不再成立，不会执行
		// setPushing(false)——这里必须显式复位，否则按钮永远转圈。
		setPushing(false);
		setPulling(false);
		mutationRunningRef.current = false;
		setMutating(false);
		setResourceOpen({ merge: true, staged: true, changes: true });
		setCollapsedChangeDirs(new Set());
		setSmartCommitPreference(readSmartCommitPreference(props.projectId));
		setShowSmartCommitPrompt(false);
		setDiscardTarget(null);
		setDeleteTarget(null);
		// 切项目/仓库时先恢复该作用域的缓存角标（秒显），后续由 refresh 成功路径
		// 后台 fetch 校正；不置 null 是避免重挂后角标长时间消失（见 aheadBehindStorageKey 注释）。
		setAheadBehind(readAheadBehindCache(props.projectId, repoScopeKey));
		// 提交框草稿和 AI 生成态按仓库存在 atom 里：切项目只清本面板的 status，不能打断旧仓库还在飞的生成。
		setNotAGitRepo(false);
		setGitNotInstalled(false);
	}, [layout, panelChromeHeight, props.projectId, repoScopeKey]);

	useEffect(() => {
		if (layout === "historyOnly") return;
		setPaneState((current) => ({
			...current,
			heights: fitPaneHeights(current, availableHeight, panelChromeHeight, layout),
		}));
	}, [availableHeight, layout, panelChromeHeight]);

	useEffect(() => {
		try {
			localStorage.setItem(paneStateStorageKey(props.projectId, repoScopeKey, layout), JSON.stringify(paneState));
		} catch {
			// Storage can be blocked in preview/web mode; pane interaction must still work for this session.
		}
	}, [layout, paneState, props.projectId, repoScopeKey]);

	/**
	 * 读取 push/pull 角标：只读本地 refs，不 fetch、不走网络。
	 *
	 * 为什么单独拆出一支：`HEAD...@{u}` 的差距完全由本地 refs 决定——AI 在终端里
	 * commit / push / 切分支后本地 refs 立即更新，直接重读就能把角标归零。
	 * 若只在 fetch 成功后才计数，fetch 慢或失败（离线/需凭据）时角标会长时间停在旧值
	 * （历史缺陷：AI 推完要等到下一轮 5 分钟 fetch 才消失）。
	 *
	 * aheadBehind 经 ref 读取：宿主包装器可能随外层 render 重建，不应因此重排定时器。
	 */
	const readAheadBehind = useCallback(async () => {
		const aheadBehind = aheadBehindRef.current;
		if (!aheadBehind) return;
		// 等前一个读落地再读：既怕子进程堆积，也要保证本调用拿到的是 fetch 之后的 refs。
		const inFlight = aheadBehindInFlightRef.current;
		if (inFlight) await inFlight;
		const projectId = props.projectId;
		const currentRepoScopeKey = repoScopeKey;
		const task = (async () => {
			try {
				const result = await aheadBehind(projectId);
				if (projectId !== projectIdRef.current || currentRepoScopeKey !== repoScopeKeyRef.current) return;
				// 数值没变就保留原对象：GitAheadBehind 每次都是新引用，直接 set 等于每 5 秒
				// 白重渲染一次整个面板（含变更树 / 图谱子树）。
				setAheadBehind((current) => (deepEqual(current, result) ? current : result));
				const scopeKey = `${projectId}::${currentRepoScopeKey}`;
				const persisted = aheadBehindPersistedRef.current;
				if (persisted?.key === scopeKey && deepEqual(persisted.value, result)) return;
				// 写缓存：重挂/切 tab 回来能秒显上次角标；null（无上游）时清缓存
				writeAheadBehindCache(projectId, currentRepoScopeKey, result);
				aheadBehindPersistedRef.current = { key: scopeKey, value: result };
			} catch {
				// 静默失败：非仓库/无上游时角标保持上次已知值，不弹错误
			}
		})();
		aheadBehindInFlightRef.current = task;
		try {
			await task;
		} finally {
			// 只清自己这一次：等待中的后来者会在它后面重新登记
			if (aheadBehindInFlightRef.current === task) aheadBehindInFlightRef.current = null;
		}
	}, [props.projectId, repoScopeKey]);

	/**
	 * 刷新 push/pull 角标。
	 *
	 * @param fetchRemote - 是否先 `git fetch` 再计数：
	 *   true  → 手动刷新与 5 分钟定时器（要知道别人推到远程的新提交，behind 才准）；
	 *   false → 本地事件驱动（外部 commit/push/切分支、窗口重新聚焦），只读本地 refs。
	 *
	 * 顺序刻意是「先本地 → 再 fetch → 再本地」：第一步不依赖网络，用户点刷新或 AI
	 * 在终端 push 完后角标能立即变；fetch 仅用于校正 behind，失败也不阻挡本地计数。
	 */
	const refreshAheadBehind = useCallback(
		async (fetchRemote = true) => {
			await readAheadBehind();
			if (!fetchRemote) return;
			const fetch = fetchRef.current;
			if (!fetch) return;
			try {
				await fetch(props.projectId);
			} catch {
				// 静默失败：离线/无远程时保留上一次 fetch 的 behind，ahead 已由本地计数更新
				return;
			}
			await readAheadBehind();
		},
		[props.projectId, readAheadBehind],
	);

	/**
	 * 拉取最新 Git 工作区状态。
	 *
	 * @param silent - 静默模式：不显示 loading 动画、不清除已有错误和分组数据；
	 *                 用于后台轮询，避免闪烁和打断用户正在查看的 Diff 内容。
	 */
	const refresh = useCallback(
		async (silent = false) => {
			// 静默轮询不打断 mutation，也不与前一个 status 请求重叠；否则慢于 5 秒的请求会彼此作废，列表永久不更新。
			if (silent && (mutationRunningRef.current || (statusRunningRequestRef.current?.projectId === props.projectId && statusRunningRequestRef.current.repoScopeKey === repoScopeKey))) return;
			const request = ++statusRequestRef.current;
			const projectId = props.projectId;
			const runningRequest = { projectId, repoScopeKey, request };
			statusRunningRequestRef.current = runningRequest;
			if (!silent) {
				setLoading(true);
				setError(null);
			}
			try {
				const next = await getStatusRef.current(projectId);
				if (request === statusRequestRef.current && projectId === projectIdRef.current && repoScopeKey === repoScopeKeyRef.current) {
					setGroups(next);
					// 刷新成功说明当前目录可用，恢复仓库/工具标记（手动 git init 或安装 git 后自动恢复轮询）
					setNotAGitRepo(false);
					setGitNotInstalled(false);
					// 非 silent refresh 成功后顺带刷角标（内含 fetch 远程校正 behind），不必再单独 fetch
					if (!silent) void refreshAheadBehind();
				}
			} catch (caught) {
				if (request === statusRequestRef.current && projectId === projectIdRef.current && repoScopeKey === repoScopeKeyRef.current) {
					const msg = gitOperationErrorText(caught);
					// 检测"不是 Git 仓库"的错误，展示初始化提示（无论是否静默都要置位，
					// 否则面板打开期间仓库状态变化时轮询永远停不下来）
					if (/not a git repository|fatal:/.test(msg)) {
						setNotAGitRepo(true);
					} else if (/command not found|ENOENT|spawn.*git.*ENOENT/i.test(msg)) {
						setGitNotInstalled(true);
					}
					if (!silent) {
						setGroups(EMPTY_GROUPS);
						if (/not a git repository|fatal:/.test(msg)) {
							setError("");
						} else if (/command not found|ENOENT|spawn.*git.*ENOENT/i.test(msg)) {
							setError("");
						} else {
							setError(msg);
						}
					}
					// 静默失败不影响已展示的旧分组数据；不做错误信息变更。
				}
			} finally {
				if (statusRunningRequestRef.current === runningRequest) statusRunningRequestRef.current = null;
				if (request === statusRequestRef.current && projectId === projectIdRef.current && repoScopeKey === repoScopeKeyRef.current && !silent) setLoading(false);
			}
		},
		[props.projectId, repoScopeKey, refreshAheadBehind],
	);

	// refresh 必须经 ref 读取：props.gitInit 内部会 refreshRepos，触发 GitDrawerHost
	// 重渲染后 repoScopeKey 可能变化（无仓库时用 projectRoot，初始化后换成 main 侧
	// resolve 出来的 repo.path，字符串形式不一定一致）。init 按钮闭包里捕获的 refresh
	// 是旧作用域，其成功/收尾守卫（repoScopeKey === repoScopeKeyRef.current）会判失败，
	// 结果被丢弃、loading 卡死——变更区要手动点好几次才恢复。
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;

	/**
	 * 初始化 git 仓库（分支栏 / 空状态两个入口共用）。
	 * gitInit 内部已 refreshRepos（仓库列表变化会触发宿主重渲染并更新作用域），
	 * 完成后用最新作用域的 refresh 拉一次状态，确保刚 init 的仓库立刻出现在变更区。
	 */
	const doInitRepo = useCallback(async () => {
		if (!props.gitInit) return;
		setInitializing(true);
		try {
			await props.gitInit(props.projectId);
			setNotAGitRepo(false);
			void refreshRef.current();
		} catch (caught) {
			// 初始化失败不常驻面板错误区（此时面板本就无变更列表），toast 提示即可。
			showNotice(gitOperationErrorText(caught) || t("git.operationFailed"), 8000, "error", t("git.operationFailed"));
		}
		setInitializing(false);
	}, [props.gitInit, props.projectId]);

	// 打开 Git drawer 时首次加载；historyOnly 只看 Graph/Compare，不必轮询工作区。
	useEffect(() => {
		if (layout === "historyOnly") return;
		void refresh();
	}, [layout, refresh]);

	// 静默轮询：每 5 秒拉取一次最新工作区状态 + 重读本地 ahead/behind 角标。
	// 非 git 仓库 / 未安装 git 时暂停轮询——状态恢复（git init / 安装 git）后由
	// refresh 成功路径清标记，interval 随依赖重建自动恢复。
	//
	// 角标为何也走这里：`HEAD...@{u}` 只依赖本地 refs，AI 在终端里 commit/push 后
	// 本地 refs 立即变化，5 秒内就能把「已推送」的角标归零；只读本地不发网络，
	// 代价是一次 `git rev-list`，比 5 分钟一轮的 fetch 快得多（fetch 仍用于发现
	// 别人推到远端的新提交）。mutation（push/pull 进行中）跳过，避免读到中间态
	// 把角标写回旧值。
	useEffect(() => {
		if (layout === "historyOnly") return;
		const timer = window.setInterval(() => {
			if (notAGitRepo || gitNotInstalled) return;
			// 窗口最小化 / 被完全遮挡时不跑：这一轮没有用户在看，却要白扫一遍 worktree
			// （status 是这套轮询里最贵的一步，大仓尤其明显）。判「可见」而不是「聚焦」——
			// 用户切到终端让 AI push 时窗口失去焦点但仍可见，角标必须继续跟平；
			// 重新可见后由 focus 监听与下一轮心跳补齐。
			if (document.hidden) return;
			if (mutationRunningRef.current) return;
			void refresh(true);
			void readAheadBehind();
		}, 5000);
		return () => window.clearInterval(timer);
	}, [layout, refresh, readAheadBehind, notAGitRepo, gitNotInstalled]);

	// 窗口重新获得焦点时补一次静默刷新：常见用法是切到终端让 AI commit/push 再切回来，
	// 不必要等下一轮 5 秒轮询（角标只读本地 refs，代价很低）。
	useEffect(() => {
		if (layout === "historyOnly") return;
		const onFocus = () => {
			if (notAGitRepo || gitNotInstalled || mutationRunningRef.current) return;
			void refresh(true);
			void readAheadBehind();
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, [layout, refresh, readAheadBehind, notAGitRepo, gitNotInstalled]);

	/** 本面板的 refs 监听 id：主进程按 (projectId, repoPath) 分配，多仓时每个面板各一份 */
	const refsWatchIdRef = useRef<string | null>(null);

	// refs 变化推送：AI 在终端里 commit/push/切分支后主进程检测到 refs 签名变化并推送，
	// 面板重读状态与角标。检测上限 = 主进程轮询间隔（1.5 秒），比「下一轮 5 秒轮询」快一个档；
	// 5 秒轮询保留为兜底（工作区文件改动不写 refs，检测不会触发，变更列表仍靠轮询）。
	//
	// 三个刻意的约束：
	// - 订阅/退订必须成对：主进程按 watchId 计数，退订后计数归零才会停掉该仓库的轮询；
	// - 推送到达时只做 silent 刷新（不 fetch）：否则 fetch → 改写 refs → 再推送，
	//   会形成往返回环；behind 的远程校正仍走手动刷新与 5 分钟定时器；
	// - watchId 未就绪或事件不属于本面板（同一条通道 N 个面板共用）时直接忽略。
	useEffect(() => {
		if (layout === "historyOnly") return;
		const watchRefs = props.watchRefs;
		const unwatchRefs = props.unwatchRefs;
		const onRefsChanged = props.onRefsChanged;
		if (!watchRefs || !unwatchRefs || !onRefsChanged) return;
		if (notAGitRepo || gitNotInstalled) return;
		const projectId = props.projectId;
		let disposed = false;
		const unsubscribe = onRefsChanged((changedId) => {
			if (disposed || refsWatchIdRef.current !== changedId) return;
			// mutation 进行中/窗口不可见时不抢刷新：push 自身已有收尾刷新，隐藏时等 focus 补齐
			if (mutationRunningRef.current || document.hidden) return;
			void refresh(true);
			void readAheadBehind();
		});
		void watchRefs(projectId)
			.then((watchId) => {
				// 卸载后才拿到 id：立即退订，否则主进程句柄会残留到最后一个订阅者退出
				if (disposed) {
					void unwatchRefs(watchId);
					return;
				}
				refsWatchIdRef.current = watchId;
			})
			.catch(() => {
				// 订阅失败不提示：refs 推送只是加速手段，轮询仍在兜底
			});
		return () => {
			disposed = true;
			unsubscribe();
			const watchId = refsWatchIdRef.current;
			refsWatchIdRef.current = null;
			if (watchId) void unwatchRefs(watchId);
		};
	}, [layout, props.projectId, props.watchRefs, props.unwatchRefs, props.onRefsChanged, refresh, readAheadBehind, notAGitRepo, gitNotInstalled]);

	// 定时 fetch 远程：每 5 分钟刷新一次 ahead/behind 角标。
	// 首次 fetch 改走 refresh 成功路径，避免未确认仓库时立刻 spawn `git fetch`。
	// 非 git 仓库 / 未安装 git 时暂停（fetch 同样会 spawn git 报错）。
	useEffect(() => {
		if (layout === "historyOnly") return;
		if (!fetchRef.current || !aheadBehindRef.current) return;
		if (notAGitRepo || gitNotInstalled) return;
		const timer = window.setInterval(() => {
			if (notAGitRepo || gitNotInstalled) return;
			if (!fetchRef.current || !aheadBehindRef.current) return;
			void refreshAheadBehind();
		}, 5 * 60_000);
		return () => window.clearInterval(timer);
	}, [layout, refreshAheadBehind, notAGitRepo, gitNotInstalled]);

	const toggleResource = (key: keyof typeof resourceOpen) => {
		setResourceOpen((current) => ({ ...current, [key]: !current[key] }));
	};
	const togglePane = (id: PaneId) => {
		setPaneState((current) => {
			const open = { ...current.open, [id]: !current.open[id] };
			const next = { ...current, open };
			return {
				...next,
				heights: layout === "historyOnly" ? next.heights : fitPaneHeights(next, availableHeight, panelChromeHeight, layout),
			};
		});
	};
	const resizePanes = (before: PaneId, after: PaneId, beforeHeight: number, afterHeight: number) => {
		setPaneState((current) => resizePair(current, before, after, beforeHeight, afterHeight));
	};

	const workingChanges = useMemo(() => {
		// VS Code 语义：Changes 组始终显示全部变更（含已暂存），Staged 组单独列已暂存；
		// 同一文件同时在 index 与 workingTree（暂存后又改）时只列一次，避免重复行
		const seen = new Set<string>();
		const result: GitResource[] = [];
		for (const r of [...groups.workingTree, ...groups.untracked, ...groups.index]) {
			if (seen.has(r.path)) continue;
			seen.add(r.path);
			result.push(r);
		}
		return result;
	}, [groups.workingTree, groups.untracked, groups.index]);
	/** 已暂存路径集合：Changes 组中这些文件不再显示 stage/rollback 行内按钮 */
	const stagedPathSet = useMemo(() => new Set(groups.index.map((r) => r.path)), [groups.index]);
	const stagedCount = groups.index.length;
	const hasUnresolvedConflicts = groups.merge.length > 0;
	// VS Code enables the action for either staged changes or working-tree changes
	// when smart commit is enabled/suggested; the command decides whether to prompt.
	const hasChangesToCommit = stagedCount > 0 || (workingChanges.length > 0 && (smartCommitPreference.enableSmartCommit || smartCommitPreference.suggestSmartCommit));
	const canCommit = Boolean(commitMessage.trim()) && hasChangesToCommit && !hasUnresolvedConflicts && !committing && !mutating;
	const total = groups.merge.length + stagedCount + workingChanges.length;

	// 合并 merge/staged/working 的可折叠目录，驱动顶部「收起/展开全部」按钮状态
	const collapsibleChangeDirs = useMemo(() => {
		const dirs = new Set<string>();
		for (const list of [groups.merge, groups.index, workingChanges]) {
			for (const dir of getCollapsibleChangeDirs(list)) {
				dirs.add(dir);
			}
		}
		return dirs;
	}, [groups.merge, groups.index, workingChanges]);

	const canCollapseChangeDirs = collapsibleChangeDirs.size > 0;
	const allChangeDirsCollapsed = canCollapseChangeDirs && [...collapsibleChangeDirs].every((dir) => collapsedChangeDirs.has(dir));
	const allChangeDirsExpanded = !canCollapseChangeDirs || [...collapsibleChangeDirs].every((dir) => !collapsedChangeDirs.has(dir));

	const toggleChangeDir = useCallback((dir: string) => {
		setCollapsedChangeDirs((prev) => {
			const next = new Set(prev);
			if (next.has(dir)) next.delete(dir);
			else next.add(dir);
			return next;
		});
	}, []);

	const collapseAllChangeDirs = useCallback(() => {
		setCollapsedChangeDirs(new Set(collapsibleChangeDirs));
	}, [collapsibleChangeDirs]);

	const expandAllChangeDirs = useCallback(() => {
		setCollapsedChangeDirs(new Set());
	}, []);

	const act = async (operation: () => Promise<void>) => {
		if (mutationRunningRef.current || committing) return;
		const mutationRequest = ++mutationRequestRef.current;
		mutationRunningRef.current = true;
		setMutating(true);
		const projectId = props.projectId;
		try {
			await operation();
			if (projectId === projectIdRef.current) await refresh();
		} catch (caught) {
			if (projectId === projectIdRef.current) {
				// 变更类操作（放弃更改/重置/拣选等）失败统一走 toast，不再 setError：
				// 面板错误条会把变更列表顶下去，且错误会在切换后残留；toast 用完即走。
				showNotice(gitOperationErrorText(caught) || t("git.operationFailed"), 8000, "error", t("git.operationFailed"));
			}
		} finally {
			if (mutationRequest === mutationRequestRef.current) {
				mutationRunningRef.current = false;
				if (projectId === projectIdRef.current) setMutating(false);
			}
		}
	};

	const runCommit = async (stageAll: boolean) => {
		const message = commitMessage.trim();
		if (!message || committing || mutating || hasUnresolvedConflicts || mutationRunningRef.current) return;
		const projectId = props.projectId;
		const mutationRequest = ++mutationRequestRef.current;
		mutationRunningRef.current = true;
		setCommitting(true);
		setError(null);
		try {
			if (stageAll) {
				const paths = workingChanges.map((resource) => resource.target);
				if (paths.length > 0) await props.stageFiles(projectId, paths);
			}
			await props.commit(projectId, message);
			// 提交成功清的是该仓库草稿，哪怕用户已经切到别的项目。
			patchGitCommitComposer(gitCommitScopeKey(projectId, repoScopeKey), { message: "" });
			if (projectId !== projectIdRef.current) return;
			await refresh();
		} catch (caught) {
			if (projectId === projectIdRef.current) {
				// 提交失败（hook 拒绝/模板错误等）不再常驻面板错误区，统一 toast；
				// 保留 git 自己的 stderr 便于排查（如 pre-commit 输出）。
				showNotice(gitOperationErrorText(caught) || t("git.commitFailed"), 8000, "error", t("git.commitFailed"), undefined, gitErrorToastId(repoScopeKey, "commit"));
			}
		} finally {
			if (mutationRequest === mutationRequestRef.current) {
				mutationRunningRef.current = false;
				if (projectId === projectIdRef.current) setCommitting(false);
			}
		}
	};

	const doCommit = async () => {
		if (!canCommit) return;
		if (stagedCount > 0) {
			await runCommit(false);
			return;
		}
		if (smartCommitPreference.enableSmartCommit) {
			await runCommit(true);
			return;
		}
		if (smartCommitPreference.suggestSmartCommit && workingChanges.length > 0) {
			setShowSmartCommitPrompt(true);
		}
	};

	const chooseSmartCommit = (choice: "yes" | "always" | "never") => {
		setShowSmartCommitPrompt(false);
		if (choice === "never") {
			const next = { ...smartCommitPreference, suggestSmartCommit: false };
			setSmartCommitPreference(next);
			writeSmartCommitPreference(props.projectId, next);
			return;
		}
		if (choice === "always") {
			const next = { enableSmartCommit: true, suggestSmartCommit: true };
			setSmartCommitPreference(next);
			writeSmartCommitPreference(props.projectId, next);
		}
		void runCommit(true);
	};

	const confirmDiscard = () => {
		const target = discardTarget;
		if (!target) return;
		setDiscardTarget(null);
		void act(() => props.discardFile(props.projectId, target.group, target.target));
	};

	const confirmDirectoryDiscard = () => {
		const target = directoryDiscardTarget;
		if (!target) return;
		setDirectoryDiscardTarget(null);
		void act(() => props.discardFiles(props.projectId, target.resources));
	};

	/** 右键菜单“删除文件”确认：移入回收站，可恢复 */
	const confirmDelete = () => {
		const target = deleteTarget;
		const deleteFiles = props.deleteFiles;
		if (!target || !deleteFiles) return;
		setDeleteTarget(null);
		void act(() => deleteFiles(props.projectId, [target]));
	};

	/**
	 * 生成提交摘要（AI）。
	 * - 防抖：按仓库 scope 互斥；切项目不能清锁，否则旧请求还在飞、新仓库又会被误拦
	 * - 进度：粘性 toast + 面板进度条；duration 必须 Infinity（0 会被 sonner 立刻关掉）
	 * - 结束：结果写回发起仓库的 atom，与当前正在看哪个项目无关
	 * - 超时：主进程 60s 上限返回 GIT_COMMIT_TIMEOUT，提示更久并带“重试”入口
	 */
	const runGenerateCommitMessage = useCallback(async () => {
		if (!props.generateCommitMessage) return;
		if (groups.index.length === 0) {
			showNotice(t("git.stageBeforeGenerateCommitMessage"), 3000);
			return;
		}
		const projectId = props.projectId;
		const scopeKey = gitCommitScopeKey(projectId, repoScopeKey);
		if (inflightCommitGenScopes.has(scopeKey)) return;
		inflightCommitGenScopes.add(scopeKey);
		patchGitCommitComposer(scopeKey, { generating: true, startedAt: Date.now() });
		showCommitGenProgressToast(scopeKey);
		try {
			const result = await props.generateCommitMessage(projectId);
			if (result.ok) {
				const message = result.message.trim();
				if (message) {
					finishCommitGen(scopeKey, { message });
					showNotice(t("git.generateCommitMessageDone"), 2500);
				} else {
					// 主进程空 diff / 模型空输出都走 ok+空串；用户侧必须看到失败，否则会以为还在转
					finishCommitGen(scopeKey);
					showNotice(t("git.generateCommitMessageEmpty"), 5000, "warning");
				}
			} else if (result.code === "GIT_COMMIT_MODEL_REQUIRED") {
				finishCommitGen(scopeKey);
				// 未配置：提示 + “去设置”直达常用设置的 Git 摘要栏（覆盖上次记住的其它 tab）
				showNotice(commitGenNoticeText(result.message, t("git.generateCommitMessageFailed")), 8000, "error", undefined, {
					action: {
						label: t("git.goSettings"),
						onClick: () => openSettings({ tab: "git", section: "git" }),
					},
				});
			} else if (result.code === "GIT_COMMIT_TIMEOUT") {
				finishCommitGen(scopeKey);
				// 生成超时（主进程 60s 上限）：提示更久并给重试入口；重试复用同一防抖锁
				showNotice(commitGenNoticeText(result.message, t("git.generateCommitMessageFailed")), 10000, "error", undefined, {
					action: {
						label: t("git.retryGenerate"),
						onClick: () => void runGenerateCommitMessage(),
					},
				});
			} else {
				finishCommitGen(scopeKey);
				showNotice(commitGenNoticeText(result.message, t("git.generateCommitMessageFailed")), 5000, "error");
			}
		} catch (err) {
			finishCommitGen(scopeKey);
			showNotice(commitGenNoticeText(err instanceof Error ? err.message : undefined, t("git.generateCommitMessageFailed")), 5000, "error");
		}
	}, [openSettings, props.generateCommitMessage, props.projectId, repoScopeKey, groups.index.length]);

	const doPush = async () => {
		if (!props.push || mutationRunningRef.current) return;
		const projectId = props.projectId;
		const mutationRequest = ++mutationRequestRef.current;
		mutationRunningRef.current = true;
		setPushing(true);
		setError(null);
		try {
			await props.push(projectId);
			if (projectId !== projectIdRef.current) return;
			// refresh() 的非 silent 成功路径会先读本地角标再 fetch：push 后本地 refs 已更新，
			// ahead 立即归零且不依赖 fetch 成败，不必再单独等一轮角标刷新。
			await refresh();
		} catch (caught) {
			if (projectId === projectIdRef.current) {
				const text = gitOperationErrorText(caught);
				if (NO_UPSTREAM_RE.test(text) && props.currentBranch) {
					// 首次推送新分支：给“建立上游”引导而非裸报错；复制按钮可直接粘到终端执行。
					const command = `git push --set-upstream origin ${props.currentBranch}`;
					showNotice(
						t("git.pushNoUpstreamDesc", { branch: props.currentBranch, command }),
						8000,
						"error",
						t("git.pushNoUpstreamTitle"),
						{
							action: {
								label: t("common.copy"),
								onClick: () => {
									void writeClipboard(command);
								},
							},
						},
						gitErrorToastId(repoScopeKey, "push"),
					);
				} else {
					showNotice(text || t("git.pushFailed"), 8000, "error", t("git.pushFailed"), undefined, gitErrorToastId(repoScopeKey, "push"));
				}
			}
		} finally {
			if (mutationRequest === mutationRequestRef.current) {
				mutationRunningRef.current = false;
				if (projectId === projectIdRef.current) setPushing(false);
			}
		}
	};

	const doPull = async () => {
		if (!props.pull || mutationRunningRef.current) return;
		const projectId = props.projectId;
		const mutationRequest = ++mutationRequestRef.current;
		mutationRunningRef.current = true;
		setPulling(true);
		setError(null);
		try {
			await props.pull(projectId);
			if (projectId !== projectIdRef.current) return;
			// 同 push：pull 后本地 refs 已是最终结果，本地角标计数先给出准确值
			await refresh();
		} catch (caught) {
			if (projectId === projectIdRef.current) {
				// 拉取失败同样不常驻面板错误区，避免错误条占位挤压变更列表。
				showNotice(gitOperationErrorText(caught) || t("git.pullFailed"), 8000, "error", t("git.pullFailed"), undefined, gitErrorToastId(repoScopeKey, "pull"));
			}
		} finally {
			if (mutationRequest === mutationRequestRef.current) {
				mutationRunningRef.current = false;
				if (projectId === projectIdRef.current) setPulling(false);
			}
		}
	};

	const visibleOpen: PaneOpenState = layout === "historyOnly" ? { ...paneState.open, changes: false } : paneState.open;
	const visibleSashAfterChanges = adjacentVisiblePane(visibleOpen, "changes", 1);
	const visibleSashAfterGraph = adjacentVisiblePane(visibleOpen, "graph", 1);
	const paneStyle = (id: PaneId): React.CSSProperties =>
		({
			"--git-pane-height": `${paneState.heights[id]}px`,
		}) as React.CSSProperties;

	const renderSash = (before: PaneId, after: PaneId) => <PaneSash before={before} after={after} beforeHeight={paneState.heights[before]} afterHeight={paneState.heights[after]} onResize={(beforeHeight, afterHeight) => resizePanes(before, after, beforeHeight, afterHeight)} />;

	/** 摘要生成进度 0–95：按 atom.startedAt 续跑，切走再回来不会从 0 重开。 */
	const [commitGenProgress, setCommitGenProgress] = useState(0);
	useEffect(() => {
		if (!commitGenLoading) {
			setCommitGenProgress(0);
			return;
		}
		const startedAt = composer.startedAt ?? Date.now();
		const tickProgress = () => {
			const ratio = Math.min(1, (Date.now() - startedAt) / COMMIT_GEN_TIMEOUT_MS);
			// 封顶 95%，避免还没返回就显示满格；真正结束靠 generating 清零。
			setCommitGenProgress(Math.max(4, Math.round(ratio * 95)));
		};
		tickProgress();
		const tick = window.setInterval(tickProgress, 200);
		return () => window.clearInterval(tick);
	}, [commitGenLoading, composer.startedAt]);
	useEffect(() => {
		// 切回仍在生成的仓库：用同一 toast id 续上进度提示（抽屉卸载过也能再挂上）。
		if (!commitGenLoading) return;
		showCommitGenProgressToast(composerScopeKey);
	}, [commitGenLoading, composerScopeKey]);
	const [branchOpen, setBranchOpen] = useState(false);
	const [branchCreating, setBranchCreating] = useState(false);
	const [newBranchName, setNewBranchName] = useState("");
	const [branchDropdownStyle, setBranchDropdownStyle] = useState<React.CSSProperties>({});
	const branchBarRef = useRef<HTMLDivElement>(null);
	const branchTriggerRef = useRef<HTMLButtonElement>(null);
	const branchDropdownRef = useRef<HTMLDivElement>(null);

	const updateBranchDropdownPosition = useCallback(() => {
		if (!branchTriggerRef.current) return;
		const rect = branchTriggerRef.current.getBoundingClientRect();
		// 菜单宽度跟触发器走（随抽屉自适应），再由 placement 钳进视口；不再写死 240。
		const preferredWidth = Math.max(Math.ceil(rect.width), 160);
		const placement = getViewportBoundMenuPlacement(rect, { width: window.innerWidth, height: window.innerHeight }, { preferredWidth, maxHeight: 300, gap: 2 });
		setBranchDropdownStyle({
			position: "fixed",
			left: placement.left,
			top: placement.top,
			bottom: placement.bottom,
			width: placement.width,
			maxHeight: placement.maxHeight,
			zIndex: 9999,
		});
	}, []);

	// 点击外部关闭分支下拉
	useEffect(() => {
		if (!branchOpen) return;
		updateBranchDropdownPosition();
		const handler = (event: MouseEvent) => {
			const target = event.target as Node;
			// Portal 出来的菜单不再是 branchBar 的后代，二者都属于菜单交互区。
			if (branchBarRef.current?.contains(target) || branchDropdownRef.current?.contains(target)) {
				return;
			}
			setBranchOpen(false);
			setBranchCreating(false);
			setNewBranchName("");
		};
		const handleScroll = () => updateBranchDropdownPosition();
		const handleResize = () => updateBranchDropdownPosition();
		document.addEventListener("mousedown", handler);
		window.addEventListener("scroll", handleScroll, true);
		window.addEventListener("resize", handleResize);
		return () => {
			document.removeEventListener("mousedown", handler);
			window.removeEventListener("scroll", handleScroll, true);
			window.removeEventListener("resize", handleResize);
		};
	}, [branchOpen, updateBranchDropdownPosition]);

	// 变更区操作：多仓并进仓库行，避免每个仓再叠一层「更改」标题栏。
	const changeToolbar = (
		<>
			{loading && <Loader2 size={14} className="animate-pideck-spin" aria-label={t("common.loading")} />}
			<Button type="button" variant="ghost" size="icon-sm" className="size-7" title={t("drawer.collapseAllDirs")} aria-label={t("drawer.collapseAllDirs")} disabled={!canCollapseChangeDirs || allChangeDirsCollapsed} onClick={collapseAllChangeDirs}>
				<ChevronsDownUp size={14} />
			</Button>
			<Button type="button" variant="ghost" size="icon-sm" className="size-7" title={t("drawer.expandAllDirs")} aria-label={t("drawer.expandAllDirs")} disabled={!canCollapseChangeDirs || allChangeDirsExpanded} onClick={expandAllChangeDirs}>
				<ChevronsUpDown size={14} />
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="icon-sm"
				className="size-7"
				title={t("common.refresh")}
				aria-label={t("common.refresh")}
				onClick={() => {
					// 非 silent refresh 成功后会顺带 refreshAheadBehind，不必再单独 fetch
					void refresh();
				}}
			>
				<RefreshCw size={14} />
			</Button>
			{props.push && (
				<div className="relative inline-flex items-center">
					<Button type="button" variant="ghost" size="icon-sm" className="size-7" title={aheadBehind && aheadBehind.ahead > 0 ? t("git.pushAhead", { count: aheadBehind.ahead }) : t("git.push")} aria-label={t("git.push")} disabled={pushing || mutationRunningRef.current} onClick={() => void doPush()}>
						{pushing ? <Loader2 size={14} className="animate-pideck-spin" /> : <ArrowUpFromLine size={14} />}
					</Button>
					{/* 领先角标：本地上游提交数，提示需要推送。
              背景用 --color-info 而非 --color-accent：accent 暗色反转为近白（#fafafa），
              与固定 text-white 组合会白底白字不可读；但暗色 info 也是亮蓝 #60a5fa，
              白字对比不足（~2.3:1），文字同样走 --color-text-inverse（暗色近黑）。 */}
					{!pushing && aheadBehind && aheadBehind.ahead > 0 && (
						<span className="pointer-events-none absolute -top-1 -right-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-info)] px-0.5 text-[9px] leading-none font-semibold text-[var(--color-text-inverse)] tabular-nums" aria-label={t("git.pushAhead", { count: aheadBehind.ahead })}>
							{aheadBehind.ahead}
						</span>
					)}
				</div>
			)}
			{props.pull && (
				<div className="relative inline-flex items-center">
					<Button type="button" variant="ghost" size="icon-sm" className="size-7" title={aheadBehind && aheadBehind.behind > 0 ? t("git.pullBehind", { count: aheadBehind.behind }) : t("git.pull")} aria-label={t("git.pull")} disabled={pulling || mutationRunningRef.current} onClick={() => void doPull()}>
						{pulling ? <Loader2 size={14} className="animate-pideck-spin" /> : <ArrowDownToLine size={14} />}
					</Button>
					{/* 落后角标：远程领先本地的提交数，提示需要拉取（颜色同领先角标，见上注释） */}
					{!pulling && aheadBehind && aheadBehind.behind > 0 && (
						<span
							className="pointer-events-none absolute -top-1 -right-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-[var(--color-info)] px-0.5 text-[9px] leading-none font-semibold text-[var(--color-text-inverse)] tabular-nums"
							aria-label={t("git.pullBehind", { count: aheadBehind.behind })}
						>
							{aheadBehind.behind}
						</span>
					)}
				</div>
			)}
		</>
	);

	return (
		<div ref={panelRef} className={`git-panel flex min-h-0 flex-col overflow-hidden bg-background text-foreground${layout === "full" ? " h-full" : ""}`} aria-label={t("git.sourceControl")}>
			{layout !== "historyOnly" && (
				<>
					{/* 当前分支 + 切换下拉：无边框、宽度收窄，把空间留给仓库名和提交区。 */}
					<div className={`flex shrink-0 items-center gap-1 border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] px-2${layout === "changesOnly" ? " py-0" : " py-1.5"}`} ref={branchBarRef}>
						{layout === "changesOnly" && props.repositoryLabel && (
							<div className="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-semibold text-[var(--git-panel-fg)]" title={props.repositoryLabel}>
								<FolderGit2 size={13} className="shrink-0 text-muted-foreground" />
								<span className="min-w-0 truncate">{props.repositoryLabel}</span>
							</div>
						)}
						<Button
							ref={branchTriggerRef}
							type="button"
							variant="ghost"
							size="xs"
							className={`inline-flex h-6 items-center gap-0.5 rounded-sm border-0 bg-transparent px-1 text-left text-[11px] text-[var(--git-panel-fg)] shadow-none hover:bg-[var(--git-panel-hover)]${layout === "changesOnly" ? " max-w-[26%] shrink min-w-0" : " max-w-[9rem] min-w-0"}`}
							onClick={() => {
								if (!branchOpen) updateBranchDropdownPosition();
								setBranchOpen((v) => !v);
							}}
							title={
								props.currentBranch
									? t("app.branchCurrent", {
											branch: props.currentBranch,
											count: props.branches.length,
										})
									: undefined
							}
						>
							<GitBranch size={12} className="shrink-0 text-muted-foreground" />
							<span className="git-branch-label min-w-0 flex-1 truncate">{props.currentBranch || t("app.branchNone")}</span>
							{/* 多仓变更行已经很挤，数字角标会把按钮撑回宽胶囊；单仓仍显示分支数。 */}
							{layout !== "changesOnly" && props.branches.length > 0 && <span className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-medium tabular-nums text-muted-foreground">{props.branches.length}</span>}
							<ChevronDown size={12} className={`shrink-0 text-muted-foreground transition-transform duration-150${branchOpen ? " rotate-180" : ""}`} />
						</Button>
						{notAGitRepo && (
							<Button type="button" variant="ghost" size="icon-sm" className="size-7 inline-grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground" title={t("git.initInBranchBar")} disabled={initializing} onClick={() => void doInitRepo()}>
								{initializing ? <Loader2 size={14} className="animate-pideck-spin" /> : <Plus size={14} />}
							</Button>
						)}
						{branchOpen &&
							createPortal(
								<div ref={branchDropdownRef} className="z-50 max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md" style={branchDropdownStyle}>
									{props.branches.map((branch) => (
										<Button
											type="button"
											key={branch}
											variant="ghost"
											size="sm"
											className={`h-auto flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent${branch === props.currentBranch ? " bg-accent font-semibold text-[color:var(--color-accent)]" : ""}`}
											title={branch}
											onClick={() => {
												if (branch !== props.currentBranch) props.onSwitchBranch?.(branch);
												setBranchOpen(false);
											}}
										>
											{branch === props.currentBranch && <Check size={14} className="shrink-0 text-[color:var(--color-accent)]" />}
											<span className="truncate">{branch}</span>
										</Button>
									))}
									<div className="my-1 h-px bg-border" />
									{branchCreating ? (
										<div className="flex items-center gap-1 px-1 py-1">
											<Input
												className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
												placeholder={t("app.branchNewPlaceholder") ?? t("app.branchNewPlaceholder")}
												value={newBranchName}
												onChange={(e) => setNewBranchName(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter" && newBranchName.trim()) {
														props.onCreateBranch?.(newBranchName.trim());
														setBranchCreating(false);
														setNewBranchName("");
														setBranchOpen(false);
													}
													if (e.key === "Escape") {
														setBranchCreating(false);
														setNewBranchName("");
													}
												}}
												autoFocus
											/>
											<Button
												type="button"
												variant="default"
												size="icon-sm"
												className="inline-grid size-7 place-items-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
												disabled={!newBranchName.trim()}
												onClick={() => {
													props.onCreateBranch?.(newBranchName.trim());
													setBranchCreating(false);
													setNewBranchName("");
													setBranchOpen(false);
												}}
											>
												<Check size={14} />
											</Button>
										</div>
									) : (
										<Button type="button" variant="ghost" size="sm" className="h-auto flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-text-secondary hover:bg-accent" onClick={() => setBranchCreating(true)}>
											<Plus size={14} />
											<span>{t("app.branchCreate")}</span>
										</Button>
									)}
								</div>,
								document.body,
							)}
						{layout === "changesOnly" && <div className="ml-auto flex shrink-0 items-center gap-0.5">{changeToolbar}</div>}
					</div>
					<section
						id={`git-pane-${paneIdPrefix}-changes`}
						className={`flex min-h-0 flex-col overflow-hidden border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] last:border-b-0${layout === "changesOnly" ? " flex-[0_0_auto]" : paneState.open.changes ? " h-[calc(var(--git-pane-height)+32px)] flex-[0_0_auto]" : " h-[32px] flex-[0_0_auto]"}`}
						style={layout === "changesOnly" ? undefined : paneStyle("changes")}
					>
						{layout !== "changesOnly" && (
							<PaneHeader id={`${paneIdPrefix}-changes`} title={t("git.changes")} open={paneState.open.changes} onToggle={() => togglePane("changes")}>
								{changeToolbar}
							</PaneHeader>
						)}
						{(layout === "changesOnly" || paneState.open.changes) && (
							<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
								{gitNotInstalled ? (
									<div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
										<div className="text-[32px] leading-none opacity-60">⚡</div>
										<div className="text-sm font-semibold text-text-primary">{t("git.gitNotInstalled")}</div>
										<div className="max-w-[360px] text-xs leading-[22px] text-text-tertiary">{t("git.gitNotInstalledDesc")}</div>
									</div>
								) : notAGitRepo ? (
									<div className="flex flex-col items-center gap-4 px-4 py-8 text-center">
										<div className="text-[13px] leading-[22px] text-[var(--git-desc-fg)]">{t("git.notAGitRepo")}</div>
										<Button type="button" variant="ghost" size="sm" className=" h-auto px-2.5 text-[13px]" disabled={initializing} onClick={() => void doInitRepo()}>
											{initializing ? <Loader2 size={14} className="animate-pideck-spin" /> : t("git.initRepo")}
										</Button>
									</div>
								) : (
									<div className="flex shrink-0 flex-col gap-2 border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] px-2.5 pt-2 pb-1.5">
										<ContextMenu>
											<ContextMenuTrigger asChild>
												<Textarea
													ref={commitInputRef}
													className="git-scm-input min-h-14 max-h-[100px] w-full resize-y rounded-sm border border-[var(--git-input-border)] bg-[var(--git-input-bg)] px-2 py-1 text-[13px] leading-[20px] text-[var(--git-panel-fg)] outline-none placeholder:text-[var(--git-desc-fg)]"
													placeholder={t("git.commitPlaceholder", {
														branch: props.currentBranch ?? "HEAD",
													})}
													value={commitMessage}
													onChange={(event) => setCommitMessage(event.target.value)}
													onKeyDown={(event) => {
														if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
															event.preventDefault();
															void doCommit();
														}
													}}
													rows={3}
												/>
											</ContextMenuTrigger>
											<ContextMenuContent alignOffset={-6}>
												<ContextMenuItem onSelect={pasteCommitClipboard}>
													<ClipboardPaste size={13} strokeWidth={2} aria-hidden="true" />
													{t("common.paste")}
												</ContextMenuItem>
											</ContextMenuContent>
										</ContextMenu>
										<div className="flex items-stretch gap-2">
											<Button
												type="button"
												variant="ghost"
												size="icon-sm"
												className="min-w-8 border border-border-subtle bg-bg-panel text-text-secondary hover:bg-bg-hover hover:text-text-primary"
												title={commitGenLoading ? t("git.generateCommitMessageProgress") : t("git.generateCommitMessage")}
												aria-label={t("git.generateCommitMessage")}
												disabled={commitGenLoading || mutating}
												onClick={() => void runGenerateCommitMessage()}
											>
												{commitGenLoading ? <Loader2 size={14} className="animate-pideck-spin" /> : <Sparkles size={14} />}
											</Button>
											<Button variant="default" className="git-commit-btn min-w-0 flex-1" loading={committing} disabled={!canCommit} onClick={() => void doCommit()}>
												{committing ? t("git.committing") : t("git.commit")}
											</Button>
										</div>
										{commitGenLoading && <Progress value={commitGenProgress} className="h-1" aria-label={t("git.generateCommitMessageProgress")} />}
									</div>
								)}

								{error && <div className="flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-conflict)]">{error}</div>}
								{!loading && total === 0 && !error && <div className="git-status-msg flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-desc-fg)]">{t("git.noPendingChanges")}</div>}

								<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
									{groups.merge.length > 0 && (
										<ResourceGroup title={t("git.mergeChanges")} count={groups.merge.length} open={resourceOpen.merge} onToggle={() => toggleResource("merge")}>
											<FileTree resources={groups.merge} groupType="merge" onOpenWorkspaceFileDiff={props.onOpenWorkspaceFileDiff} mutating={mutating || committing} collapsedDirs={collapsedChangeDirs} onToggleDir={toggleChangeDir} />
										</ResourceGroup>
									)}
									{groups.index.length > 0 && (
										<ResourceGroup
											title={t("git.stagedChanges")}
											count={groups.index.length}
											open={resourceOpen.staged}
											onToggle={() => toggleResource("staged")}
											allAction={() =>
												act(() =>
													props.unstageFiles(
														props.projectId,
														groups.index.map((resource) => resource.target),
													),
												)
											}
											allLabel={t("git.unstageAll")}
											allDisabled={mutating || committing}
										>
											<FileTree
												resources={groups.index}
												groupType="index"
												onOpenWorkspaceFileDiff={props.onOpenWorkspaceFileDiff}
												mutating={mutating || committing}
												unstageFile={(path) => act(() => props.unstageFiles(props.projectId, [path]))}
												deleteFile={props.deleteFiles ? (path) => setDeleteTarget(path) : undefined}
												onOpenFile={props.onOpenFile}
												collapsedDirs={collapsedChangeDirs}
												onToggleDir={toggleChangeDir}
											/>
										</ResourceGroup>
									)}
									{workingChanges.length > 0 && (
										<ResourceGroup
											title={t("git.changes")}
											count={workingChanges.length}
											open={resourceOpen.changes}
											onToggle={() => toggleResource("changes")}
											allAction={() =>
												act(() =>
													props.stageFiles(
														props.projectId,
														workingChanges.map((resource) => resource.target),
													),
												)
											}
											allLabel={t("git.stageAll")}
											allDisabled={mutating || committing}
										>
											<FileTree
												resources={workingChanges}
												groupType="workingTree"
												onOpenWorkspaceFileDiff={props.onOpenWorkspaceFileDiff}
												mutating={mutating || committing}
												stageFile={(path) => act(() => props.stageFiles(props.projectId, [path]))}
												discardFile={(target, group) => setDiscardTarget({ group, target })}
												deleteFile={props.deleteFiles ? (path) => setDeleteTarget(path) : undefined}
												onOpenFile={props.onOpenFile}
												stagedPaths={stagedPathSet}
												collapsedDirs={collapsedChangeDirs}
												onToggleDir={toggleChangeDir}
												stageDir={(paths) => act(() => props.stageFiles(props.projectId, paths))}
												discardDir={(resources, label) => setDirectoryDiscardTarget({ resources, label })}
											/>
										</ResourceGroup>
									)}
								</div>
							</div>
						)}
					</section>
				</>
			)}

			{layout !== "changesOnly" && visibleSashAfterChanges && renderSash("changes", visibleSashAfterChanges)}

			{layout !== "changesOnly" && (
				<SourceControlGraph
					key={`graph-${repoScopeKey}`}
					paneIdPrefix={paneIdPrefix}
					projectId={props.projectId}
					commitLog={props.commitLog}
					commitCount={props.commitCount}
					commitDetail={props.commitDetail}
					onOpenCommitFileDiff={props.onOpenCommitFileDiff}
					branches={props.branches}
					currentBranch={props.currentBranch}
					open={paneState.open.graph}
					height={paneState.heights.graph}
					onToggle={() => togglePane("graph")}
					cherryPick={props.cherryPick}
					revert={props.revert}
					reset={props.reset}
					dropCommit={props.dropCommit}
					historyRepoPath={props.historyRepoPath}
					historyRepoOptions={props.historyRepoOptions}
					onSelectHistoryRepo={props.onSelectHistoryRepo}
				/>
			)}

			{layout !== "changesOnly" && paneState.open.graph && visibleSashAfterGraph && renderSash("graph", visibleSashAfterGraph)}

			{layout !== "changesOnly" && (
				<CompareChanges
					key={`compare-${repoScopeKey}`}
					paneIdPrefix={paneIdPrefix}
					projectId={props.projectId}
					branches={props.branches}
					branchCompare={props.branchCompare}
					open={paneState.open.compare}
					height={paneState.heights.compare}
					onToggle={() => togglePane("compare")}
					historyRepoPath={props.historyRepoPath}
					historyRepoOptions={props.historyRepoOptions}
					onSelectHistoryRepo={props.onSelectHistoryRepo}
				/>
			)}

			{discardTarget &&
				createPortal(
					<ConfirmDialog
						title={discardTarget.group === "untracked" ? t("git.discardUntrackedConfirmTitle") : t("git.discardConfirmTitle")}
						message={
							discardTarget.group === "untracked"
								? t("git.discardUntrackedConfirmMessage", {
										path: fileNameOnly(discardTarget.target.relativePath),
									})
								: t("git.discardConfirmMessage", {
										path: fileNameOnly(discardTarget.target.relativePath),
									})
						}
						danger
						confirmLabel={discardTarget.group === "untracked" ? t("common.delete") : t("app.retractDiscard")}
						onConfirm={confirmDiscard}
						onCancel={() => setDiscardTarget(null)}
					/>,
					document.body,
				)}

			{directoryDiscardTarget &&
				createPortal(
					<ConfirmDialog
						title={t("git.discardDirectoryConfirmTitle")}
						message={t("git.discardDirectoryConfirmMessage", {
							path: directoryDiscardTarget.label,
							count: directoryDiscardTarget.resources.length,
						})}
						danger
						confirmLabel={t("app.retractDiscard")}
						onConfirm={confirmDirectoryDiscard}
						onCancel={() => setDirectoryDiscardTarget(null)}
					/>,
					document.body,
				)}

			{/* 右键“删除文件”确认：文件移入回收站（可恢复），danger 提示 */}
			{deleteTarget &&
				createPortal(
					<ConfirmDialog
						title={t("git.deleteFileConfirmTitle")}
						message={t("git.deleteFileConfirmMessage", {
							path: fileNameOnly(deleteTarget.relativePath),
						})}
						danger
						confirmLabel={t("common.delete")}
						onConfirm={confirmDelete}
						onCancel={() => setDeleteTarget(null)}
					/>,
					document.body,
				)}

			{showSmartCommitPrompt &&
				createPortal(
					<div className="absolute inset-0 z-[1200] flex items-center justify-center bg-[var(--overlay-backdrop-soft)] p-6" role="presentation" onClick={() => setShowSmartCommitPrompt(false)}>
						<div className="w-[min(520px,calc(100vw-48px))] rounded-lg border border-border-subtle bg-bg-panel p-4 font-sans text-text-primary shadow-[var(--shadow-modal)]" role="alertdialog" aria-modal="true" aria-labelledby="git-smart-commit-title" onClick={(event) => event.stopPropagation()}>
							<strong id="git-smart-commit-title" className="text-base leading-6">
								{t("git.smartCommitTitle")}
							</strong>
							<p className="my-3 mb-4 text-sm leading-[22px] whitespace-pre-line text-text-secondary">{t("git.smartCommitPrompt")}</p>
							<div className="flex flex-wrap justify-end gap-2">
								<Button type="button" variant="outline" size="sm" onClick={() => setShowSmartCommitPrompt(false)}>
									{t("common.cancel")}
								</Button>
								<Button type="button" variant="outline" size="sm" onClick={() => chooseSmartCommit("never")}>
									{t("git.smartCommitNever")}
								</Button>
								<Button type="button" variant="outline" size="sm" onClick={() => chooseSmartCommit("always")}>
									{t("git.smartCommitAlways")}
								</Button>
								<Button type="button" variant="default" size="sm" autoFocus onClick={() => chooseSmartCommit("yes")}>
									{t("git.smartCommitYes")}
								</Button>
							</div>
						</div>
					</div>,
					document.body,
				)}
		</div>
	);
}

function CompareChanges(props: {
	paneIdPrefix: string;
	projectId: string;
	branches: string[];
	branchCompare: GitPanelProps["branchCompare"];
	open: boolean;
	height: number;
	onToggle: () => void;
	historyRepoPath?: string;
	historyRepoOptions?: { value: string; label: string }[];
	onSelectHistoryRepo?: (path: string) => void;
}) {
	const [base, setBase] = useState("");
	const [target, setTarget] = useState("");
	const [result, setResult] = useState<BranchDiffResult | null>(null);
	const [loading, setLoading] = useState(false);
	const requestSequence = useRef(0);

	useEffect(() => {
		// Branch names overlap across projects; comparison state must not cross that boundary.
		requestSequence.current += 1;
		setBase("");
		setTarget("");
		setResult(null);
		setLoading(false);
	}, [props.projectId]);

	useEffect(() => {
		if (props.branches.length >= 2 && (!base || !target)) {
			setTarget(props.branches[0] ?? "");
			setBase(props.branches[1] ?? "");
		}
	}, [base, props.branches, target]);

	const run = async () => {
		if (!base || !target || base === target) return;
		const request = ++requestSequence.current;
		const projectId = props.projectId;
		setLoading(true);
		try {
			const next = await props.branchCompare(projectId, base, target);
			if (request === requestSequence.current && projectId === props.projectId) setResult(next);
		} catch (caught) {
			if (request === requestSequence.current && projectId === props.projectId) {
				setResult(null);
				// 对比失败（分支被删/仓库异常）不再占面板错误区，toast 用完即走。
				showNotice(gitOperationErrorText(caught) || t("git.compareFailed"), 8000, "error", t("git.compareFailed"));
			}
		} finally {
			if (request === requestSequence.current && projectId === props.projectId) setLoading(false);
		}
	};

	return (
		<section
			id={`git-pane-${props.paneIdPrefix}-compare`}
			className={`flex min-h-0 flex-[0_0_auto] flex-col overflow-hidden border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] last:border-b-0${props.open ? " h-[calc(var(--git-pane-height)+32px)]" : " h-[32px]"}`}
			style={{ "--git-pane-height": `${props.height}px` } as React.CSSProperties}
		>
			<PaneHeader id={`${props.paneIdPrefix}-compare`} title={t("git.compareChanges")} count={result?.files.length} open={props.open} onToggle={props.onToggle}>
				{props.historyRepoOptions && props.historyRepoOptions.length > 1 && props.onSelectHistoryRepo && <GitCompactFilter value={props.historyRepoPath ?? ""} ariaLabel={t("git.switchRepository")} options={props.historyRepoOptions} onChange={props.onSelectHistoryRepo} className="max-w-[8.5rem]" />}
			</PaneHeader>
			{props.open && (
				<div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain [scrollbar-gutter:stable]">
					<div className="git-compare-controls">
						<Label>
							<span>{t("git.base")}</span>
							<GitCompactFilter
								value={base}
								ariaLabel={t("git.base")}
								options={[
									{ value: "", label: t("git.selectBase") },
									...props.branches.map((branch) => ({
										value: branch,
										label: branch,
									})),
								]}
								onChange={(value) => setBase(value)}
							/>
						</Label>
						<span className="flex items-center pb-px text-[var(--git-desc-fg)]" aria-hidden="true">
							→
						</span>
						<Label>
							<span>{t("git.compare")}</span>
							<GitCompactFilter
								value={target}
								ariaLabel={t("git.compare")}
								options={[
									{ value: "", label: t("git.selectCompare") },
									...props.branches.map((branch) => ({
										value: branch,
										label: branch,
									})),
								]}
								onChange={(value) => setTarget(value)}
							/>
						</Label>
						<Button type="button" variant="ghost" size="sm" className=" h-auto px-2.5 text-[13px]" disabled={!base || !target || base === target || loading} onClick={() => void run()}>
							{loading ? <Loader2 size={14} className="animate-pideck-spin" /> : t("git.compare")}
						</Button>
					</div>
					{result && (
						<>
							<div className="flex-[0_0_auto] border-t border-[var(--git-panel-border)] px-2.5 py-1 text-[11px] text-[var(--git-desc-fg)]">
								{t("git.compareSummary", {
									ahead: result.ahead,
									behind: result.behind,
									count: result.files.length,
								})}
							</div>
							<div className="min-h-0 flex-1 overflow-auto overscroll-contain">
								{result.files.map((file) => (
									<ResourceRow key={file.path} status={0 as GitStatus} letter="" path={file.path} compareStatus={file.status} />
								))}
							</div>
						</>
					)}
					{!result && <div className="flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-desc-fg)]">{t("git.compareHint")}</div>}
				</div>
			)}
		</section>
	);
}
