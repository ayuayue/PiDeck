"use client";
// beui.dev/components/agents/tool-result
//
// beUI 官方实现（官方/定制双轨收敛后的唯一实现，2026-08）。
// 保留官方新增能力：状态图标（spinner/check/x/ban）、ActionSwapRollText 换字动画、
// 折叠与按状态自动开合、retry、meta/icon 扩展。
// 另含 PiDeck 本地扩展（定制版同签名，调用方不变）：
// - `showHeader`：false 时隐藏折叠头部，内容恒展开（工具卡宿主已有自己的头部 chrome）；
// - `copyClassName`：复制按钮追加类名（如工具卡内的 tool-card-copy 悬浮显隐）；
// - 用户可见文案走 i18n（AGENTS.md 硬性要求）。

import { Ban, Braces, Check, ChevronDown, CircleCheck, CircleX, Copy, LoaderCircle, RotateCcw, SquareTerminal, Wrench } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { AgentCode, type AgentCodeLanguage } from "@/components/agents/agent-code";
import { ActionSwapRollText } from "@/components/motion/action-swap-roll";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { t } from "@/i18n";
import { SPRING_PRESS, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type ToolResultStatus = "running" | "success" | "error" | "cancelled";
export type ToolResultKind = "terminal" | "request" | "custom";

export interface ToolResultProps {
	tool?: ReactNode;
	title: ReactNode;
	children: ReactNode;
	status?: ToolResultStatus;
	kind?: ToolResultKind;
	meta?: ReactNode;
	icon?: ReactNode;
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	collapseOnComplete?: boolean;
	/** `null` = 不限高不自转滚轮：[PiDeck local] 外层已自带滚轮时（过程组组体）让内层让位，避免双层滚动条。 */
	maxHeight?: number | null;
	copyText?: string;
	onCopy?: () => void | Promise<void>;
	onRetry?: () => void;
	className?: string;
	contentClassName?: string;
	/** [PiDeck local] 隐藏折叠头部，内容恒展开（宿主自带头部 chrome 时用，如工具卡）。 */
	showHeader?: boolean;
	/** [PiDeck local] 复制按钮追加类名（如 tool-card-copy 的悬浮显隐规则）。 */
	copyClassName?: string;
}

export interface ToolResultOutputProps {
	children: string;
	language?: AgentCodeLanguage;
	className?: string;
}

function getStatusLabel(status: ToolResultStatus) {
	if (status === "running") return t("app.toolResultStatusRunning");
	if (status === "success") return t("app.toolResultStatusCompleted");
	if (status === "error") return t("app.toolResultStatusFailed");
	return t("app.toolResultStatusCancelled");
}

function getSwapKey(value: ReactNode, fallback: string) {
	return typeof value === "string" || typeof value === "number" ? String(value) : fallback;
}

/**
 * Execution states use PiDeck semantic tokens. The user's accent identifies
 * interactive selection, while success/error meaning must remain stable.
 */
function getStatusClass(status: ToolResultStatus) {
	if (status === "running") return "text-info";
	if (status === "success") return "text-success";
	if (status === "error") return "text-danger";
	return "text-text-tertiary";
}

function KindIcon({ kind }: { kind: ToolResultKind }) {
	if (kind === "terminal") return <SquareTerminal className="size-4" />;
	if (kind === "request") return <Braces className="size-4" />;
	return <Wrench className="size-4" />;
}

function StatusIcon({ status, reduce }: { status: ToolResultStatus; reduce: boolean }) {
	if (status === "running") {
		return <LoaderCircle className={cn("size-3", !reduce && "animate-pideck-spin")} />;
	}
	if (status === "success") return <CircleCheck className="size-3" />;
	if (status === "error") return <CircleX className="size-3" />;
	return <Ban className="size-3" />;
}

function ToolResultAction({ label, onClick, className, children }: { label: string; onClick: () => void; className?: string; children: ReactNode }) {
	const reduce = useReducedMotion() ?? false;

	return (
		<motion.button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			whileTap={reduce ? undefined : { scale: 0.9 }}
			transition={SPRING_PRESS}
			className={cn("grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring", className)}
		>
			{children}
		</motion.button>
	);
}

export function ToolResultOutput({ children, language = "bash", className }: ToolResultOutputProps) {
	return (
		<AgentCode
			code={children}
			language={language}
			className={cn(
				// Tool output is a process log rather than source code: keep it in the
				// app's neutral color scale instead of beUI's fixed GitHub Shiki palette.
				// Match PiDeck's prior custom result density: caption text with relaxed leading.
				"whitespace-pre-wrap break-words text-[length:var(--font-size-caption)]",
				"leading-[1.625] text-[color:var(--color-text-secondary)]",
				"[&_span]:text-[color:var(--color-text-secondary)]",
				className,
			)}
		/>
	);
}

export function ToolResult({ tool = null, title, children, status = "running", kind = "custom", meta, icon, open, defaultOpen = true, onOpenChange, collapseOnComplete = true, maxHeight = 220, copyText, onCopy, onRetry, className, contentClassName, showHeader = true, copyClassName }: ToolResultProps) {
	const reduce = useReducedMotion() ?? false;
	const baseId = useId();
	const triggerId = `${baseId}-trigger`;
	const contentId = `${baseId}-content`;
	const viewportRef = useRef<HTMLDivElement>(null);
	const previousStatus = useRef(status);
	const copyTimer = useRef<number | undefined>(undefined);
	const [copied, setCopied] = useState(false);
	const [internalOpen, setInternalOpen] = useState(defaultOpen);
	const currentOpen = open ?? internalOpen;
	const running = status === "running";
	const canCopy = Boolean(copyText || onCopy);
	// maxHeight 为 null（外层已自带滚轮，如过程组组体）时不限高、不自转滚轮：避免双层滚动条。
	// 只影响这一处容器，外层已有滚轮承载滚动，内层再截断没有意义（详见 file-diff.tsx 同款注释）。
	const maxHeightStyle = maxHeight === null ? undefined : { maxHeight };
	// 类名内联在容器行上、不抽常量：scrollContainerGuard 只认元素行里的 overflow-* 字面量，
	// 抽成变量会让这个真实滚动窗从判定面里整条消失（PR #471 review 实测）。
	const titleKey = getSwapKey(title, status);
	const metaKey = getSwapKey(meta, `${status}-meta`);
	const toolKey = getSwapKey(tool, `${status}-tool`);
	const statusLabel = getStatusLabel(status);

	const setOpen = useCallback(
		(next: boolean) => {
			if (open === undefined) setInternalOpen(next);
			onOpenChange?.(next);
		},
		[onOpenChange, open],
	);

	// 无头部（showHeader=false）时不做状态驱动的自动折叠：宿主工具卡靠自己的
	// chrome 呈现状态，结果内容须恒可见（定制版行为）。
	useEffect(() => {
		if (!showHeader) return;
		if (previousStatus.current !== "running" && status === "running") {
			setOpen(true);
		}
		if (previousStatus.current === "running" && status !== "running" && collapseOnComplete) {
			setOpen(false);
		}
		previousStatus.current = status;
	}, [collapseOnComplete, setOpen, showHeader, status]);

	useEffect(
		() => () => {
			if (copyTimer.current) window.clearTimeout(copyTimer.current);
		},
		[],
	);

	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport || !currentOpen || !running) return;

		const frame = requestAnimationFrame(() => {
			if (typeof viewport.scrollTo === "function") {
				viewport.scrollTo({
					top: viewport.scrollHeight,
					behavior: reduce ? "auto" : "smooth",
				});
			} else {
				viewport.scrollTop = viewport.scrollHeight;
			}
		});
		return () => cancelAnimationFrame(frame);
	});

	const handleCopy = useCallback(async () => {
		if (onCopy) await onCopy();
		else if (copyText) await navigator.clipboard?.writeText(copyText);

		setCopied(true);
		if (copyTimer.current) window.clearTimeout(copyTimer.current);
		copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
	}, [copyText, onCopy]);

	return (
		<div data-state={status} aria-busy={running} className={cn("w-full text-sm", className)}>
			{showHeader ? (
				<button
					id={triggerId}
					type="button"
					aria-expanded={currentOpen}
					aria-controls={contentId}
					onClick={() => setOpen(!currentOpen)}
					className="group flex min-h-9 w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
				>
					<span aria-hidden="true" className="grid size-4 shrink-0 place-items-center text-muted-foreground">
						{icon ?? <KindIcon kind={kind} />}
					</span>
					<span className="flex min-w-0 flex-1 items-baseline gap-2">
						<span className="min-w-0 truncate font-medium text-foreground/90">
							<ActionSwapRollText value={titleKey}>{title}</ActionSwapRollText>
						</span>
						{meta ? (
							<span className="shrink-0 text-xs text-muted-foreground/60">
								<ActionSwapRollText value={metaKey}>{meta}</ActionSwapRollText>
							</span>
						) : null}
						<span className="min-w-0 truncate font-mono text-micro text-muted-foreground/55">
							<ActionSwapRollText value={toolKey}>{tool}</ActionSwapRollText>
						</span>
					</span>
					<span className={cn("inline-flex shrink-0 items-center gap-1 text-micro font-medium", getStatusClass(status))}>
						<StatusIcon status={status} reduce={reduce} />
						<ActionSwapRollText value={status}>{statusLabel}</ActionSwapRollText>
					</span>
					<motion.span aria-hidden="true" animate={{ rotate: currentOpen ? 180 : 0 }} transition={reduce ? { duration: 0 } : SPRING_SWAP} className="shrink-0 text-muted-foreground/50 transition-colors group-hover:text-muted-foreground">
						<ChevronDown className="size-3.5" />
					</motion.span>
				</button>
			) : null}

			<AgentDisclosure id={contentId} role="region" aria-labelledby={showHeader ? triggerId : undefined} open={showHeader ? currentOpen : true}>
				{/* Embedded ToolCard already aligns beneath its own icon; applying the
            standalone beUI header gutter here would produce a double indent. */}
				<div className={cn("pt-1.5", showHeader && "pl-6")}>
					<div className={cn("min-w-0", showHeader && "overflow-hidden rounded-xl bg-muted/80")}>
						{/* scroll-ok: nested —— 行模型由 children（ToolCard 渲染的内容）持有，本层只是限高视口。 */}
						<div ref={viewportRef} role="log" aria-live="polite" className={maxHeight === null ? "" : "scrollbar-hide overflow-y-auto"} style={maxHeightStyle}>
							<div className={cn(showHeader ? "p-3" : "py-1", contentClassName)}>{children}</div>
						</div>

						{canCopy || onRetry ? (
							<div className={cn("flex items-center gap-0.5", showHeader ? "px-2 pb-1.5" : "pt-1")}>
								{canCopy ? (
									<ToolResultAction label={copied ? t("app.toolResultCopied") : t("app.toolResultCopy")} onClick={handleCopy} className={copyClassName}>
										{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
									</ToolResultAction>
								) : null}
								{onRetry ? (
									<ToolResultAction label={t("app.toolResultRunAgain")} onClick={onRetry}>
										<RotateCcw className="size-3.5" />
									</ToolResultAction>
								) : null}
								<span className="ml-auto text-micro text-muted-foreground/55">
									<ActionSwapRollText value={status}>{statusLabel}</ActionSwapRollText>
								</span>
							</div>
						) : null}
					</div>
				</div>
			</AgentDisclosure>
		</div>
	);
}
