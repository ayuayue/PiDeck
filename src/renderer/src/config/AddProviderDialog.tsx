import { useEffect, useState } from "react";
import { Button } from "../components/ui-shadcn/button";
import { Input } from "../components/ui-shadcn/input";
import { Label } from "../components/ui-shadcn/label";
import { t } from "../i18n";
import { isValidProviderName } from "../../../shared/providerName";
import { desktopApi } from "../desktopApi";
import { FetchedModelCombobox } from "./FetchedModelCombobox";
import { buildModelsFromFetchedSelection } from "./modelsUtils";
import { showNotice } from "../utils/notice";
import { ArrowLeft, RefreshCw, Trash2, X } from "lucide-react";
import type { FetchedModel, ConfigProxyMode } from "../../../shared/types/fetchedModel";
import type { ModelItem, ProviderCompat } from "./configTypes";
import { ModelsTable } from "./ModelsTable";
import { ProviderConnectionForm, type ProviderTestResult } from "./ProviderConnectionForm";
import { buildProviderConfigFromDraft } from "./addProviderDraft";
import {
	applyModelPatches,
	applyAdaptiveTemplateReset,
	computeModelSpecPatches,
	mergeAdaptiveModelTemplate,
} from "../utils/modelSpecAutoFill";
import {
	countSelectedModelIndexes,
	removeSelectedModelIndexes,
	toggleAllModelIndexes,
	toggleModelIndex,
} from "./modelBatchSelection";

/**
 * 新增/编辑供应商页（Pi 模型页的「下一页」）：
 * - 新增：点「+ 添加供应商」进入，填名字 + 服务商配置 + 获取模型，一步加入；
 * - 编辑：卡片「修改名称」按钮进入，预填现有配置（名字可改，走 rename 语义），
 *   同时可重新拉取 /models 勾选保存模型。
 * 以整页形式呈现（非弹窗），左上角返回按钮回到模型列表；获取模型与配置在同一页内完成。
 */
export type AddProviderDraft = {
	name: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	userAgent: string;
	compat: {
		supportsDeveloperRole: boolean;
		supportsReasoningEffort: boolean;
	};
	models: ModelItem[];
};

/** 页面模式：add=新增空草稿；edit=预填现有 provider（含改名）。 */
export type ProviderDialogMode = "add" | "edit";

/** 编辑模式预填数据（现有 provider 配置）。 */
export type ProviderDialogInitial = {
	name: string;
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	userAgent?: string;
	compat?: ProviderCompat;
	models?: ModelItem[];
};

