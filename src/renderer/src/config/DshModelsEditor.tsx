import { useState } from "react";
import { desktopApi } from "../desktopApi";
import { t } from "../i18n";
import { showNotice } from "../utils/notice";
import { Button } from "../components/ui-shadcn/button";
import { ModelsTable, type DshModelRow } from "./DshModelsTable";
import { FetchedModelCombobox } from "./FetchedModelCombobox";
import { appendBlankDshModel, appendFetchedDshModels, dshModelInputField, removeDshModelAt, seedDshModelsForCustomEdit, updateDshModelAt } from "./dshModels";
import type { FetchedModel } from "../../../shared/types/fetchedModel";
import type { ModelSpec } from "../../../shared/types/modelSpecs";
import type { ModelItem } from "./configTypes";
import { computeModelSpecPatches } from "../utils/modelSpecAutoFill";

/**
 * DSH 的 reasoningEfforts 需要“规范档位 → 上游 wire 值”映射；pi-ai catalog 的
 * ModelSpec 只知道模型是否推理，不能安全构造这份映射。因此自动补全只写容量和图片输入。
 */
function dshModelSpecPatches(model: ModelItem, spec: ModelSpec | null, supportsGenericInput: boolean) {
	return computeModelSpecPatches(model, spec).filter(([field]) => field !== "reasoning" && (supportsGenericInput || field !== "input"));
}

/**
 * DSH custom model editor: extend or interrogate the adapter catalog without
 * starting from an empty draft. The visible fields follow dsh-web's curated
 * model editor, plus the input-modality control dsh-web keeps in the advanced
 * settings page: a model declared text-only is rejected by DSH prompt
 * admission as soon as a message carries an image.
 */
