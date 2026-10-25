/**
 * 当前聊天模型是否已声明原生图片输入。
 * 与 pi-deck-vision 的 currentModelSupportsImages 对齐：只有明确 images===true
 * 才视为原生看图；目录缺字段（undefined）仍走视觉桥兜底，不能当成已支持。
 *
 * 用户在配置页勾选的是 models.json 的 input 含 image，不一定立刻反映到
 * pi --list-models 缓存；本地配置覆盖 CLI 列，避免「已勾选仍显示转换中」。
 */

type ListedModel = { provider: string; id: string; images?: boolean };

export function imagesFromModelsJson(modelsFile: unknown): Map<string, boolean> {
	const result = new Map<string, boolean>();
	if (!modelsFile || typeof modelsFile !== "object" || Array.isArray(modelsFile)) return result;
	const providers = Reflect.get(modelsFile, "providers");
	if (!providers || typeof providers !== "object" || Array.isArray(providers)) return result;
	for (const [provider, config] of Object.entries(providers)) {
		if (!provider || !config || typeof config !== "object" || Array.isArray(config)) continue;
		const list = Reflect.get(config, "models");
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (!item || typeof item !== "object" || Array.isArray(item)) continue;
			const id = Reflect.get(item, "id");
			if (typeof id !== "string" || !id) continue;
			const input = Reflect.get(item, "input");
			if (!Array.isArray(input)) continue;
			result.set(`${provider}\0${id}`, input.includes("image"));
		}
	}
	return result;
}

export function modelSupportsNativeImages(models: ListedModel[], current: { provider?: string; modelId?: string } | undefined, localFile?: unknown): boolean {
	if (!current?.provider || !current.modelId) return false;
	const key = `${current.provider}\0${current.modelId}`;
	const local = imagesFromModelsJson(localFile).get(key);
	if (local === true) return true;
	if (local === false) return false;
	const found = models.find((model) => model.provider === current.provider && model.id === current.modelId);
	return found?.images === true;
}

/**
 * 用户气泡要不要走视觉桥轮询/「转换中」动画。
 * - false：不会调用视觉桥（DSH 不跑 pi 扩展，或当前模型已勾选图片能力）
 * - true：视觉桥可能接管，允许按开关轮询
 * - null：pi 模型目录还没解析完，不能先乐观显示转换中
 */
export function resolveVisionBridgeExpected(input: { backend?: string; modelSupportsImages: boolean | null }): boolean | null {
	if (input.backend === "dsh") return false;
	if (input.modelSupportsImages === true) return false;
	if (input.modelSupportsImages === null) return null;
	return true;
}
