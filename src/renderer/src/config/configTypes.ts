export type ConfigTab = "models" | "auth" | "settings" | "trust" | "raw";

// ── 匹配 pi 实际文件格式的类型 ────────────────────────

export type ThinkingLevelMap = Partial<Record<"off" | "minimal" | "low" | "medium" | "high" | "xhigh", string | null>>;

export type ProviderCompat = {
	supportsDeveloperRole?: boolean;
	supportsReasoningEffort?: boolean;
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
	/** 自定义请求体：内联 JSON，由 pi-deck-body-override 扩展深合并进每次请求 */
	body?: Record<string, unknown>;
	/** 自定义请求体：本地 JSON 文件路径（相对路径基于 ~/.pi/agent/） */
	bodyFile?: string;
	[key: string]: unknown;
};

export type ProviderConfig = {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	compat?: ProviderCompat;
	models: ModelItem[];
	/** 自定义请求体：内联 JSON，模型级同名字段优先级更高 */
	body?: Record<string, unknown>;
	/** 自定义请求体：本地 JSON 文件路径（相对路径基于 ~/.pi/agent/） */
	bodyFile?: string;
	[key: string]: unknown;
};

export type ModelsFile = { providers: Record<string, ProviderConfig> };
export type AuthFile = Record<
	string,
	{ type?: string; key?: string; [key: string]: unknown }
>;
export type SettingsFile = Record<string, unknown>;
