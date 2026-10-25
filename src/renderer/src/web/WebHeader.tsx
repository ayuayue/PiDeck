/**
 * WebHeader — Web 端会话头部（第三批瘦身后）。
 *
 * 左侧：会话标题（截断）；右侧：运行态指示 + 会话/全局动作。
 * 模型与思考档位已迁往 composer 工具行（WebModelSelector/WebThinkingSelector）。
 * 运行态来自 useChat status（submitted/streaming）与轮询的 runtime.status 兜底。
 */
import { useState } from "react";
import { AlertCircle, Check, ClipboardCopy, Clock, Copy, Download, EllipsisVertical, FileDown, FoldVertical, GitFork, Menu, Monitor, Moon, MoreHorizontal, PanelRight, Pencil, Puzzle, RefreshCw, RotateCw, Search, Sun, Target, Trash2 } from "lucide-react";
import type { AgentBackend } from "../../../shared/types";
import type { UsageProbeBackend } from "../../../shared/types/providerUsage";
import { Button } from "@/components/ui-shadcn/button";
import { t } from "@/i18n";
import { cn } from "@/lib/utils";
import { SessionBackendMark } from "@/components/session/SessionSourceBadge";
import { DSH_PERMISSION_PRESETS } from "@/components/session/DshPermissionMenu";
import { permissionStrengthIcon } from "@/utils/permissionLevelIcon";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui-shadcn/dropdown-menu";
import { WebBottomSheet } from "./WebBottomSheet";
import type { WebContextUsage } from "./webTypes";
import { useWebProviderUsage } from "./useWebProviderUsage";
import { formatPercent } from "../components/session/TimelineFormat";
// 紧凑数字（K/M）复用桌面 composer 统计行同一份实现，保证两头口径一致
import { formatTokens } from "../components/session/SessionContextMeter";
import { USAGE_TONE_BAR_CLASS, USAGE_TONE_TEXT_CLASS, formatAmount, formatBalance, relativeTimeParts, usageToneForPercent, usageWindowLabelText, usageWindowPercent, type UsageTone } from "../utils/providerUsageDisplay";

/**
 * 上下文占用百分比（数值）：pi 侧直接透传 contextPercent（浮点，可能是 45.50234375），
 * 缺失时按 tokens/window 兜底。展示一律经 formatPercent 做自适应精度。
 */
function resolveContextPercent(usage: WebContextUsage): number {
	const contextWindow = usage.contextWindow ?? 0;
	const contextTokens = usage.contextTokens ?? 0;
	const percent = usage.contextPercent ?? (contextWindow > 0 ? Math.min(100, (contextTokens / contextWindow) * 100) : 0);
	return Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
}
import type { ResolvedWebTheme, WebThemePreference } from "./webTheme";

export type WebHeaderStatus = "idle" | "starting" | "running" | "error";

/** P1/P3：溢出菜单 + 头部快捷入口回调（全部可选，缺失即隐藏对应项）。 */
export type WebHeaderActions = {
	onRename?: () => void;
	onDuplicate?: () => void;
	onExportHtml?: () => void;
	onDelete?: () => void;
	onRestart?: () => void;
	onCompact?: () => void;
	onClone?: () => void;
	onCopyMarkdown?: () => void;
	/** 手动从磁盘重拉当前会话消息（桌面端跑出的新输出不自动出现时的兜底入口）。 */
	onRefreshMessages?: () => void;
	onOpenWorkspace?: () => void;
	onPermissionChange?: (preset: string) => void;
};

