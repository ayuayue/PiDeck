import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Check, Loader2, RefreshCw } from "lucide-react";
import type {
  BranchDiffResult,
  CommitEntry,
  GitFileStatus,
  GitResourceGroups,
} from "../../../../shared/types";
import { GitStatus } from "../../../../shared/types";
import { getFileIconColor, getFileIconSeti } from "../../fileIcons";
import { t } from "../../i18n";

type GitPanelProps = {
  projectId: string;
  commitLog: (projectId: string, options?: { maxEntries?: number; ref?: string; allBranches?: boolean }) => Promise<CommitEntry[]>;
  branchCompare: (projectId: string, base: string, target: string) => Promise<BranchDiffResult>;
  getStatus: (projectId: string) => Promise<GitResourceGroups>;
  stageFiles: (projectId: string, paths: string[]) => Promise<void>;
  unstageFiles: (projectId: string, paths: string[]) => Promise<void>;
  commit: (projectId: string, message: string) => Promise<void>;
  branches: string[];
  currentBranch: string | null;
};

type PaneId = "changes" | "graph" | "compare";
type PaneHeights = Record<PaneId, number>;
type PaneOpenState = Record<PaneId, boolean>;
type PaneState = { heights: PaneHeights; open: PaneOpenState };
type SmartCommitPreference = { enableSmartCommit: boolean; suggestSmartCommit: boolean };

