import { CircleArrowDown } from "lucide-react";
import { useMemo } from "react";
import { useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import type { SessionTimelineController } from "../../hooks/useSessionTimelineController";
import type { SessionMessageTimelineProps } from "./SessionMessageTimeline";
import { SessionMessageTimeline } from "./SessionMessageTimeline";
import { outlineItemsBySessionIdAtomFamily, sessionHistoryMutationOverlayBySessionIdAtomFamily } from "../../atoms";
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
};

/**
 * 中栏表面：只承载对话时间线。轨迹复盘已迁到右侧抽屉独立 tab。
 */
export function SessionSurfaceStage(props: { sessionId: string; sessionTimeline: SessionTimelineController; timelineProps: Omit<SessionMessageTimelineProps, "sessionId" | "controller">; isRestarting: boolean }) {
	const { sessionId, sessionTimeline, timelineProps, isRestarting } = props;
	// Assistant streaming rebuilds the derived array; equal user checkpoints should not rerender the rail.
	const outlineItemsAtom = useMemo(() => selectAtom(outlineItemsBySessionIdAtomFamily(sessionId), (items) => items, areOutlineRailItemsEqual), [sessionId]);
	const outlineItems = useAtomValue(outlineItemsAtom);
	const mutationKind = useAtomValue(sessionHistoryMutationOverlayBySessionIdAtomFamily(sessionId));
	const overlayVisible = isRestarting || Boolean(mutationKind);
	const overlayLabel = isRestarting ? t("app.restarting") : mutationKind ? t(HISTORY_OVERLAY_COPY[mutationKind] ?? "message.historyOverlay.mutating") : t("app.restarting");
	return (
		<div className="relative h-full min-h-0">
			<ConversationOutline className="session-outline-pane" timelineRef={sessionTimeline.timelineRef} onTimelineWheel={sessionTimeline.scrollTimelineBy} items={outlineItems} onJump={sessionTimeline.jumpToMessage} />
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
							className="pointer-events-auto absolute left-1/2 bottom-1.5 size-8 -translate-x-1/2 border border-border-strong bg-bg-panel text-text-secondary shadow-md backdrop-blur-sm transition-[background-color,color,border-color,box-shadow] hover:border-accent hover:bg-bg-hover hover:text-foreground hover:shadow-lg"
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
			<div className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-2.5 bg-bg-panel/70 transition-opacity duration-200 ${overlayVisible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`} role={overlayVisible ? "status" : undefined} aria-hidden={!overlayVisible}>
				<div className="loader animate-pideck-spin" />
				<span className="text-body text-text-secondary">{overlayLabel}</span>
			</div>
		</div>
	);
}
