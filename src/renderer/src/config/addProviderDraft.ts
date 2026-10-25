import { setHeaderValue } from "./providerHeaders";
import { looksDeepSeekBacked } from "../utils/modelSpecAutoFill";
import type { ModelItem, ProviderCompat, ProviderConfig } from "./configTypes";

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
		/**
		 * 思考模式回传 reasoning_content。三态：true/false = 用户显式表态；
		 * undefined = 未触碰，交给保存时的 DeepSeek 特征自动判定（见 modelSpecAutoFill）。
		 */
		requiresReasoningContentOnAssistantMessages?: boolean;
		/**
		 * strict JSON-schema 工具采样（pi compat.supportsStrictMode）。
		 * 三态：true/false = 用户显式表态；undefined = 未触碰，保存时不写该键，
		 * 由 pi 按协议自行判定（openai-completions 默认开、responses 系默认关）。
		 * 变更背景与关闭原因见 configTypes.ProviderCompat.supportsStrictMode。
		 */
		supportsStrictMode?: boolean;
	};
	/** 弹窗内维护的模型草稿（新增=空；编辑=现有模型；获取模型勾选后追加）。 */
	models: ModelItem[];
	/**
	 * 逐模型 UA 覆盖（models.json 的 provider.modelOverrides，按 modelId 建键）。
	 * 三态：undefined = 表单不管这项（保留原 provider 的值）；`{}` = 显式清空；有值 = 以它为准。
	 */
	modelOverrides?: Record<string, Record<string, unknown>>;
	/**
	 * 新增页缓冲的「每模型默认思考档位」（modelId → 档位）：新增时 provider 还没有名字，
	 * 写不进 settings.json 的 `provider/modelId` 键，确认时由 ConfigModal 按最终名字落盘。
	 * 只有新增页会填；编辑页即时写回（同一个宿主回调），不重复落盘。
	 */
	modelThinkingLevelDefaults?: Record<string, string>;
	/** 新增页缓冲的「要隐藏的模型 id」（确认时并入 AppSettings.hiddenModels；编辑页即时生效）。 */
	hiddenModelIds?: string[];
};

/**
 * 打开供应商页/卡片时 reasoning_content 回传勾选的默认值（三态）。
 *
 * 文件里已有显式值 → 原样回显（`false` 是用户否决自动判定的表态，不能被重新打开）；
 * 未表态（undefined，含「模型列表还不全」的新增草稿）时：看着是 DeepSeek 系后端就预置
 * 勾选为 true——让用户看到的勾选状态与保存结果一致（保存时同一判定会再跑一遍，
 * 见 deriveProviderCompat）；其余情况保持未表态，不往 models.json 写无意义的 false 噪声。
 *
 * 参数只取结构子集（不依赖 UI 层的 ProviderDialogInitial），因此可在单测直接调用。
 */
export function resolveInitialReasoningContentReplay(
	initial:
		| {
				name: string;
				baseUrl?: string;
				models?: ModelItem[];
				compat?: ProviderCompat;
		  }
		| undefined,
): boolean | undefined {
	const saved = initial?.compat?.requiresReasoningContentOnAssistantMessages;
	if (saved !== undefined) return saved;
	if (!initial) return undefined;
	const deepseekBacked = looksDeepSeekBacked({ models: initial.models ?? [], baseUrl: initial.baseUrl }, initial.name);
	return deepseekBacked ? true : undefined;
}

/**
 * 供应商编辑页的初始化重置键：重置只由「页面模式 + 编辑对象身份」决定，与 initial 的
 * 引用无关。ModelsTab 在 JSX 内联构造预填对象，父组件刷新会传内容相同、引用不同的
 * initial；初始化 effect 若按引用做依赖，会把用户未保存的 API 类型 / User-Agent 草稿
 * 和测试结果整体冲回旧配置（issue #311）。键语义：
 *  - 同一供应商同一模式内的父组件刷新 → 键不变，不重置（保草稿与测试结果）；
 *  - 切换供应商 / add↔edit / 编辑对象消失 → 键变化，重新初始化。
 * 参数只取结构子集（不依赖 UI 层的 ProviderDialogInitial），因此可在单测直接调用。
 */
export function providerDialogResetKey(mode: "add" | "edit", initial: { name: string } | undefined): string {
	return `${mode}:${mode === "edit" ? (initial?.name ?? "") : ""}`;
}

/**
 * 「获取模型」成功后的 baseUrl 归一化：检测侧若走通了版本路径（/v1 等）而草稿
 * 仍是不带版本的根路径，会返回 suggestedBaseUrl（见 ConfigManager.fetchProviderModels）。
 * pi 会话原样使用 models.json 的 baseUrl，不改写则「拉取正常、会话 404」。
 * 与设置页展开卡片的 applySuggestedBaseUrl 同一语义，抽成纯函数便于单测。
 */
export function resolveFetchedBaseUrl(currentBaseUrl: string, suggestedBaseUrl?: string): { baseUrl: string; changed: boolean } {
	const next = (suggestedBaseUrl ?? "").trim().replace(/\/+$/, "");
	const current = (currentBaseUrl ?? "").trim().replace(/\/+$/, "");
	if (!next || next === current) return { baseUrl: currentBaseUrl, changed: false };
	return { baseUrl: next, changed: true };
}

