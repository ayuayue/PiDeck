import { Button } from "../components/ui-shadcn/button";
import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Copy, ExternalLink, Trash2 } from "lucide-react";
import { t } from "../i18n";
import type { AuthFile, ModelsFile } from "./configTypes";
import { ConfigSelect, openDocsInSystemBrowser, SecretInput } from "./ConfigShared";
import { Input } from "../components/ui-shadcn/input";
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Label } from "../components/ui-shadcn/label";
import { ProviderMigrationButton } from "./ProviderMigrationButton";
import { UsageQueryEntryButton } from "../components/app/UsageQueryEntryButton";
import { ProviderUsageRow } from "../components/app/ProviderUsageInline";

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
	const { data, expandedAuth, saving } = props;
	const providers = Object.keys(data);
	const [selectingProvider, setSelectingProvider] = useState(false);
	const [selectedProvider, setSelectedProvider] = useState("");
	const [customProviderName, setCustomProviderName] = useState("");
	const [newAuthKey, setNewAuthKey] = useState("");
	const [showGuide, setShowGuide] = useState(false);
	const [batchMode, setBatchMode] = useState(false);
	const [selectedAuths, setSelectedAuths] = useState(new Set());

	// 从预设列表获取供应商信息
	const presetProvider = selectedProvider ? PRESET_PROVIDERS.find(p => p.value === selectedProvider) : undefined;

	return (
		<div className="config-auth-tab">
			<div className="mb-3 flex items-center justify-between gap-3">
				<span className="font-mono text-xs tabular-nums text-text-tertiary">
					{t("config.count.auth", { count: providers.length })}
				</span>
				<div className="flex min-w-0 items-center gap-1.5">
					<Button size="sm" variant="outline"
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
					<Button size="sm" variant="outline"
						onClick={() => setShowGuide(!showGuide)}
						disabled={saving}
					>
						{t("config.authGuide")}
					</Button>
					<Button size="sm" variant="destructive"
						onClick={() => {
							if (batchMode) {
								setBatchMode(false);
								setSelectedAuths(new Set());
							} else {
								setBatchMode(true);
							}
						}}
						disabled={saving || providers.length === 0}
					>
						{batchMode ? t("common.cancel") : t("common.deleteBatch")}
					</Button>
					{batchMode && (
						<Button size="sm" variant="destructive"
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

			{/* 使用引导 */}
			{showGuide && (
				<div className="mb-4 rounded-md border border-border-subtle bg-bg-subtle p-4">
					<div className="mb-2.5 flex items-center justify-between">
						<strong className="text-sm text-text-primary">{t("config.authGuideTitle")}</strong>
						<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setShowGuide(false)}>×</Button>
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
							<a
								href="https://pi.dev/docs/latest/providers#auth-file"
								onClick={openDocsInSystemBrowser("https://pi.dev/docs/latest/providers#auth-file")}
								className="inline-flex items-center gap-0.5 text-[color:var(--color-accent)] no-underline"
							>
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
						<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setSelectingProvider(false)}>×</Button>
					</div>
					<div className="grid max-h-[320px] grid-cols-[repeat(auto-fill,minmax(200px,1fr))] gap-1.5 overflow-y-auto">
						{PRESET_PROVIDERS.map((provider) => {
							const alreadyConfigured = providers.includes(provider.value);
							return (
								<button
									key={provider.value}
									className={`flex cursor-pointer flex-col items-start rounded-md border border-border-subtle bg-bg-muted px-3 py-2.5 text-left text-xs transition-all duration-150 hover:border-[var(--color-accent)] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_5%,var(--color-bg-panel))]${selectedProvider === provider.value ? " border-[var(--color-accent)] font-medium" : ""}${alreadyConfigured ? " opacity-60" : ""}`}
									onClick={() => {
										setSelectedProvider(provider.value);
									}}
								>
									<span className="font-medium text-text-primary">{provider.label}</span>
									<span className="mt-0.5 font-mono text-[11px] text-text-tertiary">{provider.value}</span>
									{alreadyConfigured && (
										<span className="mt-1 rounded-[4px] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-1.5 py-px text-[11px] text-[color:var(--color-accent)]">{t("config.configured")}</span>
									)}
								</button>
							);
						})}
						{/* 从 models.json 读取已配置的服务商 */}
						{props.modelsData && Object.keys(props.modelsData.providers).length > 0 && (
							<>
								<div className="flex items-center gap-2 text-xs text-text-tertiary">
									<span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
									<span>{t("config.authFromModels")}</span>
									<span className="h-px flex-1 bg-border-subtle" aria-hidden="true" />
								</div>
								{Object.keys(props.modelsData.providers).map((providerName) => {
									const alreadyConfigured = providers.includes(providerName);
									return (
										<button
											key={providerName}
											className={`flex cursor-pointer flex-col items-start rounded-md border border-border-subtle bg-bg-muted px-3 py-2.5 text-left text-xs transition-all duration-150 hover:border-[var(--color-accent)] hover:bg-[color:color-mix(in_srgb,var(--color-accent)_5%,var(--color-bg-panel))]${selectedProvider === providerName ? " border-[var(--color-accent)] font-medium" : ""}${alreadyConfigured ? " opacity-60" : ""}`}
											onClick={() => {
												setSelectedProvider(providerName);
											}}
										>
											<span className="font-medium text-text-primary">{providerName}</span>
											<span className="mt-0.5 font-mono text-[11px] text-text-tertiary">{t("config.fromModels")}</span>
											{alreadyConfigured && (
												<span className="mt-1 rounded-[4px] bg-[color:color-mix(in_srgb,var(--color-accent)_10%,transparent)] px-1.5 py-px text-[11px] text-[color:var(--color-accent)]">{t("config.configured")}</span>
											)}
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
							<SecretInput
								value={newAuthKey}
								onChange={setNewAuthKey}
							/>
						</div>
					)}
					<div className="mt-3 flex items-center gap-2 border-t border-border-subtle pt-2.5">
						{selectedProvider && presetProvider && (
							<div className="flex flex-1 items-center gap-1.5 text-xs text-text-tertiary">
								{t("config.authEnvVar")}: <code className="rounded-[4px] bg-bg-hover px-1.5 py-px font-mono text-[11px]">{presetProvider.env}</code>
								{presetProvider.url && (
									<a
										href={presetProvider.url}
										onClick={openDocsInSystemBrowser(presetProvider.url)}
										className="inline-flex items-center gap-0.5 text-[11px] text-[color:var(--color-accent)] no-underline"
									>
										{t("config.authGetKey")} <ExternalLink size={10} />
									</a>
								)}
							</div>
						)}
						<Button size="sm" variant="default"
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
						<Button size="sm"  variant="outline" onClick={() => setSelectingProvider(false)}>
							{t("common.cancel")}
						</Button>
					</div>
				</div>
			)}

			<div className="flex flex-col gap-2.5">
				{providers.map((name) => {
					const auth = data[name];
					const isExpanded = expandedAuth === name;
					return (
						<div
							key={name}
							className={`rounded-lg border border-border-subtle bg-bg-panel transition-[border-color,box-shadow,background-color] duration-150${isExpanded ? " border-[color-mix(in_srgb,var(--color-accent)_32%,var(--color-border-subtle))] shadow-[var(--shadow-border)]" : ""}`}
						>
							<div
								className="flex cursor-pointer items-center gap-3 rounded-t-lg px-3.5 py-2 transition-colors duration-150 hover:bg-bg-hover"
								onClick={() => props.onToggleAuth(name)}
							>
						{batchMode && (
							<Label className="mr-2.5 inline-flex size-4 shrink-0 items-center justify-center" onClick={(e) => e.stopPropagation()}>
								<Checkbox
									checked={selectedAuths.has(name)}
									onClick={(e) => e.stopPropagation()}
								onCheckedChange={() => {
										setSelectedAuths(prev => {
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
								<span className="min-w-0 flex-1 truncate font-mono text-xs text-text-tertiary">
									{auth.key
										? `${auth.key.slice(0, 10)}••••••${auth.key.slice(-4)}`
										: t("config.authKeyPreviewEmpty")}
								</span>
								<div className="flex items-center gap-1">
									<ProviderMigrationButton
										direction="pi-to-dsh"
										provider={name}
									/>
									{/* 用量查询配置（内置支持的供应商零配置自动生效，不渲染） */}
									<UsageQueryEntryButton
										provider={name}
										onOpen={() => props.onOpenUsageProbeDialog(name)}
									/>
									<Button variant="ghost" size="icon-sm" className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
										onClick={(e) => {
											e.stopPropagation();
											props.onDeleteAuth(name);
										}}
										title={t("common.delete")}
									>
										<Trash2 size={14} />
									</Button>
									<span className="ml-1 text-control text-text-tertiary">
										{isExpanded ? (
											<ChevronDown size={14} />
										) : (
											<ChevronRight size={14} />
										)}
									</span>
								</div>
							</div>
							{isExpanded && (
								<div className="mx-4 my-3.5 grid gap-2.5 rounded-lg border border-border-subtle bg-bg-panel p-3.5">
									<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
										<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.type")}</Label>
										<ConfigSelect
											value={auth.type ?? "api_key"}
											options={AUTH_TYPE_OPTIONS}
											onChange={(v) =>
												props.onUpdate(name, "type", v)
											}
										/>
									</div>
									<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
										<Label className="mb-1.5 block text-xs font-medium text-text-secondary">{t("config.field.apiKey")}</Label>
										<SecretInput
											value={auth.key ?? ""}
											onChange={(v) => props.onUpdate(name, "key", v)}
										/>
									</div>
								</div>
							)}
							{/* 用量行（与模型页/DSH 同一版式：卡片右下角）= 金额/百分比 + 柱状图「用量查询」按钮 */}
							<ProviderUsageRow provider={name} />
						</div>
					);
				})}
				{providers.length === 0 && (
					<div className="py-12 text-center text-control text-text-tertiary">{t("config.authEmpty")}</div>
				)}
			</div>
		</div>
	);
}


