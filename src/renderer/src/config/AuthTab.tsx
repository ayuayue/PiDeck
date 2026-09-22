import { Button } from "../components/ui-shadcn/button";
import { useCallback, useEffect, useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronRight, Copy, ExternalLink, Eye, EyeOff, GripVertical, Trash2 } from "lucide-react";
import { t } from "../i18n";
import type { AuthFile, ModelsFile } from "./configTypes";
import { ConfigSelect, openDocsInSystemBrowser, SecretInput } from "./ConfigShared";
import { Input } from "../components/ui-shadcn/input";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Label } from "../components/ui-shadcn/label";
import { ProviderMigrationButton } from "./ProviderMigrationButton";
import { ProviderUsageInline } from "../components/app/ProviderUsageInline";
import { UsageQueryEntryButton } from "../components/app/UsageQueryEntryButton";
import { applyProviderOrder } from "../utils/providerOrder";
import { useProviderReorder } from "../hooks/useProviderReorder";

// 根据 pi 官方文档支持的供应商列表 (https://pi.dev/docs/latest/providers#auth-file)
const PRESET_PROVIDERS = [
	{ value: "anthropic", label: "Anthropic", env: "ANTHROPIC_API_KEY", url: "https://console.anthropic.com/" },
	{ value: "openai", label: "OpenAI", env: "OPENAI_API_KEY", url: "https://platform.openai.com/api-keys" },
	{ value: "google", label: "Google Gemini", env: "GEMINI_API_KEY", url: "https://aistudio.google.com/apikey" },
	{ value: "deepseek", label: "DeepSeek", env: "DEEPSEEK_API_KEY", url: "https://platform.deepseek.com/api_keys" },
	{ value: "mistral", label: "Mistral", env: "MISTRAL_API_KEY", url: "https://console.mistral.ai/api-keys/" },
	{ value: "nvidia", label: "NVIDIA NIM", env: "NVIDIA_API_KEY", url: "https://build.nvidia.com/explore/discover" },
	{ value: "xai", label: "xAI (Grok)", env: "XAI_API_KEY", url: "https://console.x.ai/" },
	{ value: "groq", label: "Groq", env: "GROQ_API_KEY", url: "https://console.groq.com/keys" },
	{ value: "cerebras", label: "Cerebras", env: "CEREBRAS_API_KEY", url: "https://cloud.cerebras.ai/" },
	{ value: "openrouter", label: "OpenRouter", env: "OPENROUTER_API_KEY", url: "https://openrouter.ai/keys" },
	{ value: "together", label: "Together AI", env: "TOGETHER_API_KEY", url: "https://api.together.ai/" },
	{ value: "fireworks", label: "Fireworks AI", env: "FIREWORKS_API_KEY", url: "https://fireworks.ai/api-keys" },
	{ value: "huggingface", label: "Hugging Face", env: "HF_TOKEN", url: "https://huggingface.co/settings/tokens" },
	{ value: "ant-ling", label: "Ant Ling (蚂蚁灵想)", env: "ANT_LING_API_KEY", url: "" },
	{ value: "cloudflare-ai-gateway", label: "Cloudflare AI Gateway", env: "CLOUDFLARE_API_KEY", url: "https://dash.cloudflare.com/" },
	{ value: "cloudflare-workers-ai", label: "Cloudflare Workers AI", env: "CLOUDFLARE_API_KEY", url: "https://dash.cloudflare.com/" },
	{ value: "vercel-ai-gateway", label: "Vercel AI Gateway", env: "AI_GATEWAY_API_KEY", url: "https://vercel.com/" },
	{ value: "azure-openai-responses", label: "Azure OpenAI", env: "AZURE_OPENAI_API_KEY", url: "https://portal.azure.com/" },
	{ value: "zai", label: "Z.AI", env: "ZAI_API_KEY", url: "" },
	{ value: "zai-coding-cn", label: "Z.AI Coding (China)", env: "ZAI_CODING_CN_API_KEY", url: "" },
	{ value: "opencode", label: "OpenCode Zen", env: "OPENCODE_API_KEY", url: "" },
	{ value: "opencode-go", label: "OpenCode Go", env: "OPENCODE_API_KEY", url: "" },
	{ value: "kimi-coding", label: "Kimi For Coding", env: "KIMI_API_KEY", url: "" },
	{ value: "minimax", label: "MiniMax", env: "MINIMAX_API_KEY", url: "" },
	{ value: "minimax-cn", label: "MiniMax (China)", env: "MINIMAX_CN_API_KEY", url: "" },
	{ value: "xiaomi", label: "Xiaomi MiMo", env: "XIAOMI_API_KEY", url: "" },
	{ value: "xiaomi-token-plan-cn", label: "Xiaomi MiMo Token (China)", env: "XIAOMI_TOKEN_PLAN_CN_API_KEY", url: "" },
	{ value: "xiaomi-token-plan-ams", label: "Xiaomi MiMo Token (Amsterdam)", env: "XIAOMI_TOKEN_PLAN_AMS_API_KEY", url: "" },
	{ value: "xiaomi-token-plan-sgp", label: "Xiaomi MiMo Token (Singapore)", env: "XIAOMI_TOKEN_PLAN_SGP_API_KEY", url: "" },
	// 0.86/0.86.1 新增 provider：Meta 走 META_API_KEY（订阅也可用 pi 的 /login meta）；
	// Radius 只有 OAuth（在 pi 终端执行 /login radius 写入 auth.json），这里保留卡片是为了
	// 让用户知道 provider 名与文档入口，env 列因此标 oauth 而不是具体环境变量名。
	{ value: "meta", label: "Meta (Muse)", env: "META_API_KEY", url: "https://pi.dev/docs/latest/providers#meta-muse-subscription" },
	{ value: "radius", label: "Radius (OAuth)", env: "oauth", url: "https://pi.dev/docs/latest/providers#radius" },
];

