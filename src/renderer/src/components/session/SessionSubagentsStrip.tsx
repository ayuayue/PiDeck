import { useAtomValue } from "jotai";
import { useCallback, useEffect, useState } from "react";
import { Ban, Bot, ChevronDown, ChevronUp, CornerUpRight, ExternalLink, FileText, Loader2, Square, X } from "lucide-react";
import { sessionRuntimeBySessionIdAtomFamily } from "../../atoms";
import { desktopApi } from "../../desktopApi";
import { t } from "../../i18n";
import { replaceExpandedRefBlocksWithLabels } from "./composer/quoteChip";
import type { PiSubagentEntry } from "../../../../shared/types";
import { useSessionSubagents } from "../../hooks/useSessionSubagents";
import { Button } from "../ui-shadcn/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui-shadcn/dialog";
import { MarkdownStream } from "./MarkdownStream";
import { ComposerWidgetFrame, useComposerWidgetCollapsed } from "./ComposerWidgetLayout";
import { isFailureSubagentStatus, isSubagentRunLost, subagentIconKind, subagentStatusLabelSuffix } from "./subagentStatus";

/**
 * composer 上方的「子代理」常驻条（移植自 dsh-web 的 agent 状态灯）。
 *
 * 形态：与输入框同宽同列的折叠卡（36px 高：图标 + 标题 + 运行中计数 + 状态灯 + chevron），
 * 点击展开子代理列表（运行中状态灯实时刷新）。两后端兼容：
 * - pi：useSessionSubagents 三源合并（record + 桥接 widget + 工具调用推导）；
 * - DSH：listDshSubagents 轮询拉取，运行中保持 3s 刷新，全空闲停表。
 * 无任何子代理时整体不渲染（「有那个显示那个」）。
 */

/* ------------------------------------------------------------------ */
/* 状态字形与徽标                                                       */
/* ------------------------------------------------------------------ */

function CompletedGlyph() {
	return (
		<svg width={16} height={16} viewBox="-1 -1 16 16" fill="none" aria-hidden="true" className="overflow-visible text-[var(--color-success)]">
			<circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
			<path
				d="M10.9631 5.71411L7.70154 8.97571C7.48011 9.19714 7.27736 9.40099 7.09229 9.54993C6.89742 9.70669 6.66314 9.85279 6.3634 9.90027C6.2049 9.92534 6.04339 9.92534 5.88489 9.90027C5.58515 9.85279 5.35087 9.70669 5.15601 9.54993C4.97093 9.40099 4.76818 9.19714 4.54675 8.97571L3.03516 7.46411L3.96313 6.53613L5.47473 8.04773C5.7169 8.28989 5.86196 8.43389 5.97888 8.52795C6.08597 8.61409 6.10875 8.60701 6.08997 8.604C6.11259 8.60758 6.13571 8.60758 6.15833 8.604C6.13954 8.60701 6.16232 8.61409 6.26941 8.52795C6.38633 8.43389 6.53139 8.28989 6.77356 8.04773L10.0352 4.78613L10.9631 5.71411Z"
				fill="currentColor"
			/>
		</svg>
	);
}

function SubagentStatusIcon({ status }: { status: string }) {
	const kind = subagentIconKind(status);
	if (kind === "completed") return <CompletedGlyph />;
	if (kind === "active") return <Loader2 size={14} className="animate-pideck-spin text-[var(--color-accent)]" />;
	if (kind === "error") return <X size={14} className="text-[var(--color-danger)]" />;
	// 非成功终态必须可明确区分：stopped/aborted 用红色系图形，绝不允许看起来像完成/未知
	if (kind === "stopped") return <Square size={11} strokeWidth={2.5} className="text-[var(--color-danger)]" />;
	if (kind === "aborted") return <Ban size={13} className="text-[var(--color-warning)]" />;
	if (kind === "steered") return <CornerUpRight size={13} className="text-[var(--color-info)]" />;
	return <span className="flex size-3.5 items-center justify-center rounded-full border border-text-tertiary" />;
}

