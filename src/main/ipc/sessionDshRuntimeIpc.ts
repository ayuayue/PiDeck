/**
 * DSH 后端运行时 IPC：模型目录 / provider / agent preset / 配置 / 凭据 / host 控制 / runtime 安装。
 * 从 sessionIpc.ts 按通道域拆出（纯搬迁：通道常量、入参校验、错误文案与注册顺序不变）。
 */

import { existsSync } from "node:fs";
import { dialog, ipcMain } from "electron";
import { ipcChannels } from "../../shared/ipc";
import type { DshModelDiscoveryInput } from "../../shared/types";
import type { DshBackendIpcDeps, SessionIpcDeps } from "./sessionIpc";
import { isRecord } from "./sessionIpcInputGuards";

/** 本组 handler 真正用到的依赖：DSH 后端能力（dshBackend 分组）+ 主进程文案。 */
export type SessionDshRuntimeIpcDeps = Pick<
	DshBackendIpcDeps,
	| "listDshModels"
	| "discoverDshModels"
	| "listDshProviders"
	| "listDshAgentPresets"
	| "getDshDefaultModel"
	| "getDshStatus"
	| "getDshRuntimeStatus"
	| "installDshRuntime"
	| "importDshRuntime"
	| "uninstallDshRuntime"
	| "describeDshSettings"
	| "updateDshSettings"
	| "mutateDshSettings"
	| "describeDshCredentials"
	| "setDshCredential"
	| "unsetDshCredential"
	| "readDshCredential"
	| "openDshDocument"
	| "restartDshHost"
	| "stopDshHost"
	| "startDshHost"
> &
	Pick<SessionIpcDeps, "mainCopy">;

function isDshModelDiscoveryInput(input: unknown): input is DshModelDiscoveryInput {
	if (!isRecord(input) || typeof input.settingsNs !== "string" || !input.settingsNs.trim()) return false;
	return ["provider", "baseURL", "api", "apiKey"].every((key) => {
		const value = input[key];
		return value === undefined || typeof value === "string";
	});
}