export function WebHeader(props: {
	title: string;
	status: WebHeaderStatus;
	onOpenSidebar: () => void;
	backend?: AgentBackend;
	/** P2：上下文用量环数据（由 WebChatApp 随轮询拉取；无 runtime 时不渲染）。 */
	contextUsage?: WebContextUsage;
	/**
	 * 额度用量归属的供应商名（优先 runtime state 的 provider，其次会话记录的 model.provider）。
	 * 缺失或该供应商未开启用量探针时详情弹层不渲染额度区块。
	 */
	usageProvider?: string;
	/** 额度用量链路：DSH 会话走 dsh 后端探针，其余走 pi（默认 pi，省略即为 pi）。 */
	usageBackend?: UsageProbeBackend;
	/** P1：DSH 当前权限预设。 */
	permissionPreset?: string;
	/** P0-P3：会话/runtime/workspace 操作回调。 */
	actions?: WebHeaderActions;
	/** 第三批：模型/思考已迁 composer，不再由头部渲染。 */
	onOpenDshTools?: () => void;
	/** 第二批：全局入口（搜索/主题/PWA 安装/技能扩展面板）。 */
	onOpenSearch?: () => void;
	themePreference?: WebThemePreference;
	resolvedTheme?: ResolvedWebTheme;
	onCycleTheme?: () => void;
	canInstall?: boolean;
	onInstall?: () => void;
	onOpenAssets?: () => void;
	headerHidden?: boolean;
}) {
	const { title, status, onOpenSidebar, backend, contextUsage, usageProvider, usageBackend, permissionPreset, actions, onOpenDshTools, onOpenSearch, themePreference, onCycleTheme, canInstall, onInstall, onOpenAssets } = props;
	// 上下文详情弹层：移动端无悬停 title 提示，环必须可点开详情（对齐桌面 SessionContextMeter 点开面板语义）。
	const [contextSheetOpen, setContextSheetOpen] = useState(false);
	// DSH 权限预设：图标按统一保护强度语义取（#214 与桌面 DshPermissionMenu 同源），
	// 触发钮只显示一个盾牌 logo——宽 Select 曾在窄屏把标题挤没。
	const knownPreset = DSH_PERMISSION_PRESETS.find((item) => item.id === permissionPreset);
	const PermissionIcon = permissionStrengthIcon(knownPreset?.strength ?? "unknown");
	const permissionLabel = permissionPreset ? (knownPreset ? t(knownPreset.labelKey) : t("dshPermission.custom")) : t("dshPermission.unknown");
	// 头部固定单行：标题+状态占左侧，右侧动作收敛后窄屏不再换行错位（全局入口收进溢出菜单）。
	return (
		<>
			<div className={cn("grid shrink-0 transition-[grid-template-rows] duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none", props.headerHidden ? "grid-rows-[0fr]" : "grid-rows-[1fr]")}>
				<div className={cn("min-h-0 overflow-hidden transition-opacity duration-[240ms] ease-[cubic-bezier(0.4,0,0.2,1)] motion-reduce:transition-none", props.headerHidden ? "opacity-0" : "opacity-100")} inert={Boolean(props.headerHidden)} aria-hidden={props.headerHidden || undefined}>
					<header className="web-header flex min-w-0 items-center gap-2 border-b border-border/60 bg-background px-3 py-2">
						<Button type="button" variant="ghost" size="icon" className="mobile-sidebar-toggle size-8 shrink-0 pointer-coarse:size-9" onClick={onOpenSidebar} aria-label={t("web.openProjects")} title={t("web.openProjects")}>
							<Menu className="size-4" aria-hidden="true" />
						</Button>
						<div className="web-title-block flex min-w-0 flex-1 flex-col gap-0.5">
							{/* 语义标题：整页唯一的 h1（会话名/空态文案），屏幕阅读器靠它定位主区 */}
							<h1 className="flex min-w-0 items-center gap-1.5 truncate text-sm font-semibold tracking-tight text-foreground" title={title}>
								{/* 后端徽标（C18 同源）：与侧栏会话行一致，头部可辨 pi/dsh */}
								{backend && <SessionBackendMark backend={backend} className="size-4 shrink-0 rounded" />}
								<span className="min-w-0 truncate">{title}</span>
							</h1>
							{/* 运行态：紧凑小圆点+文字，不用带边框底色的大 pill（旧 agent-status-indicator
						在头部占两行高度且视觉过重；侧栏列表仍沿用该样式，此处不动它）。 */}
							<span className="flex items-center gap-1 self-start text-micro text-muted-foreground">
								<span
									className={cn("size-1.5 shrink-0 rounded-full", status === "running" && "animate-pulse bg-[var(--color-accent)]", status === "starting" && "animate-pulse bg-[var(--color-warning)]", status === "error" && "bg-[var(--color-danger)]", status === "idle" && "bg-[var(--color-info)]")}
									aria-hidden="true"
								/>
								{t(statusLabelKey(status))}
							</span>
						</div>
						<div className="web-header-actions flex min-w-0 items-center justify-end gap-1.5">
							{/* P2：上下文用量环（无窗口数据时隐藏；超限变红；点击开详情弹层） */}
							{contextUsage && (contextUsage.contextWindow ?? 0) > 0 ? <ContextRing usage={contextUsage} onClick={() => setContextSheetOpen(true)} /> : null}
							{/* S6.3：DSH 会话的 goals/subagents/skills 工具面板入口（仅 dsh 后端显示） */}
							{backend === "dsh" && onOpenDshTools && (
								<Button type="button" variant="ghost" size="sm" className="h-8 gap-1 px-2 text-caption text-muted-foreground hover:bg-muted/60 hover:text-foreground" onClick={onOpenDshTools} aria-label={t("web.dshTools")} title={t("web.dshTools")}>
									<Target size={14} aria-hidden="true" />
									<span className="hidden sm:inline">{t("web.dshTools")}</span>
								</Button>
							)}
							{/* P1：DSH 权限预设——单盾牌图标（强度语义：read-only=ShieldAlert / workspace-write=ShieldCheck /
						full-access=ShieldOff），下拉选档；与桌面 DshPermissionMenu 同一交互族。 */}
							{backend === "dsh" && actions?.onPermissionChange ? (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground pointer-coarse:size-9" aria-label={t("web.permission")} title={`${t("web.permission")} · ${permissionLabel}`}>
											<PermissionIcon className="size-4" aria-hidden="true" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-56">
										{DSH_PERMISSION_PRESETS.map((preset) => (
											<DropdownMenuItem key={preset.id} onClick={() => actions?.onPermissionChange?.(preset.id)}>
												<span className="min-w-0 flex-1 truncate">{t(preset.labelKey)}</span>
												{preset.id === permissionPreset ? <Check className="size-4 shrink-0" aria-hidden="true" /> : null}
											</DropdownMenuItem>
										))}
									</DropdownMenuContent>
								</DropdownMenu>
							) : null}
							{/* P3：工作区抽屉（Git / 文件）入口 */}
							{actions?.onOpenWorkspace ? (
								<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground pointer-coarse:size-9" onClick={actions.onOpenWorkspace} aria-label={t("web.workspaceDrawer")} title={t("web.workspaceDrawer")}>
									<PanelRight className="size-4" aria-hidden="true" />
								</Button>
							) : null}
							{/* P1/P3：会话与 runtime 操作溢出菜单（任一回调存在才渲染） */}
							{actions && (actions.onRename || actions.onRestart || actions.onCompact || actions.onClone || actions.onCopyMarkdown || actions.onExportHtml || actions.onDuplicate || actions.onDelete || actions.onRefreshMessages) ? (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground pointer-coarse:size-9" aria-label={t("web.sessionMenu")} title={t("web.sessionMenu")}>
											<MoreHorizontal className="size-4" aria-hidden="true" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-52">
										{actions.onRename ? (
											<DropdownMenuItem onClick={actions.onRename}>
												<Pencil className="size-4" aria-hidden="true" />
												{t("web.rename")}
											</DropdownMenuItem>
										) : null}
										{actions.onDuplicate ? (
											<DropdownMenuItem onClick={actions.onDuplicate}>
												<Copy className="size-4" aria-hidden="true" />
												{t("web.duplicate")}
											</DropdownMenuItem>
										) : null}
										{actions.onExportHtml ? (
											<DropdownMenuItem onClick={actions.onExportHtml}>
												<FileDown className="size-4" aria-hidden="true" />
												{t("web.exportHtml")}
											</DropdownMenuItem>
										) : null}
										{actions.onCopyMarkdown ? (
											<DropdownMenuItem onClick={actions.onCopyMarkdown}>
												<ClipboardCopy className="size-4" aria-hidden="true" />
												{t("web.copyMarkdown")}
											</DropdownMenuItem>
										) : null}
										{actions.onRefreshMessages ? (
											<DropdownMenuItem onClick={actions.onRefreshMessages}>
												<RefreshCw className="size-4" aria-hidden="true" />
												{t("web.refreshMessages")}
											</DropdownMenuItem>
										) : null}
										{actions.onRestart || actions.onCompact || actions.onClone ? <DropdownMenuSeparator /> : null}
										{actions.onRestart ? (
											<DropdownMenuItem onClick={actions.onRestart}>
												<RotateCw className="size-4" aria-hidden="true" />
												{t("web.restartRuntime")}
											</DropdownMenuItem>
										) : null}
										{actions.onCompact ? (
											<DropdownMenuItem onClick={actions.onCompact}>
												<FoldVertical className="size-4" aria-hidden="true" />
												{t("web.compactContext")}
											</DropdownMenuItem>
										) : null}
										{actions.onClone ? (
											<DropdownMenuItem onClick={actions.onClone}>
												<GitFork className="size-4" aria-hidden="true" />
												{t("web.cloneSession")}
											</DropdownMenuItem>
										) : null}
										{actions.onDelete ? (
											<>
												<DropdownMenuSeparator />
												<DropdownMenuItem className="text-danger focus:text-danger" onClick={actions.onDelete}>
													<Trash2 className="size-4" aria-hidden="true" />
													{t("web.deleteSession")}
												</DropdownMenuItem>
											</>
										) : null}
									</DropdownMenuContent>
								</DropdownMenu>
							) : null}
							{/* 第二批：全局入口（搜索/主题/安装/技能）收敛进溢出菜单——窄屏头部固定单行不换行（竖三点区分会话菜单的横三点） */}
							{onOpenSearch || onCycleTheme || (canInstall && onInstall) || onOpenAssets ? (
								<DropdownMenu>
									<DropdownMenuTrigger asChild>
										<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 text-muted-foreground hover:bg-muted/60 hover:text-foreground pointer-coarse:size-9" aria-label={t("web.globalMenu")} title={t("web.globalMenu")}>
											<EllipsisVertical className="size-4" aria-hidden="true" />
										</Button>
									</DropdownMenuTrigger>
									<DropdownMenuContent align="end" className="w-52">
										{onOpenSearch ? (
											<DropdownMenuItem onClick={onOpenSearch}>
												<Search className="size-4" aria-hidden="true" />
												{t("web.searchTitle")}
											</DropdownMenuItem>
										) : null}
										{onCycleTheme ? (
											<DropdownMenuItem onClick={onCycleTheme}>
												{themePreference === "light" ? <Sun className="size-4" aria-hidden="true" /> : themePreference === "dark" ? <Moon className="size-4" aria-hidden="true" /> : <Monitor className="size-4" aria-hidden="true" />}
												{t("web.themeToggle")} · {t(themePreference === "light" ? "web.themeLight" : themePreference === "dark" ? "web.themeDark" : "web.themeSystem")}
											</DropdownMenuItem>
										) : null}
										{canInstall && onInstall ? (
											<DropdownMenuItem onClick={onInstall}>
												<Download className="size-4" aria-hidden="true" />
												{t("web.installApp")}
											</DropdownMenuItem>
										) : null}
										{onOpenAssets ? (
											<DropdownMenuItem onClick={onOpenAssets}>
												<Puzzle className="size-4" aria-hidden="true" />
												{t("web.assetsTitle")}
											</DropdownMenuItem>
										) : null}
									</DropdownMenuContent>
								</DropdownMenu>
							) : null}
						</div>
					</header>
				</div>
			</div>
			{contextUsage && (contextUsage.contextWindow ?? 0) > 0 ? (
				<WebBottomSheet open={contextSheetOpen} onOpenChange={setContextSheetOpen} title={t("web.contextUsage")}>
					<ContextUsageSheetBody usage={contextUsage} provider={usageProvider} backend={usageBackend} enabled={contextSheetOpen} onCompact={actions?.onCompact} onCompacted={() => setContextSheetOpen(false)} />
				</WebBottomSheet>
			) : null}
		</>
	);
}

