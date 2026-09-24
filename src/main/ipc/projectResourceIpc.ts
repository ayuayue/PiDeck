import { ipcMain, shell } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { CreateProjectSkillInput, ProjectInheritedResourceToggleInput, ProjectResourceDirectoryKind } from "../../shared/types";
import type { AppLogger } from "../logging/AppLogger";
import type { ProjectResourceManager } from "../projects/ProjectResourceManager";

export type ProjectResourceIpcDeps = {
	appLogger: Pick<AppLogger, "info">;
	projectResourceManager: ProjectResourceManager;
};

function nonEmptyString(value: unknown, maxLength = 4096): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function isCreateSkillInput(value: unknown): value is CreateProjectSkillInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	return (
		"projectId" in value &&
		nonEmptyString(value.projectId, 256) &&
		"name" in value &&
		nonEmptyString(value.name, 256) &&
		"description" in value &&
		typeof value.description === "string" &&
		value.description.length <= 4096 &&
		"locationId" in value &&
		(value.locationId === "project-pi" || value.locationId === "project-agents")
	);
}

function isInheritedToggleInput(value: unknown): value is ProjectInheritedResourceToggleInput {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	if (!("projectId" in value) || !("kind" in value) || !("key" in value) || !("enabled" in value)) {
		return false;
	}
	return nonEmptyString(value.projectId, 256) && (value.kind === "extension" || value.kind === "skill" || value.kind === "prompt") && nonEmptyString(value.key, 1024) && typeof value.enabled === "boolean";
}

function isProjectResourceDirectoryKind(value: unknown): value is ProjectResourceDirectoryKind {
	return value === "project-pi" || value === "project-agents" || value === "prompts";
}

export function registerProjectResourceIpc({ appLogger, projectResourceManager }: ProjectResourceIpcDeps): void {
	ipcMain.handle(ipcChannels.projectResourcesList, async (_event, projectId: unknown) => {
		if (!nonEmptyString(projectId, 256)) throw new Error("Invalid project id.");
		return projectResourceManager.list(projectId.trim());
	});
	ipcMain.handle(ipcChannels.projectResourcesOpenDirectory, async (_event, projectId: unknown, kind: unknown) => {
		if (!nonEmptyString(projectId, 256) || !isProjectResourceDirectoryKind(kind)) {
			throw new Error("Invalid project resource directory input.");
		}
		const directory = await projectResourceManager.ensureResourceDirectory(projectId.trim(), kind);
		const error = await shell.openPath(directory);
		if (error) throw new Error(error);
	});
	ipcMain.handle(ipcChannels.projectResourcesCreateSkill, async (_event, input: unknown) => {
		if (!isCreateSkillInput(input)) throw new Error("Invalid project skill input.");
		const result = await projectResourceManager.createSkill({ ...input, projectId: input.projectId.trim() });
		void appLogger.info("project-resource", "Project skill created", { projectId: input.projectId, name: result.name });
		return result;
	});
	ipcMain.handle(ipcChannels.projectResourcesDeleteSkill, async (_event, projectId: unknown, skillPath: unknown) => {
		if (!nonEmptyString(projectId, 256) || !nonEmptyString(skillPath)) throw new Error("Invalid project skill deletion input.");
		// The manager resolves and rechecks project ownership before deleting renderer-supplied paths.
		await projectResourceManager.deleteSkill(projectId.trim(), skillPath);
		void appLogger.info("project-resource", "Project skill deleted", { projectId, skillPath });
	});
	ipcMain.handle(ipcChannels.projectResourcesDeleteExtension, async (_event, projectId: unknown, extensionPath: unknown) => {
		if (!nonEmptyString(projectId, 256) || !nonEmptyString(extensionPath)) throw new Error("Invalid project extension deletion input.");
		// Extensions are discovered locally; deletion remains constrained to the project's extension directory.
		await projectResourceManager.deleteExtension(projectId.trim(), extensionPath);
		void appLogger.info("project-resource", "Project extension deleted", { projectId, extensionPath });
	});
	ipcMain.handle(ipcChannels.projectResourcesToggleSkill, async (_event, projectId: unknown, skillPath: unknown, enabled: unknown) => {
		if (!nonEmptyString(projectId, 256) || !nonEmptyString(skillPath) || typeof enabled !== "boolean") {
			throw new Error("Invalid project skill toggle input.");
		}
		const result = await projectResourceManager.toggleSkill(projectId.trim(), skillPath, enabled);
		void appLogger.info("project-resource", "Project skill toggled", { projectId, skillPath, enabled });
		return result;
	});
	ipcMain.handle(ipcChannels.projectResourcesToggleExtension, async (_event, projectId: unknown, extensionPath: unknown, enabled: unknown) => {
		if (!nonEmptyString(projectId, 256) || !nonEmptyString(extensionPath) || typeof enabled !== "boolean") {
			throw new Error("Invalid project extension toggle input.");
		}
		await projectResourceManager.toggleExtension(projectId.trim(), extensionPath, enabled);
		void appLogger.info("project-resource", "Project extension toggled", { projectId, extensionPath, enabled });
	});
	ipcMain.handle(ipcChannels.projectResourcesToggleInherited, async (_event, input: unknown) => {
		if (!isInheritedToggleInput(input)) throw new Error("Invalid project inherited resource toggle input.");
		const overrides = await projectResourceManager.toggleInheritedResource(input);
		void appLogger.info("project-resource", "Inherited resource override toggled", {
			projectId: input.projectId,
			kind: input.kind,
			enabled: input.enabled,
		});
		return overrides;
	});
	ipcMain.handle(ipcChannels.projectResourcesRenameSkill, async (_event, projectId: unknown, skillPath: unknown, newName: unknown) => {
		if (!nonEmptyString(projectId, 256) || !nonEmptyString(skillPath) || !nonEmptyString(newName, 256)) {
			throw new Error("Invalid project skill rename input.");
		}
		const result = await projectResourceManager.renameSkill(projectId.trim(), skillPath, newName);
		void appLogger.info("project-resource", "Project skill renamed", { projectId, skillPath, newName });
		return result;
	});
	ipcMain.handle(ipcChannels.projectResourcesDiscovery, async (_event, projectId: unknown) => {
		if (projectId !== undefined && !nonEmptyString(projectId, 256)) throw new Error("Invalid project id.");
		return projectResourceManager.discovery(typeof projectId === "string" ? projectId.trim() : undefined);
	});
}
