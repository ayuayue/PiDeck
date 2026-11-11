import { Clock, Loader2, Share, SquarePen, Star, Trash } from "lucide-react";
import type { RefObject } from "react";
import type { ChatMessage } from "../../../../../shared/types";
import type { PendingHistoryMutationKind } from "../../../atoms/session-atoms";
import { t } from "../../../i18n";
import { Button } from "../../ui-shadcn/button";
import { CopyMenu } from "../SurfaceComponents";
import { formatDuration } from "../TimelineFormat";

export type TurnRowActionsProps = {
	/** 整轮回复正文（Markdown 源码）；为空时整栏只剩耗时/模型。 */
	mergedText: string;
	editing: boolean;
	containsImageGen: boolean;
	/** 惰性求值的纯文本（`stripMarkdown` 走正则，只在点「复制为文本」时才跑）。 */
	resolvePlainText: () => string;
	/** 复制为图片的截取目标（整轮 `<article>`）。 */
	targetRef: RefObject<HTMLElement | null>;
	replyFavorited: boolean;
	replyMessageId: string | null;
	onFavoriteReply?: (text: string, messageId: string | null) => void;
	onEnterMultiSelect?: () => void;
	/** 进入编辑态；undefined = 不显示编辑按钮（流式中 / 无可编辑目标 / 上层没给回调）。 */
	onStartEdit?: () => void;
	/** 删除本轮回复；undefined = 不显示删除按钮，判据同上。 */
	onDeleteReply?: () => void;
	showDuration: boolean;
	duration: number;
	showTurnModel: boolean;
	turnModel?: ChatMessage["model"];
	/** 本轮回复正在编辑/删除：按钮整组替换为 spinner 行（与用户气泡 pending 同口径）。 */
	pendingKind?: PendingHistoryMutationKind | null;
};

/**
 * 轮尾操作栏：复制（文本 / 图片）/ 收藏 / 多选 / 编辑 / 删除，以及行末的耗时与模型名。
 *
 * 为什么单独一个组件：TurnRow 是「一轮怎么组织」，这里是「一轮结束后给用户哪些动作」。
 * 抽出来之前这段 60 多行的 JSX 与折叠栏、最终回答、文件清单挤在同一个 return 里，
 * TurnRow 已经越过单文件行数红线（AGENTS.md §6：超 600 行必须评估拆分）。
 *
 * 两条纪律写在搬移前，搬完照旧生效：
 * 1. 耗时与模型名排在**行末**（用户视线在底部）。流式期间的实时秒表在状态条
 *    （与「正在执行命令…」同行，见 statusFacts），这里只显示本轮结束后的固定耗时，
 *    保证同一个数字不同时出现两处；
 * 2. 半透明降噪必须盖住整行——按钮图标与行末数字同一层，否则「图标偏淡、数字偏深」。
 *
 * 分区（2026-10 用户要求）：按钮 | 耗时 | 模型，三区之间用竖线分隔，视觉上各归各位。
 * 竖线只在两侧都真有内容时才画：空正文的轮只剩耗时/模型，不能留下孤立的竖线。
 */
function ZoneDivider() {
	return (
		<span aria-hidden="true" className="mx-1 select-none leading-none text-text-faint">
			|
		</span>
	);
}

export function TurnRowActions(props: TurnRowActionsProps) {
	const showActions = Boolean(props.mergedText) && !props.editing && !props.pendingKind;
	if (props.pendingKind) {
		return (
			<div className="flex min-h-6 items-center gap-1.5 text-xs text-text-secondary" role="status">
				<Loader2 size={14} className="animate-pideck-spin" aria-hidden="true" />
				<span>{props.pendingKind === "delete" ? t("web.msgDeleting") : t("web.msgSaving")}</span>
			</div>
		);
	}
	if (!showActions && !props.showDuration && !props.showTurnModel) return null;
	return (
		<div className={`flex min-h-6 items-center gap-1${showActions ? " opacity-55 transition-opacity hover:opacity-100 focus-within:opacity-100" : ""}`}>
			{showActions && (
				<>
					{!props.containsImageGen && <CopyMenu resolveText={props.resolvePlainText} markdown={props.mergedText} targetRef={props.targetRef} />}
					{/* 收藏整轮回复：与复制同源（Markdown 源码），快照落本机收藏页；入口不依赖编辑权限。
						    已收藏显示实心星（与右键菜单同一身份），再点即取消。 */}
					{props.onFavoriteReply && (
						<Button
							type="button"
							variant="ghost"
							size="icon-sm"
							className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground"
							aria-pressed={props.replyFavorited}
							onClick={() => props.onFavoriteReply?.(props.mergedText, props.replyMessageId)}
							title={props.replyFavorited ? t("favorites.unsaveMessage") : t("favorites.saveMessage")}
							aria-label={props.replyFavorited ? t("favorites.unsaveMessage") : t("favorites.saveMessage")}
						>
							<Star size={14} className={props.replyFavorited ? "fill-current" : undefined} />
						</Button>
					)}
					<Button type="button" variant="ghost" size="icon-sm" className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={props.onEnterMultiSelect} title={t("app.multiSelectEnter")}>
						<Share size={14} />
					</Button>
					{props.onStartEdit && (
						<Button type="button" variant="ghost" size="icon-sm" className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={props.onStartEdit} title={t("common.edit")}>
							<SquarePen size={14} />
						</Button>
					)}
					{props.onDeleteReply && (
						<Button type="button" variant="ghost" size="icon-sm" className="turn-row-action-btn size-7 rounded-sm text-muted-foreground hover:bg-muted hover:text-foreground" onClick={props.onDeleteReply} title={t("common.delete")}>
							<Trash size={14} />
						</Button>
					)}
				</>
			)}
			{showActions && (props.showDuration || (props.showTurnModel && props.turnModel)) && <ZoneDivider />}
			{props.showDuration && (
				/* 图标尺寸 14 对齐同行按钮图标（原独占一行时是 12）；与按钮区之间改由竖线分隔，
				   不再用 pl-2 模拟按钮内缩。 */
				<div className="flex items-center gap-1.5 text-muted-foreground">
					<Clock size={14} className="shrink-0" aria-hidden="true" />
					{/* 固定耗时（实时读数在状态条，见 statusFacts）；tabular-nums 与行头时间对齐 */}
					<span className="text-body leading-none tabular-nums">{formatDuration(props.duration)}</span>
				</div>
			)}
			{props.showDuration && props.showTurnModel && props.turnModel && <ZoneDivider />}
			{props.showTurnModel && props.turnModel && (
				/* 本轮实际使用的模型（provider + modelId）跟在耗时后面：同一会话内用户会频繁换模型，
				   只在输入框显示当前模型不足以回看历史轮；流式中不显示，回复结束才落定。
				   字号与耗时区统一为 text-body（2026-10 用户要求：模型名不再比同行小一号）；保留等宽
				   字体以区别于耗时读数，但去掉灰底——每轮都有的元信息 chip 会给时间线添碎。
				   字符上限 28ch：等宽字体里 1ch 恰好是一个字符宽，超过按字符截断成省略号；
				   max-w-[16rem] 只是窄窗口下的硬顶，不让长 id 把操作栏挤走。
				   title 给全量 provider/model，鼠标移入可看全。 */
				<span className="min-w-0 max-w-[16rem] truncate font-mono text-body leading-none text-text-tertiary" title={`${props.turnModel.provider}/${props.turnModel.modelId}`} data-turn-model={props.turnModel.modelId}>
					<span className="block max-w-[28ch] truncate">{props.turnModel.modelId}</span>
				</span>
			)}
		</div>
	);
}
