/**
 * TokenDancePanel — Pi 配置管理「模型」页的 TokenDance 入口卡片。
 *
 * 与 PiDeck 的关系边界（用户确认的方案）：
 * - 不做任何内置/展示层注入：模型不存在于配置时，会话模型列表也不会出现；
 * - 卡片提供「一键配置」：用户点击 → 同意弹窗 → 授权 → 自动拿到 API Key → 写入
 *   pi models.json（与 DSH 模型目录），之后一切走既有链路；
 * - API Key 获取与配置写入合并成**一个操作**（见 TokenDanceSetupDialog）：主进程起本地
 *   回环端口接收授权回调，用户只需在浏览器点一次「授权」，不需要复制粘贴任何东西；
 *   自动接收不可用时才降级到「粘贴授权码 / 直接粘贴 Key」手动路径。
 * - 侵入性最低：只在配置页显示；不启动弹通知，用户不打开配置页则完全无感知。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, KeyRound, Loader2, PlugZap, ShieldCheck, Sparkles, Wallet } from "lucide-react";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { useProviderUsageRefresh } from "../hooks/useProviderUsage";
import { TokenDanceTopUpDialog } from "./TokenDanceTopUpDialog";
import { Button } from "../components/ui-shadcn/button";
import { Badge } from "../components/ui-shadcn/badge";
import { Input } from "../components/ui-shadcn/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { Collapsible, CollapsibleContent } from "../components/ui-shadcn/collapsible";
import { TOKENDANCE_APP_URL, TOKENDANCE_BASE_URL, TOKENDANCE_PROVIDER } from "../../../shared/tokendance";
import type { ModelItem } from "./configTypes";

/** 安装结果（主进程回执的精简视图，父级只需这两个值刷新 UI）。 */
export type TokendanceInstallOutcome = {
	modelCount: number;
	dshSaved: boolean;
};

/** 卡片 props（配置页装配层注入，保持本组件无全局状态依赖）。 */
export type TokenDancePanelProps = {
	/** models.json 是否已含 tokendance provider（决定「一键配置」or「已配置」状态）。 */
	configured: boolean;
	/** 安装成功后的回调（父级刷新 Pi 模型数据 + DSH 配置页）。 */
	onInstalled: (outcome: TokendanceInstallOutcome) => void;
};

/** 目录数据（模型数/时效展示）；拉取失败降级为局部错误提示，不阻塞卡片其它能力。 */
type CatalogState = {
	models: ModelItem[];
	fromCache: boolean;
	at: number;
	loading: boolean;
	error: string | null;
};

/**
 * 单一操作弹窗的状态机：
 * - idle    未开始，只展示写入清单 + 主按钮
 * - waiting 已打开授权页，等本地回环回调自动送达 code（主路径，用户无需操作）
 * - busy    正在交换 Key / 写入配置
 * - manual  自动接收不可用（降级或超时），展开手动粘贴区
 */
type SetupPhase = "idle" | "waiting" | "busy" | "manual";

/** 进行中的授权流程凭证（flowId 用于 await/exchange/cancel；authUrl 仅用于展示）。 */
type SetupFlow = { flowId: string; authUrl: string };

/**
 * 一键配置弹窗：把「授权拿 Key」和「写入配置」合成一次点击。
 *
 * 主路径（callback 模式）：start → 开浏览器 → 用户在授权页点确认 → 平台把一次性 code
 * 重定向回本机回环端口 → 主进程用 PKCE verifier 交换出 API Key → 立即写入配置。
 * 用户视角只有一个动作：点「授权并一键配置」，然后回到 PiDeck 看结果。
 *
 * 降级路径：端口绑定失败或等待超时 → 展开手动区，允许粘贴授权码（headless 交换）
 * 或直接粘贴已在后台创建好的 API Key。
 */
function TokenDanceSetupDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/** 已配置时只更新 Key（文案不同，写入仍是幂等 upsert）。 */
	configured: boolean;
	/** 目录模型数，用于「将写入 N 个模型」文案。 */
	modelCount: number;
	onDone: (outcome: TokendanceInstallOutcome) => void;
}) {
	const [phase, setPhase] = useState<SetupPhase>("idle");
	const [flow, setFlow] = useState<SetupFlow | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [code, setCode] = useState("");
	const [pastedKey, setPastedKey] = useState("");
	/** 关闭/卸载时要 cancel 的 flow：用 ref 保证拿到最新值，不闭包过期状态。 */
	const flowRef = useRef<SetupFlow | null>(null);
	// 依赖数组只写单个回调，不写整个 props 对象（AGENTS.md 禁止 props 袋透传）。
	const { onOpenChange, onDone } = props;

	/** 放弃未完成的授权流程：释放主进程回环端口（成功交换后 flowRef 已清空，不会误关）。 */
	const cancelPendingFlow = useCallback(() => {
		const current = flowRef.current;
		flowRef.current = null;
		if (current) void desktopApi.config.tokendanceAuthCancel(current.flowId).catch(() => undefined);
	}, []);

	/** 关闭弹窗并重置：下次打开必须重新 start（一次性 code 与 verifier 都不可复用）。 */
	const close = useCallback(() => {
		cancelPendingFlow();
		props.onOpenChange(false);
		setPhase("idle");
		setFlow(null);
		setError(null);
		setCode("");
		setPastedKey("");
	}, [cancelPendingFlow, onOpenChange]);

	// 组件随配置弹窗卸载时也要退订本地端口，否则端口挂到主进程 30 分钟过期清理为止。
	useEffect(() => cancelPendingFlow, [cancelPendingFlow]);

	/** 写入配置（Key 已在手）：成功回执父级并关闭；失败留在弹窗内可重试。 */
	const installWithKey = useCallback(
		async (apiKey: string) => {
			setPhase("busy");
			setError(null);
			const result = await desktopApi.config.installTokendance(apiKey);
			if (!result.ok) {
				setPhase("manual");
				setError(result.error ?? t("config.tokendance.installFailed"));
				return false;
			}
			showNotice(t("config.tokendance.installSuccess", { count: result.modelCount }), 4000);
			onDone({ modelCount: result.modelCount, dshSaved: result.dshSaved });
			close();
			return true;
		},
		[close, onDone],
	);

	/**
	 * 主路径：一次点击跑完「授权 → 自动收 code → 交换 Key → 写入配置」。
	 * 每一步失败都留在弹窗里并给出可执行的下一步，不吞错误。
	 */
	const handleOneClick = useCallback(async () => {
		setError(null);
		setPhase("busy");
		const start = await desktopApi.config.tokendanceAuthStart("callback");
		if (!start.ok) {
			setPhase("idle");
			setError(start.error);
			return;
		}
		const nextFlow = { flowId: start.flowId, authUrl: start.authUrl };
		flowRef.current = nextFlow;
		setFlow(nextFlow);
		// 打开系统浏览器授权页；callback 模式下确认后平台会把 code 重定向回本机端口。
		await desktopApi.app.openExternal(start.authUrl, true).catch(() => undefined);

		// 主进程绑定回环端口失败 → 已降级 headless（授权页展示一次性 code），直接展开手动区。
		if (start.mode === "headless") {
			setPhase("manual");
			setError(start.fallbackReason ? `${t("config.tokendance.headlessFallback")}（${start.fallbackReason}）` : t("config.tokendance.headlessFallback"));
			return;
		}

		setPhase("waiting");
		const exchanged = await desktopApi.config.tokendanceAuthAwait(start.flowId);
		if (!exchanged.ok) {
			// 超时/交换失败：flow 可能已被主进程清理，保留 authUrl 供重开授权页。
			setPhase("manual");
			setError(exchanged.error);
			return;
		}
		flowRef.current = null;
		await installWithKey(exchanged.key);
	}, [installWithKey]);

	/** 手动路径 A：粘贴授权页上展示的一次性授权码，由主进程交换成 Key。 */
	const handleExchangeCode = useCallback(async () => {
		const trimmed = code.trim();
		if (!trimmed || !flow) return;
		setPhase("busy");
		setError(null);
		const result = await desktopApi.config.tokendanceAuthExchange(flow.flowId, trimmed);
		if (!result.ok) {
			setPhase("manual");
			setError(result.error);
			return;
		}
		flowRef.current = null;
		await installWithKey(result.key);
	}, [code, flow, installWithKey]);

	/** 手动路径 B：用户已在 TokenDance 后台自建 Key，直接写入。 */
	const handlePasteKey = useCallback(async () => {
		const trimmed = pastedKey.trim();
		if (!trimmed) return;
		await installWithKey(trimmed);
	}, [installWithKey, pastedKey]);

	const busy = phase === "busy";
	const waiting = phase === "waiting";

	return (
		<Dialog open={props.open} onOpenChange={(open) => (open ? undefined : close())}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t(props.configured ? "config.tokendance.keyTitle" : "config.tokendance.installTitle")}</DialogTitle>
				</DialogHeader>
				<div className="flex min-w-0 flex-col gap-3 text-sm leading-relaxed text-text-secondary">
					<p className="text-muted-foreground">{t(props.configured ? "config.tokendance.keyDesc" : "config.tokendance.installDesc", { count: props.modelCount })}</p>

					{/* 写入清单只在首次配置时展示；已配置只更新 Key，不再重复列优势 */}
					{!props.configured && (
						<>
							<ul className="grid gap-1.5 text-xs">
								<li className="flex items-start gap-1.5">
									<span className="mt-0.5 shrink-0 text-[var(--color-accent)]">●</span>
									{t("config.tokendance.advantageOne")}
								</li>
								<li className="flex items-start gap-1.5">
									<span className="mt-0.5 shrink-0 text-[var(--color-accent)]">●</span>
									{t("config.tokendance.advantageTwo")}
								</li>
								{/* 新用户体验额度：注册即送，先试后充，降低首次使用门槛 */}
								<li className="flex items-start gap-1.5">
									<span className="mt-0.5 shrink-0 text-[var(--color-accent)]">●</span>
									{t("config.tokendance.advantageCredit")}
								</li>
							</ul>
							<p className="rounded-sm border border-border-subtle bg-bg-subtle/60 px-2.5 py-2 text-micro text-muted-foreground">{t("config.tokendance.installWrites")}</p>
						</>
					)}

					{/* 归因说明：Key 会带上 app_url，用户可核对不是 PiDeck 偷偷收集信息 */}
					<p className="text-micro text-text-tertiary">{t("config.tokendance.oauthAppUrl", { appUrl: TOKENDANCE_APP_URL })}</p>

					{/* 进度反馈：waiting 是主路径的关键提示，告诉用户「回浏览器点确认就行」 */}
					{(waiting || busy) && (
						<p className="flex items-center gap-2 rounded-sm border border-border-subtle bg-bg-subtle/60 px-2.5 py-2 text-xs text-text-secondary">
							<Loader2 className="size-3.5 shrink-0 animate-pideck-spin text-[var(--color-accent)]" aria-hidden="true" />
							<span className="min-w-0">{t(busy ? "config.tokendance.writingConfig" : "config.tokendance.waitingBrowser")}</span>
						</p>
					)}

					{error && <p className="rounded-sm border border-danger/20 bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{error}</p>}

					{/* 手动降级区：只在自动接收不可用（或用户主动选择）时展开，避免主路径被干扰 */}
					{phase === "manual" && (
						<div className="flex min-w-0 flex-col gap-2.5 rounded-sm border border-border-subtle bg-bg-subtle/40 p-2.5">
							<p className="text-micro text-text-tertiary">{t("config.tokendance.manualHint")}</p>

							{flow && (
								<p className="w-full min-w-0 truncate font-mono text-micro text-text-tertiary" title={flow.authUrl}>
									{authUrlLabel(flow.authUrl)}
								</p>
							)}

							{/* 路径 A：粘贴一次性授权码（headless 交换） */}
							<div className="flex min-w-0 items-start gap-2">
								<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)] font-mono text-micro font-semibold text-[var(--color-accent)]">1</span>
								{/* min-w-0 必须在每一层（grid item → flex 行 → flex-1 列）：否则长内容
								    的 min-content 会把 DialogContent 的 grid 单列轨道撑宽，输入框画出弹窗。 */}
								<div className="min-w-0 flex-1">
									<p className="text-xs">{t("config.tokendance.oauthStepCode")}</p>
									<div className="mt-1.5 flex items-center gap-1.5">
										<Input value={code} onChange={(e) => setCode(e.target.value)} placeholder={t("config.tokendance.oauthCodePlaceholder")} className="h-8 min-w-0 flex-1" />
										<Button variant="secondary" size="sm" className="h-8 shrink-0" disabled={!code.trim() || !flow} onClick={() => void handleExchangeCode()}>
											<KeyRound className="size-3.5" aria-hidden="true" />
											{t("config.tokendance.oauthExchange")}
										</Button>
									</div>
									{flow && (
										<Button variant="ghost" size="sm" className="mt-1.5 h-7 px-0 text-micro" onClick={() => void desktopApi.app.openExternal(flow.authUrl, true).catch(() => undefined)}>
											<ExternalLink className="size-3.5" aria-hidden="true" />
											{t("config.tokendance.oauthReopen")}
										</Button>
									)}
								</div>
							</div>

							{/* 路径 B：直接粘贴已自建 API Key（完全跳过授权页） */}
							<div className="flex min-w-0 items-start gap-2">
								<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)] font-mono text-micro font-semibold text-[var(--color-accent)]">2</span>
								<div className="min-w-0 flex-1">
									<p className="text-xs">{t("config.tokendance.keyOptionPaste")}</p>
									<div className="mt-1.5 flex items-center gap-1.5">
										<Input value={pastedKey} onChange={(e) => setPastedKey(e.target.value)} placeholder={t("config.tokendance.keyPastePlaceholder")} className="h-8 min-w-0 flex-1 font-mono" type="password" />
										<Button variant="secondary" size="sm" className="h-8 shrink-0" disabled={!pastedKey.trim()} onClick={() => void handlePasteKey()}>
											<KeyRound className="size-3.5" aria-hidden="true" />
											{t("config.tokendance.keyApply")}
										</Button>
									</div>
								</div>
							</div>
						</div>
					)}
				</div>
				<DialogFooter className="gap-2">
					{phase === "manual" ? (
						<Button variant="ghost" size="sm" onClick={close}>
							{t("config.tokendance.keyLater")}
						</Button>
					) : (
						<Button variant="ghost" size="sm" onClick={close} disabled={waiting || busy}>
							{t("common.cancel")}
						</Button>
					)}
					{/* 主按钮：一次点击完成授权 + 写入；waiting 时允许重开授权页重试 */}
					<Button variant="default" size="sm" onClick={() => void handleOneClick()} disabled={busy || waiting}>
						{busy || waiting ? <Loader2 className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <PlugZap className="size-3.5" aria-hidden="true" />}
						{t(props.configured ? "config.tokendance.setupPrimaryUpdate" : "config.tokendance.setupPrimary")}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}

