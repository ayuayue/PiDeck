import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Copy, ExternalLink, Trash2 } from "lucide-react";
import { t } from "../i18n";
import type { AuthFile } from "./configTypes";
import { SecretInput } from "./ConfigShared";

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

export function AuthTab(props: {
	data: AuthFile;
	expandedAuth: string | null;
	addingAuth: boolean;
	newAuthName: string;
	saving: boolean;
	onToggleAuth: (name: string) => void;
	onStartAddAuth: () => void;
	onCancelAddAuth: () => void;
	onChangeNewAuthName: (name: string) => void;
	onConfirmAddAuth: () => void;
	onDuplicateAuth: (provider: string) => void;
	onDeleteAuth: (provider: string) => void;
	onDeleteAuths: (providers: string[]) => void;
	onUpdate: (provider: string, field: string, value: string) => void;
	onSave: () => void;
}) {
	const { data, expandedAuth, saving } = props;
	const providers = Object.keys(data);
	const [selectingProvider, setSelectingProvider] = useState(false);
	const [selectedProvider, setSelectedProvider] = useState("");
	const [customProviderName, setCustomProviderName] = useState("");
	const [showGuide, setShowGuide] = useState(false);
	const [batchMode, setBatchMode] = useState(false);
	const [selectedAuths, setSelectedAuths] = useState(new Set());

	// 从预设列表获取供应商信息
	const presetProvider = selectedProvider ? PRESET_PROVIDERS.find(p => p.value === selectedProvider) : undefined;

	return (
		<div className="config-auth-tab">
			<div className="config-toolbar">
				<span className="config-count">
					{t("config.count.auth", { count: providers.length })}
				</span>
				<div className="config-toolbar-actions">
					<button
						className="config-btn"
						onClick={() => {
							setSelectingProvider(true);
							setSelectedProvider("");
							setCustomProviderName("");
						}}
						disabled={saving}
					>
						{t("config.addAuth")}
					</button>
					<button
						className="config-btn"
						onClick={() => setShowGuide(!showGuide)}
						disabled={saving}
					>
						{t("config.authGuide")}
					</button>
					<button
						className="config-btn primary"
						onClick={props.onSave}
						disabled={saving}
					>
						{saving ? t("common.saving") : t("common.save")}
					</button>
				</div>
			</div>

			{/* 使用引导 */}
			{showGuide && (
				<div className="config-auth-guide">
					<div className="config-auth-guide-header">
						<strong>{t("config.authGuideTitle")}</strong>
						<button className="config-icon-btn" onClick={() => setShowGuide(false)}>×</button>
					</div>
					<div className="config-auth-guide-body">
						<p>{t("config.authGuideDesc")}</p>
						<ul>
							<li>{t("config.authGuideStep1")}</li>
							<li>{t("config.authGuideStep2")}</li>
							<li>{t("config.authGuideStep3")}</li>
						</ul>
						<p className="config-auth-guide-note">
							{t("config.authGuideNote")}{" "}
							<a href="https://pi.dev/docs/latest/providers#auth-file" target="_blank" rel="noreferrer">
								pi docs <ExternalLink size={12} />
							</a>
						</p>
					</div>
				</div>
			)}

			{/* 选择供应商弹窗 */}
			{selectingProvider && (
				<div className="config-auth-selector">
					<div className="config-auth-selector-header">
						<strong>{t("config.authSelectProvider")}</strong>
						<button className="config-icon-btn" onClick={() => setSelectingProvider(false)}>×</button>
					</div>
					<div className="config-auth-selector-list">
						{PRESET_PROVIDERS.map((provider) => {
							const alreadyConfigured = providers.includes(provider.value);
							return (
								<button
									key={provider.value}
									className={`config-auth-selector-item${selectedProvider === provider.value ? " selected" : ""}${alreadyConfigured ? " configured" : ""}`}
									onClick={() => {
										setSelectedProvider(provider.value);
									}}
								>
									<span className="config-auth-selector-name">{provider.label}</span>
									<span className="config-auth-selector-id">{provider.value}</span>
									{alreadyConfigured && (
										<span className="config-auth-selector-badge">{t("config.configured")}</span>
									)}
								</button>
							);
						})}
					</div>
					<div className="config-auth-selector-bottom">
						<p className="config-auth-selector-custom-hint">
							<span className="config-auth-selector-custom-label">{t("config.authCustomHint")}</span>
							<input
								value={customProviderName}
								onChange={(e) => {
									setCustomProviderName(e.target.value);
									if (e.target.value) setSelectedProvider("");
								}}
								placeholder={t("config.authCustomPlaceholder")}
							/>
						</p>
					</div>
					<div className="config-auth-selector-actions">
						{selectedProvider && presetProvider && (
							<div className="config-auth-selector-info">
								{t("config.authEnvVar")}: <code>{presetProvider.env}</code>
								{presetProvider.url && (
									<a href={presetProvider.url} target="_blank" rel="noreferrer">
										{t("config.authGetKey")} <ExternalLink size={10} />
									</a>
								)}
							</div>
						)}
						<button
							className="config-btn primary"
							onClick={() => {
								const finalName = customProviderName.trim() || selectedProvider;
								if (!finalName) return;
								// 调用原来的添加流程
								props.onChangeNewAuthName(finalName);
								props.onConfirmAddAuth();
								setSelectingProvider(false);
							}}
							disabled={!selectedProvider && !customProviderName.trim()}
						>
							{t("config.authAddSelected")}
						</button>
						<button className="config-btn" onClick={() => setSelectingProvider(false)}>
							{t("common.cancel")}
						</button>
					</div>
				</div>
			)}

			<div className="config-auth-list">
				{providers.map((name) => {
					const auth = data[name];
					const isExpanded = expandedAuth === name;
					return (
						<div
							key={name}
							className={`config-auth-card ${isExpanded ? "editing" : ""}`}
						>
							<div
								className="config-auth-card-header"
								onClick={() => props.onToggleAuth(name)}
							>
								<span className="config-auth-provider">{name}</span>
								<span className="config-auth-key-preview">
									{auth.key
										? `${auth.key.slice(0, 10)}••••••${auth.key.slice(-4)}`
										: t("config.authKeyPreviewEmpty")}
								</span>
								<div className="config-provider-actions">
									<button
										className="config-icon-btn danger"
										onClick={(e) => {
											e.stopPropagation();
											props.onDeleteAuth(name);
										}}
										title={t("common.delete")}
									>
										<Trash2 size={14} />
									</button>
									<span className="config-chevron">
										{isExpanded ? (
											<ChevronDown size={14} />
										) : (
											<ChevronRight size={14} />
										)}
									</span>
								</div>
							</div>
							{isExpanded && (
								<div className="config-provider-form">
									<div className="config-form-row">
										<label>{t("config.field.type")}</label>
										<input
											value={auth.type ?? "api_key"}
											onChange={(e) =>
												props.onUpdate(name, "type", e.target.value)
											}
										/>
									</div>
									<div className="config-form-row">
										<label>{t("config.field.apiKey")}</label>
										<SecretInput
											value={auth.key ?? ""}
											onChange={(v) => props.onUpdate(name, "key", v)}
										/>
									</div>
								</div>
							)}
						</div>
					);
				})}
				{providers.length === 0 && (
					<div className="config-empty">{t("config.authEmpty")}</div>
				)}
			</div>
		</div>
	);
}


