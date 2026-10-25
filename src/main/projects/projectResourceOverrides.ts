import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectInheritedResourceToggleInput, ProjectResourceOverrides } from "../../shared/types";

const OVERRIDE_FIELDS = {
	extension: "pideckDisabledGlobalExtensions",
	skill: "pideckDisabledGlobalSkills",
	prompt: "pideckDisabledGlobalPrompts",
} as const;

/** pi 原生 settings.json 里各类资源的数组字段名。 */
const NATIVE_FIELDS = { extension: "extensions", skill: "skills", prompt: "prompts" } as const;
/** 历史缺陷写入的身份键形态（`pi-global:<名>`）：pi 不认这种值，读回时必须忽略而不是当成已停用。 */
const LEGACY_KEY_PREFIX = /^(?:pi-global|agents-global):/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown, normalize: (entry: string) => string = (entry) => entry): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry !== "string") continue;
		const normalized = normalize(entry.trim());
		if (normalized) seen.add(normalized);
	}
	return [...seen];
}

/**
 * 从 pi 原生数组解析「本层停用的继承资源」：精确 `-<值>` 规则即停用。
 * 忽略历史缺陷写入的身份键形态（pi 不认，实际并未停用）。
 */
function nativeDisabledValues(settings: Record<string, unknown>, kind: keyof typeof NATIVE_FIELDS, normalize: (entry: string) => string): string[] {
	const raw = settings[NATIVE_FIELDS[kind]];
	const entries = Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === "string") : [];
	const disabled = new Set<string>();
	for (const entry of entries) {
		if (typeof entry !== "string") continue;
		const value = entry.trim();
		if (!value.startsWith("-") || LEGACY_KEY_PREFIX.test(value.slice(1))) continue;
		const target = normalize(value.slice(1).trim());
		if (target) disabled.add(target);
	}
	return [...disabled];
}

function overridesFromRecord(settings: Record<string, unknown>): ProjectResourceOverrides {
	return {
		// 原生精确规则优先；pideckDisabledGlobal* 是原生规则改造前的私有字段，仅未迁移旧文件还有，读出来兑底。
		disabledGlobalExtensions: [...nativeDisabledValues(settings, "extension", (entry) => entry), ...stringArray(settings[OVERRIDE_FIELDS.extension])],
		disabledGlobalSkills: [...nativeDisabledValues(settings, "skill", (entry) => entry.toLowerCase()), ...stringArray(settings[OVERRIDE_FIELDS.skill], (entry) => entry.toLowerCase())],
		disabledGlobalPrompts: [...nativeDisabledValues(settings, "prompt", (entry) => entry.toLowerCase()), ...stringArray(settings[OVERRIDE_FIELDS.prompt], (entry) => entry.toLowerCase())],
	};
}

export function projectResourceOverridesFromRecord(settings: Record<string, unknown>): ProjectResourceOverrides {
	return overridesFromRecord(settings);
}

export function emptyProjectResourceOverrides(): ProjectResourceOverrides {
	return {
		disabledGlobalExtensions: [],
		disabledGlobalSkills: [],
		disabledGlobalPrompts: [],
	};
}

/** Reads PiDeck-only project overrides without treating malformed pi settings as trusted data. */
export function readProjectResourceOverrides(projectRoot: string): ProjectResourceOverrides {
	try {
		const parsed: unknown = JSON.parse(readFileSync(join(projectRoot, ".pi", "settings.json"), "utf8"));
		if (!isRecord(parsed)) return emptyProjectResourceOverrides();
		return overridesFromRecord(parsed);
	} catch {
		return emptyProjectResourceOverrides();
	}
}

/** Persists one inherited-resource override while preserving every unrelated pi setting. */
export async function setProjectInheritedResourceEnabled(settingsFile: string, kind: ProjectInheritedResourceToggleInput["kind"], key: string, enabled: boolean, invalidJsonMessage: string): Promise<ProjectResourceOverrides> {
	let settings: Record<string, unknown> = {};
	if (existsSync(settingsFile)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(await readFile(settingsFile, "utf8"));
		} catch {
			throw new Error(invalidJsonMessage);
		}
		if (!isRecord(parsed)) throw new Error(invalidJsonMessage);
		settings = parsed;
	}

	const field = OVERRIDE_FIELDS[kind];
	const normalize = kind === "extension" ? (entry: string) => entry : (entry: string) => entry.toLowerCase();
	const current = stringArray(settings[field], normalize);
	const next = current.filter((entry) => entry !== key);
	if (!enabled) next.push(key);
	settings[field] = next;
	await mkdir(dirname(settingsFile), { recursive: true });
	await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
	return overridesFromRecord(settings);
}