/** 状态徽标配色：失败类红、steered 蓝、completed 绿、运行中琥珀、其余中性。 */
function subagentStatusBadgeClass(status: string): string {
	switch (subagentIconKind(status)) {
		case "completed":
			return "bg-success/15 text-success";
		case "active":
			return "bg-warning/15 text-warning";
		case "error":
		case "stopped":
		case "aborted":
			return "border border-danger/30 bg-danger-soft text-danger";
		case "steered":
			return "bg-info/15 text-info";
		default:
			return "bg-muted text-text-secondary";
	}
}

/**
 * 时长格式化（子代理行与详情共用）。
 *
 * 必须带小时/天档位：子代理是长任务，只到分钟档会输出「3120m 0s」这种读不出来的数字
 * （用户反馈「几千分钟」）。秒级只保留在 1 分钟内，避免长任务末尾抖动。
 */
function formatDuration(ms: number): string {
	if (ms < 60000) return `${Math.round(ms / 1000)}s`;
	const totalMinutes = Math.floor(ms / 60000);
	if (totalMinutes < 60) return `${totalMinutes}m ${Math.round((ms % 60000) / 1000)}s`;
	const totalHours = Math.floor(totalMinutes / 60);
	if (totalHours < 24) return `${totalHours}h ${totalMinutes % 60}m`;
	return `${Math.floor(totalHours / 24)}d ${totalHours % 24}h`;
}

/* ------------------------------------------------------------------ */
/* Pi 子代理行                                                          */
/* ------------------------------------------------------------------ */

