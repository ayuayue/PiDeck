import { useCallback, useEffect, useMemo, useState } from "react";
import { FileDiff, RefreshCw, Undo2 } from "lucide-react";
import { useAtomValue } from "jotai";
import { t, type TranslationKey } from "../../i18n";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms/session-selectors";
import { desktopApi } from "../../desktopApi";
import {
	requireSessionCommand,
	sessionCommandFailureToast,
	toSessionRuntimeTarget,
} from "../../utils/sessionCommands";
import { formatRelativeTime, formatAbsoluteTime } from "../../utils/relativeTime";
import { parseDiffStatSummary, type DiffStatSummary } from "../../utils/rewindDiffStat";
import { showNotice } from "../../utils/notice";
import { ConfirmDialog } from "../ui-shadcn/ConfirmDialog";
import { Badge } from "../ui-shadcn/badge";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui-shadcn/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import type {
	RewindCheckpointSummary,
	RewindCheckpointTrigger,
	RewindRestoreScope,
} from "../../../../shared/types";

/** trigger → i18n key（before-restore 含连字符，key 用 camelCase）。 */
const TRIGGER_LABEL_KEY: Record<RewindCheckpointTrigger, TranslationKey> = {
	turn: "rewind.trigger.turn",
	tool: "rewind.trigger.tool",
	resume: "rewind.trigger.resume",
	"before-restore": "rewind.trigger.beforeRestore",
};

/** 每页条数：列表按时间倒序一页一页加载，避免一次铺开全部快照。 */
const PAGE_SIZE = 10;

/**
 * 检查点列表（弹层与右侧抽屉面板共用）：拉取当前会话在 refs/pi-checkpoints 下的
 * 快照列表，支持查看相对当前工作区的 diff、按范围（files/conversation/all）回退。
 *
 * 挂载即拉取（弹层打开/面板打开都是挂载时机），回退成功后自动刷新。
 * 滚动容器由父级控制：弹层套 ScrollArea，抽屉面板走 drawer-content-frame。
 *
 * ⚠️ target 必须稳定引用：toSessionRuntimeTarget 每次调用新建对象，直接依赖它会让
 * reload 每次渲染都是新引用 → useEffect 每渲染触发一次 → 无限发 IPC 拉列表
 * （主进程被 git spawn 洪泛 = 卡死 + 弹层持续抖动）。这里按原始字段 useMemo。
 */
