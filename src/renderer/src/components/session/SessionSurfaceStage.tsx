import { CircleArrowDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import type { SessionMessageTimelineProps } from "./SessionMessageTimeline";
import { SessionMessageTimeline } from "./SessionMessageTimeline";
import { showNotice } from "../../utils/notice";
import { outlineItemsBySessionIdAtomFamily, sessionHistoryMutationOverlayBySessionIdAtomFamily } from "../../atoms";
import { isPendingRailItemId, mergeOutlineRailItems, pendingEntryIdOf, RAIL_PENDING_MAX_ATTEMPTS } from "./timeline/outlineRailTicks";
import { useSessionOutlineDirectory } from "../../hooks/useSessionOutlineDirectory";
import { formatTime, summarizeMessage } from "../app/AppUtils";
import { replaceExpandedRefBlocksWithLabels } from "../../../../shared/expandedRefBlocks";
import { Button } from "../ui-shadcn/button";
import { chatContentWidthStyle } from "./chatContentWidth";
import { t, type TranslationKey } from "../../i18n";
import type { AgentRunItem } from "./timeline/types";
import { ConversationOutline } from "./SurfaceComponents";
import { areOutlineRailItemsEqual } from "./timeline/outlineRailActive";

const HISTORY_OVERLAY_COPY: Record<string, TranslationKey> = {
	stopping: "message.historyOverlay.stopping",
	mutating: "message.historyOverlay.mutating",
	reloading: "message.historyOverlay.reloading",
	activating: "message.historyOverlay.activating",
	forking: "message.historyOverlay.forking",
	// 重发/编辑迁移在内部走 fork，但用户感知的是“重发/编辑”这个动作，文案不暴露实现术语
	editing: "message.historyOverlay.editing",
	resending: "message.historyOverlay.resending",
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
	const directoryRailItems = useMemo(
		() =>
			directory.map((entry) => ({
				entryId: entry.entryId,
				title: entry.preview ? summarizeMessage(replaceExpandedRefBlocksWithLabels(entry.preview)) : t("outline.turnFallback", { index: entry.turnOrdinal + 1 }),
				time: entry.timestamp ? formatTime(Date.parse(entry.timestamp)) : "",
			})),
		[directory],
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
			setPendingAttempts(0);
			setPendingEntryId(pendingEntryIdOf(id));
		},
		[sessionTimeline],
	);
	// 补页循环：每轮等已加载条数变化再决定继续；到目标即停，上限覆盖整个刻度窗口。
	useEffect(() => {
		if (!pendingEntryId) return;
		const loaded = outlineItems.find((item) => item.entryId === pendingEntryId);
		if (loaded) {
			setPendingEntryId(undefined);
			sessionTimeline.jumpToMessage(loaded.id);
			return;
		}
		if (pendingAttempts >= RAIL_PENDING_MAX_ATTEMPTS) {
			// 补页预算用尽：必须给反馈。静默放弃会让「点了刻度没反应」变成无解释的黑洞
			// （导轨现在最多 30 条、覆盖整个会话，靠前的刻度天然可能超出补页预算）。
			setPendingEntryId(undefined);
			showNotice(t("outline.jumpUnreachable"), 6000, "info");
			return;
		}
		const timer = setTimeout(() => {
			setPendingAttempts((current) => current + 1);
			sessionTimeline.loadMoreMessages("button");
		}, 60);
		return () => clearTimeout(timer);
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
