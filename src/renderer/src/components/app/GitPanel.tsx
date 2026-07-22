import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { createPortal } from "react-dom";
import {
  Check,
  ChevronDown,
  GitBranch,
  Loader2,
  Plus,
  RefreshCw,
  RotateCcw,
  Sparkles,
} from "lucide-react";
import { Button } from "../ui/Button";
import { IconButton } from "../ui/IconButton";
import { ConfirmDialog } from "./AppParts";
import { showNotice } from "../../utils/notice";
import type {
  BranchDiffResult,
  CommitDetail,
  CommitEntry,
  GitChangedFile,
  GitFileStatus,
  GitResourceGroupType,
  GitResourceGroups,
} from "../../../../shared/types";
import { GitStatus } from "../../../../shared/types";
import { getFileIconColor, getFileIconSeti } from "../../fileIcons";
import { t, type TranslationKey } from "../../i18n";

type GitPanelProps = {
  projectId: string;
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
const GRAPH_COLORS = [
  "var(--git-graph-lane-1)",
  "var(--git-graph-lane-2)",
  "var(--git-graph-lane-3)",
  "var(--git-graph-lane-4)",
  "var(--git-graph-lane-5)",
  "var(--git-graph-lane-6)",
];
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

function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return t("git.relativeSeconds", { count: seconds });
  if (seconds < 3600)
    return t("git.relativeMinutes", { count: Math.floor(seconds / 60) });
  if (seconds < 86400)
    return t("git.relativeHours", { count: Math.floor(seconds / 3600) });
  if (seconds < 2592000)
    return t("git.relativeDays", { count: Math.floor(seconds / 86400) });
  if (seconds < 31536000)
    return t("git.relativeMonths", { count: Math.floor(seconds / 2592000) });
  return t("git.relativeYears", { count: Math.floor(seconds / 31536000) });
}

