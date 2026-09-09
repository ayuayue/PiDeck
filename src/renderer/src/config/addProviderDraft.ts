import { setHeaderValue } from "./providerHeaders";
import type { ModelItem, ProviderConfig } from "./configTypes";

/**
 * 新增/编辑供应商弹窗的草稿类型与草稿 → models.json provider 转换（纯函数，便于单测）。
 * 与 AddProviderDialog 组件分离：组件只负责收集字段，转换逻辑独立可测。
 */
export type AddProviderDraft = {
	name: string;
	baseUrl: string;
	api: string;
	apiKey: string;
	userAgent: string;
	compat: {
		supportsDeveloperRole: boolean;
		supportsReasoningEffort: boolean;
	};
	/** 弹窗内维护的模型草稿（新增=空；编辑=现有模型；获取模型勾选后追加）。 */
	models: ModelItem[];
};

/**
 * 弹窗草稿 → models.json provider 配置。
 * 空字段不写入（与手写 models.json 一致）；User-Agent 走 headers；
 * compat 全 false 不写（与 pi 默认一致）；baseUrl 去除首尾空白。
 * models 原样写入（弹窗内已是最终列表）。
 */
export function buildProviderConfigFromDraft(draft: AddProviderDraft): ProviderConfig {
	const provider: ProviderConfig = { models: draft.models ?? [] };
	if (draft.baseUrl.trim()) provider.baseUrl = draft.baseUrl.trim();
	if (draft.api) provider.api = draft.api;
	if (draft.apiKey.trim()) provider.apiKey = draft.apiKey.trim();
	if (draft.userAgent.trim()) {
		provider.headers = setHeaderValue(undefined, "User-Agent", draft.userAgent);
	}
	if (draft.compat.supportsDeveloperRole || draft.compat.supportsReasoningEffort) {
		provider.compat = {
			supportsDeveloperRole: draft.compat.supportsDeveloperRole,
			supportsReasoningEffort: draft.compat.supportsReasoningEffort,
		};
	}
	return provider;
}

/**
 * 编辑供应商页保存：以原 provider 为基底合并草稿，保留表单不拥有的字段。
 *
 * 为什么不能用 buildProviderConfigFromDraft 重建：那会把 oauth / authHeader /
 * modelOverrides / 自定义字段以及除 User-Agent 外的自定义 headers 静默丢掉
 * （展开卡片的内联编辑是原地改同一个对象，不会丢——两条入口行为不一致）。
 * 这里统一为「加载的 models.json 是 source of truth，表单只覆盖它拥有的字段」
 * （与 JSON Merge Patch / Kubernetes patch 的保真思路一致）：
 * - models / baseUrl / api / apiKey：表单拥有，空值 = 删除字段；
 * - headers：逐键合并，只覆盖 User-Agent，保留 X-App-URL / 鉴权头等自定义头；
 * - compat：合并两个已知布尔并保留未知子键；原本没有 compat 且两项都 false 时不凭空创建；
 * - 其余字段（oauth / authHeader / modelOverrides / 未知字段）原样透传。
 * original 为空（新增模式）时等价于 buildProviderConfigFromDraft。
 */
export function mergeProviderDraft(
	original: ProviderConfig | undefined,
	draft: AddProviderDraft,
): ProviderConfig {
	if (!original) return buildProviderConfigFromDraft(draft);
	const next: ProviderConfig = { ...original };
	next.models = draft.models ?? [];
	if (draft.baseUrl.trim()) next.baseUrl = draft.baseUrl.trim();
	else delete next.baseUrl;
	if (draft.api) next.api = draft.api;
	else delete next.api;
	if (draft.apiKey.trim()) next.apiKey = draft.apiKey.trim();
	else delete next.apiKey;
	// headers 逐键合并：setHeaderValue 会先删同名旧键，再按需重写 User-Agent
	const headers = setHeaderValue(original.headers, "User-Agent", draft.userAgent);
	if (headers) next.headers = headers;
	else delete next.headers;
	// compat 合并：保留未知子键；原本没有 compat 且两项都 false 时不凭空创建
	const compat = {
		...(original.compat ?? {}),
		supportsDeveloperRole: draft.compat.supportsDeveloperRole,
		supportsReasoningEffort: draft.compat.supportsReasoningEffort,
	};
	const hasCompat =
		original.compat != null ||
		draft.compat.supportsDeveloperRole ||
		draft.compat.supportsReasoningEffort;
	if (hasCompat) next.compat = compat;
	else delete next.compat;
	return next;
}
