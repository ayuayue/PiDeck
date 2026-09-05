import type {
  ModelSpec,
  ModelSpecMatchKind,
  ThinkingLevelMap,
} from "../../shared/types/modelSpecs";

const THINKING_LEVEL_KEYS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

type ThinkingLevelKey = typeof THINKING_LEVEL_KEYS[number];

export type ModelCapabilitySource = "pi-ai" | "pi-runtime";

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

function sourcePriority(source: ModelCapabilitySource): number {
  // The installed Pi catalog reflects the executable that will execute requests;
  // pi-ai remains the deterministic fallback for older Pi and test/preview paths.
  return source === "pi-runtime" ? 2 : 1;
}

function completeness(candidate: ModelCapabilityCandidate): number {
  return Number(candidate.contextWindow !== undefined) +
    Number(candidate.maxTokens !== undefined) +
    Number(candidate.reasoning !== undefined) +
    Number(candidate.input !== undefined) +
    Number(candidate.thinkingLevelMap !== undefined);
}

function choosePreferred(candidates: readonly ModelCapabilityCandidate[]): ModelCapabilityCandidate | undefined {
  return [...candidates].sort((left, right) => {
    const sourceDiff = sourcePriority(right.source) - sourcePriority(left.source);
    if (sourceDiff) return sourceDiff;
    const completenessDiff = completeness(right) - completeness(left);
    if (completenessDiff) return completenessDiff;
    const providerDiff = left.provider.localeCompare(right.provider);
    if (providerDiff) return providerDiff;
    return left.id.localeCompare(right.id);
  })[0];
}

const MODEL_VARIANT_TOKENS = new Set([
  "mini",
  "nano",
  "pro",
  "turbo",
  "instruct",
  "preview",
  "latest",
]);

/** 视觉/多模态变体 token：base 模型（多数为 text-only）不能当它们的别名模板，
 *  否则会把 text-only 的 input 声明错写进视觉模型（如 deepseek-v4-flash-vision-exp
 *  被错配到 deepseek-v4-flash 后图片能力被锁死为纯文本）。 */
const VISION_VARIANT_TOKENS = new Set([
  "vision",
  "vl",
  "vlm",
  "multimodal",
  "image",
]);

function hasDelimitedIdentity(target: string, candidate: string): boolean {
  if (!candidate || candidate.length < 5 || !/\d/.test(candidate)) return false;
  const targetTokens = target.split("-");
  const candidateTokens = candidate.split("-");
  for (let start = 0; start <= targetTokens.length - candidateTokens.length; start++) {
    if (!candidateTokens.every((token, index) => targetTokens[start + index] === token)) continue;
    const suffix = targetTokens[start + candidateTokens.length];
    // `gpt-5` is not a safe template for `gpt-5.6`, nor is a base model a
    // safe stand-in for a known distinct variant such as `gpt-4o-mini`.
    // 视觉变体同理：base（text-only）→ vision/vl 变体的能力声明完全不同，
    // 但同族视觉变体之间（如 -vision-exp → -vision）仍允许继续匹配。
    if (
      suffix &&
      (/^\d+$/.test(suffix) || MODEL_VARIANT_TOKENS.has(suffix) || VISION_VARIANT_TOKENS.has(suffix))
    ) {
      continue;
    }
    return true;
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
 * Resolve the model's canonical capability template. Provider identity is preferred
 * when it is known, but a proxy can match any provider's exact canonical model id.
 * A display-name/alias match is accepted only when its longest boundary-delimited
 * candidate is unique, avoiding `gpt`/prefix guesses and ambiguous brand names.
 */
export function findModelCapabilityMatch(
  input: ModelCapabilityLookupInput,
  rawCandidates: readonly ModelCapabilityCandidate[],
): ModelCapabilityMatch | undefined {
  const modelId = input.modelId.trim();
  if (!modelId) return undefined;
  const candidates = uniqueCandidates(rawCandidates.filter((candidate) => candidate.id.trim()));
  const providerMatches = candidates.filter(
    (candidate) => candidate.provider === input.providerName && sameIdentity(candidate.id, modelId),
  );
  const providerMatch = choosePreferred(providerMatches);
  if (providerMatch) return { candidate: providerMatch, matchKind: "provider-id" };

  const exactMatches = candidates.filter((candidate) => sameIdentity(candidate.id, modelId));
  const exactMatch = choosePreferred(exactMatches);
  if (exactMatch) {
    const usesTail = !identityVariants(modelId).includes(normalizeModelIdentity(exactMatch.id));
    return { candidate: exactMatch, matchKind: usesTail ? "id-tail" : "model-id" };
  }

  const targetVariants = [...identityVariants(modelId), ...identityVariants(input.modelName)];
  const aliasMatches = candidates.filter((candidate) => {
    const candidateIdentity = normalizeModelIdentity(candidate.id);
    return targetVariants.some((target) => hasDelimitedIdentity(target, candidateIdentity));
  });
  if (aliasMatches.length === 0) return undefined;

  const longestIdentityLength = Math.max(
    ...aliasMatches.map((candidate) => normalizeModelIdentity(candidate.id).length),
  );
  const longestMatches = aliasMatches.filter(
    (candidate) => normalizeModelIdentity(candidate.id).length === longestIdentityLength,
  );
  const uniqueCanonicalIds = new Set(longestMatches.map((candidate) => normalizeModelIdentity(candidate.id)));
  if (uniqueCanonicalIds.size !== 1) return undefined;
  const aliasMatch = choosePreferred(longestMatches);
  return aliasMatch ? { candidate: aliasMatch, matchKind: "name-alias" } : undefined;
}

/** Convert a trusted candidate to a patch-only model specification. */
export function modelCapabilityMatchToSpec(match: ModelCapabilityMatch): ModelSpec {
  const { candidate } = match;
  return {
    ...(candidate.contextWindow !== undefined ? { contextWindow: candidate.contextWindow } : {}),
    ...(candidate.maxTokens !== undefined ? { maxTokens: candidate.maxTokens } : {}),
    ...(candidate.reasoning !== undefined ? { reasoning: candidate.reasoning } : {}),
    ...(candidate.input ? { input: [...candidate.input] } : {}),
    ...(candidate.input ? { images: candidate.input.includes("image") } : {}),
    ...(candidate.thinkingLevelMap ? { thinkingLevelMap: { ...candidate.thinkingLevelMap } } : {}),
    source: candidate.source,
    matchKind: match.matchKind,
    matchedId: candidate.id,
  };
}
