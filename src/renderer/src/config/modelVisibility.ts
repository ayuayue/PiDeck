/**
 * 模型与提供商显示开关的纯函数（Pi 模型页与模型选择器通用）。
 *
 * 隐藏语义：
 * 1. 隐藏提供商（hiddenProviders）：整个 provider 从主列表和模型选择器隐藏；
 * 2. 隐藏单个模型（hiddenModels）：存储形式为 "provider/modelId"，
 *    在配置页该 provider 下移入「已隐藏模型」折叠区，在模型选择器中不展示；
 * 3. 恢复显示 = 从对应的隐藏列表中移除该项。
 * 配置本身均完整保留（models.json 不动），安全可逆。
 */

/** 生成模型在 hiddenModels 中的标准标识："${provider}/${modelId}"。 */
export function toModelKey(provider: string, modelId: string): string {
	return `${provider}/${modelId}`;
}

/** 按隐藏列表拆分供应商名：visible = 主列表展示，hidden = 底部「已隐藏」折叠区。 */
export function splitVisibleAndHiddenProviders(providerNames: string[], hiddenProviders: string[]): { visible: string[]; hidden: string[] } {
	const hiddenSet = new Set(hiddenProviders);
	const visible: string[] = [];
	const hidden: string[] = [];
	for (const name of providerNames) {
		if (hiddenSet.has(name)) hidden.push(name);
		else visible.push(name);
	}
	return { visible, hidden };
}

/** 切换单个供应商的隐藏状态：已隐藏则恢复，未隐藏则加入。 */
export function toggleHiddenProvider(hiddenProviders: string[], name: string): string[] {
	return hiddenProviders.includes(name) ? hiddenProviders.filter((item) => item !== name) : [...hiddenProviders, name];
}

/** 切换单个模型的隐藏状态：已隐藏则恢复，未隐藏则加入。 */
export function toggleHiddenModel(hiddenModels: string[], provider: string, modelId: string): string[] {
	const key = toModelKey(provider, modelId);
	return hiddenModels.includes(key) ? hiddenModels.filter((item) => item !== key) : [...hiddenModels, key];
}

/**
 * 按隐藏模型列表拆分单个 provider 的模型项：
 * visible = 表格正常显示行（保留带原索引供操作使用）；
 * hidden = 折叠区展示的隐藏行（附带原行原值与原始索引）。
 */
export function splitVisibleAndHiddenModels<T extends { id: string }>(
	provider: string,
	models: T[],
	hiddenModels: string[],
): {
	visible: Array<{ model: T; originalIndex: number }>;
	hidden: Array<{ model: T; originalIndex: number }>;
} {
	if (hiddenModels.length === 0) {
		return {
			visible: models.map((model, originalIndex) => ({ model, originalIndex })),
			hidden: [],
		};
	}
	const hiddenSet = new Set(hiddenModels);
	const visible: Array<{ model: T; originalIndex: number }> = [];
	const hidden: Array<{ model: T; originalIndex: number }> = [];
	models.forEach((model, originalIndex) => {
		const key = toModelKey(provider, model.id);
		if (hiddenSet.has(key)) {
			hidden.push({ model, originalIndex });
		} else {
			visible.push({ model, originalIndex });
		}
	});
	return { visible, hidden };
}

/**
 * 按隐藏列表同时过滤 provider 和 model（模型选择器使用）。
 * 过滤规则：
 * 1. 隐藏 provider 下的所有模型被过滤；
 * 2. 隐藏单个 modelKey ("provider/id") 的模型被过滤。
 */
export function filterVisibleModels<T extends { provider: string; id: string }>(models: T[], hiddenProviders?: string[], hiddenModels?: string[]): T[] {
	const hasHiddenProviders = Boolean(hiddenProviders && hiddenProviders.length > 0);
	const hasHiddenModels = Boolean(hiddenModels && hiddenModels.length > 0);
	if (!hasHiddenProviders && !hasHiddenModels) {
		return models;
	}
	const providerSet = hasHiddenProviders ? new Set(hiddenProviders) : null;
	const modelSet = hasHiddenModels ? new Set(hiddenModels) : null;
	return models.filter((model) => {
		if (providerSet && providerSet.has(model.provider)) return false;
		if (modelSet && modelSet.has(toModelKey(model.provider, model.id))) return false;
		return true;
	});
}

/**
 * 数组元素上下移动重排（纯函数，越界时原样返回新副本）。
 * direction === "up" 时向索引减小方向移动（从 1 到 0）；
 * direction === "down" 时向索引增大方向移动（从 0 到 1）。
 */
export function moveModelItem<T>(items: T[], fromIndex: number, direction: "up" | "down"): T[] {
	const targetIndex = direction === "up" ? fromIndex - 1 : fromIndex + 1;
	if (fromIndex < 0 || fromIndex >= items.length) return [...items];
	if (targetIndex < 0 || targetIndex >= items.length) return [...items];
	const next = [...items];
	const [removed] = next.splice(fromIndex, 1);
	next.splice(targetIndex, 0, removed);
	return next;
}
