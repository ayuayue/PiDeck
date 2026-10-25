import type { FetchedModel } from "../../../shared/types/fetchedModel";
// 排序键收敛到 shared：DSH 模型行与 Pi 配置页 / 下拉列表保持同一顺序。
import { sortModelRows } from "../../../shared/modelOrder";
import { buildModelsFromFetchedSelection } from "./modelsUtils";

/** DSH 模型行：自定义覆盖适配器目录时写入 settings.yaml 的条目。 */
export type DshModelLike = {
	id?: unknown;
	name?: unknown;
	contextWindow?: unknown;
	maxTokens?: unknown;
	[key: string]: unknown;
};

export type DshDeepseekModelValidationFailure = {
	index: number;
	issue: "idRequired" | "idDuplicate" | "nameInvalid" | "contextInvalid" | "maxTokensInvalid";
};

const CAPACITY_PATTERN = /^(\d+(?:\.\d+)?)([km])?$/i;

/** Parse the same `256K` / `1M` capacity shorthand accepted by DSH Web. */
export function parseDshModelCapacity(raw: string): number | undefined {
	const trimmed = raw.trim();
	if (!trimmed) return undefined;
	const match = CAPACITY_PATTERN.exec(trimmed);
	if (!match) return Number.NaN;
	const suffix = match[2]?.toLowerCase();
	const scale = suffix === "k" ? 1_000 : suffix === "m" ? 1_000_000 : 1;
	const scaled = Number(match[1]) * scale;
	const rounded = Math.round(scaled);
	return Math.abs(scaled - rounded) < 1e-6 ? rounded : scaled;
}

/** Keep adapter-default capacities compact in placeholders, as DSH Web does. */
export function formatDshModelCapacity(value: unknown, fallback = ""): string {
	if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback;
	if (value % 1_000_000 === 0) return `${value / 1_000_000}M`;
	if (value % 1_000 === 0) return `${value / 1_000}K`;
	return String(value);
}

