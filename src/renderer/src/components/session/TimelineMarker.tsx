import type { ReactNode } from "react";
import { Check, X } from "lucide-react";
import { cn } from "../../lib/utils";

export type TimelineMarkerKind = "thinking" | "tool" | "diagnostic";
export type TimelineMarkerTone = "neutral" | "active" | "success" | "warning" | "error";

const TONE_CLASSES: Record<TimelineMarkerTone, string> = {
	neutral: "timeline-marker-node-neutral",
	active: "timeline-marker-node-active",
	success: "timeline-marker-node-success",
	warning: "timeline-marker-node-warning",
	error: "timeline-marker-node-error",
};

/** 借鉴 AI Elements Chain of Thought 的步骤节点：完成/失败不再是同色小圆点，
 *  轨道节点直接承载状态语义（✓/✗），扫一眼即可定位失败步骤。
 *  图标用显式白色 stroke：tone 类同时设置了 color 与 background（供圆点用），
 *  lucide 默认 currentColor 会和底色相同导致图标不可见，必须显式覆盖。 */
const TONE_STATUS_ICONS: Partial<Record<TimelineMarkerTone, ReactNode>> = {
	success: <Check size={9} strokeWidth={3.5} color="#fff" />,
	error: <X size={9} strokeWidth={3.5} color="#fff" />,
};

/** 状态图标是否显示：思考/工具过程行默认无轨，此函数只服务仍显示轨道的事件
 *  （诊断）。工具即便显式开轨也不放大 ✓/✗，避免 14px 节点喧宾夺主。 */
function getStatusIcon(kind: TimelineMarkerKind, tone: TimelineMarkerTone): ReactNode | undefined {
	if (kind === "tool" || kind === "thinking") return undefined;
	return TONE_STATUS_ICONS[tone];
}

/** 思考/工具已是「图标+文案」过程行（Codex/Cursor 同款），左侧圆点轨是重复装饰；
 *  诊断等临时提示走显式 hideRail。 */
function shouldHideRail(kind: TimelineMarkerKind, hideRail?: boolean): boolean {
	if (hideRail != null) return hideRail;
	return kind === "thinking" || kind === "tool";
}

/**
 * 时间线事件的统一外壳。
 *
 * 事件内容本身仍由各业务卡片负责；Marker 承载类型/状态，并按事件种类决定
 * 是否画左侧轨道。过程行（思考/工具）默认无轨，避免与行内图标叠两套标记。
 */
export function TimelineMarker(props: {
	kind: TimelineMarkerKind;
	tone?: TimelineMarkerTone;
	children: ReactNode;
	className?: string;
	/** 内容区（timeline-marker-content）追加类，供具体卡片覆盖默认底距等间距 */
	contentClassName?: string;
	/** 不渲染左侧轨道（竖线+节点）。思考/工具默认已隐藏；诊断等临时提示显式传入。 */
	hideRail?: boolean;
}) {
	const tone = props.tone ?? "neutral";
	const hideRail = shouldHideRail(props.kind, props.hideRail);
	const statusIcon = hideRail ? undefined : getStatusIcon(props.kind, tone);
	return (
		<div className={cn("timeline-marker-row flex min-w-0 items-stretch", !hideRail && "gap-2.5", props.className)} data-marker-kind={props.kind} data-marker-tone={tone}>
			{!hideRail && (
				<div className="timeline-marker-rail relative flex w-4 shrink-0 justify-center" aria-hidden="true">
					<span className="timeline-marker-line absolute top-0 bottom-0 w-px bg-border-subtle" />
					{/* 轨道只保留状态节点；工具/思考的语义图标已经在内容卡片里，避免左侧重复一套 Logo。 */}
					<span
						className={cn(
							"timeline-marker-node relative z-[1] grid size-2 place-items-center rounded-full",
							// 思考 trigger 行较高（min-h-8 + p-1.5），节点下移 3 对齐行内容中心；
							// 工具行已收紧（20px）保持基线偏移即可；其他事件维持原偏移
							props.kind === "thinking" ? "mt-3" : "mt-1.5",
							// ✓/✗ 节点放大为 14px 并微调基线，与首行文字视觉对齐
							statusIcon && "mt-1 size-3.5",
							TONE_CLASSES[tone],
						)}
					>
						{statusIcon}
					</span>
				</div>
			)}
			<div className={cn("timeline-marker-content min-w-0 flex-1 pb-2", props.contentClassName)}>{props.children}</div>
		</div>
	);
}

/** 状态完成标记，供详情或完成态卡片复用，避免各域自行拼图标和颜色。 */
export function TimelineSuccessMarker() {
	return (
		<span className="grid size-5 place-items-center rounded-full bg-[var(--color-accent)] text-[var(--color-text-inverse)]" aria-hidden="true">
			<Check size={12} strokeWidth={2.5} />
		</span>
	);
}