export function DshModelsEditor(props: {
	models: DshModelRow[];
	/** Whether the direct adapter's user layer owns the array (empty is meaningful there). */
	modelsOverridden?: boolean;
	/** Restore the adapter catalog by unsetting the user-layer models array. */
	onResetModels?: () => void;
	/** Whether inherited rows should immediately materialize a user override on edit. */
	editableInherited?: boolean;
	/** Adapter fallback capacities shown for a model that leaves them unset. */
	defaultContextWindow?: number;
	defaultMaxTokens?: number;
	savedModels?: DshModelRow[];
	catalog?: DshModelRow[];
	writable: boolean;
	providerKey?: string;
	/** DSH adapter settings namespace（如 llm-pi-ai / llm-deepseek）。 */
	settingsNs: string;
	baseURL?: string;
	api?: string;
	/** 只作为本次 discovery 的一次性密钥；为空时由 DSH 读取已存凭证。 */
	apiKeyDraft?: string;
	onChange: (models: DshModelRow[]) => void;
}) {
	const { models, savedModels, catalog, writable } = props;
	const [fetching, setFetching] = useState(false);
	const [fetched, setFetched] = useState<FetchedModel[] | null>(null);
	const [selectedIds, setSelectedIds] = useState<string[]>([]);
	const [fetchError, setFetchError] = useState<string | undefined>(undefined);
	// 当前 DSH 包只有 llm-pi-ai 注册了 llm.discoverModels；llm-deepseek 的官方配置面
	// 只编辑适配器 catalog，不能伪造一个必然返回 NO_DISCOVERY 的 endpoint 按钮。
	const canDiscoverModels = props.settingsNs === "llm-pi-ai";
	const seedInput = {
		draftModels: models,
		savedModels,
		catalog,
		// DeepSeek treats [] as an intentional catalog override; pi-ai keeps its
		// historic empty-means-inherit behavior.
		emptyDraftIsOverride: props.modelsOverridden === true,
	};

	// 继承目录时 models 为空，勾选器仍要把目录 id 标成已配置，避免重复拉回
	const existingIds = (models.length > 0 ? models : (catalog ?? [])).map((model) => (typeof model.id === "string" ? model.id : "")).filter(Boolean);

	const fetchModels = async () => {
		const settingsNs = props.settingsNs.trim();
		if (!settingsNs) {
			setFetchError(t("config.fetchModelsFailed"));
			return;
		}
		setFetching(true);
		setFetchError(undefined);
		try {
			const apiKey = props.apiKeyDraft?.trim();
			const result = await desktopApi.sessions.discoverDshModels({
				settingsNs,
				...(props.providerKey?.trim() ? { provider: props.providerKey.trim() } : {}),
				...(props.baseURL?.trim() ? { baseURL: props.baseURL.trim() } : {}),
				...(props.api?.trim() ? { api: props.api.trim() } : {}),
				...(apiKey ? { apiKey } : {}),
			});
			setFetched(result);
			setSelectedIds([]);
			showNotice(t("config.fetchedModels", { count: result.length }), 3000);
		} catch (error) {
			setFetchError(error instanceof Error ? error.message : String(error));
		} finally {
			setFetching(false);
		}
	};

	const saveSelected = async () => {
		if (!fetched || selectedIds.length === 0) return;
		const existing = seedDshModelsForCustomEdit(seedInput);
		let nextRows = appendFetchedDshModels({
			...seedInput,
			fetched,
			selectedIds,
		});
		// DSH discovery 只返回 endpoint/catalog 可确认的容量；已知模型再由本地 pi-ai catalog 补图片输入。
		// reasoning 只有 DSH 明确返回的 wire 映射才可信，不能从 Pi 的布尔事实构造。
		const appended = nextRows.slice(existing.length);
		const specs = await Promise.all(appended.map((row) => desktopApi.projects.getModelSpec(props.providerKey ?? "", typeof row.id === "string" ? row.id : "").catch(() => null)));
		for (let offset = 0; offset < appended.length; offset += 1) {
			const row = nextRows[existing.length + offset];
			if (!row || typeof row.id !== "string") continue;
			const model: ModelItem = {
				id: row.id,
				name: typeof row.name === "string" ? row.name : undefined,
				contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : undefined,
				maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : undefined,
				input: Array.isArray(row.input) ? row.input.filter((item): item is string => typeof item === "string") : undefined,
			};
			for (const [field, value] of dshModelSpecPatches(model, specs[offset], props.settingsNs === "llm-pi-ai")) {
				nextRows = updateDshModelAt({
					draftModels: nextRows,
					savedModels,
					catalog,
					index: existing.length + offset,
					field,
					value,
				});
			}
		}
		props.onChange(nextRows);
		setSelectedIds([]);
	};

	/** 手动输入 id 失焦：listing 没给的容量按 pi-ai 目录补，仍缺留空 */
	const fillFromCatalogOnIdBlur = async (index: number, modelId: string) => {
		const trimmed = modelId.trim();
		if (!trimmed || !writable) return;
		const spec = await desktopApi.projects.getModelSpec(props.providerKey ?? "", trimmed).catch(() => null);
		const current = seedDshModelsForCustomEdit(seedInput);
		const row = current[index];
		if (!row) return;
		const model: ModelItem = {
			id: typeof row.id === "string" ? row.id : trimmed,
			name: typeof row.name === "string" ? row.name : undefined,
			contextWindow: typeof row.contextWindow === "number" ? row.contextWindow : undefined,
			maxTokens: typeof row.maxTokens === "number" ? row.maxTokens : undefined,
			// 已声明的模态不能被目录补全覆盖（补全只填空字段；手填可能是适配器目录
			// 没收录的视觉别名，例如中转站的 `...-vision-exp`）。
			input: Array.isArray(row.input) ? row.input.filter((item): item is string => typeof item === "string") : undefined,
		};
		const updates = dshModelSpecPatches(model, spec, props.settingsNs === "llm-pi-ai");
		if (updates.length === 0) return;
		let nextRows = current;
		for (const [field, value] of updates) {
			nextRows = updateDshModelAt({
				draftModels: nextRows,
				savedModels,
				catalog,
				index,
				field,
				value,
			});
		}
		props.onChange(nextRows);
		showNotice(t("config.modelSpecAutoFilled", { model: spec?.matchedId ?? trimmed }), 3000);
	};

	return (
		<div className="grid gap-2">
			{canDiscoverModels && (
				<div className="flex flex-wrap items-center justify-end gap-1.5">
					<Button type="button" variant="outline" size="sm" className="h-7" disabled={!writable || fetching} onClick={() => void fetchModels()}>
						{fetching ? t("config.fetchingModels") : t("config.fetchModels")}
					</Button>
				</div>
			)}
			{fetchError && <div className="rounded-sm border border-danger/20 bg-danger-soft px-3.5 py-2.5 text-control leading-relaxed text-danger whitespace-pre-line">{fetchError}</div>}
			{fetched && fetched.length > 0 && (
				<div className="flex flex-col gap-2 rounded-md border border-border-subtle bg-bg-subtle p-2.5">
					<FetchedModelCombobox models={fetched} value={selectedIds} existingModelIds={existingIds} onChange={setSelectedIds} />
					<div className="flex justify-end border-t border-border-subtle pt-2">
						<Button type="button" variant="default" size="sm" disabled={selectedIds.length === 0} onClick={() => void saveSelected()}>
							{t("config.saveSelectedModels")}
						</Button>
					</div>
				</div>
			)}
			<ModelsTable
				models={models}
				catalog={catalog}
				modelsOverridden={props.modelsOverridden}
				onReset={props.onResetModels}
				editableInherited={props.editableInherited}
				defaultContextWindow={props.defaultContextWindow}
				defaultMaxTokens={props.defaultMaxTokens}
				allowCapacitySuffixes={props.settingsNs === "llm-deepseek"}
				inputField={dshModelInputField(props.settingsNs)}
				writable={writable}
				onAdd={() => props.onChange(appendBlankDshModel(seedInput))}
				onUpdate={(index, field, value) => props.onChange(updateDshModelAt({ ...seedInput, index, field, value }))}
				onRemove={(index) => props.onChange(removeDshModelAt({ ...seedInput, index }))}
				onIdBlur={canDiscoverModels ? (index, modelId) => void fillFromCatalogOnIdBlur(index, modelId) : undefined}
			/>
		</div>
	);
}
