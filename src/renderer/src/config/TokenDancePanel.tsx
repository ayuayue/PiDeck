/**
 * TokenDancePanel — Pi 配置管理「模型」页的 TokenDance 入口卡片。
 *
 * 与 PiDeck 的关系边界（用户确认的方案）：
 * - 不做任何内置/展示层注入：模型不存在于配置时，会话模型列表也不会出现；
 * - 卡片提供「确认写入」：用户点击 → 同意弹窗（写入清单 + 平台优势）→ 主进程把
 *   供应商信息 + 目录模型写入 pi models.json（与 DSH 模型目录），之后一切走既有链路；
 * - API Key 由用户自行获取：OAuth 授权（PKCE headless）或粘贴已有 Key，二选一。
 * - 侵入性最低：只在配置页显示；不启动弹通知，用户不打开配置页则完全无感知。
 */
import { useCallback, useEffect, useState } from "react";
import { ChevronDown, ChevronUp, ExternalLink, KeyRound, Loader2, PlugZap, ShieldCheck, Sparkles } from "lucide-react";
import { t } from "../i18n";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
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

/** Key 弹窗内部状态机：oauth idle → started(有 flowId) → busy → error。 */
type AuthDialogState =
	| { phase: "idle"; error: string | null }
	| { phase: "started"; flowId: string; authUrl: string; error: string | null }
	| { phase: "busy"; flowId: string; authUrl: string; error: string | null };

/**
 * 获取 API Key 弹窗：两种获取路径并存——
 * ① OAuth 授权（打开授权页 → 粘贴一次性 code → 主进程交换 Key）；
 * ② 已有 Key 直接粘贴（用户自行在 TokenDance 后台创建）。
 * 两条路径最终都调 onKeyObtained(key)，由父级写入配置。
 */