function isDshModelRecord(value: unknown): value is DshModelLike {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate the direct adapter's user-owned array before persisting it. */
export function validateDshDeepseekModels(value: unknown): DshDeepseekModelValidationFailure | undefined {
	if (value === undefined) return undefined;
	const models = Array.isArray(value) ? value : [];
	const ids = new Set<string>();
	for (const [index, candidate] of models.entries()) {
		const model = isDshModelRecord(candidate) ? candidate : {};
		const id = typeof model.id === "string" ? model.id.trim() : "";
		if (!id) return { index, issue: "idRequired" };
		if (ids.has(id)) return { index, issue: "idDuplicate" };
		ids.add(id);
		if (model.name !== undefined && (typeof model.name !== "string" || model.name.length === 0)) {
			return { index, issue: "nameInvalid" };
		}
		if (model.contextWindow !== undefined && (typeof model.contextWindow !== "number" || !Number.isInteger(model.contextWindow) || model.contextWindow <= 0)) {
			return { index, issue: "contextInvalid" };
		}
		if (model.maxTokens !== undefined && (typeof model.maxTokens !== "number" || !Number.isInteger(model.maxTokens) || model.maxTokens <= 0)) {
			return { index, issue: "maxTokensInvalid" };
		}
	}
	return undefined;
}

function cloneModelRows(rows: unknown): DshModelLike[] {
	if (!Array.isArray(rows)) return [];
	return rows.map((row) => (row && typeof row === "object" && !Array.isArray(row) ? { ...(row as DshModelLike) } : { id: "" }));
}

function isNonEmptyModelList(rows: unknown): rows is unknown[] {
	return Array.isArray(rows) && rows.length > 0;
}

/**
 * 开始自定义编辑前解析「当前已有模型」。
 *
 * DSH 语义：provider.models 非空 = 覆盖适配器目录。首次点「添加 / 获取」时
 * draft 往往还没有 models，若只从 draft 起步会写成 [空行] 并在保存时清空目录。
 *
 * 优先级：
 * 1. draft 非空数组——本轮已开始自定义
 * 2. 已保存的自定义列表
 * 3. 适配器目录（继承态下第一次自定义，必须先拷贝再改）
 *
 * draft=[] 在 pi-ai 中与「尚未写入」同等对待；Direct DeepSeek 则通过
 * `emptyDraftIsOverride` 保留它的“显式零模型”语义。
 */
type DshModelSeedInput = {
	draftModels?: unknown;
	savedModels?: unknown;
	catalog?: unknown;
	/** Direct DeepSeek uses `models: []` as an explicit zero-model override. */
	emptyDraftIsOverride?: boolean;
};

export function seedDshModelsForCustomEdit(input: DshModelSeedInput): DshModelLike[] {
	if (Array.isArray(input.draftModels) && (input.emptyDraftIsOverride || input.draftModels.length > 0)) {
		return cloneModelRows(input.draftModels);
	}
	if (isNonEmptyModelList(input.savedModels)) return cloneModelRows(input.savedModels);
	return cloneModelRows(input.catalog);
}

/** 在已有模型末尾追加一行空自定义（不丢目录 / 已保存列表）。 */
export function appendBlankDshModel(input: DshModelSeedInput): DshModelLike[] {
	const models = seedDshModelsForCustomEdit(input);
	models.push({ id: "" });
	return models;
}

/** 改某一行字段前先按同样优先级铺底，避免只写 draft 时把其它行冲掉。 */
export function updateDshModelAt(
	input: DshModelSeedInput & {
		index: number;
		field: string;
		value: unknown;
	},
): DshModelLike[] {
	const models = seedDshModelsForCustomEdit(input);
	const entry = { ...(models[input.index] ?? {}) };
	if (input.value === undefined || input.value === "") {
		delete entry[input.field];
	} else {
		entry[input.field] = input.value;
	}
	models[input.index] = entry;
	return models;
}

/** 删除一行前同样先铺底，避免 inherited / 已保存列表被当成空数组。 */
export function removeDshModelAt(
	input: DshModelSeedInput & {
		index: number;
	},
): DshModelLike[] {
	return seedDshModelsForCustomEdit(input).filter((_, index) => index !== input.index);
}

/** 把勾选的拉取结果追加到已有模型，跳过 id 重复。 */
export function appendFetchedDshModels(
	input: DshModelSeedInput & {
		fetched: FetchedModel[];
		selectedIds: string[];
	},
): DshModelLike[] {
	const existing = seedDshModelsForCustomEdit(input);
	const existingItems = existing.map((row) => ({
		id: typeof row.id === "string" ? row.id : "",
		name: typeof row.name === "string" ? row.name : undefined,
	}));
	const added = buildModelsFromFetchedSelection(input.fetched, input.selectedIds, existingItems);
	const result = [
		...existing,
		...added.map((model) => {
			const row: DshModelLike = { id: model.id, name: model.name };
			// 与 Pi 配置页同一套：listing / pi-ai 已给出的容量原样写入，缺的留空
			if (model.contextWindow != null) row.contextWindow = model.contextWindow;
			if (model.maxTokens != null) row.maxTokens = model.maxTokens;
			if (Array.isArray(model.input) && model.input.length > 0) row.input = [...model.input];
			return row;
		}),
	];
	// 按展示名正序排列（name 缺失回退 id），保证保存后模型表顺序稳定。
	return sortModelRows(result);
}

/** 输入模态在 settings.yaml 里的字段名：两个适配器的 schema 拼写不同。 */
export type DshModelInputField = "input" | "inputModalities";

/** 配置页的三态：继承适配器目录（不写字段）/ 仅文本 / 文本+图片。 */
export type DshModalitySelection = "inherit" | "text" | "textImage";

/**
 * 模型行里承载输入模态的字段名。
 *
 * DSH 侧语义（node_modules 里两个适配器的 model schema）：
 * - llm-pi-ai：`input?: ("text"|"image")[]`，缺省/空数组都表示「沿用适配器目录，
 *   目录也不认识时落到 route.defaultInput（默认 ["text"]）」；
 * - llm-deepseek：同义字段拼写为 `inputModalities`（default ["text"]）。
 * 两个适配器都在 prompt 准入阶段用 `inputModalities` 校验带图消息，声明成纯文本
 * 会被 session/attachment-invalid 直接拒绝（MODEL_DOES_NOT_SUPPORT_IMAGES）。
 */
export function dshModelInputField(settingsNs: string): DshModelInputField | undefined {
	if (settingsNs === "llm-pi-ai") return "input";
	if (settingsNs === "llm-deepseek") return "inputModalities";
	return undefined;
}

/** 把已存的字段值映射成三态：缺省/空数组 = 继承。 */
export function dshModalitySelection(value: unknown): DshModalitySelection {
	if (!Array.isArray(value)) return "inherit";
	const modalities = value.filter((item): item is string => typeof item === "string");
	if (modalities.length === 0) return "inherit";
	return modalities.includes("image") ? "textImage" : "text";
}

/** 三态 → 写入 settings.yaml 的字段值；"inherit" 用 undefined 表示删掉字段（沿用目录）。 */
export function dshModalityValue(selection: DshModalitySelection): string[] | undefined {
	if (selection === "inherit") return undefined;
	return selection === "textImage" ? ["text", "image"] : ["text"];
}

/** DSH 配置页应通过 host 的 llm.discoverModels 取候选，不在 renderer 解析 provider 端点。 */
