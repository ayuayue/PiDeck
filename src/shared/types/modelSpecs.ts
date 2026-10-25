/** Pi models.json thinking-level mapping. null explicitly disables a level. */
export type ThinkingLevelMap = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max", string | null>>;

/**
 * provider → 该供应商当前模型 id 集合（来自 models.json）。
 * 配置保存前的「设置跟着模型走」清理用它判定：键里的 provider 在表里、但模型 id 不在集合里 = 孤儿。
 * 不在表里的 provider 一律不动——pi 内置 provider 的档位/隐藏设置是合法的，不能误伤。
 */
export type ProviderModelIdIndex = ReadonlyMap<string, ReadonlySet<string>>;

export type ModelSpecSource = "listing" | "pi-ai" | "pi-runtime";
export type ModelSpecMatchKind = "provider-id" | "model-id" | "id-tail" | "name-alias";

/**
 * 模型规格匹配结果（context / 输出上限 / 推理 / 视觉）。
 *
 * 数据按模型本体匹配，与第三方中转站的 provider/baseUrl 无关。调用方仅用这些
 * 字段补空值，保留用户的 endpoint、认证、协议与显式覆盖。
 */
export type ModelSpec = {
	/** 上下文窗口（token 数） */
	contextWindow?: number;
	/** 建议单次输出上限（token 数） */
	maxTokens?: number;
	/** 推理模型（仅当目录明确支持时置 true） */
	reasoning?: boolean;
	/** 完整输入模态；存在时优先于 images，便于把文本模型也显式配置为 text-only。 */
	input?: Array<"text" | "image">;
	/** 支持图片输入（兼容旧调用方；input 存在时由它推导）。 */
	images?: boolean;
	/** Pi 的规范档位 → provider wire 值映射；用于保留 xhigh/max 等模型特有档位。 */
	thinkingLevelMap?: ThinkingLevelMap;
	/** 命中来源 */
	source: ModelSpecSource;
	/** 匹配方式：名称别名是受控候选，不会覆盖用户字段。 */
	matchKind?: ModelSpecMatchKind;
	/** 匹配到的规范模型 id */
	matchedId?: string;
};
