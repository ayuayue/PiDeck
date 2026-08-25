/**
 * Cloud sync IPC handlers: input validation at the boundary, thin adaptation
 * only. All business logic lives in CloudSyncManager; renderer never receives
 * master passwords, derived keys or provider credentials.
 */

import { dialog, ipcMain } from "electron";
import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { ipcChannels } from "../../shared/ipc";
import type {
	CloudProvider,
	CloudSyncConflictResolution,
	CloudSyncExportResult,
	CloudSyncImportInput,
	CloudSyncImportMode,
	CloudSyncSelectionUpdate,
	CloudSyncStrategy,
} from "../../shared/types/cloudSync";
import { isBuiltinCloudProvider } from "../../shared/types/cloudSync";
import { parseProviderConfigInput } from "../cloudSync/parseProviderConfig";
import type { CloudSyncManager } from "../cloudSync/CloudSyncManager";
import type { Project } from "../../shared/types";

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

/** 自选路径归属判断用的项目列表（由 registerCloudSyncIpc 注入）。 */
let listProjectsForCustomPath: () => Project[] = () => [];

function parseProvider(provider: unknown): CloudProvider {
	if (typeof provider !== "string" || !isBuiltinCloudProvider(provider)) {
		throw new TypeError("Unknown cloud provider");
	}
	return provider;
}

function parsePassword(value: unknown): string {
	if (typeof value !== "string" || value.length < 8 || value.length > 1024) {
		throw new TypeError("Master password must be 8 to 1024 characters");
	}
	return value;
}

function parseSelectionUpdate(value: unknown): CloudSyncSelectionUpdate {
	if (!isPlainObject(value)) throw new TypeError("Selection update must be an object");
	const selectedSessionIds = Array.isArray(value.selectedSessionIds)
		? value.selectedSessionIds.filter((id): id is string => typeof id === "string" && id.startsWith("session:"))
		: [];
	const selectedResourceIds = Array.isArray(value.selectedResourceIds)
		? value.selectedResourceIds.filter((id): id is string => typeof id === "string" && id.startsWith("resource:"))
		: [];
	const content = value.content;
	if (content !== undefined && !isPlainObject(content)) throw new TypeError("Content preferences must be an object");
	return {
		selectedSessionIds,
		selectedResourceIds,
		...(content ? { content: content as CloudSyncSelectionUpdate["content"] } : {}),
	};
}

function parseStrategy(value: unknown): CloudSyncStrategy {
	if (value !== "smartMerge" && value !== "preferCloud" && value !== "preferLocal") {
		throw new TypeError("Unknown sync strategy");
	}
	return value;
}

/** M9：自选同步路径入参校验（renderer 数据不可信，边界收口）。 */
function parseCustomPathInput(value: unknown): {
	filePath: string;
	relativeTo: "project" | "home" | "absolute";
	relativePath: string;
	projectId?: string;
	label?: string;
} {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Custom path input must be an object");
	}
	const input = value as Record<string, unknown>;
	if (typeof input.filePath !== "string" || input.filePath.trim().length === 0 || input.filePath.length > 4096) {
		throw new TypeError("Custom path filePath is invalid");
	}
	const relativeTo = input.relativeTo;
	if (relativeTo !== "project" && relativeTo !== "home" && relativeTo !== "absolute") {
		throw new TypeError("Custom path relativeTo is invalid");
	}
	if (typeof input.relativePath !== "string" || input.relativePath.length === 0 || input.relativePath.length > 4096) {
		throw new TypeError("Custom path relativePath is invalid");
	}
	return {
		filePath: input.filePath,
		relativeTo,
		relativePath: input.relativePath,
		...(typeof input.projectId === "string" && input.projectId.length > 0 ? { projectId: input.projectId } : {}),
		...(typeof input.label === "string" && input.label.trim().length > 0 ? { label: input.label.trim() } : {}),
	};
}

/** M9：自选路径归属计算 —— 命中项目目录 → project 相对；否则 home 相对；无法相对 → absolute（仅本机）。 */
function mapCustomPathToPortable(filePath: string): {
	filePath: string;
	relativeTo: "project" | "home" | "absolute";
	relativePath: string;
	projectId?: string;
	label: string;
} | null {
	const normalized = resolve(filePath);
	const projects = listProjectsForCustomPath();
	for (const project of projects) {
		const projectRoot = resolve(project.path);
		const relativePath = relative(projectRoot, normalized);
		if (!relativePath || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) continue;
		return {
			filePath: normalized,
			relativeTo: "project",
			relativePath,
			projectId: project.id,
			label: `${project.name}/${relativePath}`,
		};
	}
	const homeRoot = resolve(homedir());
	const homeRelative = relative(homeRoot, normalized);
	if (homeRelative && homeRelative !== ".." && !homeRelative.startsWith(`..${sep}`) && !isAbsolute(homeRelative)) {
		return { filePath: normalized, relativeTo: "home", relativePath: homeRelative, label: homeRelative };
	}
	return { filePath: normalized, relativeTo: "absolute", relativePath: normalized, label: normalized };
}