const EMPTY_GROUPS: GitResourceGroups = { merge: [], index: [], workingTree: [], untracked: [] };
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
function fitPaneHeights(state: PaneState, availableHeight: number): PaneHeights {
  const visible = visiblePaneIds(state.open);
  const heights = { ...state.heights };
  if (!visible.length) return heights;

  const bodyBudget = Math.max(
    PANE_MIN_BODY_HEIGHT * visible.length,
    availableHeight - PANE_IDS.length * PANE_HEADER_HEIGHT,
  );
  const requestedTotal = visible.reduce((sum, id) => sum + heights[id], 0);
  if (requestedTotal < bodyBudget) {
    // Keep empty space in the primary Changes pane so lower pane headers remain anchored
    // toward the bottom, like VS Code's ViewPaneContainer.
    heights[visible[0]] += bodyBudget - requestedTotal;
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
    heights[id] = PANE_MIN_BODY_HEIGHT + (requestedAboveMinimum > 0
      ? Math.round(distributable * requested / requestedAboveMinimum)
      : 0);
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

function paneStateStorageKey(projectId: string): string {
  return `pideck:git-panel:${projectId}:pane-state:v2`;
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
    heights: { changes: 300, graph: 320, compare: 240 },
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
      result[id] = typeof height === "number" && Number.isFinite(height)
        ? Math.max(PANE_MIN_BODY_HEIGHT, Math.round(height))
        : fallback.heights[id];
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

function relativeTime(ms: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (seconds < 60) return t("git.relativeSeconds", { count: seconds });
  if (seconds < 3600) return t("git.relativeMinutes", { count: Math.floor(seconds / 60) });
  if (seconds < 86400) return t("git.relativeHours", { count: Math.floor(seconds / 3600) });
  if (seconds < 2592000) return t("git.relativeDays", { count: Math.floor(seconds / 86400) });
  if (seconds < 31536000) return t("git.relativeMonths", { count: Math.floor(seconds / 2592000) });
  return t("git.relativeYears", { count: Math.floor(seconds / 31536000) });
}

function fileNameOnly(path: string): string {
  return path.split(/[/\\]/).pop() ?? path;
}

function statusTone(status: GitStatus | GitFileStatus, isCompareContext = false): string {
  if (isCompareContext) {
    switch (status) {
      case "added": return "status-added";
      case "deleted": return "status-deleted";
      case "renamed": return "status-renamed";
      default: return "status-modified";
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
    case "added": return "A";
    case "deleted": return "D";
    case "renamed": return "R";
    default: return "M";
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
    return <span aria-hidden="true" className="git-file-icon git-file-fallback" />;
  }
}

/** Mirrors VS Code's monaco-tl-twistie without importing structural icons. */
function Twistie({ open }: { open: boolean }) {
  return <span className={`git-twistie${open ? " open" : ""}`} aria-hidden="true" />;
}

function GitStageGlyph({ unstage = false }: { unstage?: boolean }) {
  return <span className="git-stage-glyph" aria-hidden="true">{unstage ? "\u2212" : "+"}</span>;
}

function ResourceRow(props: {
  status: GitStatus;
  letter: string;
  path: string;
  compareStatus?: GitFileStatus;
  action?: { label: string; run: () => void };
}) {
  const name = fileNameOnly(props.path);
  const tone = props.compareStatus ? statusTone(props.compareStatus, true) : statusTone(props.status);
  const letter = props.compareStatus ? compareStatusLetter(props.compareStatus) : props.letter;
  return (
    <div className={`git-resource-row ${tone}`} title={props.path}>
      <FileIcon name={name} />
      <span className="git-resource-name">{name}</span>
      <span className="git-resource-path">{props.path}</span>
      {props.action && (
        <div className="git-resource-actions">
          <button
            type="button"
            className="git-action-btn git-stage-action"
            aria-label={props.action.label}
            onClick={(event) => {
              event.stopPropagation();
              props.action?.run();
            }}
          >
            <GitStageGlyph unstage={props.action.label === t("git.unstage")} />
          </button>
        </div>
      )}
      <span className="git-decoration" aria-hidden="true">{letter}</span>
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
  children: ReactNode;
}) {
  return (
    <div className="git-resource-group">
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
              onClick={() => props.allAction?.()}
            >
              <GitStageGlyph unstage={props.allLabel === t("git.unstageAll")} />
            </button>
          </div>
        )}
        <span className="git-resource-group-count">{props.count}</span>
      </div>
      {props.open && <div className="git-resource-group-body">{props.children}</div>}
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
      {props.children && <div className="git-pane-header-actions">{props.children}</div>}
      {typeof props.count === "number" && props.count > 0 && (
        <span className="git-pane-count">{props.count}</span>
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
      const before = Math.max(
        PANE_MIN_BODY_HEIGHT,
        Math.min(requestedBefore, startBeforeHeight + startAfterHeight - PANE_MIN_BODY_HEIGHT),
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
      Math.min(requestedBefore, props.beforeHeight + props.afterHeight - PANE_MIN_BODY_HEIGHT),
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
  const statusRequestRef = useRef(0);
  const [availableHeight, setAvailableHeight] = useState(720);
  const [groups, setGroups] = useState<GitResourceGroups>(EMPTY_GROUPS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [committing, setCommitting] = useState(false);
  const [smartCommitPreference, setSmartCommitPreference] = useState<SmartCommitPreference>(() => readSmartCommitPreference(props.projectId));
  const [showSmartCommitPrompt, setShowSmartCommitPrompt] = useState(false);
  const [resourceOpen, setResourceOpen] = useState({ merge: true, staged: true, changes: true });
  const [paneState, setPaneState] = useState<PaneState>(() => readPaneState(props.projectId));

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
    const next = readPaneState(props.projectId);
    setPaneState({ ...next, heights: fitPaneHeights(next, availableHeight) });
    setGroups(EMPTY_GROUPS);
    setError(null);
    setSmartCommitPreference(readSmartCommitPreference(props.projectId));
    setShowSmartCommitPrompt(false);
  }, [props.projectId]);

  useEffect(() => {
    setPaneState((current) => ({ ...current, heights: fitPaneHeights(current, availableHeight) }));
  }, [availableHeight]);

  useEffect(() => {
    try {
      localStorage.setItem(paneStateStorageKey(props.projectId), JSON.stringify(paneState));
    } catch {
      // Storage can be blocked in preview/web mode; pane interaction must still work for this session.
    }
  }, [paneState, props.projectId]);

  const refresh = useCallback(async () => {
    const request = ++statusRequestRef.current;
    const projectId = props.projectId;
    setLoading(true);
    setError(null);
    try {
      const next = await props.getStatus(projectId);
      if (request === statusRequestRef.current && projectId === props.projectId) setGroups(next);
    } catch (caught) {
      if (request === statusRequestRef.current && projectId === props.projectId) {
        setGroups(EMPTY_GROUPS);
        setError(errorMessage(caught));
      }
    } finally {
      if (request === statusRequestRef.current && projectId === props.projectId) setLoading(false);
    }
  }, [props.getStatus, props.projectId]);

  useEffect(() => { void refresh(); }, [refresh]);

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
  const resizePanes = (before: PaneId, after: PaneId, beforeHeight: number, afterHeight: number) => {
    setPaneState((current) => resizePair(current, before, after, beforeHeight, afterHeight));
  };

  const workingChanges = useMemo(
    () => [...groups.workingTree, ...groups.untracked],
    [groups.workingTree, groups.untracked],
  );
  const stagedCount = groups.index.length;
  const hasUnresolvedConflicts = groups.merge.length > 0;
  // VS Code enables the action for either staged changes or working-tree changes
  // when smart commit is enabled/suggested; the command decides whether to prompt.
  const hasChangesToCommit = stagedCount > 0 || (workingChanges.length > 0 && (smartCommitPreference.enableSmartCommit || smartCommitPreference.suggestSmartCommit));
  const canCommit = Boolean(commitMessage.trim()) && hasChangesToCommit && !hasUnresolvedConflicts && !committing;
  const total = groups.merge.length + stagedCount + workingChanges.length;

  const act = async (operation: () => Promise<void>) => {
    const projectId = props.projectId;
    try {
      await operation();
      if (projectId === props.projectId) await refresh();
    } catch (caught) {
      // Do not let refresh clear the mutation error before the user can read it.
      if (projectId === props.projectId) setError(errorMessage(caught));
    }
  };

  const runCommit = async (stageAll: boolean) => {
    const message = commitMessage.trim();
    if (!message || committing || hasUnresolvedConflicts) return;
    const projectId = props.projectId;
    setCommitting(true);
    setError(null);
    try {
      if (stageAll) {
        const paths = workingChanges.map((resource) => resource.path);
        if (paths.length > 0) await props.stageFiles(projectId, paths);
      }
      await props.commit(projectId, message);
      if (projectId !== props.projectId) return;
      setCommitMessage("");
      await refresh();
    } catch (caught) {
      if (projectId === props.projectId) setError(errorMessage(caught));
    } finally {
      if (projectId === props.projectId) setCommitting(false);
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

  const visibleSashAfterChanges = adjacentVisiblePane(paneState.open, "changes", 1);
  const visibleSashAfterGraph = adjacentVisiblePane(paneState.open, "graph", 1);
  const paneStyle = (id: PaneId): React.CSSProperties => ({
    "--git-pane-height": `${paneState.heights[id]}px`,
  } as React.CSSProperties);

  const renderSash = (before: PaneId, after: PaneId) => (
    <PaneSash
      before={before}
      after={after}
      beforeHeight={paneState.heights[before]}
      afterHeight={paneState.heights[after]}
      onResize={(beforeHeight, afterHeight) => resizePanes(before, after, beforeHeight, afterHeight)}
    />
  );

  return (
    <div ref={panelRef} className="git-panel" aria-label={t("git.sourceControl")}>
      <section
        id="git-pane-changes"
        className={`git-pane git-pane-changes${paneState.open.changes ? " open" : " collapsed"}`}
        style={paneStyle("changes")}
      >
        <PaneHeader id="changes" title={t("git.changes")} count={total} open={paneState.open.changes} onToggle={() => togglePane("changes")}>
          {loading && <Loader2 size={14} className="git-spin" aria-label={t("common.loading")} />}
          <button type="button" className="git-action-btn" title={t("common.refresh")} aria-label={t("common.refresh")} onClick={() => void refresh()}>
            <RefreshCw size={14} />
          </button>
        </PaneHeader>
        {paneState.open.changes && (
          <div className="git-pane-body git-changes-body">
            <div className="git-scm-input-wrap">
              <textarea
                className="git-scm-input"
                placeholder={t("git.commitPlaceholder", { branch: props.currentBranch ?? "HEAD" })}
                value={commitMessage}
                onChange={(event) => setCommitMessage(event.target.value)}
                onKeyDown={(event) => {
                  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                    event.preventDefault();
                    void doCommit();
                  }
                }}
                rows={2}
              />
              <button
                type="button"
                className="git-commit-btn"
                disabled={!canCommit}
                title={hasUnresolvedConflicts
                  ? t("git.resolveConflictsBeforeCommit")
                  : stagedCount > 0
                    ? t("git.commitStaged", { count: stagedCount })
                    : t("git.commitAll", { count: workingChanges.length })}
                onClick={() => void doCommit()}
              >
                {committing ? <Loader2 size={14} className="git-spin" /> : <Check size={14} />}
                <span>{committing
                  ? t("git.committing")
                  : stagedCount > 0
                    ? t("git.commitStaged", { count: stagedCount })
                    : t("git.commit")}</span>
              </button>
            </div>

            {error && <div className="git-status-msg error">{error}</div>}
            {!loading && total === 0 && !error && <div className="git-status-msg">{t("git.noPendingChanges")}</div>}

            <div className="git-resource-list">
              {groups.merge.length > 0 && (
                <ResourceGroup title={t("git.mergeChanges")} count={groups.merge.length} open={resourceOpen.merge} onToggle={() => toggleResource("merge")}>
                  {groups.merge.map((resource) => <ResourceRow key={resource.path} status={resource.status} letter={resource.letter} path={resource.path} />)}
                </ResourceGroup>
              )}
              {groups.index.length > 0 && (
                <ResourceGroup
                  title={t("git.stagedChanges")}
                  count={groups.index.length}
                  open={resourceOpen.staged}
                  onToggle={() => toggleResource("staged")}
                  allAction={() => act(() => props.unstageFiles(props.projectId, groups.index.map((resource) => resource.path)))}
                  allLabel={t("git.unstageAll")}
                >
                  {groups.index.map((resource) => (
                    <ResourceRow
                      key={resource.path}
                      status={resource.status}
                      letter={resource.letter}
                      path={resource.path}
                      action={{ label: t("git.unstage"), run: () => act(() => props.unstageFiles(props.projectId, [resource.path])) }}
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
                  allAction={() => act(() => props.stageFiles(props.projectId, workingChanges.map((resource) => resource.path)))}
                  allLabel={t("git.stageAll")}
                >
                  {workingChanges.map((resource) => (
                    <ResourceRow
                      key={`${resource.status}-${resource.path}`}
                      status={resource.status}
                      letter={resource.letter}
                      path={resource.path}
                      action={{ label: t("git.stage"), run: () => act(() => props.stageFiles(props.projectId, [resource.path])) }}
                    />
                  ))}
                </ResourceGroup>
              )}
            </div>
          </div>
        )}
      </section>

      {visibleSashAfterChanges && renderSash("changes", visibleSashAfterChanges)}

      <SourceControlGraph
        projectId={props.projectId}
        commitLog={props.commitLog}
        branches={props.branches}
        currentBranch={props.currentBranch}
        open={paneState.open.graph}
        height={paneState.heights.graph}
        onToggle={() => togglePane("graph")}
      />

      {paneState.open.graph && visibleSashAfterGraph && renderSash("graph", visibleSashAfterGraph)}

      <CompareChanges
        projectId={props.projectId}
        branches={props.branches}
        branchCompare={props.branchCompare}
        open={paneState.open.compare}
        height={paneState.heights.compare}
        onToggle={() => togglePane("compare")}
      />

      {showSmartCommitPrompt && createPortal(
        <div className="git-smart-commit-backdrop" role="presentation" onClick={() => setShowSmartCommitPrompt(false)}>
          <div className="git-smart-commit-dialog" role="alertdialog" aria-modal="true" aria-labelledby="git-smart-commit-title" onClick={(event) => event.stopPropagation()}>
            <strong id="git-smart-commit-title">{t("git.smartCommitTitle")}</strong>
            <p>{t("git.smartCommitPrompt")}</p>
            <div className="git-smart-commit-actions">
              <button type="button" onClick={() => setShowSmartCommitPrompt(false)}>{t("common.cancel")}</button>
              <button type="button" onClick={() => chooseSmartCommit("never")}>{t("git.smartCommitNever")}</button>
              <button type="button" onClick={() => chooseSmartCommit("always")}>{t("git.smartCommitAlways")}</button>
              <button type="button" className="primary" autoFocus onClick={() => chooseSmartCommit("yes")}>{t("git.smartCommitYes")}</button>
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

    if (commit.parents.length > 0) {
      for (const node of input) {
        if (node.id === commit.hash) {
          if (!firstParentAdded) {
            output.push({ id: commit.parents[0], color: node.color });
            firstParentAdded = true;
          }
          continue;
        }
        output.push({ ...node });
      }
    }

    for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index++) {
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
  const nodeColor = output[nodeIndex]?.color ?? input[nodeIndex]?.color ?? 0;
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
      } else {
        outputIndex += 1;
      }
      continue;
    }

    if (outputIndex >= output.length || node.id !== output[outputIndex].id) continue;
    if (index === outputIndex) {
      paths.push({ d: `M ${laneX(index)} 0 V ${GRAPH_ROW_HEIGHT}`, color: node.color });
    } else {
      paths.push({
        d: `M ${laneX(index)} 0 V ${GRAPH_ROW_HEIGHT / 2 - GRAPH_CURVE_RADIUS} A ${GRAPH_CURVE_RADIUS} ${GRAPH_CURVE_RADIUS} 0 0 1 ${laneX(index) - GRAPH_CURVE_RADIUS} ${GRAPH_ROW_HEIGHT / 2} H ${laneX(outputIndex) + GRAPH_CURVE_RADIUS} A ${GRAPH_CURVE_RADIUS} ${GRAPH_CURVE_RADIUS} 0 0 0 ${laneX(outputIndex)} ${GRAPH_ROW_HEIGHT / 2 + GRAPH_CURVE_RADIUS} V ${GRAPH_ROW_HEIGHT}`,
        color: node.color,
      });
    }
    outputIndex += 1;
  }

  for (let parentIndex = 1; parentIndex < commit.parents.length; parentIndex += 1) {
    const parentOutputIndex = lastNodeIndex(output, commit.parents[parentIndex]);
    if (parentOutputIndex === -1) continue;
    paths.push({
      d: `M ${GRAPH_LANE_WIDTH * parentOutputIndex} ${GRAPH_ROW_HEIGHT / 2} A ${GRAPH_LANE_WIDTH} ${GRAPH_LANE_WIDTH} 0 0 1 ${laneX(parentOutputIndex)} ${GRAPH_ROW_HEIGHT} M ${GRAPH_LANE_WIDTH * parentOutputIndex} ${GRAPH_ROW_HEIGHT / 2} H ${laneX(nodeIndex)}`,
      color: output[parentOutputIndex].color,
    });
  }

  if (inputIndex !== -1) {
    paths.push({ d: `M ${laneX(nodeIndex)} 0 V ${GRAPH_ROW_HEIGHT / 2}`, color: input[inputIndex].color });
  }
  if (commit.parents.length > 0) {
    paths.push({ d: `M ${laneX(nodeIndex)} ${GRAPH_ROW_HEIGHT / 2} V ${GRAPH_ROW_HEIGHT}`, color: nodeColor });
  }

  const width = GRAPH_LANE_WIDTH * (Math.min(MAX_VISIBLE_GRAPH_LANES, Math.max(input.length, output.length, 1)) + 1);
  return (
    <span className="git-graph-cell" style={{ width }}>
      <svg className="git-graph-svg" width={width} height={GRAPH_ROW_HEIGHT} viewBox={`0 0 ${width} ${GRAPH_ROW_HEIGHT}`} aria-hidden="true">
        {paths.map((path, index) => (
          <path key={`${path.d}-${index}`} d={path.d} fill="none" stroke={GRAPH_COLORS[path.color % GRAPH_COLORS.length]} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        ))}
        {commit.parents.length > 1 && (
          <circle cx={laneX(nodeIndex)} cy={GRAPH_ROW_HEIGHT / 2} r={GRAPH_NODE_RADIUS + 2} fill="var(--git-panel-bg)" stroke={GRAPH_COLORS[nodeColor % GRAPH_COLORS.length]} strokeWidth="1.6" />
        )}
        <circle cx={laneX(nodeIndex)} cy={GRAPH_ROW_HEIGHT / 2} r={current ? GRAPH_NODE_RADIUS + 0.5 : GRAPH_NODE_RADIUS} fill={GRAPH_COLORS[nodeColor % GRAPH_COLORS.length]} stroke="var(--git-panel-bg)" strokeWidth="2" />
        {current && <circle cx={laneX(nodeIndex)} cy={GRAPH_ROW_HEIGHT / 2} r="2" fill="var(--git-panel-bg)" />}
      </svg>
    </span>
  );
}

function primaryRef(refNames: string[]): { label: string; kind: "branch" | "tag" } | null {
  const refs = refNames.flatMap((item) => item.split(",")).map((item) => item.trim()).filter(Boolean);
  const current = refs.find((item) => item.startsWith("HEAD -> "));
  if (current) return { label: current.replace("HEAD -> ", ""), kind: "branch" };
  const tag = refs.find((item) => item.startsWith("tag: "));
  if (tag) return { label: tag.replace("tag: ", ""), kind: "tag" };
  return null;
}

function SourceControlGraph(props: {
  projectId: string;
  commitLog: GitPanelProps["commitLog"];
  branches: string[];
  currentBranch: string | null;
  open: boolean;
  height: number;
  onToggle: () => void;
}) {
  const [commits, setCommits] = useState<CommitEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ref, setRef] = useState("");
  const loadSequence = useRef(0);

  useEffect(() => {
    // A project can reuse the same branch name, so clear graph selections explicitly.
    loadSequence.current += 1;
    setCommits([]);
    setError(null);
    setRef("");
  }, [props.projectId]);

  const load = useCallback(async () => {
    if (!props.open) return;
    const request = ++loadSequence.current;
    const projectId = props.projectId;
    setLoading(true);
    setError(null);
    try {
      const next = await props.commitLog(projectId, { maxEntries: 50, ref: ref || undefined, allBranches: !ref });
      if (request === loadSequence.current && projectId === props.projectId) setCommits(next);
    } catch (caught) {
      if (request === loadSequence.current && projectId === props.projectId) setError(errorMessage(caught));
    } finally {
      if (request === loadSequence.current && projectId === props.projectId) setLoading(false);
    }
  }, [props.commitLog, props.open, props.projectId, ref]);

  useEffect(() => { void load(); }, [load]);
  const graphRows = useMemo(() => buildGraphRows(commits), [commits]);

  return (
    <section
      id="git-pane-graph"
      className={`git-pane git-pane-graph${props.open ? " open" : " collapsed"}`}
      style={{ "--git-pane-height": `${props.height}px` } as React.CSSProperties}
    >
      <PaneHeader id="graph" title={t("git.sourceControlGraph")} count={commits.length} open={props.open} onToggle={props.onToggle}>
        <select className="git-compact-select" value={ref} onChange={(event) => setRef(event.target.value)} aria-label={t("git.filterReference")}>
          <option value="">{t("common.all")}</option>
          {props.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
        </select>
        <button type="button" className="git-action-btn" title={t("common.refresh")} aria-label={t("common.refresh")} onClick={() => void load()}>
          <RefreshCw size={14} />
        </button>
      </PaneHeader>
      {props.open && (
        <div className="git-pane-body git-graph-body">
          {loading && !commits.length && <div className="git-status-msg"><Loader2 size={14} className="git-spin" /> {t("git.loadingCommits")}</div>}
          {error && <div className="git-status-msg error">{error}</div>}
          {!loading && !error && !commits.length && <div className="git-status-msg">{t("git.noCommits")}</div>}
          {commits.length > 0 && (
            <div className="git-history-list">
              {graphRows.map((row) => {
                const commit = row.commit;
                const ref = primaryRef(commit.refNames);
                const isCurrent = commit.refNames.some((item) => item.includes("HEAD ->"));
                return (
                  <div
                    key={commit.hash}
                    className={`git-history-row${isCurrent ? " current" : ""}`}
                    title={`${commit.message}\n${commit.hash}\n${commit.authorName} · ${relativeTime(commit.authorDate)}`}
                  >
                    <GraphLanes row={row} current={isCurrent} />
                    <span className="git-history-label">
                      <span className="git-history-msg">{commit.message}</span>
                      <span className="git-history-author">{commit.authorName}</span>
                    </span>
                    {ref && <span className={`git-ref git-ref-${ref.kind}`}>{ref.label}</span>}
                  </div>
                );
              })}
            </div>
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
      if (request === requestSequence.current && projectId === props.projectId) setResult(next);
    } catch (caught) {
      if (request === requestSequence.current && projectId === props.projectId) {
        setResult(null);
        setError(errorMessage(caught));
      }
    } finally {
      if (request === requestSequence.current && projectId === props.projectId) setLoading(false);
    }
  };

  return (
    <section
      id="git-pane-compare"
      className={`git-pane git-pane-compare${props.open ? " open" : " collapsed"}`}
      style={{ "--git-pane-height": `${props.height}px` } as React.CSSProperties}
    >
      <PaneHeader id="compare" title={t("git.compareChanges")} count={result?.files.length} open={props.open} onToggle={props.onToggle} />
      {props.open && (
        <div className="git-pane-body git-compare-body">
          <div className="git-compare-controls">
            <label>
              <span>{t("git.base")}</span>
              <select className="git-compact-select" value={base} onChange={(event) => setBase(event.target.value)} aria-label={t("git.base")}>
                <option value="">{t("git.selectBase")}</option>
                {props.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
              </select>
            </label>
            <span className="git-compare-arrow" aria-hidden="true">→</span>
            <label>
              <span>{t("git.compare")}</span>
              <select className="git-compact-select" value={target} onChange={(event) => setTarget(event.target.value)} aria-label={t("git.compare")}>
                <option value="">{t("git.selectCompare")}</option>
                {props.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}
              </select>
            </label>
            <button type="button" className="git-compare-btn" disabled={!base || !target || base === target || loading} onClick={() => void run()}>
              {loading ? <Loader2 size={14} className="git-spin" /> : t("git.compare")}
            </button>
          </div>
          {error && <div className="git-status-msg error">{error}</div>}
          {result && (
            <>
              <div className="git-compare-summary">{t("git.compareSummary", { ahead: result.ahead, behind: result.behind, count: result.files.length })}</div>
              <div className="git-compare-files">
                {result.files.map((file) => <ResourceRow key={file.path} status={0 as GitStatus} letter="" path={file.path} compareStatus={file.status} />)}
              </div>
            </>
          )}
          {!result && !error && <div className="git-status-msg">{t("git.compareHint")}</div>}
        </div>
      )}
    </section>
  );
}
