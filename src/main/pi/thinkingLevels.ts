/**
 * Parse Pi RPC's model-specific thinking levels.
 *
 * Pi 0.81.0 introduced the capability through get_available_thinking_levels. Older
 * Pi versions answer with an unknown-command error; returning undefined keeps
 * the picker on its legacy static list instead of breaking the session UI.
 */
export type ThinkingLevelsRpcResponseLike = {
	success: boolean;
	data?: unknown;
	error?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whether an unsuccessful response means that the optional RPC is unavailable. */
export function isUnsupportedThinkingLevelsRpcError(error: string | undefined): boolean {
	if (!error) return false;
	return /unknown\s+(?:rpc\s+)?command|unsupported\s+(?:rpc\s+)?command|unrecognized\s+(?:rpc\s+)?command|not implemented/i.test(error);
}

/**
 * Convert a successful Pi response into a validated, de-duplicated level list.
 * `undefined` means "capability unavailable or malformed" and deliberately
 * differs from `[]`, which is a valid authoritative response.
 */
export function parseAvailableThinkingLevelsResponse(response: ThinkingLevelsRpcResponseLike): string[] | undefined {
	if (!response.success) {
		if (isUnsupportedThinkingLevelsRpcError(response.error)) return undefined;
		throw new Error(response.error || "get_available_thinking_levels failed");
	}

	if (!isRecord(response.data) || !Array.isArray(response.data.levels)) return undefined;
	const levels = response.data.levels;
	if (!levels.every((level): level is string => typeof level === "string")) return undefined;

	const normalized: string[] = [];
	const seen = new Set<string>();
	for (const level of levels) {
		const value = level.trim();
		if (!value || seen.has(value)) continue;
		seen.add(value);
		normalized.push(value);
	}
	return normalized;
}