/** M9：云端项目挂载入参校验。 */
function parseMountInput(value: unknown): { remoteProjectId: string; remoteProjectName: string; localPath: string } {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new TypeError("Mount input must be an object");
	}
	const input = value as Record<string, unknown>;
	if (typeof input.remoteProjectId !== "string" || input.remoteProjectId.trim().length === 0 || input.remoteProjectId.length > 256) {
		throw new TypeError("Mount remoteProjectId is invalid");
	}
	if (typeof input.remoteProjectName !== "string" || input.remoteProjectName.trim().length === 0 || input.remoteProjectName.length > 512) {
		throw new TypeError("Mount remoteProjectName is invalid");
	}
	if (typeof input.localPath !== "string" || input.localPath.trim().length === 0 || input.localPath.length > 4096) {
		throw new TypeError("Mount localPath is invalid");
	}
	return { remoteProjectId: input.remoteProjectId.trim(), remoteProjectName: input.remoteProjectName.trim(), localPath: input.localPath };
}

function parseImportMode(value: unknown): CloudSyncImportMode {
	if (value !== "merge" && value !== "overwrite" && value !== "restoreMissing") {
		throw new TypeError("Unknown import mode");
	}
	return value;
}

/** 校验导出选项：outputPath 缺省走保存对话框；title 仅作对话框标题（渲染层 i18n 文案）。 */
function parseExportOptions(value: unknown): { outputPath?: string; title?: string } {
	if (value === undefined || value === null) return {};
	if (!isPlainObject(value)) throw new TypeError("Export options must be an object");
	const outputPath = value.outputPath;
	const title = value.title;
	return {
		...(typeof outputPath === "string" && outputPath.length > 0 && outputPath.length <= 4096 && !outputPath.includes("\0")
			? { outputPath }
			: {}),
		...(typeof title === "string" && title.length > 0 && title.length <= 256 ? { title } : {}),
	};
}

function parseImportInput(value: unknown): CloudSyncImportInput {
	if (!isPlainObject(value)) throw new TypeError("Import input must be an object");
	const filePath = value.filePath;
	if (typeof filePath !== "string" || filePath.length === 0 || filePath.length > 4096 || filePath.includes("\0")) {
		throw new TypeError("Import file path is invalid");
	}
	return {
		filePath,
		password: parsePassword(value.password),
		mode: parseImportMode(value.mode),
	};
}

/** 导出保存对话框：返回 null 表示用户取消。 */
async function resolveBackupSavePath(title?: string): Promise<string | null> {
	const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
	const result = await dialog.showSaveDialog({
		title,
		defaultPath: `PiDeck 备份 ${stamp}.pideckbackup`,
		filters: [{ name: "PiDeck Backup", extensions: ["pideckbackup"] }],
	});
	return result.canceled ? null : result.filePath;
}

