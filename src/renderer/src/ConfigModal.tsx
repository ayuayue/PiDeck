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

// pi provider 的 api 字段是字符串配置；这里提供常见值辅助选择，同时保留未知值以兼容用户自定义或未来新增类型。
const PROVIDER_API_OPTIONS = [
	"openai-completions",
	"openai-chat-completions",
	"openai-responses",
	"anthropic",
	"google-generative-ai",
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
	// 新增 auth
	const [addingAuth, setAddingAuth] = useState(false);
	const [newAuthName, setNewAuthName] = useState("");

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
			showToast("配置已保存，正在重载…");
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
				[newProviderName.trim()]: { models: [] },
			},
		};
		setModelsData(updated);
		setExpandedProvider(newProviderName.trim());
		setAddingProvider(false);
		setNewProviderName("");
	};

	const handleDeleteProvider = (name: string) => {
		const providers = { ...modelsData.providers };
		delete providers[name];
		setModelsData({ ...modelsData, providers });
		if (expandedProvider === name) setExpandedProvider(null);
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

	if (!open) return null;

	return (
		<div className="modal-backdrop" onClick={onClose}>
			<div className="config-modal" onClick={(e) => e.stopPropagation()}>
				<div className="modal-header">
					<strong>配置管理</strong>
					<button onClick={onClose}>×</button>
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
							onDeleteProvider={handleDeleteProvider}
							onAddModel={handleAddModel}
							onUpdateModel={handleUpdateModel}
							onDeleteModel={handleDeleteModel}
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
	saving: boolean;
	onToggleProvider: (name: string) => void;
	onStartAddProvider: () => void;
	onCancelAddProvider: () => void;
	onChangeNewProviderName: (name: string) => void;
	onConfirmAddProvider: () => void;
	onDeleteProvider: (name: string) => void;
	onAddModel: (providerName: string) => void;
	onUpdateModel: (
		providerName: string,
		index: number,
		field: string,
		value: unknown,
	) => void;
	onDeleteModel: (providerName: string, index: number) => void;
	onSave: () => void;
	onChangeProvider: (name: string, field: string, value: unknown) => void;
}) {
	const { data, expandedProvider, saving } = props;
	const providerNames = Object.keys(data.providers);

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
						{saving ? "保存中…" : "保存全部"}
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
					return (
						<div
							key={name}
							className={`config-provider-card ${isExpanded ? "expanded" : ""}`}
						>
							<div
								className="config-provider-header"
								onClick={() => props.onToggleProvider(name)}
							>
								<div className="config-provider-info">
									<span className="config-provider-name">{name}</span>
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
									</div>

									<div className="config-models-section">
										<div className="config-models-header">
											<span>模型列表</span>
											<button
												className="config-btn small"
												onClick={() => props.onAddModel(name)}
											>
												+ 模型
											</button>
										</div>
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
													×
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
						{saving ? "保存中…" : "保存全部"}
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
					{saving ? "保存中…" : "保存全部"}
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
					{props.saving ? "保存中…" : "保存并重载"}
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
