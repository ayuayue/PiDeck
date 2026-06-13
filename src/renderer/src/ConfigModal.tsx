import { Component, useState, useEffect, useCallback, type ReactNode } from "react";
import type { PiDesktopApi } from "../../preload";
import { AuthTab } from "./config/AuthTab";
import { ModelsTab } from "./config/ModelsTab";
import { RawTab } from "./config/RawTab";
import { SettingsTab } from "./config/SettingsTab";
import { SkillsTab } from "./config/SkillsTab";
import { ExtensionsTab } from "./config/ExtensionsTab";
import { t } from "./i18n";
import type {
	AuthFile,
	ConfigTab,
	ModelItem,
	ModelsFile,
	SettingsFile,
} from "./config/configTypes";
import type { ConfigFileDiagnostic, PiExtensionListResult, PiExtensionSummary, PiSkillListResult, PiSkillLocation, PiSkillSummary } from "../../shared/types";
import { getProviderHeaders } from "./config/providerHeaders";

const api: PiDesktopApi = (window as unknown as { piDesktop: PiDesktopApi })
	.piDesktop;
const DEFAULT_MODEL_CONFIG: Pick<
	ModelItem,
	"contextWindow" | "maxTokens" | "reasoning"
> = {
	contextWindow: 1000000,
	maxTokens: 128000,
	reasoning: true,
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
				? rawModels.filter((model): model is ModelItem =>
						Boolean(model) && typeof model === "object" && !Array.isArray(model),
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
				<strong>{diagnostic.fileName} 加载失败</strong>
				<span>
					{diagnostic.line && diagnostic.column
						? `第 ${diagnostic.line} 行，第 ${diagnostic.column} 列：${diagnostic.message}`
						: diagnostic.message}
				</span>
				<small>
					已保留源文件内容，可切到“源文件”修复。复杂 provider/model 字段（如 compat、headers、thinkingLevelMap、modelOverrides）建议参考{" "}
					<a href={diagnostic.docsUrl} target="_blank" rel="noreferrer">
						pi 官方配置文档
					</a>
					。
				</small>
			</div>
			{diagnostic.snippet && <pre>{diagnostic.snippet}</pre>}
			<div className="config-diagnostic-actions">
				<button className="config-btn primary" onClick={props.onOpenRaw}>打开源文件</button>
				<button className="config-btn" onClick={props.onOpenDocs}>查看官方文档</button>
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
			<div className="modal-backdrop">
				<div className="config-modal">
					<div className="modal-header">
						<strong>配置管理加载失败</strong>
						<button className="modal-close-btn" onClick={this.props.onClose}>×</button>
					</div>
					<div className="config-content">
						<div className="config-diagnostic-card">
							<div>
								<strong>配置管理渲染异常</strong>
								<span>{this.state.error.message}</span>
								<small>
									这通常是某个配置字段结构超出了当前可视化表单的兼容范围。配置文件不会被修改，建议先查看{" "}
									<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer">pi models 文档</a>
									{" / "}
									<a href="https://pi.dev/docs/latest/settings" target="_blank" rel="noreferrer">settings 文档</a>
									，并把控制台错误和配置片段反馈给我们。
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
	const [section, setSection] = useState<"config" | "skills" | "extensions">("config");
	const [tab, setTab] = useState<ConfigTab>("models");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [configDiagnostic, setConfigDiagnostic] = useState<ConfigFileDiagnostic | null>(null);
	const [toast, setToast] = useState<string | null>(null);

	// 各 tab 的数据
	const [modelsData, setModelsData] = useState<ModelsFile>({ providers: {} });
	const [authData, setAuthData] = useState<AuthFile>({});
	const [settingsData, setSettingsData] = useState<SettingsFile>({});
	const [skillsData, setSkillsData] = useState<PiSkillListResult>({
		locations: [],
		skills: [],
	});
	const [extensionsData, setExtensionsData] = useState<PiExtensionListResult>({
		extensions: [],
		raw: "",
	});
	const [creatingSkill, setCreatingSkill] = useState(false);
	const [uninstallingExtensionSource, setUninstallingExtensionSource] = useState<string | null>(null);
	const [newSkillName, setNewSkillName] = useState("");
	const [newSkillDescription, setNewSkillDescription] = useState("");
	const [newSkillLocationId, setNewSkillLocationId] = useState<PiSkillLocation["id"]>("pi-global");
	const [deleteSkillConfirm, setDeleteSkillConfirm] = useState<PiSkillSummary | null>(null);
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
					const res = await api.config.getSettings();
					setSettingsData(res.parsed as SettingsFile);
					setRawContent(res.raw);
					setRawFileName("settings.json");
					setConfigDiagnostic(res.diagnostic ?? null);
				} else if (target === "raw") {
					// 源文件 tab 复用当前 tab 对应的文件
					const fileName =
						tab === "models"
							? "models.json"
							: tab === "auth"
								? "auth.json"
								: "settings.json";
					setRawFileName(fileName);
					const res =
						fileName === "models.json"
							? await api.config.getModels()
							: fileName === "auth.json"
								? await api.config.getAuth()
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
		if (section === "extensions") {
			void refreshExtensions();
			return;
		}
		void loadConfig(tab);
	}, [open, section, tab, loadConfig]);

	const showToast = (msg: string) => {
		setToast(msg);
		setTimeout(() => setToast(null), 2500);
	};

	const saveAndReload = async (
		saveFn: () => Promise<{ valid: boolean; error?: string }>,
	) => {
		setSaving(true);
		setError(null);
		try {
			const result = await saveFn();
			if (!result.valid) {
				setError(result.error ?? "保存失败");
				return;
			}
			onSaved();
			showToast("配置已保存");
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
		const providers = { ...modelsData.providers };
		delete providers[name];
		setModelsData({ ...modelsData, providers });
		if (expandedProvider === name) setExpandedProvider(null);
	};

	// 从 provider 的 baseUrl + apiKey 拉取可用模型列表
	const handleFetchModels = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setError("请先填写 Base URL 和 API Key");
			return;
		}
		setFetchingProvider(providerName);
		setError(null);
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
				showToast(`已获取 ${result.models.length} 个模型`);
			} else {
				setError(result.error ?? "获取模型列表失败");
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setFetchingProvider(null);
		}
	};

	// 快速测试 provider 连接
	const handleTestProvider = async (providerName: string) => {
		const provider = modelsData.providers[providerName];
		if (!provider?.baseUrl || !provider?.apiKey) {
			setError("请先填写 Base URL 和 API Key");
			return;
		}
		// 确定测试用的模型：优先用户指定的 testModelId，否则取第一个模型 id
		const modelId =
			(testModelIdByProvider[providerName] ?? "").trim() ||
			provider.models[0]?.id ||
			"";
		if (!modelId) {
			setError("请至少添加一个模型，或在测试模型框中手动输入模型 ID");
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

	const handleDeleteModel = (providerName: string, index: number) => {
		const provider = modelsData.providers[providerName];
		if (!provider) return;
		const models = provider.models.filter((_, i) => i !== index);
		setModelsData({
			...modelsData,
			providers: {
				...modelsData.providers,
				[providerName]: { ...provider, models },
			},
		});
	};

	const handleSaveModels = async () => {
		await saveAndReload(() => api.config.saveModels(modelsData));
		await loadConfig("models");
	};

	// ── Auth 操作 ────────────────────────────────────────

	const handleUpdateAuth = (provider: string, field: string, value: string) => {
		setAuthData({
			...authData,
			[provider]: { ...authData[provider], [field]: value },
		});
	};

	const handleAddAuth = () => {
		if (!newAuthName.trim()) return;
		setAuthData({
			...authData,
			[newAuthName.trim()]: { type: "api_key", key: "" },
		});
		setExpandedAuth(newAuthName.trim());
		setAddingAuth(false);
		setNewAuthName("");
	};

	const handleDeleteAuth = (provider: string) => {
		const updated = { ...authData };
		delete updated[provider];
		setAuthData(updated);
		if (expandedAuth === provider) setExpandedAuth(null);
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

	// ── Raw 操作 ─────────────────────────────────────────

	const handleSaveRaw = async () => {
		await saveAndReload(() => api.config.saveRaw(rawFileName, rawContent));
		if (rawFileName === "models.json") await loadConfig("models");
		else if (rawFileName === "auth.json") await loadConfig("auth");
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
			a.download = `pi-desktop-config-${new Date().toISOString().slice(0, 10)}.json`;
			a.click();
			URL.revokeObjectURL(url);
			showToast("配置已导出");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
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
			showToast("Skill 已创建，重启 agent 后生效");
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
			showToast(enabled ? "Skill 已启用，重启 agent 后生效" : "Skill 已禁用，重启 agent 后生效");
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
			showToast("Skill 已删除，重启 agent 后生效");
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		}
	};

	const refreshExtensions = async () => {
		setLoading(true);
		setError(null);
		try {
			const res = await api.extensions.list();
			setExtensionsData(res);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setLoading(false);
		}
	};

	const confirmUninstallExtension = async () => {
		if (!uninstallExtensionConfirm) return;
		const target = uninstallExtensionConfirm;
		setUninstallExtensionConfirm(null);
		setUninstallingExtensionSource(target.source);
		setError(null);
		try {
			await api.extensions.uninstall(target.source, target.scope);
			await refreshExtensions();
			showToast("扩展已卸载，重启 agent 后生效");
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
					setError(result.error ?? "导入失败");
					return;
				}
				onSaved();
				await loadConfig(tab);
				showToast("配置已导入");
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
		{ id: "raw", label: t("config.nav.raw") },
	];

	if (!open) return null;

	return (
		<div className="modal-backdrop">
			<div className="config-modal">
				<div className="modal-header">
					<strong>{t("config.title")}</strong>
					<div className="modal-header-actions">
						{section === "config" && (
							<>
								<button className="config-btn primary" onClick={handleExport}>
									导出
								</button>
								<button className="config-btn blue" onClick={handleImport}>
									导入
								</button>
							</>
						)}
						<button className="modal-close-btn" onClick={onClose}>×</button>
					</div>
				</div>

				<div className="config-layout">
					<aside className="config-sidebar" aria-label={t("config.title")}>
						<div className="config-sidebar-group">
							<span>{t("config.nav.config")}</span>
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
							<span>Agent</span>
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
						</div>
					</aside>

					<main className="config-main">
						<div className="config-content">
					{loading && <div className="config-loading">加载中…</div>}
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
							onAddModel={handleAddModel}
							onUpdateModel={handleUpdateModel}
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
							onToggleAuth={(name) =>
								setExpandedAuth(expandedAuth === name ? null : name)
							}
							onStartAddAuth={() => {
								setAddingAuth(true);
								setNewAuthName("");
							}}
							onCancelAddAuth={() => setAddingAuth(false)}
							onChangeNewAuthName={setNewAuthName}
							onConfirmAddAuth={handleAddAuth}
							onDeleteAuth={handleDeleteAuth}
							onUpdate={handleUpdateAuth}
							onSave={handleSaveAuth}
						/>
					)}

					{section === "config" && !loading && tab === "settings" && (
						<SettingsTab
							data={settingsData}
							saving={saving}
							onChange={setSettingsData}
							onSave={handleSaveSettings}
						/>
					)}

					{section === "skills" && !loading && (
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
							onOpenFolder={(skill) => api.skills.openFolder(skill.path)}
						/>
					)}

					{section === "extensions" && !loading && (
						<ExtensionsTab
							data={extensionsData}
							loading={loading}
							uninstallingSource={uninstallingExtensionSource}
							onRefresh={refreshExtensions}
							onUninstall={setUninstallExtensionConfirm}
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
							<strong>删除 Skill</strong>
							<p>
								确认删除「{deleteSkillConfirm.name}」吗？此操作会删除本地 Skill 文件，且不可撤销。
							</p>
							<small>{deleteSkillConfirm.path}</small>
							<div className="session-delete-confirm-actions">
								<button onClick={() => setDeleteSkillConfirm(null)}>取消</button>
								<button className="danger" onClick={() => void confirmDeleteSkill()}>
									确认删除
								</button>
							</div>
						</div>
					</div>
				)}

				{uninstallExtensionConfirm && (
					<div className="session-delete-confirm-backdrop" onClick={() => setUninstallExtensionConfirm(null)}>
						<div className="session-delete-confirm skill-delete-confirm" onClick={(event) => event.stopPropagation()}>
							<strong>卸载扩展</strong>
							<p>
								确认卸载「{uninstallExtensionConfirm.source}」吗？这会执行 pi remove 并从 pi 配置中移除该扩展。
							</p>
							{uninstallExtensionConfirm.path && <small>{uninstallExtensionConfirm.path}</small>}
							<div className="session-delete-confirm-actions">
								<button onClick={() => setUninstallExtensionConfirm(null)}>取消</button>
								<button className="danger" onClick={confirmUninstallExtension}>卸载</button>
							</div>
						</div>
					</div>
				)}

				{toast && <div className="config-toast">{toast}</div>}
			</div>
		</div>
	);
}