export function registerCloudSyncIpc(deps: {
	manager: CloudSyncManager;
	notifyStateChanged: () => void;
	listProjects?: () => Project[];
}): void {
	if (deps.listProjects) listProjectsForCustomPath = deps.listProjects;
	const { manager, notifyStateChanged } = deps;

	ipcMain.handle(ipcChannels.cloudSyncGetState, () => manager.getStateSnapshot());

	ipcMain.handle(ipcChannels.cloudSyncSetupMasterKey, async (_event, password: unknown) => {
		await manager.setupMasterKey(parsePassword(password));
		notifyStateChanged();
		return manager.getStateSnapshot();
	});

	ipcMain.handle(ipcChannels.cloudSyncUnlock, async (_event, password: unknown) => {
		const ok = await manager.unlock(parsePassword(password));
		notifyStateChanged();
		return ok;
	});

	ipcMain.handle(ipcChannels.cloudSyncLock, async () => {
		await manager.lock();
		notifyStateChanged();
	});

	ipcMain.handle(ipcChannels.cloudSyncChangePassword, async (_event, oldPassword: unknown, newPassword: unknown) => {
		const ok = await manager.changeMasterPassword(parsePassword(oldPassword), parsePassword(newPassword));
		notifyStateChanged();
		return ok;
	});

	ipcMain.handle(ipcChannels.cloudSyncConfigureProvider, async (_event, input: unknown) => {
		const parsed = parseProviderConfigInput(input);
		await manager.configureProvider(parsed);
		notifyStateChanged();
		return manager.getStateSnapshot();
	});

	ipcMain.handle(ipcChannels.cloudSyncDisconnectProvider, async (_event, provider: unknown) => {
		await manager.disconnectProvider(parseProvider(provider));
		notifyStateChanged();
	});

	ipcMain.handle(ipcChannels.cloudSyncConnect, async (_event, provider: unknown) => {
		const account = await manager.connectProvider(parseProvider(provider));
		notifyStateChanged();
		return account;
	});

	ipcMain.handle(ipcChannels.cloudSyncGithubDeviceStart, async (_event, clientId: unknown) => {
		if (typeof clientId !== "string" || clientId.length === 0 || clientId.length > 128) {
			throw new TypeError("GitHub client id is invalid");
		}
		return manager.startGithubDeviceFlow(clientId);
	});

	ipcMain.handle(ipcChannels.cloudSyncGithubDevicePoll, async () => {
		const result = await manager.pollGithubDeviceFlow();
		if (result.status === "ok") notifyStateChanged();
		return result;
	});

	ipcMain.handle(ipcChannels.cloudSyncScan, () => manager.scanSelection());

	ipcMain.handle(ipcChannels.cloudSyncUpdateSelection, async (_event, update: unknown) => {
		const tree = await manager.updateSelection(parseSelectionUpdate(update));
		notifyStateChanged();
		return tree;
	});

	ipcMain.handle(ipcChannels.cloudSyncSyncNow, (_event, options: unknown) =>
		manager.syncNow(options && typeof options === "object" ? { allowShrink: Boolean((options as { allowShrink?: unknown }).allowShrink) } : undefined));

	ipcMain.handle(ipcChannels.cloudSyncResolveConflicts, async (_event, resolutions: unknown) => {
		if (!Array.isArray(resolutions) || resolutions.length > 1000) {
			throw new TypeError("Conflict resolutions must be an array");
		}
		const parsed = resolutions.map((resolution): CloudSyncConflictResolution => {
			if (!isPlainObject(resolution) || typeof resolution.id !== "string" || resolution.id.length > 512) {
				throw new TypeError("Conflict resolution has an invalid id");
			}
			if (resolution.choice !== "local" && resolution.choice !== "remote") {
				throw new TypeError("Conflict resolution choice must be local or remote");
			}
			return { id: resolution.id, choice: resolution.choice };
		});
		const result = await manager.resolveConflicts(parsed);
		notifyStateChanged();
		return result;
	});

	ipcMain.handle(ipcChannels.cloudSyncSetAutoSync, async (_event, enabled: unknown, intervalMinutes: unknown) => {
		if (typeof enabled !== "boolean") throw new TypeError("Auto sync enabled must be a boolean");
		await manager.setAutoSync(enabled, typeof intervalMinutes === "number" ? intervalMinutes : undefined);
		notifyStateChanged();
		return manager.getStateSnapshot();
	});

	ipcMain.handle(ipcChannels.cloudSyncRestoreExtensions, async () => {
		const result = await manager.retryMissingExtensions();
		notifyStateChanged();
		return result;
	});

	ipcMain.handle(ipcChannels.cloudSyncSetStrategy, async (_event, strategy: unknown) => {
		await manager.setStrategy(parseStrategy(strategy));
		notifyStateChanged();
		return manager.getStateSnapshot();
	});

	ipcMain.handle(ipcChannels.cloudSyncExport, async (_event, options: unknown): Promise<CloudSyncExportResult | null> => {
		const parsed = parseExportOptions(options);
		const filePath = parsed.outputPath ?? await resolveBackupSavePath(parsed.title);
		if (!filePath) return null; // 用户取消保存对话框
		const result = await manager.exportBackup({ outputPath: filePath });
		notifyStateChanged();
		return result;
	});

	ipcMain.handle(ipcChannels.cloudSyncImport, async (_event, input: unknown) => {
		const parsed = parseImportInput(input);
		const result = await manager.importBackup(parsed);
		notifyStateChanged();
		return result;
	});

	// ── M9: exclusions / custom paths / mounts ─────────────────────────

	ipcMain.handle(ipcChannels.cloudSyncSetExclusions, async (_event, patterns: unknown) => {
		if (!Array.isArray(patterns) || patterns.some((item) => typeof item !== "string")) {
			throw new TypeError("Exclusions must be an array of strings");
		}
		await manager.setExclusions(patterns);
		notifyStateChanged();
		return manager.getStateSnapshot();
	});

	ipcMain.handle(ipcChannels.cloudSyncAddCustomPath, async (_event, input: unknown) => {
		const parsed = parseCustomPathInput(input);
		await manager.addCustomPath(parsed);
		notifyStateChanged();
		return manager.getStateSnapshot();
	});

	ipcMain.handle(ipcChannels.cloudSyncRemoveCustomPath, async (_event, id: unknown) => {
		if (typeof id !== "string" || id.length === 0) throw new TypeError("Custom path id is invalid");
		await manager.removeCustomPath(id);
		notifyStateChanged();
		return manager.getStateSnapshot();
	});

	ipcMain.handle(ipcChannels.cloudSyncMountProject, async (_event, input: unknown) => {
		const parsed = parseMountInput(input);
		await manager.mountProject(parsed);
		notifyStateChanged();
		return manager.getStateSnapshot();
	});

	ipcMain.handle(ipcChannels.cloudSyncUnmountProject, async (_event, remoteProjectId: unknown) => {
		if (typeof remoteProjectId !== "string" || remoteProjectId.length === 0) throw new TypeError("Remote project id is invalid");
		await manager.unmountProject(remoteProjectId);
		notifyStateChanged();
		return manager.getStateSnapshot();
	});

	/** M9：弹原生文件/文件夹选择器，归属计算后直接加入自选同步清单。 */
	ipcMain.handle(ipcChannels.cloudSyncPickCustomPath, async () => {
		const result = await dialog.showOpenDialog({
			title: "选择要同步的文件或文件夹",
			properties: ["openFile", "openDirectory", "multiSelections"],
		});
		if (result.canceled || result.filePaths.length === 0) return manager.getStateSnapshot();
		for (const filePath of result.filePaths) {
			const mapped = mapCustomPathToPortable(filePath);
			if (!mapped) continue;
			await manager.addCustomPath(mapped);
		}
		notifyStateChanged();
		return manager.getStateSnapshot();
	});

	/** M9：弹目录选择器，返回选中目录（挂载到云端项目用）。 */
	ipcMain.handle(ipcChannels.cloudSyncPickMountDirectory, async () => {
		const result = await dialog.showOpenDialog({
			title: "选择同步目标目录",
			properties: ["openDirectory"],
		});
		if (result.canceled || result.filePaths.length === 0) return null;
		return result.filePaths[0];
	});

	ipcMain.handle(ipcChannels.cloudSyncOneDriveStart, async (_event, clientId: unknown) => {
		// clientId 可为空串：走构建期注入的内置凭据（对齐 Netcatty）；非空时按 BYO 校验。
		if (clientId !== null && clientId !== undefined && typeof clientId !== "string") {
			throw new TypeError("OneDrive client id is invalid");
		}
		if (typeof clientId === "string" && (clientId.length > 128 || /[\u0000-\u001f\u007f]/.test(clientId))) {
			throw new TypeError("OneDrive client id is invalid");
		}
		return manager.startOneDriveOAuth(typeof clientId === "string" ? clientId.trim() : "");
	});

	ipcMain.handle(ipcChannels.cloudSyncOneDrivePoll, async () => {
		const result = await manager.pollOneDriveOAuth();
		if (result.status === "ok") notifyStateChanged();
		return result;
	});

	ipcMain.handle(ipcChannels.cloudSyncGoogleStart, async (_event, clientId: unknown, clientSecret: unknown) => {
		// clientId 可为空串：走构建期注入的内置凭据；非空时按 BYO 校验。
		if (clientId !== null && clientId !== undefined && typeof clientId !== "string") {
			throw new TypeError("Google Drive client id is invalid");
		}
		if (typeof clientId === "string" && (clientId.length > 128 || /[\u0000-\u001f\u007f]/.test(clientId))) {
			throw new TypeError("Google Drive client id is invalid");
		}
		if (clientSecret !== null && clientSecret !== undefined && typeof clientSecret !== "string") {
			throw new TypeError("Google Drive client secret is invalid");
		}
		return manager.startGoogleOAuth(
			typeof clientId === "string" ? clientId.trim() : "",
			typeof clientSecret === "string" ? clientSecret.trim() : undefined,
		);
	});

	ipcMain.handle(ipcChannels.cloudSyncGooglePoll, async () => {
		const result = await manager.pollGoogleOAuth();
		if (result.status === "ok") notifyStateChanged();
		return result;
	});
}
