/**
 * 外部 Agent 配置发现：主/渲染共享契约（发现结果条目 + 来源状态）。
 * 解析逻辑在 src/main/config/externalAgents/（编排见 externalAgentDiscovery.ts）；本文件只放类型，禁止反向依赖运行时层。
 */

/** 来源 agent 标识。 */
export type ExternalAgentKind = "claude-code" | "codex" | "opencode" | "gemini-cli" | "qwen-code" | "crush" | "goose" | "kimi-code" | "kilo-code" | "minimax-code" | "zcode" | "qoder-cn" | "openclaw";

/** 发现结果条目：渲染层展示用；apiKeyMasked 永远是掩码，真实 key 经 resolveExternalAgentKey 取。 */
export type ExternalAgentProviderFound = {
	/** 稳定 id：`<agent>:<provider>`（导入时凭它取真实 key）。 */
	id: string;
	agent: ExternalAgentKind;
	/** 建议的 pi 供应商名（已做安全校验/去重后缀）。 */
	providerName: string;
	/** pi api 协议类型（PROVIDER_API_OPTIONS 成员）。 */
	apiType: string;
	baseUrl?: string;
	/** 掩码后的 key（如 `sk-abc…xyz`）。 */
	apiKeyMasked?: string;
	/** 建议导入的模型 id（来自对方配置里正在用/默认的模型）。 */
	modelIds: string[];
	/** 该候选的说明：subscription:xxx（订阅登录，无 key 可导）/ no-key / undefined（正常 API key）。 */
	note?: string;
};

export type ExternalAgentDiscoveryResult = {
	sources: Array<{ agent: ExternalAgentKind; found: boolean; error?: string }>;
	providers: ExternalAgentProviderFound[];
};
