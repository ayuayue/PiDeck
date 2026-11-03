import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import { codeOf, opFailFromCode, opOk } from "../../shared/op";
import { ipcChannels } from "../../shared/ipc";
import type { RemoteTransferEvent, RemoteTransferSettlementResult, RemoteTransferStartInput, RemoteTransferUploadResult } from "../../shared/types/remoteTransfers";
import type { RemoteHostConnectionService } from "../remote/RemoteHostConnectionService";
import { createRemoteProjectTargetResolver, type RemoteProjectTarget } from "./remoteProjectTarget";
import { createLocalIoBudget, LOCAL_FILE_IO_TIMEOUT_MS, parseLocalUploadPaths, withLocalIoTimeout } from "./remoteUploadPaths";
import { createRemoteProjectTransferRegistry, type RemoteProjectTransferJobHandle, type RemoteProjectTransferScope, type RemoteProjectTransferSettlement } from "../remote/RemoteProjectTransferRegistry";
import { uploadOneRemoteProjectFile, type RemoteProjectUploadJobReceipt } from "../remote/RemoteProjectUploadJob";
import { createRemoteSftpCapabilityCache, type RemoteSftpCapabilityCache } from "../remote/RemoteSftpCapabilityCache";
import { createRemoteSftpCapabilityProbe, type RemoteSftpCapabilityProbe } from "../remote/RemoteSftpCapabilityProbe";
import { runRemoteSftpJob, type RemoteSftpProbe } from "../remote/RemoteSftpAdapter";
import type { RemoteSftpBinaryIdentity } from "../remote/RemoteSftpBinary";

const CONTROL = /[\u0000-\u001f\u007f]/;
const PROJECT_ID_MAX = 256;
const RELATIVE_MAX = 4096;
const TRASH = ".pideck-trash";
const REMOTE_TRANSFER_JOB_CODES = {
	binaryUnavailable: "REMOTE_SFTP_BINARY_UNAVAILABLE",
	downloadStatInvalid: "REMOTE_DOWNLOAD_STAT_INVALID",
	downloadUnconfirmed: "REMOTE_DOWNLOAD_RESULT_UNCONFIRMED",
	uploadFailed: "REMOTE_UPLOAD_FAILED",
} as const;
const DOWNLOAD_UNCERTAIN_CODES = new Set(["SFTP_JOB_CANCELLED", "SFTP_JOB_TIMEOUT", "SFTP_JOB_FAILED", "SFTP_OUTPUT_TOO_LARGE", "SFTP_RESULT_INVALID", "SFTP_LOCAL_IO_FAILED"]);

type ProjectTargetInput = {
	enabled: boolean;
	service?: () => RemoteHostConnectionService | undefined | Promise<RemoteHostConnectionService | undefined>;
	locator?: (projectId: string) => { kind: "ssh"; hostId: string; remotePath: string } | undefined;
};

type Dialogs = {
	openFiles(sender: WebContents): Promise<readonly string[] | undefined>;
	saveFile(sender: WebContents, defaultName: string): Promise<string | undefined>;
};

export type RemoteProjectTransferJobIpcInput = ProjectTargetInput & {
	readonly binary: () => Promise<RemoteSftpBinaryIdentity | undefined>;
	readonly probe?: RemoteSftpCapabilityProbe;
	readonly cache?: RemoteSftpCapabilityCache<RemoteSftpProbe>;
	readonly adapter?: typeof runRemoteSftpJob;
	readonly uploadOne?: typeof uploadOneRemoteProjectFile;
	readonly dialogs?: Dialogs;
	readonly afterWrite: (projectId: string, paths: readonly string[]) => void;
	readonly afterUnknown: (projectId: string) => void;
};

export type RemoteProjectTransferJobIpcHandle = {
	closeProject(projectId: string): void;
	dispose(): void;
};

type UploadInput = Extract<RemoteTransferStartInput, { operation: "upload" }>;
type DownloadInput = Extract<RemoteTransferStartInput, { operation: "download" }>;
type ValidInput = { readonly upload: UploadInput; readonly paths: readonly string[] } | { readonly download: DownloadInput };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function senderIdOf(sender: WebContents): number | undefined {
	const id = sender?.id;
	return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function readProjectId(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 && value.length <= PROJECT_ID_MAX && !CONTROL.test(value) ? value : undefined;
}

/** Project-relative POSIX path; the root is represented by the empty string. */
function readRelative(value: unknown, allowRoot: boolean): string | undefined {
	if (typeof value !== "string" || value.length > RELATIVE_MAX || CONTROL.test(value) || value.includes("\\") || value.startsWith("/")) return undefined;
	if (value === "") return allowRoot ? value : undefined;
	if (value.endsWith("/")) return undefined;
	const segments = value.split("/");
	if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) return undefined;
	if (segments[0] === TRASH) return undefined;
	return value;
}

