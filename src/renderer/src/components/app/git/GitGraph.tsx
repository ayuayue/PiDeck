import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { GitBranch, Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { ConfirmDialog } from "../AppParts";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui-shadcn/dropdown-menu";
import { showNotice } from "../../../utils/notice";
import type { CommitDetail, CommitEntry, GitChangedFile } from "../../../../../shared/types";
import { t, type TranslationKey } from "../../../i18n";
import {
  compareStatusLetter,
  FileIcon,
  fileNameOnly,
  statusTone,
  Twistie,
} from "./GitResourceTree";
import { GitCompactFilter, PaneHeader } from "./GitPanelControls";
import { Button } from "../../ui-shadcn/button";

export type GitGraphProps = {
  projectId: string;
  commitLog: (
    projectId: string,
    options?: { maxEntries?: number; ref?: string; allBranches?: boolean },
  ) => Promise<CommitEntry[]>;
  commitDetail: (projectId: string, ref: string) => Promise<CommitDetail | null>;
  onOpenCommitFileDiff: (
    commit: CommitEntry,
    file: GitChangedFile,
  ) => void | Promise<void>;
  branches: string[];
  currentBranch: string | null;
  open: boolean;
  onToggle: () => void;
  cherryPick?: (projectId: string, hash: string) => Promise<void>;
  revert?: (projectId: string, hash: string) => Promise<void>;
  reset?: (
    projectId: string,
    hash: string,
    mode: "soft" | "mixed" | "hard",
  ) => Promise<void>;
  dropCommit?: (projectId: string, hash: string) => Promise<void>;
};

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
const GRAPH_COLORS = [
  "var(--git-graph-lane-1)",
  "var(--git-graph-lane-2)",
  "var(--git-graph-lane-3)",
  "var(--git-graph-lane-4)",
  "var(--git-graph-lane-5)",
  "var(--git-graph-lane-6)",
];

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
    <span className="block h-7 shrink-0 overflow-hidden" style={{ width }}>
      <svg
        className="block max-w-none [&_path]:[vector-effect:non-scaling-stroke] [&_circle]:[vector-effect:non-scaling-stroke]"
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
      className="block h-[26px] shrink-0 overflow-hidden"
      style={{ width }}
      aria-hidden="true"
    >
      <svg
        className="block max-w-none [&_path]:[vector-effect:non-scaling-stroke] [&_circle]:[vector-effect:non-scaling-stroke]"
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
      className={`git-history-file-row grid min-h-[26px] w-full cursor-pointer appearance-none grid-cols-[auto_minmax(0,1fr)_16px] items-center gap-2 border-0 bg-transparent p-0 pr-2.5 pl-0.5 font-mono text-[13px] leading-[26px] text-left text-inherit focus-visible:shadow-[inset_var(--focus-ring)] focus-visible:outline-none disabled:cursor-progress disabled:opacity-70 hover:bg-[var(--git-panel-hover)] active:bg-[var(--git-panel-selection)] ${statusTone(file.status, true)}`}
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
      <span className="flex min-w-0 items-center overflow-hidden">
        <FileIcon name={name} />
        <span className="min-w-0 flex-[0_1_auto] truncate text-[var(--git-panel-fg)]">{name}</span>
        <span className="min-w-0 flex-1 truncate pl-[7px] text-right text-xs text-[var(--git-desc-fg)]">{description}</span>
      </span>
      <span className="ml-[5px] flex w-4 shrink-0 justify-end font-mono text-xs font-semibold text-right text-[var(--git-desc-fg)]" aria-hidden="true">
        {opening ? (
          <Loader2 size={13} className="animate-spin" />
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
      className="pointer-events-none absolute z-[1800] box-border max-h-[min(420px,calc(100vh-16px))] overflow-auto rounded-md border border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] p-3 text-[var(--git-panel-fg)] shadow-[var(--shadow-popover)] [--git-panel-bg:var(--color-bg-panel)] [--git-panel-fg:var(--color-text-primary)] [--git-panel-border:var(--color-border-subtle)] [--git-desc-fg:var(--color-text-tertiary)] [--git-added:var(--color-accent)] [--git-deleted:var(--color-danger)]"
      role="tooltip"
      style={{ left, top, width }}
      onMouseEnter={props.onMouseEnter}
      onMouseLeave={props.onMouseLeave}
    >
      <div className="flex min-w-0 items-start gap-2">
        <span className="inline-flex size-6 shrink-0 items-center justify-center rounded-sm bg-bg-muted font-mono text-xs font-semibold text-[var(--git-panel-fg)]" aria-hidden="true">
          {initial}
        </span>
        <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-[5px]">
          <strong className="truncate">{commit.authorName}</strong>
          {commit.authorEmail && <span className="truncate text-[var(--git-desc-fg)]">{`<${commit.authorEmail}>`}</span>}
          <small className="w-full text-xs text-[var(--git-desc-fg)]">
            {relativeTime(commit.authorDate)} ·{" "}
            {absoluteTime(commit.authorDate)}
          </small>
        </span>
      </div>
      <div className="my-2.5 border-y border-[var(--git-panel-border)] py-[9px] break-words whitespace-pre-wrap">
        {commit.fullMessage || commit.message}
      </div>
      <div className="mt-2">
        <code className="block truncate font-mono text-xs text-[var(--git-desc-fg)]">{commit.hash}</code>
        {refs.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {refs.map((item) => (
              <span key={item} className="max-w-full truncate rounded-sm border border-[var(--git-panel-border)] px-1.5 py-px text-xs text-[var(--git-desc-fg)]">{item}</span>
            ))}
          </div>
        )}
      </div>
      {props.state?.loading && (
        <div className="mt-[9px] flex items-center gap-[7px] border-t border-[var(--git-panel-border)] pt-2 text-[var(--git-desc-fg)]">
          <Loader2 size={13} className="animate-spin" />{" "}
          {t("git.loadingCommitDetails")}
        </div>
      )}
      {props.state?.error && (
        <div className="mt-[9px] flex items-center gap-[7px] border-t border-[var(--git-panel-border)] pt-2 text-[var(--color-danger)]">{props.state.error}</div>
      )}
      {shortStat && (
        <div className="mt-[9px] flex items-center gap-[7px] border-t border-[var(--git-panel-border)] pt-2 text-[var(--git-desc-fg)]">
          <span>{t("git.filesChanged", { count: shortStat.files })}</span>
          <span className="ml-auto text-[var(--git-added)]">+{shortStat.insertions}</span>
          <span className="text-[var(--git-deleted)]">-{shortStat.deletions}</span>
        </div>
      )}
    </div>,
    document.body,
  );
}

