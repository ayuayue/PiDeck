import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, CircleHelp, Copy, Eye, EyeOff, X } from "lucide-react";
import { Button } from "./button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./collapsible";
import { cn } from "../../lib/utils";
import { t } from "../../i18n";
import { writeClipboard } from "../../utils/clipboard";

/**
 * ApprovalCard 是 AI 人在回路交互的通用外壳。
 *
 * 这里只负责 BEUI 风格的标题、折叠、取消和内容布局，不处理业务答案。
 * Ask、权限确认和后续需要用户批准的 Plan 步骤都可以复用同一外壳，
 * 这样不同阻塞点不会各自维护一套视觉和展开状态。
 *
 * 交互边界（2026-12 重做）：
 * - 只有 chevron 是 CollapsibleTrigger。标题/描述必须是普通可选择文本，
 *   否则 mouseup 结束划选会被当成一次 click，把选项区折起来。
 * - 眼睛只切换 description 全文/摘要，复制写未折叠全文；两者都是 trigger 的兄弟，
 *   不得嵌进折叠按钮（嵌套 button 会让折叠/展开抢点击）。
 */

/** 状态胶囊的语义提示：active=等待（琥珀脉动点）、success=已应答（绿色勾）、danger=已取消（红点）。 */
export type ApprovalCardStatusTone = "active" | "success" | "danger";

function StatusIndicator({ tone }: { tone: ApprovalCardStatusTone }) {
	if (tone === "success") {
		return <Check size={12} className="text-emerald-500" aria-hidden="true" />;
	}
	if (tone === "danger") {
		return <span className="inline-block size-1.5 rounded-full bg-red-500" aria-hidden="true" />;
	}
	return (
		<span className="relative flex size-1.5" aria-hidden="true">
			<span className="absolute inline-flex size-full animate-ping rounded-full bg-amber-400 opacity-75" />
			<span className="relative inline-flex size-1.5 rounded-full bg-amber-500" />
		</span>
	);
}

export function ApprovalCard(props: {
	title: string;
	description?: string;
	/** description 超过该行数时默认折叠为摘要（对应 plan 草案等超长列表）；
	 *  不传则保持原样全量展示，兼容权限确认等短描述场景。 */
	descriptionPreviewLines?: number;
	status?: string;
	/** 状态胶囊的语义色；缺省时仅显示纯文本胶囊，不带状态点。 */
	statusTone?: ApprovalCardStatusTone;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCancel?: () => void;
	cancelLabel: string;
	cancelDisabled?: boolean;
	children: ReactNode;
	className?: string;
}) {
	// 摘要展开态与卡片整体 open 解耦：chevron 折叠的是选项区，眼睛只控制 description 全文。
	const [descExpanded, setDescExpanded] = useState(false);
	const [copied, setCopied] = useState(false);
	const copyResetTimerRef = useRef<number | null>(null);
	const descriptionClamped = Boolean(props.descriptionPreviewLines) && !descExpanded;
	const showDescriptionToggle = Boolean(props.descriptionPreviewLines && props.description);
	const optionsLabel = props.open ? t("ask.collapseOptions") : t("ask.expandOptions");
	const copyLabel = copied ? t("common.copied") : t("ask.copyPrompt");

	// 卡片卸载后必须清掉 copied 回滞计时器，避免写入已卸载组件的 state。
	useEffect(() => {
		return () => {
			if (copyResetTimerRef.current !== null) {
				window.clearTimeout(copyResetTimerRef.current);
				copyResetTimerRef.current = null;
			}
		};
	}, []);

	const copyPrompt = () => {
		// 复制始终写未折叠全文。预览 clamp 只影响展示，不能让用户以为复制的是截断摘要。
		const text = props.description ? `${props.title}\n\n${props.description}` : props.title;
		void writeClipboard(text).then(() => {
			setCopied(true);
			if (copyResetTimerRef.current !== null) {
				window.clearTimeout(copyResetTimerRef.current);
			}
			copyResetTimerRef.current = window.setTimeout(() => {
				copyResetTimerRef.current = null;
				setCopied(false);
			}, 1500);
		});
	};

	return (
		<Collapsible open={props.open} onOpenChange={props.onOpenChange} className={cn("ask-inline-bar ask-inline-bar--active relative flex min-w-0 flex-col overflow-hidden rounded-lg border border-border bg-card text-card-foreground shadow-sm", props.className)}>
			<div className="flex min-w-0 items-start gap-2 border-b border-border/70 bg-muted/25 px-3 py-1">
				<CollapsibleTrigger asChild>
					<Button variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-foreground" aria-label={optionsLabel} title={optionsLabel}>
						<ChevronDown className={cn("size-3.5 shrink-0 transition-transform duration-200", !props.open && "-rotate-90")} aria-hidden="true" />
					</Button>
				</CollapsibleTrigger>
				<CircleHelp className="mt-1.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
				<div className="min-w-0 flex-1 py-0.5">
					<div className="whitespace-pre-wrap break-words text-caption font-semibold leading-relaxed text-foreground select-text">{props.title}</div>
					{props.description ? (
						// 有 previewLines 时默认 line-clamp-2 折叠为摘要（plan 草案等超长列表）；
						// title 兜底悬停看全文，眼睛按钮显式切换全文/摘要。文本本身可划选复制。
						<div className={cn("whitespace-pre-wrap break-words text-micro font-normal leading-relaxed text-muted-foreground select-text", descriptionClamped && "line-clamp-2")} title={descriptionClamped ? props.description : undefined}>
							{props.description}
						</div>
					) : null}
				</div>
				<div className="flex shrink-0 items-start gap-0.5">
					{props.status ? (
						<span className="mt-1 inline-flex shrink-0 items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-px text-micro font-medium text-primary">
							{props.statusTone ? <StatusIndicator tone={props.statusTone} /> : null}
							{props.status}
						</span>
					) : null}
					{showDescriptionToggle ? (
						<Button
							variant="ghost"
							size="icon-sm"
							className="size-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-foreground"
							title={descExpanded ? t("ask.collapseDescription") : t("ask.expandDescription")}
							aria-label={descExpanded ? t("ask.collapseDescription") : t("ask.expandDescription")}
							onClick={() => setDescExpanded((next) => !next)}
						>
							{descExpanded ? <EyeOff size={14} aria-hidden="true" /> : <Eye size={14} aria-hidden="true" />}
						</Button>
					) : null}
					<Button variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground hover:bg-accent hover:text-foreground" title={copyLabel} aria-label={copyLabel} onClick={() => copyPrompt()}>
						{copied ? <Check size={14} aria-hidden="true" /> : <Copy size={14} aria-hidden="true" />}
					</Button>
					{props.onCancel ? (
						<Button variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive" aria-label={props.cancelLabel} title={props.cancelLabel} disabled={props.cancelDisabled} onClick={props.onCancel}>
							<X aria-hidden="true" />
						</Button>
					) : null}
				</div>
			</div>
			<CollapsibleContent className="min-h-0 px-3 pb-3 pt-2">{props.children}</CollapsibleContent>
		</Collapsible>
	);
}
