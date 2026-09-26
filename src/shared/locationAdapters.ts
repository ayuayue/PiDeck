import type { LegacyProjectLocationFields, ProjectLocation, ProjectLocator } from "./types/project";
import type { LegacySessionLocationFields, SessionLocator } from "./types/session";

/** Converts the persisted v1 path/environment pair into the canonical local locator. */
export function projectLocatorFromLegacy(fields: LegacyProjectLocationFields & { wslDistro?: string }): ProjectLocator {
	return {
		kind: "local",
		environment: fields.environment === "wsl" ? "wsl" : "native",
		localPath: fields.path,
		...(fields.wslDistro ? { wslDistro: fields.wslDistro } : {}),
	};
}

/** Drops execution paths when a caller only needs to select a location target. */
export function projectLocationFromLocator(locator: ProjectLocator): ProjectLocation {
	if (locator.kind === "ssh") return { kind: "ssh", hostId: locator.hostId };
	return {
		kind: "local",
		environment: locator.environment,
		...(locator.wslDistro ? { wslDistro: locator.wslDistro } : {}),
	};
}

/** The legacy project shape exists only for local consumers during the migration. */
export function projectLocatorToLegacyFields(locator: ProjectLocator): LegacyProjectLocationFields | undefined {
	if (locator.kind !== "local") return undefined;
	return {
		path: locator.localPath,
		environment: locator.environment === "wsl" ? "wsl" : "windows",
		...(locator.wslDistro ? { wslDistro: locator.wslDistro } : {}),
	};
}

/** Converts old catalog location fields into the canonical local session locator. */
export function sessionLocatorFromLegacy(fields: LegacySessionLocationFields): SessionLocator {
	const environment = fields.environment === "wsl" || fields.wsl === true ? "wsl" : "native";
	return {
		kind: "local",
		environment,
		...(fields.filePath ? { filePath: fields.filePath } : {}),
		...(fields.wslDistro ? { wslDistro: fields.wslDistro } : {}),
		...(fields.wslUser ? { wslUser: fields.wslUser } : {}),
	};
}

/** Remote session identity must never be serialized as local path/environment authority. */
export function sessionLocatorToLegacyFields(locator: SessionLocator): LegacySessionLocationFields | undefined {
	if (locator.kind !== "local") return undefined;
	return {
		environment: locator.environment,
		...(locator.filePath ? { filePath: locator.filePath } : {}),
		...(locator.wslDistro ? { wslDistro: locator.wslDistro } : {}),
		...(locator.wslUser ? { wslUser: locator.wslUser } : {}),
		...(locator.environment === "wsl" ? { wsl: true } : {}),
	};
}