/** P2：上下文用量环 — 与桌面 ContextMeter 同语义的迷你版（无 jotai 依赖）。可点时升级为 32px 大触区按钮。 */
function ContextRing(props: { usage: WebContextUsage; onClick?: () => void }) {
	const window = props.usage.contextWindow ?? 0;
	const tokens = props.usage.contextTokens ?? 0;
	const percent = resolveContextPercent(props.usage);
	const overflow = props.usage.contextOverflow === true || percent >= 100;
	// 12px 环 + 2px 描边，SVG 圆弧按 percent 扫过（-90° 起笔）
	const radius = 5;
	const circumference = 2 * Math.PI * radius;
	const dash = (Math.min(100, Math.max(0, percent)) / 100) * circumference;
	// 展示走自适应精度：pi 直接透传的 contextPercent 是浮点（如 45.50234375），原样插值会显示成乱码般的长小数
	const tooltip = `${t("web.contextUsage")} ${formatPercent(percent)}% · ${formatTokens(tokens)} / ${formatTokens(window)}${overflow ? ` · ${t("web.contextOverflow")}` : ""}`;
	const ring = (
		<svg viewBox="0 0 14 14" className="size-4">
			<circle cx="7" cy="7" r={radius} fill="none" strokeWidth="2" className="stroke-border" />
			<circle cx="7" cy="7" r={radius} fill="none" strokeWidth="2" strokeLinecap="round" strokeDasharray={`${dash} ${circumference - dash}`} transform="rotate(-90 7 7)" className={overflow ? "stroke-danger" : "stroke-primary"} />
		</svg>
	);
	// 无点击处理时保持纯展示；可点时套 ghost 图标钮（触区 16px→32px，对齐桌面 28px 圆形点击区）。
	if (props.onClick) {
		return (
			<Button type="button" variant="ghost" size="icon" className="size-8 shrink-0 pointer-coarse:size-9" onClick={props.onClick} aria-label={tooltip} title={tooltip}>
				{ring}
			</Button>
		);
	}
	return (
		<span className="flex size-4 shrink-0 items-center justify-center" title={tooltip} aria-label={tooltip} role="img">
			{ring}
		</span>
	);
}

