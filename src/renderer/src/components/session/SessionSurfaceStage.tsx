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
	resending: "message.historyOverlay.resending",
	editing: "message.historyOverlay.editing",
	deleting: "message.historyOverlay.deleting",
	rewinding: "message.historyOverlay.rewinding",
};

/**
 * 中栏表面：只承载对话时间线。轨迹复盘已迁到右侧抽屉独立 tab。
 */
export function SessionSurfaceStage(props: { sessionId: string; sessionTimeline: SessionTimelineController; timelineProps: Omit<SessionMessageTimelineProps, "sessionId" | "controller">; isRestarting: boolean; isReloading?: boolean }) {
	const { sessionId, sessionTimeline, timelineProps, isRestarting, isReloading = false } = props;
	// Assistant streaming rebuilds the derived array; equal user checkpoints should not rerender the rail.
	const outlineItemsAtom = useMemo(() => selectAtom(outlineItemsBySessionIdAtomFamily(sessionId), (items) => items, areOutlineRailItemsEqual), [sessionId]);
	const outlineItems = useAtomValue(outlineItemsAtom);
	// 刻度只收用户提问（buildOutline），条数就是提问数；助手回复增删都不必重拉目录。
	const outlineUserCount = outlineItems.length;
	// 索引目录补齐「已加载消息之外」的用户检查点；未加载项点击后连续补页再跳转。
	const directory = useSessionOutlineDirectory(sessionId, outlineUserCount);
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
	// 灰色的占位刻度不再有「先向上补页再跳」这条循环：目标 entryId 直接交给 controller，
	// 它按 entryId 一次定位取页（loadPageAroundEntry），向上向下同一条路径。
	// 旧循环的三个失败形态（补页 in-flight 空转烧预算、补不出新内容时死循环、
	// 从顶部点最新一条时方向反了）都随这段一起消失。
	const pendingRailJump = useCallback(
		(id: string) => {
			sessionTimeline.jumpToMessage(planRailJump(railItems, id).id);
		},
		[railItems, sessionTimeline],
	);
	const mutationKind = useAtomValue(sessionHistoryMutationOverlayBySessionIdAtomFamily(sessionId));
	// 热重载（扩展/技能）不重启进程、也不改会话文件，但它会重建扩展运行时；
	// 只转小按钮时用户看不出会话侧有任何变化，所以同样落一层「正在重载」遮罩。
	const liveOverlayVisible = isRestarting || isReloading || Boolean(mutationKind);
	const liveOverlayLabel = isReloading ? t("message.historyOverlay.reloadingResources") : isRestarting ? t("app.restarting") : mutationKind ? t(HISTORY_OVERLAY_COPY[mutationKind] ?? "message.historyOverlay.mutating") : t("app.restarting");
	// 转场衔接：fork 切会话时新会话侧的遮罩在首帧前即挂好（hook 侧先挂目标、再清源），
	// 这里只需冻结旧文案 60ms 避免淡出瞬间文案跳变，真实淡出走 transition-opacity。
	const [overlayVisible, setOverlayVisible] = useState(liveOverlayVisible);
	const [overlayLabel, setOverlayLabel] = useState(liveOverlayLabel);
	const labelFrozenRef = useRef(false);
	const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(() => {
		if (hideTimerRef.current) {
			clearTimeout(hideTimerRef.current);
			hideTimerRef.current = null;
		}
		if (liveOverlayVisible) {
			labelFrozenRef.current = false;
			setOverlayLabel(liveOverlayLabel);
			setOverlayVisible(true);
			return;
		}
		if (!labelFrozenRef.current) labelFrozenRef.current = true;
		hideTimerRef.current = setTimeout(() => {
			labelFrozenRef.current = false;
			setOverlayVisible(false);
		}, 60);
		return () => {
			if (hideTimerRef.current) {
				clearTimeout(hideTimerRef.current);
				hideTimerRef.current = null;
			}
		};
	}, [liveOverlayVisible, liveOverlayLabel]);
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
							// 浮动提问卡压住列底中线时由 FloatingAskLayer 下发抬高量，按钮停在卡片上方而不是被盖住。
							style={{ bottom: "calc(0.375rem + var(--ask-float-scroll-lift, 0px))" }}
							className="pointer-events-auto absolute left-1/2 size-8 -translate-x-1/2 border border-border-strong bg-bg-panel text-text-secondary shadow-md backdrop-blur-sm transition-[background-color,color,border-color,box-shadow] hover:border-accent hover:bg-bg-hover hover:text-foreground"
							onClick={sessionTimeline.scrollToBottom}
							title={t("app.scrollToBottom")}
							aria-label={t("app.scrollToBottom")}
						>
							<CircleArrowDown size={18} className="size-4.5" />
						</Button>
					</div>
				</div>
			)}
			{/* 重启 / 历史改写遮罩：opacity 过渡 + loader 旋转走合成器，始终挂载以便淡出。
			   旋转类只在可见时挂上——隐藏态 opacity:0 不能代表动画停下，一直在转的
			   loader 仍会每帧参与合成（issue #510：DOM 里那个透明 overlay 的 spinner）。 */}
			<div className={`absolute inset-0 z-30 flex flex-col items-center justify-center gap-2.5 bg-bg-panel/70 transition-opacity duration-base ${overlayVisible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`} role={overlayVisible ? "status" : undefined} aria-hidden={!overlayVisible}>
				<div className={`loader${overlayVisible ? " animate-pideck-spin" : ""}`} />
				<span className="text-body text-text-secondary">{overlayLabel}</span>
			</div>
		</div>
	);
}
