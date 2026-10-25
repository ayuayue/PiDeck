import type { SessionModelPreference } from "./types/session";

/**
 * Resolve PiDeck's model display label from a configured/selected name.
 *
 * A blank or absent name is not a distinct display value: model id is the stable fallback.
 * Keep this in shared code so main-process persistence and renderer labels cannot diverge.
 */
export function resolveModelDisplayName(name: unknown, modelId: string): string {
	return typeof name === "string" && name.trim() ? name.trim() : modelId;
}

export type NormalizedSessionModelPreference = SessionModelPreference & {
	modelName: string;
};

/** Build the complete model-selection snapshot persisted on new SessionRecord writes. */
export function createSessionModelPreference(provider: string, modelId: string, modelName: unknown): NormalizedSessionModelPreference {
	return {
		provider,
		modelId,
		modelName: resolveModelDisplayName(modelName, modelId),
	};
}