/**
 * P2：上下文用量详情 — 环点击后的弹层主体（桌面详情面板的精简版）。
 * 数字一律走紧凑 K/M 格式：Web 端常见的 128K/256K 窗口用千分位写满是七位数字，
 * 在 390px 弹层里会把行宽撑到换行/省略；哨兵位与桌面 composer 统计行同口径。
 */
function ContextUsageSheetBody(props: { usage: WebContextUsage; provider?: string; backend?: UsageProbeBackend; enabled?: boolean; onCompact?: () => void; onCompacted: () => void }) {
	const { usage } = props;
	const window = usage.contextWindow ?? 0;
	const tokens = usage.contextTokens ?? 0;
	const percent = resolveContextPercent(usage);
	const overflow = usage.contextOverflow === true || percent >= 100;
	const rows = [
		{ key: "context", label: t("web.contextUsage"), value: `${formatTokens(tokens)} / ${formatTokens(window)}` },
		...(usage.inputTokens != null ? [{ key: "input", label: t("web.inputTokens"), value: formatTokens(usage.inputTokens) }] : []),
		...(usage.outputTokens != null ? [{ key: "output", label: t("web.outputTokens"), value: formatTokens(usage.outputTokens) }] : []),
	];
	return (
		<div className="flex flex-col gap-3 px-3 pb-3">
			<div className="flex items-center gap-3">
				<ContextRing usage={usage} />
				<span className={cn("text-2xl font-semibold leading-none", overflow ? "text-danger" : "text-foreground")}>{formatPercent(percent)}%</span>
				{overflow ? <span className="rounded-full bg-danger/10 px-2 py-0.5 text-micro text-danger">{t("web.contextOverflow")}</span> : null}
			</div>
			<ul className="flex flex-col gap-1.5">
				{rows.map((row) => (
					<li key={row.key} className="flex items-baseline justify-between gap-4 rounded-md bg-muted/50 px-2.5 py-2">
						<span className="text-caption text-muted-foreground">{row.label}</span>
						<span className="text-control text-foreground">{row.value}</span>
					</li>
				))}
			</ul>
			<ProviderUsageBlock provider={props.provider} backend={props.backend} enabled={props.enabled !== false} />
			{props.onCompact ? (
				<Button
					type="button"
					size="sm"
					className="h-10 w-full text-control"
					onClick={() => {
						props.onCompacted();
						props.onCompact?.();
					}}
				>
					{t("web.compactContext")}
				</Button>
			) : null}
		</div>
	);
}

