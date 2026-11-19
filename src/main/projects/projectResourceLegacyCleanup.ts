export type ProjectResourceLegacyCleanupPatch = {
	extensions?: boolean;
	skills?: boolean;
	prompts?: boolean;
	inherited?: boolean;
};

export function clearProjectResourceLegacyFields(settings: Record<string, unknown>, patch: ProjectResourceLegacyCleanupPatch): void {
	const keys = [patch.extensions && "disabledExtensions", patch.skills && "disabledSkills", patch.prompts && "disabledPrompts", patch.inherited && "pideckDisabledGlobalExtensions", patch.inherited && "pideckDisabledGlobalSkills", patch.inherited && "pideckDisabledGlobalPrompts"].filter((key): key is string =>
		Boolean(key),
	);
	for (const key of keys) delete settings[key];
}
