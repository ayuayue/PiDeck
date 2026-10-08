import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { Bot, ChevronDown, ChevronRight, ChevronsDownUp, ChevronsUpDown, GitFork, ListTree, RefreshCw, Sparkles, User } from "lucide-react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import type { SessionBranchTree } from "../../../../../shared/types";
import { currentSessionIdAtom } from "../../../atoms/session-atoms";
import { sessionRecordByIdAtomFamily } from "../../../atoms/session-selectors";
import { desktopApi } from "../../../desktopApi";
import { t } from "../../../i18n";
import { buildBranchRows, childRowId, collectAllIds, collectRunIds, defaultCollapsedIds, indentUnits, MAX_INDENT_DEPTH, moveRowFocus, prepareTree, rowHasDisclosure } from "./branchTreeView";
import type { BranchRow } from "./branchTreeView";

/**
 * 右侧抽屉「分支」面板：会话条目树（pi /tree 的桌面只读版）。
 *
 * 数据走主进程文件索引（不走 get_tree RPC——整树单行 JSON 会冻窗），见
 * SessionHistoryReader.readBranchTree。user 行可一键 fork（复用时间线显式 fork 链路）。
 *
 * 视图策略（缩进只在分支点增长、步骤折叠、非活动子树收起）在 ./branchTreeView.ts，
 * 这里只负责取数与渲染，保持可单测与时序可读。
 */

type PanelState = { kind: "loading" } | { kind: "empty" } | { kind: "tree"; tree: SessionBranchTree } | { kind: "error"; message: string };

function nodeRoleIcon(role: string | undefined): ReactNode {
	if (role === "user") return <User size={12} strokeWidth={1.8} aria-hidden="true" />;
	if (role === "assistant") return <Bot size={12} strokeWidth={1.8} aria-hidden="true" />;
	return <Sparkles size={12} strokeWidth={1.8} aria-hidden="true" />;
}

/** 行文案：优先预览文本；没有预览的结构节点给本地化名字，兜底显示原始类型。 */
function rowLabel(row: BranchRow): string {
	const node = row.steps > 0 ? row.tail : row.node;
	if (node.preview) return node.preview;
	if (node.entryType === "compaction") return t("session.branchTree.compactionNode");
	if (node.entryType === "branch_summary") return t("session.branchTree.branchSummaryNode");
	return node.entryType;
}

/** 轻量空态（图标 + 文案），与 RewindPanel 的引导空态同风格但零依赖。 */
function BranchTreeEmpty(props: { text: string }) {
	return (
		<div className="flex flex-col items-center gap-2 px-4 py-8 text-center">
			<ListTree size={18} strokeWidth={1.6} className="text-text-tertiary" aria-hidden="true" />
			<p className="text-xs leading-5 text-text-secondary">{props.text}</p>
		</div>
	);
}