export function registerSessionDshRuntimeIpc(deps: SessionDshRuntimeIpcDeps): void {
	const {
		mainCopy,
		listDshModels,
		discoverDshModels,
		listDshProviders,
		listDshAgentPresets,
		getDshDefaultModel,
		getDshStatus,
		getDshRuntimeStatus,
		installDshRuntime,
		importDshRuntime,
		uninstallDshRuntime,
		describeDshSettings,
		updateDshSettings,
		mutateDshSettings,
		describeDshCredentials,
		setDshCredential,
		unsetDshCredential,
		readDshCredential,
		openDshDocument,
		restartDshHost,
		stopDshHost,
		startDshHost,
	} = deps;
	ipcMain.handle(ipcChannels.dshListModels, async () => (listDshModels ? listDshModels() : []));
	ipcMain.handle(ipcChannels.dshDiscoverModels, async (_event, input: unknown) => {
		if (!isDshModelDiscoveryInput(input)) {
			throw new Error("Invalid DSH model discovery input");
		}
		if (!discoverDshModels) throw new Error("DSH model discovery is not available");
		return discoverDshModels(input);
	});
	ipcMain.handle(ipcChannels.dshListProviders, async () => (listDshProviders ? listDshProviders() : []));
	ipcMain.handle(ipcChannels.dshAgentPresets, async () => (listDshAgentPresets ? listDshAgentPresets() : []));
	ipcMain.handle(ipcChannels.dshDefaultModel, async () => (getDshDefaultModel ? getDshDefaultModel() : undefined));
	ipcMain.handle(ipcChannels.dshGetStatus, async () => (getDshStatus ? getDshStatus() : { started: false, homeDir: "", bootError: null }));
	// DSH runtime 安装态查询：未装配 dshBackend = 无 DSH 后端，按 notInstalled 返回
	//（渲染层据此隐藏 DSH UI、显示安装引导，不会出现裸报错）。
	ipcMain.handle(ipcChannels.dshRuntimeGetStatus, async () => (getDshRuntimeStatus ? getDshRuntimeStatus() : { state: "notInstalled" as const }));
	// DSH runtime 安装（阶段 2）：进度不走返回值，经 dsh-runtime:install-progress 推送，
	// 因为下载可能持续数十秒——返回 promise 会让渲染层一直空转等待。
	ipcMain.handle(ipcChannels.dshRuntimeInstall, async () => {
		if (!installDshRuntime) throw new Error("DSH runtime installation is not available");
		return installDshRuntime();
	});
	ipcMain.handle(ipcChannels.dshRuntimeInstallLocal, async () => {
		if (!importDshRuntime) throw new Error("DSH runtime installation is not available");
		// 对话框在主进程弹：渲染层不参与路径选择，也就没有「传任意路径读文件」的入口。
		const picked = await dialog.showOpenDialog({
			title: mainCopy("dsh.runtime.pickArchiveTitle"),
			// 只收归档：与目录入口分开弹。Windows 上 openFile + openDirectory 同时给会
			// 退化成只能选目录，.tgz 选不到（见 shared/ipc.ts 的 dshRuntimeInstallLocalDir）。
			filters: [{ name: "DSH runtime", extensions: ["tgz", "gz"] }],
			properties: ["openFile"],
		});
		if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: "cancelled" };
		const filePath = picked.filePaths[0];
		// 归档文件或已解压目录都允许（目录由 installer 按类型分流处理）。
		if (!filePath || !existsSync(filePath)) {
			throw new Error(mainCopy("dsh.runtime.invalidArchivePath"));
		}
		return importDshRuntime(filePath);
	});
	ipcMain.handle(ipcChannels.dshRuntimeInstallLocalDir, async () => {
		if (!importDshRuntime) throw new Error("DSH runtime installation is not available");
		const picked = await dialog.showOpenDialog({
			title: mainCopy("dsh.runtime.pickDirectoryTitle"),
			properties: ["openDirectory"],
		});
		if (picked.canceled || picked.filePaths.length === 0) return { ok: false, error: "cancelled" };
		const dirPath = picked.filePaths[0];
		if (!dirPath || !existsSync(dirPath)) {
			throw new Error(mainCopy("dsh.runtime.invalidArchivePath"));
		}
		return importDshRuntime(dirPath);
	});
	ipcMain.handle(ipcChannels.dshRuntimeUninstall, async () => {
		if (!uninstallDshRuntime) throw new Error("DSH runtime installation is not available");
		return uninstallDshRuntime();
	});
	ipcMain.handle(ipcChannels.dshConfigDescribe, async () => (describeDshSettings ? describeDshSettings() : { writable: false, hasDocument: false, namespaces: [] }));
	ipcMain.handle(ipcChannels.dshConfigUpdate, async (_event, ns: string, patch: Record<string, unknown>, expectedRevision?: number) => {
		if (!updateDshSettings) throw new Error("DSH settings are not available");
		return updateDshSettings(ns, patch, expectedRevision);
	});
	ipcMain.handle(ipcChannels.dshConfigMutate, async (_event, ns: string, ops: Array<{ op: "set"; path: string[]; value: unknown } | { op: "unset"; path: string[] }>, expectedRevision?: number) => {
		if (!mutateDshSettings) throw new Error("DSH settings are not available");
		return mutateDshSettings(ns, ops, expectedRevision);
	});
	ipcMain.handle(ipcChannels.dshCredentialDescribe, async (_event, refs: string[]) => (describeDshCredentials ? describeDshCredentials(refs) : {}));
	ipcMain.handle(ipcChannels.dshCredentialSet, async (_event, ref: string, value: string) => {
		if (!setDshCredential) throw new Error("DSH credentials are not available");
		await setDshCredential(ref, value);
	});
	ipcMain.handle(ipcChannels.dshCredentialUnset, async (_event, ref: string) => {
		if (!unsetDshCredential) throw new Error("DSH credentials are not available");
		await unsetDshCredential(ref);
	});
	// 凭证明文读取：渲染层点「眼睛」时按 ref 取一次（无值返回 undefined）。
	// ref 格式校验与 DSH credentialRef 同规则，防路径注入。
	ipcMain.handle(ipcChannels.dshCredentialRead, async (_event, ref: unknown) => {
		if (!readDshCredential) throw new Error("DSH credentials are not available");
		if (typeof ref !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) {
			throw new Error(`invalid credential ref: ${String(ref)}`);
		}
		return readDshCredential(ref);
	});
	ipcMain.handle(ipcChannels.dshOpenDocument, async () => {
		if (!openDshDocument) throw new Error("DSH settings document is not available");
		await openDshDocument();
	});
	ipcMain.handle(ipcChannels.dshRestartHost, async () => {
		if (!restartDshHost) throw new Error("DSH host restart is not available");
		return restartDshHost();
	});
	ipcMain.handle(ipcChannels.dshStopHost, async () => {
		if (!stopDshHost) throw new Error("DSH host stop is not available");
		return stopDshHost();
	});
	ipcMain.handle(ipcChannels.dshStartHost, async () => {
		if (!startDshHost) throw new Error("DSH host start is not available");
		return startDshHost();
	});
}
