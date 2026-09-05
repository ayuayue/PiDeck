/**
 * 用量查询配置弹窗（学 cc-switch UsageScriptModal：per-provider 开关 + 预设模板 + 最少字段）。
 *
 * 版式对齐 cc-switch：
 * - 顶部「启用用量查询」开关（命中内置模板默认开，否则默认关）；
 * - 「预设模板」pills：识别到内置模板时只显示该类别（已内置 xxx）＋ 通用模板 ＋ New API；
 *   未识别时只显示 通用模板 ＋ New API（不照抄 cc-switch 全量五类——用户只需要相关的）；
 * - 模板表单区：内置/套餐/官方订阅 = 一行说明，无字段；通用模板 = API Key/请求地址（可选，
 *   留空自动用供应商配置）；New API = 请求地址 + 访问令牌 + 用户 ID；
 * - 超时（秒，默认 10）与自动查询间隔（分钟，默认 5，0 = 不自动）两列；
 * - 「测试」成功即写缓存（三处展示立刻热更）；「保存」按 provider 合并写 usage-probes.json。
 * - 无字段级自定义：脚本/JSON 编辑不开放（用户和我们都不需要）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useAtomValue, useSetAtom } from "jotai";
import { Bot, Eye, EyeOff } from "lucide-react";
import { t } from "../i18n";
import type { TranslationKey } from "../i18n";
import type {
	ProviderUsageResult,
	UsageProbeProviderConfig,
	UsageProbeTemplateCategory,
} from "../../../shared/types/providerUsage";
import { desktopApi } from "../desktopApi";
import { showNotice } from "../utils/notice";
import { invalidateAllProviderUsageAtom, resolveProviderUsageAtom } from "../atoms/provider-usage-atoms";
import { currentSessionIdAtom } from "../atoms/session-atoms";
import { setSessionDraftAtom } from "../atoms/composer-atoms";
import { appendContentToDraft } from "../composerBehavior";
import { usageCacheKey } from "../hooks/useProviderUsage";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../components/ui-shadcn/dialog";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { Switch } from "../components/ui-shadcn/switch";
import { StatefulButton, type ButtonState } from "../components/motion/button";
import { cn } from "../lib/utils";
import { formatUsageBadgeText } from "../utils/providerUsageDisplay";

/** 模板类别 → 展示名 i18n key。 */
const CATEGORY_LABEL_KEY: Record<UsageProbeTemplateCategory, TranslationKey> = {
	balance: "config.usageProbe.category.balance",
	plan: "config.usageProbe.category.plan",
	subscription: "config.usageProbe.category.subscription",
	general: "config.usageProbe.category.general",
	newapi: "config.usageProbe.category.newapi",
	cookie: "config.usageProbe.category.cookie",
};

/** 类别 → 说明文案 i18n key（内置/套餐/订阅无字段，说明即全部）。 */
const CATEGORY_HINT_KEY: Record<UsageProbeTemplateCategory, TranslationKey> = {
	balance: "config.usageProbe.balanceHint",
	plan: "config.usageProbe.planHint",
	subscription: "config.usageProbe.subscriptionHint",
	general: "config.usageProbe.generalHint",
	newapi: "config.usageProbe.newapiHint",
	cookie: "config.usageProbe.cookieHint",
};

/** 模板 id → 类别（内置 templateId 由主进程识别结果给出；声明式三个固定）。 */
const DECLARATIVE_TEMPLATE_CATEGORY: Record<string, UsageProbeTemplateCategory> = {
	general: "general",
	newapi: "newapi",
	cookie: "cookie",
};

/** 「无模板」哨兵：供应商既不适用通用也不适用 New API 时，明确不选任何预设模板。 */
const NONE_TEMPLATE = "none";

/** cc-switch pill 同款样式：选中实心、未选描边灰字。 */
function pillClass(selected: boolean): string {
	return cn(
		"h-7 rounded-lg border px-2.5 text-caption",
		selected
			? "border-transparent bg-[color:var(--color-accent)] font-medium text-white shadow-sm hover:opacity-90"
			: "border-border bg-transparent text-text-secondary hover:bg-bg-hover hover:text-foreground",
	);
}

