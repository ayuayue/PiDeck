import { useState, useEffect, useCallback } from "react";
import {
	Check,
	Eye,
	EyeOff,
	Trash2,
	ChevronDown,
	ChevronRight,
} from "lucide-react";
import type { PiDesktopApi } from "../../preload";

type ConfigTab = "models" | "auth" | "settings" | "raw";

// ── 匹配 pi 实际文件格式的类型 ────────────────────────

type ModelItem = {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	[key: string]: unknown;
};

type ProviderConfig = {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models: ModelItem[];
	[key: string]: unknown;
};

type ModelsFile = { providers: Record<string, ProviderConfig> };
type AuthFile = Record<
	string,
	{ type?: string; key?: string; [key: string]: unknown }
>;
type SettingsFile = Record<string, unknown>;

const api: PiDesktopApi = (window as unknown as { piDesktop: PiDesktopApi })
	.piDesktop;

const DEFAULT_PROVIDER_HEADERS = { "User-Agent": "pi-coding-agent" };
const USER_AGENT_OPTIONS = [
	{ value: "pi-coding-agent", label: "pi-coding-agent" },
	{ value: "Mozilla/5.0", label: "Mozilla/5.0" },
	{ value: "OpenAI/JS 6.26.0", label: "OpenAI/JS 6.26.0" },
	{ value: "", label: "不发送" },
];
const CUSTOM_USER_AGENT_VALUE = "__custom__";

function getProviderHeaders(value: unknown): Record<string, string> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const entries = Object.entries(value).filter(
		([key, headerValue]) =>
			key.trim().length > 0 && typeof headerValue === "string",
	);
	return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function getHeaderValue(headers: unknown, targetKey: string) {
	const normalized = getProviderHeaders(headers);
	if (!normalized) return "";
	const entry = Object.entries(normalized).find(
		([key]) => key.toLowerCase() === targetKey.toLowerCase(),
	);
	return entry?.[1] ?? "";
}

function setHeaderValue(
	headers: unknown,
	targetKey: string,
	value: string,
): Record<string, string> | undefined {
	const normalized = { ...(getProviderHeaders(headers) ?? {}) };
	for (const key of Object.keys(normalized)) {
		if (key.toLowerCase() === targetKey.toLowerCase()) delete normalized[key];
	}
	if (value.trim()) normalized[targetKey] = value.trim();
	return Object.keys(normalized).length > 0 ? normalized : undefined;
}

// pi provider 的 api 字段是字符串配置；这里提供常见值辅助选择，同时保留未知值以兼容用户自定义或未来新增类型。
const PROVIDER_API_OPTIONS = [
	"openai-completions",
	"openai-chat-completions",
	"openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"google-generative-ai",
	"mistral-conversations",
];