/** 授权 URL 只展示 host + 参数摘要（含 challenge 尾部），完整 URL 放 title 悬停。 */
function authUrlLabel(url: string): string {
	try {
		const parsed = new URL(url);
		return `${parsed.origin}/auth?code_challenge=…&app_url=${parsed.searchParams.get("app_url") ?? ""}&key_name=${parsed.searchParams.get("key_name") ?? ""}`;
	} catch {
		return url;
	}
}

export function TokenDancePanel(props: TokenDancePanelProps) {
	const [catalog, setCatalog] = useState<CatalogState>({
		models: [],
		fromCache: false,
		at: 0,
		loading: true,
		error: null,
	});
	const [setupOpen, setSetupOpen] = useState(false);
	const [topUpOpen, setTopUpOpen] = useState(false);
	const [installing, setInstalling] = useState(false);
	// 到账后刷新余额缓存：会话上下文面板与用量弹窗订阅同一 atom，一处刷新多处联动。
	const refreshUsage = useProviderUsageRefresh();
	const handlePaid = useCallback(() => refreshUsage(TOKENDANCE_PROVIDER), [refreshUsage]);

	// 目录只读展示（模型数/时效）；失败不阻塞「配置」——写入时主进程会再取目录并报错。
	const loadCatalog = useCallback(async (): Promise<ModelItem[]> => {
		setCatalog((prev) => ({ ...prev, loading: true, error: null }));
		try {
			const result = await desktopApi.config.getTokendanceModels();
			const models = result.models.map((m) => {
				const item: ModelItem = { id: m.id, name: m.name ?? m.id };
				if (m.contextWindow != null) item.contextWindow = m.contextWindow;
				return item;
			});
			setCatalog({
				models,
				fromCache: result.fromCache,
				at: result.at,
				loading: false,
				error: null,
			});
			return models;
		} catch (error) {
			setCatalog((prev) => ({
				...prev,
				loading: false,
				error: error instanceof Error ? error.message : String(error),
			}));
			return [];
		}
	}, []);

	useEffect(() => {
		void loadCatalog();
	}, [loadCatalog]);

	/** 打开一键配置弹窗；目录为空/上次拉取失败时先补拉，让「将写入 N 个模型」显示真实数字。 */
	const openSetup = async () => {
		setInstalling(true);
		try {
			if (catalog.models.length === 0 && !catalog.loading) await loadCatalog();
		} finally {
			setInstalling(false);
		}
		setSetupOpen(true);
	};

	/** 打开 TokenDance 官网模型列表页（优势详情让用户自行确认，避免过度承诺）。 */
	const openSite = () => {
		void desktopApi.app.openExternal("https://tokendance.space/models", true).catch(() => undefined);
	};

	/** 展开详情（优势/基址/模型数/提示）；默认收起：卡片头部+操作按钮常驻，
	 * 详情折进头部，避免挤压下方模型列表。 */
	const [expanded, setExpanded] = useState(false);

	return (
		<section className="config-builtin-provider-panel mb-2.5 rounded-lg border border-border-subtle bg-bg-subtle/40 p-3.5">
			{/* 整行标题可点击展开/收起：折叠态下右侧图标小，用户可能注意不到，整行即开关 */}
			<button type="button" className="flex w-full items-center gap-2 text-left" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded} aria-label={t("config.tokendance.expandDetails")} title={t("config.tokendance.expandDetails")}>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-soft)]">
					<Sparkles className="size-3.5 text-[var(--color-accent)]" aria-hidden="true" />
				</span>
				<span className="font-mono text-sm font-semibold text-text-primary">{TOKENDANCE_PROVIDER}</span>
				{props.configured && (
					<Badge variant="success" size="sm">
						<ShieldCheck className="size-3" aria-hidden="true" />
						{t("config.tokendance.configuredBadge")}
					</Badge>
				)}
				<span className="min-w-0 flex-1 truncate text-micro text-text-tertiary">{t("config.tokendance.subtitle")}</span>
				<span className="shrink-0 text-text-tertiary">{expanded ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}</span>
			</button>

			{/* 折叠详情走共享折叠原语（真高度渐变 + exit 后卸载 + reduced-motion 回退）；
			    display:contents 让根不生成盒子，折叠态零空档；三段详情（优势/基址/提示）合一收进单个折叠体。 */}
			<Collapsible open={expanded} className="contents">
				{/* 不再挂 animate-in/fade-in：twMerge 会把 animate-* 判同组，保留会盖掉高度动画。 */}
				<CollapsibleContent>
					{/* 平台优势（聚合 + 特价 + 新用户体验额度）；详情给官网链接，由用户自行核对 */}
					<ul className="mt-2 grid gap-1 text-xs text-text-secondary">
						<li className="flex items-start gap-1.5">
							<span className="mt-0.5 shrink-0 text-[var(--color-accent)]">●</span>
							{t("config.tokendance.advantageOne")}
						</li>
						<li className="flex items-start gap-1.5">
							<span className="mt-0.5 shrink-0 text-[var(--color-accent)]">●</span>
							{t("config.tokendance.advantageTwo")}
						</li>
						{/* 新用户体验额度：注册即送，先试后充，降低首次使用门槛 */}
						<li className="flex items-start gap-1.5">
							<span className="mt-0.5 shrink-0 text-[var(--color-accent)]">●</span>
							{t("config.tokendance.advantageCredit")}
						</li>
					</ul>

					<div className="mt-2 grid gap-1.5 text-xs text-text-secondary">
						<div className="flex items-center gap-1.5">
							<span className="min-w-[72px] shrink-0 text-text-tertiary">{t("config.field.baseUrl")}</span>
							<code className="truncate font-mono text-micro text-text-primary">{TOKENDANCE_BASE_URL}</code>
						</div>
						<div className="flex items-center gap-1.5">
							<span className="min-w-[72px] shrink-0 text-text-tertiary">{t("config.tokendance.modelsCount")}</span>
							{catalog.loading ? (
								<Loader2 className="size-3 animate-pideck-spin text-text-tertiary" aria-hidden="true" />
							) : catalog.error ? (
								<span className="text-danger">{t("config.tokendance.catalogError")}</span>
							) : (
								<span>
									{catalog.models.length}
									{catalog.fromCache ? ` · ${t("config.tokendance.fromCache")}` : ""}
								</span>
							)}
						</div>
						<div className="flex items-center gap-1.5">
							<span className="min-w-[72px] shrink-0 text-text-tertiary">{t("config.tokendance.appUrlLabel")}</span>
							<code className="truncate font-mono text-micro text-text-primary">{TOKENDANCE_APP_URL}</code>
						</div>
					</div>

					<p className="mt-2 text-micro leading-relaxed text-text-tertiary">{t("config.tokendance.hint")}</p>
				</CollapsibleContent>
			</Collapsible>

			<div className="mt-3 flex flex-wrap items-center gap-1.5">
				<Button size="sm" variant={props.configured ? "outline" : "default"} onClick={() => void openSetup()} disabled={props.configured || installing} title={props.configured ? t("config.tokendance.alreadyConfiguredTitle") : undefined}>
					{installing ? <Loader2 className="size-3.5 animate-pideck-spin" aria-hidden="true" /> : <PlugZap className="size-3.5" aria-hidden="true" />}
					{props.configured ? t("config.tokendance.alreadyConfigured") : t("config.tokendance.addToConfig")}
				</Button>
				{props.configured && (
					<>
						<Button size="sm" variant="outline" onClick={() => setSetupOpen(true)}>
							<KeyRound className="size-3.5" aria-hidden="true" />
							{t("config.tokendance.oauthButton")}
						</Button>
						{/* 充值入口：只在已配置（已有 API Key）时出现——未配置时无 Key，无法发起充值 */}
						<Button size="sm" variant="outline" onClick={() => setTopUpOpen(true)}>
							<Wallet className="size-3.5" aria-hidden="true" />
							{t("config.tokendance.topUpButton")}
						</Button>
					</>
				)}
				<Button size="sm" variant="ghost" onClick={openSite}>
					<ExternalLink className="size-3.5" aria-hidden="true" />
					{t("config.tokendance.detailsLink")}
				</Button>
			</div>

			{/* 单一操作弹窗：授权 + 交换 Key + 写入配置一次完成 */}
			<TokenDanceSetupDialog open={setupOpen} onOpenChange={setSetupOpen} configured={props.configured} modelCount={catalog.models.length} onDone={props.onInstalled} />
			{/* 充值弹窗：创建支付会话（主进程）→ 扫码 → 轮询到账 */}
			<TokenDanceTopUpDialog open={topUpOpen} onOpenChange={setTopUpOpen} onPaid={handlePaid} />
		</section>
	);
}