function fileNameOnly(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function statusTone(
  status: GitStatus | GitFileStatus,
  isCompareContext = false,
): string {
  if (isCompareContext) {
    switch (status) {
      case "added":
        return "status-added";
      case "deleted":
        return "status-deleted";
      case "renamed":
        return "status-renamed";
      default:
        return "status-modified";
    }
  }

  switch (status) {
    case GitStatus.INDEX_ADDED:
    case GitStatus.UNTRACKED:
    case GitStatus.INTENT_TO_ADD:
      return "status-added";
    case GitStatus.INDEX_DELETED:
    case GitStatus.DELETED:
      return "status-deleted";
    case GitStatus.INDEX_RENAMED:
    case GitStatus.INDEX_COPIED:
    case GitStatus.INTENT_TO_RENAME:
      return "status-renamed";
    case GitStatus.ADDED_BY_US:
    case GitStatus.ADDED_BY_THEM:
    case GitStatus.DELETED_BY_US:
    case GitStatus.DELETED_BY_THEM:
    case GitStatus.BOTH_ADDED:
    case GitStatus.BOTH_DELETED:
    case GitStatus.BOTH_MODIFIED:
      return "status-conflicting";
    default:
      return "status-modified";
  }
}

function compareStatusLetter(status: GitFileStatus): string {
  switch (status) {
    case "added":
      return "A";
    case "deleted":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

function FileIcon({ name }: { name: string }) {
  try {
    const { svg, colorName } = getFileIconSeti(name);
    return (
      <span
        aria-hidden="true"
        className="git-file-icon"
        style={{ color: getFileIconColor(colorName) }}
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  } catch {
    return (
      <span aria-hidden="true" className="git-file-icon git-file-fallback" />
    );
  }
}

/** Mirrors VS Code's monaco-tl-twistie without importing structural icons. */
function Twistie({ open }: { open: boolean }) {
  return (
    <span className={`git-twistie${open ? " open" : ""}`} aria-hidden="true" />
  );
}

function GitStageGlyph({ unstage = false }: { unstage?: boolean }) {
  return (
    <span className="git-stage-glyph" aria-hidden="true">
      {unstage ? "\u2212" : "+"}
    </span>
  );
}

function ResourceRow(props: {
  status: GitStatus;
  letter: string;
  path: string;
  compareStatus?: GitFileStatus;
  actions?: Array<{
    label: string;
    kind: "stage" | "unstage" | "discard";
    disabled?: boolean;
    run: () => void;
  }>;
  onOpen?: () => void | Promise<void>;
}) {
  const [opening, setOpening] = useState(false);
  const name = fileNameOnly(props.path);
  const tone = props.compareStatus
    ? statusTone(props.compareStatus, true)
    : statusTone(props.status);
  const letter = props.compareStatus
    ? compareStatusLetter(props.compareStatus)
    : props.letter;
  return (
    <div className={`git-resource-row ${tone}`} title={props.path}>
      {props.onOpen ? (
        <button
          type="button"
          className="git-resource-open"
          aria-label={t("git.openWorkspaceDiff", { path: props.path })}
          aria-busy={opening}
          disabled={opening}
          onClick={async () => {
            setOpening(true);
            try {
              await props.onOpen?.();
            } finally {
              setOpening(false);
            }
          }}
        >
          <FileIcon name={name} />
          <span className="git-resource-name">{name}</span>
        </button>
      ) : (
        <div className="git-resource-open static">
          <FileIcon name={name} />
          <span className="git-resource-name">{name}</span>
        </div>
      )}
      {props.actions && props.actions.length > 0 && (
        <div className="git-resource-actions">
          {props.actions.map((action) => (
            <IconButton
              key={action.kind}
              className={`git-action-btn${action.kind === "discard" ? " git-discard-action" : " git-stage-action"}`}
              label={action.label}
              disabled={action.disabled}
              onClick={action.run}
            >
              {action.kind === "discard" ? (
                <RotateCcw size={14} strokeWidth={2} aria-hidden="true" />
              ) : (
                <GitStageGlyph unstage={action.kind === "unstage"} />
              )}
            </IconButton>
          ))}
        </div>
      )}
      <span className="git-decoration" aria-hidden="true">
        {opening ? <Loader2 size={13} className="git-spin" /> : letter}
      </span>
    </div>
  );
}

function ResourceGroup(props: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  allAction?: () => void;
  allLabel?: string;
  allDisabled?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={`git-resource-group${props.open ? " open" : ""}`}>
      <div className="git-resource-group-header">
        <button
          type="button"
          className="git-resource-group-toggle"
          aria-expanded={props.open}
          onClick={props.onToggle}
        >
          <Twistie open={props.open} />
          <span className="git-resource-group-name">{props.title}</span>
        </button>
        {props.allAction && (
          <div className="git-resource-group-actions">
            <button
              type="button"
              className="git-action-btn git-stage-action"
              aria-label={props.allLabel}
              title={props.allLabel}
              disabled={props.allDisabled}
              onClick={() => props.allAction?.()}
            >
              <GitStageGlyph unstage={props.allLabel === t("git.unstageAll")} />
            </button>
          </div>
        )}
        <span className="git-resource-group-count">{props.count}</span>
      </div>
      {props.open && (
        <div className="git-resource-group-body">{props.children}</div>
      )}
    </div>
  );
}

function PaneHeader(props: {
  id: PaneId;
  title: string;
  count?: number;
  open: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <div className="git-pane-header">
      <button
        type="button"
        className="git-pane-header-toggle"
        aria-expanded={props.open}
        aria-controls={`git-pane-${props.id}`}
        onClick={props.onToggle}
      >
        <Twistie open={props.open} />
        <span className="git-pane-title">{props.title}</span>
      </button>
      {props.children && (
        <div className="git-pane-header-actions">{props.children}</div>
      )}
      {typeof props.count === "number" && props.count > 0 && (
        <span className="git-pane-count">{props.count}</span>
      )}
    </div>
  );
}

/**
 * 紧凑型下拉筛选器，替换原生 <select> 用于 Git pane header 中的过滤/选择场景。
 * 使用统一的按钮+弹出菜单，避免 Windows 原生 <select> 样式不一致的问题。
 */
function GitCompactFilter(props: {
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  ariaLabel: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  const selected = props.options.find((o) => o.value === props.value);

  return (
    <div
      ref={containerRef}
      className={`git-compact-filter${props.className ? ` ${props.className}` : ""}`}
    >
      <button
        type="button"
        className="git-compact-filter-btn"
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="git-compact-filter-label">
          {selected?.label ?? props.value}
        </span>
        <ChevronDown
          size={12}
          className={`git-compact-filter-chevron${open ? " open" : ""}`}
        />
      </button>
      {open && (
        <div className="git-compact-filter-menu" role="listbox">
          {props.options.map((opt) => (
            <button
              key={opt.value}
              type="button"
              className={`git-compact-filter-opt${opt.value === props.value ? " active" : ""}`}
              role="option"
              aria-selected={opt.value === props.value}
              onClick={() => {
                props.onChange(opt.value);
                setOpen(false);
              }}
            >
              {opt.label}
              {opt.value === props.value && (
                <Check size={12} className="git-compact-filter-check" />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
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
      className="git-pane-sash"
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
  const [mutating, setMutating] = useState(false);
  const [notAGitRepo, setNotAGitRepo] = useState(false);
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
  const branchBarRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭分支下拉
  useEffect(() => {
    if (!branchOpen) return;
    const handler = (event: MouseEvent) => {
      if (
        branchBarRef.current &&
        !branchBarRef.current.contains(event.target as Node)
      ) {
        setBranchOpen(false);
        setBranchCreating(false);
        setNewBranchName("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [branchOpen]);

  return (
    <div
      ref={panelRef}
      className="git-panel"
      aria-label={t("git.sourceControl")}
    >
      {/* 当前分支 + 切换下拉 */}
      <div className="git-branch-bar" ref={branchBarRef}>
        <button
          className="git-branch-trigger"
          onClick={() => setBranchOpen((v) => !v)}
          title={
            props.currentBranch
              ? t("app.branchCurrent", {
                  branch: props.currentBranch,
                  count: props.branches.length,
                })
              : undefined
          }
        >
          <GitBranch size={14} />
          <span className="git-branch-label">
            {props.currentBranch || t("app.branchNone")}
          </span>
          {props.branches.length > 0 && (
            <span className="git-branch-badge">{props.branches.length}</span>
          )}
          <ChevronDown
            size={12}
            className={`git-branch-chevron${branchOpen ? " open" : ""}`}
          />
        </button>
        {branchOpen && (
          <div className="git-branch-dropdown">
            {props.branches.map((branch) => (
              <button
                key={branch}
                className={`git-branch-item${branch === props.currentBranch ? " active" : ""}`}
                onClick={() => {
                  if (branch !== props.currentBranch)
                    props.onSwitchBranch?.(branch);
                  setBranchOpen(false);
                }}
              >
                {branch === props.currentBranch && (
                  <Check size={14} className="git-branch-check" />
                )}
                <span>{branch}</span>
              </button>
            ))}
            <div className="git-branch-divider" />
            {branchCreating ? (
              <div className="git-branch-create-form">
                <input
                  type="text"
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
                <button
                  className="git-branch-create-confirm"
                  disabled={!newBranchName.trim()}
                  onClick={() => {
                    props.onCreateBranch?.(newBranchName.trim());
                    setBranchCreating(false);
                    setNewBranchName("");
                    setBranchOpen(false);
                  }}
                >
                  <Check size={14} />
                </button>
              </div>
            ) : (
              <button
                className="git-branch-item git-branch-create-btn"
                onClick={() => setBranchCreating(true)}
              >
                <Plus size={14} />
                <span>{t("app.branchCreate")}</span>
              </button>
            )}
          </div>
        )}
      </div>
      <section
        id="git-pane-changes"
        className={`git-pane git-pane-changes${paneState.open.changes ? " open" : " collapsed"}`}
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
              className="git-spin"
              aria-label={t("common.loading")}
            />
          )}
          <button
            type="button"
            className="git-action-btn"
            title={t("common.refresh")}
            aria-label={t("common.refresh")}
            onClick={() => void refresh()}
          >
            <RefreshCw size={14} />
          </button>
        </PaneHeader>
        {paneState.open.changes && (
          <div className="git-pane-body git-changes-body">
            {notAGitRepo ? (
              <div className="git-not-init">
                <div className="git-not-init-prompt">{t("git.notAGitRepo")}</div>
                <button
                  type="button"
                  className="git-compare-btn"
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
                    <Loader2 size={14} className="git-spin" />
                  ) : (
                    t("git.initRepo")
                  )}
                </button>
              </div>
            ) : (
            <div className="git-scm-input-wrap">
              <textarea
                className="git-scm-input"
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
              <div className="git-commit-actions">
                <button
                  type="button"
                  className="git-commit-gen-btn"
                  title={t("git.generateCommitMessage")}
                  disabled={commitGenLoading || mutating}
                  onClick={async () => {
                    if (!props.generateCommitMessage) return;
                    // 无暂存文件时提示用户先暂存再生成摘要
                    if (groups.index.length === 0) {
                      showNotice(t("git.stageBeforeGenerateCommitMessage"), 3000);
                      return;
                    }
                    setCommitGenLoading(true);
                    try {
                      const message = await props.generateCommitMessage(
                        props.projectId,
                      );
                      if (message) setCommitMessage(message);
                    } catch (err) {
                      showNotice(
                        err instanceof Error ? err.message : t("git.generateCommitMessageFailed"),
                        5000,
                        "error",
                      );
                    setCommitGenLoading(false);
                  }}
                >
                  {commitGenLoading ? (
                    <Loader2 size={14} className="git-spin" />
                  ) : (
                    <Sparkles size={14} />
                  )}
                </button>
                <Button
                  variant="primary"
                  className="git-commit-btn"
                  loading={committing}
                  disabled={!canCommit}
                  onClick={() => void doCommit()}
                >
                  {committing ? t("git.committing") : t("git.commit")}
                </Button>
              </div>
            </div>

            {error && <div className="git-status-msg error">{error}</div>}
            {!loading && total === 0 && !error && (
              <div className="git-status-msg">{t("git.noPendingChanges")}</div>
            )}

            <div className="git-resource-list">
              {groups.merge.length > 0 && (
                <ResourceGroup
                  title={t("git.mergeChanges")}
                  count={groups.merge.length}
                  open={resourceOpen.merge}
                  onToggle={() => toggleResource("merge")}
                >
                  {groups.merge.map((resource) => (
                    <ResourceRow
                      key={resource.path}
                      status={resource.status}
                      letter={resource.letter}
                      path={resource.path}
                      onOpen={() =>
                        props.onOpenWorkspaceFileDiff("merge", resource.path)
                      }
                      actions={[
                        {
                          kind: "stage",
                          label: t("git.stage"),
                          disabled: mutating || committing,
                          run: () =>
                            act(() =>
                              props.stageFiles(props.projectId, [
                                resource.path,
                              ]),
                            ),
                        },
                      ]}
                    />
                  ))}
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
                  {groups.index.map((resource) => (
                    <ResourceRow
                      key={resource.path}
                      status={resource.status}
                      letter={resource.letter}
                      path={resource.path}
                      onOpen={() =>
                        props.onOpenWorkspaceFileDiff("index", resource.path)
                      }
                      actions={[
                        {
                          kind: "unstage",
                          label: t("git.unstage"),
                          disabled: mutating || committing,
                          run: () =>
                            act(() =>
                              props.unstageFiles(props.projectId, [
                                resource.path,
                              ]),
                            ),
                        },
                      ]}
                    />
                  ))}
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
                  {workingChanges.map((resource) => (
                    <ResourceRow
                      key={`${resource.status}-${resource.path}`}
                      status={resource.status}
                      letter={resource.letter}
                      path={resource.path}
                      onOpen={() =>
                        props.onOpenWorkspaceFileDiff(
                          resource.status === GitStatus.UNTRACKED
                            ? "untracked"
                            : "workingTree",
                          resource.path,
                        )
                      }
                      actions={[
                        {
                          kind: "discard",
                          label:
                            resource.status === GitStatus.UNTRACKED
                              ? t("git.discardUntracked")
                              : t("git.discard"),
                          disabled: mutating || committing,
                          run: () =>
                            setDiscardTarget({
                              group:
                                resource.status === GitStatus.UNTRACKED
                                  ? "untracked"
                                  : "workingTree",
                              path: resource.path,
                            }),
                        },
                        {
                          kind: "stage",
                          label: t("git.stage"),
                          disabled: mutating || committing,
                          run: () =>
                            act(() =>
                              props.stageFiles(props.projectId, [
                                resource.path,
                              ]),
                            ),
                        },
                      ]}
                    />
                  ))}
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
            className="git-smart-commit-backdrop"
            role="presentation"
            onClick={() => setShowSmartCommitPrompt(false)}
          >
            <div
              className="git-smart-commit-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="git-smart-commit-title"
              onClick={(event) => event.stopPropagation()}
            >
              <strong id="git-smart-commit-title">
                {t("git.smartCommitTitle")}
              </strong>
              <p>{t("git.smartCommitPrompt")}</p>
              <div className="git-smart-commit-actions">
                <button
                  type="button"
                  onClick={() => setShowSmartCommitPrompt(false)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  onClick={() => chooseSmartCommit("never")}
                >
                  {t("git.smartCommitNever")}
                </button>
                <button
                  type="button"
                  onClick={() => chooseSmartCommit("always")}
                >
                  {t("git.smartCommitAlways")}
                </button>
                <button
                  type="button"
                  className="primary"
                  autoFocus
                  onClick={() => chooseSmartCommit("yes")}
                >
                  {t("git.smartCommitYes")}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}

type GraphNode = { id: string; color: number };
type GraphRow = {
  commit: CommitEntry;
  input: GraphNode[];
  output: GraphNode[];
  nodeIndex: number;
};

type GraphPath = { d: string; color: number };

const GRAPH_LANE_WIDTH = 14;
const GRAPH_ROW_HEIGHT = 28;
const GRAPH_CURVE_RADIUS = 6;
const GRAPH_NODE_RADIUS = 4.5;
const MAX_VISIBLE_GRAPH_LANES = 8;

/**
 * Build VS Code-style input/output swimlanes from topologically ordered commits.
 * An unseen commit intentionally starts at input.length; this preserves existing
 * lanes while refs introduced by --all enter from the right without crossing them.
 */
function buildGraphRows(commits: CommitEntry[]): GraphRow[] {
  let colorIndex = -1;
  let previousOutput: GraphNode[] = [];

  return commits.map((commit) => {
    const input = previousOutput.map((node) => ({ ...node }));
    const inputIndex = input.findIndex((node) => node.id === commit.hash);
    const nodeIndex = inputIndex === -1 ? input.length : inputIndex;
    const output: GraphNode[] = [];
    let firstParentAdded = false;

    for (const node of input) {
      if (node.id === commit.hash) {
        if (commit.parents.length > 0 && !firstParentAdded) {
          output.push({ id: commit.parents[0], color: node.color });
          firstParentAdded = true;
        }
        continue;
      }
      output.push({ ...node });
    }

    for (
      let index = firstParentAdded ? 1 : 0;
      index < commit.parents.length;
      index++
    ) {
      colorIndex = (colorIndex + 1) % GRAPH_COLORS.length;
      output.push({ id: commit.parents[index], color: colorIndex });
    }

    previousOutput = output;
    return { commit, input, output, nodeIndex };
  });
}

function laneX(index: number): number {
  return GRAPH_LANE_WIDTH * (index + 1);
}

function lastNodeIndex(nodes: GraphNode[], id: string): number {
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    if (nodes[index].id === id) return index;
  }
  return -1;
}

function GraphLanes({ row, current }: { row: GraphRow; current: boolean }) {
  const { commit, input, output, nodeIndex } = row;
  const inputIndex = input.findIndex((node) => node.id === commit.hash);
  const nodeColor =
    inputIndex !== -1
      ? input[inputIndex].color
      : (output[nodeIndex]?.color ?? 0);
  const paths: GraphPath[] = [];
  let outputIndex = 0;

  // This follows renderSCMHistoryItemGraph rather than approximating it: each
  // surviving input lane is matched to the next output lane and bent only when
  // deleting the current commit shifts that lane to the left.
  for (let index = 0; index < input.length; index += 1) {
    const node = input[index];
    if (node.id === commit.hash) {
      if (index !== nodeIndex) {
        paths.push({
          d: `M ${laneX(index)} 0 A ${GRAPH_LANE_WIDTH} ${GRAPH_LANE_WIDTH} 0 0 1 ${GRAPH_LANE_WIDTH * index} ${GRAPH_ROW_HEIGHT / 2} H ${laneX(nodeIndex)}`,
          color: node.color,
        });
      } else if (commit.parents.length > 0) {
        // 第一父提交占据当前 lane；root commit 则会删除 lane，后续 lane 需要左移匹配。
        outputIndex += 1;
      }
      continue;
    }

    if (outputIndex >= output.length || node.id !== output[outputIndex].id)
      continue;
    if (index === outputIndex) {
      paths.push({
        d: `M ${laneX(index)} 0 V ${GRAPH_ROW_HEIGHT}`,
        color: node.color,
      });
    } else {
      paths.push({
        d: `M ${laneX(index)} 0 V ${GRAPH_ROW_HEIGHT / 2 - GRAPH_CURVE_RADIUS} A ${GRAPH_CURVE_RADIUS} ${GRAPH_CURVE_RADIUS} 0 0 1 ${laneX(index) - GRAPH_CURVE_RADIUS} ${GRAPH_ROW_HEIGHT / 2} H ${laneX(outputIndex) + GRAPH_CURVE_RADIUS} A ${GRAPH_CURVE_RADIUS} ${GRAPH_CURVE_RADIUS} 0 0 0 ${laneX(outputIndex)} ${GRAPH_ROW_HEIGHT / 2 + GRAPH_CURVE_RADIUS} V ${GRAPH_ROW_HEIGHT}`,
        color: node.color,
      });
    }
    outputIndex += 1;
  }

  for (
    let parentIndex = 1;
    parentIndex < commit.parents.length;
    parentIndex += 1
  ) {
    const parentOutputIndex = lastNodeIndex(
      output,
      commit.parents[parentIndex],
    );
    if (parentOutputIndex === -1) continue;
    paths.push({
      d: `M ${GRAPH_LANE_WIDTH * parentOutputIndex} ${GRAPH_ROW_HEIGHT / 2} A ${GRAPH_LANE_WIDTH} ${GRAPH_LANE_WIDTH} 0 0 1 ${laneX(parentOutputIndex)} ${GRAPH_ROW_HEIGHT} M ${GRAPH_LANE_WIDTH * parentOutputIndex} ${GRAPH_ROW_HEIGHT / 2} H ${laneX(nodeIndex)}`,
      color: output[parentOutputIndex].color,
    });
  }

  if (inputIndex !== -1) {
    paths.push({
      d: `M ${laneX(nodeIndex)} 0 V ${GRAPH_ROW_HEIGHT / 2}`,
      color: input[inputIndex].color,
    });
  }
  if (commit.parents.length > 0) {
    paths.push({
      d: `M ${laneX(nodeIndex)} ${GRAPH_ROW_HEIGHT / 2} V ${GRAPH_ROW_HEIGHT}`,
      color: nodeColor,
    });
  }

  const width =
    GRAPH_LANE_WIDTH *
    (Math.min(
      MAX_VISIBLE_GRAPH_LANES,
      Math.max(input.length, output.length, 1),
    ) +
      1);
  return (
    <span className="git-graph-cell" style={{ width }}>
      <svg
        className="git-graph-svg"
        width={width}
        height={GRAPH_ROW_HEIGHT}
        viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`}
        aria-hidden="true"
      >
        {paths.map((path, index) => (
          <path
            key={`${path.d}-${index}`}
            d={path.d}
            fill="none"
            stroke={GRAPH_COLORS[path.color % GRAPH_COLORS.length]}
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {commit.parents.length > 1 && (
          <circle
            cx={laneX(nodeIndex)}
            cy={GRAPH_ROW_HEIGHT / 2}
            r={GRAPH_NODE_RADIUS + 2}
            fill="var(--git-panel-bg)"
            stroke={GRAPH_COLORS[nodeColor % GRAPH_COLORS.length]}
            strokeWidth="1.6"
          />
        )}
        <circle
          cx={laneX(nodeIndex)}
          cy={GRAPH_ROW_HEIGHT / 2}
          r={current ? GRAPH_NODE_RADIUS + 0.5 : GRAPH_NODE_RADIUS}
          fill={GRAPH_COLORS[nodeColor % GRAPH_COLORS.length]}
          stroke="var(--git-panel-bg)"
          strokeWidth="2"
        />
        {current && (
          <circle
            cx={laneX(nodeIndex)}
            cy={GRAPH_ROW_HEIGHT / 2}
            r="2"
            fill="var(--git-panel-bg)"
          />
        )}
      </svg>
    </span>
  );
}

function primaryRef(
  refNames: string[],
): { label: string; kind: "branch" | "tag" } | null {
  const refs = refNames
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  const current = refs.find((item) => item.startsWith("HEAD -> "));
  if (current)
    return { label: current.replace("HEAD -> ", ""), kind: "branch" };
  const tag = refs.find((item) => item.startsWith("tag: "));
  if (tag) return { label: tag.replace("tag: ", ""), kind: "tag" };
  return null;
}

function absoluteTime(ms: number): string {
  if (!Number.isFinite(ms)) return "";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function GraphContinuation({ row }: { row: GraphRow }) {
  const width =
    GRAPH_LANE_WIDTH *
    (Math.min(MAX_VISIBLE_GRAPH_LANES, Math.max(row.output.length, 1)) + 1);
  return (
    <span
      className="git-graph-cell git-graph-continuation"
      style={{ width }}
      aria-hidden="true"
    >
      <svg
        className="git-graph-svg"
        width={width}
        height="26"
        viewBox={`0 0 ${width} 26`}
      >
        {row.output.slice(0, MAX_VISIBLE_GRAPH_LANES).map((node, index) => (
          <path
            key={`${node.id}-${index}`}
            d={`M ${laneX(index)} 0 V 26`}
            fill="none"
            stroke={GRAPH_COLORS[node.color % GRAPH_COLORS.length]}
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        ))}
      </svg>
    </span>
  );
}

function CommitFileRow(props: {
  file: GitChangedFile;
  row: GraphRow;
  onOpen: () => void | Promise<void>;
}) {
  const { file, row } = props;
  const [opening, setOpening] = useState(false);
  const name = fileNameOnly(file.path);
  const description = file.originalPath
    ? t("git.renamedFrom", { path: file.originalPath })
    : file.path;
  return (
    <button
      type="button"
      className={`git-history-file-row ${statusTone(file.status, true)}`}
      title={
        file.originalPath ? `${file.originalPath} → ${file.path}` : file.path
      }
      aria-label={t("git.openFileDiff", { path: file.path })}
      aria-busy={opening}
      disabled={opening}
      onClick={async (event) => {
        event.stopPropagation();
        setOpening(true);
        try {
          await props.onOpen();
        } finally {
          setOpening(false);
        }
      }}
    >
      <GraphContinuation row={row} />
      <span className="git-history-file-content">
        <FileIcon name={name} />
        <span className="git-history-file-name">{name}</span>
        <span className="git-history-file-path">{description}</span>
      </span>
      <span className="git-decoration" aria-hidden="true">
        {opening ? (
          <Loader2 size={13} className="git-spin" />
        ) : (
          compareStatusLetter(file.status)
        )}
      </span>
    </button>
  );
}

type CommitHoverState = {
  commit: CommitEntry;
  anchor: DOMRect;
};

type CommitDetailState = {
  detail: CommitDetail | null;
  loading: boolean;
  error: string | null;
};

const GRAPH_DETAIL_CACHE_LIMIT = 16;
const GRAPH_DETAIL_CACHE_BYTE_LIMIT = 2 * 1024 * 1024;
const COMMIT_HOVER_OPEN_DELAY_MS = 500;
// 浮层与窄抽屉中的 commit 行之间可能隔着 8px；给鼠标足够时间跨过间隙并进入可滚动浮层。
const COMMIT_HOVER_DISMISS_DELAY_MS = 400;

function estimateGraphDetailBytes(state: CommitDetailState): number {
  if (!state.detail) return (state.error?.length ?? 0) * 2 + 64;
  const { commit, files } = state.detail;
  const text = [
    commit.hash,
    commit.authorName,
    commit.authorEmail,
    commit.message,
    commit.fullMessage ?? "",
    ...commit.parents,
    ...commit.refNames,
  ];
  for (const file of files) text.push(file.path, file.originalPath ?? "");
  return (
    text.reduce((sum, value) => sum + value.length * 2, 0) + files.length * 64
  );
}

function CommitHoverCard(props: {
  hover: CommitHoverState;
  state: CommitDetailState | undefined;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}) {
  const commit = props.state?.detail?.commit ?? props.hover.commit;
  const shortStat = props.state?.detail?.commit.shortStat;
  const gap = 8;
  const margin = 8;
  const width = Math.min(360, Math.max(0, window.innerWidth - margin * 2));
  const maxHeight = Math.min(420, Math.max(0, window.innerHeight - margin * 2));
  let left = props.hover.anchor.right + gap;
  if (left + width > window.innerWidth - margin) {
    left = props.hover.anchor.left - width - gap;
  }
  left = Math.max(margin, Math.min(left, window.innerWidth - width - margin));
  const top = Math.max(
    margin,
    Math.min(props.hover.anchor.top, window.innerHeight - margin - maxHeight),
  );
  const refs = commit.refNames
    .flatMap((item) => item.split(","))
    .map((item) => item.trim())
    .filter(Boolean);
  const initial =
    commit.authorName.trim().slice(0, 1).toLocaleUpperCase() || "?";

  return createPortal(
    <div
      id="git-commit-hover"
      className="git-commit-hover"
      role="tooltip"
      style={{ left, top, width }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      <div className="git-commit-hover-author">
        <span className="git-commit-hover-avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="git-commit-hover-author-text">
          <strong>{commit.authorName}</strong>
          {commit.authorEmail && <span>{`<${commit.authorEmail}>`}</span>}
          <small>
            {relativeTime(commit.authorDate)} ·{" "}
            {absoluteTime(commit.authorDate)}
          </small>
        </span>
      </div>
      <div className="git-commit-hover-message">
        {commit.fullMessage || commit.message}
      </div>
      <div className="git-commit-hover-identity">
        <code>{commit.hash}</code>
        {refs.length > 0 && (
          <div className="git-commit-hover-refs">
            {refs.map((item) => (
              <span key={item}>{item}</span>
            ))}
          </div>
        )}
      </div>
      {props.state?.loading && (
        <div className="git-commit-hover-status">
          <Loader2 size={13} className="git-spin" />{" "}
          {t("git.loadingCommitDetails")}
        </div>
      )}
      {props.state?.error && (
        <div className="git-commit-hover-status error">{props.state.error}</div>
      )}
      {shortStat && (
        <div className="git-commit-hover-stat">
          <span>{t("git.filesChanged", { count: shortStat.files })}</span>
          <span className="added">+{shortStat.insertions}</span>
          <span className="deleted">-{shortStat.deletions}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}

function SourceControlGraph(props: {
  projectId: string;
  commitLog: GitPanelProps["commitLog"];
  commitDetail: GitPanelProps["commitDetail"];
  onOpenCommitFileDiff: GitPanelProps["onOpenCommitFileDiff"];
  branches: string[];
  currentBranch: string | null;
  open: boolean;
  height: number;
  onToggle: () => void;
  cherryPick?: GitPanelProps["cherryPick"];
  revert?: GitPanelProps["revert"];
  reset?: GitPanelProps["reset"];
  dropCommit?: GitPanelProps["dropCommit"];
}) {
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ref, setRef] = useState("");
  const [expandedHashes, setExpandedHashes] = useState<Set<string>>(
    () => new Set(),
  );
  const [detailStates, setDetailStates] = useState<
    Record<string, CommitDetailState>
  >({});
  const [hover, setHover] = useState<CommitHoverState | null>(null);
  const loadSequence = useRef(0);
  const detailSequence = useRef(0);
  const detailStateRef = useRef<Record<string, CommitDetailState>>({});
  const detailAccessOrder = useRef<string[]>([]);
  const detailRequests = useRef(
    new Map<string, Promise<CommitDetail | null>>(),
  );
  const hoverTimer = useRef<number | null>(null);
  const hoverDismissTimer = useRef<number | null>(null);
  const hoverOverCard = useRef(false);

  const clearHoverTimer = useCallback(() => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);

  const clearHoverDismissTimer = useCallback(() => {
    if (hoverDismissTimer.current !== null) {
      window.clearTimeout(hoverDismissTimer.current);
      hoverDismissTimer.current = null;
    }
  }, []);

  const resetCommitDetails = useCallback(() => {
    detailSequence.current += 1;
    detailRequests.current.clear();
    detailStateRef.current = {};
    detailAccessOrder.current = [];
    setDetailStates({});
    setExpandedHashes(new Set());
    setHover(null);
    clearHoverTimer();
    clearHoverDismissTimer();
    hoverOverCard.current = false;
  }, [clearHoverTimer, clearHoverDismissTimer]);

  const updateDetailState = useCallback(
    (hash: string, state: CommitDetailState) => {
      const next = { ...detailStateRef.current, [hash]: state };
      detailAccessOrder.current = [
        ...detailAccessOrder.current.filter((entry) => entry !== hash),
        hash,
      ];
      const totalBytes = () =>
        Object.values(next).reduce(
          (sum, entry) => sum + estimateGraphDetailBytes(entry),
          0,
        );
      const evicted: string[] = [];
      while (
        detailAccessOrder.current.length > GRAPH_DETAIL_CACHE_LIMIT ||
        totalBytes() > GRAPH_DETAIL_CACHE_BYTE_LIMIT
      ) {
        const oldest = detailAccessOrder.current.shift();
        if (!oldest) break;
        delete next[oldest];
        evicted.push(oldest);
      }
      if (evicted.length > 0) {
        setExpandedHashes((current) => {
          const updated = new Set(current);
          for (const evictedHash of evicted) updated.delete(evictedHash);
          return updated;
        });
      }
      detailStateRef.current = next;
      setDetailStates(next);
    },
    [],
  );

  const loadCommitDetail = useCallback(
    (hash: string): Promise<CommitDetail | null> => {
      const cached = detailStateRef.current[hash];
      // 成功和失败结果都保留到 Graph 下次刷新；否则不可用的提交会在每次 hover 时重复拉起 Git 子进程。
      if (cached && !cached.loading) {
        detailAccessOrder.current = [
          ...detailAccessOrder.current.filter((entry) => entry !== hash),
          hash,
        ];
        return Promise.resolve(cached.detail);
      }
      const pending = detailRequests.current.get(hash);
      if (pending) return pending;

      const requestSequence = detailSequence.current;
      const projectId = props.projectId;
      updateDetailState(hash, { detail: null, loading: true, error: null });
      const request = props
        .commitDetail(projectId, hash)
        .then((detail) => {
          if (
            requestSequence !== detailSequence.current ||
            projectId !== props.projectId
          )
            return null;
          updateDetailState(
            hash,
            detail
              ? { detail, loading: false, error: null }
              : {
                  detail: null,
                  loading: false,
                  error: t("git.commitDetailsUnavailable"),
                },
          );
          return detail;
        })
        .catch((caught) => {
          if (
            requestSequence === detailSequence.current &&
            projectId === props.projectId
          ) {
            updateDetailState(hash, {
              detail: null,
              loading: false,
              error: errorMessage(caught),
            });
          }
          return null;
        })
        .finally(() => {
          if (detailRequests.current.get(hash) === request)
            detailRequests.current.delete(hash);
        });
      detailRequests.current.set(hash, request);
      return request;
    },
    [props.commitDetail, props.projectId, updateDetailState],
  );

  useEffect(() => {
    // A project can reuse the same branch name, so all graph-local state must stop at this boundary.
    loadSequence.current += 1;
    setCommits([]);
    setError(null);
    setLoading(false);
    setRef("");
    resetCommitDetails();
  }, [props.projectId, resetCommitDetails]);

  useEffect(() => {
    if (!props.open) {
      setHover(null);
      clearHoverTimer();
    }
  }, [clearHoverTimer, props.open]);

  useEffect(() => {
    const dismissOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") {
        clearHoverTimer();
        clearHoverDismissTimer();
        setHover(null);
      }
    };
    // Hover 使用打开时缓存的 DOMRect；窗口尺寸变化后旧坐标不再可靠，直接关闭等待重新触发。
    const dismissOnResize = () => {
      clearHoverTimer();
      clearHoverDismissTimer();
      setHover(null);
    };
    window.addEventListener("keydown", dismissOnEscape);
    window.addEventListener("resize", dismissOnResize);
    return () => {
      window.removeEventListener("keydown", dismissOnEscape);
      window.removeEventListener("resize", dismissOnResize);
      clearHoverTimer();
      clearHoverDismissTimer();
      detailSequence.current += 1;
    };
  }, [clearHoverTimer, clearHoverDismissTimer]);

  /** 提交条目右键菜单状态 */
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    commit: CommitEntry;
  } | null>(null);
  /** 确认弹框状态 */
  const [confirmAction, setConfirmAction] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  /** 右键操作loading */
  const [contextMenuLoading, setContextMenuLoading] = useState<string | null>(
    null,
  );
  /** 加载更多的计数（每次加 30） */
  const [loadCount, setLoadCount] = useState(30);

  /** 右键菜单关闭 */
  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  /** 执行右键操作（通过 ref 引用 load，避免循环依赖） */
  const loadRef = useRef<() => void>(() => {});
  const runGitAction = useCallback(
    async (
      action: string,
      run: () => Promise<void> | void,
      successKey: TranslationKey,
    ) => {
      const hash = contextMenu?.commit.hash ?? "";
      setContextMenuLoading(action);
      closeContextMenu();
      try {
        await run();
        showNotice(t(successKey, { hash: hash.substring(0, 7) }), 2000);
        loadRef.current();
      } catch (err) {
        showNotice(
          t("git.contextMenuFailed", { error: errorMessage(err) }),
          3000,
        );
      } finally {
        setContextMenuLoading(null);
      }
    },
    [contextMenu, closeContextMenu],
  );

  useEffect(() => {
    loadRef.current = load;
  });

  const load = useCallback(async () => {
    if (!props.open) return;
    const request = ++loadSequence.current;
    const projectId = props.projectId;
    setLoading(true);
    setError(null);
    resetCommitDetails();
    try {
      const next = await props.commitLog(projectId, {
        maxEntries: loadCount,
        ref: ref || undefined,
        allBranches: !ref,
      });
      if (request === loadSequence.current && projectId === props.projectId)
        setCommits(next);
    } catch (caught) {
      if (request === loadSequence.current && projectId === props.projectId)
        setError(errorMessage(caught));
    } finally {
      if (request === loadSequence.current && projectId === props.projectId)
        setLoading(false);
    }
  }, [
    props.commitLog,
    props.open,
    props.projectId,
    ref,
    resetCommitDetails,
    loadCount,
  ]);

  useEffect(() => {
    void load();
  }, [load]);
  const graphRows = useMemo(() => buildGraphRows(commits), [commits]);

  const toggleCommit = useCallback(
    (hash: string) => {
      const isOpening = !expandedHashes.has(hash);
      setExpandedHashes((current) => {
        const next = new Set(current);
        if (isOpening) next.add(hash);
        else next.delete(hash);
        return next;
      });
      if (isOpening && !detailStateRef.current[hash])
        void loadCommitDetail(hash);
    },
    [expandedHashes, loadCommitDetail],
  );

  const scheduleHover = useCallback(
    (commit: CommitEntry, anchor: HTMLElement) => {
      clearHoverTimer();
      clearHoverDismissTimer();
      hoverOverCard.current = false;
      const anchorRect = anchor.getBoundingClientRect();
      hoverTimer.current = window.setTimeout(() => {
        hoverTimer.current = null;
        setHover({ commit, anchor: anchorRect });
        void loadCommitDetail(commit.hash);
      }, COMMIT_HOVER_OPEN_DELAY_MS);
    },
    [clearHoverTimer, loadCommitDetail],
  );

  const dismissHover = useCallback(() => {
    clearHoverTimer();
    clearHoverDismissTimer();
    setHover(null);
  }, [clearHoverTimer, clearHoverDismissTimer]);

  /** 鼠标离开提交行按钮时延迟关闭，允许用户跨过间隙后进入并滚动详情浮层。 */
  const handleRowMouseLeave = useCallback(() => {
    clearHoverTimer();
    clearHoverDismissTimer();
    hoverDismissTimer.current = window.setTimeout(() => {
      if (!hoverOverCard.current) setHover(null);
    }, COMMIT_HOVER_DISMISS_DELAY_MS);
  }, [clearHoverTimer, clearHoverDismissTimer]);

  /** 鼠标进入浮层卡片，取消延迟消失。 */
  const handleCardMouseEnter = useCallback(() => {
    hoverOverCard.current = true;
    clearHoverDismissTimer();
  }, [clearHoverDismissTimer]);

  /** 鼠标离开浮层卡片，直接关闭。 */
  const handleCardMouseLeave = useCallback(() => {
    hoverOverCard.current = false;
    setHover(null);
  }, []);

  return (
    <section
      id="git-pane-graph"
      className={`git-pane git-pane-graph${props.open ? " open" : " collapsed"}`}
      style={
        { "--git-pane-height": `${props.height}px` } as React.CSSProperties
      }
    >
      <PaneHeader
        id="graph"
        title={t("git.sourceControlGraph")}
        count={commits.length}
        open={props.open}
        onToggle={props.onToggle}
      >
        <GitCompactFilter
          value={ref}
          ariaLabel={t("git.filterReference")}
          options={[
            { value: "", label: t("common.all") },
            ...props.branches.map((branch) => ({
              value: branch,
              label: branch,
            })),
          ]}
          onChange={(value) => setRef(value)}
        />
        <button
          type="button"
          className="git-action-btn"
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </button>
      </PaneHeader>
      {props.open && (
        <div className="git-pane-body git-graph-body">
          {loading && !commits.length && (
            <div className="git-status-msg">
              <Loader2 size={14} className="git-spin" />{" "}
              {t("git.loadingCommits")}
            </div>
          )}
          {error && <div className="git-status-msg error">{error}</div>}
          {!loading && !error && !commits.length && (
            <div className="git-status-msg">{t("git.noCommits")}</div>
          )}
          {commits.length > 0 && (
            <div
              className="git-history-list"
              role="list"
              onScroll={dismissHover}
            >
              {graphRows.map((row) => {
                const commit = row.commit;
                const detailState = detailStates[commit.hash];
                const commitFiles = detailState?.detail?.files ?? [];
                const expanded = expandedHashes.has(commit.hash);
                const ref = primaryRef(commit.refNames);
                const isCurrent = commit.refNames.some((item) =>
                  item.includes("HEAD ->"),
                );
                return (
                  <div
                    key={commit.hash}
                    className="git-history-item"
                    role="listitem"
                  >
                    <button
                      type="button"
                      className={`git-history-row${isCurrent ? " current" : ""}${expanded ? " expanded" : ""}`}
                      aria-expanded={expanded}
                      aria-describedby={
                        hover?.commit.hash === commit.hash
                          ? "git-commit-hover"
                          : undefined
                      }
                      onClick={() => {
                        // 点击只展开文件列表；先取消 hover，避免按钮获得焦点后误显示提交详情。
                        dismissHover();
                        toggleCommit(commit.hash);
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setContextMenu({
                          x: event.clientX,
                          y: event.clientY,
                          commit,
                        });
                      }}
                      onMouseEnter={(event) =>
                        scheduleHover(commit, event.currentTarget)
                      }
                      onMouseLeave={handleRowMouseLeave}
                    >
                      <GraphLanes row={row} current={isCurrent} />
                      <span className="git-history-label">
                        <span className="git-history-msg">
                          <Twistie open={expanded} />
                          {commit.message}
                        </span>
                        <span className="git-history-author">
                          {commit.authorName}
                        </span>
                      </span>
                      {ref && (
                        <span className={`git-ref git-ref-${ref.kind}`}>
                          {ref.label}
                        </span>
                      )}
                    </button>
                    {expanded && (
                      <div className="git-history-children">
                        {detailState?.loading && (
                          <div className="git-history-detail-status">
                            <GraphContinuation row={row} />
                            <span>
                              <Loader2 size={13} className="git-spin" />{" "}
                              {t("git.loadingCommitFiles")}
                            </span>
                          </div>
                        )}
                        {detailState?.error && !detailState.loading && (
                          <div className="git-history-detail-status error">
                            <GraphContinuation row={row} />
                            <span>{detailState.error}</span>
                          </div>
                        )}
                        {detailState?.detail && commitFiles.length === 0 && (
                          <div className="git-history-detail-status">
                            <GraphContinuation row={row} />
                            <span>{t("git.noCommitFiles")}</span>
                          </div>
                        )}
                        {commitFiles.map((file) => (
                          <CommitFileRow
                            key={`${file.originalPath ?? ""}-${file.path}`}
                            file={file}
                            row={row}
                            onOpen={() =>
                              props.onOpenCommitFileDiff(commit, file)
                            }
                          />
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {/* "加载更多"按钮放在列表底部；当返回的提交数等于当前请求数时，可能还有更多可加载 */}
              {commits.length === loadCount && commits.length > 0 && (
                <button
                  type="button"
                  className="git-load-more-btn"
                  onClick={() => {
                    setLoadCount((prev) => prev + 30);
                  }}
                >
                  {t("git.loadMore")}
                </button>
              )}
            </div>
          )}
          {hover && (
            <CommitHoverCard
              hover={hover}
              state={detailStates[hover.commit.hash]}
              onMouseEnter={handleCardMouseEnter}
              onMouseLeave={handleCardMouseLeave}
            />
          )}
          {/* 提交右键菜单 */}
          {contextMenu && (
            <div className="context-backdrop" onClick={closeContextMenu}>
              <div
                className="context-menu"
                style={{ left: contextMenu.x, top: contextMenu.y }}
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  disabled={contextMenuLoading !== null}
                  onClick={() =>
                    runGitAction(
                      "cherryPick",
                      () =>
                        props.cherryPick?.(
                          props.projectId,
                          contextMenu.commit.hash,
                        ),
                      "git.cherryPickSuccess",
                    )
                  }
                >
                  {contextMenuLoading === "cherryPick" ? (
                    <Loader2 size={14} className="git-spin" />
                  ) : (
                    <GitBranch size={14} />
                  )}
                  {t("git.cherryPick")}
                </button>
                <button
                  disabled={contextMenuLoading !== null}
                  onClick={() =>
                    runGitAction(
                      "revert",
                      () =>
                        props.revert?.(
                          props.projectId,
                          contextMenu.commit.hash,
                        ),
                      "git.revertSuccess",
                    )
                  }
                >
                  {contextMenuLoading === "revert" ? (
                    <Loader2 size={14} className="git-spin" />
                  ) : (
                    <RotateCcw size={14} />
                  )}
                  {t("git.revert")}
                </button>
                <hr className="context-separator" />
                <button
                  disabled={contextMenuLoading !== null}
                  onClick={() =>
                    runGitAction(
                      "resetSoft",
                      () =>
                        props.reset?.(
                          props.projectId,
                          contextMenu.commit.hash,
                          "soft",
                        ),
                      "git.contextMenuSuccess",
                    )
                  }
                >
                  {contextMenuLoading === "resetSoft" ? (
                    <Loader2 size={14} className="git-spin" />
                  ) : null}
                  {t("git.resetSoft")}
                </button>
                <button
                  disabled={contextMenuLoading !== null}
                  onClick={() =>
                    runGitAction(
                      "resetMixed",
                      () =>
                        props.reset?.(
                          props.projectId,
                          contextMenu.commit.hash,
                          "mixed",
                        ),
                      "git.contextMenuSuccess",
                    )
                  }
                >
                  {contextMenuLoading === "resetMixed" ? (
                    <Loader2 size={14} className="git-spin" />
                  ) : null}
                  {t("git.resetMixed")}
                </button>
                <button
                  disabled={contextMenuLoading !== null}
                  onClick={() => {
                    closeContextMenu();
                    setConfirmAction({
                      title: t("git.resetHardConfirmTitle"),
                      message: t("git.resetHardConfirmMessage", {
                        hash: contextMenu.commit.hash.substring(0, 7),
                      }),
                      onConfirm: () =>
                        runGitAction(
                          "resetHard",
                          () =>
                            props.reset?.(
                              props.projectId,
                              contextMenu.commit.hash,
                              "hard",
                            ),
                          "git.contextMenuSuccess",
                        ),
                    });
                  }}
                >
                  {t("git.resetHard")}
                </button>
                <hr className="context-separator" />
                <button
                  className="danger"
                  disabled={contextMenuLoading !== null}
                  onClick={() => {
                    closeContextMenu();
                    setConfirmAction({
                      title: t("git.dropCommitConfirmTitle"),
                      message: t("git.dropCommitConfirmMessage", {
                        hash: contextMenu.commit.hash.substring(0, 7),
                      }),
                      onConfirm: () =>
                        runGitAction(
                          "drop",
                          () =>
                            props.dropCommit?.(
                              props.projectId,
                              contextMenu.commit.hash,
                            ),
                          "git.contextMenuSuccess",
                        ),
                    });
                  }}
                >
                  {contextMenuLoading === "drop" ? (
                    <Loader2 size={14} className="git-spin" />
                  ) : null}
                  {t("git.dropCommit")}
                </button>
              </div>
            </div>
          )}
          {/* 确认弹框 */}
          {confirmAction && (
            <ConfirmDialog
              title={confirmAction.title}
              message={confirmAction.message}
              confirmLabel={t("common.confirm")}
              onConfirm={() => {
                confirmAction.onConfirm();
                setConfirmAction(null);
              }}
              onCancel={() => setConfirmAction(null)}
            />
          )}
        </div>
      )}
    </section>
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
      className={`git-pane git-pane-compare${props.open ? " open" : " collapsed"}`}
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
        <div className="git-pane-body git-compare-body">
          <div className="git-compare-controls">
            <label>
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
            </label>
            <span className="git-compare-arrow" aria-hidden="true">
              →
            </span>
            <label>
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
            </label>
            <button
              type="button"
              className="git-compare-btn"
              disabled={!base || !target || base === target || loading}
              onClick={() => void run()}
            >
              {loading ? (
                <Loader2 size={14} className="git-spin" />
              ) : (
                t("git.compare")
              )}
            </button>
          </div>
          {error && <div className="git-status-msg error">{error}</div>}
          {result && (
            <>
              <div className="git-compare-summary">
                {t("git.compareSummary", {
                  ahead: result.ahead,
                  behind: result.behind,
                  count: result.files.length,
                })}
              </div>
              <div className="git-compare-files">
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
            <div className="git-status-msg">{t("git.compareHint")}</div>
          )}
        </div>
      )}
    </section>
  );
}
