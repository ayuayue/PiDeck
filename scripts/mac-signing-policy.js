/** Shared identity requirements for mac packaging and artifact verification. */
function resolveMacIdentityPolicy(env = process.env) {
	const release = env.PIDECK_RELEASE_BUILD === "1";
	const requireNotarization = release || env.PIDECK_MAC_REQUIRE_NOTARIZATION === "1";
	const teamId = env.PIDECK_MAC_TEAM_ID?.trim() || null;
	return {
		teamId,
		requirePinnedTeam: requireNotarization,
		requireNotarization,
		requireCertificate: requireNotarization || /^(true|1)$/i.test(env.PIDECK_MAC_REQUIRE_DEVELOPER_ID ?? "") || Boolean(teamId),
	};
}

/** Validate configured publisher identity before packing or trusting an artifact. */
function validateMacIdentityPolicy(policy) {
	if ((policy.requirePinnedTeam && !policy.teamId) || (policy.teamId && !/^[A-Z0-9]{10}$/.test(policy.teamId))) {
		throw new Error("macOS 发布需要固定的 10 位 Team ID：请配置 PIDECK_MAC_TEAM_ID（workflow 使用 MAC_TEAM_ID 或 APPLE_TEAM_ID）");
	}
}

/** The same notarization credential paths supported by electron-builder. */
function hasNotarizationCredentials(env) {
	const has = (name) => typeof env[name] === "string" && env[name].trim() !== "";
	return (has("APPLE_ID") && has("APPLE_APP_SPECIFIC_PASSWORD") && has("APPLE_TEAM_ID")) || (has("APPLE_API_KEY") && has("APPLE_API_KEY_ID") && has("APPLE_API_ISSUER")) || has("APPLE_KEYCHAIN_PROFILE");
}

/** A release must be notarized by the pinned publisher's team. */
function validateMacNotarization(policy, env) {
	if (!policy.requireNotarization) return;
	if (!hasNotarizationCredentials(env)) throw new Error("macOS 正式发布需要完整公证凭据：APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID，或 API key / keychain profile");
	if (env.APPLE_TEAM_ID?.trim() && policy.teamId && env.APPLE_TEAM_ID.trim() !== policy.teamId) throw new Error("APPLE_TEAM_ID 与固定的 PIDECK_MAC_TEAM_ID 不一致");
}

module.exports = { resolveMacIdentityPolicy, validateMacIdentityPolicy, hasNotarizationCredentials, validateMacNotarization };
