import type { LegacyDisabledState, MigrationPlan } from "./piResourceMigration";
import type { ResourceMigrationRecord } from "./PiResourceStateStore";

type LegacyInput = { kind: "extension" | "skill" | "prompt"; name: string; scope: "global" | "project"; key: string; unsupportedScope?: boolean };

function inputKey(kind: LegacyInput["kind"], name: string, scope: LegacyInput["scope"], origin = "disabled", extensionScope = ""): string {
	return JSON.stringify([scope, origin, kind, extensionScope, kind === "extension" || origin === "inherited" ? name.trim() : name.trim().toLowerCase()]);
}

/** 旧输入身份与原生路径分开：资源重装/用户修改原生开关后，已处理的旧意图不能再次重放。 */
function inputsOf(legacy: LegacyDisabledState): LegacyInput[] {
	const inputs: LegacyInput[] = [];
	const add = (kind: LegacyInput["kind"], names: readonly string[], scope: LegacyInput["scope"], origin = "disabled") => {
		for (const name of names) inputs.push({ kind, name, scope, key: inputKey(kind, name, scope, origin) });
	};
	for (const entry of legacy.global.disabledExtensions) inputs.push({ kind: "extension", name: entry.source, scope: "global", key: inputKey("extension", entry.source, "global", "disabled", entry.scope), unsupportedScope: entry.scope !== "user" });
	add("skill", legacy.global.disabledSkills, "global");
	add("prompt", legacy.global.disabledPrompts, "global");
	add("extension", legacy.project.disabledExtensions, "project");
	add("skill", legacy.project.disabledSkills, "project");
	add("prompt", legacy.project.disabledPrompts, "project");
	add("extension", legacy.project.inheritedExtensions, "project", "inherited");
	add("skill", legacy.project.inheritedSkills, "project", "inherited");
	add("prompt", legacy.project.inheritedPrompts, "project", "inherited");
	return inputs;
}

/** 旧标记在所有原生写入成功后生成；仅未解析的输入需要再映射，其余只补旧字段清理。 */
export function completedMigrationInputs(legacy: LegacyDisabledState, record?: ResourceMigrationRecord): Set<string> {
	const completed = new Set(record?.completedInputs ?? []);
	if (record && record.cleanupCompleted === undefined && Array.isArray(record.unresolved)) {
		for (const input of inputsOf(legacy)) {
			if (!input.unsupportedScope && !record.unresolved.some((entry) => entry.startsWith(`${input.kind} ${input.name} (${input.scope}):`))) completed.add(input.key);
		}
	}
	return completed;
}

/** 规划时移除已完成输入，cleanup 仍使用完整的旧记录。 */
export function pendingMigrationLegacy(legacy: LegacyDisabledState, completed: ReadonlySet<string>): LegacyDisabledState {
	const filter = (kind: LegacyInput["kind"], names: readonly string[], scope: LegacyInput["scope"], origin = "disabled") => names.filter((name) => !completed.has(inputKey(kind, name, scope, origin)));
	return {
		global: {
			...legacy.global,
			disabledExtensions: legacy.global.disabledExtensions.filter((entry) => !completed.has(inputKey("extension", entry.source, "global", "disabled", entry.scope))),
			disabledSkills: filter("skill", legacy.global.disabledSkills, "global"),
			disabledPrompts: filter("prompt", legacy.global.disabledPrompts, "global"),
		},
		project: {
			disabledExtensions: filter("extension", legacy.project.disabledExtensions, "project"),
			disabledSkills: filter("skill", legacy.project.disabledSkills, "project"),
			disabledPrompts: filter("prompt", legacy.project.disabledPrompts, "project"),
			inheritedExtensions: filter("extension", legacy.project.inheritedExtensions, "project", "inherited"),
			inheritedSkills: filter("skill", legacy.project.inheritedSkills, "project", "inherited"),
			inheritedPrompts: filter("prompt", legacy.project.inheritedPrompts, "project", "inherited"),
		},
	};
}

/** 没有写入失败时，将本次已完整映射的输入加入进度。 */
export function markResolvedMigrationInputs(legacy: LegacyDisabledState, plan: MigrationPlan, completed: Set<string>): void {
	for (const input of inputsOf(legacy)) {
		if (!plan.unresolved.some((item) => item.kind === input.kind && item.scope === input.scope && item.name.trim().toLowerCase() === input.name.trim().toLowerCase())) completed.add(input.key);
	}
}
