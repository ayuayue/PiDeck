/**
 * Select certificate signing before electron-builder packs either macOS channel.
 * Keep the explicit ad-hoc fallback for local builds without certificates (#347).
 * Published stable/dev builds must use a pinned Developer ID identity so updates
 * do not invalidate the user's existing TCC grants.
 */
/** Resolve the same release policy for the packaging hook and artifact verifier. */
function getMacSigningPolicy(env) {
	const releaseBuild = env.PIDECK_RELEASE_BUILD === "1";
	const expectedTeamId = env.PIDECK_MAC_TEAM_ID?.trim() || null;
	return {
		releaseBuild,
		expectedTeamId,
		requireDeveloperId: releaseBuild || /^(true|1)$/i.test(env.PIDECK_MAC_REQUIRE_DEVELOPER_ID ?? "") || Boolean(expectedTeamId),
	};
}

/**
 * electron-builder's getCscLink() treats an *empty string* CSC_LINK as a configured link
 * (its comment: "allow to specify as empty string"), then resolves it against projectDir
 * and dies with `<projectPath> not a file`. Workflows that unconditionally export
 * `CSC_LINK: ''` for the non-signing case therefore break every unsigned macOS build.
 * Drop blank credentials before electron-builder reads them.
 */
function dropBlankCredentials(env) {
	for (const name of ["CSC_LINK", "CSC_KEY_PASSWORD", "CSC_NAME"]) {
		if (typeof env[name] === "string" && env[name].trim() === "") delete env[name];
	}
}

function configureMacSigning(context, { env = process.env } = {}) {
	if (context.electronPlatformName !== "darwin") return;
	dropBlankCredentials(env);
	const options = context.packager.platformSpecificBuildOptions;
	const configured = (value) => typeof value === "string" && value.trim() !== "";
	const explicitIdentity = configured(options.identity) && options.identity !== "-";
	const certificateRequested = explicitIdentity || [env.CSC_LINK, env.CSC_NAME, options.cscLink, context.packager.config.cscLink].some(configured);
	const { releaseBuild, requireDeveloperId, expectedTeamId } = getMacSigningPolicy(env);
	if (options.identity === null && (certificateRequested || requireDeveloperId)) throw new Error("mac.identity is null: certificate signing was requested but explicitly disabled");
	if (requireDeveloperId && !certificateRequested) throw new Error("macOS release signing requires Developer ID Application: configure MAC_CSC_LINK / MAC_CSC_NAME; ad-hoc updates invalidate TCC grants (docs/release-process.md)");
	if ((releaseBuild && !expectedTeamId) || (expectedTeamId && !/^[A-Z0-9]{10}$/.test(expectedTeamId))) throw new Error("PIDECK_MAC_TEAM_ID must pin the 10-character Developer ID team for macOS releases (Actions variable MAC_TEAM_ID)");
	if (!certificateRequested) return;

	// Undefined lets electron-builder select the imported certificate / CSC_NAME.
	// Keeping '-' here always selects ad-hoc, even when a certificate is available.
	if (options.identity === "-") delete options.identity;
	options.type = "distribution";
	options.forceCodeSigning = true;
}

exports.default = configureMacSigning;
exports.getMacSigningPolicy = getMacSigningPolicy;
