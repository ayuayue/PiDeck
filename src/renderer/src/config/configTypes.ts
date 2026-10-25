export type ConfigTab = "models" | "auth" | "settings" | "trust" | "mcp" | "raw";

import type { ThinkingLevelMap } from "../../../shared/types/modelSpecs";
import type { ModelCostTier } from "./modelCostTiers";

export type { ThinkingLevelMap };

// ── 匹配 pi 实际文件格式的类型 ────────────────────────

/** 模型计费字段：单价为每百万 token 美元数，与 pi models.json 的 cost 字段一致。 */
export type ModelCost = {
	/** 输入 token 单价（$/M tokens） */
	input?: number;
	/** 输出 token 单价（$/M tokens） */
	output?: number;
	/** 缓存读 token 单价（$/M tokens） */
	cacheRead?: number;
	/** 缓存写 token 单价（$/M tokens） */
	cacheWrite?: number;
	/** 分档计费：输入 token 超过阈值后整次请求按该档费率（pi cost.tiers） */
	tiers?: ModelCostTier[];
};

export type ProviderCompat = {
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
	/**
	 * 思考模式需回传 reasoning_content。
	 *
	 * DeepSeek 系网关要求：带 tool_calls 的 assistant 回合必须在后续请求里回放
	 * reasoning_content，缺字段直接 400（"The `reasoning_content` in the thinking
	 * mode must be passed back to the API."）；pi 在该键为 true 且当轮没有思考内容时
	 * 补一个空串。缺省（undefined）= 用户未表态，保存时按 DeepSeek 特征自动判定
	 * （见 deriveProviderCompat）；显式 false = 用户否决自动判定，不再被覆盖。
	 */
	requiresReasoningContentOnAssistantMessages?: boolean;
	/**
	 * 是否发送 strict JSON-schema 工具定义（pi 的 compat.supportsStrictMode）。
	 *
	 * 背景：pi 0.86 起内置 read/bash/edit/write 无条件声明 json_schema 约束采样
	 * （0.85 需 PI_EXPERIMENTAL=1 才开）。pi-ai 据此在 openai-completions 协议下实际
	 * 发出 `strict: true` 并把 schema 重写为「全部参数进 required、可选参数变
	 * anyOf:[原类型,{type:"null"}]」。第三方中转站若不认 strict，可能退回模型原生工具
	 * 标记，把工具调用漏成纯文本（DeepSeek 系表现为 `<｜DSML｜>` 标记块），用户看到
	 * 一坨乱码且这一轮工具根本没执行。
	 *
	 * 三态（与 requiresReasoningContentOnAssistantMessages 同一套语义）：
	 * - undefined = 用户未表态：PiDeck 不写这个键，由 pi 按协议自行判定
	 *   （openai-completions 默认开、responses 系默认关）。**不做自动推导**——
	 *   自动写 true 会把 responses 系本该关掉的约定强行打开，反向改动线上行为；
	 * - true = 显式开启（= openai-completions 的默认值，写盘只为配置自解释）；
	 * - false = 显式关闭，回到 pi 0.85 的线上行为，用于修中转站把工具调用漏成文本。
	 */
	supportsStrictMode?: boolean;
	[key: string]: unknown;
};

export type ModelItem = {
	id: string;
	name?: string;
	reasoning?: boolean;
	thinkingLevelMap?: ThinkingLevelMap;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: ModelCost;
	[key: string]: unknown;
};

export type ProviderConfig = {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	compat?: ProviderCompat;
	models: ModelItem[];
	[key: string]: unknown;
};

export type ModelsFile = { providers: Record<string, ProviderConfig> };
export type AuthFile = Record<string, { type?: string; key?: string; [key: string]: unknown }>;
export type SettingsFile = Record<string, unknown>;