/** 数字输入（超时/间隔）：非法值回退默认，不阻塞保存。 */
function NumberField(props: {
	label: string;
	value: number;
	onChange: (value: number) => void;
	min: number;
	max: number;
}) {
	return (
		<div className="space-y-1.5">
			<Label className="text-xs font-medium text-foreground">{props.label}</Label>
			<Input
				type="number"
				min={props.min}
				max={props.max}
				value={String(props.value)}
				onChange={(event) => {
					const parsed = Number(event.target.value);
					if (Number.isFinite(parsed)) {
						props.onChange(Math.max(props.min, Math.min(props.max, Math.round(parsed))));
					}
				}}
				className="h-9"
			/>
		</div>
	);
}

/** 凭证覆盖输入（通用模板 API Key / 请求地址；可选覆盖，留空用供应商配置）。 */
function OptionalField(props: {
	label: string;
	placeholder: string;
	value: string;
	onChange: (value: string) => void;
	type?: "text" | "password";
}) {
	return (
		<div className="space-y-1.5">
			<Label className="text-xs font-medium text-foreground">{props.label}</Label>
			<Input
				type={props.type ?? "text"}
				value={props.value}
				onChange={(event) => props.onChange(event.target.value)}
				placeholder={props.placeholder}
				className="h-9"
			/>
		</div>
	);
}

