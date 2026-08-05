import { Button } from "../components/ui-shadcn/button";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Check, ChevronDown, ChevronRight, Copy, ExternalLink, SquarePen, Trash2, X } from "lucide-react";
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
import { Checkbox } from "../components/ui-shadcn/checkbox";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";

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
		<div className="min-w-0">
			<div className="flex items-center gap-2">
				<Input
					ref={inputRef}
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					placeholder={t("config.modelSearchPlaceholder")}
					className="h-7 min-w-0 flex-1 rounded-sm border border-border-subtle bg-bg-panel px-2.5 text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
				/>
				<Button type="button"
					 variant="outline" size="sm"
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
				</Button>
			</div>
			<div className="text-[11px] text-text-tertiary">
				<span>
					{t("config.modelFetchSelectionSummary", {
						selected: selectedModels.length,
						total: props.models.length,
					})}
				</span>
			</div>
			<div className="mt-2 flex max-h-[220px] flex-wrap gap-2 overflow-auto p-1">
				{visibleModels.map((model) => {
					const selected = selectedModelIdSet.has(model.id);
					const configured = existingModelIdSet.has(model.id);
					return (
						<button
							key={model.id}
							type="button"
							className={`inline-flex min-h-7 max-w-[260px] cursor-pointer items-center gap-1 rounded-sm border border-border-subtle bg-bg-panel px-2 py-1 text-xs text-text-primary transition-[background-color,border-color,color,box-shadow] duration-150 hover:border-[color-mix(in_srgb,var(--color-accent)_42%,var(--color-border-subtle))] hover:bg-bg-hover focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none${selected ? " border-[color-mix(in_srgb,var(--color-accent)_70%,var(--color-border-subtle))] bg-[color:color-mix(in_srgb,var(--color-accent)_12%,var(--color-bg-panel))] text-[color:var(--color-accent)]" : ""}${configured ? " cursor-not-allowed bg-bg-muted opacity-70" : ""}`}
							onClick={() => toggleModel(model.id)}
							disabled={configured}
							aria-pressed={selected}
						>
							<span className="min-w-0 truncate font-medium">{model.name ?? model.id}</span>
							{model.name && model.name !== model.id && (
								<span className="truncate text-[11px] text-text-tertiary">{model.id}</span>
							)}
							{selected && !configured && <Check size={12} className="shrink-0" />}
							{configured && (
								<span className="shrink-0 rounded-sm bg-bg-muted px-1.5 py-0.5 text-[11px] leading-tight text-text-tertiary">
									{t("config.configured")}
								</span>
							)}
						</button>
					);
				})}
				{visibleModels.length === 0 && (
					<div className="w-full p-3 text-center text-xs text-text-tertiary">{t("app.modelPickerEmpty")}</div>
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
		<div>
			<div className="mb-3 flex items-center justify-between gap-3">
				<span className="font-mono text-xs tabular-nums text-text-tertiary">
					{t("config.count.providers", { count: providerNames.length })}
				</span>
				<div className="flex min-w-0 items-center gap-1.5">
					<Button size="sm" variant="outline"
						onClick={props.onStartAddProvider}
						disabled={saving}
					>
						{t("config.addProvider")}
					</Button>
					<Button size="sm" variant="outline"
						onClick={() => setShowGuide(!showGuide)}
						disabled={saving}
					>
						{t("config.providerGuide")}
					</Button>
					<Button size="sm" variant="destructive"
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
					</Button>
					{batchMode && (
						<Button size="sm" variant="destructive"
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
						</Button>
					)}
					<Button size="sm" variant="default"
						onClick={props.onSave}
						disabled={saving}
					>
						{saving ? t("common.saving") : t("common.save")}
					</Button>
				</div>
			</div>

			{/* Provider 配置指南 */}
			{showGuide && (
				<div className="mb-4 rounded-md border border-border-subtle bg-bg-subtle p-4">
					<div className="mb-2.5 flex items-center justify-between">
						<strong className="text-sm text-text-primary">{t("config.providerGuideTitle")}</strong>
						<Button variant="ghost" size="icon-sm" className="size-7" onClick={() => setShowGuide(false)}><X size={14} /></Button>
					</div>
					<div className="text-xs leading-relaxed text-text-secondary">
						<p>{t("config.providerGuideIntro")}</p>

						<strong className="mt-3.5 mb-1.5 block text-sm text-text-primary">{t("config.providerGuideApis")}</strong>
						<div className="grid grid-cols-3 gap-1.5">
							<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
								<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">openai-completions</code>
								<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc1")}</span>
							</div>
							<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
								<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">anthropic-messages</code>
								<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc2")}</span>
							</div>
							<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
								<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">openai-responses</code>
								<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc3")}</span>
							</div>
							<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
								<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">openai-codex-responses</code>
								<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc5")}</span>
							</div>
							<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
								<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">google-generative-ai</code>
								<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc4")}</span>
							</div>
							<div className="flex flex-col gap-0.5 rounded-sm bg-bg-hover px-2.5 py-2">
								<code className="font-mono text-[11px] font-semibold text-[color:var(--color-accent)]">mistral-conversations</code>
								<span className="text-[11px] text-text-tertiary">{t("config.providerGuideApiDesc6")}</span>
							</div>
						</div>

						<strong className="mt-3.5 mb-1.5 block text-sm text-text-primary">{t("config.providerGuideCompat")}</strong>
						<table className="w-full border-collapse text-xs">
							<tbody>
								<tr>
									<td className="w-[180px] border-b border-border-subtle px-2.5 py-1.5 align-top"><code className="rounded-[4px] bg-[color:color-mix(in_srgb,var(--color-accent)_5%,transparent)] px-1.5 py-px font-mono text-[11px] text-[color:var(--color-accent)]">supportsDeveloperRole</code></td>
									<td className="border-b border-border-subtle px-2.5 py-1.5 align-top">{t("config.providerGuideCompatDevRole")}</td>
								</tr>
								<tr>
									<td className="w-[180px] border-b border-border-subtle px-2.5 py-1.5 align-top"><code className="rounded-[4px] bg-[color:color-mix(in_srgb,var(--color-accent)_5%,transparent)] px-1.5 py-px font-mono text-[11px] text-[color:var(--color-accent)]">supportsReasoningEffort</code></td>
									<td className="border-b border-border-subtle px-2.5 py-1.5 align-top">{t("config.providerGuideCompatReasoning")}</td>
								</tr>
							</tbody>
						</table>

						<strong className="mt-3.5 mb-1.5 block text-sm text-text-primary">{t("config.providerGuideTroubleshoot")}</strong>
						<ul className="my-1.5 list-disc pl-5 text-xs text-text-secondary">
							<li className="mb-1.5 leading-relaxed">{t("config.providerGuideTip1")}</li>
							<li className="mb-1.5 leading-relaxed">{t("config.providerGuideTip2")}</li>
							<li className="mb-1.5 leading-relaxed">{t("config.providerGuideTip3")}</li>
							<li className="mb-1.5 leading-relaxed">{t("config.providerGuideTip4")}</li>
						</ul>

						<p className="mt-3 border-t border-border-subtle pt-2.5 text-text-tertiary">
							{t("config.providerGuideNote")}{" "}
							<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[color:var(--color-accent)] no-underline">
								{t("config.modelsDocs")} <ExternalLink size={12} />
							</a>
							{" · "}
							<a href="https://pi.dev/docs/latest/providers" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[color:var(--color-accent)] no-underline">
								{t("config.providersDocs")} <ExternalLink size={12} />
							</a>
						</p>
					</div>
				</div>
			)}

			{props.addingProvider && (
				<div className="config-add-provider-row">
					<Input
						value={props.newProviderName}
						onChange={(e) => props.onChangeNewProviderName(e.target.value)}
						placeholder={t("config.providerNamePlaceholder")}
						onKeyDown={(e) => e.key === "Enter" && props.onConfirmAddProvider()}
						autoFocus
					/>
					<Button size="sm" variant="default"
						onClick={props.onConfirmAddProvider}
						disabled={!props.newProviderName.trim()}
					>
						{t("common.confirm")}
					</Button>
					<Button size="sm" variant="outline" onClick={props.onCancelAddProvider}>
						{t("common.cancel")}
					</Button>
				</div>
			)}

			<div className="flex flex-col gap-2.5">
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
							className={`overflow-hidden rounded-lg border border-border-subtle bg-bg-panel transition-[border-color,box-shadow,background-color] duration-150${isExpanded ? " border-[color-mix(in_srgb,var(--color-accent)_32%,var(--color-border-subtle))] shadow-[var(--shadow-border)] overflow-visible" : ""}`}
						>
							<div
								className="flex cursor-pointer items-center justify-between px-3.5 py-2 transition-colors duration-150 hover:bg-bg-hover"
								onClick={() => {
									// 重命名模式下点击不折叠展开
									if (props.renamingProvider === name) return;
									props.onToggleProvider(name);
								}}
							>
								{batchMode && (
								<Label className="mr-2.5 inline-flex size-4 shrink-0 items-center justify-center" onClick={(e) => e.stopPropagation()}>
									<Checkbox
										checked={selectedProviders.has(name)}
										onClick={(e) => e.stopPropagation()}
								onCheckedChange={() => {
											setSelectedProviders(prev => {
												const next = new Set(prev);
												if (next.has(name)) next.delete(name);
												else next.add(name);
												return next;
											});
										}}
									/>
								</Label>
							)}
							<div className="flex min-w-0 flex-1 items-center gap-2.5">
									{props.renamingProvider === name ? (
										<Input
											className="h-[30px] min-w-[120px] rounded-sm border border-border-subtle bg-bg-panel px-2.5 text-sm font-semibold text-text-primary outline-none transition-colors duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
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
										<span className="text-control font-semibold text-text-primary">{name}</span>
									)}
									<span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 font-mono text-[11px] font-medium tabular-nums text-[color:var(--color-accent)]">
										{t("config.count.models", {
											count: provider.models.length,
										})}
									</span>
									{provider.baseUrl && (
										<span className="max-w-[240px] truncate text-[11px] text-text-tertiary">
											{provider.baseUrl}
										</span>
									)}
								</div>
								<div className="flex items-center gap-1">
									{props.renamingProvider === name ? (
										<>
											<Button variant="ghost" size="icon-sm" className="size-7"
												onClick={(e) => {
													e.stopPropagation();
													props.onConfirmRename(name);
												}}
												title={t("config.renameConfirm")}
											>
												<Check size={14} />
											</Button>
											<Button variant="ghost" size="icon-sm" className="size-7"
												onClick={(e) => {
													e.stopPropagation();
													props.onCancelRename();
												}}
												title={t("config.renameCancel")}
											>
												<X size={14} />
											</Button>
										</>
									) : (
										<Button variant="ghost" size="icon-sm" className="size-7"
											onClick={(e) => {
												e.stopPropagation();
												props.onStartRename(name);
											}}
											title={t("config.renameProvider")}
										>
											<SquarePen size={14} />
										</Button>
									)}
									<Button variant="ghost" size="icon-sm" className="size-7"
										onClick={(e) => {
											e.stopPropagation();
											props.onDuplicateProvider(name);
										}}
										title={t("config.duplicateProvider")}
									>
										<Copy size={14} />
									</Button>
									<Button variant="ghost" size="icon-sm" className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
										onClick={(e) => {
											e.stopPropagation();
											props.onDeleteProvider(name);
										}}
										title={t("config.deleteProvider")}
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
								<div className="border-t border-border-subtle bg-bg-muted pt-3">
									<div className="mx-4 my-3.5 grid gap-2.5 rounded-lg border border-border-subtle bg-bg-panel p-3.5">
										<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
											<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.baseUrl")}</Label>
											<div className="config-base-url-field">
												<Input
													value={provider.baseUrl ?? ""} className="h-8 min-w-0 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
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
												<span className="mt-1 block text-[11px] leading-relaxed text-text-tertiary">{t("config.baseUrlHint")}</span>
											</div>
										</div>
										<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
											<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiType")}</Label>
											<ApiTypeInput
												value={provider.api ?? ""}
												onChange={(value) =>
													props.onChangeProvider(name, "api", value)
												}
											/>
										</div>
										<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
											<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.apiKey")}</Label>
											<SecretInput
												value={provider.apiKey ?? ""}
												onChange={(v) =>
													props.onChangeProvider(name, "apiKey", v)
												}
											/>
										</div>
										<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
											<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.field.userAgent")}</Label>
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
												<Input
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
										<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
											<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.testModel")}</Label>
											<div className="config-test-controls">
												<Input
													value={props.testModelIdByProvider[name] ?? ""} className="h-8 min-w-0 rounded-sm border border-border-subtle bg-bg-panel px-3 text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
													onChange={(e) =>
														props.onChangeTestModelId(name, e.target.value)
													}
													placeholder={
														provider.models[0]?.id ?? t("config.testModelPlaceholder")
													}
												/>
												<Button size="sm" variant="default"
													onClick={() => props.onTestProvider(name)}
													disabled={props.testingProvider === name}
												>
													{props.testingProvider === name
														? t("config.testingConnection")
														: t("config.testConnection")}
												</Button>
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
														<Button variant="ghost" size="icon-sm" className="size-7"
															onClick={props.onClearTestResult}
															title={t("config.clearResult")}
														>
															<X size={14} />
														</Button>
													</div>
													{props.testResult.success ? (
														<div className="config-test-result-body">
															<div className="flex items-baseline gap-4 text-control">
																<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.model")}</span>
																<strong className="break-all text-text-primary">{props.testResult.model}</strong>
															</div>
															<div className="flex items-baseline gap-4 text-control">
																<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.response")}</span>
																<span className="break-all text-text-primary">{props.testResult.snippet}</span>
															</div>
															{props.testResult.requestUrl && (
																<div className="flex items-baseline gap-4 text-control">
																	<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.request")}</span>
																	<code className="config-test-request-url">
																		POST{" "}
																		{props.testResult.requestUrl}
																	</code>
																</div>
															)}
															{props.testResult.tokens &&
																(props.testResult.tokens.input != null ||
																	props.testResult.tokens.output != null) && (
																<div className="flex items-baseline gap-4 text-control">
																	<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.tokens")}</span>
																	<span className="break-all text-text-primary">
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
																<div className="flex items-baseline gap-4 text-control">
																	<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.testLatency")}</span>
																	<span className="break-all text-text-primary">
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
															<div className="flex items-start gap-4 text-control">
																<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.reason")}</span>
																<strong className="break-all leading-relaxed text-danger">{props.testResult.error}</strong>
															</div>
															{props.testResult.latencyMs != null && (
																<div className="flex items-baseline gap-4 text-control">
																	<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.testElapsed")}</span>
																	<span className="break-all text-text-primary">
																		{props.testResult.latencyMs < 1000
																			? `${props.testResult.latencyMs} ms`
																			: `${(props.testResult.latencyMs / 1000).toFixed(1)} s`}
																	</span>
																</div>
															)}
															{props.testResult.requestUrl && (
																<div className="flex items-baseline gap-4 text-control">
																	<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.request")}</span>
																	<code className="config-test-request-url">
																		POST{" "}
																		{props.testResult.requestUrl}
																	</code>
																</div>
															)}
															{props.testResult.requestBody && (
																<div className="flex items-baseline gap-4 text-control">
																	<span className="basis-12 shrink-0 text-xs text-text-secondary">{t("config.requestBody")}</span>
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

										<div className="grid grid-cols-[90px_1fr] items-center gap-2.5">
											<Label className="pl-0.5 text-left text-xs font-medium text-text-secondary">{t("config.compatibility")}</Label>
											<div className="config-compat-group">
												<div className="config-compat-item">
													<Label className="config-checkbox-label">
														<Checkbox
															checked={getCompat(name).supportsDeveloperRole === true}
															onCheckedChange={(checked) => {
																const compat = { ...getCompat(name) };
																compat.supportsDeveloperRole = checked === true;
																// 确保两个兼容性字段都显式写入，避免序列化后 JSON 为空导致 pi 后端无法正确判断
																compat.supportsReasoningEffort ??= false;
																props.onChangeProvider(name, "compat", compat);
															}}
														/>
														<span>{t("config.developerRole")}</span>
													</Label>
													<small className="config-compat-item-desc">{t("config.developerRoleDesc")}</small>
												</div>
												<div className="config-compat-item">
													<Label className="config-checkbox-label">
														<Checkbox
															checked={getCompat(name).supportsReasoningEffort === true}
															onCheckedChange={(checked) => {
																const compat = { ...getCompat(name) };
																compat.supportsReasoningEffort = checked === true;
																// 确保两个兼容性字段都显式写入，避免序列化后 JSON 为空导致 pi 后端无法正确判断
																compat.supportsDeveloperRole ??= false;
																props.onChangeProvider(name, "compat", compat);
															}}
														/>
														<span>{t("config.reasoningEffort")}</span>
													</Label>
													<small className="config-compat-item-desc">{t("config.reasoningEffortDesc")}</small>
												</div>
											</div>
										</div>

										{(providerComplexFields.length > 0 || providerAdvancedFields.length > 0) && (
											<div className="mt-1.5 mb-2.5 flex items-start gap-2.5 rounded-md border border-border-subtle bg-bg-muted px-3 py-2 text-text-secondary">
												<strong className="min-w-[100px] shrink-0 whitespace-nowrap text-[11px] font-semibold text-text-primary">{t("config.advancedPreservedTitle")}</strong>
												<span>
													{t("config.advancedPreservedProvider", {
														fields: [...providerComplexFields, ...providerAdvancedFields].join(", "),
													})}
													{" "}
													<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[color:var(--color-accent)] no-underline">
														pi {t("config.docsModels")}
													</a>
													{" / "}
													<a href="https://pi.dev/docs/latest/custom-provider" target="_blank" rel="noreferrer" className="font-medium text-[color:var(--color-accent)] no-underline hover:underline">
														{t("config.docsCustomProvider")}
													</a>
												</span>
											</div>
										)}
									</div>

									<div className="config-models-section">
										<div className="config-models-header">
											<span>{t("config.modelList")}</span>
											<div className="flex min-w-0 items-center gap-1.5">
												<Button variant="outline" size="sm"
													onClick={() => props.onFetchModels(name)}
													disabled={props.fetchingProvider === name}
												>
													{props.fetchingProvider === name
														? t("config.fetchingModels")
														: t("config.fetchModels")}
												</Button>
												<Button variant="outline" size="sm"
													onClick={() => {
														setPendingModelFocusKey(
															getModelInputKey(name, provider.models.length),
														);
														props.onAddModel(name);
													}}
												>
													{t("config.addModelManual")}
												</Button>
											</div>
										</div>

										{props.fetchModelsErrorByProvider[name] && (
											<div className="mb-3.5 rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{props.fetchModelsErrorByProvider[name]}</div>
										)}

										{/* 自动获取后直接在同一区块勾选保存，保留手动添加作为兜底入口。 */}
										{props.fetchedModels[name] && props.fetchedModels[name].length > 0 && (
											<div className="mb-2.5 flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-subtle p-2.5">
												<FetchedModelCombobox
													models={props.fetchedModels[name]}
													value={selectedFetchedModelIds[name] ?? []}
													existingModelIds={provider.models.map((model) => model.id)}
													onChange={(modelIds) => setSelectedFetchedModels(name, modelIds)}
												/>
												<div className="flex justify-end border-t border-border-subtle pt-2">
													<Button variant="default" size="sm"
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
												</Button>
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
												<Input
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
												<Input
													value={m.name ?? ""}
													onChange={(e) =>
														props.onUpdateModel(name, i, "name", e.target.value)
													}
													placeholder={t("config.modelDisplayName")}
												/>
												<Input
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
												<Input
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
												<Label className="config-checkbox-cell">
													<Checkbox
														checked={m.reasoning ?? false}
														onCheckedChange={(checked) =>
															props.onUpdateModel(
																name,
																i,
																"reasoning",
																checked,
															)
														}
													/>
												</Label>
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
														<Label className="config-input-option">
															<Checkbox
																checked={(m.input ?? []).includes("image")}
																onCheckedChange={(checked) => {
																	const base = m.input ?? ["text", "image"];
																	const next = checked
																		? [...new Set([...base, "text", "image"])]
																		: ["text"];
																	props.onUpdateModel(name, i, "input", next);
																}}
															/>
															<span>{t("config.inputTypeImage")}</span>
														</Label>
													</div>
													<Button variant="ghost" size="icon-sm" className="size-7 text-destructive hover:bg-destructive/10 hover:text-destructive"
														onClick={() => props.onDeleteModel(name, i)}
														title={t("config.deleteModel")}
													>
													<Trash2 size={14} />
												</Button>
												{(modelComplexFields.length > 0 || modelAdvancedFields.length > 0) && (
													<div className="col-span-full mt-[-4px] rounded-sm bg-bg-muted px-2 py-1.5 text-[11px] leading-relaxed text-text-secondary">
														{t("config.advancedPreservedModel", {
															fields: [...modelComplexFields, ...modelAdvancedFields].join(", "),
														})}
														<a href="https://pi.dev/docs/latest/models" target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-[color:var(--color-accent)] no-underline">
															{t("config.docsModels")}
														</a>
													</div>
												)}
											</div>
											);
										})}
										{provider.models.length === 0 && (
											<div className="py-5 text-center text-xs text-text-tertiary">
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
					<div className="py-12 text-center text-control text-text-tertiary">{t("config.emptyProviders")}</div>
				)}
			</div>
		</div>
	);
}