/**
 * Web 端「供应商额度用量」区块（桌面 ProviderUsageDetails 的精简版）。
 *
 * 与桌面同源的部分全部走 providerUsageDisplay 的纯函数（档位色/窗口名/相对时间），
 * 因此 Web 与桌面看到的颜色语义、阈值与叫法完全一致；数据获取是自写 hook
 * （useWebProviderUsage），不引桌面那套 jotai provider-usage-atoms。
 *
 * 降级策略：用量查询是用户显式开关的能力（ConfigManager usage probe）。主进程未装配、
 * 供应商未开启、无可用端点、网络失败 → 一律 success=false（路由恒返回 200），此处
 * 按「不渲染额度区块」处理，不弹错误 toast——Web 用户可能只是没开这个开关。
 */
function ProviderUsageBlock(props: { provider?: string; backend?: UsageProbeBackend; enabled?: boolean }) {
	const { result, loading, refresh } = useWebProviderUsage(props.provider, props.backend ?? "pi", props.enabled !== false && Boolean(props.provider));
	if (!props.provider || !result?.success) return null;
	const time = result.at != null ? relativeTimeParts(result.at) : null;
	const windows = result.kind === "credits" && result.credits?.windows ? result.credits.windows : [];
	const booster = result.booster;
	return (
		<div className="flex flex-col gap-1.5 border-t border-border pt-2" data-testid="web-provider-usage" data-provider={props.provider}>
			<div className="flex items-center gap-1.5">
				<span className="text-micro font-semibold uppercase tracking-wide text-muted-foreground">{t("sessionContext.usageHeader")}</span>
				<span className="min-w-0 truncate text-micro text-muted-foreground">{props.provider}</span>
				{time ? <Clock size={10} aria-hidden="true" className="shrink-0 text-muted-foreground" /> : null}
				{time ? <span className="shrink-0 text-micro text-muted-foreground">{t(time.key, time.params)}</span> : null}
				<Button type="button" variant="ghost" size="icon" className="ml-auto size-6 shrink-0 text-muted-foreground" onClick={refresh} aria-label={t("config.usage.refresh")} title={t("config.usage.refresh")} data-testid="web-provider-usage-refresh">
					<RefreshCw size={12} className={loading ? "animate-pideck-spin" : undefined} aria-hidden="true" />
				</Button>
			</div>
			{loading && result == null ? <span className="text-caption text-muted-foreground">{t("sessionContext.usageRefreshing")}</span> : null}
			{/* periods：三档窗口（滚动/本周/本月）——压缩进度条 + 彩色百分比，桌面 TierBar 同版式 */}
			{result.kind === "periods" && result.periods
				? (["rolling", "weekly", "monthly"] as const)
						.filter((key) => result.periods?.[key]?.percent != null)
						.map((key) => <WebUsageBarRow key={key} label={key === "rolling" ? t("sessionContext.usageRolling") : key === "weekly" ? t("sessionContext.usageWeekly") : t("sessionContext.usageMonthly")} percent={Math.min(100, Math.max(0, result.periods?.[key]?.percent ?? 0))} />)
				: null}
			{/* credits 多窗口：逐窗口（如智谱 5h 滚动窗 + 周窗），附带剩余小字 */}
			{result.kind === "credits" && windows.length > 0
				? windows.map((window) => {
						const percent = usageWindowPercent(window);
						const remaining = window.remaining ?? (window.total != null && window.used != null ? Math.max(0, window.total - window.used) : undefined);
						return <WebUsageBarRow key={window.key} label={usageWindowLabelText(window.key, t)} percent={percent} trailing={remaining != null && percent != null && percent < 90 ? t("sessionContext.usageWindowRemaining", { n: remaining }) : undefined} />;
					})
				: null}
			{/* 余额 / 点数：label + 右对齐彩色数值（无百分比语义的档位由 usageTone 判定） */}
			{result.kind === "balance" && result.balance ? (
				<div className="flex items-center justify-between gap-4 rounded-md bg-muted/50 px-2.5 py-2">
					<span className="text-caption text-muted-foreground">{t("sessionContext.usageBalance")}</span>
					<span className={cn("text-control tabular-nums", result.balance.value <= 0 ? USAGE_TONE_TEXT_CLASS.empty : USAGE_TONE_TEXT_CLASS.ok)}>{formatBalance(result.balance)}</span>
				</div>
			) : null}
			{result.kind === "credits" && result.credits ? (
				<div className="flex flex-col gap-1.5">
					{result.credits.remaining != null ? (
						<div className="flex items-center justify-between gap-4 rounded-md bg-muted/50 px-2.5 py-2">
							<span className="text-caption text-muted-foreground">{t("sessionContext.usageCreditsRemaining")}</span>
							<span className={cn("text-control tabular-nums", result.credits.remaining <= 0 ? USAGE_TONE_TEXT_CLASS.empty : USAGE_TONE_TEXT_CLASS.ok)}>{formatAmount(result.credits.remaining)}</span>
						</div>
					) : null}
					{result.credits.used != null ? (
						<div className="flex items-center justify-between gap-4 rounded-md bg-muted/50 px-2.5 py-2">
							<span className="text-caption text-muted-foreground">{t("sessionContext.usageCreditsUsed")}</span>
							<span className="text-control tabular-nums text-muted-foreground">{formatAmount(result.credits.used)}</span>
						</div>
					) : null}
				</div>
			) : null}
			{booster ? (
				<div className="flex items-center justify-between gap-4 px-2.5">
					<span className="text-caption text-muted-foreground">{t("sessionContext.usageBoosterBalance")}</span>
					<span className="text-control tabular-nums text-foreground">{formatBalance({ value: booster.balance, currency: booster.currency })}</span>
				</div>
			) : null}
			{/* 面板 JWT 余额段被丢弃时显式说明原因，避免「余额行突然消失」的困惑 */}
			{result.panelBalanceError ? (
				<div className="flex items-center gap-1.5 px-2.5 text-caption text-amber-600 dark:text-amber-400">
					<AlertCircle size={12} aria-hidden="true" />
					<span>{result.panelBalanceError === "unauthorized" ? t("config.usageProbe.sub2apiPanelJwtExpired") : t("config.usageProbe.sub2apiPanelJwtFailed")}</span>
				</div>
			) : null}
		</div>
	);
}