export function UsageProbeConfigDialog(props: {
	open: boolean;
	onClose: () => void;
	/** 供应商名（主进程解析端点与密钥；per-provider 配置的唯一作用域）。 */
	provider: string;
	/** 配置宿主：pi（缺省，~/.pi/agent/usage-probes.json）或 dsh（$DSH_HOME/usage-probes.json）。 */
	backend?: "pi" | "dsh";
	/**
	 * 关闭宿主窗口（设置窗口或独立配置弹窗）：走宿主自己的未保存确认流程，
	 * 供「让 AI 帮我查」写入输入框后回到主会话（缺省只关本弹窗）。
	 */
	onCloseHost?: () => void;
}) {
	const invalidateAll = useSetAtom(invalidateAllProviderUsageAtom);
	const resolveUsage = useSetAtom(resolveProviderUsageAtom);
	// 「让 AI 帮我查」：把提示词写进当前会话的 composer 草稿（无活动会话则回退剪贴板）。
	const currentSessionId = useAtomValue(currentSessionIdAtom);
	const setDraft = useSetAtom(setSessionDraftAtom);
	// 缓存 key：与 useProviderUsage.usageCacheKey 同规则（DSH 链路 dsh: 前缀 + 官方
	// DeepSeek 名归一），保证弹窗「测试成功」写进的缓存与卡片/选择器/圆球的查询共用一份。
	const cacheKey = usageCacheKey(props.provider, props.backend ?? "pi");

	// ── 打开时加载：已保存配置 + 内置模板自动识别 ──
	const [loaded, setLoaded] = useState(false);
	const [loadErrors, setLoadErrors] = useState<string[]>([]);
	const [recognized, setRecognized] = useState<{ templateId: string; category: UsageProbeTemplateCategory } | null>(null);
	/** 选中的模板：内置 templateId（识别命中）或声明式 id（general/newapi）；NONE_TEMPLATE = 无模板。 */
	const [template, setTemplate] = useState<string>(NONE_TEMPLATE);
	const [enabled, setEnabled] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [accessToken, setAccessToken] = useState("");
	const [userId, setUserId] = useState("");
	const [cookie, setCookie] = useState("");
	const [cookiePath, setCookiePath] = useState("");
	const [valuePath, setValuePath] = useState("");
	const [currencyPath, setCurrencyPath] = useState("");
	const [showToken, setShowToken] = useState(false);
	const [timeoutSecs, setTimeoutSecs] = useState(10);
	const [intervalMinutes, setIntervalMinutes] = useState(5);
	const [testState, setTestState] = useState<ButtonState>("idle");
	const [testError, setTestError] = useState("");
	const [testDetail, setTestDetail] = useState("");
	const [testResult, setTestResult] = useState<ProviderUsageResult | null>(null);
	const [saveState, setSaveState] = useState<ButtonState>("idle");
	const [saveError, setSaveError] = useState("");
	// 旧版 probes 数组命中提示（打开时检测；保存迁移后置空）
	const [legacyNotice, setLegacyNotice] = useState("");

	useEffect(() => {
		if (!props.open || !props.provider) return;
		let cancelled = false;
		setLoaded(false);
		setLoadErrors([]);
		setLegacyNotice("");
		// 主进程侧默认值：内置命中 → enabled 默认 true；未命中 → false（用户显式开启才保存）。
		desktopApi.config
			.getUsageProbes(props.provider, props.backend)
			.then((result) => {
				if (cancelled) return;
				const config = result.config;
				setRecognized(result.recognized);
				setEnabled(config?.enabled ?? result.recognized != null);
				setTemplate(config?.template ?? result.recognized?.templateId ?? NONE_TEMPLATE);
				setApiKey(config?.apiKey ?? "");
				setBaseUrl(config?.baseUrl ?? "");
				setAccessToken(config?.accessToken ?? "");
				setUserId(config?.userId ?? "");
				setCookie(config?.cookie ?? "");
				setCookiePath(config?.cookiePath ?? "");
				setValuePath(config?.valuePath ?? "");
				setCurrencyPath(config?.currencyPath ?? "");
				setTimeoutSecs(config?.timeoutSecs ?? 10);
				setIntervalMinutes(config?.intervalMinutes ?? 5);
				setLoadErrors(result.errors);
				// 旧版 probes 数组命中回显：无声明式模板时预选 Cookie 模板并回填字段，
				// 让手写/历史配置可见可迁（保存即转为声明式配置）。
				const legacy = result.legacyProbes ?? [];
				if (legacy.length > 0 && !config?.template) {
					const first = legacy[0];
					const cookieHeader = first.request?.headers?.["Cookie"] ?? first.request?.headers?.cookie ?? "";
					if (cookieHeader) setCookie(cookieHeader);
					if (first.request?.path) setCookiePath(first.request.path);
					// parse 是判别联合：currencyPath 只在 kind "balance" 分支可取。
					const parse = first.parse;
					if (parse?.kind === "balance") {
						if (parse.valuePath) setValuePath(parse.valuePath);
						if (parse.currencyPath) setCurrencyPath(parse.currencyPath);
					}
					const firstNamed = legacy.find((item) => item.name)?.name;
					setLegacyNotice(
						t("config.usageProbe.legacyDetected", {
							count: String(legacy.length),
							name: firstNamed ?? t("config.usageProbe.legacyUnnamed"),
						}),
					);
					setTemplate("cookie");
				}
				setLoaded(true);
			})
			.catch((error) => {
				if (cancelled) return;
				setLoadErrors([t("config.usageProbe.loadFailed", { error: String(error) })]);
				setLoaded(true);
			});
		return () => {
			cancelled = true;
		};
	}, [props.open, props.provider, props.backend]);

	// 关闭时重置瞬时状态（每次打开重新加载，弹窗不跨会话保留草稿）。
	const resetInstant = useCallback(() => {
		setTestState("idle");
		setTestError("");
		setTestDetail("");
		setTestResult(null);
		setSaveState("idle");
		setSaveError("");
		setShowToken(false);
	}, []);
	const handleClose = useCallback(() => {
		resetInstant();
		props.onClose();
	}, [props.onClose, resetInstant]);

	/** 兜底模板幂等校验：既没有内置识别也没有选中任何模板时提示保存失败。
	 * 「无模板」（NONE_TEMPLATE）返回 null——表示不配置任何预设模板，
	 * 保存时只写开关/超时/间隔，查询走内置候选 + 旧探针自动匹配。 */
	const currentTemplate = useMemo((): { id: string; category: UsageProbeTemplateCategory } | null => {
		if (template === NONE_TEMPLATE) return null;
		if (template === "general" || template === "newapi" || template === "cookie") {
			return { id: template, category: DECLARATIVE_TEMPLATE_CATEGORY[template] };
		}
		if (recognized && recognized.templateId === template) {
			return { id: template, category: recognized.category };
		}
		return null;
	}, [template, recognized]);

	/** 测试：按当前选中模板 + 覆盖字段发请求（主进程解析端点与密钥）。无模板时不可测试。 */
	const runTest = async () => {
		setTestError("");
		setTestDetail("");
		setTestResult(null);
		const current = currentTemplate;
		if (!current) {
			// 无模板：没有可探测的端点，提示而非报「测试失败」（用户主动选了无模板）。
			setTestState("error");
			setTestError(t("config.usageProbe.noneNoTest"));
			return;
		}
		setTestState("loading");
		try {
			const result = await desktopApi.config.testUsageProbe({
				provider: props.provider,
				backend: props.backend,
				template: current.id,
				...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
				...(baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}),
				...(accessToken.trim() ? { accessToken: accessToken.trim() } : {}),
				...(userId.trim() ? { userId: userId.trim() } : {}),
				...(cookie.trim() ? { cookie: cookie.trim() } : {}),
				...(cookiePath.trim() ? { cookiePath: cookiePath.trim() } : {}),
				...(valuePath.trim() ? { valuePath: valuePath.trim() } : {}),
				...(currencyPath.trim() ? { currencyPath: currencyPath.trim() } : {}),
				...(timeoutSecs !== 10 ? { timeoutSecs } : {}),
			});
			setTestResult(result);
			setTestState(result.success ? "success" : "error");
			if (result.success) {
				// 测试成功直接写缓存（等价 cc-switch 的 queryClient.setQueryData），
				// 圆环/卡片/选择器三处立刻显示这次测试到的真实数值。
				resolveUsage(cacheKey, result);
				const summary = formatUsageBadgeText(result);
				showNotice(
					summary
						? t("config.usageProbe.testSuccessWith", { value: summary })
						: t("config.usageProbe.testSuccess"),
					3000,
					"info",
				);
			} else {
				setTestError(result.error ?? t("config.usageProbe.testFailed"));
				// 主进程带上的排查明细（尝试过的 URL + 状态 + 提示），多行展示方便定位问题。
				setTestDetail(result.detail ?? "");
			}
		} catch (error) {
			setTestState("error");
			setTestError(error instanceof Error ? error.message : String(error));
		}
	};

	/** 保存：按 provider 合并写（内置命中可只存开关与频率；声明式模板带覆盖字段）。
	 * 「无模板」= 只写 enabled/超时/间隔，不写 template（查询走内置 + 旧探针自动匹配）。 */
	const runSave = async () => {
		setSaveError("");
		const isNone = template === NONE_TEMPLATE;
		const current = currentTemplate;
		if (!isNone && !current) {
			setSaveState("error");
			setSaveError(t("config.usageProbe.saveFailed"));
			return;
		}
		const config: UsageProbeProviderConfig = {
			enabled,
			timeoutSecs,
			intervalMinutes,
		};
		// 内置识别命中 / 无模板：不写 template（自动路由）；声明式：写模板 id + 模板字段。
		if (!isNone && current && (current.id === "general" || current.id === "newapi" || current.id === "cookie")) {
			config.template = current.id;
			if (current.id === "general") {
				if (apiKey.trim()) config.apiKey = apiKey.trim();
				if (baseUrl.trim()) config.baseUrl = baseUrl.trim();
			} else if (current.id === "newapi") {
				if (baseUrl.trim()) config.baseUrl = baseUrl.trim();
				if (!accessToken.trim() || !userId.trim()) {
					setSaveState("error");
					setSaveError(
						accessToken.trim()
							? t("config.usageProbe.newApiUserIdRequired")
							: t("config.usageProbe.newApiTokenRequired"),
					);
					return;
				}
				config.accessToken = accessToken.trim();
				config.userId = userId.trim();
			} else {
				if (baseUrl.trim()) config.baseUrl = baseUrl.trim();
				if (!cookie.trim() || !cookiePath.trim() || !valuePath.trim()) {
					setSaveState("error");
					setSaveError(
						!cookie.trim()
							? t("config.usageProbe.cookieRequired")
							: !cookiePath.trim()
								? t("config.usageProbe.cookiePathRequired")
								: t("config.usageProbe.cookieValuePathRequired"),
					);
					return;
				}
				config.cookie = cookie.trim();
				config.cookiePath = cookiePath.trim();
				config.valuePath = valuePath.trim();
				if (currencyPath.trim()) config.currencyPath = currencyPath.trim();
			}
		}
		setSaveState("loading");
		try {
			const result = await desktopApi.config.saveUsageProbes({
				provider: props.provider,
				backend: props.backend,
				config,
			});
			if (result.ok) {
				setSaveState("success");
				// 保存成功 → 清全部用量缓存，三处随即重查出新配置的效果。
				invalidateAll();
				window.setTimeout(handleClose, 600);
			} else {
				setSaveState("error");
				setSaveError(result.error ?? t("config.usageProbe.saveFailed"));
			}
		} catch (error) {
			setSaveState("error");
			setSaveError(error instanceof Error ? error.message : String(error));
		}
	};

	/**
	 * 「让 AI 帮我查接口文档」：装技能 → 关闭弹窗与宿主窗口 → 提示词写进主会话输入框
	 * （复用并行问询「插入主会话输入框」同一条 setSessionDraftAtom 通道，只填草稿不发送）。
	 * 提示词模板带 provider 与配置路径（pi/DSH 的 usage-probes.json 位置不同），AI 拿到即可开工；
	 * 无活动会话（引导页）退回剪贴板兜底，不关窗口。
	 */
	const aiAssist = async () => {
		const prompt = t("config.usageProbe.aiPrompt", {
			provider: props.provider,
			configPath: props.backend === "dsh" ? "$DSH_HOME/usage-probes.json" : "~/.pi/agent/usage-probes.json",
		});
		try {
			await desktopApi.config.installUsageSkill();
			const sessionId = currentSessionId;
			if (!sessionId) {
				await navigator.clipboard.writeText(prompt);
				showNotice(t("config.usageProbe.aiAssistCopiedOnly"), 6000, "info");
				return;
			}
			setDraft({ sessionId, value: (current) => appendContentToDraft(current, prompt) });
			props.onClose();
			props.onCloseHost?.();
			showNotice(t("config.usageProbe.aiAssistInserted"), 5000, "info");
		} catch {
			showNotice(t("config.usageProbe.saveFailed"), 4000, "error");
		}
	};

	const testSummary = useMemo(() => {
		if (!testResult) return "";
		if (!testResult.success) return testResult.error ?? t("config.usageProbe.testFailed");
		return formatUsageBadgeText(testResult) ?? t("config.usageProbe.testSuccess");
	}, [testResult]);

	// 当前选中类别的说明文案（内置/套餐/订阅 = 无字段说明；通用/NewAPI = 表单区上方提示）。
	const hintKey = currentTemplate ? CATEGORY_HINT_KEY[currentTemplate.category] : null;

	if (!props.open) return null;

	return (
		<Dialog open onOpenChange={(next) => !next && handleClose()}>
			<DialogContent className="max-h-[85vh] flex flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
				<DialogHeader className="px-5 pt-4 pb-2">
					<DialogTitle>
						{t("config.usageProbe.titleWithProvider", { provider: props.provider })}
						{props.backend === "dsh" ? t("config.usageProbe.dshSuffix") : null}
					</DialogTitle>
				</DialogHeader>
				<div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 pb-3">
					{!loaded ? (
						<div className="py-4 text-center text-caption text-text-tertiary">{t("common.loading")}</div>
					) : (
						<>
							{loadErrors.length > 0 && (
								<div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-caption leading-relaxed text-amber-600 dark:text-amber-400">
									{loadErrors.join("\n")}
								</div>
							)}
							{legacyNotice && (
								<div
									className="rounded-md border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-caption leading-relaxed text-sky-600 dark:text-sky-400"
									data-testid="usage-probe-legacy-notice"
								>
									{legacyNotice}
								</div>
							)}

							{/* 启用开关（cc-switch 同款：整行右侧 Switch） */}
							<div className="flex items-center justify-between rounded-lg border border-border px-3.5 py-2.5">
								<span className="text-sm font-medium text-foreground">{t("config.usageProbe.enable")}</span>
								<Switch checked={enabled} onCheckedChange={setEnabled} data-testid="usage-probe-enable" />
							</div>

							{/* 预设模板：识别命中只显示「已内置」+ 通用 + NewAPI；未识别只显示通用 + NewAPI */}
							<section className="space-y-1.5">
								<p className="text-sm font-medium text-foreground">{t("config.usageProbe.templatesTitle")}</p>
								<div className="flex flex-wrap gap-1.5">
									<button
										type="button"
										className={pillClass(template === NONE_TEMPLATE)}
										onClick={() => setTemplate(NONE_TEMPLATE)}
										data-testid="usage-probe-template-none"
									>
										{t("config.usageProbe.category.none")}
									</button>
									{recognized && (
										<button
											type="button"
											className={pillClass(template === recognized.templateId)}
											onClick={() => setTemplate(recognized.templateId)}
											data-testid="usage-probe-template-builtin"
										>
											{t("config.usageProbe.builtin", { label: t(CATEGORY_LABEL_KEY[recognized.category]) })}
										</button>
									)}
									<button
										type="button"
										className={pillClass(template === "general")}
										onClick={() => setTemplate("general")}
										data-testid="usage-probe-template-general"
									>
										{t("config.usageProbe.category.general")}
									</button>
									<button
										type="button"
										className={pillClass(template === "newapi")}
										onClick={() => setTemplate("newapi")}
										data-testid="usage-probe-template-newapi"
									>
										{t("config.usageProbe.category.newapi")}
									</button>
									<button
										type="button"
										className={pillClass(template === "cookie")}
										onClick={() => setTemplate("cookie")}
										data-testid="usage-probe-template-cookie"
									>
										{t("config.usageProbe.category.cookie")}
									</button>
								</div>
								{template === NONE_TEMPLATE && (
									<p className="px-0.5 text-caption text-text-tertiary" data-testid="usage-probe-none-hint">
										{t("config.usageProbe.noneHint")}
									</p>
								)}
								{hintKey && (
									<div className="flex flex-col gap-2">
										{recognized && template === recognized.templateId && (
											/* 已识别供应商徽标（学 cc-switch DeepSeek 蓝标）：明确「预制的是你」，
											   让「内置模板」与「需要填字段的模板」一眼区分开 */
											<span
												className="inline-flex flex-none items-center rounded border border-[var(--color-accent)]/40 bg-[var(--color-accent)]/10 px-1.5 py-0.5 font-mono text-micro leading-none tracking-wide text-[var(--color-accent)]"
												data-testid="usage-probe-recognized-badge"
											>
												{props.provider}
											</span>
										)}
										<p className="px-0.5 text-caption text-text-tertiary">
											{recognized && template === recognized.templateId
												? t("config.usageProbe.builtinHint")
												: t(hintKey)}
										</p>
									</div>
								)}
							</section>

							{/* 模板字段区：仅声明式模板有字段；内置/套餐/订阅零字段 */}
							{currentTemplate?.id === "general" && (
								<section className="space-y-3">
									<div className="grid grid-cols-2 gap-3">
										<OptionalField
											label={t("config.usageProbe.credentialApiKey")}
											placeholder={t("config.usageProbe.credentialApiKeyPlaceholder")}
											value={apiKey}
											onChange={setApiKey}
										/>
										<OptionalField
											label={t("config.usageProbe.credentialBaseUrl")}
											placeholder={t("config.usageProbe.credentialBaseUrlPlaceholder")}
											value={baseUrl}
											onChange={setBaseUrl}
										/>
									</div>
								</section>
							)}
							{currentTemplate?.id === "newapi" && (
								<section className="space-y-3">
									<div className="grid grid-cols-2 gap-3">
										<OptionalField
											label={t("config.usageProbe.credentialBaseUrl")}
											placeholder={t("config.usageProbe.credentialBaseUrlPlaceholder")}
											value={baseUrl}
											onChange={setBaseUrl}
										/>
										<div className="space-y-1.5">
											<div className="flex items-center justify-between">
												<Label className="text-xs font-medium text-foreground">{t("config.usageProbe.newApiToken")}</Label>
												<button
													type="button"
													className="inline-flex items-center gap-1 text-micro text-text-tertiary transition-colors hover:text-foreground"
													onClick={() => setShowToken((value) => !value)}
												>
													{showToken ? <EyeOff size={12} /> : <Eye size={12} />}
													{showToken ? t("config.usageProbe.hideKey") : t("config.usageProbe.showKey")}
												</button>
											</div>
											<Input
												type={showToken ? "text" : "password"}
												value={accessToken}
												onChange={(event) => setAccessToken(event.target.value)}
												placeholder={t("config.usageProbe.newApiTokenPlaceholder")}
												className="h-9"
											/>
										</div>
									</div>
									<OptionalField
										label={t("config.usageProbe.newApiUserId")}
										placeholder={t("config.usageProbe.newApiUserIdPlaceholder")}
										value={userId}
										onChange={setUserId}
									/>
								</section>
							)}


							{currentTemplate?.id === "cookie" && (
								<section className="space-y-3">
									<div className="grid grid-cols-2 gap-3">
										<div className="space-y-1.5">
											<div className="flex items-center justify-between">
												<Label className="text-xs font-medium text-foreground">{t("config.usageProbe.cookieLabel")}</Label>
												<button
													type="button"
													className="inline-flex items-center gap-1 text-micro text-text-tertiary transition-colors hover:text-foreground"
													onClick={() => setShowToken((value) => !value)}
												>
													{showToken ? <EyeOff size={12} /> : <Eye size={12} />}
													{showToken ? t("config.usageProbe.hideKey") : t("config.usageProbe.showKey")}
												</button>
											</div>
											<Input
												type={showToken ? "text" : "password"}
												value={cookie}
												onChange={(event) => setCookie(event.target.value)}
												placeholder={t("config.usageProbe.cookiePlaceholder")}
												className="h-9"
											/>
										</div>
										<OptionalField
											label={t("config.usageProbe.credentialBaseUrl")}
											placeholder={t("config.usageProbe.credentialBaseUrlPlaceholder")}
											value={baseUrl}
											onChange={setBaseUrl}
										/>
									</div>
									<OptionalField
										label={t("config.usageProbe.cookiePathLabel")}
										placeholder={t("config.usageProbe.cookiePathPlaceholder")}
										value={cookiePath}
										onChange={setCookiePath}
									/>
									<div className="grid grid-cols-2 gap-3">
										<OptionalField
											label={t("config.usageProbe.cookieValuePathLabel")}
											placeholder={t("config.usageProbe.cookieValuePathPlaceholder")}
											value={valuePath}
											onChange={setValuePath}
										/>
										<OptionalField
											label={t("config.usageProbe.cookieCurrencyPathLabel")}
											placeholder={t("config.usageProbe.cookieCurrencyPathPlaceholder")}
											value={currencyPath}
											onChange={setCurrencyPath}
										/>
									</div>
								</section>
							)}
							{/* 超时 / 自动查询间隔（cc-switch 同款两列） */}
							<div className="grid grid-cols-2 gap-3">
								<NumberField
									label={t("config.usageProbe.timeout")}
									value={timeoutSecs}
									onChange={setTimeoutSecs}
									min={1}
									max={300}
								/>
								<NumberField
									label={t("config.usageProbe.interval")}
									value={intervalMinutes}
									onChange={setIntervalMinutes}
									min={0}
									max={1440}
								/>
							</div>

							{/* 测试（cc-switch 测试按钮 + 内联结果）：成功即写缓存热更三处 */}
							<section className="space-y-2 border-t border-border pt-3">
								<div className="flex items-center gap-2.5">
									<StatefulButton
										variant="outline"
										state={testState}
										onClick={() => void runTest()}
										loadingText={t("config.usageProbe.testing")}
										successText={t("config.usageProbe.testSuccess")}
										errorText={t("config.usageProbe.testFailed")}
										// motion 按钮默认 rounded-full 胶囊：配置表单调成圆角矩形（对齐 cc-switch 输入框观感）
										className="h-8 rounded-md px-3 text-xs"
									>
										{t("config.usageProbe.test")}
									</StatefulButton>
									{testState === "error" && testError && (
										<span className="min-w-0 flex-1 truncate text-caption text-destructive" title={testError}>
											{testError}
										</span>
									)}
									{testSummary && testState !== "error" && (
										<span className="min-w-0 flex-1 truncate text-caption text-foreground" title={testSummary}>
											{testSummary}
										</span>
									)}
								</div>
								{testState === "error" && testDetail && (
									// 失败明细：URL/状态/提示多行列表（已脱敏），平铺展示便于排查地址与鉴权问题。
									<div className="w-full overflow-hidden rounded-md border border-border/60 bg-background/60 px-2 py-1.5" data-testid="usage-probe-test-detail">
										<pre className="max-h-44 overflow-auto whitespace-pre-wrap break-all font-mono text-micro leading-relaxed text-text-secondary">
											{testDetail}
										</pre>
									</div>
								)}
							</section>
						</>
					)}
				</div>

				<div className="flex items-center gap-2 border-t border-border px-5 py-3">
					<Button variant="ghost" size="sm" onClick={() => void aiAssist()} title={t("config.usageProbe.aiAssistTitle")}>
						<Bot size={14} />
						{t("config.usageProbe.aiAssist")}
					</Button>
					<div className="ml-auto flex items-center gap-2">
						<Button variant="ghost" size="sm" onClick={handleClose}>
							{t("common.cancel")}
						</Button>
						{loaded && (
							<StatefulButton
								state={saveState}
								onClick={() => void runSave()}
								loadingText={t("config.usageProbe.saving")}
								successText={t("config.usageProbe.savedDone")}
								errorText={saveError || t("config.usageProbe.saveFailed")}
								// motion 按钮默认 rounded-full 胶囊：保存按钮对齐圆角矩形（取消按钮同款）
								className="h-8 rounded-md px-3 text-xs"
							>
								{t("config.usageProbe.save")}
							</StatefulButton>
						)}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
