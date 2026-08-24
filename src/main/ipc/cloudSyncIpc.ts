/**
 * Cloud sync IPC handlers: input validation at the boundary, thin adaptation
 * only. All business logic lives in CloudSyncManager; renderer never receives
 * master passwords, derived keys or provider credentials.
 */

import { ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type {
	CloudProvider,
	CloudSyncConflictResolution,
	CloudSyncProviderConfigInput,
	CloudSyncSelectionUpdate,
	CloudSyncStrategy,
	WebDAVConfig,
	S3Config,
} from "../../shared/types/cloudSync";
import { isBuiltinCloudProvider } from "../../shared/types/cloudSync";
import type { CloudSyncManager } from "../cloudSync/CloudSyncManager";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isWebDAVConfig(value: unknown): value is WebDAVConfig {
	if (!isPlainObject(value)) return false;
	if (typeof value.endpoint !== "string" || value.endpoint.length === 0 || value.endpoint.length > 2048) return false;
	if (value.authType !== "basic" && value.authType !== "digest" && value.authType !== "token") return false;
	if (value.username !== undefined && typeof value.username !== "string") return false;
	if (value.password !== undefined && typeof value.password !== "string") return false;
	if (value.token !== undefined && typeof value.token !== "string") return false;
	return true;
}

function isS3Config(value: unknown): value is S3Config {
	if (!isPlainObject(value)) return false;
	if (typeof value.endpoint !== "string" || value.endpoint.length === 0 || value.endpoint.length > 2048) return false;
	if (typeof value.region !== "string" || value.region.length === 0) return false;
	if (typeof value.bucket !== "string" || value.bucket.length === 0) return false;
	if (typeof value.accessKeyId !== "string" || typeof value.secretAccessKey !== "string") return false;
	if (value.sessionToken !== undefined && typeof value.sessionToken !== "string") return false;
	if (value.prefix !== undefined && typeof value.prefix !== "string") return false;
	return true;
}

function parseProviderConfigInput(value: unknown): CloudSyncProviderConfigInput {
	if (!isPlainObject(value)) throw new TypeError("Provider config must be an object");
	const provider = value.provider;
	if (provider === "webdav") {
		return { provider, config: isWebDAVConfig(value.config) ? value.config : throwType("WebDAV config is invalid") };
	}
	if (provider === "s3") {
		return { provider, config: isS3Config(value.config) ? value.config : throwType("S3 config is invalid") };
	}
	throw new TypeError("Unknown cloud provider");
}

function throwType(message: string): never {
	throw new TypeError(message);
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
}