export function AddProviderDialog(props: {
	mode: ProviderDialogMode;
	/** edit 模式预填值（add 模式忽略）。 */
	initial?: ProviderDialogInitial;
	/** 已存在的供应商名（防重名；edit 模式已排除自身）。 */
	existingNames: string[];
	/** 返回模型列表（页面左上角返回按钮）。 */
	onBack: () => void;
	onConfirm: (draft: AddProviderDraft) => void;
}) {
	const [name, setName] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [userAgent, setUserAgent] = useState("");
	const [compat, setCompat] = useState({
		supportsDeveloperRole: false,
		supportsReasoningEffort: false,
	});
	/** 页内维护的模型草稿：新增=空，编辑=现有模型；获取模型勾选后追加。 */
	const [models, setModels] = useState<ModelItem[]>([]);
	/** 正在重置为自适应的行 key（String(index)；与 ModelsTable 的默认 getRowKey 对齐）。 */
	const [resettingModelKey, setResettingModelKey] = useState<string | null>(null);
	/** 手动添加模型后待聚焦的新行 key，ModelsTable 聚焦完成后回调清空。 */
	const [pendingModelFocusKey, setPendingModelFocusKey] = useState<string | null>(null);
	/** 模型批量删除模式（与展开卡片同款勾选列 + 删除选中）。 */
	const [modelBatchMode, setModelBatchMode] = useState(false);
	const [selectedModelIndexes, setSelectedModelIndexes] = useState<Set<number>>(() => new Set());
	// 快速测试连接（草稿级：配置不落盘，走临时 agent 目录探针）
	const [testModelId, setTestModelId] = useState("");
	const [testProxyMode, setTestProxyMode] = useState<ConfigProxyMode>("follow");
	const [testing, setTesting] = useState(false);
	const [testResult, setTestResult] = useState<ProviderTestResult | null>(null);
	// ── 获取模型（/models）──
	const [fetching, setFetching] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [fetchedModels, setFetchedModels] = useState<FetchedModel[] | null>(null);
	const [selectedFetchedIds, setSelectedFetchedIds] = useState<string[]>([]);

	// 每次进入页面重置草稿：add=空表单；edit=预填现有配置（含模型列表）
	useEffect(() => {
		const initial = props.initial;
		setName(initial?.name ?? "");
		setBaseUrl(initial?.baseUrl ?? "");
		setApi(initial?.api ?? "");
		setApiKey(initial?.apiKey ?? "");
		setUserAgent(initial?.userAgent ?? "");
		setCompat({
			supportsDeveloperRole: initial?.compat?.supportsDeveloperRole ?? false,
			supportsReasoningEffort: initial?.compat?.supportsReasoningEffort ?? false,
		});
		setModels(initial?.models ? initial.models.map((model) => ({ ...model })) : []);
		setFetchedModels(null);
		setSelectedFetchedIds([]);
		setFetchError(null);
		setModelBatchMode(false);
		setSelectedModelIndexes(new Set());
		setPendingModelFocusKey(null);
		setResettingModelKey(null);
		setTestModelId("");
		setTestResult(null);
	}, [props.initial, props.mode]);

	const trimmedName = name.trim();
	const nameValid = isValidProviderName(trimmedName);
	const duplicate = trimmedName !== "" && props.existingNames.includes(trimmedName);
	const canConfirm = nameValid && !duplicate;

	/** 获取模型用当前草稿的 baseUrl/apiKey/api（不依赖已保存的 provider）。 */
	const handleFetchModels = async () => {
		if (!baseUrl.trim() || !apiKey.trim()) {
			setFetchError(t("config.missingBaseUrlApiKey"));
			return;
		}
		setFetching(true);
		setFetchError(null);
		try {
			const result = await desktopApi.config.fetchModels(
				baseUrl.trim(),
				apiKey.trim(),
				api || undefined,
				userAgent.trim() ? { "User-Agent": userAgent.trim() } : undefined,
			);
			if (result.success && result.models) {
				setFetchedModels(result.models);
				setSelectedFetchedIds([]);
			} else {
				setFetchError(result.error ?? t("config.fetchModelsFailed"));
			}
		} catch (error) {
			setFetchError(error instanceof Error ? error.message : String(error));
		} finally {
			setFetching(false);
		}
	};

	/**
	 * 把勾选的获取结果追加进模型草稿（跳过已存在的 id）。
	 * 与展开卡片保存勾选流程一致：listing 已带容量的字段直接写入，
	 * 其余空字段再按 pi-ai 目录补全（getModelSpec），仍缺则保持空，不写猜测值。
	 */
	const saveSelectedFetched = async () => {
		if (!fetchedModels || selectedFetchedIds.length === 0) return;
		const baseModels = buildModelsFromFetchedSelection(fetchedModels, selectedFetchedIds, models);
		if (baseModels.length === 0) {
			showNotice(t("config.modelsAlreadyConfigured"));
			return;
		}
		const results = await Promise.all(
			baseModels.map((m) =>
				desktopApi.projects.getModelSpec(name.trim() || "draft", m.id, m.name).catch(() => null),
			),
		);
		let filledCount = 0;
		const newModels = baseModels.map((m, i) => {
			const updates = computeModelSpecPatches(m, results[i]);
			if (updates.length === 0) return m;
			filledCount++;
			return applyModelPatches(m, updates);
		});
		setModels((prev) => [...prev, ...newModels]);
		setSelectedFetchedIds([]);
		showNotice(
			filledCount > 0
				? t("config.modelsSavedWithSpecs", { count: filledCount })
				: t("config.modelsSavedFromFetch", { count: newModels.length }),
			filledCount > 0 ? 3000 : undefined,
		);
	};

	/**
	 * 重置为自适应：显式刷当前草稿 baseUrl/apiKey 的 /models 取实报字段，
	 * 再按 pi-ai 目录模板合并后只覆盖模板有值的字段（语义与 ConfigModal.handleResetModelToAdaptive 一致，
	 * 但作用于页内草稿——未保存的 provider 不落盘）。
	 */
	const handleResetModelToAdaptive = async (index: number) => {
		const model = models[index];
		if (!model) return;
		setResettingModelKey(String(index));
		try {
			let listing: FetchedModel | undefined;
			if (baseUrl.trim() && apiKey.trim()) {
				const result = await desktopApi.config.fetchModels(
					baseUrl.trim(),
					apiKey.trim(),
					api || undefined,
					userAgent.trim() ? { "User-Agent": userAgent.trim() } : undefined,
				);
				if (result.success && result.models) {
					listing = result.models.find((item) => item.id === model.id);
				}
			}
			const spec = await desktopApi.projects
				.getModelSpec(name.trim() || "draft", model.id, model.name)
				.catch(() => null);
			const template = mergeAdaptiveModelTemplate(listing, spec, model.id);
			const nextModel = applyAdaptiveTemplateReset(model, template);
			setModels((prev) => prev.map((m, j) => (j === index ? nextModel : m)));
			showNotice(
				template.matchedId
					? t("config.modelResetAdaptiveDone", { model: template.matchedId })
					: t("config.modelResetAdaptiveKept"),
				3000,
			);
		} finally {
			setResettingModelKey(null);
		}
	};

	/** 模型 ID/名称失焦时按 pi-ai 目录补齐空字段（语义与 ModelsTab.applyModelSpecAutoFill 一致，草稿级）。 */
	const applyModelSpecAutoFill = async (index: number, modelId: string) => {
		const trimmed = modelId.trim();
		if (!trimmed) return;
		const model = models[index];
		if (!model) return;
		const spec = await desktopApi.projects.getModelSpec(name.trim() || "draft", trimmed, model.name);
		const updates = computeModelSpecPatches(model, spec);
		if (updates.length === 0) return;
		setModels((prev) => prev.map((m, j) => (j === index ? applyModelPatches(m, updates) : m)));
		showNotice(t("config.modelSpecAutoFilled", { model: spec?.matchedId ?? trimmed }), 3000);
	};

	/** 手加一行空模型（能力字段留空，由失焦补全/重置为自适应补齐，不写猜测值）。 */
	const handleAddModel = () => {
		setPendingModelFocusKey(String(models.length));
		setModels((prev) => [...prev, { id: "", name: "" }]);
	};

	/** 切换模型批量删除模式；退出或删除后必须清空勾选（行索引随删除漂移）。 */
	const toggleModelBatch = () => {
		if (modelBatchMode) {
			setModelBatchMode(false);
			setSelectedModelIndexes(new Set());
		} else {
			setModelBatchMode(true);
		}
	};
	const clearModelBatch = () => {
		setModelBatchMode(false);
		setSelectedModelIndexes(new Set());
	};

	/**
	 * 测试连接（统一隔离探针）：不落盘正式配置，把当前草稿构建成临时 agent 目录
	 * （models.json + auth.json + PI_CODING_AGENT_DIR）后走真实 pi 探针路径
	 * （见主进程 config:test-provider；与展开卡片同一通道、同一语义）。
	 * 名字未填时用 "draft" 占位：探针只读临时目录，不影响正式配置。
	 */
	const handleTestProvider = async () => {
		if (!baseUrl.trim() || !apiKey.trim()) {
			setTestResult({ success: false, error: t("config.missingBaseUrlApiKey") });
			return;
		}
		const modelId = testModelId.trim() || models[0]?.id || "";
		if (!modelId) {
			setTestResult({ success: false, error: t("config.missingTestModel") });
			return;
		}
		setTesting(true);
		setTestResult(null);
		try {
			const providerName = trimmedName || "draft";
			// 草稿可能尚无模型行：探针按 --model 直测，塞一个最小条目保证 pi 能解析 provider
			const probeProvider = buildProviderConfigFromDraft({
				name: providerName,
				baseUrl,
				api,
				apiKey,
				userAgent,
				compat,
				models: models.length > 0 ? models : [{ id: modelId, name: modelId }],
			});
			const result = await desktopApi.config.testProvider(
				providerName,
				modelId,
				probeProvider,
				apiKey.trim(),
				testProxyMode,
			);
			setTestResult(result);
		} catch (error) {
			setTestResult({ success: false, error: error instanceof Error ? error.message : String(error) });
		} finally {
			setTesting(false);
		}
	};

	const submit = () => {
		if (!canConfirm) return;
		props.onConfirm({
			name: trimmedName,
			baseUrl: baseUrl.trim(),
			api,
			apiKey: apiKey.trim(),
			userAgent: userAgent.trim(),
			compat,
			models,
		});
	};

	return (
		<div className="flex h-full min-h-0 flex-col">
			{/* 页面头部：返回按钮 + 标题（对齐设置界面头部形态） */}
			<div className="flex shrink-0 items-center gap-2 border-b border-border-subtle px-4 py-2.5">
				<Button type="button" variant="ghost" size="icon-sm" className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
					onClick={props.onBack}
					title={t("common.back")}
					aria-label={t("common.back")}
				>
					<ArrowLeft size={16} />
				</Button>
				<span className="text-control font-semibold text-foreground">
					{props.mode === "edit" ? t("config.editProviderDialogTitle") : t("config.addProviderDialogTitle")}
				</span>
			</div>

			{/* 内容区：配置字段 + 获取模型 + 模型列表（可滚动） */}
			<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
				<div className="config-provider-form grid gap-2.5">
					<div className="grid grid-cols-[90px_1fr] items-start gap-2.5">
						<Label className="pl-0.5 pt-1.5 text-left text-xs font-medium text-text-secondary">
							{t("config.addProviderName")}
						</Label>
						<div className="flex min-w-0 flex-col gap-1">
							<Input
								value={name}
								className="h-8 min-w-0 rounded-sm border border-border-subtle bg-bg-panel px-3 font-mono text-control text-text-primary outline-none transition-[border-color,box-shadow,background-color] duration-150 focus:border-[var(--color-accent)] focus:shadow-[var(--focus-ring)]"
								placeholder={t("config.providerNamePlaceholder")}
								autoFocus
								onChange={(e) => setName(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Enter") submit();
								}}
							/>
							{trimmedName !== "" && !nameValid && (
								<span className="text-[11px] leading-relaxed text-destructive">{t("config.providerNameRule")}</span>
							)}
							{duplicate && (
								<span className="text-[11px] leading-relaxed text-destructive">{t("config.providerNameDuplicate")}</span>
							)}
						</div>
					</div>
					{/* 连接字段 + 测试连接 + 兼容性：与模型页展开卡片同一套组件（ProviderConnectionForm） */}
					<ProviderConnectionForm
						baseUrl={baseUrl}
						api={api}
						apiKey={apiKey}
						userAgent={userAgent}
						onChangeBaseUrl={setBaseUrl}
						onChangeApi={setApi}
						onChangeApiKey={setApiKey}
						onChangeUserAgent={setUserAgent}
						compat={compat}
						onChangeCompat={setCompat}
						testModelId={testModelId}
						onChangeTestModelId={setTestModelId}
						testing={testing}
						firstModelId={models[0]?.id}
						onTest={() => void handleTestProvider()}
						onClearTestResult={() => setTestResult(null)}
						testProxyMode={testProxyMode}
						onChangeTestProxyMode={setTestProxyMode}
						testResult={testResult}
						testHint={t(
							(fetchedModels?.length ?? 0) > 0
								? "config.testFailedButModelsFetched"
								: "config.testConnectionHint",
						)}
					/>
				</div>

				{/* ── 模型配置区：获取 /models + 勾选保存 + 已配置列表（新增/编辑共用） ── */}
				<div className="mt-4 border-t border-border-subtle pt-3">
					<div className="mb-2 flex items-center justify-between gap-2">
						<div className="flex min-w-0 flex-wrap items-center gap-2">
							<span className="text-xs font-semibold text-text-primary">{t("config.modelList")}</span>
							{modelBatchMode && (
								<span className="rounded-full bg-[color:var(--color-accent-soft)] px-2 py-0.5 text-[11px] font-medium tabular-nums text-[color:var(--color-accent)]">
									{t("config.modelBatchSelected", {
										selected: countSelectedModelIndexes(selectedModelIndexes, models.length),
										total: models.length,
									})}
								</span>
							)}
						</div>
						{/* 与展开卡片同款工具组：手动添加 + 获取模型 + 批量删除/取消 + 删除选中 */}
						<div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
							<Button type="button" variant="outline" size="sm" className="h-7" onClick={handleAddModel}>
								{t("config.addModelManual")}
							</Button>
							<Button type="button" variant="outline" size="sm" className="h-7" onClick={() => void handleFetchModels()} disabled={fetching || !baseUrl.trim() || !apiKey.trim()}>
								<RefreshCw size={13} className={fetching ? "animate-pideck-spin" : ""} aria-hidden="true" />
								{fetching ? t("config.fetchingModels") : t("config.fetchModels")}
							</Button>
							<Button
								type="button"
								variant={modelBatchMode ? "secondary" : "outline"}
								size="sm"
								className={`h-7${modelBatchMode ? "" : " text-destructive hover:bg-destructive/10 hover:text-destructive"}`}
								onClick={toggleModelBatch}
								disabled={models.length === 0}
							>
								{modelBatchMode ? (
									<X className="size-3.5" aria-hidden="true" />
								) : (
									<Trash2 className="size-3.5" aria-hidden="true" />
								)}
								{modelBatchMode ? t("common.cancel") : t("common.deleteBatch")}
							</Button>
							{modelBatchMode && (
								<Button
									type="button"
									variant="destructive"
									size="sm"
									className="h-7"
									onClick={() => {
										if (countSelectedModelIndexes(selectedModelIndexes, models.length) === 0) return;
										setModels((prev) => removeSelectedModelIndexes(prev, selectedModelIndexes));
										clearModelBatch();
									}}
									disabled={countSelectedModelIndexes(selectedModelIndexes, models.length) === 0}
								>
									<Trash2 className="size-3.5" aria-hidden="true" />
									{t("common.deleteSelected")} ({countSelectedModelIndexes(selectedModelIndexes, models.length)})
								</Button>
							)}
						</div>
					</div>
					{/* 获取结果勾选（拉取成功才显示） */}
					{fetchedModels && fetchedModels.length > 0 && (
						<div className="mb-2 flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-subtle p-2.5">
							<FetchedModelCombobox
								models={fetchedModels}
								value={selectedFetchedIds}
								existingModelIds={models.map((model) => model.id)}
								onChange={setSelectedFetchedIds}
							/>
							<div className="flex justify-end border-t border-border-subtle pt-2">
								<Button type="button" variant="default" size="sm" disabled={selectedFetchedIds.length === 0} onClick={saveSelectedFetched}>
									{t("config.saveSelectedModels")}
								</Button>
							</div>
						</div>
					)}
					{fetchError && (
						<div className="mb-2 rounded-sm border border-danger/20 bg-danger-soft px-3 py-2 text-[11px] leading-relaxed text-danger whitespace-pre-line">{fetchError}</div>
					)}
					{/* 已配置模型列表：与展开卡片同款模型表格（页内草稿管理，确认时随 provider 一起提交） */}
					<ModelsTable
						models={models}
						onUpdateModel={(index, field, value) =>
							setModels((prev) => prev.map((m, j) => (j === index ? { ...m, [field]: value } : m)))
						}
						onUpdateModelThinkingLevel={(index, key, value) => {
							// 思考级别写入模型草稿 thinkingLevelMap/reasoning，并同步 compat.supportsReasoningEffort
							// （与 ConfigModal 的 handleUpdateModelThinkingLevel 语义一致）
							setModels((prev) =>
								prev.map((m, j) => {
									if (j !== index) return m;
									const nextMap = { ...(m.thinkingLevelMap ?? {}) };
									if (value) nextMap[key] = value;
									else delete nextMap[key];
									const next = { ...m, reasoning: value ? true : m.reasoning };
									if (Object.keys(nextMap).length > 0) next.thinkingLevelMap = nextMap;
									else delete next.thinkingLevelMap;
									return next;
								}),
							);
							if (value) {
								setCompat((prev) => ({ ...prev, supportsReasoningEffort: true }));
							}
						}}
						onDeleteModel={(index) => {
							clearModelBatch();
							setModels((prev) => prev.filter((_, j) => j !== index));
						}}
						onResetModel={handleResetModelToAdaptive}
						resettingModelKey={resettingModelKey}
						onBlurAutoFill={applyModelSpecAutoFill}
						batchMode={modelBatchMode}
						selectedIndexes={selectedModelIndexes}
						onToggleSelectIndex={(index) =>
							setSelectedModelIndexes((current) => toggleModelIndex(current, index))
						}
						onToggleAll={(total) =>
							setSelectedModelIndexes((current) => toggleAllModelIndexes(current, total))
						}
						focusModelKey={pendingModelFocusKey}
						onFocusHandled={() => setPendingModelFocusKey(null)}
					/>
					<p className="mt-1.5 text-[11px] leading-relaxed text-text-tertiary">{t("config.providerDialogModelsHint")}</p>
				</div>
			</div>

			{/* 底部操作：返回（取消）+ 添加/保存 */}
			<div className="flex shrink-0 items-center justify-end gap-2 border-t border-border-subtle px-5 py-3">
				<Button type="button" variant="outline" size="sm" onClick={props.onBack}>
					{t("common.cancel")}
				</Button>
				<Button type="button" variant="default" size="sm" disabled={!canConfirm} onClick={submit}>
					{props.mode === "edit" ? t("common.save") : t("config.addProviderConfirm")}
				</Button>
			</div>
		</div>
	);
}