export function RewindCheckpointList(props: { sessionId: string }) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const agentId = runtime?.agentId;
	const runtimeGeneration = runtime?.runtimeGeneration;
	const target = useMemo(
		() =>
			agentId
				? { sessionId: props.sessionId, agentId, runtimeGeneration }
				: undefined,
		[props.sessionId, agentId, runtimeGeneration],
	);
	const [checkpoints, setCheckpoints] = useState<RewindCheckpointSummary[]>([]);
	const [hasMore, setHasMore] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	/** 加载更多进行中：锁定「加载更多」按钮，避免重复点击拉出重复页。 */
	const [loadingMore, setLoadingMore] = useState(false);
	/** checkpointId → diff 文本缓存（存在即视为已加载/已收起开关）。 */
	const [diffs, setDiffs] = useState<Record<string, string>>({});
	const [diffLoadingId, setDiffLoadingId] = useState<string | null>(null);
	/** checkpointId → 变更统计（auto 摘要行）；null = 与当前工作区无差异；缺 key = 未拉取。 */
	const [diffStats, setDiffStats] = useState<Record<string, DiffStatSummary | null>>({});
	/** 待确认回退：检查点 + 回退范围（files/conversation/all，由恢复按钮的下拉菜单选择）。 */
	const [confirmRestore, setConfirmRestore] = useState<
		{ cp: RewindCheckpointSummary; scope: RewindRestoreScope } | null
	>(null);
	const [restoring, setRestoring] = useState(false);

	/** 拉取当前会话检查点列表（首页）；无运行时（未激活/已停止）时给出可读提示。 */
	const reload = useCallback(async () => {
		if (!target) {
			setCheckpoints([]);
			setHasMore(false);
			setLoadError(t("rewind.unavailable"));
			return;
		}
		setLoading(true);
		setLoadError(null);
		try {
			const page = requireSessionCommand(
				await desktopApi.sessions.listRewindCheckpoints(target, { limit: PAGE_SIZE }),
			).value;
			setCheckpoints(page.items);
			setHasMore(page.hasMore);
		} catch (error) {
			setCheckpoints([]);
			setHasMore(false);
			setLoadError(sessionCommandFailureToast(error, (raw) => t("rewind.loadFailed", { error: raw })));
		} finally {
			setLoading(false);
		}
	}, [target]);

	/** 加载更早一页：以当前最后一条的 timestamp 为游标，时间倒序追加。 */
	const loadMore = useCallback(async () => {
		if (!target || loadingMore || checkpoints.length === 0) return;
		const beforeTimestamp = checkpoints[checkpoints.length - 1]?.timestamp;
		if (beforeTimestamp === undefined) return;
		setLoadingMore(true);
		try {
			const page = requireSessionCommand(
				await desktopApi.sessions.listRewindCheckpoints(target, {
					limit: PAGE_SIZE,
					beforeTimestamp,
				}),
			).value;
			setCheckpoints((prev) => [...prev, ...page.items]);
			setHasMore(page.hasMore);
		} catch (error) {
			showNotice(
				sessionCommandFailureToast(error, (raw) => t("rewind.loadFailed", { error: raw })),
				undefined,
				"error",
			);
		} finally {
			setLoadingMore(false);
		}
	}, [target, loadingMore, checkpoints]);

	// 每次挂载（弹层打开/抽屉面板打开）都重新拉取：回退后列表会变化，
	// 且 ref 可能被外部 pi 进程新增。
	useEffect(() => {
		void reload();
	}, [reload]);

	// 可见行（当前已加载的页）自动拉取变更统计，用于每行摘要。
	// 依赖用 checkpoints 引用 + 长度串，diffStats 变化后 idsToFetch 变空直接短路，
	// 不会造成二次拉取/死循环。
	const visibleCheckpointIds = checkpoints.map((cp) => cp.id).join(",");
	useEffect(() => {
		if (!target || loading || !visibleCheckpointIds) return;
		const idsToFetch = visibleCheckpointIds
			.split(",")
			.filter((id) => !(id in diffStats));
		if (idsToFetch.length === 0) return;
		let cancelled = false;
		void (async () => {
			const results = await Promise.all(
				idsToFetch.map(async (id) => {
					try {
						const text = requireSessionCommand(
							await desktopApi.sessions.getRewindCheckpointDiff(target, id),
						).value;
						return { id, stat: parseDiffStatSummary(text) };
					} catch {
						// 单条 diff 失败不阻塞其余行：标记为 null（按无差异显示）
						// 的同时允许下次重试——null 是合法值，这里干脆不写缓存。
						return { id, stat: undefined as DiffStatSummary | null | undefined };
					}
				}),
			);
			if (cancelled) return;
			setDiffStats((prev) => {
				const next = { ...prev };
				for (const r of results) {
					if (r.stat !== undefined) next[r.id] = r.stat;
				}
				return next;
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [target, loading, visibleCheckpointIds, diffStats]);

	const toggleDiff = useCallback(
		async (cp: RewindCheckpointSummary) => {
			const existing = diffs[cp.id];
			if (existing !== undefined) {
				// 已加载 → 收起（删除缓存项，允许再次展开重新拉取）。
				setDiffs((prev) => {
					const next = { ...prev };
					delete next[cp.id];
					return next;
				});
				return;
			}
			if (!target) return;
			setDiffLoadingId(cp.id);
			try {
				const text = requireSessionCommand(
					await desktopApi.sessions.getRewindCheckpointDiff(target, cp.id),
				).value;
				setDiffs((prev) => ({ ...prev, [cp.id]: text }));
			} catch (error) {
				showNotice(
					sessionCommandFailureToast(error, (raw) => t("rewind.diffLoadFailed", { error: raw })),
					undefined,
					"error",
				);
			} finally {
				setDiffLoadingId(null);
			}
		},
		[target, diffs],
	);

	const performRestore = useCallback(async () => {
		// restoring 防抖：确认框恢复中拒绝再次触发（git 回退不可打断）。
		if (!confirmRestore || !target || restoring) return;
		const { cp, scope } = confirmRestore;
		setRestoring(true);
		try {
			const result = requireSessionCommand(
				await desktopApi.sessions.restoreRewindCheckpoint(target, cp.id, scope),
			).value;
			// conversation/all 会 fork 出新会话（原会话保留）：toast 提示新会话 id。
			if (result.forkedSessionId) {
				showNotice(
					scope === "conversation"
						? t("rewind.conversationForked", { id: cp.id, forked: result.forkedSessionId })
						: t("rewind.restoreDoneForked", { id: cp.id, forked: result.forkedSessionId }),
				);
			} else {
				showNotice(t("rewind.restoreDone", { id: cp.id }));
			}
			setConfirmRestore(null);
			// 回退会改动工作区/会话 → 刷新列表，避免展示过期的快照状态。
			await reload();
		} catch (error) {
			showNotice(
				sessionCommandFailureToast(error, (raw) => t("rewind.restoreFailed", { error: raw })),
				undefined,
				"error",
			);
			setConfirmRestore(null);
		} finally {
			setRestoring(false);
		}
	}, [confirmRestore, target, reload, restoring]);

	return (
		<>
			{/* 手动刷新：checkpoint 由主进程在写文件工具事件后异步创建，
			    面板开着期间新打的点不会自动出现；空态/错误态尤其需要刷新重试。
			    加载中显示旋转态，防止重复点击。 */}
			<div className="flex justify-end pb-1">
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							className="grid size-6 place-items-center rounded-md text-text-tertiary transition-colors hover:bg-muted/60 disabled:opacity-50"
							disabled={loading || restoring}
							aria-label={t("common.refresh")}
							onClick={() => void reload()}
						>
							{loading ? (
								<span className="size-3 animate-pideck-spin rounded-full border border-text-tertiary border-t-transparent" aria-hidden="true" />
							) : (
								<RefreshCw size={13} strokeWidth={1.8} aria-hidden="true" />
							)}
						</button>
					</TooltipTrigger>
					<TooltipContent>{t("common.refresh")}</TooltipContent>
				</Tooltip>
			</div>
			{loading && checkpoints.length === 0 ? (
				<p className="px-1 py-2 text-xs text-text-tertiary">{t("common.loading")}</p>
			) : loadError ? (
				<p className="px-1 py-2 text-xs text-destructive">{loadError}</p>
			) : checkpoints.length === 0 ? (
				<div className="px-1 py-2 text-xs leading-5 text-text-secondary">
					<p>{t("rewind.empty")}</p>
					<p className="mt-0.5 text-text-tertiary">{t("rewind.emptyHint")}</p>
				</div>
			) : (
				<>
					{checkpoints.map((cp) => (
						<CheckpointRow
							key={cp.id}
							cp={cp}
							diff={diffs[cp.id]}
							diffStat={diffStats[cp.id]}
							diffLoading={diffLoadingId === cp.id}
							restoring={restoring && confirmRestore?.cp.id === cp.id}
							onToggleDiff={() => void toggleDiff(cp)}
							onRestore={(scope) => setConfirmRestore({ cp, scope })}
						/>
					))}
					{/* 加载更多：按时间倒序逐页追加（hasMore 由后端游标判断）。 */}
					{hasMore && (
						<button
							type="button"
							disabled={loadingMore}
							className="flex w-full items-center justify-center gap-1.5 rounded-md px-2 py-1.5 text-center text-xs text-text-tertiary transition-colors hover:bg-muted/60 hover:text-foreground disabled:cursor-default disabled:opacity-50"
							onClick={() => void loadMore()}
						>
							{loadingMore && (
								<span className="size-3 animate-pideck-spin rounded-full border border-text-tertiary border-t-transparent" aria-hidden="true" />
							)}
							{t("rewind.loadMore")}
						</button>
					)}
				</>
			)}
			{confirmRestore && (
				<ConfirmDialog
					title={t(
						confirmRestore.scope === "files"
							? "rewind.restoreConfirmTitle"
							: confirmRestore.scope === "conversation"
								? "rewind.restoreConfirmConversation"
								: "rewind.restoreConfirmAll",
					)}
					message={t(
						confirmRestore.scope === "files"
							? "rewind.restoreConfirmMessage"
							: confirmRestore.scope === "conversation"
								? "rewind.restoreConfirmMessageConversation"
								: "rewind.restoreConfirmMessageAll",
						{
							id: confirmRestore.cp.id,
							time: formatRelativeTime(confirmRestore.cp.timestamp),
						},
					)}
					confirmLabel={t(
						confirmRestore.scope === "files"
							? "rewind.restoreConfirmRestore"
							: confirmRestore.scope === "conversation"
								? "rewind.restoreConfirmConversation"
								: "rewind.restoreConfirmAll",
					)}
					danger
					onConfirm={() => void performRestore()}
					onCancel={() => setConfirmRestore(null)}
				/>
			)}
		</>
	);
}

function CheckpointRow(props: {
	cp: RewindCheckpointSummary;
	diff?: string;
	/** 变更统计（auto 拉取）；null = 无差异；undefined = 未拉取（不展示摘要行）。 */
	diffStat?: DiffStatSummary | null;
	diffLoading: boolean;
	restoring: boolean;
	onToggleDiff: () => void;
	onRestore: (scope: RewindRestoreScope) => void;
}) {
	const { cp } = props;
	// 描述缺省时按 trigger 回退到可读标签（tool → 工具名，turn → 第 N 轮）。
	const fallbackLabel =
		cp.trigger === "tool" && cp.toolName
			? cp.toolName
			: cp.trigger === "turn"
				? t("rewind.turnLabel", { turn: cp.turnIndex })
				: cp.trigger === "before-restore"
					? t("rewind.triggerBeforeRestoreHint")
					: t(TRIGGER_LABEL_KEY[cp.trigger]);
	const diffVisible = props.diff !== undefined || props.diffLoading;
	const stat = props.diffStat;
	// 展示标题：描述缺省时按 trigger 回退到可读标签（tool → 工具名，turn → 第 N 轮）。
	const titleText = cp.description ?? fallbackLabel;
	// meta 行去重：描述本身就是工具名/轮次时不再重复展示一次。
	const showToolName = cp.trigger === "tool" && !!cp.toolName && cp.toolName !== titleText;
	const turnLabelText = cp.trigger === "turn" ? t("rewind.turnLabel", { turn: cp.turnIndex }) : null;
	const showTurnLabel = turnLabelText !== null && turnLabelText !== titleText;
	return (
		<div className="rounded-lg border border-border bg-card/60 p-2">
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					{/* 标题行：相对时间固定在右侧，不参与 meta 行换行——避免带统计的行时间被挤到独立行导致高度参差。 */}
					<div className="flex items-center gap-2">
						<p className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={cp.description}>
							{titleText}
						</p>
						<span
							className="shrink-0 text-[11px] tabular-nums text-text-tertiary"
							title={formatAbsoluteTime(cp.timestamp)}
						>
							{formatRelativeTime(cp.timestamp)}
						</span>
					</div>
					<div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-text-tertiary">
						<Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
							{t(TRIGGER_LABEL_KEY[cp.trigger])}
						</Badge>
						{showToolName && (
							<span className="truncate" title={cp.toolName}>{cp.toolName}</span>
						)}
						{showTurnLabel && <span>{turnLabelText}</span>}
						{stat === null ? (
							<span>{t("rewind.diffEmpty")}</span>
						) : stat ? (
							// 变更统计拆成三段渲染：文件数走文案，增删行数着色（+绿 −红，与 activity-row/git 面板一致）。
							<span className="flex flex-wrap items-center gap-x-1.5" title={t("rewind.diffVsCurrentHint")}>
								<span className="text-text-secondary">{t("rewind.changedFiles", { files: stat.files })}</span>
								{stat.insertions !== undefined && (
									<span className="font-mono tabular-nums text-emerald-500">+{stat.insertions}</span>
								)}
								{stat.deletions !== undefined && (
									<span className="font-mono tabular-nums text-rose-500">−{stat.deletions}</span>
								)}
							</span>
						) : null}
					</div>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								className="grid size-6 place-items-center rounded-md text-text-tertiary transition-colors hover:bg-muted/60 disabled:opacity-50"
								disabled={props.diffLoading || props.restoring}
								aria-label={t(diffVisible ? "rewind.diffClose" : "rewind.diff")}
								onClick={props.onToggleDiff}
							>
								<FileDiff size={13} strokeWidth={1.8} aria-hidden="true" />
							</button>
						</TooltipTrigger>
						<TooltipContent>{t(diffVisible ? "rewind.diffClose" : "rewind.diff")}</TooltipContent>
					</Tooltip>
					{/* 恢复按钮：下拉选择回退范围（仅文件 / 仅对话 / 全部），选项自带说明文案。 */}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<button
								type="button"
								className="grid size-6 place-items-center rounded-md text-text-tertiary transition-colors hover:bg-muted/60 disabled:cursor-default disabled:opacity-50"
								disabled={props.restoring}
								aria-label={t("rewind.restoreTitle")}
							>
								{props.restoring ? (
									<span className="size-3 animate-pideck-spin rounded-full border border-text-tertiary border-t-transparent" aria-hidden="true" />
								) : (
									<Undo2 size={13} strokeWidth={1.8} aria-hidden="true" />
								)}
							</button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="min-w-44">
							<DropdownMenuItem onSelect={() => props.onRestore("files")}>
								<span className="flex flex-col">
									<span className="text-xs font-medium">{t("rewind.scope.files")}</span>
									<span className="text-[10px] text-text-tertiary">{t("rewind.scopeFilesHint")}</span>
								</span>
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => props.onRestore("conversation")}>
								<span className="flex flex-col">
									<span className="text-xs font-medium">{t("rewind.scope.conversation")}</span>
									<span className="text-[10px] text-text-tertiary">{t("rewind.scopeConversationHint")}</span>
								</span>
							</DropdownMenuItem>
							<DropdownMenuItem onSelect={() => props.onRestore("all")}>
								<span className="flex flex-col">
									<span className="text-xs font-medium">{t("rewind.scope.all")}</span>
									<span className="text-[10px] text-text-tertiary">{t("rewind.scopeAllHint")}</span>
								</span>
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				</div>
			</div>
			{diffVisible && (
				<div className="mt-1.5 max-h-40 overflow-auto rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[10px] leading-4 text-text-secondary">
					{props.diffLoading ? (
						<span>{t("common.loading")}</span>
					) : props.diff ? (
						<pre className="whitespace-pre-wrap">{props.diff}</pre>
					) : (
						<span>{t("rewind.diffEmpty")}</span>
					)}
				</div>
			)}
		</div>
	);
}
