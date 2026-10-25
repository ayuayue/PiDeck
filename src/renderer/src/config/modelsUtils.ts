import type { FetchedModel } from "../../../shared/types/fetchedModel";
// 排序键与主进程 / 模型下拉列表共用 shared 比较器，保证「保存顺序 = 下拉顺序」。
import { sortModelRows } from "../../../shared/modelOrder";
import type { ModelItem } from "./configTypes";

export type { FetchedModel };

/**
 * 根据从 API 拉取的模型列表和用户选中项，生成待新增的 ModelItem 列表。
 *
 * 过滤：只保留勾选且尚未配置的 id。
 * 容量：listing 已返回的 contextWindow/maxTokens 原样带上；
 * listing 没有的字段由调用方再用 pi-ai 目录补（见 ModelsTab / DshModelsEditor），
 * 仍没有就空着，不写猜的默认值。
 */
export function buildModelsFromFetchedSelection(fetchedModels: FetchedModel[], selectedModelIds: string[], existingModels: ModelItem[]): ModelItem[] {
	const existingIds = new Set(existingModels.map((model) => model.id));
	const selectedIds = new Set(selectedModelIds);
	const result = fetchedModels
		.filter((model) => selectedIds.has(model.id) && !existingIds.has(model.id))
		.map((model) => {
			const item: ModelItem = {
				id: model.id,
				name: model.name ?? model.id,
			};
			if (model.contextWindow != null) item.contextWindow = model.contextWindow;
			if (model.maxTokens != null) item.maxTokens = model.maxTokens;
			if (model.reasoning !== undefined) item.reasoning = model.reasoning;
			if (model.thinkingLevelMap) item.thinkingLevelMap = { ...model.thinkingLevelMap };
			if (model.input && model.input.length > 0) item.input = model.input;
			return item;
		});
	// 按展示名正序排列（name 缺失回退 id），保证保存后模型表顺序稳定。
	return sortModelRows(result);
}
