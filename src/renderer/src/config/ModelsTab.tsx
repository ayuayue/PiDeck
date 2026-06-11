import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import type { ModelItem, ModelsFile } from "./configTypes";
import { ApiTypeInput, ConfigSelect, SecretInput } from "./ConfigShared";
import {
	CUSTOM_USER_AGENT_VALUE,
	USER_AGENT_OPTIONS,
	getHeaderValue,
	setHeaderValue,
} from "./providerHeaders";

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
]);

function FetchedModelCombobox(props: {
	models: FetchedModel[];
	value: string;
	onChange: (value: string) => void;
}) {
	const [open, setOpen] = useState(true);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const selected = props.models.find((model) => model.id === props.value);
	const displayValue = selected
		? selected.name && selected.name !== selected.id
			? `${selected.name} / ${selected.id}`
			: selected.id
		: "";

	useEffect(() => {
		inputRef.current?.focus();
	}, []);

	return (
		<div
			className="config-combobox config-model-combobox"
			onBlur={() => {
				// 让菜单项的 mouseDown 先完成选中，再关闭弹层，保持和 API 类型下拉一致。
				window.setTimeout(() => setOpen(false), 80);
			}}
		>
			<input
				ref={inputRef}
				readOnly
				value={displayValue}
				onFocus={() => setOpen(true)}
				placeholder="选择模型"
			/>
			<button
				type="button"
				className="config-combobox-toggle"
				onMouseDown={(e) => {
					e.preventDefault();
					setOpen((current) => !current);
				}}
				title="展开模型选项"
			>
				<ChevronDown size={14} />
			</button>
			{open && (
				<div className="config-combobox-menu config-model-combobox-menu">
					{props.models.map((model) => (
						<button
							key={model.id}
							type="button"
							className={model.id === props.value ? "active" : ""}
							onMouseDown={(e) => {
								e.preventDefault();
								props.onChange(model.id);
								setOpen(false);
							}}
						>
							<span>{model.name ?? model.id}</span>
							{model.name && model.name !== model.id && <small>{model.id}</small>}
						</button>
					))}
				</div>
			)}
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
	const [pendingModelFocusKey, setPendingModelFocusKey] = useState<string | null>(null);
	const modelIdInputRefs = useRef<Record<string, HTMLInputElement | null>>({});
	const getModelInputKey = (providerName: string, index: number) =>
		`${providerName}\u0000${index}`;
	const getCompat = (providerName: string) =>
		(data.providers[providerName].compat as Record<string, unknown> | undefined) ??
		{};

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
					const providerAdvancedFields = Object.keys(provider).filter(
						(key) => !KNOWN_PROVIDER_FIELDS.has(key),
					);
					const providerComplexFields = ["headers", "authHeader", "compat", "modelOverrides", "oauth"].filter(
						(key) => provider[key] !== undefined,
					);
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
												<ConfigSelect
													value={userAgentSelectValue}
													options={[
														...USER_AGENT_OPTIONS,
														{ value: CUSTOM_USER_AGENT_VALUE, label: "自定义" },
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
													placeholder="留空则不写入"
												/>
												<span>留空时不写入 headers，使用 pi / SDK 运行时默认值</span>
											</div>
										</div>
										{(providerComplexFields.length > 0 || providerAdvancedFields.length > 0) && (
											<div className="config-advanced-preserved">
												<strong>高级字段已保留</strong>
												<span>
													{[...providerComplexFields, ...providerAdvancedFields].join(", ")}
													{" "}不会被可视化表单丢弃；复杂结构请在“源文件”中编辑，并参考{" "}
													<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer">
														pi models 文档
													</a>
													{" / "}
													<a href="https://pi.dev/docs/latest/custom-provider" target="_blank" rel="noreferrer">
														custom provider 文档
													</a>
													。
												</span>
											</div>
										)}

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
															{/* 失败原因放在详情第一行，保证用户从折叠卡片展开后立刻看到核心错误，
															   不会只看到请求/Body 等排障信息而误判测试结果。 */}
															<div className="config-test-result-row config-test-result-error-row">
																<span>原因</span>
																<strong>{props.testResult.error}</strong>
															</div>
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
														checked={getCompat(name).supportsDeveloperRole === true}
														onChange={(e) => {
															const compat = { ...getCompat(name) };
															compat.supportsDeveloperRole = e.target.checked;
															props.onChangeProvider(name, "compat", compat);
														}}
													/>
													<span>developer 角色</span>
												</label>
												<label className="config-checkbox-label">
													<input
														type="checkbox"
														checked={getCompat(name).supportsReasoningEffort === true}
														onChange={(e) => {
															const compat = { ...getCompat(name) };
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
														setPendingModelFocusKey(
															getModelInputKey(name, provider.models.length),
														);
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
													<FetchedModelCombobox
														models={props.fetchedModels[name]}
														value={addingModelId}
														onChange={setAddingModelId}
													/>
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
																contextWindow: 1000000,
																maxTokens: 128000,
																reasoning: true,
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
										{provider.models.map((m, i) => {
											const modelAdvancedFields = Object.keys(m).filter(
												(key) => !KNOWN_MODEL_FIELDS.has(key),
											);
											const modelComplexFields = ["api", "baseUrl", "thinkingLevelMap", "input", "cost", "headers", "compat"].filter(
												(key) => m[key] !== undefined,
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
												<button
													className="config-icon-btn danger"
													onClick={() => props.onDeleteModel(name, i)}
													title="删除模型"
												>
													<Trash2 size={14} />
												</button>
												{(modelComplexFields.length > 0 || modelAdvancedFields.length > 0) && (
													<div className="config-model-advanced-note">
														高级字段已保留：{[...modelComplexFields, ...modelAdvancedFields].join(", ")}。
														<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer">
															查看 models 文档
														</a>
													</div>
												)}
											</div>
											);
										})}
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