/**
 * 弹窗草稿 → models.json provider 配置。
 * 空字段不写入（与手写 models.json 一致）；User-Agent 走 headers；
 * compat 全 false 不写（与 pi 默认一致）；baseUrl 去除首尾空白。
 * models 原样写入（弹窗内已是最终列表）。
 *
 * compat.requiresReasoningContentOnAssistantMessages 是唯一例外：它只在自己被
 * 赋值（true/false）时写入——false 是「用户否决自动判定」的表态，必须落盘才能压住
 * 保存时的 DeepSeek 特征判定，不能像另两项那样无条件显式写入。
 * compat.supportsStrictMode 同样只在自己被赋值时写入：它是三态的「用户表态」，
 * 未表态时不写，避免把 pi 自己的协议判定固化成配置（见 configTypes）。
 */
export function buildProviderConfigFromDraft(draft: AddProviderDraft): ProviderConfig {
	const provider: ProviderConfig = { models: draft.models ?? [] };
	// 新增页自己维护逐模型 UA（与展开卡片写同一存储位置 provider.modelOverrides）
	if (draft.modelOverrides && Object.keys(draft.modelOverrides).length > 0) provider.modelOverrides = draft.modelOverrides;
	if (draft.baseUrl.trim()) provider.baseUrl = draft.baseUrl.trim();
	if (draft.api) provider.api = draft.api;
	if (draft.apiKey.trim()) provider.apiKey = draft.apiKey.trim();
	if (draft.userAgent.trim()) {
		provider.headers = setHeaderValue(undefined, "User-Agent", draft.userAgent);
	}
	const reasoningContent = draft.compat.requiresReasoningContentOnAssistantMessages;
	const strictSampling = draft.compat.supportsStrictMode;
	if (draft.compat.supportsDeveloperRole || draft.compat.supportsReasoningEffort || reasoningContent !== undefined || strictSampling !== undefined) {
		provider.compat = {
			supportsDeveloperRole: draft.compat.supportsDeveloperRole,
			supportsReasoningEffort: draft.compat.supportsReasoningEffort,
		};
		if (reasoningContent !== undefined) {
			provider.compat.requiresReasoningContentOnAssistantMessages = reasoningContent;
		}
		if (strictSampling !== undefined) {
			provider.compat.supportsStrictMode = strictSampling;
		}
	}
	return provider;
}

/**
 * 编辑供应商页保存：以原 provider 为基底合并草稿，保留表单不拥有的字段。
 *
 * 为什么不能用 buildProviderConfigFromDraft 重建：那会把 oauth / authHeader
 * 以及除 User-Agent、modelOverrides 外的自定义字段与自定义 headers 静默丢掉
 * （展开卡片的内联编辑是原地改同一个对象，不会丢——两条入口行为不一致）。
 * 这里统一为「加载的 models.json 是 source of truth，表单只覆盖它拥有的字段」
 * （与 JSON Merge Patch / Kubernetes patch 的保真思路一致）：
 * - models / baseUrl / api / apiKey：表单拥有，空值 = 删除字段；
 * - headers：逐键合并，只覆盖 User-Agent，保留 X-App-URL / 鉴权头等自定义头；
 * - compat：合并两个已知布尔并保留未知子键；原本没有 compat 且两项都 false 时不凭空创建；
 * - modelOverrides（逐模型 UA）：表单拥有，草稿带值就整体覆盖（见字段三态注释）；
 * - 其余字段（oauth / authHeader / 未知字段）原样透传。
 * original 为空（新增模式）时等价于 buildProviderConfigFromDraft。
 */
export function mergeProviderDraft(original: ProviderConfig | undefined, draft: AddProviderDraft): ProviderConfig {
	if (!original) return buildProviderConfigFromDraft(draft);
	const next: ProviderConfig = { ...original };
	next.models = draft.models ?? [];
	// modelOverrides：表单拥有（编辑页草稿初值就是原 provider 的值），三态语义见 AddProviderDraft。
	// 原来靠「其余字段透传」保留它，现在由弹窗读写，必须显式处理清空（`{}`）与不管（undefined）。
	if (draft.modelOverrides !== undefined) {
		if (Object.keys(draft.modelOverrides).length > 0) next.modelOverrides = draft.modelOverrides;
		else delete next.modelOverrides;
	}
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
	// compat 合并：保留未知子键；原本没有 compat 且两项都 false 时不凭空创建。
	// requiresReasoningContentOnAssistantMessages 只在草稿显式赋值时覆盖，未表态则
	// 沿用文件里的值——否则一次无关编辑就会把用户手写的开关抹回「自动判定」。
	// supportsStrictMode 同理：未表态（undefined）时不动文件里的值，手写在 models.json
	// 里的 supportsStrictMode 不会被一次无关编辑抹掉。
	const reasoningContent = draft.compat.requiresReasoningContentOnAssistantMessages;
	const strictSampling = draft.compat.supportsStrictMode;
	const compat: ProviderCompat = {
		...(original.compat ?? {}),
		supportsDeveloperRole: draft.compat.supportsDeveloperRole,
		supportsReasoningEffort: draft.compat.supportsReasoningEffort,
	};
	if (reasoningContent !== undefined) {
		compat.requiresReasoningContentOnAssistantMessages = reasoningContent;
	}
	if (strictSampling !== undefined) {
		compat.supportsStrictMode = strictSampling;
	}
	const hasCompat = original.compat != null || draft.compat.supportsDeveloperRole || draft.compat.supportsReasoningEffort || reasoningContent !== undefined || strictSampling !== undefined;
	if (hasCompat) next.compat = compat;
	else delete next.compat;
	return next;
}
