import type { ConfigTab } from "../configTypes";
import type { ConfigSection } from "./configModalStorage";

type ReloadConfigSectionOptions = {
	section: ConfigSection;
	tab: ConfigTab;
	resetDrafts: () => void;
	setAddingProvider: (value: false) => void;
	setEditingProvider: (value: null) => void;
	setEditingGlobalSkill: (value: null) => void;
	setEditingPrompt: (value: null) => void;
	clearDirty: (key: string) => void;
	refreshSkills: () => Promise<void>;
	refreshPrompts: () => Promise<void>;
	refreshExtensions: (force: boolean) => Promise<void>;
	loadConfig: (tab: ConfigTab, options: { force: true }) => Promise<void>;
};

/** Explicit reload resets editors and resource drafts before refreshing the active section. */
export async function reloadConfigSection(options: ReloadConfigSectionOptions): Promise<void> {
	options.resetDrafts();
	options.setAddingProvider(false);
	options.setEditingProvider(null);
	options.setEditingGlobalSkill(null);
	options.setEditingPrompt(null);
	options.clearDirty("skills");
	options.clearDirty("prompts");
	if (options.section === "skills") return options.refreshSkills();
	if (options.section === "prompts") return options.refreshPrompts();
	if (options.section === "extensions") return options.refreshExtensions(true);
	return options.loadConfig(options.tab, { force: true });
}
