/**
 * Select certificate signing before electron-builder packs either macOS channel.
 * Keep the explicit ad-hoc fallback for machines without certificates (#347),
 * but do not let that fallback mask CSC_LINK / CSC_NAME on signing machines.
 */
function configureMacSigning(context, { env = process.env } = {}) {
	if (context.electronPlatformName !== "darwin") return;
	const options = context.packager.platformSpecificBuildOptions;
	const configured = (value) => typeof value === "string" && value.trim() !== "";
	const explicitIdentity = configured(options.identity) && options.identity !== "-";
	const certificateRequested = explicitIdentity || [env.CSC_LINK, env.CSC_NAME, options.cscLink, context.packager.config.cscLink].some(configured);
	if (!certificateRequested) return;
	if (options.identity === null) throw new Error("mac.identity is null: certificate signing was requested but explicitly disabled");

	// Undefined lets electron-builder select the imported certificate / CSC_NAME.
	// Keeping '-' here always selects ad-hoc, even when a certificate is available.
	if (options.identity === "-") delete options.identity;
	options.type = "distribution";
	options.forceCodeSigning = true;
}

exports.default = configureMacSigning;
