import { useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { Inbox, List } from "lucide-react";
import type { GtdBucket, GtdLedger } from "../../../../shared/types/gtd";
import { GTD_COLLAPSED_BUCKETS } from "../../../../shared/types/gtd";
import { sessionRuntimeUiByIdAtom, sessionRecordToSummary } from "../../atoms";
import { useSessionActivityAt } from "../../hooks/sidebar/useSessionActivityClock";
import { t } from "../../i18n";
import { cn } from "../../lib/utils";
import { desktopApi } from "../../desktopApi";
import { showNotice } from "../../utils/notice";
import { formatRelativeTime } from "../../utils/relativeTime";
import { hasPendingAskForSession } from "../../utils/askUi";
import type { SidebarActions } from "./SidebarContent";
import type { SidebarController } from "../../hooks/useSidebarController";
import type { ActiveSessionRow } from "./activitySessionsModel";
import { GTD_ROW_DRAG_MIME, bucketGtdRows, gtdDropIntent, shouldHandleGtdUndoKey, undoSettleTarget } from "./gtdInboxModel";
import { SidebarStatusDot } from "./SidebarStatusDot";
import { Button } from "../ui-shadcn/button";
import { SESSION_ROW_CLASS } from "./sidebarRowStyles";

/** 桶标题：needs-you 用强调色，其余用三级文字（克制，不堆彩色标签墙）。 */
const BUCKET_LABEL_KEY = {
	"needs-you": "gtd.bucketNeedsYou",
	pinned: "gtd.bucketPinned",
	active: "gtd.bucketActive",
	working: "gtd.bucketWorking",
	snoozed: "gtd.bucketSnoozed",
	settled: "gtd.bucketSettled",
} as const satisfies Record<GtdBucket, string>;

/**
 * GTD 分诊视图（#546 阶段 2）：把活动页的行按「是否需要人介入」分组。
 *
 * 只覆盖活动页已有的行（runtime 绑定的会话），不把磁盘历史灌进来；桶由
 * `shared/gtdProjection` 实时投影，账本只存结清/已读水位（`gtd:state-*` IPC）。
 * 传统视图完全不经过这里，切换只影响侧栏怎么排。
 */
export function GtdInboxView(props: { controller: SidebarController; actions: SidebarActions; currentSessionId?: string; rows: readonly ActiveSessionRow[]; onExit: () => void }) {
	const runtimeUiById = useAtomValue(sessionRuntimeUiByIdAtom);
	const activityAt = useSessionActivityAt();
	const [ledger, setLedger] = useState<GtdLedger>({});
	const [collapsed, setCollapsed] = useState<ReadonlySet<GtdBucket>>(() => new Set(GTD_COLLAPSED_BUCKETS));
	/** 刚结清的会话：5 秒内 Ctrl/Cmd+Z 可撤销（阶段 3）。 */
	const [pendingSettle, setPendingSettle] = useState<{ sessionId: string; at: number } | null>(null);
	useEffect(() => {
		void desktopApi.sessions
			.gtdState()
			.then(setLedger)
			.catch(() => undefined);
	}, []);

	const groups = useMemo(
		() =>
			bucketGtdRows({
				rows: props.rows,
				describe: (row) => {
					const sessionId = row.record?.id;
					return {
						sessionId,
						status: row.agent.status,
						pendingInteraction: hasPendingAskForSession(sessionId, runtimeUiById),
						lastActivityAt: activityAt(sessionId, row.sortAt),
					};
				},
				ledger,
				pinned: props.controller.pinnedSessionIds,
				now: Date.now(),
			}),
		[props.rows, props.controller.pinnedSessionIds, runtimeUiById, activityAt, ledger],
	);

	/** 写一个水位并回写本地账本；失败提示但不回滚（下一次刷新会与服务端对齐）。 */
	const patch = async (sessionId: string, next: Parameters<typeof desktopApi.sessions.gtdPatch>[1]) => {
		try {
			setLedger(await desktopApi.sessions.gtdPatch(sessionId, next));
		} catch (error) {
			showNotice(error instanceof Error ? error.message : String(error), 4000, "error");
		}
	};

	const open = (row: ActiveSessionRow) => {
		const sessionId = row.record?.id;
		if (!sessionId) return;
		// 点击即「看过」：消未读，但不改动结清水位（结清由用户显式点 ✓）。
		void patch(sessionId, { viewedAt: Date.now() });
		void props.actions.sessions.open(row.projectId, sessionId, props.actions.sessions.simpleNavigation ? undefined : "preview");
	};

	const settle = (sessionId: string) => {
		const now = Date.now();
		void patch(sessionId, { settledAt: now });
		setPendingSettle({ sessionId, at: now });
		showNotice(t("gtd.settled"), 5000, "info", undefined, {
			action: {
				label: t("gtd.undo"),
				onClick: () => void patch(sessionId, { settledAt: null }),
			},
		});
	};

	// 结清后 5 秒内 Ctrl/Cmd+Z 撤销：只在分诊视图挂着时生效；输入框/可编辑区里的撤销不抢。
	useEffect(() => {
		if (!pendingSettle) return;
		const onKeyDown = (event: KeyboardEvent) => {
			const target = event.target as HTMLElement | null;
			if (!shouldHandleGtdUndoKey({ key: event.key, ctrlKey: event.ctrlKey, metaKey: event.metaKey, targetTagName: target?.tagName, targetEditable: target?.isContentEditable === true })) return;
			const sessionId = undoSettleTarget(pendingSettle, Date.now());
			if (!sessionId) return;
			event.preventDefault();
			setPendingSettle(null);
			void patch(sessionId, { settledAt: null });
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [pendingSettle]);

	return (
		<div className="gtd-inbox-pane flex h-full min-h-0 flex-col">
			<div className="flex shrink-0 items-center gap-1 px-2 pt-1">
				<span className="text-caption font-medium text-text-secondary">{t("gtd.title")}</span>
				<Button variant="ghost" size="icon-xs" className="ml-auto" title={t("gtd.switchToList")} aria-label={t("gtd.switchToList")} onClick={props.onExit}>
					<List size={14} aria-hidden="true" />
				</Button>
			</div>
			<div className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto [scrollbar-gutter:stable]">
				{groups.length === 0 ? <div className="px-2 py-1.5 text-caption text-muted-foreground">{t("gtd.empty")}</div> : null}
				{groups.map((group) => {
					const folded = collapsed.has(group.bucket);
					// 拖拽改桶（阶段 3）：只有用户可决定的桶能接住拖拽；运行态决定的桶返回 null。
					const dropIntent = gtdDropIntent(group.bucket, Date.now());
					return (
						<section key={group.bucket} className="gtd-bucket mt-2 first:mt-1">
							<button
								type="button"
								className={cn("flex w-full items-center gap-1.5 px-2 py-1 text-caption", group.bucket === "needs-you" ? "font-medium text-[var(--color-accent)]" : "text-text-tertiary")}
								onDragOver={(event) => {
									if (!dropIntent) return;
									event.preventDefault();
									event.dataTransfer.dropEffect = "move";
								}}
								onDrop={(event) => {
									if (!dropIntent) return;
									const sessionId = event.dataTransfer.getData(GTD_ROW_DRAG_MIME);
									if (!sessionId) return;
									event.preventDefault();
									void patch(sessionId, dropIntent);
								}}
								onClick={() =>
									setCollapsed((current) => {
										const next = new Set(current);
										if (next.has(group.bucket)) next.delete(group.bucket);
										else next.add(group.bucket);
										return next;
									})
								}
							>
								{group.bucket === "needs-you" && <Inbox size={12} aria-hidden="true" />}
								<span>{t(BUCKET_LABEL_KEY[group.bucket])}</span>
								<span className="tabular-nums">{group.rows.length}</span>
							</button>
							{!folded &&
								group.rows.map(({ row, unread }) => {
									const sessionId = row.record?.id;
									const summary = row.record ? sessionRecordToSummary(row.record) : undefined;
									const title = summary?.name || row.agent.title || t("common.untitled");
									const selected = sessionId === props.currentSessionId;
									return (
										<div key={row.agent.id} className="group/row relative flex min-h-8 items-center">
											<button
												type="button"
												className={cn(SESSION_ROW_CLASS, "pr-7", selected && "bg-bg-active text-foreground")}
												onClick={() => open(row)}
												title={title}
												draggable={Boolean(sessionId)}
												onDragStart={(event) => {
													if (!sessionId) return;
													// 专用 MIME：不带 text/plain，避免拖到聊天区边缘被当成分屏拆分。
													event.dataTransfer.effectAllowed = "move";
													event.dataTransfer.setData(GTD_ROW_DRAG_MIME, sessionId);
												}}
											>
												<SidebarStatusDot status={row.agent.status} />
												<span className="conversation-body min-w-0 flex-1 truncate">{title}</span>
												{unread && <span className="size-1.5 shrink-0 rounded-full bg-[var(--color-accent)]" aria-label={t("gtd.unread")} />}
												<span className="shrink-0 text-micro tabular-nums text-muted-foreground">{formatRelativeTime(activityAt(sessionId, row.sortAt))}</span>
											</button>
											{sessionId && group.bucket !== "settled" && (
												<Button variant="ghost" size="icon-xs" className="absolute right-1 opacity-0 group-hover/row:opacity-100" title={t("gtd.settle")} aria-label={t("gtd.settle")} onClick={() => settle(sessionId)}>
													✓
												</Button>
											)}
										</div>
									);
								})}
						</section>
					);
				})}
			</div>
		</div>
	);
}
