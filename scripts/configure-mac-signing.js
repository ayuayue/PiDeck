const { resolveMacIdentityPolicy, validateMacIdentityPolicy, validateMacNotarization } = require("./mac-signing-policy.js");

/**
 * Select certificate signing before electron-builder packs either macOS channel.
 * Keep the explicit ad-hoc fallback for machines without certificates (#347),
 * but do not let that fallback mask CSC_LINK / CSC_NAME on signing machines.
 */
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
	const policy = resolveMacIdentityPolicy(env);
	if (options.identity === null && (certificateRequested || policy.requireCertificate)) throw new Error("mac.identity is null: certificate signing was requested but explicitly disabled");
	if (policy.requireCertificate && !certificateRequested) throw new Error("macOS 正式发布需要 Developer ID 证书：请配置 CSC_LINK 或 CSC_NAME");
	validateMacIdentityPolicy(policy);
	validateMacNotarization(policy, env);
	if (!certificateRequested) return;

	// Undefined lets electron-builder select the imported certificate / CSC_NAME.
	// Keeping '-' here always selects ad-hoc, even when a certificate is available.
	if (options.identity === "-") delete options.identity;
	options.type = "distribution";
	options.forceCodeSigning = true;
	if (policy.requireNotarization) options.notarize = true;
}

exports.default = configureMacSigning;