/** 配置管理弹窗：支持 models/auth/settings 三个 tab 的可视化编辑和源文件编辑 */
export function ConfigModal(props: {
	open: boolean;
	onClose: () => void;
	onSaved: () => void;
}) {
	const { open, onClose, onSaved } = props;
	const [tab, setTab] = useState<ConfigTab>("models");
	const [loading, setLoading] = useState(false);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [toast, setToast] = useState<string | null>(null);

	// 各 tab 的数据
	const [modelsData, setModelsData] = useState<ModelsFile>({ providers: {} });
	const [authData, setAuthData] = useState<AuthFile>({});
	const [settingsData, setSettingsData] = useState<SettingsFile>({});
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
			try {
				if (target === "models") {
					const res = await api.config.getModels();
					setModelsData(res.parsed as ModelsFile);
					setRawContent(res.raw);
					setRawFileName("models.json");
				} else if (target === "auth") {
					const res = await api.config.getAuth();
					setAuthData(res.parsed as AuthFile);
					setRawContent(res.raw);
					setRawFileName("auth.json");
				} else if (target === "settings") {
					const res = await api.config.getSettings();
					setSettingsData(res.parsed as SettingsFile);
					setRawContent(res.raw);
					setRawFileName("settings.json");
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
		if (open) loadConfig(tab);
	}, [open, tab, loadConfig]);

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
		if (!newProviderName.trim()) return;
		const updated = {
			...modelsData,
			providers: {
				...modelsData.providers,
				[newProviderName.trim()]: {
					headers: DEFAULT_PROVIDER_HEADERS,
					models: [],
				},
			},
		};
		setModelsData(updated);
		setExpandedProvider(newProviderName.trim());
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
		const newModel: ModelItem = { id: "", name: "" };
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

	if (!open) return null;

	return (
		<div className="modal-backdrop">
			<div className="config-modal">
				<div className="modal-header">
					<strong>配置管理</strong>
					<div className="modal-header-actions">
						<button className="config-btn primary" onClick={handleExport}>
							导出
						</button>
						<button className="config-btn blue" onClick={handleImport}>
							导入
						</button>
						<button className="modal-close-btn" onClick={onClose}>×</button>
					</div>
				</div>

				<div className="config-tabs">
					<button
						className={tab === "models" ? "active" : ""}
						onClick={() => setTab("models")}
					>
						Models
					</button>
					<button
						className={tab === "auth" ? "active" : ""}
						onClick={() => setTab("auth")}
					>
						Auth
					</button>
					<button
						className={tab === "settings" ? "active" : ""}
						onClick={() => setTab("settings")}
					>
						Setting
					</button>
					<button
						className={tab === "raw" ? "active" : ""}
						onClick={() => setTab("raw")}
					>
						源文件
					</button>
				</div>

				<div className="config-content">
					{loading && <div className="config-loading">加载中…</div>}
					{error && <div className="config-error">{error}</div>}

					{!loading && tab === "models" && (
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

					{!loading && tab === "auth" && (
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

					{!loading && tab === "settings" && (
						<SettingsTab
							data={settingsData}
							saving={saving}
							onChange={setSettingsData}
							onSave={handleSaveSettings}
						/>
					)}

					{!loading && tab === "raw" && (
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

				{toast && <div className="config-toast">{toast}</div>}
			</div>
		</div>
	);
}

// ── 复制到剪贴板工具 ──────────────────────────────────

function CopyButton(props: { text: string }) {
	const [copied, setCopied] = useState(false);
	const handleCopy = async (e: React.MouseEvent) => {
		e.stopPropagation();
		try {
			await navigator.clipboard.writeText(props.text);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			/* 静默失败 */
		}
	};
	return (
		<button
			className={`config-copy-btn ${copied ? "copied" : ""}`}
			onClick={handleCopy}
			title="复制"
		>
			{copied ? (
				<>
					<Check size={14} /> 已复制
				</>
			) : (
				"复制"
			)}
		</button>
	);
}

/** 密码输入框：支持显示/隐藏 + 复制 */
function SecretInput(props: {
	value: string;
	onChange: (v: string) => void;
	placeholder?: string;
}) {
	const [visible, setVisible] = useState(false);
	return (
		<div className="config-secret-input">
			<input
				type={visible ? "text" : "password"}
				value={props.value}
				onChange={(e) => props.onChange(e.target.value)}
				placeholder={props.placeholder ?? "sk-..."}
			/>
			<button
				className="config-eye-btn"
				onClick={() => setVisible(!visible)}
				title={visible ? "隐藏" : "显示"}
			>
				{visible ? <EyeOff size={15} /> : <Eye size={15} />}
			</button>
			<CopyButton text={props.value} />
		</div>
	);
}

// ── Models Tab ──────────────────────────────────────────

/** API 类型输入：自定义 combobox，避免原生 datalist 在 Electron 滚动容器中出现弹层错位或选项显示不完整。 */
function ApiTypeInput(props: {
	value: string;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<div
			className="config-combobox"
			onBlur={() => {
				// 等待 option 的 mouseDown 先写入值，再关闭下拉，避免点击被 blur 截断。
				window.setTimeout(() => setOpen(false), 80);
			}}
		>
			<input
				value={props.value}
				onFocus={() => setOpen(true)}
				onChange={(e) => {
					props.onChange(e.target.value);
					setOpen(true);
				}}
				placeholder="选择或输入 API 类型"
			/>
			<button
				type="button"
				className="config-combobox-toggle"
				onMouseDown={(e) => {
					e.preventDefault();
					setOpen((current) => !current);
				}}
				title="展开 API 类型选项"
			>
				<ChevronDown size={14} />
			</button>
			{open && (
				<div className="config-combobox-menu">
					{PROVIDER_API_OPTIONS.map((option) => (
						<button
							key={option}
							type="button"
							className={option === props.value ? "active" : ""}
							onMouseDown={(e) => {
								e.preventDefault();
								props.onChange(option);
								setOpen(false);
							}}
						>
							{option}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

function ModelsTab(props: {
	data: ModelsFile;
	expandedProvider: string | null;
	addingProvider: boolean;
	newProviderName: string;
	renamingProvider: string | null;
	renameValue: string;
	fetchingProvider: string | null;
	fetchedModels: Record<string, Array<{ id: string; name?: string }>>;
	testingProvider: string | null;
	testResult: {
		providerName: string;
		success: boolean;
		model?: string;
		snippet?: string;
		tokens?: { input?: number; output?: number };
		latencyMs?: number;
		error?: string;
		requestUrl?: string;
		requestBody?: string;
	} | null;
	testModelIdByProvider: Record<string, string>;
	saving: boolean;
	onToggleProvider: (name: string) => void;
	onStartAddProvider: () => void;
	onCancelAddProvider: () => void;
	onChangeNewProviderName: (name: string) => void;
	onConfirmAddProvider: () => void;
	onStartRename: (name: string) => void;
	onChangeRenameValue: (name: string) => void;
	onConfirmRename: (oldName: string) => void;
	onCancelRename: () => void;
	onDeleteProvider: (name: string) => void;
	onAddModel: (providerName: string) => void;
	onUpdateModel: (
		providerName: string,
		index: number,
		field: string,
		value: unknown,
	) => void;
	onDeleteModel: (providerName: string, index: number) => void;
	onFetchModels: (providerName: string) => void;
	onTestProvider: (providerName: string) => void;
	onChangeTestModelId: (providerName: string, modelId: string) => void;
	onClearTestResult: () => void;
	onSave: () => void;
	onChangeProvider: (name: string, field: string, value: unknown) => void;
}) {
	const { data, expandedProvider, saving } = props;
	const providerNames = Object.keys(data.providers);
	// 当前正在下拉选模型的 provider（null = 手动输入模式）
	const [addingModelDropdown, setAddingModelDropdown] = useState<string | null>(null);
	const [addingModelId, setAddingModelId] = useState("");

	return (
		<div className="config-model-tab">
			<div className="config-toolbar">
				<span className="config-count">{providerNames.length} 个 provider</span>
				<div style={{ display: "flex", gap: 8 }}>
					<button
						className="config-btn"
						onClick={props.onStartAddProvider}
						disabled={saving}
					>
						+ Provider
					</button>
					<button
						className="config-btn primary"
						onClick={props.onSave}
						disabled={saving}
					>
						{saving ? "保存中…" : "保存"}
					</button>
				</div>
			</div>

			{props.addingProvider && (
				<div className="config-add-provider-row">
					<input
						value={props.newProviderName}
						onChange={(e) => props.onChangeNewProviderName(e.target.value)}
						placeholder="provider 名称，如 openai"
						onKeyDown={(e) => e.key === "Enter" && props.onConfirmAddProvider()}
						autoFocus
					/>
					<button
						className="config-btn primary"
						onClick={props.onConfirmAddProvider}
						disabled={!props.newProviderName.trim()}
					>
						确认
					</button>
					<button className="config-btn" onClick={props.onCancelAddProvider}>
						取消
					</button>
				</div>
			)}

			<div className="config-provider-list">
				{providerNames.map((name) => {
					const provider = data.providers[name];
					const isExpanded = expandedProvider === name;
					const userAgentValue = getHeaderValue(provider.headers, "User-Agent");
					const userAgentSelectValue = USER_AGENT_OPTIONS.some(
						(option) => option.value === userAgentValue,
					)
						? userAgentValue
						: CUSTOM_USER_AGENT_VALUE;
					return (
						<div
							key={name}
							className={`config-provider-card ${isExpanded ? "expanded" : ""}`}
						>
							<div
								className="config-provider-header"
								onClick={() => {
									// 重命名模式下点击不折叠展开
									if (props.renamingProvider === name) return;
									props.onToggleProvider(name);
								}}
							>
								<div className="config-provider-info">
									{props.renamingProvider === name ? (
										<input
											className="config-rename-input"
											value={props.renameValue}
											onChange={(e) => props.onChangeRenameValue(e.target.value)}
											onKeyDown={(e) => {
												if (e.key === "Enter") props.onConfirmRename(name);
												if (e.key === "Escape") props.onCancelRename();
											}}
											onClick={(e) => e.stopPropagation()}
											autoFocus
										/>
									) : (
										<span className="config-provider-name">{name}</span>
									)}
									<span className="config-provider-badge">
										{provider.models.length} 模型
									</span>
									{provider.baseUrl && (
										<span className="config-provider-url">
											{provider.baseUrl}
										</span>
									)}
								</div>
								<div className="config-provider-actions">
									{props.renamingProvider === name ? (
										<>
											<button
												className="config-icon-btn"
												onClick={(e) => {
													e.stopPropagation();
													props.onConfirmRename(name);
												}}
												title="确认重命名"
											>
												<Check size={14} />
											</button>
											<button
												className="config-icon-btn"
												onClick={(e) => {
													e.stopPropagation();
													props.onCancelRename();
												}}
												title="取消重命名"
											>
												×
											</button>
										</>
									) : (
										<button
											className="config-icon-btn"
											onClick={(e) => {
												e.stopPropagation();
												props.onStartRename(name);
											}}
											title="重命名 provider"
										>
											✎
										</button>
									)}
									<button
										className="config-icon-btn danger"
										onClick={(e) => {
											e.stopPropagation();
											props.onDeleteProvider(name);
										}}
										title="删除 provider"
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
								<div className="config-provider-body">
									<div className="config-provider-form">
										<div className="config-form-row">
											<label>Base URL</label>
											<input
												value={provider.baseUrl ?? ""}
												onChange={(e) =>
													props.onChangeProvider(
														name,
														"baseUrl",
														e.target.value,
													)
												}
												placeholder="https://api.openai.com/v1"
											/>
										</div>
										<div className="config-form-row">
											<label>API 类型</label>
											<ApiTypeInput
												value={provider.api ?? ""}
												onChange={(value) =>
													props.onChangeProvider(name, "api", value)
												}
											/>
										</div>
										<div className="config-form-row">
											<label>API Key</label>
											<SecretInput
												value={provider.apiKey ?? ""}
												onChange={(v) =>
													props.onChangeProvider(name, "apiKey", v)
												}
											/>
										</div>
										<div className="config-form-row">
											<label>User-Agent</label>
											<div className="config-header-field">
												<select
													value={userAgentSelectValue}
													onChange={(e) => {
														if (e.target.value === CUSTOM_USER_AGENT_VALUE) return;
														props.onChangeProvider(
															name,
															"headers",
															setHeaderValue(
																provider.headers,
																"User-Agent",
																e.target.value,
															),
														);
													}}
												>
													{USER_AGENT_OPTIONS.map((option) => (
														<option
															key={option.value || "none"}
															value={option.value}
														>
															{option.label}
														</option>
													))}
													<option value={CUSTOM_USER_AGENT_VALUE}>
														自定义
													</option>
												</select>
												<input
													value={userAgentValue}
													onChange={(e) =>
														props.onChangeProvider(
															name,
															"headers",
															setHeaderValue(
																provider.headers,
																"User-Agent",
																e.target.value,
															),
														)
													}
													placeholder="pi-coding-agent"
												/>
												<span>写入 models.json 的 headers 字段</span>
											</div>
										</div>
										<div className="config-form-row">
											<label></label>
											<button
												className="config-btn blue"
												onClick={() => props.onFetchModels(name)}
												disabled={props.fetchingProvider === name}
											>
												{props.fetchingProvider === name
													? "获取中…"
													: "获取模型列表"}
											</button>
										</div>

										{/* 快速测试连接 */}
										<div className="config-form-row">
											<label>测试模型</label>
											<div style={{ display: "flex", gap: 8, alignItems: "center", flex: 1 }}>
												<input
													value={props.testModelIdByProvider[name] ?? ""}
													onChange={(e) =>
														props.onChangeTestModelId(name, e.target.value)
													}
													placeholder={
														provider.models[0]?.id ?? "输入模型 ID 进行测试"
													}
													style={{ flex: 1 }}
												/>
												<button
													className="config-btn primary"
													onClick={() => props.onTestProvider(name)}
													disabled={props.testingProvider === name}
												>
													{props.testingProvider === name
														? "测试中…"
														: "测试连接"}
												</button>
											</div>
										</div>

										{/* 测试结果 */}
										{props.testResult &&
											props.testResult.providerName === name && (
												<div
													className={`config-test-result ${props.testResult.success ? "success" : "fail"}`}
												>
													<div className="config-test-result-header">
														<span>
															{props.testResult.success
																? "✅ 连接正常"
																: "❌ 连接失败"}
														</span>
														<button
															className="config-icon-btn"
															onClick={props.onClearTestResult}
															title="清除结果"
														>
															×
														</button>
													</div>
													{props.testResult.success ? (
														<div className="config-test-result-body">
															<div className="config-test-result-row">
																<span>模型</span>
																<strong>{props.testResult.model}</strong>
															</div>
															<div className="config-test-result-row">
																<span>响应</span>
																<span>{props.testResult.snippet}</span>
															</div>
															{props.testResult.requestUrl && (
																<div className="config-test-result-row">
																	<span>请求</span>
																	<code className="config-test-request-url">
																		POST{" "}
																		{props.testResult.requestUrl}
																	</code>
																</div>
															)}
															{props.testResult.tokens &&
																(props.testResult.tokens.input != null ||
																	props.testResult.tokens.output != null) && (
																<div className="config-test-result-row">
																	<span>Token</span>
																	<span>
																		输入 {props.testResult.tokens.input ?? "-"}
																		，输出{" "}
																		{props.testResult.tokens.output ?? "-"}
																	</span>
																</div>
															)}
															{props.testResult.latencyMs != null && (
																<div className="config-test-result-row">
																	<span>延迟</span>
																	<span>
																		{props.testResult.latencyMs < 1000
																			? `${props.testResult.latencyMs} ms`
																			: `${(props.testResult.latencyMs / 1000).toFixed(1)} s`}
																	</span>
																</div>
															)}
														</div>
													) : (
														<div className="config-test-result-body">
															{props.testResult.latencyMs != null && (
																<div className="config-test-result-row">
																	<span>耗时</span>
																	<span>
																		{props.testResult.latencyMs < 1000
																			? `${props.testResult.latencyMs} ms`
																			: `${(props.testResult.latencyMs / 1000).toFixed(1)} s`}
																	</span>
																</div>
															)}
															{props.testResult.requestUrl && (
																<div className="config-test-result-row">
																	<span>请求</span>
																	<code className="config-test-request-url">
																		POST{" "}
																		{props.testResult.requestUrl}
																	</code>
																</div>
															)}
															{props.testResult.requestBody && (
																<div className="config-test-result-row">
																	<span>Body</span>
																	<code className="config-test-request-body">
																		{props.testResult.requestBody}
																	</code>
																</div>
															)}
															<div className="config-test-result-error">
																{props.testResult.error}
															</div>
														</div>
													)}
												</div>
											)}

										<div className="config-form-row">
											<label>兼容性</label>
											<div className="config-compat-group">
												<label className="config-checkbox-label">
													<input
														type="checkbox"
														checked={(provider.compat as Record<string, unknown>)?.supportsDeveloperRole !== false}
														onChange={(e) => {
															const compat = { ...((provider.compat as Record<string, unknown>) ?? {}) } as Record<string, unknown>;
															compat.supportsDeveloperRole = e.target.checked;
															props.onChangeProvider(name, "compat", compat);
														}}
													/>
													<span>developer 角色</span>
												</label>
												<label className="config-checkbox-label">
													<input
														type="checkbox"
														checked={(provider.compat as Record<string, unknown>)?.supportsReasoningEffort !== false}
														onChange={(e) => {
															const compat = { ...((provider.compat as Record<string, unknown>) ?? {}) } as Record<string, unknown>;
															compat.supportsReasoningEffort = e.target.checked;
															props.onChangeProvider(name, "compat", compat);
														}}
													/>
													<span>推理强度</span>
												</label>
											</div>
										</div>
									</div>

									<div className="config-models-section">
										<div className="config-models-header">
											<span>模型列表</span>
											<div style={{ display: "flex", gap: 6 }}>
												{props.fetchedModels[name] &&
												props.fetchedModels[name].length > 0 &&
												addingModelDropdown !== name && (
													<button
														className="config-btn small"
														onClick={() => {
															setAddingModelDropdown(name);
															setAddingModelId("");
														}}
													>
														+ 从列表选择
													</button>
												)}
												<button
													className="config-btn small"
													onClick={() => {
														setAddingModelDropdown(null);
														props.onAddModel(name);
													}}
												>
													+ 手动添加
												</button>
											</div>
										</div>

										{/* 下拉选择模型 */}
										{addingModelDropdown === name &&
											props.fetchedModels[name] && (
												<div className="config-model-dropdown-row">
													<select
														value={addingModelId}
														onChange={(e) =>
															setAddingModelId(e.target.value)
														}
													>
														<option value="">
															-- 选择模型 --
														</option>
														{props.fetchedModels[name].map((m) => (
															<option key={m.id} value={m.id}>
																{m.name ?? m.id}
															</option>
														))}
													</select>
													<button
														className="config-btn primary small"
														onClick={() => {
															if (!addingModelId.trim()) return;
															const selected = props.fetchedModels[
																name
															].find((m) => m.id === addingModelId);
															const provider =
																data.providers[name];
															if (!provider) return;
															const newModel: ModelItem = {
																id: addingModelId,
																name: selected?.name ?? addingModelId,
															};
															props.onChangeProvider(
																name,
																"models",
																[
																	...provider.models,
																	newModel,
																],
															);
															setAddingModelDropdown(null);
															setAddingModelId("");
														}}
														disabled={!addingModelId.trim()}
													>
														添加
													</button>
													<button
														className="config-btn small"
														onClick={() => {
															setAddingModelDropdown(null);
															setAddingModelId("");
														}}
													>
														取消
													</button>
												</div>
											)}
										<div className="config-models-grid-header">
											<span>ID</span>
											<span>名称</span>
											<span>Context</span>
											<span>MaxTokens</span>
											<span>推理</span>
											<span></span>
										</div>
										{provider.models.map((m, i) => (
											<div
												key={`${m.id}-${i}`}
												className="config-models-grid-row"
											>
												<input
													value={m.id}
													onChange={(e) =>
														props.onUpdateModel(name, i, "id", e.target.value)
													}
													placeholder="model-id"
												/>
												<input
													value={m.name ?? ""}
													onChange={(e) =>
														props.onUpdateModel(name, i, "name", e.target.value)
													}
													placeholder="显示名称"
												/>
												<input
													type="number"
													value={m.contextWindow ?? ""}
													onChange={(e) =>
														props.onUpdateModel(
															name,
															i,
															"contextWindow",
															e.target.value
																? Number(e.target.value)
																: undefined,
														)
													}
													placeholder="200k"
												/>
												<input
													type="number"
													value={m.maxTokens ?? ""}
													onChange={(e) =>
														props.onUpdateModel(
															name,
															i,
															"maxTokens",
															e.target.value
																? Number(e.target.value)
																: undefined,
														)
													}
													placeholder="8k"
												/>
												<label className="config-checkbox-cell">
													<input
														type="checkbox"
														checked={m.reasoning ?? false}
														onChange={(e) =>
															props.onUpdateModel(
																name,
																i,
																"reasoning",
																e.target.checked,
															)
														}
													/>
												</label>
												<button
													className="config-icon-btn danger"
													onClick={() => props.onDeleteModel(name, i)}
													title="删除模型"
												>
													<Trash2 size={14} />
												</button>
											</div>
										))}
										{provider.models.length === 0 && (
											<div className="config-empty-sm">
												暂无模型，点击「+ 模型」添加
											</div>
										)}
									</div>
								</div>
							)}
						</div>
					);
				})}
				{providerNames.length === 0 && (
					<div className="config-empty">暂无 provider 配置</div>
				)}
			</div>
		</div>
	);
}

// ── Auth Tab ────────────────────────────────────────────

function AuthTab(props: {
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
	onDeleteAuth: (provider: string) => void;
	onUpdate: (provider: string, field: string, value: string) => void;
	onSave: () => void;
}) {
	const { data, expandedAuth, saving } = props;
	const providers = Object.keys(data);

	return (
		<div className="config-auth-tab">
			<div className="config-toolbar">
				<span className="config-count">{providers.length} 个 provider</span>
				<div style={{ display: "flex", gap: 8 }}>
					<button
						className="config-btn"
						onClick={props.onStartAddAuth}
						disabled={saving}
					>
						+ Auth
					</button>
					<button
						className="config-btn primary"
						onClick={props.onSave}
						disabled={saving}
					>
						{saving ? "保存中…" : "保存"}
					</button>
				</div>
			</div>

			{props.addingAuth && (
				<div className="config-add-provider-row">
					<input
						value={props.newAuthName}
						onChange={(e) => props.onChangeNewAuthName(e.target.value)}
						placeholder="provider 名称，如 openai"
						onKeyDown={(e) => e.key === "Enter" && props.onConfirmAddAuth()}
						autoFocus
					/>
					<button
						className="config-btn primary"
						onClick={props.onConfirmAddAuth}
						disabled={!props.newAuthName.trim()}
					>
						确认
					</button>
					<button className="config-btn" onClick={props.onCancelAddAuth}>
						取消
					</button>
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
										: "未配置"}
								</span>
								<div className="config-provider-actions">
									<button
										className="config-icon-btn danger"
										onClick={(e) => {
											e.stopPropagation();
											props.onDeleteAuth(name);
										}}
										title="删除"
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
										<label>类型</label>
										<input
											value={auth.type ?? "api_key"}
											onChange={(e) =>
												props.onUpdate(name, "type", e.target.value)
											}
										/>
									</div>
									<div className="config-form-row">
										<label>API Key</label>
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
					<div className="config-empty">暂无 Auth 配置</div>
				)}
			</div>
		</div>
	);
}

// ── Settings Tab ────────────────────────────────────────

function SettingsTab(props: {
	data: SettingsFile;
	saving: boolean;
	onChange: (data: SettingsFile) => void;
	onSave: () => void;
}) {
	const { data, saving } = props;
	const entries = Object.entries(data);

	return (
		<div className="config-settings-tab">
			<div className="config-toolbar">
				<span className="config-count">{entries.length} 个配置项</span>
				<button
					className="config-btn primary"
					onClick={props.onSave}
					disabled={saving}
				>
					{saving ? "保存中…" : "保存"}
				</button>
			</div>
			<div className="config-settings-list">
				{entries.map(([key, value]) => (
					<div key={key} className="config-settings-row">
						<span className="config-settings-key">{key}</span>
						<SettingsValueInput
							value={value}
							onChange={(v) => props.onChange({ ...data, [key]: v })}
						/>
					</div>
				))}
				{entries.length === 0 && <div className="config-empty">暂无配置</div>}
			</div>
		</div>
	);
}

function SettingsValueInput(props: {
	value: unknown;
	onChange: (v: unknown) => void;
}) {
	const { value } = props;
	if (typeof value === "boolean") {
		return (
			<label className="config-checkbox-label">
				<input
					type="checkbox"
					checked={value}
					onChange={(e) => props.onChange(e.target.checked)}
				/>
				<span>{value ? "true" : "false"}</span>
			</label>
		);
	}
	if (typeof value === "number") {
		return (
			<input
				type="number"
				value={value}
				onChange={(e) => props.onChange(Number(e.target.value))}
				className="config-settings-input"
			/>
		);
	}
	if (typeof value === "string") {
		return (
			<input
				value={value}
				onChange={(e) => props.onChange(e.target.value)}
				className="config-settings-input"
			/>
		);
	}
	return (
		<input
			value={JSON.stringify(value)}
			onChange={(e) => {
				try {
					props.onChange(JSON.parse(e.target.value));
				} catch {
					/* 输入过程中 JSON 不合法时暂不更新 */
				}
			}}
			className="config-settings-input"
		/>
	);
}

// ── Raw Tab ─────────────────────────────────────────────

function RawTab(props: {
	fileName: string;
	content: string;
	saving: boolean;
	onChangeFileName: (name: string) => void;
	onChangeContent: (content: string) => void;
	onSave: () => void;
}) {
	return (
		<div className="config-raw-tab">
			<div className="config-toolbar">
				<select
					value={props.fileName}
					onChange={(e) => props.onChangeFileName(e.target.value)}
				>
					<option value="models.json">models.json</option>
					<option value="auth.json">auth.json</option>
					<option value="settings.json">settings.json</option>
				</select>
				<button
					className="config-btn primary"
					onClick={props.onSave}
					disabled={props.saving}
				>
					{props.saving ? "保存中…" : "保存"}
				</button>
			</div>
			<textarea
				className="config-raw-editor"
				value={props.content}
				onChange={(e) => props.onChangeContent(e.target.value)}
				spellCheck={false}
			/>
		</div>
	);
}
