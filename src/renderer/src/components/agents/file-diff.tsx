"use client";
// beui.dev/components/agents/file-diff
//
// beUI 官方实现（官方/定制双轨收敛后的唯一实现，2026-08）。
// 保留官方新增能力：流式状态图标（LoaderCircle/Check）、自动折叠与追底滚动；
// 另含 PiDeck 本地扩展：`animateHeight`（展开/收起是否播放高度动画），
// 放在高度受外部 hug 测量（如 composer 卡）的容器内时传 false：折叠瞬时完成，
// 避免 0.14s 连续高度变化被 ResizeObserver 逐帧上报导致外层面板/时间线抖动。

import { Check, ChevronDown, Copy, FileCode2, LoaderCircle } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { type ReactNode, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { type AgentCodeLanguage, AgentCodeLine, useAgentCodeTokens } from "@/components/agents/agent-code";
import { AgentDisclosure } from "@/components/agents/agent-disclosure";
import { SPRING_PRESS, SPRING_SWAP } from "@/lib/ease";
import { cn } from "@/lib/utils";

export type FileDiffStatus = "streaming" | "complete";
export type FileDiffLineType = "added" | "removed" | "context";

export interface FileDiffLine {
	id: string;
	type?: FileDiffLineType;
	oldLine?: number;
	newLine?: number;
	content: string;
}

export interface FileDiffProps {
	file: ReactNode;
	lines: FileDiffLine[];
	status?: FileDiffStatus;
	open?: boolean;
	defaultOpen?: boolean;
	onOpenChange?: (open: boolean) => void;
	collapseOnComplete?: boolean;
	/** `null` = 不限高不自转滚轮：[PiDeck local] 外层已自带滚轮时（过程组组体）让内层让位，避免双层滚动条。 */
	maxHeight?: number | null;
	language?: AgentCodeLanguage;
	copyText?: string;
	onCopy?: () => void | Promise<void>;
	className?: string;
	/**
	 * [PiDeck local] 展开/收起是否播放高度动画（默认 true，保持 beui 原行为）。
	 * 放在高度受外部 hug 测量（如 composer 卡）的容器内时传 false：折叠瞬时完成，
	 * 避免 0.14s 连续高度变化被 ResizeObserver 逐帧上报导致外层面板/时间线抖动。
	 */
	animateHeight?: boolean;
}

function ChangeCount({ value, type }: { value: number; type: "added" | "removed" }) {
	if (!value) return null;
	return (
		<span className={cn("font-mono text-xs tabular-nums", type === "added" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
			{type === "added" ? "+" : "−"}
			{value}
		</span>
	);
}

export function FileDiff({ file, lines, status = "streaming", open, defaultOpen = true, onOpenChange, collapseOnComplete = true, maxHeight = 220, language = "typescript", copyText, onCopy, className, animateHeight = true }: FileDiffProps) {
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
	const streaming = status === "streaming";
	// maxHeight 为 null（外层已自带滚轮，如过程组组体）时不做限高、不自转滚轮，直接自然铺开。
	// 双层滚动条（内层小窗 + 外层组体）观感像卡死：内层到边即被 contain 切断，外层一像素不动。
	// 只影响这一处容器：外层已有一条滚轮承载整组内容，内层再截断没有意义。
	const maxHeightStyle = maxHeight === null ? undefined : { maxHeight };
	// 不限高时仍保留横向滚动：diff 行可能很宽，去掉 overflow 会让宽行顶出组体、
	// 反而给组体套出一条横向滚动条（overflow-y:auto 会让 overflow-x 计算成 auto）。
	// 只纵轴让位——纵向轨道归外层那一条滚轮。
	const scrollClass = maxHeight === null ? "overflow-x-auto" : "scrollbar-hide overflow-auto";
	const additions = lines.filter((line) => line.type === "added").length;
	const deletions = lines.filter((line) => line.type === "removed").length;
	const canCopy = Boolean(copyText || onCopy);
	const code = lines.map((line) => line.content).join("\n");
	const tokens = useAgentCodeTokens(code, language);

	const setOpen = useCallback(
		(next: boolean) => {
			if (open === undefined) setInternalOpen(next);
			onOpenChange?.(next);
		},
		[onOpenChange, open],
	);

	useEffect(() => {
		if (previousStatus.current !== "streaming" && status === "streaming") {
			setOpen(true);
		}
		if (previousStatus.current === "streaming" && status === "complete" && collapseOnComplete) {
			setOpen(false);
		}
		previousStatus.current = status;
	}, [collapseOnComplete, setOpen, status]);

	useEffect(
		() => () => {
			if (copyTimer.current) window.clearTimeout(copyTimer.current);
		},
		[],
	);

	// 流式 diff 每个 token 都会触发渲染；只在当前帧末尾追底（且仅 code 变化时），
	// 直接赋值 scrollTop 避免连续 smooth 滚动互相取消并与外层时间线的
	// ResizeObserver 争抢布局（官方原版为无 deps 的逐渲染 smooth scroll）。
	useLayoutEffect(() => {
		const viewport = viewportRef.current;
		if (!viewport || !currentOpen || !streaming) return;

		const frame = requestAnimationFrame(() => {
			if (viewport.scrollHeight <= viewport.clientHeight) return;
			viewport.scrollTop = viewport.scrollHeight;
		});
		return () => cancelAnimationFrame(frame);
	}, [currentOpen, streaming, code]);

	const handleCopy = useCallback(async () => {
		if (onCopy) await onCopy();
		else if (copyText) await navigator.clipboard?.writeText(copyText);

		setCopied(true);
		if (copyTimer.current) window.clearTimeout(copyTimer.current);
		copyTimer.current = window.setTimeout(() => setCopied(false), 1600);
	}, [copyText, onCopy]);

	return (
		<div data-state={status} aria-busy={streaming} className={cn("w-full text-sm", className)}>
			<button
				id={triggerId}
				type="button"
				aria-expanded={currentOpen}
				aria-controls={contentId}
				onClick={() => setOpen(!currentOpen)}
				className="group flex min-h-9 w-full items-center gap-2 rounded-md py-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
			>
				<FileCode2 aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/80">{file}</span>
				<span className="flex shrink-0 items-center gap-2">
					<ChangeCount value={additions} type="added" />
					<ChangeCount value={deletions} type="removed" />
				</span>
				<span className="grid size-4 shrink-0 place-items-center text-muted-foreground/60">{streaming ? <LoaderCircle aria-label="Applying changes" className={cn("size-3.5", !reduce && "animate-pideck-spin")} /> : <Check aria-label="Changes applied" className="size-3.5" />}</span>
				<motion.span aria-hidden="true" animate={{ rotate: currentOpen ? 180 : 0 }} transition={reduce ? { duration: 0 } : SPRING_SWAP} className="shrink-0 text-muted-foreground/45 transition-colors group-hover:text-muted-foreground">
					<ChevronDown className="size-3.5" />
				</motion.span>
			</button>

			<AgentDisclosure id={contentId} role="region" aria-labelledby={triggerId} open={currentOpen} transition={animateHeight ? undefined : { duration: 0 }}>
				<div className="pl-6 pt-1.5">
					<div className="overflow-hidden rounded-xl bg-muted/80">
						<div ref={viewportRef} data-slot="file-diff-viewport" aria-live="polite" className={scrollClass} style={maxHeightStyle}>
							<div className="font-mono text-xs leading-5">
								<span className="sr-only">File changes</span>
								{lines.map((line, index) => {
									const type = line.type ?? "context";
									return (
										<div key={line.id} className={cn("grid grid-cols-[2.25rem_2.25rem_1rem_minmax(0,1fr)]", type === "added" && "bg-emerald-500/[0.07]", type === "removed" && "bg-rose-500/[0.07]")}>
											<span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">{line.oldLine}</span>
											<span className="select-none pr-2 text-right tabular-nums text-muted-foreground/40">{line.newLine}</span>
											<span className={cn("select-none text-center text-muted-foreground/45", type === "added" && "text-emerald-600 dark:text-emerald-400", type === "removed" && "text-rose-600 dark:text-rose-400")}>{type === "added" ? "+" : type === "removed" ? "−" : ""}</span>
											<AgentCodeLine code={line.content} tokens={tokens?.[index]} className="min-w-0 whitespace-pre px-1.5" />
										</div>
									);
								})}
							</div>
						</div>

						{canCopy ? (
							<div className="flex justify-end px-2 pb-1.5 pt-1">
								<motion.button
									type="button"
									aria-label={copied ? "Copied" : "Copy diff"}
									title={copied ? "Copied" : "Copy diff"}
									onClick={handleCopy}
									whileTap={reduce ? undefined : { scale: 0.9 }}
									transition={SPRING_PRESS}
									className="grid size-7 place-items-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-background/70 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
								>
									{copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
								</motion.button>
							</div>
						) : null}
					</div>
				</div>
			</AgentDisclosure>
		</div>
	);
}
