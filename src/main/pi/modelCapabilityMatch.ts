import type { ModelSpec, ModelSpecMatchKind, ThinkingLevelMap } from "../../shared/types/modelSpecs";

const THINKING_LEVEL_KEYS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

type ThinkingLevelKey = (typeof THINKING_LEVEL_KEYS)[number];

/** 唯一可信来源：构建期从 pi-ai 官方 provider JSON 提取的目录（resources/pi-ai-catalog.json）。 */
export type ModelCapabilitySource = "pi-ai";

/** A trusted catalog entry whose model-level properties may fill a proxy model's blank fields. */
export type ModelCapabilityCandidate = {
	source: ModelCapabilitySource;
	provider: string;
	id: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	thinkingLevelMap?: ThinkingLevelMap;
};

export type ModelCapabilityLookupInput = {
	providerName: string;
	modelId: string;
	modelName?: string;
};

export type ModelCapabilityMatch = {
	candidate: ModelCapabilityCandidate;
	matchKind: ModelSpecMatchKind;
};

/** 容量值域上限：官方目录与端点 listing 都会出现荒唐值（实测某中转回 max_output_tokens=32763840008），
 *  超过该上限一律视为「未提供」——宁可留空让用户手填，也不把垃圾写进 models.json。 */
const MAX_PLAUSIBLE_CAPACITY = 100_000_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keep only Pi's finite thinking-level keys and safe wire values from untyped catalog/RPC data. */
export function parseThinkingLevelMap(value: unknown): ThinkingLevelMap | undefined {
	if (!isRecord(value)) return undefined;
	const map: ThinkingLevelMap = {};
	for (const key of THINKING_LEVEL_KEYS) {
		const wireValue = value[key];
		if (wireValue === null) {
			map[key] = null;
			continue;
		}
		if (typeof wireValue === "string" && wireValue.trim()) {
			map[key] = wireValue;
		}
	}
	return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * Normalize a model family without treating arbitrary substrings as model names.
 * `GPT-5.6 Luna`, `gpt_5_6-luna`, and `openai/gpt-5.6` retain the same
 * token boundary representation while still preserving version components.
 */
export function normalizeModelIdentity(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** 路径尾段：`deepseek-ai/DeepSeek-V4.1-Flash` → `DeepSeek-V4.1-Flash`。 */
function modelIdTail(modelId: string): string {
	const trimmed = modelId.trim();
	const slash = trimmed.lastIndexOf("/");
	return slash >= 0 && slash < trimmed.length - 1 ? trimmed.slice(slash + 1) : trimmed;
}

function identityVariants(value: string | undefined): string[] {
	if (!value?.trim()) return [];
	const variants = new Set<string>();
	const add = (candidate: string) => {
		const normalized = normalizeModelIdentity(candidate);
		if (normalized) variants.add(normalized);
	};
	add(value);
	add(modelIdTail(value));
	if (value.startsWith("models/")) add(value.slice("models/".length));
	return [...variants];
}

function sameIdentity(left: string, right: string): boolean {
	return identityVariants(left).some((variant) => identityVariants(right).includes(variant));
}

// ── 家族键 ────────────────────────────────────────────────────────

/**
 * 服务档位/路由装饰 token：与模型身份无关，参与家族键时剥掉。
 *
 * 为什么需要：中转站给同一官方模型的 id 带各种服务后缀（`-free`、`:batch`、`-latest`），
 * 官方目录里也有一批 `~xxx/deepseek-flash-latest` / `fireworks .../deepseek-flash-latest` 条目；
 * 不剥这些 token，`deepseek-v4-flash-latest` 就永远匹配不上 `deepseek-v4-flash`。
 */
const SERVICE_TIER_TOKENS = new Set(["free", "latest", "batch", "online", "proxy", "beta"]);

/**
 * 家族键：路径尾段 → 归一化 → 剥尾部服务档位 token。
 *
 * 为什么不能直接用完整 id：官方目录的 id 带厂商命名空间（`deepseek-ai/DeepSeek-V4.1-Flash`、
 * `accounts/fireworks/routers/deepseek-flash-latest`、`workers-ai/@cf/deepseek-ai/...`），
 * 中转站的 id 通常只有尾段（`deepseek-v4.1-flash`）。用尾段做家族键才能把两边对上。
 */
export function modelFamilyKey(value: string): string {
	const tokens = normalizeModelIdentity(modelIdTail(value)).split("-").filter(Boolean);
	while (tokens.length > 1 && SERVICE_TIER_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
	return tokens.join("-");
}

/**
 * 单字段值域护栏（端点 listing 与官方目录共用）。
 * 只挡「物理不可能」的量级；收紧到真实模型范围会把未来的长上下文模型误判为无效。
 */
export function plausibleCapacity(value: number | undefined): number | undefined {
	if (value === undefined || !Number.isInteger(value) || value <= 0 || value > MAX_PLAUSIBLE_CAPACITY) return undefined;
	return value;
}

/** 上下文窗口：与容量同口径。 */
export function plausibleContextWindow(value: number | undefined): number | undefined {
	return plausibleCapacity(value);
}

/** 输出上限同样要挡荒唐值，且不得超过已知上下文窗口（`max > ctx` 一定是坏数据）。 */
export function plausibleMaxTokens(value: number | undefined, contextWindow: number | undefined): number | undefined {
	const sane = plausibleCapacity(value);
	if (sane === undefined) return undefined;
	if (contextWindow !== undefined && sane > contextWindow) return undefined;
	return sane;
}

// ── 候选择优 ──────────────────────────────────────────────────────

function completeness(candidate: ModelCapabilityCandidate): number {
	return Number(candidate.contextWindow !== undefined) + Number(candidate.maxTokens !== undefined) + Number(candidate.reasoning !== undefined) + Number(candidate.input !== undefined) + Number(candidate.thinkingLevelMap !== undefined);
}

/** 同一 provider 的多个候选：完整度优先，其后只用 provider/id 保证确定性。 */
function choosePreferred(candidates: readonly ModelCapabilityCandidate[]): ModelCapabilityCandidate | undefined {
	return sortedCandidates(candidates).sort((left, right) => completeness(right) - completeness(left))[0];
}

/** 确定性基线顺序：任何「众数/首个」取值都基于它，避免结果随候选顺序漂移。 */
function sortedCandidates(candidates: readonly ModelCapabilityCandidate[]): ModelCapabilityCandidate[] {
	return [...candidates].sort((left, right) => {
		const providerDiff = left.provider.localeCompare(right.provider);
		if (providerDiff) return providerDiff;
		return left.id.localeCompare(right.id);
	});
}

/** 众数（按出现次数）；并列时取确定性顺序里的第一个，保证可复现。
 *  capacitiesPreferSmaller：容量字段并列时取小值——写大了上游会 400（max_tokens 超限）
 *  或让 pi 发出超出上游的长上下文，写小了只是提前压缩/输出变短，失败模式更软。 */
function modeOf<T>(values: readonly (T | undefined)[], preferSmaller = false): T | undefined {
	const counts = new Map<T, number>();
	const order: T[] = [];
	for (const value of values) {
		if (value === undefined) continue;
		if (!counts.has(value)) order.push(value);
		counts.set(value, (counts.get(value) ?? 0) + 1);
	}
	let best: T | undefined;
	let bestCount = 0;
	for (const value of order) {
		const count = counts.get(value) ?? 0;
		if (count > bestCount) {
			best = value;
			bestCount = count;
			continue;
		}
		if (preferSmaller && count === bestCount && typeof value === "number" && typeof best === "number" && value < best) best = value;
	}
	return best;
}

/**
 * 家族头 token → 官方目录里该「厂商自己的 provider」。
 *
 * 为什么需要：同一家族里平台的条目常带自家 SKU 的容量（azure 的 gpt-5.6-luna ctx=1050000，而
 * openai 自己与多数中转站都是 272000），而中转站服务的通常是厂商标准 API。
 * 只在家族头 token 与 provider 名对不上时才是必需项（deepseek / minimax / mistral 这类同名 provider
 * 走 provider 名前缀规则自动命中）。新增家族时按需补，语料测试会校验表里的 provider 仍存在于目录。
 */
export const FAMILY_VENDOR_PROVIDERS: Record<string, readonly string[]> = {
	gpt: ["openai"],
	o1: ["openai"],
	o3: ["openai"],
	o4: ["openai"],
	claude: ["anthropic"],
	gemini: ["google", "google-vertex"],
	gemma: ["google"],
	glm: ["zai", "zai-coding-cn"],
	kimi: ["moonshotai", "moonshotai-cn"],
	grok: ["xai"],
	llama: ["meta"],
	nemotron: ["nvidia"],
	nova: ["amazon-bedrock"],
};

function familyHead(familyKey: string): string {
	return familyKey.split("-").filter(Boolean)[0] ?? "";
}

/**
 * 厂系亲和打分：候选条目对这条家族有多「官方」。
 * - 3 = 厂商自己的条目（带 FAMILY_VENDOR_PROVIDERS 映射的家族，如 openai 的 gpt-*）；
 * - 2 = provider 名就是家族前缀（`deepseek` → `deepseek-v4-pro`、`mistral` → `mistral-large`）；
 * - 1 = 候选 id 带该厂商命名空间的上游镜像条目（openrouter 的 `deepseek/…`、huggingface 的 `deepseek-ai/…`）；
 * - 0 = 聚合/转售条目（baseten、amazon-bedrock 这类各自截断容量的条目）。
 */
function vendorTier(candidate: ModelCapabilityCandidate, familyKey: string): number {
	const vendors = FAMILY_VENDOR_PROVIDERS[familyHead(familyKey)];
	if (vendors?.includes(candidate.provider)) return 3;
	const providerKey = normalizeModelIdentity(candidate.provider);
	if (providerKey && (familyKey === providerKey || familyKey.startsWith(`${providerKey}-`))) return 2;
	const namespace = candidate.id.includes("/") ? candidate.id.slice(0, candidate.id.lastIndexOf("/")) : "";
	const namespaceHead = normalizeModelIdentity(namespace).split("-").filter(Boolean)[0];
	if (namespaceHead && (familyKey === namespaceHead || familyKey.startsWith(`${namespaceHead}-`))) return 1;
	return 0;
}

/**
 * 同一家族跨 provider 的代表条目。
 *
 * 关键修复：旧实现按 provider 名字典序取第一个，实测 279 组同 id 跨 provider 里有 55 组 ctx、
 * 61 组 maxTokens 与「多数 provider 的值」不一致（baseten 的 maxTokens=32768 就是这样压过官方 384000 的）。
 *
 * 字段分工：
 * - contextWindow 取「厂商自己声明的值」优先（平台条目常是自家 SKU：azure 的 gpt-5.6-luna=1050000，
 *   而 openai 与多数中转站是 272000）；厂商条目缺失时退回众数（并列取小值）；
 * - maxTokens / input 取「多家一致」的众数：厂商条目在输出上限上常用「等于上下文窗口」的填充值
 *   （moonshotai 的 kimi-k3 max=1048576=ctx），直接当上限会向上游发出超限的请求；
 * - 代表条目取「与上述取值一致字段最多」的那条，再按厂系亲和 → 完整度 → provider/id 字典序定序，
 *   既保证可复现，也让 matchedId 交代清楚的来源。
 */
function chooseFamilyRepresentative(group: readonly ModelCapabilityCandidate[]): ModelCapabilityCandidate {
	const ordered = sortedCandidates(group);
	const modeContext = modeOf(
		ordered.map((candidate) => candidate.contextWindow),
		true,
	);
	const modeMaxTokens = modeOf(
		ordered.map((candidate) => candidate.maxTokens),
		true,
	);
	const modeInput = modeOf(ordered.map((candidate) => candidate.input?.join("+")));
	const vendorContext = modeOf(
		ordered.filter((candidate) => vendorTier(candidate, modelFamilyKey(candidate.id)) >= 2).map((candidate) => candidate.contextWindow),
		true,
	);
	const preferredContext = vendorContext ?? modeContext;
	const agreement = (candidate: ModelCapabilityCandidate): number =>
		Number(candidate.contextWindow !== undefined && candidate.contextWindow === preferredContext) + Number(candidate.maxTokens !== undefined && candidate.maxTokens === modeMaxTokens) + Number(Boolean(candidate.input) && candidate.input?.join("+") === modeInput);
	return [...ordered].sort((left, right) => {
		const agreementDiff = agreement(right) - agreement(left);
		if (agreementDiff) return agreementDiff;
		const affinityDiff = vendorTier(right, modelFamilyKey(right.id)) - vendorTier(left, modelFamilyKey(left.id));
		if (affinityDiff) return affinityDiff;
		const completenessDiff = completeness(right) - completeness(left);
		if (completenessDiff) return completenessDiff;
		const providerDiff = left.provider.localeCompare(right.provider);
		if (providerDiff) return providerDiff;
		return left.id.localeCompare(right.id);
	})[0];
}

// ── 别名匹配 ──────────────────────────────────────────────────────

/**
 * 变体 token：出现在「差集」里说明是另一个模型，不能当同一家族。
 * `gpt-5` 不能当 `gpt-5.6`（数字后缀）或 `gpt-4o-mini`（变体 token）的模板。
 */
const MODEL_VARIANT_TOKENS = new Set(["mini", "nano", "pro", "turbo", "instruct", "preview", "latest"]);

/** 视觉/多模态变体 token：base 模型（多数为 text-only）不能当它们的别名模板，
 *  否则会把 text-only 的 input 声明错写进视觉模型（如 deepseek-v4-flash-vision-exp
 *  被错配到 deepseek-v4-flash 后图片能力被锁死为纯文本）。 */
const VISION_VARIANT_TOKENS = new Set(["vision", "vl", "vlm", "multimodal", "image"]);

/** 模式/专用分支 token：`-thinking` 与 base 是不同解析模式的模型，别互相顶替。 */
const MODE_VARIANT_TOKENS = new Set(["thinking", "reasoning", "coder", "code", "math"]);

/** 官方 id 相对中转 id 多出来的纯装饰 token（`qwen2.5-vl-72b` → `Qwen/Qwen2.5-VL-72B-Instruct`）。 */
const DECORATION_TOKENS = new Set(["instruct", "chat", "base", "it", "hf", "gguf", "awq", "quantized", "fp8", "fp16", "int4", "int8"]);

function tokenize(key: string): string[] {
	return key.split("-").filter(Boolean);
}

function isIdentityBoundaryToken(token: string): boolean {
	return /^\d+$/.test(token) || MODEL_VARIANT_TOKENS.has(token) || VISION_VARIANT_TOKENS.has(token) || MODE_VARIANT_TOKENS.has(token);
}

/** 去除路径/网关命名空间后的字符长度，用于「最长家族优先 + 必须唯一」判定。 */
function aliasWeight(key: string): number {
	return key.length;
}

/**
 * 别名接受判定：目标与候选的家族 token 序列互为子串（双向）。
 *
 * 旧实现只允许「候选 ⊂ 目标」，于是中转给的简称（`qwen2.5-vl-72b`）永远匹配不上官方长名
 * （`qwen/qwen2.5-vl-72b-instruct`）；反向则只允许候选多出纯装饰 token。
 * 旧实现还要求候选含数字，`deepseek-chat`、`glm-4v` 这类家族直接失去别名能力。
 */
function aliasAccepts(targetKey: string, candidateKey: string): boolean {
	const target = tokenize(targetKey);
	const candidate = tokenize(candidateKey);
	if (!candidate.length || !target.length) return false;
	if (candidateKey.length < 5) return false;
	// 单个 token 且不含数字的家族（`chat`、`pro`）太泛，不参与别名
	if (candidate.length < 2 && !candidate.some((token) => /\d/.test(token))) return false;

	// 候选 ⊂ 目标：整段连续出现，且紧随其后的 token 不能是版本号/身份变体
	for (let start = 0; start + candidate.length <= target.length; start++) {
		if (!candidate.every((token, index) => target[start + index] === token)) continue;
		const next = target[start + candidate.length];
		if (next && isIdentityBoundaryToken(next)) continue;
		return true;
	}

	// 目标 ⊂ 候选：官方长名里的装饰 token 允许，身份变体/版本号仍然拒绝
	for (let start = 0; start + target.length <= candidate.length; start++) {
		if (!target.every((token, index) => candidate[start + index] === token)) continue;
		const extra = [...candidate.slice(0, start), ...candidate.slice(start + target.length)];
		const decorationsOnly = extra.every((token) => DECORATION_TOKENS.has(token) || SERVICE_TIER_TOKENS.has(token));
		if (decorationsOnly && extra.length > 0) return true;
	}
	return false;
}

function uniqueCandidates(candidates: readonly ModelCapabilityCandidate[]): ModelCapabilityCandidate[] {
	const seen = new Set<string>();
	return candidates.filter((candidate) => {
		const key = `${candidate.source}\u0000${candidate.provider}\u0000${candidate.id}`;
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});
}

/**
 * Resolve the model's canonical capability template from the official catalog.
 *
 * 顺序：
 * 1. 同 provider 精确 id（内置 provider 直接命中）；
 * 2. 家族键相等（剥厂商命名空间与服务档位；跨 provider 取家族代表）；
 * 3. 名称/别名（双向 token 包含，最长家族必须唯一）。
 * 不做全局子串模糊匹配：命不中就返回 undefined，让调用方留空而不是猜。
 */
export function findModelCapabilityMatch(input: ModelCapabilityLookupInput, rawCandidates: readonly ModelCapabilityCandidate[]): ModelCapabilityMatch | undefined {
	const modelId = input.modelId.trim();
	if (!modelId) return undefined;
	const candidates = uniqueCandidates(rawCandidates.filter((candidate) => candidate.id.trim()));

	const providerMatches = candidates.filter((candidate) => candidate.provider === input.providerName && sameIdentity(candidate.id, modelId));
	const providerMatch = choosePreferred(providerMatches);
	if (providerMatch) return { candidate: providerMatch, matchKind: "provider-id" };

	const idFamilyKey = modelFamilyKey(modelId);
	const nameFamilyKey = input.modelName ? modelFamilyKey(input.modelName) : "";
	const targetFamilies = new Set([idFamilyKey, nameFamilyKey].filter(Boolean));
	const familyMatches = candidates.filter((candidate) => targetFamilies.has(modelFamilyKey(candidate.id)) || sameIdentity(candidate.id, modelId));
	if (familyMatches.length > 0) {
		const representative = chooseFamilyRepresentative(familyMatches);
		if (modelFamilyKey(representative.id) === idFamilyKey || sameIdentity(representative.id, modelId)) {
			const usesTail = !identityVariants(modelId).includes(normalizeModelIdentity(representative.id));
			return { candidate: representative, matchKind: usesTail ? "id-tail" : "model-id" };
		}
		return { candidate: representative, matchKind: "name-alias" };
	}

	const targetVariants = [...identityVariants(modelId), ...identityVariants(input.modelName)];
	const aliasesByFamily = new Map<string, ModelCapabilityCandidate[]>();
	for (const candidate of candidates) {
		const familyKey = modelFamilyKey(candidate.id);
		if (!targetVariants.some((target) => aliasAccepts(target, familyKey))) continue;
		const group = aliasesByFamily.get(familyKey);
		if (group) group.push(candidate);
		else aliasesByFamily.set(familyKey, [candidate]);
	}
	if (aliasesByFamily.size === 0) return undefined;

	// 取最长家族；并列说明无法判断（alpha-1 / beta-22 之类），宁可不匹配
	const longest = Math.max(...[...aliasesByFamily.keys()].map(aliasWeight));
	const winners = [...aliasesByFamily.keys()].filter((key) => aliasWeight(key) === longest);
	if (winners.length !== 1) return undefined;
	return { candidate: chooseFamilyRepresentative(aliasesByFamily.get(winners[0]) ?? []), matchKind: "name-alias" };
}

/** Convert a trusted candidate to a patch-only model specification. */
export function modelCapabilityMatchToSpec(match: ModelCapabilityMatch): ModelSpec {
	const { candidate } = match;
	const contextWindow = plausibleContextWindow(candidate.contextWindow);
	const maxTokens = plausibleMaxTokens(candidate.maxTokens, contextWindow);
	return {
		...(contextWindow !== undefined ? { contextWindow } : {}),
		...(maxTokens !== undefined ? { maxTokens } : {}),
		...(candidate.reasoning !== undefined ? { reasoning: candidate.reasoning } : {}),
		...(candidate.input ? { input: [...candidate.input] } : {}),
		...(candidate.input ? { images: candidate.input.includes("image") } : {}),
		...(candidate.thinkingLevelMap ? { thinkingLevelMap: { ...candidate.thinkingLevelMap } } : {}),
		source: candidate.source,
		matchKind: match.matchKind,
		matchedId: candidate.id,
	};
}
