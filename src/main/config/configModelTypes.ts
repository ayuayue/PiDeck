/**
 * pi 配置文件（models.json / auth.json / settings.json）的结构类型与 ConfigManager 公共契约。
 *
 * 从 ConfigManager.ts 原样搬出（行为零变化）：ConfigManager 仍在原路径 `export type` 转发，
 * 既有 `import type { PiModelsFile } from "./ConfigManager"` 的调用方无需改动。
 *
 * **本模块只允许类型导出**：多个单测把 ConfigManager.ts 转成 CJS 后用一个「未知说明符返回 {}」
 * 的 require 桩跑真实代码路径，任何运行时导出被搬到这里都会在那些用例里变成 undefined。
 */
import type { MainProcessTranslationKey } from "../../shared/i18n/mainProcessCopy";

/** DSH 用量链路的外部读取能力（装配层注入；见 ConfigManager 构造注释）。 */
export type DshUsageLookup = {
	/** 生效 DSH_HOME（设置覆盖 > ~/.dsh > 应用私有目录，与 DshHost/resolveDshHomeDir 同一解析）。 */
	getHomeDir: () => string;
	/** 按 credential ref 读 DSH 凭据（$DSH_HOME/.credentials.yaml，环境层兜底）；无值返回 undefined。 */
	readCredential: (ref: string) => Promise<string | undefined>;
};

// ── models.json 结构 ──────────────────────────────────
// { providers: { [providerName]: { baseUrl, api, apiKey, models: [...] } } }

export type PiModelItem = {
	id: string;
	name?: string;
	/** 模型级 API 协议；缺省时继承 provider 或 pi 内置默认。 */
	api?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
	};
	[key: string]: unknown;
};

export type PiProviderConfig = {
	baseUrl?: string;
	api?: string;
	apiKey?: string;
	models: PiModelItem[];
	[key: string]: unknown;
};

export type PiModelsFile = {
	providers: Record<string, PiProviderConfig>;
};

// ── auth.json 结构 ────────────────────────────────────
// { [providerName]: { type: "api_key", key: "..." } }

export type PiAuthItem = {
	type?: string;
	key?: string;
	[key: string]: unknown;
};

export type PiAuthFile = Record<string, PiAuthItem>;

// ── settings.json ─────────────────────────────────────

export type PiSettings = Record<string, unknown>;

export type ConfigValidationResult = {
	valid: boolean;
	error?: string;
	debugDetails?: string;
	/** 乐观锁冲突：磁盘内容与页面快照不一致（调用方应提示重新加载）。 */
	conflict?: boolean;
	/** 写入成功后的新 revision；冲突时为磁盘当前 revision。 */
	revision?: string;
};

export type ConfigCopy = (key: MainProcessTranslationKey, params?: Record<string, string | number>) => string;

export type TestRequest = {
	url: string;
	headers: Record<string, string>;
	body?: string;
	method?: "GET" | "POST";
};
