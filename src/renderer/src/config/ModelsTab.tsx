import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, Trash2 } from "lucide-react";
import { t } from "../i18n";
import type { ModelItem, ModelsFile } from "./configTypes";
import { ApiTypeInput, ConfigSelect, SecretInput } from "./ConfigShared";
import {
	CUSTOM_USER_AGENT_VALUE,
	getUserAgentOptions,
	getHeaderValue,
	setHeaderValue,
} from "./providerHeaders";
import { buildModelsFromFetchedSelection } from "./modelsUtils";

type FetchedModel = { id: string; name?: string };

const KNOWN_PROVIDER_FIELDS = new Set([
	"baseUrl",
	"api",
	"apiKey",
	"headers",
	"authHeader",
	"models",
	"modelOverrides",
	"compat",
	"oauth",
	"body",
	"bodyFile",
]);
const KNOWN_MODEL_FIELDS = new Set([
	"id",
	"name",
	"api",
	"baseUrl",
	"reasoning",
	"thinkingLevelMap",
	"input",
	"cost",
	"contextWindow",
	"maxTokens",
	"headers",
	"compat",
	"body",
	"bodyFile",
]);

// 自定义请求体编辑器：内联 JSON（body）+ 本地文件路径（bodyFile）。
// body / bodyFile 不是 pi models.json 的官方字段，但 pi 的 TypeBox 校验放行未知
// 字段；保存后由 pi-deck-body-override 扩展在 before_provider_request 时深合并进
// 请求体。编辑时用本地文本状态，只有解析为合法 JSON 对象才提交，避免污染表单数据。
function BodyOverrideFields(props: {
	body?: Record<string, unknown>;
	bodyFile?: string;
	compact?: boolean;
	onChangeBody: (value: Record<string, unknown> | undefined) => void;
	onChangeBodyFile: (value: string | undefined) => void;
}) {
	const serialize = (value: Record<string, unknown> | undefined) =>
		value ? JSON.stringify(value, null, 2) : "";
	const [text, setText] = useState(() => serialize(props.body));
	const [invalid, setInvalid] = useState(false);
	// 外部 body 变化（非本次提交引起）时才重置本地文本，避免打字过程中被重新格式化
	const bodyKey = JSON.stringify(props.body ?? null);
	const lastCommittedRef = useRef(bodyKey);
	useEffect(() => {
		if (bodyKey !== lastCommittedRef.current) {
			lastCommittedRef.current = bodyKey;
			setText(serialize(props.body));
			setInvalid(false);
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [bodyKey]);
	const handleText = (value: string) => {
		setText(value);
		const trimmed = value.trim();
		if (!trimmed) {
			setInvalid(false);
			lastCommittedRef.current = "null";
			props.onChangeBody(undefined);
			return;
		}
		try {
			const parsed = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				setInvalid(false);
				lastCommittedRef.current = JSON.stringify(parsed);
				props.onChangeBody(parsed);
			} else {
				setInvalid(true);
			}
		} catch {
			setInvalid(true);
		}
	};
	return (
		<div className="config-body-override">
			<textarea
				className={`config-body-textarea${invalid ? " invalid" : ""}`}
				value={text}
				onChange={(e) => handleText(e.target.value)}
				placeholder='{ "temperature": 0.6 }'
				rows={props.compact ? 2 : 4}
				spellCheck={false}
			/>
			{invalid && <span className="config-body-invalid">{t("config.bodyOverrideInvalid")}</span>}
			<input
				value={props.bodyFile ?? ""}
				onChange={(e) => props.onChangeBodyFile(e.target.value.trim() || undefined)}
				placeholder={t("config.bodyOverrideFilePlaceholder")}
			/>
			<span className="config-field-hint">{t("config.bodyOverrideHint")}</span>
		</div>
	);
}

function FetchedModelCombobox(props: {
	models: FetchedModel[];
	value: string[];
	existingModelIds: string[];
	onChange: (value: string[]) => void;
}) {
	const [filter, setFilter] = useState("");
	const inputRef = useRef<HTMLInputElement | null>(null);
	const existingModelIdSet = new Set(props.existingModelIds);
	const selectedModelIdSet = new Set(props.value);
	const normalizedFilter = filter.trim().toLowerCase();
	const visibleModels = normalizedFilter
		? props.models.filter((model) =>
			[model.id, model.name]
				.filter(Boolean)
				.some((text) => text!.toLowerCase().includes(normalizedFilter)),
		)
		: props.models;
	const selectableVisibleModels = visibleModels.filter((model) => !existingModelIdSet.has(model.id));
	const selectedModels = props.models.filter((model) => selectedModelIdSet.has(model.id));
	const allSelectableSelected =
		selectableVisibleModels.length > 0 &&
		selectableVisibleModels.every((model) => selectedModelIdSet.has(model.id));

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	function toggleModel(modelId: string) {
		if (existingModelIdSet.has(modelId)) return;
		const next = new Set(props.value);
		if (next.has(modelId)) next.delete(modelId);
		else next.add(modelId);
		props.onChange([...next]);
	}

	return (
		<div className="config-model-combobox">
			<div className="config-model-combobox-toolbar">
				<input
					ref={inputRef}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder={t("config.modelSearchPlaceholder")}
				/>
				<button
					type="button"
					className="config-btn small"
					onClick={() => {
						// 全选只作用于当前筛选结果，方便大列表按关键字批量选择，同时不会误选已配置模型。
						const visibleIds = selectableVisibleModels.map((model) => model.id);
						if (allSelectableSelected) {
							props.onChange(props.value.filter((id) => !visibleIds.includes(id)));
						} else {
							props.onChange([...new Set([...props.value, ...visibleIds])]);
						}
					}}
					disabled={selectableVisibleModels.length === 0}
				>
					{allSelectableSelected ? t("common.deselectAll") : t("common.selectAll")}
				</button>
			</div>
			<div className="config-model-combobox-summary">
				<span>
					{t("config.modelFetchSelectionSummary", {
						selected: selectedModels.length,
						total: props.models.length,
					})}
				</span>
			</div>
			<div className="config-model-chip-list">
				{visibleModels.map((model) => {
					const selected = selectedModelIdSet.has(model.id);
					const configured = existingModelIdSet.has(model.id);
					return (
						<button
							key={model.id}
							type="button"
							className={`config-model-chip${selected ? " selected" : ""}${configured ? " configured" : ""}`}
							onClick={() => toggleModel(model.id)}
							disabled={configured}
							aria-pressed={selected}
						>
							<span className="config-model-chip-label">{model.name ?? model.id}</span>
							{model.name && model.name !== model.id && (
								<span className="config-model-chip-id">{model.id}</span>
							)}
							{selected && !configured && <Check size={12} className="config-model-chip-check" />}
							{configured && (
								<span className="config-model-combobox-badge">
									{t("config.configured")}
								</span>
							)}
						</button>
					);
				})}
				{visibleModels.length === 0 && (
					<div className="config-model-combobox-empty">{t("app.modelPickerEmpty")}</div>
				)}
			</div>
		</div>
	);
}

export function ModelsTab(props: {
	data: ModelsFile;
	expandedProvider: string | null;
	addingProvider: boolean;
	newProviderName: string;
	renamingProvider: string | null;
	renameValue: string;
	fetchingProvider: string | null;
	fetchedModels: Record<string, Array<{ id: string; name?: string }>>;
	fetchModelsErrorByProvider: Record<string, string | undefined>;
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
	onDuplicateProvider: (name: string) => void;
	onDeleteProviders: (names: string[]) => void;
	onAddModel: (providerName: string) => void;
	onUpdateModel: (
		providerName: string,
		index: number,
		field: string,
		value: unknown,
	) => void;
	onUpdateModelXhigh: (
		providerName: string,
		index: number,
		value: "" | "xhigh" | "max",
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
	// 自动获取后的待保存选择：与 provider 分开存储，避免多个 provider 同时展开时选中状态互相污染。
	const [selectedFetchedModelIds, setSelectedFetchedModelIds] = useState<Record<string, string[]>>({});
	const [pendingModelFocusKey, setPendingModelFocusKey] = useState<string | null>(null);
	const [showGuide, setShowGuide] = useState(false);
	const [batchMode, setBatchMode] = useState(false);
	const [selectedProviders, setSelectedProviders] = useState(new Set());
	const setSelectedFetchedModels = (providerName: string, modelIds: string[]) => {
		setSelectedFetchedModelIds((current) => ({
			...current,
			[providerName]: modelIds,
		}));
	};
	const modelIdInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
	const getModelInputKey = (providerName: string, index: number) =>
		`${providerName}\u0000${index}`;
	const getCompat = (providerName: string) => ({
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
		...(data.providers[providerName].compat as Record<string, unknown> | undefined),
	});

	useLayoutEffect(() => {
		if (!pendingModelFocusKey) return;
		const frameId = window.requestAnimationFrame(() => {
			const input = modelIdInputRefs.current[pendingModelFocusKey];
			if (!input) return;
			// 手动新增模型后立即进入 ID 编辑，避免点击“+ 手动添加”后还要再次点击空输入框。
			input.focus();
			input.select();
			setPendingModelFocusKey(null);
		});
		return () => window.cancelAnimationFrame(frameId);
	}, [data.providers, pendingModelFocusKey]);

	return (
		<div className="config-model-tab">
			<div className="config-toolbar">
				<span className="config-count">
					{t("config.count.providers", { count: providerNames.length })}
				</span>
				<div className="config-toolbar-actions">
					<button
						className="config-btn"
						onClick={props.onStartAddProvider}
						disabled={saving}
					>
						{t("config.addProvider")}
					</button>
					<button
						className="config-btn"
						onClick={() => setShowGuide(!showGuide)}
						disabled={saving}
					>
						{t("config.providerGuide")}
					</button>
					<button
						className="config-btn danger-fill"
						onClick={() => {
							if (batchMode) {
								setBatchMode(false);
								setSelectedProviders(new Set());
							} else {
								setBatchMode(true);
							}
						}}
						disabled={saving || providerNames.length === 0}
					>
						{batchMode ? t("common.cancel") : t("common.deleteBatch")}
					</button>
					{batchMode && (
						<button
							className="config-btn danger-fill"
							onClick={() => {
								if (selectedProviders.size > 0) {
									props.onDeleteProviders([...selectedProviders] as string[]);
									setSelectedProviders(new Set());
									setBatchMode(false);
								}
							}}
							disabled={selectedProviders.size === 0}
						>
							{t("common.deleteSelected")} ({selectedProviders.size})
						</button>
					)}
					<button
						className="config-btn primary"
						onClick={props.onSave}
						disabled={saving}
					>
						{saving ? t("common.saving") : t("common.save")}
					</button>
				</div>
			</div>

			{/* Provider 配置指南 */}
			{showGuide && (
				<div className="config-auth-guide config-provider-guide">
					<div className="config-auth-guide-header">
						<strong>{t("config.providerGuideTitle")}</strong>
						<button className="config-icon-btn" onClick={() => setShowGuide(false)}>×</button>
					</div>
					<div className="config-auth-guide-body">
						<p>{t("config.providerGuideIntro")}</p>

						<strong className="config-provider-guide-section">{t("config.providerGuideApis")}</strong>
						<div className="config-provider-api-grid">
							<div className="config-provider-api-item">
								<code>openai-completions</code>
								<span>{t("config.providerGuideApiDesc1")}</span>
							</div>
							<div className="config-provider-api-item">
								<code>anthropic-messages</code>
								<span>{t("config.providerGuideApiDesc2")}</span>
							</div>
							<div className="config-provider-api-item">
								<code>openai-responses</code>
								<span>{t("config.providerGuideApiDesc3")}</span>
							</div>
							<div className="config-provider-api-item">
								<code>openai-codex-responses</code>
								<span>{t("config.providerGuideApiDesc5")}</span>
							</div>
							<div className="config-provider-api-item">
								<code>google-generative-ai</code>
								<span>{t("config.providerGuideApiDesc4")}</span>
							</div>
							<div className="config-provider-api-item">
								<code>mistral-conversations</code>
								<span>{t("config.providerGuideApiDesc6")}</span>
							</div>
						</div>

						<strong className="config-provider-guide-section">{t("config.providerGuideCompat")}</strong>
						<table className="config-provider-compat-table">
							<tbody>
								<tr>
									<td><code>supportsDeveloperRole</code></td>
									<td>{t("config.providerGuideCompatDevRole")}</td>
								</tr>
								<tr>
									<td><code>supportsReasoningEffort</code></td>
									<td>{t("config.providerGuideCompatReasoning")}</td>
								</tr>
							</tbody>
						</table>

						<strong className="config-provider-guide-section">{t("config.providerGuideTroubleshoot")}</strong>
						<ul className="config-provider-guide-list">
							<li>{t("config.providerGuideTip1")}</li>
							<li>{t("config.providerGuideTip2")}</li>
							<li>{t("config.providerGuideTip3")}</li>
							<li>{t("config.providerGuideTip4")}</li>
						</ul>

						<p className="config-auth-guide-note">
							{t("config.providerGuideNote")}{" "}
							<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer">
								{t("config.modelsDocs")} <ExternalLink size={12} />
							</a>
							{" · "}
							<a href="https://pi.dev/docs/latest/providers" target="_blank" rel="noreferrer">
								{t("config.providersDocs")} <ExternalLink size={12} />
							</a>
						</p>
					</div>
				</div>
			)}

			{props.addingProvider && (
				<div className="config-add-provider-row">
					<input
						value={props.newProviderName}
						onChange={(e) => props.onChangeNewProviderName(e.target.value)}
						placeholder={t("config.providerNamePlaceholder")}
						onKeyDown={(e) => e.key === "Enter" && props.onConfirmAddProvider()}
						autoFocus
					/>
					<button
						className="config-btn primary"
						onClick={props.onConfirmAddProvider}
						disabled={!props.newProviderName.trim()}
					>
						{t("common.confirm")}
					</button>
					<button className="config-btn" onClick={props.onCancelAddProvider}>
						{t("common.cancel")}
					</button>
				</div>
			)}

			<div className="config-provider-list">
				{providerNames.map((name) => {
					const provider = data.providers[name];
					const isExpanded = expandedProvider === name;
					const userAgentValue = getHeaderValue(provider.headers, "User-Agent");
					const providerAdvancedFields = Object.keys(provider).filter(
						(key) => !KNOWN_PROVIDER_FIELDS.has(key),
					);
					const providerComplexFields = ["headers", "authHeader", "compat", "modelOverrides", "oauth"].filter(
						(key) => provider[key] !== undefined,
					);
					const userAgentOptions = getUserAgentOptions();
					const userAgentSelectValue = userAgentOptions.some(
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
								{batchMode && (
								<label className="config-batch-checkbox" onClick={(e) => e.stopPropagation()}>
									<input
										type="checkbox"
										checked={selectedProviders.has(name)}
										onChange={(e) => {
											e.stopPropagation();
											setSelectedProviders(prev => {
												const next = new Set(prev);
												if (next.has(name)) next.delete(name);
												else next.add(name);
												return next;
											});
										}}
									/>
								</label>
							)}
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
										{t("config.count.models", {
											count: provider.models.length,
										})}
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
												title={t("config.renameConfirm")}
											>
												<Check size={14} />
											</button>
											<button
												className="config-icon-btn"
												onClick={(e) => {
													e.stopPropagation();
													props.onCancelRename();
												}}
												title={t("config.renameCancel")}
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
											title={t("config.renameProvider")}
										>
											✎
										</button>
									)}
									<button
										className="config-icon-btn"
										onClick={(e) => {
											e.stopPropagation();
											props.onDuplicateProvider(name);
										}}
										title={t("config.duplicateProvider")}
									>
										<Copy size={14} />
									</button>
									<button
										className="config-icon-btn danger"
										onClick={(e) => {
											e.stopPropagation();
											props.onDeleteProvider(name);
										}}
										title={t("config.deleteProvider")}
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
											<label>{t("config.field.baseUrl")}</label>
											<div className="config-base-url-field">
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
												{/* 说明检测兼容补路径 vs 会话原样使用 baseUrl 的差异 */}
												<span className="config-field-hint">{t("config.baseUrlHint")}</span>
											</div>
										</div>
										<div className="config-form-row">
											<label>{t("config.field.apiType")}</label>
											<ApiTypeInput
												value={provider.api ?? ""}
												onChange={(value) =>
													props.onChangeProvider(name, "api", value)
												}
											/>
										</div>
										<div className="config-form-row">
											<label>{t("config.field.apiKey")}</label>
											<SecretInput
												value={provider.apiKey ?? ""}
												onChange={(v) =>
													props.onChangeProvider(name, "apiKey", v)
												}
											/>
										</div>
										<div className="config-form-row">
											<label>{t("config.field.userAgent")}</label>
											<div className="config-header-field">
												<ConfigSelect
													value={userAgentSelectValue}
													options={[
														...userAgentOptions,
														{ value: CUSTOM_USER_AGENT_VALUE, label: t("config.custom") },
													]}
													onChange={(value) => {
														if (value === CUSTOM_USER_AGENT_VALUE) return;
														props.onChangeProvider(
															name,
															"headers",
															setHeaderValue(
																provider.headers,
																"User-Agent",
																value,
															),
														);
													}}
												/>
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
													placeholder={t("common.notConfigured")}
												/>
												<span>{t("config.headerEmptyHint")}</span>
											</div>
										</div>


										{/* 快速测试连接 */}
										<div className="config-form-row">
											<label>{t("config.testModel")}</label>
											<div className="config-test-controls">
												<input
													value={props.testModelIdByProvider[name] ?? ""}
													onChange={(e) =>
														props.onChangeTestModelId(name, e.target.value)
													}
													placeholder={
														provider.models[0]?.id ?? t("config.testModelPlaceholder")
													}
												/>
												<button
													className="config-btn primary"
													onClick={() => props.onTestProvider(name)}
													disabled={props.testingProvider === name}
												>
													{props.testingProvider === name
														? t("config.testingConnection")
														: t("config.testConnection")}
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
																? `✅ ${t("config.connectionOk")}`
																: `❌ ${t("config.connectionFailed")}`}
														</span>
														<button
															className="config-icon-btn"
															onClick={props.onClearTestResult}
															title={t("config.clearResult")}
														>
															×
														</button>
													</div>
													{props.testResult.success ? (
														<div className="config-test-result-body">
															<div className="config-test-result-row">
																<span>{t("config.model")}</span>
																<strong>{props.testResult.model}</strong>
															</div>
															<div className="config-test-result-row">
																<span>{t("config.response")}</span>
																<span>{props.testResult.snippet}</span>
															</div>
															{props.testResult.requestUrl && (
																<div className="config-test-result-row">
																	<span>{t("config.request")}</span>
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
																	<span>{t("config.tokens")}</span>
																	<span>
																		{t("config.testInputTokens", {
																			count: props.testResult.tokens.input ?? "-",
																		})}
																		，
																		{t("config.testOutputTokens", {
																			count: props.testResult.tokens.output ?? "-",
																		})}
																	</span>
																</div>
															)}
															{props.testResult.latencyMs != null && (
																<div className="config-test-result-row">
																	<span>{t("config.testLatency")}</span>
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
															{/* 失败原因放在详情第一行，保证用户从折叠卡片展开后立刻看到核心错误，
															   不会只看到请求/Body 等排障信息而误判测试结果。 */}
															<div className="config-test-result-row config-test-result-error-row">
																<span>{t("config.reason")}</span>
																<strong>{props.testResult.error}</strong>
															</div>
															{props.testResult.latencyMs != null && (
																<div className="config-test-result-row">
																	<span>{t("config.testElapsed")}</span>
																	<span>
																		{props.testResult.latencyMs < 1000
																			? `${props.testResult.latencyMs} ms`
																			: `${(props.testResult.latencyMs / 1000).toFixed(1)} s`}
																	</span>
																</div>
															)}
															{props.testResult.requestUrl && (
																<div className="config-test-result-row">
																	<span>{t("config.request")}</span>
																	<code className="config-test-request-url">
																		POST{" "}
																		{props.testResult.requestUrl}
																	</code>
																</div>
															)}
															{props.testResult.requestBody && (
																<div className="config-test-result-row">
																	<span>{t("config.requestBody")}</span>
																	<code className="config-test-request-body">
																		{props.testResult.requestBody}
																	</code>
																</div>
															)}
														</div>
													)}
												</div>
											)}

								{(props.testResult && !props.testResult.success && props.testResult.providerName === name) && (
									<div className="config-test-hint">
										💡 {t("config.testConnectionHint")}
									</div>
								)}

										<div className="config-form-row">
											<label>{t("config.compatibility")}</label>
											<div className="config-compat-group">
												<div className="config-compat-item">
													<label className="config-checkbox-label">
														<input
															type="checkbox"
															checked={getCompat(name).supportsDeveloperRole === true}
															onChange={(e) => {
																const compat = { ...getCompat(name) };
																compat.supportsDeveloperRole = e.target.checked;
																// 确保两个兼容性字段都显式写入，避免序列化后 JSON 为空导致 pi 后端无法正确判断
																compat.supportsReasoningEffort ??= false;
																props.onChangeProvider(name, "compat", compat);
															}}
														/>
														<span>{t("config.developerRole")}</span>
													</label>
													<small className="config-compat-item-desc">{t("config.developerRoleDesc")}</small>
												</div>
												<div className="config-compat-item">
													<label className="config-checkbox-label">
														<input
															type="checkbox"
															checked={getCompat(name).supportsReasoningEffort === true}
															onChange={(e) => {
																const compat = { ...getCompat(name) };
																compat.supportsReasoningEffort = e.target.checked;
																// 确保两个兼容性字段都显式写入，避免序列化后 JSON 为空导致 pi 后端无法正确判断
																compat.supportsDeveloperRole ??= false;
																props.onChangeProvider(name, "compat", compat);
															}}
														/>
														<span>{t("config.reasoningEffort")}</span>
													</label>
													<small className="config-compat-item-desc">{t("config.reasoningEffortDesc")}</small>
												</div>
											</div>
										</div>

										<div className="config-form-row">
											<label>{t("config.bodyOverride")}</label>
											<BodyOverrideFields
												body={provider.body}
												bodyFile={provider.bodyFile}
												onChangeBody={(value) => props.onChangeProvider(name, "body", value)}
												onChangeBodyFile={(value) => props.onChangeProvider(name, "bodyFile", value)}
											/>
										</div>

										{(providerComplexFields.length > 0 || providerAdvancedFields.length > 0) && (
											<div className="config-advanced-preserved">
												<strong>{t("config.advancedPreservedTitle")}</strong>
												<span>
													{t("config.advancedPreservedProvider", {
														fields: [...providerComplexFields, ...providerAdvancedFields].join(", "),
													})}
													{" "}
													<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer">
														pi {t("config.docsModels")}
													</a>
													{" / "}
													<a href="https://pi.dev/docs/latest/custom-provider" target="_blank" rel="noreferrer">
														{t("config.docsCustomProvider")}
													</a>
												</span>
											</div>
										)}
									</div>

									<div className="config-models-section">
										<div className="config-models-header">
											<span>{t("config.modelList")}</span>
											<div className="config-model-list-actions">
												<button
													className="config-btn small"
													onClick={() => props.onFetchModels(name)}
													disabled={props.fetchingProvider === name}
												>
													{props.fetchingProvider === name
														? t("config.fetchingModels")
														: t("config.fetchModels")}
												</button>
												<button
													className="config-btn small"
													onClick={() => {
														setPendingModelFocusKey(
															getModelInputKey(name, provider.models.length),
														);
														props.onAddModel(name);
													}}
												>
													{t("config.addModelManual")}
												</button>
											</div>
										</div>

										{props.fetchModelsErrorByProvider[name] && (
											<div className="config-error">{props.fetchModelsErrorByProvider[name]}</div>
										)}

										{/* 自动获取后直接在同一区块勾选保存，保留手动添加作为兜底入口。 */}
										{props.fetchedModels[name] && props.fetchedModels[name].length > 0 && (
											<div className="config-model-dropdown-row">
												<FetchedModelCombobox
													models={props.fetchedModels[name]}
													value={selectedFetchedModelIds[name] ?? []}
													existingModelIds={provider.models.map((model) => model.id)}
													onChange={(modelIds) => setSelectedFetchedModels(name, modelIds)}
												/>
												<div className="config-model-dropdown-actions">
													<button
														className="config-btn primary small"
														onClick={() => {
														const currentProvider = data.providers[name];
														if (!currentProvider) return;
														const selectedIds = selectedFetchedModelIds[name] ?? [];
														const newModels = buildModelsFromFetchedSelection(
															props.fetchedModels[name],
															selectedIds,
															currentProvider.models,
														);
														if (newModels.length === 0) return;
														props.onChangeProvider(name, "models", [
															...currentProvider.models,
															...newModels,
														]);
														setSelectedFetchedModels(name, []);
													}}
													disabled={(selectedFetchedModelIds[name] ?? []).length === 0}
												>
													{t("config.saveSelectedModels")}
												</button>
											</div>
										</div>
										)}
										<div className="config-models-grid-header">
											<span>{t("config.modelId")}</span>
											<span>{t("config.modelDisplayName")}</span>
											<span>{t("config.contextWindow")}</span>
											<span>{t("config.maxTokens")}</span>
											<span>{t("config.reasoning")}</span>
											<span>{t("config.xhigh")}</span>
											<span>{t("config.inputTypeImage")}</span>
											<span></span>
										</div>
										{provider.models.map((m, i) => {
											const modelAdvancedFields = Object.keys(m).filter(
												(key) => !KNOWN_MODEL_FIELDS.has(key),
											);
											const xhighValue =
												m.thinkingLevelMap?.xhigh === "xhigh" || m.thinkingLevelMap?.xhigh === "max"
													? m.thinkingLevelMap.xhigh
													: "";
											const hasOnlyManagedThinkingLevelMap =
												m.thinkingLevelMap &&
												Object.keys(m.thinkingLevelMap).every((key) => key === "xhigh");
											const modelComplexFields = ["api", "baseUrl", "thinkingLevelMap", "cost", "headers", "compat"].filter(
												(key) => m[key] !== undefined && (key !== "thinkingLevelMap" || !hasOnlyManagedThinkingLevelMap),
											);
											return (
											<div
												// 模型 ID 是可编辑字段，不能作为 key；否则每次输入都会重建行并导致输入框失焦。
												key={`${name}-${i}`}
												className="config-models-grid-row"
											>
												<input
													ref={(element) => {
														modelIdInputRefs.current[getModelInputKey(name, i)] =
															element;
													}}
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
													placeholder={t("config.modelDisplayName")}
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
													// 数字输入框不能填写 200k 这类缩写，placeholder 使用真实可保存的 token 数值。
													placeholder="1000000"
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
													// 与 contextWindow 一样保持纯数字，避免提示值看起来能输入但实际被 number 控件拒绝。
													placeholder="128000"
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
												<div className="config-xhigh-cell" title={t("config.xhighDesc")}>
													<ConfigSelect
														value={xhighValue}
														options={[
															{ value: "", label: t("config.xhighOff") },
															{ value: "xhigh", label: "xhigh" },
															{ value: "max", label: "max" },
														]}
														onChange={(value) =>
															props.onUpdateModelXhigh(
																name,
																i,
																value as "" | "xhigh" | "max",
															)
														}
													/>
												</div>
													<div className="config-input-cell">
														<label className="config-input-option">
															<input
																type="checkbox"
																checked={(m.input ?? []).includes("image")}
																onChange={(e) => {
																	const base = m.input ?? ["text", "image"];
																	const next = e.target.checked
																		? [...new Set([...base, "text", "image"])]
																		: ["text"];
																	props.onUpdateModel(name, i, "input", next);
																}}
															/>
															<span>{t("config.inputTypeImage")}</span>
														</label>
													</div>
													<button
														className="config-icon-btn danger"
														onClick={() => props.onDeleteModel(name, i)}
														title={t("config.deleteModel")}
													>
													<Trash2 size={14} />
												</button>
												{(modelComplexFields.length > 0 || modelAdvancedFields.length > 0) && (
													<div className="config-model-advanced-note">
														{t("config.advancedPreservedModel", {
															fields: [...modelComplexFields, ...modelAdvancedFields].join(", "),
														})}
														<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer">
															{t("config.docsModels")}
														</a>
													</div>
												)}
												<div className="config-model-body-override">
													<BodyOverrideFields
														compact
														body={m.body}
														bodyFile={m.bodyFile}
														onChangeBody={(value) => props.onUpdateModel(name, i, "body", value)}
														onChangeBodyFile={(value) => props.onUpdateModel(name, i, "bodyFile", value)}
													/>
												</div>
											</div>
											);
										})}
										{provider.models.length === 0 && (
											<div className="config-empty-sm">
												{t("config.emptyModels")}
											</div>
										)}
									</div>
								</div>
							)}
						</div>
					);
				})}
				{providerNames.length === 0 && (
					<div className="config-empty">{t("config.emptyProviders")}</div>
				)}
			</div>
		</div>
	);
}


