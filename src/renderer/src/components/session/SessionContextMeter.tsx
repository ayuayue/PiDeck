import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FoldVertical } from "lucide-react";
import { useSetAtom } from "jotai";
import { t } from "../../i18n";
import type { AgentRuntimeState } from "../../../../shared/types";
import type { UsageProbeBackend } from "../../../../shared/types/providerUsage";
import { compactUiState, resolveCompactUsagePercent } from "../../../../shared/compactFeedback";
import { openSettingsAtom } from "../../atoms/app-ui-atoms";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui-shadcn/tooltip";
import { ProviderUsageDetails } from "../app/ProviderUsageDetails";
import { buildSessionStatusDetail } from "./SurfaceComponents";
import { formatPercent } from "./TimelineFormat";

/**
 * composer 发送按钮旁的上下文占用圆环（移植自 dsh-web ContextMeter）。
 *
 * 形态：14px 圆环（2px 描边，strokeDasharray 按占用比例填充，从 12 点方向起笔），
 * 28px 圆形点击区；点击弹出占用面板：
 * - 标题「上下文已用 45%」+ ~used/window 数字 + 4px 占用条；
 * - 两段占比图例「对话 / 系统 + 工具」：pi 不返回 prompt 构成，对话按会话文件
 *   消息字符 ÷ 4 估算（contextMessageTokens，主进程算好），系统+工具为反推值
 *   （contextTokens − 对话），缺估算数据时退化单段条（dsh 自身 breakdown 也是
 *   heuristic，缺失时回退成单段 total）；
 * - 完整会话详情：复用会话头部 SessionStatus 的明细构建器（buildSessionStatusDetail），
 *   包含上下文/输入输出/缓存读写/命中率/费用，以及「最近一次回复」的性能组
 *   （TTFT 首字、总耗时、tps）——圆环面板与会话头部共用同一份明细，语义一致；
 * - 压缩上下文按钮：从原右上角紧凑徽章移入面板。占用未达
 *   COMPACT_READY_PERCENT（30%）时禁用并说明「未到建议门槛」，避免空 RPC；
 *   达标后可点，urgency 色阶 ≥90 红 / ≥70 黄；压缩中禁用并显示进度态。
 *
 * 边界：
 * - 圆环常驻：percent 或 window 缺失（会话未运行/模型切换瞬间）时渲染 0% 占位环，
 *   面板内容降级为「上下文数据暂不可用」，不再整环隐藏。
 * - 命中率/输入输出行按数据存在性渲染，缺字段不占位。
 */

/** 圆环几何：14px viewBox、2px 描边（dsh 逐字节移植）。 */
const RADIUS = 5.5;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** 两段图例色：对话=蓝、系统+工具=紫（dsh ROWS 的 messages/tools 色系）。 */
const COLOR_CONVERSATION = "var(--color-context-conversation, #2563eb)";
const COLOR_SYSTEM_TOOLS = "var(--color-context-system-tools, rgb(167, 139, 250))";
/** host contextBreakdown 三段图例色（dsh-web ROWS 色系）：系统=蓝灰、工具=紫、对话=蓝。 */
const COLOR_SYSTEM = "var(--color-context-system, #94a3b8)";
const COLOR_TOOLS = "var(--color-context-tools, rgb(167, 139, 250))";

/** 弹出面板宽度：原 264px 对「输入/输出 tokens / 命中率快照」过窄会折行；
 *  320 仍贴 composer 不挡主栏。style.width 与定位回退必须用同一常量，
 *  避免首帧 offsetWidth=0 时按旧宽度错位。 */
const PANEL_WIDTH = 320;

/** token 数紧凑格式化（dsh StatsLine 同款）：<1K 原样，<1M 用 K，之后用 M；
 *  ≥100 取整，其余保留一位小数。 */
export function formatTokens(n: number): string {
	const scaled = (v: number): string =>
		v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
	if (n < 1_000) return String(n);
	if (n < 1_000_000) return `${scaled(n / 1_000)}K`;
	return `${scaled(n / 1_000_000)}M`;
}

/** 币种代码 → 常用符号（未知代码原样展示，避免硬编码映射丢失币种）。 */
function currencySymbol(code?: string): string {
	switch ((code ?? "").toUpperCase()) {
		case "CNY":
		case "RMB":
			return "¥";
		case "USD":
			return "$";
		case "EUR":
			return "€";
		case "GBP":
			return "£";
		default:
			return (code ?? "").trim();
	}
}