/** 单条 pi 子代理：点击行展开详情（描述 / 错误 / 结果预览 / 元信息 / 打开子会话）。 */
const PiSubagentEntryRow = (props: {
	entry: PiSubagentEntry;
	/** 所属会话：打开结果 Dialog 时从会话文件 record 拉取全文 */
	sessionId: string;
	onOpenChildSession?: (sessionId: string) => void;
}) => {
	const { entry } = props;
	const now = Date.now();
	// 失联判定：runner 进程已死但记录仍是 running/queued（父进程换代/被杀后
	// 永远等不到终态写盘）时，按「已停止」呈现——否则条目永远亮着「运行中」，
	// 时长还会一直涨到几千分钟。仅改展示，不回写数据。
	const lost = isSubagentRunLost(entry, now);
	const effectiveStatus = lost ? "stopped" : entry.status;
	// 失败类终态默认展开，让失败原因一眼可见；其余默认收起。
	// 本组件在 ComposerWidgetLayoutProvider 内，行级折叠走 composer 通道记忆
	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(`subagent-entry:${entry.id}`, !isFailureSubagentStatus(effectiveStatus));
	const isActive = !lost && (entry.status === "running" || entry.status === "queued");
	const [resultDialogOpen, setResultDialogOpen] = useState(false);
	// 运行中时长平滑走秒：时长是 Date.now() - startedAt 的派生值，仅靠 bridge 事件
	// 推送重渲染会"一会儿蹦一下"；运行中的行自己挂 1s 心跳，终态/卸载时清理
	const [, tickNow] = useState(0);
	useEffect(() => {
		if (!isActive) return;
		const timer = window.setInterval(() => tickNow((n) => n + 1), 1000);
		return () => window.clearInterval(timer);
	}, [isActive]);
	// 「查看完整结果」每次打开现拉 record 全文：bridge 实时预览截断 2000 字符，
	// 只有会话文件里的 record 承载全文；record 尚未落盘（刚完成的瞬间）回落
	// 到截断文本并提示。只在 Dialog 打开期间拉一次，长文本由 MarkdownStream
	// 按 block memo 渲染，容器限高滚动。
	const [fullResult, setFullResult] = useState<string | null>(null);
	useEffect(() => {
		if (!resultDialogOpen) return;
		let cancelled = false;
		desktopApi.sessions
			.listSessionSubagents(props.sessionId)
			.then((entries) => {
				if (cancelled) return;
				setFullResult(entries.find((e) => e.id === entry.id)?.result ?? null);
			})
			.catch(() => undefined);
		return () => {
			cancelled = true;
		};
	}, [resultDialogOpen, entry.id, props.sessionId]);
	const hasLongText = Boolean(entry.result || entry.error);
	const displayResult = fullResult ?? entry.result ?? undefined;
	// 失联条目也要显示已运行的时长（就是用户看到的那个「几千分钟」），
	// 所以与运行中同样取 now - startedAt，只在有 startedAt 时展示。
	const duration = entry.completedAt && entry.startedAt ? formatDuration(entry.completedAt - entry.startedAt) : entry.startedAt && (isActive || lost) ? formatDuration(now - entry.startedAt) : null;

	return (
		<li className={`rounded ${isActive ? "bg-muted/40" : ""}`}>
			<button type="button" className="flex min-w-0 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-control leading-5 transition-colors hover:bg-muted/60" aria-expanded={!collapsed} onClick={toggleCollapsed}>
				<span className="grid size-5 shrink-0 place-items-center">
					<SubagentStatusIcon status={effectiveStatus} />
				</span>
				<span className="shrink-0 font-medium text-foreground">{entry.type}</span>
				<span className="min-w-0 flex-1 truncate text-text-secondary">{entry.description}</span>
				{duration && <span className="shrink-0 tabular-nums text-text-tertiary">{duration}</span>}
				{entry.tokens != null && entry.tokens > 0 && <span className="shrink-0 tabular-nums text-xs text-text-tertiary">{entry.tokens.toLocaleString()} tk</span>}
				<ChevronDown size={13} className={`shrink-0 text-text-tertiary transition-transform ${collapsed ? "" : "rotate-180"}`} aria-hidden="true" />
			</button>
			{!collapsed && (
				<div className="flex flex-col gap-1.5 px-2 pb-2 pl-9 text-xs leading-5 text-text-secondary motion-safe:animate-in motion-safe:fade-in motion-safe:duration-fast">
					{/* 元信息行：本地化状态徽标 + 起止时间与量化指标 */}
					<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-text-tertiary">
						<span className={`rounded px-1.5 py-0.5 text-micro font-medium ${subagentStatusBadgeClass(effectiveStatus)}`}>{t(lost ? "sessionSubagents.status.lost" : `sessionSubagents.status.${subagentStatusLabelSuffix(effectiveStatus)}`)}</span>
						{entry.toolUses != null && entry.toolUses > 0 && <span>{t("sessionSubagents.detailToolUses", { count: entry.toolUses })}</span>}
						{entry.tokens != null && entry.tokens > 0 && <span>{t("sessionSubagents.detailTokens", { count: entry.tokens.toLocaleString() })}</span>}
						{entry.startedAt != null && <span>{t("sessionSubagents.detailStartedAt", { time: new Date(entry.startedAt).toLocaleTimeString() })}</span>}
						{entry.completedAt != null && <span>{t("sessionSubagents.detailCompletedAt", { time: new Date(entry.completedAt).toLocaleTimeString() })}</span>}
					</div>
					{lost && <p className="rounded border border-danger/30 bg-danger-soft px-2 py-1.5 text-danger">{t("sessionSubagents.lostHint")}</p>}
					{entry.description && <p className="whitespace-pre-wrap break-words">{entry.description}</p>}
					{entry.error && <div className="whitespace-pre-wrap break-words rounded border border-danger/30 bg-danger-soft px-2 py-1.5 text-danger">{entry.error}</div>}
					{entry.result && <div className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/50 px-2 py-1.5">{entry.result}</div>}
					{(entry.childSessionId || hasLongText) && (
						<div className="flex flex-wrap items-center gap-2 pt-0.5">
							{entry.childSessionId && props.onOpenChildSession && (
								<Button variant="outline" size="sm" className="h-6 gap-1 px-2 text-xs text-text-secondary hover:text-foreground" onClick={() => props.onOpenChildSession?.(entry.childSessionId ?? "")}>
									<ExternalLink size={12} />
									{t("sessionSubagents.openChildSession")}
								</Button>
							)}
							{hasLongText && (
								<Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-xs text-text-secondary hover:text-foreground" onClick={() => setResultDialogOpen(true)}>
									<FileText size={12} />
									{t("sessionSubagents.viewFullResult")}
								</Button>
							)}
						</div>
					)}
				</div>
			)}
			{/* 完整结果 Dialog：长结果/无子会话文件时的完整终态文本与元信息 */}
			{hasLongText && (
				<Dialog open={resultDialogOpen} onOpenChange={setResultDialogOpen}>
					<DialogContent className="max-w-2xl">
						<DialogHeader>
							<DialogTitle>{t("sessionSubagents.dialogTitle", { type: entry.type })}</DialogTitle>
						</DialogHeader>
						<div className="flex max-h-[60vh] flex-col gap-2 overflow-y-auto overscroll-contain">
							<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-tertiary">
								<span className={`rounded px-1.5 py-0.5 text-micro font-medium ${subagentStatusBadgeClass(entry.status)}`}>{t(`sessionSubagents.status.${subagentStatusLabelSuffix(entry.status)}`)}</span>
								{entry.toolUses != null && entry.toolUses > 0 && <span>{t("sessionSubagents.detailToolUses", { count: entry.toolUses })}</span>}
								{entry.tokens != null && entry.tokens > 0 && <span>{t("sessionSubagents.detailTokens", { count: entry.tokens.toLocaleString() })}</span>}
								{entry.startedAt != null && <span>{t("sessionSubagents.detailStartedAt", { time: new Date(entry.startedAt).toLocaleTimeString() })}</span>}
								{entry.completedAt != null && <span>{t("sessionSubagents.detailCompletedAt", { time: new Date(entry.completedAt).toLocaleTimeString() })}</span>}
							</div>
							{entry.description && <p className="whitespace-pre-wrap break-words text-xs text-text-secondary">{entry.description}</p>}
							{entry.error && <div className="whitespace-pre-wrap break-words rounded border border-danger/30 bg-danger-soft px-2 py-1.5 text-xs text-danger">{entry.error}</div>}
							{displayResult && (
								// 完整结果按 Markdown 渲染：子代理返回普遍是 md 文本，与会话正文
								// /FileDiffViewer 预览共用同一 Streamdown 引擎（code/mermaid/math）。
								// 优先 record 全文（fullResult），record 未落盘时回落 bridge 截断预览
								<div className="markdown-body break-words rounded bg-muted/50 px-3 py-2 text-xs text-text-secondary">
									<MarkdownStream text={displayResult} onOpenExternal={() => undefined} />
								</div>
							)}
							{!fullResult && entry.source === "bridge" && entry.result && entry.result.length >= 2000 && <p className="text-micro text-text-tertiary">{t("sessionSubagents.fullResultPending")}</p>}
						</div>
					</DialogContent>
				</Dialog>
			)}
		</li>
	);
};

/* ------------------------------------------------------------------ */
/* DSH 子代理                                                           */
/* ------------------------------------------------------------------ */

type DshSubagentEntry = {
	id: string;
	label?: string;
	activity: "running" | "inactive";
	hasChildren: boolean;
	mode: "one-shot" | "continuable";
	kind: "child" | "diagnostic";
};

/**
 * DSH 子代理轮询：挂载拉一次；有运行中的子代理时保持 3s 刷新（状态灯实时），
 * 全空闲停表，避免空转 IPC。与 DshAgentToolsPanel 的静态拉取相比，横栏需要
 * 跟随子代理生命周期展示「运行中」状态。
 */
function useDshSubagents(agentId: string | undefined): DshSubagentEntry[] {
	const [entries, setEntries] = useState<DshSubagentEntry[]>([]);
	useEffect(() => {
		if (!agentId) return;
		let cancelled = false;
		let timer = 0;
		const load = async () => {
			const items = await desktopApi.sessions.listDshSubagents(agentId).catch(() => [] as DshSubagentEntry[]);
			if (cancelled) return;
			setEntries(items);
			// 运行中才保持轮询；全空闲停表（load 自身可被 interval 复用，注意
			// timer 判 0 避免重复起表）
			const hasRunning = items.some((e) => e.activity === "running");
			if (hasRunning && timer === 0) {
				timer = window.setInterval(load, 3000);
			} else if (!hasRunning && timer !== 0) {
				window.clearInterval(timer);
				timer = 0;
			}
		};
		void load();
		return () => {
			cancelled = true;
			if (timer) window.clearInterval(timer);
		};
	}, [agentId]);
	return entries;
}

/** 单条 DSH 子代理：点击行展开只读 transcript（readDshSubagentHistory）。 */
const DshSubagentEntryRow = (props: { agentId: string; entry: DshSubagentEntry }) => {
	const { entry } = props;
	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(`dsh-subagent:${entry.id}`, true);
	const [transcript, setTranscript] = useState<Array<{ role: string; text: string }> | null>(null);
	const [transcriptLoading, setTranscriptLoading] = useState(false);
	const [transcriptError, setTranscriptError] = useState(false);

	const toggle = useCallback(async () => {
		if (!collapsed) {
			toggleCollapsed();
			return;
		}
		// 展开前现拉 transcript：与工具面板一致，避免先展开再补数据造成跳动
		setTranscriptLoading(true);
		setTranscriptError(false);
		const page = await desktopApi.sessions.readDshSubagentHistory(props.agentId, entry.id).catch(() => null);
		setTranscriptLoading(false);
		if (page) {
			setTranscript(
				page.messages.map((message) => ({
					role: message.role,
					// 转录是纯文本出口：折叠自包含引用块，避免露出 <quoted_context> 等 XML 原文。
					text: replaceExpandedRefBlocksWithLabels(message.text),
				})),
			);
		} else {
			setTranscriptError(true);
		}
		toggleCollapsed();
	}, [collapsed, entry.id, props.agentId, toggleCollapsed]);

	return (
		<li className="rounded hover:bg-muted/40">
			<button type="button" className="flex min-w-0 w-full items-center gap-2 rounded px-2 py-1.5 text-left text-control leading-5 transition-colors hover:bg-muted/60" aria-expanded={!collapsed} onClick={() => void toggle()}>
				<span className="grid size-5 shrink-0 place-items-center">{entry.activity === "running" ? <Loader2 size={14} className="animate-pideck-spin text-[var(--color-accent)]" /> : <span className="size-2 rounded-full bg-muted-foreground/60" aria-hidden="true" />}</span>
				<span className="min-w-0 flex-1 truncate font-medium text-foreground">{entry.label ?? entry.id}</span>
				{entry.activity === "running" && (
					<span className="inline-flex shrink-0 items-center gap-1 rounded bg-primary/15 px-1.5 py-0.5 text-micro font-medium text-primary">
						<Loader2 size={11} className="animate-pideck-spin" aria-hidden="true" />
						{t("dshTools.subagentRunning")}
					</span>
				)}
				{entry.kind === "diagnostic" && <span className="shrink-0 inline-flex items-center rounded bg-amber-500/15 px-1.5 py-0.5 text-micro font-medium text-amber-600 dark:text-amber-400">{t("dshTools.subagentDiagnostic")}</span>}
				<span className="shrink-0 text-micro text-text-tertiary">{entry.mode === "continuable" ? t("dshTools.subagentContinuable") : t("dshTools.subagentOneShot")}</span>
				<ChevronDown size={13} className={`shrink-0 text-text-tertiary transition-transform ${collapsed ? "" : "rotate-180"}`} aria-hidden="true" />
			</button>
			{!collapsed && (
				<div className="flex max-h-56 flex-col gap-1 overflow-y-auto border-t border-border-subtle px-2 py-1.5">
					{transcriptLoading && (
						<p className="flex items-center gap-1.5 px-1 text-xs text-text-tertiary">
							<Loader2 size={13} className="animate-pideck-spin" aria-hidden="true" />
							{t("dshTools.loading")}
						</p>
					)}
					{!transcriptLoading && transcriptError && <p className="px-1 text-xs text-[var(--color-danger)]">{t("dshTools.subagentTranscriptError")}</p>}
					{!transcriptLoading && !transcriptError && (transcript?.length ?? 0) === 0 && <p className="px-1 text-xs text-text-tertiary">{t("dshTools.subagentTranscriptEmpty")}</p>}
					{!transcriptLoading &&
						transcript?.map((message, index) => (
							<div key={index} className={`flex flex-col gap-0.5 rounded-md px-2 py-1 ${message.role === "user" ? "bg-accent/30" : "bg-bg-panel"}`}>
								<span className="text-micro text-text-tertiary">{message.role === "user" ? t("dshTools.roleUser") : t("dshTools.roleAssistant")}</span>
								<span className="whitespace-pre-wrap break-words text-xs text-foreground">{message.text || "…"}</span>
							</div>
						))}
				</div>
			)}
		</li>
	);
};

/* ------------------------------------------------------------------ */
/* 横栏本体                                                             */
/* ------------------------------------------------------------------ */

export function SessionSubagentsStrip(props: {
	sessionId: string;
	/** 打开子会话只读视图（SessionView 透传 openSidebarSessionById 通路） */
	onOpenChildSession?: (sessionId: string) => void;
}) {
	const runtime = useAtomValue(sessionRuntimeBySessionIdAtomFamily(props.sessionId));
	const isDsh = runtime?.backend === "dsh";
	const agentId = runtime?.agentId;

	const { collapsed, toggleCollapsed } = useComposerWidgetCollapsed(`subagents:${props.sessionId}`, true);

	// pi：三源合并；DSH：轮询。两条数据通道只取其一，渲染层不区分后端
	const piSubs = useSessionSubagents(props.sessionId);
	const dshEntries = useDshSubagents(isDsh ? agentId : undefined);
	const entries = isDsh ? dshEntries : piSubs.entries;
	const running = isDsh ? dshEntries.filter((e) => e.activity === "running").length : piSubs.entries.filter((e) => e.status === "running" || e.status === "queued").length;
	// acp_delegate（billion-context）委托条目无子会话文件与完整结果文本，展开时提示产出位置
	const hasAcpEntries = !isDsh && piSubs.entries.some((e) => e.via === "acp-delegate");

	// 无子代理：不渲染（「有那个显示那个」）。pi 空态细分（插件未装等）在展开
	// 列表内用现有文案表达，折叠卡本身不常显空条
	if (entries.length === 0) return null;

	return (
		<ComposerWidgetFrame data-testid="session-subagents-strip" aria-label={t("sessionSubagents.title")}>
			<div className="flex h-9 w-full items-center gap-2.5 px-3">
				<button type="button" className="flex min-w-0 flex-1 items-center gap-2.5 text-left" aria-expanded={!collapsed} onClick={toggleCollapsed}>
					<Bot size={14} aria-hidden="true" className="shrink-0 text-text-tertiary" />
					<span className="shrink-0 text-control font-medium leading-6 text-foreground">{t("sessionSubagents.title")}</span>
					{/* 运行中计数徽标 + 状态灯：dsh-web 的 agent 状态灯语义 */}
					{running > 0 && (
						<span className="inline-flex shrink-0 items-center gap-1.5 rounded bg-warning/15 px-1.5 py-0.5 text-micro leading-none font-medium text-warning">
							<span className="size-1.5 rounded-full bg-current animate-pulse" aria-hidden="true" />
							{running}
						</span>
					)}
					<span className="min-w-0 flex-1" />
					<span className="shrink-0 text-text-tertiary" aria-hidden="true">
						{collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
					</span>
				</button>
			</div>
			{!collapsed && (
				<>
					<ul className="mb-2 flex max-h-[240px] flex-col gap-1 overflow-y-auto [contain:layout_paint] [scrollbar-gutter:stable] px-3 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-100 motion-reduce:animate-none">
						{isDsh ? (entries as DshSubagentEntry[]).map((entry) => <DshSubagentEntryRow key={entry.id} agentId={agentId ?? ""} entry={entry} />) : entries.map((entry) => <PiSubagentEntryRow key={entry.id} entry={entry as PiSubagentEntry} sessionId={props.sessionId} onOpenChildSession={props.onOpenChildSession} />)}
					</ul>
					{hasAcpEntries && <p className="-mt-1 px-3 pb-2 text-micro leading-4 text-text-tertiary">{t("sessionSubagents.acpDelegateHint")}</p>}
				</>
			)}
		</ComposerWidgetFrame>
	);
}