/** TierBar 行（版式对齐桌面 ProviderUsageDetails 的 UsageBarRow）：label + 进度条 + 彩色百分比 + 剩余小字。 */
function WebUsageBarRow(props: { label: string; percent: number | null; trailing?: string }) {
	const tone: UsageTone = usageToneForPercent(props.percent);
	const pct = props.percent == null ? null : Math.min(100, Math.max(0, Math.round(props.percent)));
	return (
		<div className="flex items-center gap-2.5" data-testid="web-usage-bar-row">
			<span className="w-14 flex-none truncate text-caption leading-5 text-muted-foreground" title={props.label}>
				{props.label}
			</span>
			<span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
				<span className={cn("block h-full rounded-full transition-all", USAGE_TONE_BAR_CLASS[tone])} style={{ width: `${pct ?? 0}%` }} />
			</span>
			<span className={cn("w-9 flex-none text-right font-mono text-caption font-semibold tabular-nums", USAGE_TONE_TEXT_CLASS[tone])}>{pct != null ? `${pct}%` : t("sessionContext.usageUnknown")}</span>
			{props.trailing ? <span className="min-w-0 flex-none text-right font-mono text-micro text-muted-foreground">{props.trailing}</span> : null}
		</div>
	);
}

function statusLabelKey(status: WebHeaderStatus) {
	switch (status) {
		case "running":
			return "app.statusRunning" as const;
		case "starting":
			return "app.statusStarting" as const;
		case "error":
			return "app.statusError" as const;
		default:
			return "app.statusIdle" as const;
	}
}
