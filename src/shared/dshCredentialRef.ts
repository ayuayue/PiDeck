/**
 * DSH provider API key credential reference derivation.
 *
 * Normal provider names use the same conventional spelling as dsh-web
 * (`<ROUTE>_API_KEY`). Names may also contain Unicode or other characters;
 * those routes receive a stable, valid PiDeck-owned reference instead of an
 * invalid environment-variable name.
 */

const PROVIDER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
const CREDENTIAL_REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function stableRouteDigest(value: string): string {
	let hash = 2166136261;
	for (const character of value) {
		hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 16777619);
	}
	return (hash >>> 0).toString(16).toUpperCase().padStart(8, "0");
}

/** From provider profile and route id derive the credential reference DSH stores. */
export function credentialRefFor(profile: { apiKeyEnv?: unknown } | undefined, routeId: string): string {
	const explicit = typeof profile?.apiKeyEnv === "string" && profile.apiKeyEnv.trim() ? profile.apiKeyEnv.trim() : "";
	if (explicit) return explicit;

	if (PROVIDER_NAME_PATTERN.test(routeId)) {
		const conventional = `${routeId.toUpperCase().replaceAll("-", "_")}_API_KEY`;
		if (CREDENTIAL_REF_PATTERN.test(conventional)) return conventional;
	}

	// Keep old non-ASCII/special provider names usable without colliding on a
	// lossy replacement such as `_API_KEY`.
	return `PIDECK_${stableRouteDigest(routeId)}_API_KEY`;
}
