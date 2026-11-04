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

// 模型表渐进渲染窗口：每行是「4 输入框 + Popover + 2 Dialog + 操作按钮」的重树，整表平铺
// 挂载与逐键整表重渲都会卡。窗口 20 行是实测一屏半的量——几十行的供应商展开也不该全量挂载，
// 不足再按步长「继续加载」（窗口只做前缀切片，行 index 语义不变）。
export const MODEL_TABLE_INITIAL_VISIBLE_ROWS = 20;
export const MODEL_TABLE_LOAD_MORE_STEP = 20;

/**
 * 模型表当前应渲染的行数（前缀窗口）。
 * 窗口只做前缀切片：行 index 与原数组一一对应，批量选择/删除/移动等 index 定位语义不变。
 * focusIndex ≥ 0 时（聚焦新增行）扩窗到能看见该行；结果始终夹在 [0, total]。
 */
export function resolveModelTableVisibleRowCount(total: number, windowSize: number, focusIndex: number): number {
	const expanded = Math.max(windowSize, focusIndex + 1);
	return Math.max(0, Math.min(total, expanded));
}
