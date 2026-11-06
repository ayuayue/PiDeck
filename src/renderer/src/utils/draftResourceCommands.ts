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

export type StandbyPreviewCommandSnapshot = {
	projectId: string | undefined;
	commands: PiCommand[];
};

/** 同 draftResourceCommandsForProject 口径：项目切换瞬间丢弃旧项目的 standby 预览，防串项目。 */
export function standbyPreviewCommandsForProject(snapshot: StandbyPreviewCommandSnapshot, projectId: string | undefined): PiCommand[] {
	return snapshot.projectId === projectId ? snapshot.commands : [];
}

/**
 * 草稿会话的斜杠建议来源优先级：DSH/已起 runtime → 本会话 RPC 表（唯一权威）；
 * draft 无 runtime 时优先 standby 进程预览（含扩展命令，Issue #316），
 * 拿不到预览（池关/无进程/查询失败）才回退本地技能/提示词发现。
 * 预览不与本地发现合并——合并需要按命令名/优先级消歧，而两条来源的
 * 同名命令描述可能不一致；直接取更接近 pi 真实命令表的那份。
 */
export function selectComposerSuggestionCommands(isDshBackend: boolean, runtimeStarted: boolean, runtimeCommands: PiCommand[], draftCommands: PiCommand[], standbyPreviewCommands?: PiCommand[]): PiCommand[] {
	if (isDshBackend || runtimeStarted) return runtimeCommands;
	return standbyPreviewCommands?.length ? standbyPreviewCommands : draftCommands;
}

/**
 * DSH 的技能不进 host 命令表，而是在发送后由 `tool-skill` 识别裸 `/名称` 手势；
 * 因此 `/` 菜单要按同名命令补上技能，否则只能从鼠标选择器看到它们。
 * 命令（host/live 或桌面静态建议）先占位：同名时命令会抢先执行，不能再建议一个被遮蔽的技能。
 */
export function mergeDshSkillCommands(commands: PiCommand[], skills: ReadonlyArray<{ name: string; description?: string }>): PiCommand[] {
	const taken = new Set(commands.map((command) => command.name.toLowerCase()));
	const merged = [...commands];
	for (const skill of skills) {
		const name = skill.name.trim();
		const key = name.toLowerCase();
		if (!name || taken.has(key)) continue;
		taken.add(key);
		merged.push({ name, ...(skill.description ? { description: skill.description } : {}), source: "skill" });
	}
	return merged;
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
	if (sourceId === "pi-global" || sourceId === "agents-global" || sourceId === "pideck-global") return 3;
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
	if (sourceId === "pi-global" || sourceId === "agents-global" || sourceId === "pideck-global") return `${sourceId}:${name.toLowerCase()}`;
	return undefined;
}