// 认证类型选项（auth.json credential.type）：pi 只识别 api_key 与 oauth。
// - api_key：auth.json 标准 credential（key 支持 $ENV 插值 / !command / 字面量）；
// - oauth：由 /login 订阅流（Claude/Codex/Copilot/Radius 等）自动写入并刷新，
//   人工录入无意义但保留选项以反映 pi 真实支持面（避免显示错误值后无法回退）。
// oauth2/bearer/basic 是 OpenAI SDK 风格的 auth 类型，pi 不识别，已移除。
const AUTH_TYPE_OPTIONS = [
	{ value: "api_key", label: "api_key" },
	{ value: "oauth", label: "oauth" },
];

export function AuthTab(props: {
	data: AuthFile;
	expandedAuth: string | null;
	addingAuth: boolean;
	newAuthName: string;
	saving: boolean;
	/** 已配置的模型/服务商数据，用于 provider / model 下拉选项 */
	modelsData?: ModelsFile;
	/** 用户隐藏的认证供应商列表 */
	hiddenAuthProviders?: string[];
	/** 供应商自定义顺序（AppSettings.providerOrder）：与模型页共用同一份排序，两页列表顺序一致。 */
	providerOrder?: string[];
	/** 排序作用域：与模型页共享的并集顺序（由父级用 models.json + auth.json 算出）。 */
	providerOrderScope?: string[];
	/** 卡片重排回调（与模型页同一个出口，父级持久化到 AppSettings.providerOrder）。 */
	onReorderProviders?: (nextOrder: string[]) => void;
	/** 清空自定义顺序（列表上方的「恢复默认顺序」）。 */
	onResetProviders?: () => void;
	/** 切换认证供应商隐藏状态 */
	onToggleHiddenAuthProvider?: (name: string) => void;
	onToggleAuth: (name: string) => void;
	onStartAddAuth: () => void;
	onCancelAddAuth: () => void;
	onChangeNewAuthName: (name: string) => void;
	onConfirmAddAuth: (name?: string, key?: string) => void;
	onDuplicateAuth: (provider: string) => void;
	onDeleteAuth: (provider: string) => void;
	onDeleteAuths: (providers: string[]) => void;
	onUpdate: (provider: string, field: string, value: string) => void;
	onSave: () => void;
	/** 打开用量查询配置弹窗（与模型页共用同一个 per-provider 弹窗；认证展开区的探查设置入口）。 */
	onOpenUsageProbeDialog: (providerName: string) => void;
}) {
	const { data, expandedAuth, saving, hiddenAuthProviders = [], onToggleHiddenAuthProvider } = props;
	// 供应商顺序沿用模型页的自定义排序：applyProviderOrder 把未列出的供应商按原序追加在后，不会漏项。
	const allProviders = applyProviderOrder(Object.keys(data), props.providerOrder);
	const hiddenAuthSet = new Set(hiddenAuthProviders);
	const visibleProviders = allProviders.filter((name) => !hiddenAuthSet.has(name));
	const hiddenProviderNames = allProviders.filter((name) => hiddenAuthSet.has(name));

	/**
	 * 拖拽/上移下移的统一出口：算出新的完整顺序交给父级持久化（与模型页共用一份）。
	 * 顺序没变（拖回原位）也照常上报，由主进程 SettingsStore 的「值未变则剔除」拦下写盘。
	 */
	const reorderProviders = useCallback((nextOrder: string[]) => props.onReorderProviders?.(nextOrder), [props.onReorderProviders]);
	// 作用域用「模型 + 认证」的并集（父级传入）：只传本页列表的话，在认证页拖动会把模型页独有的
	// 供应商从顺序里踢出去，模型页的顺序就跟着回到默认了。
	const providerReorder = useProviderReorder({ names: props.providerOrderScope?.length ? props.providerOrderScope : allProviders, visibleNames: visibleProviders, onReorder: reorderProviders });

	const [hiddenSectionOpen, setHiddenSectionOpen] = useState(false);
	const [selectingProvider, setSelectingProvider] = useState(false);
	const [selectedProvider, setSelectedProvider] = useState("");
	const [customProviderName, setCustomProviderName] = useState("");
	const [newAuthKey, setNewAuthKey] = useState("");
	const [showGuide, setShowGuide] = useState(false);
	const [batchMode, setBatchMode] = useState(false);
	const [selectedAuths, setSelectedAuths] = useState(new Set());

	// 从预设列表获取供应商信息
	const presetProvider = selectedProvider ? PRESET_PROVIDERS.find((p) => p.value === selectedProvider) : undefined;

	return (
		<div className="config-auth-tab">
			<div className="mb-3 flex items-center justify-between gap-3">
				<span className="font-mono text-xs tabular-nums text-text-tertiary">{t("config.count.auth", { count: allProviders.length })}</span>
				<div className="flex min-w-0 items-center gap-1.5">
					<Button
						size="sm"
						variant="outline"
						onClick={() => {
							setSelectingProvider(true);
							setSelectedProvider("");
							setCustomProviderName("");
							setNewAuthKey("");
						}}
						disabled={saving}
					>
						{t("config.addAuth")}
					</Button>
					<Button size="sm" variant="outline" onClick={() => setShowGuide(!showGuide)} disabled={saving}>
						{t("config.authGuide")}
					</Button>
					<Button
						size="sm"
						variant="destructive"
						onClick={() => {
							if (batchMode) {
								setBatchMode(false);
								setSelectedAuths(new Set());
							} else {
								setBatchMode(true);
							}
						}}
						disabled={saving || allProviders.length === 0}
					>
						{batchMode ? t("common.cancel") : t("common.deleteBatch")}
					</Button>
					{batchMode && (
						<Button
							size="sm"
							variant="destructive"
							onClick={() => {
								if (selectedAuths.size > 0) {
									props.onDeleteAuths([...selectedAuths] as string[]);
									setSelectedAuths(new Set());
									setBatchMode(false);
								}
							}}
							disabled={selectedAuths.size === 0}
						>
							{t("common.deleteSelected")} ({selectedAuths.size})
						</Button>
					)}
				</div>
			</div>

			{/* 排序说明：与模型页共用同一份顺序，写明白用户才知道拖完为什么另一页也跟着变 */}
			{visibleProviders.length > 1 && (
				<div className="mb-2.5 flex items-start gap-2 text-[11px] leading-relaxed text-text-tertiary">
					<ArrowUpDown size={12} className="mt-0.5 shrink-0" aria-hidden="true" />
					<span className="min-w-0 flex-1">{t("config.providerOrderHint")}</span>
					{(props.providerOrder?.length ?? 0) > 0 && props.onResetProviders && (
						<Button variant="ghost" size="sm" className="h-5 shrink-0 px-1.5 text-[11px] font-normal text-text-tertiary hover:text-text-primary" onClick={props.onResetProviders} disabled={saving}>
							{t("config.providerOrderReset")}
						</Button>
					)}
				</div>
			)}

			{/* 使用引导 */}
			{showGuide && (
				<div className="mb-4 rounded-md border border-border-subtle bg-bg-subtle p-4">
					<div className="mb-2.5 flex items-center justify-between">
						<strong className="text-sm text-text-primary">{t("config.authGuideTitle")}</strong>
						<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setShowGuide(false)}>
							×
						</Button>
					</div>
					<div className="text-xs leading-relaxed text-text-secondary">
						<p>{t("config.authGuideDesc")}</p>
						<ul className="my-2 list-disc pl-5">
							<li className="mb-1">{t("config.authGuideStep1")}</li>
							<li className="mb-1">{t("config.authGuideStep2")}</li>
							<li className="mb-1">{t("config.authGuideStep3")}</li>
						</ul>
						<p className="mt-3 border-t border-border-subtle pt-2.5 text-text-tertiary">
							{t("config.authGuideNote")}{" "}
							<a href="https://pi.dev/docs/latest/providers#auth-file" onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/providers#auth-file")} className="inline-flex items-center gap-0.5 text-[color:var(--color-accent)] no-underline">
								pi docs <ExternalLink size={12} />
							</a>
						</p>
					</div>
				</div>
			)}

			{/* 选择供应商弹窗 */}
			{selectingProvider && (
				<div className="mb-4 rounded-lg border border-border-default bg-bg-panel p-4 shadow-[0_4px_12px_color-mix(in_srgb,var(--color-text-primary)_8%,transparent)]">
					<div className="mb-3 flex items-center justify-between border-b border-border-subtle pb-2.5">
						<strong className="text-sm text-text-primary">{t("config.authSelectProvider")}</strong>
						<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setSelectingProvider(false)}>
							×
						</Button>
					</div>
					<div className="grid max-h-[320px] grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-1.5 overflow-y-auto">
						{PRESET_PROVIDERS.map((provider) => {
							const alreadyConfigured = allProviders.includes(provider.value);
							const isSelected = selectedProvider === provider.value;
							return (
								<button
									key={provider.value}
									type="button"
									className={`group relative flex cursor-pointer flex-col items-start rounded-md border p-3 text-left text-xs transition-all duration-150 ${
										isSelected
											? "border-[var(--color-accent)] bg-[color:color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg-panel))] shadow-[0_0_0_1px_var(--color-accent)]"
											: "border-border-subtle bg-bg-muted hover:border-[var(--color-accent)] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_5%,var(--color-bg-panel))]"
									}${alreadyConfigured ? " opacity-75" : ""}`}
									onClick={() => {
										setSelectedProvider(provider.value);
										setCustomProviderName("");
									}}
								>
									<div className="flex w-full items-center justify-between gap-1.5">
										<span className={`font-medium ${isSelected ? "text-[color:var(--color-accent)]" : "text-text-primary"}`}>{provider.label}</span>
										{isSelected && (
											<span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-accent)] text-white">
												<Check size={11} strokeWidth={3} aria-hidden="true" />
											</span>
										)}
									</div>
									<span className="mt-0.5 font-mono text-[11px] text-text-tertiary">{provider.value}</span>
									{alreadyConfigured && <span className="mt-1.5 rounded-[4px] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-1.5 py-px text-[11px] text-[color:var(--color-accent)]">{t("config.configured")}</span>}
								</button>
							);
						})}
						{/* 从 models.json 读取已配置的服务商 */}
						{props.modelsData && Object.keys(props.modelsData.providers).length > 0 && (
							<>
								<div className="col-span-full my-1 flex items-center gap-2 text-xs text-text-tertiary">
									<span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
									<span>{t("config.authFromModels")}</span>
									<span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
								</div>
								{applyProviderOrder(Object.keys(props.modelsData.providers), props.providerOrder).map((providerName) => {
									const alreadyConfigured = allProviders.includes(providerName);
									const isSelected = selectedProvider === providerName;
									return (
										<button
											key={providerName}
											type="button"
											className={`group relative flex cursor-pointer flex-col items-start rounded-md border p-3 text-left text-xs transition-all duration-150 ${
												isSelected
													? "border-[var(--color-accent)] bg-[color:color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg-panel))] shadow-[0_0_0_1px_var(--color-accent)]"
													: "border-border-subtle bg-bg-muted hover:border-[var(--color-accent)] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_5%,var(--color-bg-panel))]"
											}${alreadyConfigured ? " opacity-75" : ""}`}
											onClick={() => {
												setSelectedProvider(providerName);
												setCustomProviderName("");
											}}
										>
											<div className="flex w-full items-center justify-between gap-1.5">
												<span className={`font-medium ${isSelected ? "text-[color:var(--color-accent)]" : "text-text-primary"}`}>{providerName}</span>
												{isSelected && (
													<span className="flex size-4 shrink-0 items-center justify-center rounded-full bg-[color:var(--color-accent)] text-white">
														<Check size={11} strokeWidth={3} aria-hidden="true" />
													</span>
												)}
											</div>
											<span className="mt-0.5 font-mono text-[11px] text-text-tertiary">{t("config.fromModels")}</span>
											{alreadyConfigured && <span className="mt-1.5 rounded-[4px] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-1.5 py-px text-[11px] text-[color:var(--color-accent)]">{t("config.configured")}</span>}
										</button>
									);
								})}
							</>
						)}
					</div>
					<div className="mt-3 border-t border-border-subtle pt-3">
						<p className="m-0 flex items-center gap-2 text-xs text-text-tertiary">
							<span className="shrink-0 whitespace-nowrap">{t("config.authCustomHint")}</span>
							<Input
								value={customProviderName}
								onChange={(e) => {
									setCustomProviderName(e.target.value);
									if (e.target.value) setSelectedProvider("");
								}}
								placeholder={t("config.authCustomPlaceholder")}
								className="h-8 min-w-0 flex-1 rounded-sm border border-border-default bg-bg-muted px-2.5 text-control text-text-primary outline-none focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
							/>
						</p>
					</div>
					{(selectedProvider || customProviderName.trim()) && (
						<div className="mt-2.5 rounded-sm border border-border-subtle bg-bg-hover p-3">
							<Label className="mb-1.5 block text-xs font-medium text-text-secondary">{t("config.field.apiKey")}</Label>
							<SecretInput value={newAuthKey} onChange={setNewAuthKey} />
						</div>
					)}
					<div className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-2.5">
						{selectedProvider && presetProvider && (
							<div className="flex flex-1 items-center gap-1.5 text-xs text-text-tertiary">
								{t("config.authEnvVar")}: <code className="rounded-[4px] bg-bg-hover px-1.5 py-px font-mono text-[11px]">{presetProvider.env}</code>
								{presetProvider.url && (
									<a href={presetProvider.url} onClick={openDocsInSystemBrowser(presetProvider.url)} className="inline-flex items-center gap-0.5 text-[11px] text-[color:var(--color-accent)] no-underline">
										{t("config.authGetKey")} <ExternalLink size={10} />
									</a>
								)}
							</div>
						)}
						<Button
							size="sm"
							variant="default"
							onClick={() => {
								const finalName = customProviderName.trim() || selectedProvider;
								if (!finalName) return;
								// 直接传入 finalName 和 newAuthKey，添加后自动展开，用户只需点顶栏保存
								props.onConfirmAddAuth(finalName, newAuthKey);
								setSelectingProvider(false);
							}}
							disabled={!selectedProvider && !customProviderName.trim()}
						>
							{t("config.authAddSelected")}
						</Button>
						<Button size="sm" variant="outline" onClick={() => setSelectingProvider(false)}>
							{t("common.cancel")}
						</Button>
					</div>
				</div>
			)}

			<div className="flex flex-col gap-2.5">
				{visibleProviders.map((name) => {
					const auth = data[name];
					const isExpanded = expandedAuth === name;
					return (
						<div
							key={name}
							ref={(element) => providerReorder.registerCard(name, element)}
							className={`relative rounded-lg border border-border-subtle bg-bg-panel transition-[border-color,box-shadow,background-color,opacity] duration-150${providerReorder.draggingName === name ? " opacity-50" : ""}${isExpanded ? " border-[color-mix(in_srgb,var(--color-accent)_32%,var(--color-border-subtle))] shadow-[var(--shadow-border)]" : ""}`}
							{...providerReorder.cardProps(name)}
						>
							{/* 插入指示线：拖拽落点在上下哪侧就画在卡片哪侧 */}
							{providerReorder.dropTarget?.name === name && <span className={`absolute ${providerReorder.dropTarget.position === "before" ? "top-0" : "bottom-0"} right-0 left-0 z-10 h-0.5 bg-[color:var(--color-accent)]`} />}
							<div data-provider-head="" className="group flex cursor-pointer items-center gap-2.5 rounded-t-lg px-3.5 py-2 transition-colors duration-150 hover:bg-bg-hover" onClick={() => props.onToggleAuth(name)}>
								{/* 拖拽手柄：draggable 只落在手柄上，避免抢整行点击展开；上移/下移悬停浮现 */}
								<Button variant="ghost" size="icon-sm" className="size-6 shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing" title={t("config.dragProvider")} {...providerReorder.gripProps(name)} onClick={(event) => event.stopPropagation()}>
									<GripVertical size={14} />
								</Button>
								{/* 上移/下移：悬停浮现（键盘聚焦也可见），到顶/到底禁用 */}
								<div className="flex shrink-0 items-center">
									<Button
										variant="ghost"
										size="icon-sm"
										className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
										disabled={!providerReorder.canMove(name, -1)}
										title={t("config.moveProviderUp")}
										onClick={(event) => {
											event.stopPropagation();
											providerReorder.moveBy(name, -1);
										}}
									>
										<ArrowUp size={13} />
									</Button>
									<Button
										variant="ghost"
										size="icon-sm"
										className="size-6 opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
										disabled={!providerReorder.canMove(name, 1)}
										title={t("config.moveProviderDown")}
										onClick={(event) => {
											event.stopPropagation();
											providerReorder.moveBy(name, 1);
										}}
									>
										<ArrowDown size={13} />
									</Button>
								</div>
								{batchMode && (
									<Label className="mr-2.5 inline-flex size-4 shrink-0 items-center justify-center" onClick={(e) => e.stopPropagation()}>
										<Checkbox
											checked={selectedAuths.has(name)}
											onClick={(e) => e.stopPropagation()}
											onCheckedChange={() => {
												setSelectedAuths((prev) => {
													const next = new Set(prev);
													if (next.has(name)) next.delete(name);
													else next.add(name);
													return next;
												});
											}}
										/>
									</Label>
								)}
								<span className="text-control font-semibold text-text-primary">{name}</span>
								<span className="min-w-0 flex-1 truncate font-mono text-xs text-text-tertiary">{auth.key ? `${auth.key.slice(0, 10)}••••••${auth.key.slice(-4)}` : t("config.authKeyPreviewEmpty")}</span>
								{/* 用量徽章（与模型页同款）：只在已启用时显示数据，开关在右侧「用量查询」弹窗里。 */}
								<span className="shrink-0" onClick={(event) => event.stopPropagation()}>
									<ProviderUsageInline provider={name} variant="card" />
								</span>
								<div className="flex items-center gap-1">
									<ProviderMigrationButton direction="pi-to-dsh" provider={name} />
									{/* 用量查询配置（内置支持的供应商零配置自动生效，不渲染） */}
									<UsageQueryEntryButton provider={name} onOpen={() => props.onOpenUsageProbeDialog(name)} />
									{onToggleHiddenAuthProvider && (
										<Button
											variant="ghost"
											size="icon-sm"
											className="size-7"
											onClick={(e) => {
												e.stopPropagation();
												onToggleHiddenAuthProvider(name);
											}}
											title={t("config.hideAuth")}
										>
											<EyeOff size={14} className="text-muted-foreground" />
										</Button>
									)}
									<Button
										variant="ghost"
										size="icon-sm"
										className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
										onClick={(e) => {
											e.stopPropagation();
											props.onDeleteAuth(name);
										}}
										title={t("common.delete")}
									>
										<Trash2 size={14} />
									</Button>
									<span className="ml-1 text-control text-text-tertiary">{isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
								</div>
							</div>
							{isExpanded && (
								<div className="mx-4 my-3.5 grid gap-2.5 rounded-lg border border-border-subtle bg-bg-panel p-3.5">
									<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
										<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.type")}</Label>
										<ConfigSelect value={auth.type ?? "api_key"} options={AUTH_TYPE_OPTIONS} onChange={(v) => props.onUpdate(name, "type", v)} />
									</div>
									<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
										<Label className="mb-1.5 block text-xs font-medium text-text-secondary">{t("config.field.apiKey")}</Label>
										<SecretInput value={auth.key ?? ""} onChange={(v) => props.onUpdate(name, "key", v)} />
									</div>
								</div>
							)}
						</div>
					);
				})}

				{/* 已隐藏的认证供应商折叠区：眼睛按钮隐藏后移入此折叠区，可随时点击恢复显示 */}
				{hiddenProviderNames.length > 0 && (
					<div className="overflow-hidden rounded-lg border border-border-subtle bg-bg-panel">
						<button type="button" className="flex w-full cursor-pointer items-center gap-2 px-3.5 py-2 text-left transition-colors duration-150 hover:bg-bg-hover" onClick={() => setHiddenSectionOpen((prev) => !prev)}>
							{hiddenSectionOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
							<EyeOff size={14} className="text-muted-foreground" aria-hidden="true" />
							<span className="text-control font-semibold text-text-primary">{t("config.hiddenAuths", { count: hiddenProviderNames.length })}</span>
						</button>
						{hiddenSectionOpen && (
							<div className="border-t border-border-subtle px-3.5 py-2">
								<p className="mb-2 text-[11px] leading-relaxed text-text-tertiary">{t("config.hiddenAuthsHint")}</p>
								<div className="flex flex-col gap-1">
									{hiddenProviderNames.map((hiddenName) => (
										<div key={hiddenName} className="flex items-center justify-between gap-2 rounded-sm bg-bg-muted px-2.5 py-1.5">
											<span className="min-w-0 truncate font-mono text-control text-text-primary">{hiddenName}</span>
											<Button variant="ghost" size="icon-sm" className="size-7 shrink-0" onClick={() => onToggleHiddenAuthProvider?.(hiddenName)} title={t("config.showAuth")}>
												<Eye size={14} />
											</Button>
										</div>
									))}
								</div>
							</div>
						)}
					</div>
				)}

				{visibleProviders.length === 0 && hiddenProviderNames.length === 0 && <div className="py-12 text-center text-control text-text-tertiary">{t("config.authEmpty")}</div>}
			</div>
		</div>
	);
}
