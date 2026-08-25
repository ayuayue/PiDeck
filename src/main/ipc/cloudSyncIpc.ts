/**
 * Cloud sync IPC handlers: input validation at the boundary, thin adaptation
 * only. All business logic lives in CloudSyncManager; renderer never receives
 * master passwords, derived keys or provider credentials.
 */

import { dialog, ipcMain } from "electron";
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

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

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
}): void {
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
}
