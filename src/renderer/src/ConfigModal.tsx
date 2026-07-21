import { showNotice } from "./utils/notice";
import { Component, useState, useEffect, useCallback, type ReactNode } from "react";
import type { PiDesktopApi } from "../../preload";
import { AuthTab } from "./config/AuthTab";
import { ModelsTab } from "./config/ModelsTab";
import { RawTab } from "./config/RawTab";
import { TrustTab } from "./config/TrustTab";
import { SettingsTab } from "./config/SettingsTab";
import { PromptsTab } from "./config/PromptsTab";
import { SkillsTab } from "./config/SkillsTab";
import { ExtensionsTab } from "./config/ExtensionsTab";
import { EditorsTab } from "./config/EditorsTab";
import { ImTab } from "./config/ImTab";
import { LogsTab } from "./config/LogsTab";
import { CloseIconButton } from "./components/ui/IconButton";
import { t } from "./i18n";
import { LazyMonacoEditor } from "./components/ui/LazyMonacoEditor";
import { translateBuiltinPromptDescription } from "./composerBehavior";
import type {
	AuthFile,
	ConfigTab,
	ModelItem,
	ModelsFile,
	SettingsFile,
} from "./config/configTypes";
import type { ConfigFileDiagnostic, CreatePiPromptTemplateInput, PiExtensionListResult, PiExtensionSummary, PiPromptTemplateListResult, PiPromptTemplateSummary, PiSkillListResult, PiSkillLocation, PiSkillSummary } from "../../shared/types";
import { getProviderHeaders, KNOWN_PROVIDER_ENDPOINTS } from "./config/providerHeaders";

const api: PiDesktopApi = (window as unknown as { piDesktop: PiDesktopApi })
	.piDesktop;
const DEFAULT_MODEL_CONFIG: Pick<
	ModelItem,
	"contextWindow" | "maxTokens" | "reasoning" | "input"
> = {
	contextWindow: 1000000,
	maxTokens: 128000,
	reasoning: true,
	input: ["text", "image"],
};

/**
 * 配置页必须能打开用户手写/旧版本生成的非标准 models.json。
 * pi 自身对配置较宽松，但 UI 会访问 provider.models.length / map；这里先把缺失或异常字段归一化，
 * 避免单个 provider 配置错误导致整个 renderer 白屏。
 */
function normalizeModelsFile(value: unknown): ModelsFile {
	const rawProviders =
		value && typeof value === "object" && !Array.isArray(value)
			? (value as { providers?: unknown }).providers
			: undefined;
	const providers: ModelsFile["providers"] = {};
	if (!rawProviders || typeof rawProviders !== "object" || Array.isArray(rawProviders)) {
		return { providers };
	}
	for (const [name, rawProvider] of Object.entries(rawProviders)) {
		const provider =
			rawProvider && typeof rawProvider === "object" && !Array.isArray(rawProvider)
				? (rawProvider as Record<string, unknown>)
				: {};
		const rawModels = provider.models;
		providers[name] = {
			...provider,
			models: Array.isArray(rawModels)
				? rawModels
					.filter((model): model is ModelItem | string =>
						Boolean(model) &&
						(typeof model === "object" && !Array.isArray(model) || typeof model === "string"),
					)
					.map((model) =>
						typeof model === "string" ? { id: model } : model,
					)
				: [],
		};
	}
	return { providers };
}

function ConfigDiagnosticCard(props: {
	diagnostic: ConfigFileDiagnostic;
	onOpenDocs: () => void;
	onOpenRaw: () => void;
}) {
	const { diagnostic } = props;
	return (
		<div className="config-diagnostic-card">
			<div>
				<strong>{t("config.diagnosticLoadFailed", { fileName: diagnostic.fileName })}</strong>
				<span>
					{diagnostic.line && diagnostic.column
						? t("config.diagnosticLocation", {
								line: diagnostic.line,
								column: diagnostic.column,
								message: diagnostic.message,
							})
						: diagnostic.message}
				</span>
				<small>
					{t("config.diagnosticHelp")}{" "}
					<a href={diagnostic.docsUrl} target="_blank" rel="noreferrer">
						{t("config.openOfficialDocs")}
					</a>
				</small>
			</div>
			{diagnostic.snippet && <pre>{diagnostic.snippet}</pre>}
			<div className="config-diagnostic-actions">
				<button className="config-btn primary" onClick={props.onOpenRaw}>{t("config.openRawFile")}</button>
				<button className="config-btn" onClick={props.onOpenDocs}>{t("config.openOfficialDocs")}</button>
			</div>
		</div>
	);
}

type ConfigModalProps = {
	open: boolean;
	onClose: () => void;
	onSaved: () => void;
};

class ConfigModalErrorBoundary extends Component<
	{ open: boolean; onClose: () => void; children: ReactNode },
	{ error: Error | null }