function TokenDanceKeyDialog(props: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onKeyObtained: (apiKey: string) => void;
}) {
	const [state, setState] = useState<AuthDialogState>({ phase: "idle", error: null });
	const [code, setCode] = useState("");
	const [pastedKey, setPastedKey] = useState("");

	// 弹窗关闭即重置状态机（下次打开重新 start，避免使用过期 verifier）。
	const close = useCallback(() => {
		props.onOpenChange(false);
		setState({ phase: "idle", error: null });
		setCode("");
		setPastedKey("");
	}, [props]);

	const handleStart = async () => {
		setState({ phase: "idle", error: null });
		const result = await desktopApi.config.tokendanceAuthStart();
		if (!result.ok) {
			setState({ phase: "idle", error: result.error });
			return;
		}
		// 打开系统浏览器授权页；headless 模式确认后页面展示一次性 code（10 分钟有效）。
		await desktopApi.app.openExternal(result.authUrl, true);
		setState({ phase: "started", flowId: result.flowId, authUrl: result.authUrl, error: null });
		showNotice(t("config.tokendance.oauthOpened"), 3000);
	};

	const handleExchange = async () => {
		if (state.phase !== "started") return;
		const trimmed = code.trim();
		if (!trimmed) return;
		setState({ phase: "busy", flowId: state.flowId, authUrl: state.authUrl, error: null });
		const result = await desktopApi.config.tokendanceAuthExchange(state.flowId, trimmed);
		if (result.ok) {
			// Key 只在本次响应出现一次：立即写入并提示，之后不保留在内存。
			props.onKeyObtained(result.key);
			close();
			return;
		}
		setState({ phase: "started", flowId: state.flowId, authUrl: state.authUrl, error: result.error });
	};

	const handlePaste = () => {
		const trimmed = pastedKey.trim();
		if (!trimmed) return;
		props.onKeyObtained(trimmed);
		setPastedKey("");
	};

	return (
		<Dialog open={props.open} onOpenChange={(open) => (open ? undefined : close())}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{t("config.tokendance.keyTitle")}</DialogTitle>
				</DialogHeader>
				<div className="flex min-w-0 flex-col gap-3 text-sm leading-relaxed text-text-secondary">
					<p className="text-muted-foreground">{t("config.tokendance.keyDesc")}</p>

					{/* 路径 ②：已有 Key 直接粘贴（无需打开授权页） */}
					{/* min-w-0 必须在每一层（grid item → flex 行 → flex-1 列）：否则长内容
					   的 min-content 会把 DialogContent 的 grid 单列轨道撑宽，输入框画出弹窗。 */}
					<div className="flex min-w-0 items-start gap-2">
						<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)] font-mono text-[11px] font-semibold text-[var(--color-accent)]">1</span>
						<div className="min-w-0 flex-1">
							<p>{t("config.tokendance.keyOptionPaste")}</p>
							<Input
								value={pastedKey}
								onChange={(e) => setPastedKey(e.target.value)}
								placeholder={t("config.tokendance.keyPastePlaceholder")}
								className="mt-2 h-8 font-mono"
								type="password"
							/>
							<Button
								variant="secondary"
								size="sm"
								className="mt-2 h-7"
								disabled={!pastedKey.trim()}
								onClick={handlePaste}
							>
								<KeyRound className="size-3.5" aria-hidden="true" />
								{t("config.tokendance.keyApply")}
							</Button>
						</div>
					</div>

					{/* 路径 ①：OAuth 授权（应用归因随 app_url 写入新 Key） */}
					<div className="flex min-w-0 items-start gap-2">
						<span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-accent-soft)] font-mono text-[11px] font-semibold text-[var(--color-accent)]">2</span>
						<div className="min-w-0 flex-1">
							<p>{t("config.tokendance.keyOptionOauth")}</p>
							<p className="mt-1 text-[11px] text-text-tertiary">{t("config.tokendance.oauthAppUrl", { appUrl: TOKENDANCE_APP_URL })}</p>
							{state.phase === "started" && (
								<>
									<p className="mt-2 text-[11px] text-text-tertiary">{t("config.tokendance.oauthStepCode")}</p>
									<Input
										value={code}
										onChange={(e) => setCode(e.target.value)}
										placeholder={t("config.tokendance.oauthCodePlaceholder")}
										className="mt-1.5 h-8"
									/>
								</>
							)}
							{state.phase === "started" && (
								<p className="mt-1.5 w-full min-w-0 truncate font-mono text-[11px] text-text-tertiary" title={state.authUrl}>
									{authUrlLabel(state.authUrl)}
								</p>
							)}
							{state.error && (
								<p className="mt-1.5 rounded-sm border border-danger/20 bg-danger-soft px-2.5 py-1.5 text-xs text-danger">{state.error}</p>
							)}
							<div className="mt-2 flex flex-wrap gap-1.5">
								{state.phase === "idle" ? (
									<Button variant="default" size="sm" className="h-7" onClick={handleStart}>
										<ExternalLink className="size-3.5" aria-hidden="true" />
										{t("config.tokendance.oauthOpenPage")}
									</Button>
								) : (
									<>
										<Button variant="outline" size="sm" className="h-7" onClick={handleStart}>
											{t("config.tokendance.oauthReopen")}
										</Button>
										<Button
											variant="default"
											size="sm"
											className="h-7"
											onClick={handleExchange}
											disabled={state.phase === "busy" || !code.trim()}
										>
											{state.phase === "busy" ? (
												<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
											) : (
												<KeyRound className="size-3.5" aria-hidden="true" />
											)}
											{t("config.tokendance.oauthExchange")}
										</Button>
									</>
								)}
							</div>
						</div>
					</div>
				</div>
				<DialogFooter>
					<Button variant="ghost" size="sm" onClick={close}>
						{t("config.tokendance.keyLater")}
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
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [keyOpen, setKeyOpen] = useState(false);
	const [installing, setInstalling] = useState(false);

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

	/** 关键写入入口：调主进程一键安装；成功回执 onInstalled，无 Key 时顺势引导获取。 */
	const handleInstall = async (apiKey?: string) => {
		setInstalling(true);
		try {
			const result = await desktopApi.config.installTokendance(apiKey);
			if (!result.ok) {
				showNotice(result.error ?? t("config.tokendance.installFailed"), 4000);
				return;
			}
			showNotice(t("config.tokendance.installSuccess", { count: result.modelCount }), 4000);
			setConfirmOpen(false);
			props.onInstalled({ modelCount: result.modelCount, dshSaved: result.dshSaved });
			// 没带 Key 安装成功 → 顺势引导获取 Key（用户已有 Key 时不再打扰）
			if (!apiKey) setKeyOpen(true);
		} finally {
			setInstalling(false);
		}
	};

	/** 打开 TokenDance 官网模型列表页（优势详情让用户自行确认，避免过度承诺）。 */
	const openSite = () => {
		void desktopApi.app.openExternal("https://tokendance.space/models", true).catch(() => undefined);
	};

	/** 展开详情（优势/基址/模型数/提示）；默认收起：卡片头部+操作按钮常驻，
	 * 详情折进头部，避免挤压下方模型列表。 */
	const [expanded, setExpanded] = useState(false);

	return (
		<section className="config-builtin-provider-panel mb-2.5 rounded-lg border border-dashed border-border-subtle bg-bg-subtle/40 p-3.5">
			{/* 整行标题可点击展开/收起：折叠态下右侧图标小，用户可能注意不到，整行即开关 */}
			<button
				type="button"
				className="flex w-full items-center gap-2 text-left"
				onClick={() => setExpanded((v) => !v)}
				aria-expanded={expanded}
				aria-label={t("config.tokendance.expandDetails")}
				title={t("config.tokendance.expandDetails")}
			>
				<span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-[var(--color-accent-soft)]">
					<Sparkles className="size-3.5 text-[var(--color-accent)]" aria-hidden="true" />
				</span>
				<span className="font-mono text-sm font-semibold text-text-primary">{TOKENDANCE_PROVIDER}</span>
				{props.configured && (
					<span className="flex items-center gap-1 rounded-full border border-emerald-300/70 bg-emerald-500/10 px-1.5 py-px text-micro text-emerald-700 dark:border-emerald-700/70 dark:text-emerald-300">
						<ShieldCheck className="size-3" aria-hidden="true" />
						{t("config.tokendance.configuredBadge")}
					</span>
				)}
				<span className="min-w-0 flex-1 truncate text-micro text-text-tertiary">{t("config.tokendance.subtitle")}</span>
				<span className="shrink-0 text-text-tertiary">
					{expanded ? <ChevronUp className="size-4" aria-hidden="true" /> : <ChevronDown className="size-4" aria-hidden="true" />}
				</span>
			</button>

			{expanded && (<>
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
					<code className="truncate font-mono text-[11px] text-text-primary">{TOKENDANCE_BASE_URL}</code>
				</div>
				<div className="flex items-center gap-1.5">
					<span className="min-w-[72px] shrink-0 text-text-tertiary">{t("config.tokendance.modelsCount")}</span>
					{catalog.loading ? (
						<Loader2 className="size-3 animate-spin text-text-tertiary" aria-hidden="true" />
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
					<code className="truncate font-mono text-[11px] text-text-primary">{TOKENDANCE_APP_URL}</code>
				</div>
			</div>

			<p className="mt-2 text-[11px] leading-relaxed text-text-tertiary">{t("config.tokendance.hint")}</p>
			</>)}

			<div className="mt-3 flex flex-wrap items-center gap-1.5">
				<Button
					size="sm"
					variant="default"
					onClick={() => {
						// 目录为空/上次拉取失败：打开确认弹窗前补拉一次，让写入清单显示真实模型数
						if (catalog.models.length === 0 && !catalog.loading) {
							void loadCatalog().then(() => setConfirmOpen(true));
							return;
						}
						setConfirmOpen(true);
					}}
					disabled={props.configured || installing}
					title={props.configured ? t("config.tokendance.alreadyConfiguredTitle") : undefined}
				>
					{installing ? (
						<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
					) : (
						<PlugZap className="size-3.5" aria-hidden="true" />
					)}
					{props.configured ? t("config.tokendance.alreadyConfigured") : t("config.tokendance.addToConfig")}
				</Button>
				{props.configured && (
					<Button size="sm" variant="outline" onClick={() => setKeyOpen(true)}>
						<KeyRound className="size-3.5" aria-hidden="true" />
						{t("config.tokendance.oauthButton")}
					</Button>
				)}
				<Button size="sm" variant="ghost" onClick={openSite}>
					<ExternalLink className="size-3.5" aria-hidden="true" />
					{t("config.tokendance.detailsLink")}
				</Button>
			</div>

			{/* 安装前的同意弹窗：写入清单 + 平台优势 + 官网入口（争取用户明确同意再落盘） */}
			<Dialog open={confirmOpen} onOpenChange={(open) => (open ? undefined : setConfirmOpen(false))}>
				<DialogContent className="max-w-md">
					<DialogHeader>
						<DialogTitle>{t("config.tokendance.installTitle")}</DialogTitle>
					</DialogHeader>
					<div className="flex flex-col gap-3 text-sm leading-relaxed text-text-secondary">
						<p>{t("config.tokendance.installDesc", { count: catalog.models.length })}</p>
						<ul className="grid gap-1.5 text-xs">
							<li className="flex items-start gap-1.5">
								<span className="mt-0.5 shrink-0 text-[var(--color-accent)]">●</span>
								{t("config.tokendance.advantageOne")}
							</li>
							<li className="flex items-start gap-1.5">
								<span className="mt-0.5 shrink-0 text-[var(--color-accent)]">●</span>
								{t("config.tokendance.advantageTwo")}
							</li>
							<li className="flex items-start gap-1.5">
								<span className="mt-0.5 shrink-0 text-[var(--color-accent)]">●</span>
								{t("config.tokendance.advantageCredit")}
							</li>
						</ul>
						<p className="rounded-sm border border-border-subtle bg-bg-subtle/60 px-2.5 py-2 text-[11px] text-muted-foreground">
							{t("config.tokendance.installWrites")}
						</p>
					</div>
					<DialogFooter className="gap-2">
						<Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
							{t("common.cancel")}
						</Button>
						<Button variant="default" size="sm" onClick={() => void handleInstall()} disabled={installing}>
							{installing ? (
								<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />
							) : (
								<PlugZap className="size-3.5" aria-hidden="true" />
							)}
							{t("config.tokendance.installConfirm")}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<TokenDanceKeyDialog
				open={keyOpen}
				onOpenChange={setKeyOpen}
				onKeyObtained={(apiKey) => void handleInstall(apiKey)}
			/>
		</section>
	);
}
