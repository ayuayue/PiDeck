export type ConfigTab = "models" | "auth" | "settings" | "im" | "raw";

// ── 匹配 pi 实际文件格式的类型 ────────────────────────

export type ModelItem = {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	[key: string]: unknown;
};

export type ProviderConfig = {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models: ModelItem[];
	[key: string]: unknown;
};

export type ModelsFile = { providers: Record<string, ProviderConfig> };
export type AuthFile = Record<
	string,
	{ type?: string; key?: string; [key: string]: unknown }
>;
export type SettingsFile = Record<string, unknown>;
