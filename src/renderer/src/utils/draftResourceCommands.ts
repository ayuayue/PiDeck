import type { PiCommand } from "../../../shared/types";

type DraftSkill = {
	name: string;
	description: string;
	enabled: boolean;
	sourceId?: string;
};

type DraftPrompt = {
	name: string;
	description: string;
	enabled?: boolean;
	scope?: "global" | "project";
	sourceId?: string;
};

type DraftResourceOptions = {
	projectResourcesAllowed: boolean;
	disabledGlobalSkillKeys?: string[];
	disabledGlobalPromptNames?: string[];
};

export type DraftResourceCommandSnapshot = {
	projectId: string | undefined;
	commands: PiCommand[];
};

/** Prevents commands discovered for the previously selected project from leaking during a switch. */
export function draftResourceCommandsForProject(snapshot: DraftResourceCommandSnapshot, projectId: string | undefined): PiCommand[] {
	return snapshot.projectId === projectId ? snapshot.commands : [];
}

export function selectComposerSuggestionCommands(isDshBackend: boolean, runtimeStarted: boolean, runtimeCommands: PiCommand[], draftCommands: PiCommand[]): PiCommand[] {
	return isDshBackend || runtimeStarted ? runtimeCommands : draftCommands;
}

/** Maps Pi-discoverable local resources to the slash names Pi exposes before an agent starts. */
export function buildDraftResourceCommands(skills: DraftSkill[], prompts: DraftPrompt[], options: DraftResourceOptions): PiCommand[] {
	const disabledGlobalSkillKeys = new Set((options.disabledGlobalSkillKeys ?? []).map((key) => key.toLowerCase()));
	const disabledGlobalPromptNames = new Set((options.disabledGlobalPromptNames ?? []).map((name) => name.toLowerCase()));
	const commands = new Map<string, { command: PiCommand; priority: number }>();
	const addCommand = (command: PiCommand, priority: number) => {
		const existing = commands.get(command.name);
		if (!existing || priority < existing.priority) commands.set(command.name, { command, priority });
	};
	for (const skill of skills) {
		if (!skill.enabled) continue;
		const projectScoped = isProjectSkillSource(skill.sourceId);
		if (projectScoped && !options.projectResourcesAllowed) continue;
		const globalKey = globalSkillKey(skill.sourceId, skill.name);
		if (globalKey && disabledGlobalSkillKeys.has(globalKey)) continue;
		const command: PiCommand = { name: `skill:${skill.name}`, description: skill.description, source: "skill" };
		addCommand(command, skillSourcePriority(skill.sourceId));
	}
	for (const prompt of prompts) {
		if (prompt.enabled === false) continue;
		const projectScoped = prompt.scope === "project" || isProjectSkillSource(prompt.sourceId);
		if (projectScoped && !options.projectResourcesAllowed) continue;
		const globalSource = prompt.scope === "global" || prompt.sourceId === "settings-user" || prompt.sourceId === "package-user";
		if (globalSource && disabledGlobalPromptNames.has(prompt.name.toLowerCase())) continue;
		const command: PiCommand = { name: prompt.name, description: prompt.description, source: "prompt" };
		addCommand(command, promptSourcePriority(prompt));
	}
	return [...commands.values()].map(({ command }) => command);
}

function isProjectSkillSource(sourceId?: string): boolean {
	return sourceId === "project-pi" || sourceId === "project-agents" || sourceId === "settings-project" || sourceId === "package-project" || sourceId === "ancestor-agents";
}

/** Mirrors Pi's resourcePrecedenceRank; exact-name collisions keep the highest-priority source. */
function skillSourcePriority(sourceId?: string): number {
	if (sourceId === "settings-project") return 0;
	if (sourceId === "project-pi" || sourceId === "project-agents" || sourceId === "ancestor-agents") return 1;
	if (sourceId === "settings-user") return 2;
	if (sourceId === "pi-global" || sourceId === "agents-global") return 3;
	if (sourceId === "package-project" || sourceId === "package-user") return 4;
	return 5;
}

function promptSourcePriority(prompt: DraftPrompt): number {
	if (prompt.sourceId === "settings-project") return 0;
	if (prompt.sourceId === "package-project" || prompt.sourceId === "package-user") return 4;
	if (prompt.scope === "project") return 1;
	if (prompt.sourceId === "settings-user") return 2;
	if (prompt.scope === "global") return 3;
	return 5;
}

function globalSkillKey(sourceId: string | undefined, name: string): string | undefined {
	if (sourceId === "pi-global" || sourceId === "agents-global") return `${sourceId}:${name.toLowerCase()}`;
	return undefined;
}
