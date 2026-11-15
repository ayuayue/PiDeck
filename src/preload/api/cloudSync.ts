/**
 * preload cloudSync 域：云同步：OneDrive / Google / GitHub 流程与选择树。
 *
 * 组装口 `src/preload/index.ts` 只做 spread；方法体 / 参数名 / 通道引用与拆分前逐字一致。
 */
import { ipcRenderer } from "electron";
import { ipcChannels } from "../../shared/ipc";
import { subscribe } from "./ipcHelpers";
import type {
	CloudSyncExportResult,
	CloudSyncGithubPollResult,
	CloudSyncGoogleFlowStart,
	CloudSyncImportInput,
	CloudSyncImportResult,
	CloudSyncMissingExtension,
	CloudSyncOneDriveFlowStart,
	CloudSyncProviderConfigInput,
	CloudSyncSelectionTree,
	CloudSyncSelectionUpdate,
	CloudSyncStateSnapshot,
	ProviderAccount,
} from "../../shared/types";

export const cloudSyncApi = {
	// ── 云同步：主进程持有密码/密钥/Provider 凭据；渲染层只拿状态快照与选择树 ──
	cloudSync: {
		getState: () => ipcRenderer.invoke(ipcChannels.cloudSyncGetState) as Promise<CloudSyncStateSnapshot>,
		onStateChanged: (callback: (state: CloudSyncStateSnapshot) => void) => subscribe(ipcChannels.cloudSyncStateChanged, callback),
		setupMasterKey: (password: string) => ipcRenderer.invoke(ipcChannels.cloudSyncSetupMasterKey, password) as Promise<CloudSyncStateSnapshot>,
		unlock: (password: string) => ipcRenderer.invoke(ipcChannels.cloudSyncUnlock, password) as Promise<boolean>,
		lock: () => ipcRenderer.invoke(ipcChannels.cloudSyncLock) as Promise<void>,
		changePassword: (oldPassword: string, newPassword: string) => ipcRenderer.invoke(ipcChannels.cloudSyncChangePassword, oldPassword, newPassword) as Promise<boolean>,
		configureProvider: (input: CloudSyncProviderConfigInput) => ipcRenderer.invoke(ipcChannels.cloudSyncConfigureProvider, input) as Promise<CloudSyncStateSnapshot>,
		disconnectProvider: (provider: string) => ipcRenderer.invoke(ipcChannels.cloudSyncDisconnectProvider, provider) as Promise<void>,
		connect: (provider: string) => ipcRenderer.invoke(ipcChannels.cloudSyncConnect, provider) as Promise<ProviderAccount>,
		githubDeviceStart: (clientId: string) =>
			ipcRenderer.invoke(ipcChannels.cloudSyncGithubDeviceStart, clientId) as Promise<{
				deviceCode: string;
				userCode: string;
				verificationUrl: string;
				expiresIn: number;
				interval: number;
			}>,
		githubDevicePoll: () => ipcRenderer.invoke(ipcChannels.cloudSyncGithubDevicePoll) as Promise<CloudSyncGithubPollResult>,
		scan: () => ipcRenderer.invoke(ipcChannels.cloudSyncScan) as Promise<CloudSyncSelectionTree>,
		updateSelection: (update: CloudSyncSelectionUpdate) => ipcRenderer.invoke(ipcChannels.cloudSyncUpdateSelection, update) as Promise<CloudSyncSelectionTree>,
		syncNow: (options?: { allowShrink?: boolean }) =>
			ipcRenderer.invoke(ipcChannels.cloudSyncSyncNow, options ?? null) as Promise<{
				pushed: boolean;
				pulled: boolean;
				reason?: string;
			}>,
		resolveConflicts: (resolutions: Array<{ id: string; choice: "local" | "remote" }>) =>
			ipcRenderer.invoke(ipcChannels.cloudSyncResolveConflicts, resolutions) as Promise<{
				pushed: boolean;
				pulled: boolean;
			}>,
		restoreExtensions: () => ipcRenderer.invoke(ipcChannels.cloudSyncRestoreExtensions) as Promise<CloudSyncMissingExtension[]>,
		setAutoSync: (enabled: boolean, intervalMinutes?: number) => ipcRenderer.invoke(ipcChannels.cloudSyncSetAutoSync, enabled, intervalMinutes) as Promise<CloudSyncStateSnapshot>,
		setStrategy: (strategy: string) => ipcRenderer.invoke(ipcChannels.cloudSyncSetStrategy, strategy) as Promise<CloudSyncStateSnapshot>,
		exportBackup: (options?: { outputPath?: string; title?: string }) => ipcRenderer.invoke(ipcChannels.cloudSyncExport, options) as Promise<CloudSyncExportResult | null>,
		importBackup: (input: CloudSyncImportInput) => ipcRenderer.invoke(ipcChannels.cloudSyncImport, input) as Promise<CloudSyncImportResult>,
		oneDriveStart: (clientId: string) => ipcRenderer.invoke(ipcChannels.cloudSyncOneDriveStart, clientId) as Promise<CloudSyncOneDriveFlowStart | null>,
		oneDrivePoll: () => ipcRenderer.invoke(ipcChannels.cloudSyncOneDrivePoll) as Promise<{ status: "ok" | "pending" | "error"; error?: string }>,
		googleStart: (clientId: string, clientSecret?: string) => ipcRenderer.invoke(ipcChannels.cloudSyncGoogleStart, clientId, clientSecret ?? null) as Promise<CloudSyncGoogleFlowStart | null>,
		googlePoll: () => ipcRenderer.invoke(ipcChannels.cloudSyncGooglePoll) as Promise<{ status: "ok" | "pending" | "error"; error?: string }>,
		setExclusions: (patterns: string[]) => ipcRenderer.invoke(ipcChannels.cloudSyncSetExclusions, patterns) as Promise<CloudSyncStateSnapshot>,
		addCustomPath: (input: { filePath: string; relativeTo: "project" | "home" | "absolute"; relativePath: string; projectId?: string; label?: string }) => ipcRenderer.invoke(ipcChannels.cloudSyncAddCustomPath, input) as Promise<CloudSyncStateSnapshot>,
		removeCustomPath: (id: string) => ipcRenderer.invoke(ipcChannels.cloudSyncRemoveCustomPath, id) as Promise<CloudSyncStateSnapshot>,
		mountProject: (input: { remoteProjectId: string; remoteProjectName: string; localPath: string }) => ipcRenderer.invoke(ipcChannels.cloudSyncMountProject, input) as Promise<CloudSyncStateSnapshot>,
		unmountProject: (remoteProjectId: string) => ipcRenderer.invoke(ipcChannels.cloudSyncUnmountProject, remoteProjectId) as Promise<CloudSyncStateSnapshot>,
		pickCustomPath: () => ipcRenderer.invoke(ipcChannels.cloudSyncPickCustomPath) as Promise<CloudSyncStateSnapshot>,
		pickMountDirectory: () => ipcRenderer.invoke(ipcChannels.cloudSyncPickMountDirectory) as Promise<string | null>,
	},
};
