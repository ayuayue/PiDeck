import { CircleArrowDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import type { SessionMessageTimelineProps } from "./SessionMessageTimeline";
import { SessionMessageTimeline } from "./SessionMessageTimeline";
import { showNotice } from "../../utils/notice";
import { outlineItemsBySessionIdAtomFamily, sessionHistoryMutationOverlayBySessionIdAtomFamily } from "../../atoms";
import { isPendingRailItemId, isRailLoadStalled, mergeOutlineRailItems, pendingEntryIdOf, planRailJump, planRailPendingStep, RAIL_PENDING_MAX_ATTEMPTS } from "./timeline/outlineRailTicks";
import { useSessionOutlineDirectory } from "../../hooks/useSessionOutlineDirectory";
import { formatTime, summarizeMessage } from "../app/AppUtils";
import { replaceExpandedRefBlocksWithLabels } from "../../../../shared/expandedRefBlocks";
import { Button } from "../ui-shadcn/button";
import { chatContentWidthStyle } from "./chatContentWidth";
import { getI18nLocale, t, type TranslationKey } from "../../i18n";
import type { AgentRunItem } from "./timeline/types";
import { ConversationOutline } from "./SurfaceComponents";
import { areOutlineRailItemsEqual } from "./timeline/outlineRailActive";

const HISTORY_OVERLAY_COPY: Record<string, TranslationKey> = {
	stopping: "message.historyOverlay.stopping",
	mutating: "message.historyOverlay.mutating",
	reloading: "message.historyOverlay.reloading",
	activating: "message.historyOverlay.activating",
	forking: "message.historyOverlay.forking",
};

/**
 * 中栏表面：只承载对话时间线。轨迹复盘已迁到右侧抽屉独立 tab。
 */
export function SessionSurfaceStage(props: { sessionId: string; sessionTimeline: SessionTimelineController; timelineProps: Omit<SessionMessageTimelineProps, "sessionId" | "controller">; isRestarting: boolean; isReloading?: boolean }) {
	const { sessionId, sessionTimeline, timelineProps, isRestarting, isReloading = false } = props;
	// Assistant streaming rebuilds the derived array; equal user checkpoints should not rerender the rail.
	const outlineItemsAtom = useMemo(() => selectAtom(outlineItemsBySessionIdAtomFamily(sessionId), (items) => items, areOutlineRailItemsEqual), [sessionId]);
	const outlineItems = useAtomValue(outlineItemsAtom);
	// 索引目录补齐「已加载消息之外」的用户检查点；未加载项点击后连续补页再跳转。
	const directory = useSessionOutlineDirectory(sessionId, outlineItems.length);
	// 目录项 → 导轨卡片：标题用索引预览（与已加载标题同一套归一，加载前后是同一句话），
	// 时间与已加载项同一格式化口（此前误塞原始 ISO）。
	// 标题兜底走 t()，而 t() 读模块级 locale 且不订阅变化：locale 必须进依赖，
	// 否则切语言后未加载项的标题会停在旧语言（依赖里那次调用就是判据本身）。
	const directoryRailItems = useMemo(
		() =>
			directory.map((entry) => ({
				entryId: entry.entryId,
				title: entry.preview ? summarizeMessage(replaceExpandedRefBlocksWithLabels(entry.preview)) : t("outline.turnFallback", { index: entry.turnOrdinal + 1 }),
				time: entry.timestamp ? formatTime(Date.parse(entry.timestamp)) : "",
			})),
		[directory, getI18nLocale()],
	);
	const railItems = useMemo(() => mergeOutlineRailItems(outlineItems, directoryRailItems), [outlineItems, directoryRailItems]);
	const [pendingEntryId, setPendingEntryId] = useState<string | undefined>(undefined);
	const [pendingAttempts, setPendingAttempts] = useState(0);
	const pendingRailJump = useCallback(
		(id: string) => {
			if (!isPendingRailItemId(id)) {
				sessionTimeline.jumpToMessage(id);
				return;
			}
			// 占位刻度只说明「目录里有、已加载消息里没有」，不含方向：它可能在更早的历史里，
			// 也可能比已加载区间还新（live 提问的 entryId 与目录还没对上）。只有前者需要
			// 向上补页；后者一路补到会话开头后只会误报「这条提问还在更早的历史里」
			// （2026-11 真机：从第一条点最后一条）。方向判断见 planRailJump。
			const plan = planRailJump(railItems, id);
			if (plan.kind === "jump") {
				setPendingEntryId(undefined);
				sessionTimeline.jumpToMessage(plan.id);
				return;
			}
			setPendingAttempts(0);
			setPendingEntryId(pendingEntryIdOf(id));
		},
		[railItems, sessionTimeline],
	);
	// 补页循环：目标刻度还没加载时，一页一页向上补，直到命中 / 没有更早的页 / 保险丝烧断。
	// 关键在「等上一页落地再发下一页」——旧实现每 60ms 轮询一次，而 loadMoreMessages 在上一页
	// 仍在飞时直接 return（in-flight 守卫），这些轮询全部空转，10 次预算很快烧完，于是点最上面
	// 的刻度必弹「继续向上翻一会儿再点」（2026-10 真机反馈：62 轮会话）。
	// 上一轮补页后已加载条数（用于判定「补不出新内容」）：见下面 noProgress。
	const railLoadProgressRef = useRef<{ entryId?: string; count: number }>({ count: -1 });
	useEffect(() => {
		if (!pendingEntryId) {
			railLoadProgressRef.current = { count: -1 };
			return;
		}
		const loaded = outlineItems.find((item) => item.entryId === pendingEntryId);
		const step = planRailPendingStep({
			targetLoaded: Boolean(loaded),
			isLoadingMore: sessionTimeline.isLoadingMoreMessages,
			hasMoreMessages: sessionTimeline.hasMoreMessages,
			loadFailed: Boolean(sessionTimeline.loadMoreError),
			attempts: pendingAttempts,
			maxAttempts: RAIL_PENDING_MAX_ATTEMPTS,
		});
		if (step === "jump" && loaded) {
			setPendingEntryId(undefined);
			sessionTimeline.jumpToMessage(loaded.id);
			return;
		}
		// 上一页还在飞：原地等，不消耗预算（isLoadingMoreMessages 翻转会让本 effect 重跑）。
		if (step === "wait") return;
		// 发过补页、没在加载、条数却没涨：这一页补不出新内容（续页锚点原地踏步或文件已到顶）。
		// 继续发只会空转到保险丝，而被动 effect 里连发 setState 正是 React #185 的直接成因
		// （2026-11 真机：点大纲最上面的刻度 →「界面渲染异常」）。
		const progress = railLoadProgressRef.current;
		const noProgress = isRailLoadStalled({
			previousEntryId: progress.entryId,
			targetEntryId: pendingEntryId,
			previousCount: progress.count,
			loadedCount: outlineItems.length,
			attempts: pendingAttempts,
			isLoadingMore: sessionTimeline.isLoadingMoreMessages,
		});
		railLoadProgressRef.current = { entryId: pendingEntryId, count: outlineItems.length };
		if (step === "load" && !noProgress) {
			// 让出一轮再发：同步发下一页会让 effect → setState → effect 连成一条嵌套更新链。
			const timer = setTimeout(() => {
				setPendingAttempts((current) => current + 1);
				sessionTimeline.loadMoreMessages("backfill");
			}, 0);
			return () => clearTimeout(timer);
		}
		// 到这里说明本轮没补成页（补页失败 / 补不动 / 保险丝烧断）或已经没有更早的页。
		// 先把 entryId 交给 controller 尽力落位——它能处理「数据里有、只是节点还没挂出」的扩窗场景。
		setPendingEntryId(undefined);
		sessionTimeline.jumpToMessage(pendingEntryId);
		// 只有「真的没有更早的页」才提示跳不到；hasMoreMessages 仍为 true 时 controller 的
		// pendingJump 会继续补页（JUMP_MAX_LOAD_ATTEMPTS = 40），大概率落位成功——此时弹
		// 「还在更早的历史里」是误报，用户会看到「说跳不到，人却已经在那条上」。
		if (!sessionTimeline.hasMoreMessages) showNotice(t("outline.jumpUnreachable"), 6000, "info");
	}, [pendingEntryId, pendingAttempts, outlineItems, sessionTimeline]);
	const mutationKind = useAtomValue(sessionHistoryMutationOverlayBySessionIdAtomFamily(sessionId));
	// 热重载（扩展/技能）不重启进程、也不改会话文件，但它会重建扩展运行时；
	// 只转小按钮时用户看不出会话侧有任何变化，所以同样落一层「正在重载」遮罩。
	const overlayVisible = isRestarting || isReloading || Boolean(mutationKind);
	const overlayLabel = isReloading ? t("message.historyOverlay.reloadingResources") : isRestarting ? t("app.restarting") : mutationKind ? t(HISTORY_OVERLAY_COPY[mutationKind] ?? "message.historyOverlay.mutating") : t("app.restarting");
	return (
		<div className="relative h-full min-h-0">
			<ConversationOutline className="session-outline-pane" timelineRef={sessionTimeline.timelineRef} onTimelineWheel={sessionTimeline.scrollTimelineBy} items={railItems} onJump={pendingRailJump} />
			<SessionMessageTimeline sessionId={sessionId} controller={sessionTimeline} {...timelineProps} />

			{sessionTimeline.showScrollToBottom && (
				// 右下角小圆形按钮，跟随消息列/输入框列宽（chatContentWidthStyle 同一基准），
				// 不贴面板最右：输入框宽度可设比例，按钮右缘必须与内容列右缘对齐。
				// 外层 pointer-events-none 不影响时间线交互；按钮自身恢复接收点击。
				<div className="pointer-events-none absolute inset-0 z-20">
					<div style={chatContentWidthStyle} className="relative h-full">
						<Button
							variant="ghost"
							size="icon"
							// 稳定 DOM 锚点：e2e 用它守卫组内滚轮不会幽灵解锁外层；
							// 按钮仍须暴露给辅助技术，不得把父层标成 aria-hidden。
							data-scroll-to-bottom=""
							className="pointer-events-auto absolute left-1/2 bottom-1.5 size-8 -translate-x-1/2 border border-border-strong bg-bg-panel text-text-secondary shadow-md backdrop-blur-sm transition-[background-color,color,border-color,box-shadow] hover:border-accent hover:bg-bg-hover hover:text-foreground"
							onClick={sessionTimeline.scrollToBottom}
							title={t("app.scrollToBottom")}
							aria-label={t("app.scrollToBottom")}
						>
							<CircleArrowDown size={18} className="size-4.5" />
						</Button>
					</div>
				</div>
			)}
			{/* 重启 / 历史改写遮罩：opacity 过渡 + loader 旋转走合成器，始终挂载以便淡出。 */}
			<div className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-2.5 bg-bg-panel/70 transition-opacity duration-base ${overlayVisible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`} role={overlayVisible ? "status" : undefined} aria-hidden={!overlayVisible}>
				<div className="loader animate-pideck-spin" />
				<span className="text-body text-text-secondary">{overlayLabel}</span>
			</div>
		</div>
	);
}