> {
	override state = { error: null as Error | null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	override componentDidUpdate(prevProps: { open: boolean }) {
		if (prevProps.open !== this.props.open && this.state.error) {
			this.setState({ error: null });
		}
	}

	override render() {
		if (!this.state.error) return this.props.children;
		if (!this.props.open) return null;
		return (
			<div className="modal-backdrop" onClick={this.props.onClose}>
				<div className="config-modal" onClick={(e) => e.stopPropagation()}>
					<div className="modal-header">
						<strong>{t("config.loadFailed")}</strong>
						<CloseIconButton
							label={t("common.close")}
							onClick={this.props.onClose}
						/>
					</div>
					<div className="config-content">
						<div className="config-diagnostic-card">
							<div>
								<strong>{t("config.renderCrashed")}</strong>
								<span>{this.state.error.message}</span>
								<small>
									{t("config.renderCrashedHelpPrefix")}
									<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer">{t("config.docsModels")}</a>
									{" / "}
									<a href="https://pi.dev/docs/latest/settings" target="_blank" rel="noreferrer">{t("config.docsSettings")}</a>
									{t("config.renderCrashedHelpSuffix")}
								</small>
							</div>
							<pre>{this.state.error.stack ?? this.state.error.message}</pre>
						</div>
					</div>
				</div>
			</div>
		);
	}
}

/** 配置管理弹窗：支持 models/auth/settings 三个 tab 的可视化编辑和源文件编辑 */
export function ConfigModal(props: ConfigModalProps) {
	return (
		<ConfigModalErrorBoundary open={props.open} onClose={props.onClose}>
			<ConfigModalContent {...props} />
		</ConfigModalErrorBoundary>
	);
}

function ConfigModalContent(props: ConfigModalProps) {
	const { open, onClose, onSaved } = props;
	const [section, setSection] = useState<"config" | "skills" | "prompts" | "extensions" | "editors" | "im" | "logs">("config");
	const [tab, setTab] = useState<ConfigTab>("models");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [configDiagnostic, setConfigDiagnostic] = useState<ConfigFileDiagnostic | null>(null);
	/* toast 已改用 sonner 实现 */

	// 各 tab 的数据
	const [modelsData, setModelsData] = useState<ModelsFile>({ providers: {} });
	const [authData, setAuthData] = useState<AuthFile>({});
	const [settingsData, setSettingsData] = useState<SettingsFile>({});
	/** 自动发现的模型：auth-only 供应商通过已知端点获取的模型列表 */
	const [discoveredModels, setDiscoveredModels] = useState<
		Record<string, Array<{ id: string; name?: string }>>
	>({});
	const [trustData, setTrustData] = useState<Record<string, boolean>>({});
	const [skillsData, setSkillsData] = useState<PiSkillListResult>({
		locations: [],
		skills: [],
	});
	const [extensionsData, setExtensionsData] = useState<PiExtensionListResult>({
		extensions: [],
		raw: "",
	});
	const [extensionsLoading, setExtensionsLoading] = useState(false);
	const [creatingSkill, setCreatingSkill] = useState(false);
	const [uninstallingExtensionSource, setUninstallingExtensionSource] = useState<string | null>(null);
	const [newSkillName, setNewSkillName] = useState("");
	const [newSkillDescription, setNewSkillDescription] = useState("");
	const [newSkillLocationId, setNewSkillLocationId] = useState<PiSkillLocation["id"]>("pi-global");
	const [deleteSkillConfirm, setDeleteSkillConfirm] = useState<PiSkillSummary | null>(null);
	const [editingGlobalSkill, setEditingGlobalSkill] = useState<PiSkillSummary | null>(null);
	const [editGlobalContent, setEditGlobalContent] = useState("");
	const [editGlobalLoading, setEditGlobalLoading] = useState(false);
	const [editGlobalSaving, setEditGlobalSaving] = useState(false);
	const [editGlobalSaved, setEditGlobalSaved] = useState(false);
	const [promptsData, setPromptsData] = useState<PiPromptTemplateListResult>({
		templates: [],
		globalDir: "",
	});
	const [creatingPrompt, setCreatingPrompt] = useState(false);
	const [newPromptName, setNewPromptName] = useState("");
	const [newPromptDescription, setNewPromptDescription] = useState("");
	const [editingPrompt, setEditingPrompt] = useState<PiPromptTemplateSummary | null>(null);
	const [editPromptContent, setEditPromptContent] = useState("");
	const [editPromptLoading, setEditPromptLoading] = useState(false);
	const [editPromptSaving, setEditPromptSaving] = useState(false);
	/** 用户已删除的内置模板名称（仅当前会话有效） */
	const [deletedBuiltinNames, setDeletedBuiltinNames] = useState<Set<string>>(new Set());
	const [uninstallExtensionConfirm, setUninstallExtensionConfirm] = useState<PiExtensionSummary | null>(null);
	const [rawContent, setRawContent] = useState("");
	const [rawFileName, setRawFileName] = useState("models.json");

	// 展开的 provider / auth 项
	const [expandedProvider, setExpandedProvider] = useState<string | null>(null);
	const [expandedAuth, setExpandedAuth] = useState<string | null>(null);
	// 新增 provider
	const [addingProvider, setAddingProvider] = useState(false);
	const [newProviderName, setNewProviderName] = useState("");
	// 重命名 provider
	const [renamingProvider, setRenamingProvider] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState("");
	// 新增 auth
	const [addingAuth, setAddingAuth] = useState(false);
	const [newAuthName, setNewAuthName] = useState("");
	// 远程拉取模型列表
	const [fetchingProvider, setFetchingProvider] = useState<string | null>(null);
	const [fetchedModels, setFetchedModels] = useState<
		Record<string, Array<{ id: string; name?: string }>>
	>({});

	/**
	 * 根据 API 类型返回对应的获取模型提示。
	 * 不同服务对 /models 端点的支持不同，提供针对性的指导。
	 */
	function getFetchModelsHintByApi(api: string | undefined, baseUrl: string): string {
		switch (api) {
			case "openai-completions":
				return t("config.fetchModelsHintOpenaiCompletions", { baseUrl });
			case "openai-responses":
				return t("config.fetchModelsHintOpenai", { baseUrl });
			case "openai-codex-responses":
				return t("config.fetchModelsHintOpenaiCodex");
			case "anthropic-messages":
				return t("config.fetchModelsHintAnthropic");
			case "google-generative-ai":
				return t("config.fetchModelsHintGoogle");
			case "mistral-conversations":
				return t("config.fetchModelsHintMistral");
			default:
				// 未知 API 类型时使用通用提示
				return t("config.fetchModelsHint");
		}
	}

	// 每个 provider 独立的模型拉取错误状态，避免全局 setError 相互覆盖
	const [fetchModelsErrorByProvider, setFetchModelsErrorByProvider] = useState<
		Record<string, string | undefined>
	>({});
	// 快速测试连接
	const [testingProvider, setTestingProvider] = useState<string | null>(null);
	const [testResult, setTestResult] = useState<{
		providerName: string;
		success: boolean;
		model?: string;
		snippet?: string;
		tokens?: { input?: number; output?: number };
		latencyMs?: number;
		error?: string;
		requestUrl?: string;
		requestBody?: string;
	} | null>(null);
	const [testModelIdByProvider, setTestModelIdByProvider] = useState<
		Record<string, string>
	>({});
	// 删除确认对话框
	const [deleteConfirm, setDeleteConfirm] = useState<{
		type: "provider" | "model" | "auth" | "batch";
		title: string;
		message: string;
		onConfirm: () => void;
	} | null>(null);

	const loadConfig = useCallback(
		async (target: ConfigTab) => {
			setLoading(true);
			setError(null);
			setConfigDiagnostic(null);
			try {
				if (target === "models") {
					const res = await api.config.getModels();
					setModelsData(normalizeModelsFile(res.parsed));
					setRawContent(res.raw);
					setRawFileName("models.json");
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "auth") {
					const res = await api.config.getAuth();
					setAuthData(res.parsed as AuthFile);
					setRawContent(res.raw);
					setRawFileName("auth.json");
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "settings") {
					// 同时加载 settings、auth 和 models 数据，确保 defaultProvider / defaultModel 下拉能聚合所有可用信息
					const [settingsRes, authRes, modelsRes] = await Promise.all([
						api.config.getSettings(),
						api.config.getAuth(),
						api.config.getModels(),
					]);
					setSettingsData(settingsRes.parsed as SettingsFile);
					setAuthData(authRes.parsed as AuthFile);
					setModelsData(normalizeModelsFile(modelsRes.parsed));
					setRawContent(settingsRes.raw);
					setRawFileName("settings.json");
					setConfigDiagnostic(settingsRes.diagnostic ?? null);

					// 对于 auth 中有但 models 中没有模型的供应商，自动尝试获取模型列表
					const authProviders = authRes.parsed as AuthFile;
					const modelsProviders = normalizeModelsFile(modelsRes.parsed).providers;
					const discovered: Record<string, Array<{ id: string; name?: string }>> = {};
					const fetchPromises: Array<Promise<void>> = [];

					for (const [providerName, authEntry] of Object.entries(authProviders)) {
						// 跳过已有模型的供应商
						if (modelsProviders[providerName]?.models?.length) continue;
						const apiKey =
							typeof authEntry.key === "string" ? authEntry.key : "";
						if (!apiKey) continue;

						// 情况1：从 KNOWN_PROVIDER_ENDPOINTS 获知该供应商的 API 端点
						const knownEndpoint = KNOWN_PROVIDER_ENDPOINTS[providerName];
						// 情况2：从 models.json 中该供应商的配置获知 baseUrl
						const modelsProvider = modelsProviders[providerName];
						const modelsBaseUrl =
							modelsProvider && typeof modelsProvider.baseUrl === "string"
								? modelsProvider.baseUrl
								: undefined;
						const baseUrl = knownEndpoint?.baseUrl ?? modelsBaseUrl;
						if (!baseUrl) continue;

						const apiType =
							knownEndpoint?.apiType ??
							(typeof modelsProvider?.api === "string"
								? modelsProvider.api
								: undefined);

						fetchPromises.push(
							api.config
								.fetchModels(baseUrl, apiKey, apiType)
								.then((result) => {
									if (result.success && result.models) {
										discovered[providerName] = result.models;
									}
								})
								.catch(() => {
									// 静默失败，不阻塞 UI
								}),
						);
					}

					if (fetchPromises.length > 0) {
						// 不 await，在后台获取后更新状态即可
						void Promise.allSettled(fetchPromises).then(() => {
							if (Object.keys(discovered).length > 0) {
								setDiscoveredModels(discovered);
							}
						});
					}
				} else if (target === "trust") {
					const res = await api.config.getTrust();
					setTrustData(res.parsed as Record<string, boolean>);
					setRawContent(res.raw);
					setRawFileName("trust.json");
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "raw") {
					// 源文件 tab 复用当前 tab 对应的文件
					const fileName =
						tab === "models"
							? "models.json"
							: tab === "auth"
								? "auth.json"
								: tab === "trust"
									? "trust.json"
									: "settings.json";
					setRawFileName(fileName);
					const res =
						fileName === "models.json"
							? await api.config.getModels()
							: fileName === "auth.json"
								? await api.config.getAuth()
								: fileName === "trust.json"
									? await api.config.getTrust()
									: await api.config.getSettings();
					setRawContent(res.raw);
					setConfigDiagnostic(res.diagnostic ?? null);
				}
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setLoading(false);
			}
		},
		[tab],
	);

	useEffect(() => {
		if (!open) return;
		if (section === "skills") {
			void refreshSkills();
			return;
		}
		if (section === "prompts") {
			void refreshPrompts();
			return;
		}
		if (section === "extensions") {
			void refreshExtensions();
			return;
		}
		if (section === "editors") return;
		if (section === "logs") return;
		void loadConfig(tab);
	}, [open, section, tab, loadConfig]);

	const showToast = (msg: string) => {
		showNotice(msg, 2500);
	};

	/**
	 * 模型配置保存后，通知所有运行中的 Agent 尝试刷新模型配置。
	 *
	 * 当前仅尝试 reload_config RPC（策略 1），pi 0.80.10 尚未支持此命令，
	 * 因此实际为 no-op。进程重启方案（策略 2）已注释，原因：
	 *   - 运行中重启会打断用户对话/工具执行
	 *   - 涉及 exit 事件竞态、模型恢复等复杂边界
	 *
	 * pi 合并 https://github.com/earendil-works/pi/issues/6890 后自动生效。
	 */
	const refreshRunningAgents = async () => {
		try {
			const agents = await api.agents.list();
			// 只刷新状态为 running 或 idle 的活跃 Agent（排除 closed/error/starting）
			const activeAgents = agents.filter(
				(agent) => agent.status === "running" || agent.status === "idle",
			);
			if (activeAgents.length === 0) return;

			let refreshed = 0;
			let failed = 0;
			for (const agent of activeAgents) {
				try {
					await api.agents.refreshModels(agent.id);
					refreshed++;
				} catch {
					failed++;
				}
			}

			if (refreshed > 0 && failed === 0) {
				showToast(t("config.modelsRefreshed", { count: refreshed }));
			} else if (refreshed > 0) {
				showToast(t("config.modelsRefreshedPartial", { refreshed, failed }));
			}
		} catch {
			// 获取 agent 列表失败时静默忽略，模型配置已保存，下次启动 agent 生效
		}
	};

	const saveAndReload = async (
		saveFn: () => Promise<{ valid: boolean; error?: string }>,
		successMessage?: string,
	) => {
		setSaving(true);
		setError(null);
		try {
			const result = await saveFn();
			if (!result.valid) {
				setError(result.error ?? t("config.saveFailed"));
				return;
			}
			onSaved();
			showToast(successMessage ?? t("config.saved"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setSaving(false);
		}
	};

	// ── Models 操作 ──────────────────────────────────────

	const handleAddProvider = () => {
		const providerName = newProviderName.trim();
		if (!providerName) return;
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				// 默认不写入 headers，保持和手写 models.json 一致；需要兼容特定代理时再由用户显式选择 User-Agent。
				[providerName]: { models: [] },
			},
		};
		setModelsData(updated);
		setExpandedProvider(providerName);
		setAddingProvider(false);
		setNewProviderName("");
	};

	// 重命名 provider：保留所有配置和模型，仅修改 key 名称
	const handleStartRename = (name: string) => {
		setRenamingProvider(name);
		setRenameValue(name);
	};

	const handleConfirmRename = (oldName: string) => {
		const newName = renameValue.trim();
		if (!newName || newName === oldName || modelsData.providers[newName]) {
			// 名称未变、为空或已存在则不操作
			setRenamingProvider(null);
			setRenameValue("");
			return;
		}
		const providers = { ...modelsData.providers };
		providers[newName] = providers[oldName];
		delete providers[oldName];
		setModelsData({ ...modelsData, providers });
		if (expandedProvider === oldName) setExpandedProvider(newName);
		setRenamingProvider(null);
		setRenameValue("");
	};

	const handleCancelRename = () => {
		setRenamingProvider(null);
		setRenameValue("");
	};

	const handleDeleteProvider = (name: string) => {
		setDeleteConfirm({
			type: "provider",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name }),
			onConfirm: () => {
				const providers = { ...modelsData.providers };
				delete providers[name];
				setModelsData({ ...modelsData, providers });
				if (expandedProvider === name) setExpandedProvider(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDuplicateProvider = (name: string) => {
		const sourceProvider = modelsData.providers[name];
		if (!sourceProvider) return;
		
		// 生成新名称：原名称 + " copy" 或 " copy 2" 依此类推
		let newName = `${name} copy`;
		let counter = 2;
		while (modelsData.providers[newName]) {
			newName = `${name} copy ${counter}`;
			counter++;
		}
		
		// 深拷贝 provider 配置，包括 models 数组
		const duplicatedProvider = JSON.parse(JSON.stringify(sourceProvider));
		
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[newName]: duplicatedProvider,
			},
		});
		
		// 展开新复制的 provider
		setExpandedProvider(newName);
	};

	// 从 provider 的 baseUrl + apiKey 拉取可用模型列表
	const handleFetchModels = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setFetchModelsErrorByProvider((prev) => ({
				...prev,
				[providerName]: t("config.missingBaseUrlApiKey"),
			}));
			return;
		}
		setFetchingProvider(providerName);
		setFetchModelsErrorByProvider((prev) => ({
			...prev,
			[providerName]: undefined,
		}));
		try {
			const result = await api.config.fetchModels(
				provider.baseUrl,
				provider.apiKey,
				provider.api as string | undefined,
			);
			if (result.success && result.models) {
				setFetchedModels((prev) => ({
					...prev,
					[providerName]: result.models!,
				}));
				setFetchModelsErrorByProvider((prev) => ({
					...prev,
					[providerName]: undefined,
				}));
				showToast(t("config.fetchedModels", { count: result.models.length }));
			} else {
				// 根据 API 类型提供不同的错误提示
				const apiTypeHint = getFetchModelsHintByApi(provider.api as string | undefined, provider.baseUrl);
				setFetchModelsErrorByProvider((prev) => ({
					...prev,
					[providerName]: (result.error ?? t("config.fetchModelsFailed")) + "\n" + apiTypeHint,
				}));
			}
		} catch (e) {
			setFetchModelsErrorByProvider((prev) => ({
				...prev,
				[providerName]: e instanceof Error ? e.message : String(e),
			}));
		} finally {
			setFetchingProvider(null);
		}
	};

	// 快速测试 provider 连接
	const handleTestProvider = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setError(t("config.missingBaseUrlApiKey"));
			return;
		}
		// 确定测试用的模型：优先用户指定的 testModelId，否则取第一个模型 id
		const modelId =
			(testModelIdByProvider[providerName] ?? "").trim() ||
			provider.models[0]?.id ||
			"";
		if (!modelId) {
			setError(t("config.missingTestModel"));
			return;
		}
		setTestingProvider(providerName);
		setTestResult(null);
		setError(null);
		try {
			const result = await api.config.testProvider(
				provider.baseUrl,
				provider.apiKey,
				modelId,
				provider.api as string | undefined,
				getProviderHeaders(provider.headers),
			);
			setTestResult({ providerName, ...result });
		} catch (e) {
			setTestResult({
				providerName,
				success: false,
				error: e instanceof Error ? e.message : String(e),
			});
		} finally {
			setTestingProvider(null);
		}
	};

	const handleAddModel = (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const newModel: ModelItem = {
			id: "",
			name: "",
			...DEFAULT_MODEL_CONFIG,
		};
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models: [...provider.models, newModel] },
			},
		};
		setModelsData(updated);
	};

	const handleUpdateModel = (
		providerName: string,
		index: number,
		field: string,
		value: unknown,
	) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const models = [...provider.models];
		models[index] = { ...models[index], [field]: value };
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models },
			},
		});
	};

	const handleUpdateModelXhigh = (
		providerName: string,
		index: number,
		value: "" | "xhigh" | "max",
	) => {
		const provider = modelsData.providers[providerName];
		const currentModel = provider?.models[index];
		if (!provider || !currentModel) return;
		const models = [...provider.models];
		const nextThinkingLevelMap = {
			...(currentModel.thinkingLevelMap ?? {}),
		};
		if (value) nextThinkingLevelMap.xhigh = value;
		else delete nextThinkingLevelMap.xhigh;
		const nextModel = {
			...currentModel,
			// xhigh 只有 reasoning 模型才有意义；打开映射时同步开启，避免保存后 UI 看似配置成功但 pi 仍不展示思考档位。
			reasoning: value ? true : currentModel.reasoning,
		};
		if (Object.keys(nextThinkingLevelMap).length > 0) {
			nextModel.thinkingLevelMap = nextThinkingLevelMap;
		} else {
			delete nextModel.thinkingLevelMap;
		}
		models[index] = nextModel;

		const nextProvider = value
			? {
				...provider,
				compat: {
					supportsDeveloperRole: false,
					...(provider.compat ?? {}),
					// xhigh 映射必须最终发送给上游；自动打开可减少用户遗漏 provider 兼容开关导致回退 high。
					supportsReasoningEffort: true,
				},
			}
			: { ...provider };
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...nextProvider, models },
			},
		});
	};

	const handleDeleteModel = (providerName: string, index: number) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const model = provider.models[index];
		if (!model) return;
		setDeleteConfirm({
			type: "model",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name: `${providerName}/${model.id}` }),
			onConfirm: () => {
				const models = provider.models.filter((_, i) => i !== index);
				setModelsData({
					...modelsData,
					providers: {
						...modelsData.providers,
						[providerName]: { ...provider, models },
					},
				});
				setDeleteConfirm(null);
			},
		});
	};

	const handleSaveModels = async () => {
		// 保存前规范化所有供应商的 compat 字段，确保布尔值显式写入而不依赖后端默认值
		const normalizedData = {
			...modelsData,
			providers: Object.fromEntries(
				Object.entries(modelsData.providers).map(([name, provider]) => [
					name,
					{
						...provider,
						compat: {
							supportsDeveloperRole: false,
							supportsReasoningEffort: false,
							...(provider.compat as Record<string, unknown> | undefined),
						},
					},
				]),
			),
		};
		await saveAndReload(
			() => api.config.saveModels(normalizedData),
			t("config.modelsSaved"),
		);
		await loadConfig("models");

		// 保存后自动刷新所有运行中的 Agent，使模型配置实时生效
		void refreshRunningAgents();
	};

	// ── Auth 操作 ────────────────────────────────────────

	const handleUpdateAuth = (provider: string, field: string, value: string) => {
		setAuthData({
			...authData,
			[provider]: { ...authData[provider], [field]: value },
		});
	};

	/**
	 * 添加认证条目。
	 * name 和 key 从 AuthTab 供应商选择弹窗直接传入，
	 * 避免 React 闭包中状态尚未刷新的问题，且支持弹窗内直接填写 API Key。
	 */
	const handleAddAuth = (name?: string, key?: string) => {
		const finalName = name ?? newAuthName.trim();
		if (!finalName) return;
		setAuthData({
			...authData,
			[finalName]: { type: "api_key", key: key ?? "" },
		});
		setExpandedAuth(finalName);
		setAddingAuth(false);
		setNewAuthName("");
	};

	const handleDeleteAuth = (provider: string) => {
		setDeleteConfirm({
			type: "auth",
			title: t("common.deleteConfirm"),
			message: t("common.deleteConfirmMsg", { name: provider }),
			onConfirm: () => {
				const updated = { ...authData };
				delete updated[provider];
				setAuthData(updated);
				if (expandedAuth === provider) setExpandedAuth(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDuplicateAuth = (provider: string) => {
		const sourceAuth = authData[provider];
		if (!sourceAuth) return;
		const duplicatedAuth = JSON.parse(JSON.stringify(sourceAuth));
		let newName = `${provider} copy`;
		let counter = 2;
		while (authData[newName]) {
			newName = `${provider} copy ${counter}`;
			counter++;
		}
		setAuthData({
			...authData,
			[newName]: duplicatedAuth,
		});
		setExpandedAuth(newName);
	};

	const handleDeleteProviders = (names: string[]) => {
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("common.deleteBatchConfirm", { count: names.length }),
			onConfirm: () => {
				const providers = { ...modelsData.providers };
				for (const name of names) delete providers[name];
				setModelsData({ ...modelsData, providers });
				if (names.includes(expandedProvider ?? "")) setExpandedProvider(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleDeleteAuths = (providers: string[]) => {
		setDeleteConfirm({
			type: "batch",
			title: t("common.deleteConfirm"),
			message: t("common.deleteBatchConfirm", { count: providers.length }),
			onConfirm: () => {
				const updated = { ...authData };
				for (const provider of providers) delete updated[provider];
				setAuthData(updated);
				if (providers.includes(expandedAuth ?? "")) setExpandedAuth(null);
				setDeleteConfirm(null);
			},
		});
	};

	const handleSaveAuth = async () => {
		await saveAndReload(() => api.config.saveAuth(authData));
		await loadConfig("auth");
	};

	// ── Settings 操作 ────────────────────────────────────

	const handleSaveSettings = async () => {
		await saveAndReload(() => api.config.saveSettings(settingsData));
		await loadConfig("settings");
	};

	// ── Trust 操作 ────────────────────────────────────────

	const handleSaveTrust = async () => {
		await saveAndReload(() => api.config.saveRaw("trust.json", JSON.stringify(trustData, null, 2)));
		await loadConfig("trust");
	};

	// ── Raw 操作 ─────────────────────────────────────────

	const handleSaveRaw = async () => {
		const isModelsFile = rawFileName === "models.json";
		await saveAndReload(
			() => api.config.saveRaw(rawFileName, rawContent),
			isModelsFile ? t("config.modelsSaved") : undefined,
		);
		if (isModelsFile) {
			await loadConfig("models");
			// Raw 保存也触发模型刷新，确保运行中的 Agent 实时生效
			void refreshRunningAgents();
		} else if (rawFileName === "auth.json") await loadConfig("auth");
		else if (rawFileName === "trust.json") await loadConfig("trust");
		else await loadConfig("settings");
	};

	// 切换源文件时重新加载对应文件内容
	const handleRawFileChange = async (fileName: string) => {
		setRawFileName(fileName);
		setLoading(true);
		try {
			const res =
				fileName === "models.json"
					? await api.config.getModels()
					: fileName === "auth.json"
						? await api.config.getAuth()
						: fileName === "trust.json"
							? await api.config.getTrust()
							: await api.config.getSettings();
			setRawContent(res.raw);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	// ── 导出 / 导入 ─────────────────────────────────────

	/** 将三个配置文件打包为 JSON 并触发浏览器下载。 */
	const handleExport = async () => {
		try {
			const json = await api.config.export();
			const blob = new Blob([json], { type: "application/json" });
			const url = URL.createObjectURL(blob);
			const a = document.createElement("a");
			a.href = url;
			// 文件名含时间戳，便于用户区分多次备份
			a.download = `pideck-config-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
			showToast(t("config.exported"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	/** 刷新 prompt templates 列表 */
	const refreshPrompts = async () => {
		const res = await api.prompts.list();
		// 过滤掉用户已删除的内置模板，同时翻译内置模板的 description
		res.templates = res.templates
			.filter((t) => t.userCreated || !deletedBuiltinNames.has(t.name))
			.map((tpl) => ({
				...tpl,
				description: translateBuiltinPromptDescription(tpl),
			}));
		setPromptsData(res);
	};

	/** 创建新 prompt template */
	const handleCreatePrompt = async () => {
		setCreatingPrompt(true);
		setError(null);
		try {
			await api.prompts.create({
				name: newPromptName,
				description: newPromptDescription,
			});
			setNewPromptName("");
			setNewPromptDescription("");
			await refreshPrompts();
			showToast(t("config.promptCreatedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreatingPrompt(false);
		}
	};

	/** 确认删除 prompt template */
	const confirmDeletePrompt = async (target: PiPromptTemplateSummary) => {
		setError(null);
		if (target.userCreated) {
			try {
				await api.prompts.delete(target.path);
				await refreshPrompts();
				showToast(t("config.promptDeletedToast"));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		} else {
			// 内置模板：从显示列表中移除
			setDeletedBuiltinNames((prev) => new Set(prev).add(target.name));
			showToast(t("config.promptDeletedToast"));
		}
	};

	/** 打开 prompt template 编辑器 */
	const handleEditPrompt = async (template: PiPromptTemplateSummary) => {
		// 内置模板直接使用预加载的 content，无需从文件读取
		if (!template.userCreated) {
			setEditingPrompt(template);
			setEditPromptContent(template.content);
			setEditPromptLoading(false);
			setError(null);
			return;
		}
		setEditingPrompt(template);
		setEditPromptContent("");
		setEditPromptLoading(true);
		setError(null);
		try {
			const content = await api.prompts.edit(template.path);
			setEditPromptContent(content as string);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingPrompt(null);
		} finally {
			setEditPromptLoading(false);
		}
	};

	/** 取消编辑 prompt template */
	const handleCancelEditPrompt = () => {
		setEditingPrompt(null);
		setEditPromptContent("");
	};

	/** 保存 prompt template 编辑器内容 */
	const handleSaveEditPrompt = async () => {
		if (!editingPrompt || editPromptSaving) return;
		setEditPromptSaving(true);
		setError(null);
		try {
			if (!editingPrompt.userCreated) {
				// 内置模板：先创建用户副本，再写入编辑内容
				const created = await api.prompts.create({
					name: editingPrompt.name,
					description: editingPrompt.description,
				});
				await api.prompts.edit(created.path, editPromptContent);
			} else {
				await api.prompts.edit(editingPrompt.path, editPromptContent);
			}
			showToast(t("config.promptSavedToast"));
			setEditingPrompt(null);
			await refreshPrompts();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditPromptSaving(false);
		}
	};

	/** Ctrl+S 快速保存：保存但不关闭弹框、不弹提示 */
	const handleRenamePrompt = async (template: { name: string; path: string }, newName: string) => {
		setError(null);
		try {
			await api.prompts.rename(template.name, newName);
			await refreshPrompts();
			showToast(t("config.promptRenamedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleQuickSavePrompt = async () => {
		if (!editingPrompt || editPromptSaving) return;
		setEditPromptSaving(true);
		setError(null);
		try {
			if (!editingPrompt.userCreated) {
				const created = await api.prompts.create({
					name: editingPrompt.name,
					description: editingPrompt.description,
				});
				await api.prompts.edit(created.path, editPromptContent);
			} else {
				await api.prompts.edit(editingPrompt.path, editPromptContent);
			}
			await refreshPrompts();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditPromptSaving(false);
		}
	};

	/** 从用户选择的 JSON 文件导入配置，成功后刷新当前 tab。 */
	const refreshSkills = async () => {
		const res = await api.skills.list();
		setSkillsData(res);
		if (res.locations[0] && !res.locations.some((item) => item.id === newSkillLocationId)) {
			setNewSkillLocationId(res.locations[0].id);
		}
	};

	const handleCreateSkill = async () => {
		setCreatingSkill(true);
		setError(null);
		try {
			await api.skills.create({
				name: newSkillName,
				description: newSkillDescription,
				locationId: newSkillLocationId,
			});
			setNewSkillName("");
			setNewSkillDescription("");
			await refreshSkills();
			showToast(t("config.skillCreatedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setCreatingSkill(false);
		}
	};

	const handleToggleSkill = async (path: string, enabled: boolean) => {
		setError(null);
		try {
			await api.skills.toggle(path, enabled);
			await refreshSkills();
			showToast(enabled ? t("config.skillEnabledToast") : t("config.skillDisabledToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const confirmDeleteSkill = async () => {
		if (!deleteSkillConfirm) return;
		const target = deleteSkillConfirm;
		setDeleteSkillConfirm(null);
		setError(null);
		try {
			await api.skills.delete(target.path);
			await refreshSkills();
			showToast(t("config.skillDeletedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleRenameGlobalSkill = async (skill: PiSkillSummary, newName: string) => {
		setError(null);
		try {
			await api.skills.rename(skill.path, newName);
			await refreshSkills();
			showToast(t("config.skillRenamedToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const handleEditGlobalSkill = async (skill: PiSkillSummary) => {
		setEditingGlobalSkill(skill);
		setEditGlobalContent("");
		setEditGlobalLoading(true);
		setError(null);
		try {
			const content = await window.piDesktop.files.readContent(skill.path);
			setEditGlobalContent(content);
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
			setEditingGlobalSkill(null);
		} finally {
			setEditGlobalLoading(false);
		}
	};

	// Ctrl+S / Cmd+S 快捷键保存 skill 编辑器
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if ((e.ctrlKey || e.metaKey) && e.key === "s" && editingGlobalSkill && !editGlobalSaving) {
				e.preventDefault();
				void saveGlobalSkillEditor();
			}
		};
		if (editingGlobalSkill) {
			window.addEventListener("keydown", handleKeyDown);
			return () => window.removeEventListener("keydown", handleKeyDown);
		}
	}, [editingGlobalSkill, editGlobalSaving]);

	const saveGlobalSkillEditor = async () => {
		if (!editingGlobalSkill || editGlobalSaving) return;
		setEditGlobalSaving(true);
		setError(null);
		try {
			await window.piDesktop.files.writeContent(editingGlobalSkill.path, editGlobalContent);
			setEditGlobalSaved(true);
			window.setTimeout(() => setEditGlobalSaved(false), 2000);
			await refreshSkills();
		} catch (err) {
			setError(err instanceof Error ? err.message : String(err));
		} finally {
			setEditGlobalSaving(false);
		}
	};

	const refreshExtensions = async () => {
		setExtensionsLoading(true);
		setError(null);
		try {
			const res = await api.extensions.list();
			setExtensionsData(res);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setExtensionsLoading(false);
		}
	};

	const confirmUninstallExtension = async () => {
		if (!uninstallExtensionConfirm) return;
		const target = uninstallExtensionConfirm;
		// 防御性检查：内置扩展不应出现在确认弹窗中
		if (target.builtIn) {
			setUninstallExtensionConfirm(null);
			return;
		}
		setUninstallExtensionConfirm(null);
		setUninstallingExtensionSource(target.source);
		setError(null);
		try {
			await api.extensions.uninstall(target.source, target.scope);
			await refreshExtensions();
			showToast(t("config.extensionUninstalledToast"));
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setUninstallingExtensionSource(null);
		}
	};

	const handleImport = async () => {
		const input = document.createElement("input");
		input.type = "file";
		input.accept = ".json";
		input.onchange = async () => {
			const file = input.files?.[0];
			if (!file) return;
			try {
				const text = await file.text();
				const result = await api.config.import(text);
				if (!result.valid) {
					setError(result.error ?? t("config.importFailed"));
					return;
				}
				onSaved();
				await loadConfig(tab);
				showToast(t("config.imported"));
			} catch (e) {
				setError(e instanceof Error ? e.message : String(e));
			}
		};
		input.click();
	};

	const configNavItems: Array<{ id: ConfigTab; label: string }> = [
		{ id: "models", label: t("config.nav.models") },
		{ id: "auth", label: t("config.nav.auth") },
		{ id: "settings", label: t("config.nav.settings") },
		{ id: "trust", label: t("config.nav.trust") },
		{ id: "raw", label: t("config.nav.raw") },
	];

	if (!open) return null;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="config-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<strong>{t("config.title")}</strong>
					<div className="modal-header-actions">
						{section === "config" && (
							<>
								<button className="config-btn primary" onClick={handleExport}>
									{t("common.export")}
								</button>
								<button className="config-btn blue" onClick={handleImport}>
									{t("common.import")}
								</button>
							</>
						)}
						<CloseIconButton label={t("common.close")} onClick={onClose} />
					</div>
				</div>

				<div className="config-layout">
					<aside className="config-sidebar" aria-label={t("config.title")}>
						<div className="config-sidebar-group">
							<span>{t("config.group.config")}</span>
							{configNavItems.map((item) => (
								<button
									key={item.id}
									className={
										section === "config" && tab === item.id ? "active" : ""
									}
									onClick={() => {
										setSection("config");
										setTab(item.id);
									}}
								>
									{item.label}
								</button>
							))}
						</div>
						<div className="config-sidebar-group">
							<span>{t("config.group.agent")}</span>
							<button
								className={section === "extensions" ? "active" : ""}
								onClick={() => setSection("extensions")}
							>
								{t("config.nav.extensions")}
							</button>
							<button
								className={section === "skills" ? "active" : ""}
								onClick={() => setSection("skills")}
							>
								{t("config.nav.skills")}
							</button>
							<button
								className={section === "prompts" ? "active" : ""}
								onClick={() => setSection("prompts")}
							>
								{t("config.nav.prompts")}
							</button>
						</div>
						<div className="config-sidebar-group">
							<span>{t("config.group.im")}</span>
							<button
								className={section === "im" ? "active" : ""}
								onClick={() => setSection("im")}
							>
								{t("config.nav.im")}
							</button>
						</div>
						<div className="config-sidebar-group">
							<span>{t("config.group.other")}</span>
							<button
								className={section === "editors" ? "active" : ""}
								onClick={() => setSection("editors")}
							>
								{t("config.nav.editors")}
							</button>
						</div>
						<div className="config-sidebar-group">
							<span>{t("config.group.diagnostics")}</span>
							<button
								className={section === "logs" ? "active" : ""}
								onClick={() => setSection("logs")}
							>
								{t("config.nav.logs")}
							</button>
						</div>
					</aside>

					<main className="config-main">
						<div className="config-content">
					{loading && <div className="config-loading">{t("common.loading")}</div>}
					{error && <div className="config-error">{error}</div>}
					{section === "config" && configDiagnostic && (
						<ConfigDiagnosticCard
							diagnostic={configDiagnostic}
							onOpenDocs={() => api.app.openExternal(configDiagnostic.docsUrl)}
							onOpenRaw={() => setTab("raw")}
						/>
					)}

					{section === "config" && !loading && tab === "models" && (
						<ModelsTab
							data={modelsData}
							expandedProvider={expandedProvider}
							addingProvider={addingProvider}
							newProviderName={newProviderName}
							renamingProvider={renamingProvider}
							renameValue={renameValue}
							fetchingProvider={fetchingProvider}
							fetchedModels={fetchedModels}
							fetchModelsErrorByProvider={fetchModelsErrorByProvider}
							testingProvider={testingProvider}
							testResult={testResult}
							testModelIdByProvider={testModelIdByProvider}
							saving={saving}
							onToggleProvider={(name) =>
								setExpandedProvider(expandedProvider === name ? null : name)
							}
							onStartAddProvider={() => {
								setAddingProvider(true);
								setNewProviderName("");
							}}
							onCancelAddProvider={() => setAddingProvider(false)}
							onChangeNewProviderName={setNewProviderName}
							onConfirmAddProvider={handleAddProvider}
							onStartRename={handleStartRename}
							onChangeRenameValue={setRenameValue}
							onConfirmRename={handleConfirmRename}
							onCancelRename={handleCancelRename}
							onDeleteProvider={handleDeleteProvider}
							onDuplicateProvider={handleDuplicateProvider}
							onDeleteProviders={handleDeleteProviders}
							onAddModel={handleAddModel}
							onUpdateModel={handleUpdateModel}
							onUpdateModelXhigh={handleUpdateModelXhigh}
							onDeleteModel={handleDeleteModel}
							onFetchModels={handleFetchModels}
							onTestProvider={handleTestProvider}
							onChangeTestModelId={(providerName, modelId) =>
								setTestModelIdByProvider((current) => ({
									...current,
									[providerName]: modelId,
								}))
							}
							onClearTestResult={() => setTestResult(null)}
							onSave={handleSaveModels}
							onChangeProvider={(name, field, value) => {
								const provider = modelsData.providers[name];
								if (!provider) return;
								setModelsData({
									...modelsData,
									providers: {
										...modelsData.providers,
										[name]: { ...provider, [field]: value },
									},
								});
							}}
						/>
					)}

					{section === "config" && !loading && tab === "auth" && (
						<AuthTab
							data={authData}
							expandedAuth={expandedAuth}
							addingAuth={addingAuth}
							newAuthName={newAuthName}
							saving={saving}
							modelsData={modelsData}
							onToggleAuth={(name) =>
								setExpandedAuth(expandedAuth === name ? null : name)
							}
							onStartAddAuth={() => {
								setAddingAuth(true);
								setNewAuthName("");
							}}
							onCancelAddAuth={() => setAddingAuth(false)}
							onChangeNewAuthName={setNewAuthName}
							onConfirmAddAuth={(name, key) => handleAddAuth(name, key)}
							onDuplicateAuth={handleDuplicateAuth}
						onDeleteAuths={handleDeleteAuths}
						onDeleteAuth={handleDeleteAuth}
							onUpdate={handleUpdateAuth}
							onSave={handleSaveAuth}
						/>
					)}

					{section === "config" && !loading && tab === "settings" && (
						<SettingsTab
							data={settingsData}
							saving={saving}
							modelsData={modelsData}
							authData={authData}
							discoveredModels={discoveredModels}
							onChange={setSettingsData}
							onSave={handleSaveSettings}
						/>
					)}

					{section === "im" && !loading && (
						<ImTab />
					)}

					{section === "logs" && !loading && (
						<LogsTab />
					)}

					{section === "skills" && !loading && (
						editingGlobalSkill ? (
							<div className="prompts-editor-backdrop" onClick={() => setEditingGlobalSkill(null)}>
								<div className="prompts-editor-modal" onClick={(e) => e.stopPropagation()}>
									<div className="file-diff-header">
										<span className="file-diff-header-file">{editingGlobalSkill.name} · SKILL.md</span>
										<div className="file-diff-header-actions">
											<CloseIconButton label={t("common.close")} onClick={() => setEditingGlobalSkill(null)} />
										</div>
									</div>
									{editGlobalLoading ? (
										<div className="config-empty">{t("common.loading")}</div>
									) : (
										<div className="prompts-monaco-wrap">
											<LazyMonacoEditor
												value={editGlobalContent}
												onChange={setEditGlobalContent}
											/>
									</div>
								)}
								{editGlobalSaved && <span className="file-diff-hint saved">{t("config.promptSavedHint")}</span>}
							</div>
						</div>
					) : (
							<SkillsTab
							data={skillsData}
							loading={loading}
							creating={creatingSkill}
							newName={newSkillName}
							newDescription={newSkillDescription}
							newLocationId={newSkillLocationId}
							onRefresh={refreshSkills}
							onOpenRoot={() => api.skills.openFolder()}
							onChangeNewName={setNewSkillName}
							onChangeNewDescription={setNewSkillDescription}
							onChangeNewLocation={setNewSkillLocationId}
							onCreate={handleCreateSkill}
							onToggle={(skill, enabled) => handleToggleSkill(skill.path, enabled)}
							onDelete={setDeleteSkillConfirm}
							onEdit={handleEditGlobalSkill}
							onRename={handleRenameGlobalSkill}
						/>
						)
					)}

					{section === "prompts" && !loading && (
						<PromptsTab
							data={promptsData}
							loading={loading}
							creating={creatingPrompt}
							newName={newPromptName}
							newDescription={newPromptDescription}
							editingTemplate={editingPrompt}
							editContent={editPromptContent}
							editLoading={editPromptLoading}
							editSaving={editPromptSaving}
							onRefresh={refreshPrompts}
							onOpenRoot={() => api.prompts.openFolder()}
							onChangeNewName={setNewPromptName}
							onChangeNewDescription={setNewPromptDescription}
							onCreate={handleCreatePrompt}
							onDelete={confirmDeletePrompt}
							onEdit={handleEditPrompt}
							onRename={handleRenamePrompt}
							onQuickSave={handleQuickSavePrompt}
							onCancelEdit={handleCancelEditPrompt}
							onChangeEditContent={setEditPromptContent}
							onSaveEdit={handleSaveEditPrompt}
						/>
					)}

					{section === "extensions" && (
						<ExtensionsTab
							data={extensionsData}
							loading={extensionsLoading}
							uninstallingSource={uninstallingExtensionSource}
							onRefresh={refreshExtensions}
							onUninstall={setUninstallExtensionConfirm}
						/>
					)}

					{section === "editors" && !loading && (
						<EditorsTab />
					)}

					{section === "config" && !loading && tab === "trust" && (
						<TrustTab
							data={trustData}
							saving={saving}
							onChange={setTrustData}
							onSave={handleSaveTrust}
						/>
					)}

					{section === "config" && !loading && tab === "raw" && (
						<RawTab
							fileName={rawFileName}
							content={rawContent}
							saving={saving}
							onChangeFileName={handleRawFileChange}
							onChangeContent={setRawContent}
							onSave={handleSaveRaw}
						/>
					)}
						</div>
					</main>
				</div>

				{deleteSkillConfirm && (
					<div className="session-delete-confirm-backdrop" onClick={() => setDeleteSkillConfirm(null)}>
						<div className="session-delete-confirm skill-delete-confirm" onClick={(event) => event.stopPropagation()}>
							<strong>{t("config.deleteSkillConfirmTitle")}</strong>
							<p>
								{t("config.deleteSkillConfirmBody", {
									name: deleteSkillConfirm.name,
								})}
							</p>
							<small>{deleteSkillConfirm.path}</small>
							<div className="session-delete-confirm-actions">
								<button onClick={() => setDeleteSkillConfirm(null)}>{t("common.cancel")}</button>
								<button className="danger" onClick={() => void confirmDeleteSkill()}>
									{t("common.delete")}
								</button>
							</div>
						</div>
					</div>
				)}

				{uninstallExtensionConfirm && (
					<div className="session-delete-confirm-backdrop" onClick={() => setUninstallExtensionConfirm(null)}>
						<div className="session-delete-confirm skill-delete-confirm" onClick={(event) => event.stopPropagation()}>
							<strong>{t("config.uninstallExtensionTitle")}</strong>
							<p>
								{t("config.uninstallExtensionBody", {
									source: uninstallExtensionConfirm.source,
								})}
							</p>
							{uninstallExtensionConfirm.path && <small>{uninstallExtensionConfirm.path}</small>}
							<div className="session-delete-confirm-actions">
								<button onClick={() => setUninstallExtensionConfirm(null)}>{t("common.cancel")}</button>
								<button className="danger" onClick={confirmUninstallExtension}>{t("config.uninstall")}</button>
							</div>
						</div>
					</div>
				)}

				{/* toast 已改用 sonner */}
				{deleteConfirm && (
					<div className="config-modal-overlay" onClick={() => setDeleteConfirm(null)}>
						<div className="config-modal-dialog" onClick={(e) => e.stopPropagation()}>
							<strong>{deleteConfirm.title}</strong>
							<p>{deleteConfirm.message}</p>
							<div className="config-modal-actions">
								<button className="config-btn danger" onClick={deleteConfirm.onConfirm}>
									{t("common.delete")}
								</button>
								<button className="config-btn" onClick={() => setDeleteConfirm(null)}>
									{t("common.cancel")}
								</button>
							</div>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}

