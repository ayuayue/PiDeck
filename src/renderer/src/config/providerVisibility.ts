/**
 * 向后兼容转发层：旧模块统一重新导出新 modelVisibility 中的函数，
 * 避免破坏既有引用。
 */
export {
	toModelKey,
	splitVisibleAndHiddenProviders,
	toggleHiddenProvider,
	toggleHiddenModel,
	splitVisibleAndHiddenModels,
	filterVisibleModels,
	moveModelItem,
} from "./modelVisibility";

// 兼容既有 filterModelsByHiddenProviders 签名
export function filterModelsByHiddenProviders<T extends { provider: string }>(models: T[], hiddenProviders: string[]): T[] {
	if (hiddenProviders.length === 0) return models;
	const hiddenSet = new Set(hiddenProviders);
	return models.filter((model) => !hiddenSet.has(model.provider));
}
