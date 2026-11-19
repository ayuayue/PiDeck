/**
 * Remote provider model catalog v1 (Phase 5 row 819): host-executed, masked and closed-code.
 *
 * Configuration uses the host's pi --list-models catalog, without requiring a project or live session.
 * Legacy runtime probes share the same DTO. Main masks both to this allowlist before
 * it leaves the process: no apiKey/baseUrl/raw runtime payload and no agentId is ever part of the DTO.
 *
 * The per-provider synthetic HTTP connection probe is NOT part of v1 (its request templates can carry
 * arbitrary URLs/headers); catalog refresh is separate from provider connection testing.
 */

/** Closed code set for remote model probe answers. */
export const REMOTE_MODEL_PROBE_CODES = {
	/** renderer-supplied hostId is not a host-id shape (zero main work is done). */
	targetInvalid: "REMOTE_MODEL_PROBE_TARGET_INVALID",
	/** the host has no enrolled remote project, so there is nowhere a runtime could live. */
	noProject: "REMOTE_MODEL_PROBE_NO_PROJECT",
	/** projects exist but no live remote agent runtime; user must open a remote session first. */
	noRuntime: "REMOTE_MODEL_PROBE_NO_RUNTIME",
	/** probe service/feature gate not assembled, or host project lookup unavailable. */
	unavailable: "REMOTE_MODEL_PROBE_UNAVAILABLE",
	/** the live runtime request failed (RPC error/timeout/malformed answer). */
	failed: "REMOTE_MODEL_PROBE_FAILED",
	/** the live runtime answered successfully with an empty catalog. */
	empty: "REMOTE_MODEL_PROBE_EMPTY",
} as const;
export type RemoteModelProbeCode = (typeof REMOTE_MODEL_PROBE_CODES)[keyof typeof REMOTE_MODEL_PROBE_CODES];
/** Closed-code set helper (source-contract tests pin renderer branching to exactly these values). */
export const REMOTE_MODEL_PROBE_CODE_SET: ReadonlySet<string> = new Set(Object.values(REMOTE_MODEL_PROBE_CODES));

/**
 * One masked catalog row. Structurally this contains only the documented model-picker fields; anything else
 * the runtime reports (keys, base URLs, thinking maps, raw provider config) is dropped by main's allowlist.
 */
export type RemoteModelCatalogEntry = {
	id: string;
	provider: string;
	name?: string;
	contextWindow?: number;
	maxTokens?: number;
	reasoning?: boolean;
	input?: Array<"text" | "image">;
	images?: boolean;
};

/** hostId comes from the target selector; it is the only renderer-supplied value a probe call may contain. */
export type RemoteModelProbeResult = { ok: true; hostId: string; models: RemoteModelCatalogEntry[]; providers: string[]; count: number; at: number } | { ok: false; code: RemoteModelProbeCode };

/** Max rows returned to the renderer even if the runtime reports more (deterministic truncation). */
export const REMOTE_MODEL_PROBE_MAX_MODELS = 1000;
/** Single bounded attempt; no automatic retry on any failure. */
export const REMOTE_MODEL_PROBE_TIMEOUT_MS = 60_000;
