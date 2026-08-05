import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  ChevronsDownUp,
  ChevronsUpDown,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Button } from "../ui-shadcn/button";
import { ConfirmDialog } from "./AppParts";
import { showNotice } from "../../utils/notice";
import type {
  BranchDiffResult,
  CommitDetail,
  CommitEntry,
  GitChangedFile,
  GitResourceGroupType,
  GitResourceGroups,
} from "../../../../shared/types";
import { GitStatus } from "../../../../shared/types";
import { t } from "../../i18n";
import {
  fileNameOnly,
  FileTree,
  getCollapsibleChangeDirs,
  ResourceGroup,
  ResourceRow,
} from "./git/GitResourceTree";
import { GitCompactFilter, PaneHeader } from "./git/GitPanelControls";
import { SourceControlGraph } from "./git/GitGraph";
import { getViewportBoundMenuPlacement } from "./git/floatingMenuPosition";
import { Input } from "../ui-shadcn/input";
import { Textarea } from "../ui-shadcn/textarea";
import { Label } from "../../components/ui-shadcn/label";

type GitPanelProps = {
  projectId: string;
  /** 项目根目录路径，用于将绝对路径转为相对路径显示 */
  projectRoot?: string;
  commitLog: (
    projectId: string,
    options?: { maxEntries?: number; ref?: string; allBranches?: boolean },
  ) => Promise<CommitEntry[]>;
  commitDetail: (
    projectId: string,
    ref: string,
  ) => Promise<CommitDetail | null>;
  onOpenCommitFileDiff: (
    commit: CommitEntry,
    file: GitChangedFile,
  ) => void | Promise<void>;
  onOpenWorkspaceFileDiff: (
    group: GitResourceGroupType,
    path: string,
  ) => void | Promise<void>;
  branchCompare: (
    projectId: string,
    base: string,
    target: string,
  ) => Promise<BranchDiffResult>;
  getStatus: (projectId: string) => Promise<GitResourceGroups>;
  stageFiles: (projectId: string, paths: string[]) => Promise<void>;
  unstageFiles: (projectId: string, paths: string[]) => Promise<void>;
  discardFile: (
    projectId: string,
    group: "workingTree" | "untracked",
    path: string,
  ) => Promise<void>;
  commit: (projectId: string, message: string) => Promise<void>;
  branches: string[];
  currentBranch: string | null;
  /** 切换分支 */
  onSwitchBranch?: (branch: string) => void;
  /** 创建新分支 */
  onCreateBranch?: (branchName: string) => void;
  cherryPick?: (projectId: string, hash: string) => Promise<void>;
  revert?: (projectId: string, hash: string) => Promise<void>;
  reset?: (
    projectId: string,
    hash: string,
    mode: "soft" | "mixed" | "hard",
  ) => Promise<void>;
  dropCommit?: (projectId: string, hash: string) => Promise<void>;
  /** AI 生成提交摘要 */
  generateCommitMessage?: (
    projectId: string,
    stagedPaths?: string[],
  ) => Promise<string>;
  /** 初始化 Git 仓库 */
  gitInit?: (projectId: string) => Promise<void>;
  /** Push：将当前分支推送到远程 */
  push?: (projectId: string) => Promise<void>;
  /** Pull：从远程拉取并合并到当前分支 */
  pull?: (projectId: string) => Promise<void>;
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
const PANE_HEADER_HEIGHT = 26;
/* 分支栏大约高度，用于 fitPaneHeights 中从可用空间预减，避免未计入分支栏高度导致 pane body 溢出 */
const BRANCH_BAR_HEIGHT = 36;
const PANE_RESIZE_STEP = 20;
const PANE_RESIZE_LARGE_STEP = 60;

function visiblePaneIds(open: PaneOpenState): PaneId[] {
  return PANE_IDS.filter((id) => open[id]);
}

function resizePair(
  state: PaneState,
  beforeId: PaneId,
  afterId: PaneId,
  beforeHeight: number,
  afterHeight: number,
): PaneState {
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
function fitPaneHeights(
  state: PaneState,
  availableHeight: number,
): PaneHeights {
  const visible = visiblePaneIds(state.open);
  const heights = { ...state.heights };
  if (!visible.length) return heights;

  const bodyBudget = Math.max(
    PANE_MIN_BODY_HEIGHT * visible.length,
    availableHeight - PANE_IDS.length * PANE_HEADER_HEIGHT - BRANCH_BAR_HEIGHT,
  );
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
  const requestedAboveMinimum = visible.reduce(
    (sum, id) => sum + Math.max(0, heights[id] - PANE_MIN_BODY_HEIGHT),
    0,
  );
  for (const id of visible) {
    const requested = Math.max(0, heights[id] - PANE_MIN_BODY_HEIGHT);
    heights[id] =
      PANE_MIN_BODY_HEIGHT +
      (requestedAboveMinimum > 0
        ? Math.round((distributable * requested) / requestedAboveMinimum)
        : 0);
  }
  return heights;
}

function adjacentVisiblePane(
  open: PaneOpenState,
  pane: PaneId,
  direction: -1 | 1,
): PaneId | null {
  const start = PANE_IDS.indexOf(pane);
  for (
    let index = start + direction;
    index >= 0 && index < PANE_IDS.length;
    index += direction
  ) {
    const candidate = PANE_IDS[index];
    if (open[candidate]) return candidate;
  }
  return null;
}

function paneStateStorageKey(projectId: string): string {
  return `pideck:git-panel:${projectId}:pane-state:v3`;
}

function smartCommitStorageKey(projectId: string): string {
  return `pideck:git-panel:${projectId}:smart-commit:v1`;
}

function readSmartCommitPreference(projectId: string): SmartCommitPreference {
  try {
    const value = JSON.parse(
      localStorage.getItem(smartCommitStorageKey(projectId)) ?? "null",
    ) as Partial<SmartCommitPreference> | null;
    return {
      enableSmartCommit: value?.enableSmartCommit === true,
      // VS Code defaults suggestSmartCommit to true until the user chooses Never.
      suggestSmartCommit: value?.suggestSmartCommit !== false,
    };
  } catch {
    return { enableSmartCommit: false, suggestSmartCommit: true };
  }
}

function writeSmartCommitPreference(
  projectId: string,
  value: SmartCommitPreference,
): void {
  try {
    localStorage.setItem(
      smartCommitStorageKey(projectId),
      JSON.stringify(value),
    );
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

function readPaneState(projectId: string): PaneState {
  const fallback = defaultPaneState();
  try {
    const raw = localStorage.getItem(paneStateStorageKey(projectId));
    if (!raw) return fallback;
    const value = JSON.parse(raw) as Partial<PaneState>;
    const heights = PANE_IDS.reduce((result, id) => {
      const height = value.heights?.[id];
      result[id] =
        typeof height === "number" && Number.isFinite(height)
          ? Math.max(PANE_MIN_BODY_HEIGHT, Math.round(height))
          : fallback.heights[id];
      return result;
    }, {} as PaneHeights);
    const open = PANE_IDS.reduce((result, id) => {
      result[id] =
        typeof value.open?.[id] === "boolean"
          ? value.open[id]
          : fallback.open[id];
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

function PaneSash(props: {
  before: PaneId;
  after: PaneId;
  beforeHeight: number;
  afterHeight: number;
  onResize: (beforeHeight: number, afterHeight: number) => void;
}) {
  const frameRef = useRef<number | undefined>(undefined);
  const pendingHeightsRef = useRef<{ before: number; after: number } | null>(
    null,
  );

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
      const before = Math.max(
        PANE_MIN_BODY_HEIGHT,
        Math.min(
          requestedBefore,
          startBeforeHeight + startAfterHeight - PANE_MIN_BODY_HEIGHT,
        ),
      );
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
    const before = Math.max(
      PANE_MIN_BODY_HEIGHT,
      Math.min(
        requestedBefore,
        props.beforeHeight + props.afterHeight - PANE_MIN_BODY_HEIGHT,
      ),
    );
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
      aria-valuemax={Math.max(
        PANE_MIN_BODY_HEIGHT,
        props.beforeHeight + props.afterHeight - PANE_MIN_BODY_HEIGHT,
      )}
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
  const projectIdRef = useRef(props.projectId);
  projectIdRef.current = props.projectId;
  const statusRequestRef = useRef(0);
  const statusRunningRequestRef = useRef<{
    projectId: string;
    request: number;
  } | null>(null);
  const mutationRequestRef = useRef(0);
  const mutationRunningRef = useRef(false);
  const [availableHeight, setAvailableHeight] = useState(720);
  const [groups, setGroups] = useState<GitResourceGroups>(EMPTY_GROUPS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [mutating, setMutating] = useState(false);
  const [notAGitRepo, setNotAGitRepo] = useState(false);
  const [gitNotInstalled, setGitNotInstalled] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [smartCommitPreference, setSmartCommitPreference] =
    useState<SmartCommitPreference>(() =>
      readSmartCommitPreference(props.projectId),
    );
  const [showSmartCommitPrompt, setShowSmartCommitPrompt] = useState(false);
  const [discardTarget, setDiscardTarget] = useState<{
    group: "workingTree" | "untracked";
    path: string;
  } | null>(null);
  const [resourceOpen, setResourceOpen] = useState({
    merge: true,
    staged: true,
    changes: true,
  });
  /** 变更文件树的目录折叠态（merge/staged/working 共享，供「收起/展开全部」） */
  const [collapsedChangeDirs, setCollapsedChangeDirs] = useState<Set<string>>(() => new Set());
  const [paneState, setPaneState] = useState<PaneState>(() =>
    readPaneState(props.projectId),
  );

  useEffect(() => {
    const element = panelRef.current;
    if (!element) return;
    const updateHeight = () =>
      setAvailableHeight(
        Math.max(PANE_MIN_BODY_HEIGHT, Math.round(element.clientHeight)),
      );
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
    const next = readPaneState(props.projectId);
    setPaneState({ ...next, heights: fitPaneHeights(next, availableHeight) });
    setGroups(EMPTY_GROUPS);
    setError(null);
    setCommitMessage("");
    setCommitting(false);
    mutationRunningRef.current = false;
    setMutating(false);
    setResourceOpen({ merge: true, staged: true, changes: true });
    setCollapsedChangeDirs(new Set());
    setSmartCommitPreference(readSmartCommitPreference(props.projectId));
    setShowSmartCommitPrompt(false);
    setDiscardTarget(null);
    setNotAGitRepo(false);
  }, [props.projectId]);

  useEffect(() => {
    setPaneState((current) => ({
      ...current,
      heights: fitPaneHeights(current, availableHeight),
    }));
  }, [availableHeight]);

  useEffect(() => {
    try {
      localStorage.setItem(
        paneStateStorageKey(props.projectId),
        JSON.stringify(paneState),
      );
    } catch {
      // Storage can be blocked in preview/web mode; pane interaction must still work for this session.
    }
  }, [paneState, props.projectId]);

  /**
   * 拉取最新 Git 工作区状态。
   *
   * @param silent - 静默模式：不显示 loading 动画、不清除已有错误和分组数据；
   *                 用于后台轮询，避免闪烁和打断用户正在查看的 Diff 内容。
   */
  const refresh = useCallback(
    async (silent = false) => {
      // 静默轮询不打断 mutation，也不与前一个 status 请求重叠；否则慢于 5 秒的请求会彼此作废，列表永久不更新。
      if (
        silent &&
        (mutationRunningRef.current ||
          statusRunningRequestRef.current?.projectId === props.projectId)
      )
        return;
      const request = ++statusRequestRef.current;
      const projectId = props.projectId;
      const runningRequest = { projectId, request };
      statusRunningRequestRef.current = runningRequest;
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const next = await props.getStatus(projectId);
        if (
          request === statusRequestRef.current &&
          projectId === projectIdRef.current
        )
          setGroups(next);
      } catch (caught) {
        if (
          request === statusRequestRef.current &&
          projectId === projectIdRef.current
        ) {
          if (!silent) {
            setGroups(EMPTY_GROUPS);
            const msg = errorMessage(caught);
            // 检测"不是 Git 仓库"的错误，展示初始化提示
            if (/not a git repository|fatal:/.test(msg)) {
              setNotAGitRepo(true);
              setError("");
            } else if (/command not found|ENOENT|spawn.*git.*ENOENT/i.test(msg)) {
              setGitNotInstalled(true);
              setError("");
            } else {
              setError(msg);
            }
          }
          // 静默失败不影响已展示的旧分组数据；不做任何 UI 状态变更。
        }
      } finally {
        if (statusRunningRequestRef.current === runningRequest)
          statusRunningRequestRef.current = null;
        if (
          request === statusRequestRef.current &&
          projectId === projectIdRef.current &&
          !silent
        )
          setLoading(false);
      }
    },
    [props.getStatus, props.projectId],
  );

  // 打开 Git drawer 时首次加载；依赖 refresh 引用稳定。
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 静默轮询：每 5 秒拉取一次最新工作区状态，不显示 loading 动画、不覆盖错误。
  useEffect(() => {
    const timer = window.setInterval(() => {
      void refresh(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const toggleResource = (key: keyof typeof resourceOpen) => {
    setResourceOpen((current) => ({ ...current, [key]: !current[key] }));
  };
  const togglePane = (id: PaneId) => {
    setPaneState((current) => {
      const open = { ...current.open, [id]: !current.open[id] };
      const next = { ...current, open };
      return { ...next, heights: fitPaneHeights(next, availableHeight) };
    });
  };
  const resizePanes = (
    before: PaneId,
    after: PaneId,
    beforeHeight: number,
    afterHeight: number,
  ) => {
    setPaneState((current) =>
      resizePair(current, before, after, beforeHeight, afterHeight),
    );
  };

  const workingChanges = useMemo(
    () => [...groups.workingTree, ...groups.untracked],
    [groups.workingTree, groups.untracked],
  );
  const stagedCount = groups.index.length;
  const hasUnresolvedConflicts = groups.merge.length > 0;
  // VS Code enables the action for either staged changes or working-tree changes
  // when smart commit is enabled/suggested; the command decides whether to prompt.
  const hasChangesToCommit =
    stagedCount > 0 ||
    (workingChanges.length > 0 &&
      (smartCommitPreference.enableSmartCommit ||
        smartCommitPreference.suggestSmartCommit));
  const canCommit =
    Boolean(commitMessage.trim()) &&
    hasChangesToCommit &&
    !hasUnresolvedConflicts &&
    !committing &&
    !mutating;
  const total = groups.merge.length + stagedCount + workingChanges.length;

  // 合并 merge/staged/working 的可折叠目录，驱动顶部「收起/展开全部」按钮状态
  const collapsibleChangeDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const list of [groups.merge, groups.index, workingChanges]) {
      for (const dir of getCollapsibleChangeDirs(list, props.projectRoot)) {
        dirs.add(dir);
      }
    }
    return dirs;
  }, [groups.merge, groups.index, workingChanges, props.projectRoot]);

  const canCollapseChangeDirs = collapsibleChangeDirs.size > 0;
  const allChangeDirsCollapsed =
    canCollapseChangeDirs &&
    [...collapsibleChangeDirs].every((dir) => collapsedChangeDirs.has(dir));
  const allChangeDirsExpanded =
    !canCollapseChangeDirs ||
    [...collapsibleChangeDirs].every((dir) => !collapsedChangeDirs.has(dir));

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
      // Do not let refresh clear the mutation error before the user can read it.
      if (projectId === projectIdRef.current) setError(errorMessage(caught));
    } finally {
      if (mutationRequest === mutationRequestRef.current) {
        mutationRunningRef.current = false;
        if (projectId === projectIdRef.current) setMutating(false);
      }
    }
  };

  const runCommit = async (stageAll: boolean) => {
    const message = commitMessage.trim();
    if (
      !message ||
      committing ||
      mutating ||
      hasUnresolvedConflicts ||
      mutationRunningRef.current
    )
      return;
    const projectId = props.projectId;
    const mutationRequest = ++mutationRequestRef.current;
    mutationRunningRef.current = true;
    setCommitting(true);
    setError(null);
    try {
      if (stageAll) {
        const paths = workingChanges.map((resource) => resource.path);
        if (paths.length > 0) await props.stageFiles(projectId, paths);
      }
      await props.commit(projectId, message);
      if (projectId !== projectIdRef.current) return;
      setCommitMessage("");
      await refresh();
    } catch (caught) {
      if (projectId === projectIdRef.current) setError(errorMessage(caught));
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
    void act(() =>
      props.discardFile(props.projectId, target.group, target.path),
    );
  };

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
      await refresh();
    } catch (caught) {
      if (projectId === projectIdRef.current) {
        const msg = errorMessage(caught);
        setError(msg);
        showNotice(msg, 10000, "error");
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
      await refresh();
    } catch (caught) {
      if (projectId === projectIdRef.current) {
        const msg = errorMessage(caught);
        setError(msg);
        showNotice(msg, 10000, "error");
      }
    } finally {
      if (mutationRequest === mutationRequestRef.current) {
        mutationRunningRef.current = false;
        if (projectId === projectIdRef.current) setPulling(false);
      }
    }
  };

  const visibleSashAfterChanges = adjacentVisiblePane(
    paneState.open,
    "changes",
    1,
  );
  const visibleSashAfterGraph = adjacentVisiblePane(paneState.open, "graph", 1);
  const paneStyle = (id: PaneId): React.CSSProperties =>
    ({
      "--git-pane-height": `${paneState.heights[id]}px`,
    }) as React.CSSProperties;

  const renderSash = (before: PaneId, after: PaneId) => (
    <PaneSash
      before={before}
      after={after}
      beforeHeight={paneState.heights[before]}
      afterHeight={paneState.heights[after]}
      onResize={(beforeHeight, afterHeight) =>
        resizePanes(before, after, beforeHeight, afterHeight)
      }
    />
  );

  /** 新建分支弹窗状态 */
  const [commitGenLoading, setCommitGenLoading] = useState(false);
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
    const placement = getViewportBoundMenuPlacement(
      rect,
      { width: window.innerWidth, height: window.innerHeight },
      { preferredWidth: 240, maxHeight: 300, gap: 2 },
    );
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
      if (
        branchBarRef.current?.contains(target) ||
        branchDropdownRef.current?.contains(target)
      ) {
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

  return (
    <div
      ref={panelRef}
      className="git-panel flex h-full min-h-0 flex-col overflow-hidden bg-background text-foreground"
      aria-label={t("git.sourceControl")}
    >
      {/* 当前分支 + 切换下拉（pure official：outline 触发器 + popover 菜单） */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border/40 bg-background px-2 py-1.5" ref={branchBarRef}>
        <Button
          ref={branchTriggerRef}
          type="button"
          variant="outline"
          className="inline-flex h-7 min-w-0 flex-1 items-center justify-start gap-1.5 rounded-md border border-border bg-background px-2 text-left text-xs text-foreground hover:bg-accent"
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
          <GitBranch size={14} className="shrink-0 text-muted-foreground" />
          <span className="git-branch-label min-w-0 flex-1 truncate">
            {props.currentBranch || t("app.branchNone")}
          </span>
          {props.branches.length > 0 && (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 font-mono text-[11px] font-medium tabular-nums text-muted-foreground">{props.branches.length}</span>
          )}
          <ChevronDown
            size={12}
            className={`shrink-0 text-muted-foreground transition-transform duration-150${branchOpen ? " rotate-180" : ""}`}
          />
        </Button>
        {notAGitRepo && (
          <Button
            type="button"
            variant="ghost" size="icon-sm" className="size-7 inline-grid size-7 place-items-center rounded-md border border-border text-muted-foreground hover:bg-accent hover:text-accent-foreground"
            title={t("git.initInBranchBar")}
            disabled={initializing}
            onClick={async () => {
              if (!props.gitInit) return;
              setInitializing(true);
              try {
                await props.gitInit(props.projectId);
                setNotAGitRepo(false);
                void refresh();
              } catch (caught) {
                setError(errorMessage(caught));
              }
              setInitializing(false);
            }}
          >
            {initializing ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Plus size={14} />
            )}
          </Button>
        )}
        {branchOpen &&
          createPortal(
            <div
              ref={branchDropdownRef}
              className="z-50 max-h-[calc(100vh-16px)] max-w-[calc(100vw-16px)] min-w-48 overflow-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md"
              style={branchDropdownStyle}
            >
            {props.branches.map((branch) => (
              <Button
                type="button"
                key={branch}
                variant="ghost"
                size="sm"
                className={`h-auto flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs hover:bg-accent${branch === props.currentBranch ? " bg-accent font-semibold text-[color:var(--color-accent)]" : ""}`}
                title={branch}
                onClick={() => {
                  if (branch !== props.currentBranch)
                    props.onSwitchBranch?.(branch);
                  setBranchOpen(false);
                }}
              >
                {branch === props.currentBranch && (
                  <Check size={14} className="shrink-0 text-[color:var(--color-accent)]" />
                )}
                <span className="truncate">{branch}</span>
              </Button>
            ))}
            <div className="my-1 h-px bg-border" />
            {branchCreating ? (
              <div className="flex items-center gap-1 px-1 py-1">
                <Input
                  className="h-7 min-w-0 flex-1 rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring"
                  placeholder={
                    t("app.branchNewPlaceholder") ??
                    t("app.branchNewPlaceholder")
                  }
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
              <Button
                type="button"
                variant="ghost" size="sm" className="h-auto flex w-full items-center gap-1.5 rounded-sm px-2 py-1.5 text-left text-xs text-text-secondary hover:bg-accent"
                onClick={() => setBranchCreating(true)}
              >
                <Plus size={14} />
                <span>{t("app.branchCreate")}</span>
              </Button>
            )}
          </div>,
          document.body,
        )}
      </div>
      <section
        id="git-pane-changes"
        className={`flex min-h-0 flex-[0_1_auto] flex-col overflow-hidden border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] last:border-b-0${paneState.open.changes ? " h-[calc(var(--git-pane-height)+26px)]" : " h-[26px]"}`}
        style={paneStyle("changes")}
      >
        <PaneHeader
          id="changes"
          title={t("git.changes")}
          count={total}
          open={paneState.open.changes}
          onToggle={() => togglePane("changes")}
        >
          {loading && (
            <Loader2
              size={14}
              className="animate-spin"
              aria-label={t("common.loading")}
            />
          )}
          {/* 与文件树一致：收起/展开全部变更目录 */}
          <Button
            type="button"
            variant="ghost" size="icon-sm" className="size-7"
            title={t("drawer.collapseAllDirs")}
            aria-label={t("drawer.collapseAllDirs")}
            disabled={!canCollapseChangeDirs || allChangeDirsCollapsed}
            onClick={collapseAllChangeDirs}
          >
            <ChevronsDownUp size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost" size="icon-sm" className="size-7"
            title={t("drawer.expandAllDirs")}
            aria-label={t("drawer.expandAllDirs")}
            disabled={!canCollapseChangeDirs || allChangeDirsExpanded}
            onClick={expandAllChangeDirs}
          >
            <ChevronsUpDown size={14} />
          </Button>
          <Button
            type="button"
            variant="ghost" size="icon-sm" className="size-7"
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
          </Button>
          {props.push && (
            <Button
              type="button"
              variant="ghost" size="icon-sm" className="size-7"
              title={t("git.push")}
              aria-label={t("git.push")}
              disabled={pushing || mutationRunningRef.current}
              onClick={() => void doPush()}
            >
              {pushing ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ArrowUpFromLine size={14} />
              )}
            </Button>
          )}
          {props.pull && (
            <Button
              type="button"
              variant="ghost" size="icon-sm" className="size-7"
              title={t("git.pull")}
              aria-label={t("git.pull")}
              disabled={pulling || mutationRunningRef.current}
              onClick={() => void doPull()}
            >
              {pulling ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                <ArrowDownToLine size={14} />
              )}
            </Button>
          )}
        </PaneHeader>
        {paneState.open.changes && (
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
                <Button
                  type="button"
                  variant="ghost" size="sm" className=" h-auto px-2.5 text-[13px]"
                  disabled={initializing}
                  onClick={async () => {
                    if (!props.gitInit) return;
                    setInitializing(true);
                    try {
                      await props.gitInit(props.projectId);
                      setNotAGitRepo(false);
                      // 初始化完成后刷新状态
                      void refresh();
                    } catch (caught) {
                      setError(errorMessage(caught));
                    }
                    setInitializing(false);
                  }}
                >
                  {initializing ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    t("git.initRepo")
                  )}
                </Button>
              </div>
            ) : (
            <div className="flex shrink-0 flex-col gap-2 border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] px-2.5 pt-2 pb-1.5">
              <Textarea
                className="git-scm-input min-h-14 max-h-[100px] w-full resize-y rounded-sm border border-[var(--git-input-border)] bg-[var(--git-input-bg)] px-2 py-1 font-mono text-[13px] leading-[20px] text-[var(--git-panel-fg)] outline-none placeholder:text-[var(--git-desc-fg)]"
                placeholder={t("git.commitPlaceholder", {
                  branch: props.currentBranch ?? "HEAD",
                })}
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    (event.ctrlKey || event.metaKey) &&
                    event.key === "Enter"
                  ) {
                    event.preventDefault();
                    void doCommit();
                  }
                }}
                rows={3}
              />
              <div className="flex items-stretch gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  className="min-w-8 border border-border-subtle bg-bg-panel text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                  title={t("git.generateCommitMessage")}
                  disabled={commitGenLoading || mutating}
                  onClick={async () => {
                    if (!props.generateCommitMessage) return;
                    if (groups.index.length === 0) {
                      showNotice(t("git.stageBeforeGenerateCommitMessage"), 3000);
                      return;
                    }
                    setCommitGenLoading(true);
                    try {
                      const message = await props.generateCommitMessage(props.projectId);
                      if (message) setCommitMessage(message);
                      setCommitGenLoading(false);
                    } catch (err) {
                      showNotice(
                        err instanceof Error ? err.message : t("git.generateCommitMessageFailed"),
                        5000,
                        "error",
                      );
                      setCommitGenLoading(false);
                    }
                  }}
                >
                  {commitGenLoading ? (
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                </Button>
                <Button
                  variant="default"
                  className="git-commit-btn min-w-0 flex-1 font-mono"
                  loading={committing}
                  disabled={!canCommit}
                  onClick={() => void doCommit()}
                >
                  {committing ? t("git.committing") : t("git.commit")}
                </Button>
              </div>
            </div>
            )}

            {error && <div className="flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-conflict)]">{error}</div>}
            {!loading && total === 0 && !error && (
              <div className="git-status-msg flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-desc-fg)]">{t("git.noPendingChanges")}</div>
            )}

            <div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-contain">
              {groups.merge.length > 0 && (
                <ResourceGroup
                  title={t("git.mergeChanges")}
                  count={groups.merge.length}
                  open={resourceOpen.merge}
                  onToggle={() => toggleResource("merge")}
                >
                  <FileTree
                    resources={groups.merge}
                    groupType="merge"
                    onOpenWorkspaceFileDiff={props.onOpenWorkspaceFileDiff}
                    mutating={mutating || committing}
                    projectRoot={props.projectRoot}
                    collapsedDirs={collapsedChangeDirs}
                    onToggleDir={toggleChangeDir}
                  />
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
                        groups.index.map((resource) => resource.path),
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
                    projectRoot={props.projectRoot}
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
                        workingChanges.map((resource) => resource.path),
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
                    discardFile={(path, group) => setDiscardTarget({ group, path })}
                    projectRoot={props.projectRoot}
                    collapsedDirs={collapsedChangeDirs}
                    onToggleDir={toggleChangeDir}
                  />
                </ResourceGroup>
              )}
            </div>
          </div>
        )}
      </section>

      {visibleSashAfterChanges &&
        renderSash("changes", visibleSashAfterChanges)}

      <SourceControlGraph
        projectId={props.projectId}
        commitLog={props.commitLog}
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
      />

      {paneState.open.graph &&
        visibleSashAfterGraph &&
        renderSash("graph", visibleSashAfterGraph)}

      <CompareChanges
        projectId={props.projectId}
        branches={props.branches}
        branchCompare={props.branchCompare}
        open={paneState.open.compare}
        height={paneState.heights.compare}
        onToggle={() => togglePane("compare")}
      />

      {discardTarget &&
        createPortal(
          <ConfirmDialog
            title={
              discardTarget.group === "untracked"
                ? t("git.discardUntrackedConfirmTitle")
                : t("git.discardConfirmTitle")
            }
            message={
              discardTarget.group === "untracked"
                ? t("git.discardUntrackedConfirmMessage", {
                    path: fileNameOnly(discardTarget.path),
                  })
                : t("git.discardConfirmMessage", {
                    path: fileNameOnly(discardTarget.path),
                  })
            }
            danger
            confirmLabel={
              discardTarget.group === "untracked"
                ? t("common.delete")
                : t("app.retractDiscard")
            }
            onConfirm={confirmDiscard}
            onCancel={() => setDiscardTarget(null)}
          />,
          document.body,
        )}

      {showSmartCommitPrompt &&
        createPortal(
          <div
            className="absolute inset-0 z-[1200] flex items-center justify-center bg-[var(--overlay-backdrop-soft)] p-6"
            role="presentation"
            onClick={() => setShowSmartCommitPrompt(false)}
          >
            <div
              className="w-[min(520px,calc(100vw-48px))] rounded-lg border border-border-subtle bg-bg-panel p-4 font-sans text-text-primary shadow-[var(--shadow-modal)]"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="git-smart-commit-title"
              onClick={(event) => event.stopPropagation()}
            >
              <strong id="git-smart-commit-title" className="text-base leading-6">
                {t("git.smartCommitTitle")}
              </strong>
              <p className="my-3 mb-4 text-sm leading-[22px] whitespace-pre-line text-text-secondary">{t("git.smartCommitPrompt")}</p>
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline" size="sm"
                  onClick={() => setShowSmartCommitPrompt(false)}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  type="button"
                  variant="outline" size="sm"
                  onClick={() => chooseSmartCommit("never")}
                >
                  {t("git.smartCommitNever")}
                </Button>
                <Button
                  type="button"
                  variant="outline" size="sm"
                  onClick={() => chooseSmartCommit("always")}
                >
                  {t("git.smartCommitAlways")}
                </Button>
                <Button
                  type="button"
                  variant="default" size="sm"
                  autoFocus
                  onClick={() => chooseSmartCommit("yes")}
                >
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
  projectId: string;
  branches: string[];
  branchCompare: GitPanelProps["branchCompare"];
  open: boolean;
  height: number;
  onToggle: () => void;
}) {
  const [base, setBase] = useState("");
  const [target, setTarget] = useState("");
  const [result, setResult] = useState<BranchDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestSequence = useRef(0);

  useEffect(() => {
    // Branch names overlap across projects; comparison state must not cross that boundary.
    requestSequence.current += 1;
    setBase("");
    setTarget("");
    setResult(null);
    setError(null);
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
    setError(null);
    try {
      const next = await props.branchCompare(projectId, base, target);
      if (request === requestSequence.current && projectId === props.projectId)
        setResult(next);
    } catch (caught) {
      if (
        request === requestSequence.current &&
        projectId === props.projectId
      ) {
        setResult(null);
        setError(errorMessage(caught));
      }
    } finally {
      if (request === requestSequence.current && projectId === props.projectId)
        setLoading(false);
    }
  };

  return (
    <section
      id="git-pane-compare"
      className={`flex min-h-0 flex-[0_1_auto] flex-col overflow-hidden border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] last:border-b-0${props.open ? " h-[calc(var(--git-pane-height)+26px)]" : " h-[26px]"}`}
      style={
        { "--git-pane-height": `${props.height}px` } as React.CSSProperties
      }
    >
      <PaneHeader
        id="compare"
        title={t("git.compareChanges")}
        count={result?.files.length}
        open={props.open}
        onToggle={props.onToggle}
      />
      {props.open && (
        <div className="flex min-h-0 flex-1 flex-col overflow-x-hidden overflow-y-auto overscroll-contain pb-[5px]">
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
            <Button
              type="button"
              variant="ghost" size="sm" className=" h-auto px-2.5 text-[13px]"
              disabled={!base || !target || base === target || loading}
              onClick={() => void run()}
            >
              {loading ? (
                <Loader2 size={14} className="animate-spin" />
              ) : (
                t("git.compare")
              )}
            </Button>
          </div>
          {error && <div className="flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-conflict)]">{error}</div>}
          {result && (
            <>
              <div className="flex-[0_0_auto] border-t border-[var(--git-panel-border)] px-2.5 py-1 font-mono text-[11px] text-[var(--git-desc-fg)]">
                {t("git.compareSummary", {
                  ahead: result.ahead,
                  behind: result.behind,
                  count: result.files.length,
                })}
              </div>
              <div className="min-h-0 flex-1 overflow-auto overscroll-contain">
                {result.files.map((file) => (
                  <ResourceRow
                    key={file.path}
                    status={0 as GitStatus}
                    letter=""
                    path={file.path}
                    compareStatus={file.status}
                  />
                ))}
              </div>
            </>
          )}
          {!result && !error && (
            <div className="flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-desc-fg)]">{t("git.compareHint")}</div>
          )}
        </div>
      )}
    </section>
  );
}