function readInput(value: unknown): ValidInput | undefined {
	if (!isRecord(value)) return undefined;
	const projectId = readProjectId(value.projectId);
	if (projectId === undefined) return undefined;
	if (value.operation === "download") {
		const targetRelativePath = readRelative(value.targetRelativePath, false);
		if (targetRelativePath === undefined) return undefined;
		return { download: { operation: "download", projectId, targetRelativePath } };
	}
	if (value.operation !== "upload") return undefined;
	const targetRelativePath = readRelative(value.targetRelativePath, true);
	if (targetRelativePath === undefined || !isRecord(value.source)) return undefined;
	const source = value.source;
	let paths: readonly string[] | undefined;
	if (source.kind === "picker") {
		paths = undefined;
	} else if (source.kind === "paths") {
		const parsed = parseLocalUploadPaths(source.paths);
		if (!parsed.ok) return undefined;
		paths = parsed.paths;
	} else {
		return undefined;
	}
	return { upload: { operation: "upload", projectId, targetRelativePath, source: source.kind === "picker" ? { kind: "picker" } : { kind: "paths", paths: paths ?? [] } }, paths: paths ?? [] };
}

function errorEnvelope(error: unknown, fallback: string) {
	return opFailFromCode(codeOf(error, fallback));
}

function defaultDialogs(): Dialogs {
	const ownerOf = (sender: WebContents): BrowserWindow | undefined => (sender.isDestroyed() ? undefined : (BrowserWindow.fromWebContents(sender) ?? undefined));
	return {
		async openFiles(sender) {
			const owner = ownerOf(sender);
			const options = { properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections"> };
			const choice = owner === undefined ? await dialog.showOpenDialog(options) : await dialog.showOpenDialog(owner, options);
			return choice.canceled || !Array.isArray(choice.filePaths) || choice.filePaths.length === 0 ? undefined : choice.filePaths;
		},
		async saveFile(sender, defaultName) {
			const owner = ownerOf(sender);
			const options = { defaultPath: defaultName };
			const choice = owner === undefined ? await dialog.showSaveDialog(options) : await dialog.showSaveDialog(owner, options);
			return choice.canceled || typeof choice.filePath !== "string" || choice.filePath.length === 0 ? undefined : choice.filePath;
		},
	};
}

/** Best-effort sizes only. The upload worker re-hashes and re-stats every file before writing. */
async function readUploadSizes(paths: readonly string[]): Promise<{ total: number; sizes: number[] }> {
	const budget = createLocalIoBudget();
	const sizes: number[] = [];
	let total = 0;
	for (const path of paths) {
		let size = 0;
		if (!budget.exhausted()) {
			const started = Date.now();
			try {
				const info = await withLocalIoTimeout(stat(path), Math.min(LOCAL_FILE_IO_TIMEOUT_MS, budget.remaining()));
				if (info.isFile() && Number.isSafeInteger(info.size) && info.size >= 0 && info.size <= 8 * 1024 * 1024 * 1024) size = info.size;
			} catch {
				size = 0;
			}
			budget.spend(Date.now() - started);
		}
		sizes.push(size);
		if (Number.isSafeInteger(total + size)) total += size;
	}
	return { total, sizes };
}

function attachSender(registry: ReturnType<typeof createRemoteProjectTransferRegistry>, sender: WebContents): () => void {
	const senderId = sender.id;
	const onDestroyed = (): void => {
		registry.closeSender(senderId);
	};
	sender.once("destroyed", onDestroyed);
	return () => sender.removeListener("destroyed", onDestroyed);
}

function emit(sender: WebContents, event: RemoteTransferEvent): void {
	if (!sender.isDestroyed()) sender.send(ipcChannels.remoteProjectTransferEvent, event);
}

function emitSettlement(sender: WebContents, event: RemoteProjectTransferSettlement): void {
	if (event.outcome === "succeeded") {
		if (event.result === undefined) {
			emit(sender, { kind: "settled", jobId: event.jobId, operation: event.operation, outcome: "failed", code: "REMOTE_TRANSFER_RESULT_INVALID" });
			return;
		}
		emit(sender, { kind: "settled", ...event, result: event.result as RemoteTransferSettlementResult });
		return;
	}
	emit(sender, { kind: "settled", ...event });
}

export function registerRemoteProjectTransferJobIpc(input: RemoteProjectTransferJobIpcInput): RemoteProjectTransferJobIpcHandle {
	const projectTarget = createRemoteProjectTargetResolver({ service: input.service, locator: input.locator });
	const dialogs = input.dialogs ?? defaultDialogs();
	const probe = input.probe ?? createRemoteSftpCapabilityProbe({ ...(input.adapter === undefined ? {} : { adapter: input.adapter }) });
	const cache = input.cache ?? createRemoteSftpCapabilityCache<RemoteSftpProbe>();
	const adapter = input.adapter ?? runRemoteSftpJob;
	const uploadOne = input.uploadOne ?? uploadOneRemoteProjectFile;
	const registry = createRemoteProjectTransferRegistry();
	const senders = new Set<WebContents>();
	let disposed = false;

	const resolveTarget = async (projectId: string): Promise<RemoteProjectTarget | { code: string }> => {
		if (disposed) return { code: "REMOTE_CONNECTION_SERVICE_DISPOSED" };
		return projectTarget(projectId);
	};

	const createScope = (sender: WebContents, projectId: string, target: RemoteProjectTarget): RemoteProjectTransferScope | undefined => {
		const identity = target.service.projectTransferIdentity(target.hostId, target.remotePath);
		if (identity === undefined || identity.state !== "ready") return undefined;
		return {
			senderId: sender.id,
			projectId,
			hostId: target.hostId,
			canonicalRoot: target.remotePath,
			connectionId: identity.connectionId,
			hostRevision: identity.hostRevision,
		};
	};

	const runUpload = (event: { sender: WebContents; projectId: string; target: RemoteProjectTarget; targetRelativePath: string; paths: readonly string[]; sizes: readonly number[]; scope: RemoteProjectTransferScope; binary: RemoteSftpBinaryIdentity }): RemoteProjectTransferJobHandle => {
		const uploaded: Array<{ name: string; bytes: number }> = [];
		const failed: Array<{ name: string; code: string }> = [];
		const writtenPaths: string[] = [];
		let completed = 0;
		const total = event.sizes.reduce((sum, value) => (Number.isSafeInteger(sum + value) ? sum + value : sum), 0);
		const handle = registry.create({
			scope: event.scope,
			operation: "upload",
			total,
			onProgress: (progress) => emit(event.sender, { kind: "progress", ...progress }),
			onSettled: (settlement) => emitSettlement(event.sender, settlement),
		});
		const detach = attachSender(registry, event.sender);
		void (async () => {
			try {
				for (let index = 0; index < event.paths.length; index += 1) {
					const localPath = event.paths[index];
					const name = basename(localPath);
					const base = completed;
					try {
						const receipt: RemoteProjectUploadJobReceipt = await uploadOne(
							{
								service: event.target.service,
								hostId: event.target.hostId,
								canonicalRoot: event.target.remotePath,
								binaryPath: event.binary.path,
								sftp: { binaryIdentity: event.binary.identity, cache, probe },
								directory: event.targetRelativePath,
								localPath,
								signal: handle.signal,
								onProgress: (transferred) => {
									const value = Math.min(total, base + transferred);
									handle.reportProgress(value);
								},
							},
							{ adapter },
						);
						uploaded.push({ name: receipt.name, bytes: receipt.bytes });
						writtenPaths.push(receipt.relativePath);
						completed = Math.min(total, base + receipt.bytes);
						handle.reportProgress(completed);
					} catch (error) {
						const code = codeOf(error, REMOTE_TRANSFER_JOB_CODES.uploadFailed);
						const outcome = (error as { outcome?: unknown } | null)?.outcome;
						completed = Math.min(total, base + (event.sizes[index] ?? 0));
						handle.reportProgress(completed);
						if (outcome === "unknown") {
							if (writtenPaths.length > 0) input.afterWrite(event.projectId, writtenPaths);
							input.afterUnknown(event.projectId);
							handle.settle({ outcome: "unknown", code });
							return;
						}
						if (handle.signal.aborted) {
							if (writtenPaths.length > 0) input.afterWrite(event.projectId, writtenPaths);
							handle.settle({ outcome: "cancelled", code: "REMOTE_TRANSFER_CANCELLED" });
							return;
						}
						failed.push({ name, code });
					}
				}
				if (uploaded.length > 0) input.afterWrite(event.projectId, writtenPaths);
				if (uploaded.length === 0) {
					handle.settle({ outcome: "failed", code: failed[0]?.code ?? REMOTE_TRANSFER_JOB_CODES.uploadFailed });
					return;
				}
				const result: RemoteTransferUploadResult = { uploaded, failed };
				handle.settle({ outcome: "succeeded", result });
			} catch (error) {
				if (writtenPaths.length > 0) input.afterWrite(event.projectId, writtenPaths);
				handle.settle({ outcome: handle.signal.aborted ? "cancelled" : "failed", code: handle.signal.aborted ? "REMOTE_TRANSFER_CANCELLED" : codeOf(error, REMOTE_TRANSFER_JOB_CODES.uploadFailed) });
			} finally {
				detach();
			}
		})();
		return handle;
	};

	const runDownload = (event: { sender: WebContents; projectId: string; target: RemoteProjectTarget; targetRelativePath: string; localPath: string; total: number; scope: RemoteProjectTransferScope; binary: RemoteSftpBinaryIdentity }): RemoteProjectTransferJobHandle => {
		const handle = registry.create({
			scope: event.scope,
			operation: "download",
			total: event.total,
			onProgress: (progress) => emit(event.sender, { kind: "progress", ...progress }),
			onSettled: (settlement) => emitSettlement(event.sender, settlement),
		});
		const detach = attachSender(registry, event.sender);
		let sftpStarted = false;
		void (async () => {
			try {
				const outcome = await event.target.service.withProjectSession(
					event.target.hostId,
					event.target.remotePath,
					async (session) => {
						const capabilities = event.target.service.projectHelperCapabilities(event.target.hostId, event.target.remotePath);
						if (capabilities === undefined || !capabilities.includes("fs.stat")) throw new Error("REMOTE_DOWNLOAD_STAT_INVALID");
						const probed = await probe.ensureProbe({
							canonicalRoot: event.target.remotePath,
							binaryPath: event.binary.path,
							binaryIdentity: event.binary.identity,
							session,
							cache,
							signal: handle.signal,
						});
						if (!probed.ok) throw new Error(probed.code);
						const result = await session.withSftpInvocation(async (invocation, assertCurrent) => {
							await assertCurrent();
							if (handle.signal.aborted) {
								const error = new Error("REMOTE_TRANSFER_CANCELLED") as Error & { outcome?: "rejected" | "unknown" };
								error.outcome = "rejected";
								throw error;
							}
							sftpStarted = true;
							const value = await adapter(
								event.binary.path,
								{ operation: "download", invocation, root: event.target.remotePath, relative: event.targetRelativePath, localPath: event.localPath },
								{
									signal: handle.signal,
									onProgress: (progress) => {
										if (progress.operation === "download") handle.reportProgress(Math.min(event.total, progress.transferred));
									},
								},
							);
							await assertCurrent();
							return value;
						});
						if (!result.ok) {
							const error = new Error(result.code === "SFTP_JOB_CANCELLED" ? "REMOTE_TRANSFER_CANCELLED" : result.code) as Error & { outcome?: "rejected" | "unknown" };
							error.outcome = DOWNLOAD_UNCERTAIN_CODES.has(result.code) ? "unknown" : "rejected";
							throw error;
						}
						if (result.operation !== "download" || !Number.isSafeInteger(result.value.bytes) || result.value.bytes < 0) {
							const error = new Error("SFTP_RESULT_INVALID") as Error & { outcome?: "rejected" | "unknown" };
							error.outcome = "unknown";
							throw error;
						}
						return { path: event.localPath, bytes: result.value.bytes };
					},
					{ requireReady: true, signal: handle.signal },
				);
				if (!outcome.ok) throw new Error(outcome.code);
				handle.settle({ outcome: "succeeded", result: outcome.value });
			} catch (error) {
				const outcome = (error as { outcome?: unknown } | null)?.outcome;
				if (outcome === "unknown" || (sftpStarted && outcome !== "rejected")) {
					handle.settle({ outcome: "unknown", code: REMOTE_TRANSFER_JOB_CODES.downloadUnconfirmed });
					return;
				}
				handle.settle({ outcome: handle.signal.aborted ? "cancelled" : "failed", code: handle.signal.aborted ? "REMOTE_TRANSFER_CANCELLED" : codeOf(error, "REMOTE_TRANSFER_FAILED") });
			} finally {
				detach();
			}
		})();
		return handle;
	};

	ipcMain.handle(ipcChannels.remoteProjectTransferStart, async (event, rawInput: unknown) => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		const senderId = senderIdOf(event.sender);
		if (senderId === undefined) return opFailFromCode("REMOTE_TRANSFER_INPUT_INVALID");
		const parsed = readInput(rawInput);
		if (parsed === undefined) return opFailFromCode("REMOTE_TRANSFER_INPUT_INVALID");
		const projectId = "upload" in parsed ? parsed.upload.projectId : parsed.download.projectId;
		const target = await resolveTarget(projectId);
		if ("code" in target) return opFailFromCode(target.code);
		const scope = createScope(event.sender, projectId, target);
		if (scope === undefined) return opFailFromCode("SSH_HOST_NOT_READY");
		const binary = await input.binary();
		if (binary === undefined) return opFailFromCode(REMOTE_TRANSFER_JOB_CODES.binaryUnavailable);

		if ("upload" in parsed) {
			let paths = parsed.paths;
			if (parsed.upload.source.kind === "picker") {
				const picked = await dialogs.openFiles(event.sender);
				if (picked === undefined) return opOk({ canceled: true as const });
				const shape = parseLocalUploadPaths(picked);
				if (!shape.ok) return opFailFromCode("REMOTE_UPLOAD_INVALID_PATHS");
				paths = shape.paths;
			}
			const sizes = await readUploadSizes(paths);
			const total = sizes.sizes.reduce((sum, value) => sum + value, 0);
			const handle = runUpload({ sender: event.sender, projectId, target, targetRelativePath: parsed.upload.targetRelativePath, paths, sizes: sizes.sizes, scope, binary });
			senders.add(event.sender);
			return opOk({ jobId: handle.jobId, operation: "upload" as const, total });
		}

		const defaultName = basename(parsed.download.targetRelativePath);
		const localPath = await dialogs.saveFile(event.sender, defaultName);
		if (localPath === undefined) return opOk({ canceled: true as const });
		let total: number;
		try {
			const outcome = await target.service.withProjectSession(
				target.hostId,
				target.remotePath,
				async (session) => {
					const value = await session.request("fs.stat", { path: parsed.download.targetRelativePath }, { timeoutMs: 30_000 });
					if (!isRecord(value) || value.kind !== "file" || !Number.isSafeInteger(value.bytes) || (value.bytes as number) < 0) throw new Error(REMOTE_TRANSFER_JOB_CODES.downloadStatInvalid);
					return value.bytes as number;
				},
				{ requireReady: true },
			);
			if (!outcome.ok) throw new Error(outcome.code);
			total = outcome.value;
		} catch (error) {
			return errorEnvelope(error, REMOTE_TRANSFER_JOB_CODES.downloadStatInvalid);
		}
		const handle = runDownload({ sender: event.sender, projectId, target, targetRelativePath: parsed.download.targetRelativePath, localPath, total, scope, binary });
		senders.add(event.sender);
		return opOk({ jobId: handle.jobId, operation: "download" as const, total });
	});

	ipcMain.handle(ipcChannels.remoteProjectTransferCancel, async (event, projectIdValue: unknown, jobIdValue: unknown) => {
		if (!input.enabled) return opFailFromCode("REMOTE_FEATURE_DISABLED");
		const senderId = senderIdOf(event.sender);
		const projectId = readProjectId(projectIdValue);
		if (senderId === undefined || projectId === undefined || typeof jobIdValue !== "string") return opFailFromCode("REMOTE_TRANSFER_INPUT_INVALID");
		try {
			return opOk({ accepted: registry.cancel({ senderId, projectId, jobId: jobIdValue }) });
		} catch {
			return opFailFromCode("REMOTE_TRANSFER_INPUT_INVALID");
		}
	});

	return {
		closeProject(projectId): void {
			registry.closeProject(projectId);
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			for (const sender of senders) registry.closeSender(sender.id);
			senders.clear();
			cache.clear();
		},
	};
}
