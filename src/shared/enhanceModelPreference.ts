/**
 * 提示词增强的目标模型解析（纯函数，无运行时依赖）。
 *
 * 优先级：用户在设置里显式指定的增强模型 > 会话记录模型 > 引导页点选偏好 >
 * 部署/主进程启动默认。前一级字段不完整（缺 provider 或 modelId）时自然落空，
 * 由下一级补位；全部落空返回 null（渲染层报「无可用模型」而不是发坏请求）。
 */

export type EnhanceModelSelection = { provider: string; modelId: string };

export type EnhanceModelSource = EnhanceModelSelection | undefined | null;

/** provider/modelId 双非空字符串才算可用（localStorage/旧数据可能只有半个）。 */
function isUsable(model: EnhanceModelSource): model is EnhanceModelSelection {
	return Boolean(model && typeof model.provider === "string" && model.provider.length > 0 && typeof model.modelId === "string" && model.modelId.length > 0);
}

export function resolveEnhanceTargetModel(input: {
	/** 设置页显式指定的增强模型（settings.enhanceModel；null = 跟随会话模型）。 */
	configured?: EnhanceModelSource;
	/** 当前会话记录的模型快照（record.model）。 */
	recordModel?: EnhanceModelSource;
	/** 引导页点选偏好（localStorage 残留，可能指向已删模型——主进程会报 model-not-found）。 */
	welcomeModel?: EnhanceModelSource;
	/** 兜底：DSH 部署默认 / 主进程解析的启动默认。 */
	fallback?: EnhanceModelSource;
}): EnhanceModelSelection | null {
	for (const candidate of [input.configured, input.recordModel, input.welcomeModel, input.fallback]) {
		if (isUsable(candidate)) return { provider: candidate.provider, modelId: candidate.modelId };
	}
	return null;
}

/**
 * 设置入参规范化：只接受双字段非空字符串的形态，其余（含 null/undefined/非对象）
 * 一律归一为 null（= 跟随会话模型）。SettingsStore 依赖 electron 无法直接单测，
 * 放 shared 纯函数；超长截断到 200 防脏数据落盘。
 */
export function normalizeEnhanceModel(value: unknown): EnhanceModelSelection | null {
	if (typeof value !== "object" || value === null) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.provider !== "string" || typeof record.modelId !== "string") return null;
	const provider = record.provider.trim();
	const modelId = record.modelId.trim();
	if (!provider || !modelId) return null;
	return { provider: provider.slice(0, 200), modelId: modelId.slice(0, 200) };
}