/** 金额/点数格式化：最多两位小数，整数不显示小数点。 */
function formatAmount(n: number): string {
	const rounded = Math.round(n * 100) / 100;
	return Number.isInteger(rounded) ? String(rounded) : String(rounded);
}

/** 余额展示：有符号用「¥110」，无符号用「110 CNY」，无币种只用数字。 */
function formatBalance(balance: { value: number; currency?: string }): string {
	const symbol = currencySymbol(balance.currency);
	const amount = formatAmount(balance.value);
	if (symbol) return `${symbol}${amount}`;
	if (balance.currency) return `${amount} ${balance.currency}`;
	return amount;
}

/** 由 runtime 状态计算占用（dsh contextOccupancy 同款语义）：
 *  缺任一字段视为无 capacity（null）；percent 保留原始精度、不封顶 100
 *  （pi/dsh 可上报 >100%，如缓存超窗；pi CLI footer 同口径显示原始值）。
 *  当上报 percent ≤ 0 而 tokens 非 0（pi/dsh 取整成 0 或尚未随 tokens 刷新）时，
 *  按 tokens/window 重算，避免「占用 0% 但 ~408 / 1M」这类自相矛盾的展示。 */
export function contextOccupancy(
	state: Pick<AgentRuntimeState, "contextPercent" | "contextTokens" | "contextWindow"> | undefined,
): { percent: number; usedTokens?: number; contextWindow?: number } | null {
	const usedTokens = state?.contextTokens ?? undefined;
	const contextWindow = state?.contextWindow ?? undefined;
	// 百分比与 /compact 共用 resolveCompactUsagePercent，避免圆环和斜杠门槛分叉。
	const percent = resolveCompactUsagePercent(state);
	if (percent == null || contextWindow == null) return null;
	return {
		percent,
		usedTokens,
		contextWindow,
	};
}

/** 占用构成：
 *  - breakdown：host contextBreakdown 投影（dsh），系统/工具/对话三段直接可用（0 也是有效值）；
 *  - estimate：无投影时的反推两段（对话 = 消息估算，系统+工具 = total − 对话，pi 路径）。
 *  返回 null 表示无估算数据（渲染单段条）。 */
export type ContextSegments =
	| { kind: "breakdown"; system: number; tools: number; conversation: number }
	| { kind: "estimate"; conversation: number; systemTools: number };

export function contextSegments(
	state: Pick<
		AgentRuntimeState,
		"contextTokens" | "contextMessageTokens" | "contextSystemTokens" | "contextToolsTokens"
	> | undefined,
): ContextSegments | null {
	// DSH host contextBreakdown 投影优先：三段数值就是 token-meter 的构成估算（dsh-web 同源）
	if (state?.contextSystemTokens != null && state?.contextToolsTokens != null) {
		return {
			kind: "breakdown",
			system: state.contextSystemTokens,
			tools: state.contextToolsTokens,
			conversation: state.contextMessageTokens ?? 0,
		};
	}
	const total = state?.contextTokens;
	const messageTokens = state?.contextMessageTokens;
	if (total == null || total <= 0 || messageTokens == null || messageTokens <= 0) return null;
	const conversation = Math.min(messageTokens, total);
	return { kind: "estimate", conversation, systemTools: Math.max(0, total - conversation) };
}