export function SourceControlGraph(props: GitGraphProps) {
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
      className={`flex flex-none flex-col border-b border-[var(--git-panel-border)] bg-[var(--git-panel-bg)] last:border-b-0${props.open ? "" : " h-[26px]"}`}
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
        <Button
          type="button"
          variant="ghost" size="icon-sm" className="size-7"
          title={t("common.refresh")}
          aria-label={t("common.refresh")}
          onClick={() => void load()}
        >
          <RefreshCw size={14} />
        </Button>
      </PaneHeader>
      {props.open && (
        <div className="flex flex-col overflow-x-hidden">
          {loading && !commits.length && (
            <div className="git-status-msg flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-desc-fg)]">
              <Loader2 size={14} className="animate-spin" />{" "}
              {t("git.loadingCommits")}
            </div>
          )}
          {error && <div className="git-status-msg error flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-conflict)]">{error}</div>}
          {!loading && !error && !commits.length && (
            <div className="git-status-msg flex min-h-[22px] shrink-0 items-center gap-1 px-[9px] text-[13px] text-[var(--git-desc-fg)]">{t("git.noCommits")}</div>
          )}
          {commits.length > 0 && (
            <div
              className="flex flex-col"
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
                    className=""
                    role="listitem"
                  >
                    <button
                      type="button"
                      className={`git-history-row grid h-7 w-full cursor-pointer appearance-none grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 border-0 bg-transparent p-0 pr-2.5 pl-0.5 font-mono text-sm leading-7 text-left text-inherit focus-visible:shadow-[inset_var(--focus-ring)] focus-visible:outline-none${isCurrent ? " current" : ""}${expanded ? " expanded" : ""}`}
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
                      <span className="flex min-w-0 items-baseline gap-2.5 overflow-hidden">
                        <span className="flex min-w-0 flex-[1_1_auto] items-center overflow-hidden whitespace-nowrap text-[var(--git-panel-fg)]">
                          <Twistie open={expanded} />
                          {commit.message}
                        </span>
                        <span className="min-w-[48px] flex-[0_1_78px] truncate font-mono text-xs text-[var(--git-desc-fg)]">
                          {commit.authorName}
                        </span>
                      </span>
                      {ref && (
                        <span className={`max-w-[108px] truncate rounded-full border border-current px-[7px] font-mono text-xs font-medium leading-[18px]${ref.kind === "branch" ? " text-[var(--git-modified)]" : " text-[var(--git-conflict)]"}`}>
                          {ref.label}
                        </span>
                      )}
                    </button>
                    {expanded && (
                      <div className="min-w-0">
                        {detailState?.loading && (
                          <div className="grid min-h-[26px] grid-cols-[auto_minmax(0,1fr)_16px] items-center gap-2 px-2.5 pl-0.5 font-mono text-[13px] leading-[26px] text-[var(--git-desc-fg)]">
                            <GraphContinuation row={row} />
                            <span className="flex min-w-0 items-center gap-[5px] truncate">
                              <Loader2 size={13} className="animate-spin" />{" "}
                              {t("git.loadingCommitFiles")}
                            </span>
                          </div>
                        )}
                        {detailState?.error && !detailState.loading && (
                          <div className="grid min-h-[26px] grid-cols-[auto_minmax(0,1fr)_16px] items-center gap-2 px-2.5 pl-0.5 font-mono text-[13px] leading-[26px] text-[var(--git-desc-fg)] text-[var(--color-danger)]">
                            <GraphContinuation row={row} />
                            <span className="flex min-w-0 items-center gap-[5px] truncate">{detailState.error}</span>
                          </div>
                        )}
                        {detailState?.detail && commitFiles.length === 0 && (
                          <div className="grid min-h-[26px] grid-cols-[auto_minmax(0,1fr)_16px] items-center gap-2 px-2.5 pl-0.5 font-mono text-[13px] leading-[26px] text-[var(--git-desc-fg)]">
                            <GraphContinuation row={row} />
                            <span className="flex min-w-0 items-center gap-[5px] truncate">{t("git.noCommitFiles")}</span>
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
                <Button
                  type="button"
                  variant="ghost" size="sm" className="w-full border border-dashed border-border-subtle py-2 text-xs text-text-secondary transition-colors duration-150 hover:bg-bg-hover hover:text-text-primary"
                  onClick={() => {
                    setLoadCount((prev) => prev + 30);
                  }}
                >
                  {t("git.loadMore")}
                </Button>
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
          {/* 提交右键菜单（#115 U5：Radix DropdownMenu，虚拟坐标 Trigger 定位） */}
          {contextMenu && (
            <DropdownMenu open onOpenChange={(open) => { if (!open) closeContextMenu(); }}>
              <DropdownMenuTrigger aria-hidden tabIndex={-1} style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, width: 0, height: 0, padding: 0, border: 0, background: "transparent", pointerEvents: "none" }} />
              <DropdownMenuContent align="start" side="bottom">
                <DropdownMenuItem
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
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <GitBranch size={14} />
                  )}
                  {t("git.cherryPick")}
                </DropdownMenuItem>
                <DropdownMenuItem
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
                    <Loader2 size={14} className="animate-spin" />
                  ) : (
                    <RotateCcw size={14} />
                  )}
                  {t("git.revert")}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
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
                    <Loader2 size={14} className="animate-spin" />
                  ) : null}
                  {t("git.resetSoft")}
                </DropdownMenuItem>
                <DropdownMenuItem
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
                    <Loader2 size={14} className="animate-spin" />
                  ) : null}
                  {t("git.resetMixed")}
                </DropdownMenuItem>
                <DropdownMenuItem
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
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
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
                    <Loader2 size={14} className="animate-spin" />
                  ) : null}
                  {t("git.dropCommit")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
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