export function SessionBranchTreePanel(props: { forkAtEntry: (entryId: string, fallbackText: string) => void }) {
	const { forkAtEntry } = props;
	const sessionId = useAtomValue(currentSessionIdAtom);
	const sessionRecord = useAtomValue(sessionRecordByIdAtomFamily(sessionId ?? ""));
	const backend = sessionRecord?.backend;
	const unsupported = backend !== undefined && backend !== "pi";
	const [state, setState] = useState<PanelState>({ kind: "loading" });
	const [refreshKey, setRefreshKey] = useState(0);
	const [busy, setBusy] = useState(false);
	const [collapsedIds, setCollapsedIds] = useState<Set<string>>(new Set());
	const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
	// 键盘导航用色子式焦点（roving tabindex）：整棵树只占一个 Tab 位，行间用 ↑/↓ 走
	const [focusedRowId, setFocusedRowId] = useState<string | null>(null);
	const rowRefs = useRef(new Map<string, HTMLDivElement>());
	// 卸载后丢弃迟到结果；会话切换/手动刷新后旧请求也不覆盖新状态。
	const aliveRef = useRef(true);
	const fetchSeqRef = useRef(0);
	useEffect(() => {
		aliveRef.current = true;
		return () => {
			aliveRef.current = false;
		};
	}, []);

	useEffect(() => {
		if (!sessionId || unsupported) {
			setState({ kind: "empty" });
			return;
		}
		const seq = ++fetchSeqRef.current;
		setState({ kind: "loading" });
		desktopApi.sessions
			.getBranchTree(sessionId)
			.then((tree) => {
				if (!aliveRef.current || seq !== fetchSeqRef.current) return;
				setState(tree && tree.roots.length > 0 ? { kind: "tree", tree } : { kind: "empty" });
			})
			.catch((error: unknown) => {
				if (!aliveRef.current || seq !== fetchSeqRef.current) return;
				setState({ kind: "error", message: error instanceof Error ? error.message : String(error) });
			});
	}, [sessionId, unsupported, refreshKey]);

	const { tree, activeIds, nodeCount } = useMemo(() => {
		if (state.kind !== "tree") return { tree: null as SessionBranchTree | null, activeIds: new Set<string>(), nodeCount: 0 };
		return prepareTree(state.tree);
	}, [state]);

	const rows = useMemo(() => (tree ? buildBranchRows(tree, { collapsedIds, expandedRuns }) : []), [tree, collapsedIds, expandedRuns]);

	// 每次拿到新树重置视图状态：默认展开活动路径，助手/工具步骤折叠成段。
	useEffect(() => {
		if (!tree) {
			setCollapsedIds(new Set());
			setExpandedRuns(new Set());
			return;
		}
		setCollapsedIds(defaultCollapsedIds(tree, activeIds));
		setExpandedRuns(new Set());
	}, [tree, activeIds]);

	// 焦点行失效（收起/刷新/换会话）时落到活动叶行，其次首行：Tab 进入树总有落点。
	useEffect(() => {
		if (rows.length === 0) {
			if (focusedRowId !== null) setFocusedRowId(null);
			return;
		}
		if (focusedRowId && rows.some((row) => row.node.id === focusedRowId)) return;
		setFocusedRowId((rows.find((row) => row.isLeaf) ?? rows[0]).node.id);
	}, [rows, focusedRowId]);

	const toggleNode = useCallback((nodeId: string) => {
		setCollapsedIds((current) => {
			const next = new Set(current);
			if (next.has(nodeId)) next.delete(nodeId);
			else next.add(nodeId);
			return next;
		});
	}, []);

	/** 展开一步折叠段：整段一次展开，并顺手解开它自己的子树收起状态。 */
	const expandRun = useCallback(
		(nodeId: string) => {
			const target = rows.find((row) => row.node.id === nodeId)?.node;
			const runIds = target ? collectRunIds(target, expandedRuns) : [nodeId];
			setExpandedRuns((current) => {
				const next = new Set(current);
				for (const runId of runIds) next.add(runId);
				return next;
			});
			setCollapsedIds((current) => {
				if (!current.has(nodeId)) return current;
				const next = new Set(current);
				next.delete(nodeId);
				return next;
			});
		},
		[rows, expandedRuns],
	);

	/** 键盘导航：↑/↓/Home/End 走行，→ 展开/进子行，← 收起/回父行（与原生 tree 控件一致）。 */
	const onRowKeyDown = useCallback(
		(event: ReactKeyboardEvent<HTMLDivElement>, row: BranchRow) => {
			const runFolded = row.steps > 0;
			const disclosure = rowHasDisclosure(row);
			if (event.key === "ArrowUp" || event.key === "ArrowDown" || event.key === "Home" || event.key === "End") {
				event.preventDefault();
				const nextId = moveRowFocus(rows, row.node.id, event.key);
				setFocusedRowId(nextId);
				rowRefs.current.get(nextId)?.focus();
				return;
			}
			if (event.key === "ArrowRight") {
				event.preventDefault();
				if (runFolded) {
					expandRun(row.node.id);
					return;
				}
				if (disclosure && row.collapsed) {
					toggleNode(row.tail.id);
					return;
				}
				const child = childRowId(rows, row.node.id);
				if (child) {
					setFocusedRowId(child);
					rowRefs.current.get(child)?.focus();
				}
				return;
			}
			if (event.key === "ArrowLeft") {
				event.preventDefault();
				if (!runFolded && disclosure && !row.collapsed) {
					toggleNode(row.tail.id);
					return;
				}
				const parent = row.parentRowId;
				if (parent) {
					setFocusedRowId(parent);
					rowRefs.current.get(parent)?.focus();
				}
				return;
			}
			if ((event.key === "Enter" || event.key === " ") && disclosure) {
				event.preventDefault();
				if (runFolded) expandRun(row.node.id);
				else toggleNode(row.tail.id);
			}
		},
		[rows, expandRun, toggleNode],
	);

	// 「看全部」= 展开所有步骤段 + 展开所有子树；「看骨架」= 只留锚点行 + 收起废弃分支。
	const expandAll = useCallback(() => {
		setCollapsedIds(new Set());
		if (tree) setExpandedRuns(new Set(collectAllIds(tree)));
	}, [tree]);
	const collapseAll = useCallback(() => {
		if (!tree) return;
		setCollapsedIds(defaultCollapsedIds(tree, activeIds));
		setExpandedRuns(new Set());
	}, [tree, activeIds]);

	const onFork = useCallback(
		async (entryId: string, fallbackText: string) => {
			if (busy) return;
			setBusy(true);
			try {
				await forkAtEntry(entryId, fallbackText);
			} finally {
				setBusy(false);
			}
		},
		[busy, forkAtEntry],
	);

	const renderRow = (row: BranchRow): ReactNode => {
		const { node, tail, steps, depth, isLeaf } = row;
		const runFolded = steps > 0;
		const indent = indentUnits(depth);
		const clamped = depth > MAX_INDENT_DEPTH;
		const labelNode = runFolded ? tail : node;
		const rowClass = row.active ? (isLeaf ? "bg-accent/15 font-medium text-accent-foreground" : "text-foreground") : "text-text-tertiary";
		const expanded = runFolded ? false : !row.collapsed;
		return (
			<div
				key={node.id}
				data-branch-row={node.id}
				role="treeitem"
				aria-level={depth + 1}
				aria-selected={row.active}
				aria-expanded={rowHasDisclosure(row) ? !row.collapsed && !runFolded : undefined}
				tabIndex={focusedRowId === node.id ? 0 : -1}
				ref={(element) => {
					if (element) rowRefs.current.set(node.id, element);
					else rowRefs.current.delete(node.id);
				}}
				onFocus={() => setFocusedRowId(node.id)}
				onKeyDown={(event) => onRowKeyDown(event, row)}
				className={`group relative flex items-center gap-1 rounded-sm py-1 pr-1 text-xs outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset ${rowClass}`}
				style={{ paddingLeft: indent * 12 + 4 }}
			>
				{/* 缩进导引线：只在未封顶的层级画，避免深链把行推出可视区后视觉断裂 */}
				{Array.from({ length: indent }, (_, level) => (
					<span key={level} className="pointer-events-none absolute top-0 bottom-0 w-px bg-border/60" style={{ left: level * 12 + 9 }} aria-hidden="true" />
				))}
				{clamped ? (
					<span className="shrink-0 px-0.5 text-[10px] text-text-tertiary" title={t("session.branchTree.deeperLevels")}>
						⋮
					</span>
				) : null}
				{rowHasDisclosure(row) ? (
					<button
						type="button"
						className="inline-grid size-4 shrink-0 place-items-center rounded text-text-tertiary hover:bg-accent hover:text-accent-foreground"
						onClick={() => (runFolded ? expandRun(node.id) : toggleNode(tail.id))}
						title={!expanded || runFolded ? t("session.branchTree.expand") : t("session.branchTree.collapse")}
						aria-expanded={expanded}
					>
						{!expanded || runFolded ? <ChevronRight size={12} strokeWidth={2} aria-hidden="true" /> : <ChevronDown size={12} strokeWidth={2} aria-hidden="true" />}
					</button>
				) : (
					// 端点行用圆点占位，保证同层图标列对齐
					<span className="inline-grid size-4 shrink-0 place-items-center" aria-hidden="true">
						<span className={`size-1 rounded-full ${row.active ? "bg-primary/60" : "bg-border"}`} />
					</span>
				)}
				<span className={`shrink-0 ${labelNode.role === "user" ? "text-primary" : "text-text-tertiary"}`}>{nodeRoleIcon(labelNode.role)}</span>
				<span className="min-w-0 flex-1 truncate" title={node.timestamp ? `${node.entryType} · ${node.timestamp}` : node.entryType}>
					{rowLabel(row)}
				</span>
				{runFolded ? (
					<button type="button" className="shrink-0 rounded bg-muted px-1 text-[10px] text-text-secondary hover:bg-accent hover:text-accent-foreground" onClick={() => expandRun(node.id)} title={t("session.branchTree.expand")}>
						{t("session.branchTree.hiddenSteps", { count: steps })}
					</button>
				) : null}
				{!runFolded && row.collapsed && tail.children.length > 1 ? <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-text-secondary">{t("session.branchTree.hiddenBranches", { count: tail.children.length })}</span> : null}
				{isLeaf ? <span className="shrink-0 rounded bg-primary/15 px-1 text-[10px] text-primary">{t("session.branchTree.activeLeaf")}</span> : null}
				{node.role === "user" ? (
					<button
						type="button"
						className="shrink-0 rounded p-0.5 text-text-tertiary opacity-0 transition-opacity hover:bg-accent hover:text-accent-foreground focus-visible:opacity-100 group-hover:opacity-100 disabled:opacity-30"
						disabled={busy}
						onClick={() => void onFork(node.id, node.preview)}
						title={t("session.branchTree.forkHere")}
						aria-label={t("session.branchTree.forkHere")}
					>
						<GitFork size={12} strokeWidth={1.8} aria-hidden="true" />
					</button>
				) : null}
			</div>
		);
	};

	if (!sessionId || unsupported) {
		return (
			<div className="flex h-full min-h-0 flex-col">
				<BranchTreeEmpty text={unsupported ? t("session.branchTree.unsupported") : t("session.branchTree.noSession")} />
			</div>
		);
	}

	return (
		<div className="flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center gap-1.5 px-3 pb-1 pt-2 text-xs font-semibold text-foreground">
				<ListTree size={13} strokeWidth={1.8} aria-hidden="true" />
				{t("session.branchTree.title")}
				<span className="ml-auto flex items-center gap-0.5 text-[10px] font-normal text-text-tertiary">
					{state.kind === "tree" ? <span className="mr-1">{t("session.branchTree.nodeCount", { count: nodeCount })}</span> : null}
					<button type="button" className="rounded p-0.5 hover:bg-muted" onClick={expandAll} title={t("session.branchTree.expandAll")} aria-label={t("session.branchTree.expandAll")}>
						<ChevronsUpDown size={12} strokeWidth={1.8} aria-hidden="true" />
					</button>
					<button type="button" className="rounded p-0.5 hover:bg-muted" onClick={collapseAll} title={t("session.branchTree.collapseAll")} aria-label={t("session.branchTree.collapseAll")}>
						<ChevronsDownUp size={12} strokeWidth={1.8} aria-hidden="true" />
					</button>
					<button type="button" className="rounded p-0.5 hover:bg-muted" onClick={() => setRefreshKey((key) => key + 1)} title={t("session.branchTree.refresh")} aria-label={t("session.branchTree.refresh")}>
						<RefreshCw size={12} strokeWidth={1.8} aria-hidden="true" />
					</button>
				</span>
			</div>
			<div className="min-h-0 flex-1 overflow-auto overscroll-contain px-2 pb-2">
				{state.kind === "loading" ? <p className="px-1 py-2 text-xs text-text-secondary">{t("session.branchTree.loading")}</p> : null}
				{state.kind === "empty" ? <BranchTreeEmpty text={t("session.branchTree.empty")} /> : null}
				{state.kind === "error" ? <p className="px-1 py-2 text-xs text-destructive">{t("session.branchTree.loadFailed", { error: state.message })}</p> : null}
				{/* 行宽用 min-w-full 而不是 w-max：w-max 会让长预览把行撑出抽屉宽度（truncate 失效、只能横向滚动），
				    深缩进由 MAX_INDENT_DEPTH 封顶 + ⋮ 提示处理，不需要横向撑开。 */}
				{state.kind === "tree" && tree ? (
					<div className="min-w-full" role="tree" aria-label={t("session.branchTree.title")}>
						{rows.map(renderRow)}
					</div>
				) : null}
			</div>
			<div className="shrink-0 border-t border-border px-3 py-1.5 text-[10px] leading-4 text-text-tertiary">{t("session.branchTree.hint")}</div>
		</div>
	);
}