export function SessionContextMeter(props: {
	state?: Pick<
		AgentRuntimeState,
		| "contextPercent" | "contextTokens" | "contextWindow"
		| "contextMessageTokens"
		| "cacheHitPercent" | "cacheHitAveragePercent" | "cacheHitSampleCount"
		| "inputTokens" | "outputTokens" | "isCompacting"
		| "cost" | "ttftMs" | "totalMs" | "tps"
		| "cacheRead" | "cacheWrite" | "cacheTotal"
		| "provider"
	>;
	/** 压缩上下文（原右上角紧凑徽章动作，迁入面板底部） */
	onCompact?: () => void;
	/**
	 * 运行时缺省时的 provider 兜底（由会话记录/默认 model 推导）：用量查询只依赖
	 * provider 配置解析端点、不依赖 agent 运行，未激活/未启动会话也可查用量。
	 */
	fallbackProvider?: string;
	/**
	 * 用量查询链路：DSH 会话传 "dsh"（$DSH_HOME 配置 + DSH 凭据库），缺省 pi。
	 * 圆球面板与 pi/DSH 各自的 usage-probes.json 同链查询——DSH 侧配的探针
	 * 不会因误走 pi 链路而查不到（pi/DSH 配置目录与凭据互不相通）。
	 */
	backend?: UsageProbeBackend;
}) {
	const [open, setOpen] = useState(false);
	const rootRef = useRef<HTMLSpanElement | null>(null);
	/** 面板 fixed 定位：相对 viewport 的 {left, top}；null = 尚未定位（首帧隐藏） */
	const [placement, setPlacement] = useState<{ left: number; top: number } | null>(null);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const panelRef = useRef<HTMLDivElement | null>(null);
	const context = contextOccupancy(props.state);
	const available = context !== null;
	const segments = contextSegments(props.state);
	const compacting = props.state?.isCompacting === true;
	// 完整详情复用会话头部 SessionStatus 的构建器：平均命中率以主进程
	// 文件统计为准（缓存快照历史均值仅作降级，头部同款语义）
	const detail = buildSessionStatusDetail(
		props.state,
		props.state?.cacheHitAveragePercent ?? undefined,
		props.state?.cacheHitSampleCount ?? 0,
	);
	// 输入/输出 token 与最新缓存命中率已常驻输入框下方（ComposerStatsLine），
	// 圆环面板不再重复这两行；会话头部（SessionStatus）共用同一构建器不受影响。
	const panelDetailRows = detail.detailRows.filter(
		(row) => row.label !== t("ctx.detail.tokens") && row.label !== t("ctx.detail.hitLatest"),
	);

	// ── 面板内 provider 用量/余额区块 ─────────────────────────────
	// 数据源与展示统一收敛到 ProviderUsageDetails（模型卡片/选择器徽标同一份
	// provider-usage-atoms 缓存，本组件只决定「是否渲染」与「失败跳转」）。
	// 用量查询不依赖 agent 运行：未激活/未启动会话用会话记录/默认 model 推导的
	// provider 兜底（ComposerComponents 已按 liveState → record → defaultModel 顺序解析）。
	const provider = props.state?.provider?.trim() || props.fallbackProvider?.trim() || undefined;
	const openModelsSettings = useSetAtom(openSettingsAtom);
	// 查不到用量 → 一键跳「设置 → 配置管理 → 模型」并定位该供应商（唯一配置入口）。
	const onConfigureUsage = useCallback(() => {
		if (!provider) return;
		openModelsSettings({ tab: "common", pane: "config", configTab: "models", provider });
	}, [provider, openModelsSettings]);
	// 有 provider 名才渲染用量区块。
	const showUsage = provider != null;

	// 圆环常驻：无 capacity 时也渲染占位环，不再因模型切换瞬间关闭面板
	// （原：不渲染过期面板；用户要求非激活会话也常驻圆环）。

	// 面板定位：fixed 相对 viewport（portal 到 body，脱离 composer 的 overflow 裁剪）。
	// 向上弹出（面板底边贴 trigger 顶），顶部空间不足时翻转到 trigger 下方；
	// 面板内容高度随数据变化，每次打开/内容变化都重新测量（首帧 hidden 定位）。
	// 抽成 useCallback 供打开/数据变化（layout effect）与滚动/resize（scroll 监听）
	// 两条路径复用——滚动时保持面板贴 trigger 而不是关闭。
	const positionPanel = useCallback(() => {
		const trigger = triggerRef.current;
		const panel = panelRef.current;
		if (!trigger || !panel) return;
		const rect = trigger.getBoundingClientRect();
		const panelWidth = panel.offsetWidth || PANEL_WIDTH;
		const panelHeight = panel.offsetHeight;
		const left = Math.max(8, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 8));
		let top = rect.top - 8 - panelHeight;
		if (top < 8) top = rect.bottom + 8; // 上方放不下：翻转到 trigger 下方
		// 位置未变不重复 setState：流式渲染追底滚动期间每帧都有 scroll 事件，
		// trigger 固定在底部栏（不随消息滚动），位置不变时避免每帧 re-render
		setPlacement((prev) =>
			prev !== null && prev.left === left && prev.top === top ? prev : { left, top },
		);
	}, []);

	useLayoutEffect(() => {
		if (!open) return;
		positionPanel();
		// 依赖只用原始值（对象引用每次渲染都变，会导致定位循环）：
		// 数据更新（占用/费用/压缩态变化）或尺寸变化时重新测量定位
	}, [open, context?.percent, context?.usedTokens, context?.contextWindow, props.state?.cost, props.state?.cacheHitPercent, props.state?.cacheHitAveragePercent, props.state?.isCompacting, positionPanel]);

	// 外点 / Escape 关闭（open 期间挂一个 document 监听，dsh Menu 同款模式）
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (e: PointerEvent): void => {
			const inside =
				e.target instanceof Node &&
				(rootRef.current?.contains(e.target) === true ||
					panelRef.current?.contains(e.target) === true);
			if (inside) return;
			setOpen(false);
		};
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	// fixed 面板本身不随滚动移动，滚动/resize 会导致 trigger 相对 viewport 变化：
	// 重新锚定面板到 trigger 当前位置而不是关闭——流式渲染追底滚动（弹簧/instant
	// 跳转）期间面板保持打开且贴 trigger，不再「点开就关」（2026-08 用户反馈）。
	// 外点 / Escape 仍是关闭面板的唯一途径。
	useEffect(() => {
		if (!open) return;
		let raf = 0;
		const reanchor = (): void => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(positionPanel);
		};
		window.addEventListener("scroll", reanchor, true);
		window.addEventListener("resize", reanchor);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("scroll", reanchor, true);
			window.removeEventListener("resize", reanchor);
		};
	}, [open, positionPanel]);

	// 无 capacity 数据（会话未运行/模型切换瞬间）也渲染占位环：0% 空环 +「暂不可用」提示，
	// 保证底部栏圆环常驻。contextOccupancy 语义不变（仍返回 null 供面板内部判断）。
	const percent = context?.percent ?? 0;
	// 低占用保留有效数字（1M 窗口下 408 tokens ≈ 0.04%，不显示成「0%」）
	const reading = context !== null
		? t("sessionContext.used", { percent: formatPercent(percent) })
		: t("sessionContext.unavailable");
	const figures =
		context !== null && [context.usedTokens, context.contextWindow].every((v) => v != null)
			? `~${formatTokens(context.usedTokens!)} / ${formatTokens(context.contextWindow!)}`
			: undefined;
	// host contextBreakdown 三段占用条（dsh-web 同宽算法：各自占 breakdownTotal 份额 × percent）
	const breakdownSegments = segments?.kind === "breakdown"
		? (() => {
			const breakdownTotal = segments.system + segments.tools + segments.conversation;
			if (breakdownTotal <= 0) return [];
			const parts = [
				{ key: "system", tokens: segments.system, color: COLOR_SYSTEM },
				{ key: "tools", tokens: segments.tools, color: COLOR_TOOLS },
				{ key: "conversation", tokens: segments.conversation, color: COLOR_CONVERSATION },
			];
			return parts
				.filter((part) => part.tokens > 0)
				.map((part) => ({ key: part.key, color: part.color, width: Math.min(100, (percent * part.tokens) / breakdownTotal) }));
		})()
		: undefined;
	const showCompact = props.onCompact !== undefined;
	// 压缩按钮态走共享策略：未达 30% 禁用（点了也不会发 RPC）；压缩中禁用。
	const compactUi = compactUiState(percent, compacting);
	const compactDisabled = compactUi.compacting || !compactUi.ready;
	const compactUrgency =
		compactUi.urgency === "danger" ? "text-destructive border-destructive/40 hover:bg-destructive/10" :
		compactUi.urgency === "warn" ? "text-amber-500 border-amber-500/40 hover:bg-amber-500/10" :
		"border-border hover:bg-muted/60";

	return (
		<span ref={rootRef} className="relative inline-flex" data-testid="session-context-meter">
			<Tooltip>
				<TooltipTrigger asChild>
					<button
						ref={triggerRef}
						type="button"
						className="grid size-7 flex-none place-items-center rounded-full text-text-tertiary transition-colors hover:bg-muted/60"
						aria-label={reading}
						aria-haspopup="dialog"
						aria-expanded={open}
						onClick={() => { setOpen((value) => !value); }}
					>
						<svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
							<circle
								className="fill-none stroke-[var(--color-border)]"
								cx="7" cy="7" r={RADIUS} strokeWidth={2}
							/>
							<circle
								className="fill-none stroke-[var(--color-text-tertiary)] [stroke-linecap:round]"
								cx="7" cy="7" r={RADIUS} strokeWidth={2}
								strokeDasharray={`${CIRCUMFERENCE * percent / 100} ${CIRCUMFERENCE}`}
								transform="rotate(-90 7 7)"
							/>
						</svg>
					</button>
				</TooltipTrigger>
				<TooltipContent>{reading}</TooltipContent>
			</Tooltip>
			{open &&
				createPortal(
					<div
						ref={panelRef}
						role="dialog"
						aria-label={reading}
						className="fixed z-[100] cursor-default rounded-xl border border-border bg-popover p-3 text-xs leading-5 text-text-secondary shadow-lg"
						style={{
							left: placement?.left,
							top: placement?.top,
							width: PANEL_WIDTH,
							visibility: placement === null ? "hidden" : "visible",
						}}
					>
					<div className="flex items-center gap-1.5">
						<span className="text-text-tertiary">{reading}</span>
						{available && figures !== undefined && (
							<span className="ml-auto font-medium tabular-nums text-foreground">
								{figures}
							</span>
						)}
					</div>
					<div className="mt-2.5 h-1 overflow-hidden rounded-full bg-muted">
						{segments === null ? (
							// 无估算数据：单段总占用条（dsh breakdown 缺失时的退化路径）
							<div
								className="h-full rounded-full bg-text-tertiary"
								style={{ width: `${percent}%` }}
							/>
						) : segments.kind === "breakdown" ? (
							// host contextBreakdown 三段（dsh-web 同宽算法：各自占 breakdownTotal 份额 × percent）
							<div className="flex h-full overflow-hidden rounded-full">
								{breakdownSegments?.map((part) => (
									<div
										key={part.key}
										className="h-full"
										style={{ width: `${part.width}%`, backgroundColor: part.color }}
									/>
								))}
							</div>
						) : (
							// 两段：对话（蓝）在前、系统+工具（紫）在后，宽度按占 contextTokens 比例
							<div className="flex h-full overflow-hidden rounded-full">
								<div
									className="h-full"
									style={{
										width: `${Math.min(100, (segments.conversation / (context?.contextWindow ?? 1)) * 100)}%`,
										backgroundColor: COLOR_CONVERSATION,
									}}
								/>
								<div
									className="h-full"
									style={{
										width: `${Math.min(100, (segments.systemTools / (context?.contextWindow ?? 1)) * 100)}%`,
										backgroundColor: COLOR_SYSTEM_TOOLS,
									}}
								/>
							</div>
						)}
					</div>
					{available && segments !== null && (
						<div className="mt-2 space-y-0.5">
							{segments.kind === "breakdown" ? (
								// host breakdown 三段图例（dsh-web ROWS 同序）：系统 / 工具 / 对话
								<>
									<div className="flex items-center gap-1.5">
										<span
											className="size-2 flex-none rounded-[2px]"
											style={{ backgroundColor: COLOR_SYSTEM }}
										/>
										<span>{t("sessionContext.system")}</span>
										<span className="ml-auto tabular-nums text-text-tertiary">
											~{formatTokens(segments.system)}
										</span>
									</div>
									<div className="flex items-center gap-1.5">
										<span
											className="size-2 flex-none rounded-[2px]"
											style={{ backgroundColor: COLOR_TOOLS }}
										/>
										<span>{t("sessionContext.tools")}</span>
										<span className="ml-auto tabular-nums text-text-tertiary">
											~{formatTokens(segments.tools)}
										</span>
									</div>
									<div className="flex items-center gap-1.5">
										<span
											className="size-2 flex-none rounded-[2px]"
											style={{ backgroundColor: COLOR_CONVERSATION }}
										/>
										<span>{t("sessionContext.conversation")}</span>
										<span className="ml-auto tabular-nums text-text-tertiary">
											~{formatTokens(segments.conversation)}
										</span>
									</div>
								</>
							) : (
								<>
									<div className="flex items-center gap-1.5">
										<span
											className="size-2 flex-none rounded-[2px]"
											style={{ backgroundColor: COLOR_CONVERSATION }}
										/>
										<span>{t("sessionContext.conversation")}</span>
										<span className="ml-auto tabular-nums text-text-tertiary">
											~{formatTokens(segments.conversation)}
										</span>
									</div>
									<div className="flex items-center gap-1.5">
										<span
											className="size-2 flex-none rounded-[2px]"
											style={{ backgroundColor: COLOR_SYSTEM_TOOLS }}
										/>
										<span>{t("sessionContext.systemTools")}</span>
										<span className="ml-auto tabular-nums text-text-tertiary">
											~{formatTokens(segments.systemTools)}
										</span>
									</div>
								</>
							)}
						</div>
					)}
					{(panelDetailRows.length > 0 || detail.replyPerfRows.length > 0 || detail.sessionStatRows.length > 0) && (
						<div className="mt-2 space-y-0.5 border-t border-border pt-2">
							{panelDetailRows.map((row) => (
								<div
									key={row.label}
									className={`flex items-baseline justify-between gap-4 px-0.5 py-0.5 text-caption leading-5${row.emphasis ? " mt-1 border-t border-border/70 pt-1.5" : ""}`}
								>
									<span className="shrink-0 text-text-secondary">{row.label}</span>
									<span className="min-w-0 whitespace-nowrap text-right font-mono font-semibold tabular-nums text-foreground">{row.value}</span>
								</div>
							))}
						</div>
					)}
					{detail.replyPerfRows.length > 0 && (
						<div className="mt-2.5 space-y-0.5 border-t border-border pt-2">
							<div className="px-0.5 text-micro font-semibold uppercase tracking-wide text-text-tertiary">
								{t("ctx.detail.lastReply")}
							</div>
							{detail.replyPerfRows.map((row) => (
								<div
									key={row.label}
									className="flex items-baseline justify-between gap-4 px-0.5 py-0.5 text-caption leading-5"
								>
									<span className="shrink-0 text-text-secondary">{row.label}</span>
									<span className="min-w-0 whitespace-nowrap text-right font-mono font-semibold tabular-nums text-foreground">{row.value}</span>
								</div>
							))}
						</div>
					)}
					{detail.sessionStatRows.length > 0 && (
						<div className="mt-2.5 space-y-0.5 border-t border-border pt-2">
							<div className="px-0.5 text-micro font-semibold uppercase tracking-wide text-text-tertiary">
								{t("ctx.detail.sessionStats")}
							</div>
							{detail.sessionStatRows.map((row) => (
								<div
									key={row.label}
									className="flex items-baseline justify-between gap-4 px-0.5 py-0.5 text-caption leading-5"
								>
									<span className="shrink-0 text-text-secondary">{row.label}</span>
									<span className="min-w-0 whitespace-nowrap text-right font-mono font-semibold tabular-nums text-foreground">{row.value}</span>
								</div>
							))}
						</div>
					)}
					{provider && showUsage && (
						// 用量区块：与模型卡片/选择器徽标共享 ProviderUsageDetails（同数据源同视觉）；
						// backend 按会话后端透传（DSH 会话走 dsh 链路，pi 会话走 pi 链路）；
						// 失败态「配置用量查询」按钮跳设置模型页并定位供应商。
						<div className="mt-2.5" data-testid="session-context-usage">
							<ProviderUsageDetails provider={provider} backend={props.backend} onConfigureUsage={onConfigureUsage} />
						</div>
					)}
					{showCompact && (
						<button
							type="button"
							data-testid="session-context-compact"
							disabled={compactDisabled}
							title={
								compactUi.compacting
									? t("sessionContext.compacting")
									: compactUi.ready
										? t("sessionContext.compact")
										: t("sessionContext.compactNotReadyHint")
							}
							onClick={props.onCompact}
							className={`mt-2 flex h-7 w-full items-center justify-center gap-1.5 rounded-md border bg-transparent text-xs font-medium transition-colors disabled:cursor-default disabled:opacity-60 ${compactUrgency}`}
						>
							<FoldVertical
								size={13}
								className={compactUi.compacting ? "animate-pideck-spin" : undefined}
							/>
							{compactUi.compacting
								? t("sessionContext.compacting")
								: compactUi.ready
									? t("sessionContext.compact")
									: t("sessionContext.compactNotReady")}
						</button>
					)}
					</div>,
					document.body,
				)}
		</span>
	);
}
