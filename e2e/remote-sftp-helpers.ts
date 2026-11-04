import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, openSync, readFileSync } from "node:fs";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { dismissRemoteConnectionProgress, openRemoteProjectFiles, readRemoteAcceptanceTimeouts, runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

const timeouts = readRemoteAcceptanceTimeouts(process.env);

export type ProjectView = {
	id: string;
	name: string;
	locator?: { kind: "ssh"; hostId: string; remotePath: string };
};

export type TransferEvent =
	| { kind: "progress"; jobId: string; operation: "upload" | "download"; transferred: number; total: number }
	| { kind: "settled"; jobId: string; operation: "upload" | "download"; outcome: "succeeded"; result: unknown }
	| { kind: "settled"; jobId: string; operation: "upload" | "download"; outcome: "failed" | "cancelled" | "unknown"; code: string };

export type TransferEvidence = {
	uploadProgress: boolean;
	downloadProgress: boolean;
	cancelled: boolean;
};

export type StartReceipt = { ok: true; value: { canceled: true } | { canceled?: false; jobId: string; operation: "upload" | "download"; total: number } } | { ok: false; code: string; outcome?: "rejected" | "unknown" };

export function q(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

export function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function makeSparse(path: string, bytes: number): void {
	const fd = openSync(path, "w");
	try {
		ftruncateSync(fd, bytes);
	} finally {
		closeSync(fd);
	}
}

export async function remote(credentials: RemoteAcceptanceCredentials, script: string, timeoutMs = 60_000): Promise<string> {
	return (await runRemoteCommand(credentials, script, timeoutMs)).stdout.trim();
}

export async function remoteExists(credentials: RemoteAcceptanceCredentials, path: string): Promise<boolean> {
	return (await remote(credentials, "test -e " + q(path) + " && printf YES || printf NO")).trim() === "YES";
}

export async function remoteSha(credentials: RemoteAcceptanceCredentials, path: string): Promise<string> {
	const result = await remote(credentials, "sha256sum -- " + q(path) + " | awk '{print $1}'");
	expect(result).toMatch(/^[0-9a-f]{64}$/);
	return result;
}

export async function remoteBytes(credentials: RemoteAcceptanceCredentials, path: string): Promise<number> {
	const value = Number(await remote(credentials, "stat -c %s -- " + q(path)));
	expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
	return value;
}

export async function dismissOnboarding(window: Page): Promise<void> {
	const dialog = window.locator('[role="dialog"]').filter({ hasText: "用命令面板直达任何设置" });
	await dialog.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
	if ((await dialog.count()) > 0) {
		await dialog.getByRole("button", { name: "以后再说" }).click();
		await expect(dialog).toHaveCount(0);
	}
}

export async function addAndConnectHost(window: Page, credentials: RemoteAcceptanceCredentials): Promise<string> {
	const added = (await window.evaluate(
		async (input) => {
			const api = (window as unknown as { piDesktop: { remoteHosts: { add: (value: unknown) => Promise<unknown> } } }).piDesktop;
			return api.remoteHosts.add(input);
		},
		{ label: "sftp-acceptance", hostName: credentials.host, user: credentials.user, port: credentials.port },
	)) as { ok: boolean; hostId?: string; code?: string };
	expect(added.ok, "add host must succeed: " + String(added.code)).toBe(true);
	if (typeof added.hostId !== "string") throw new Error("add host returned no hostId");
	const connected = (await window.evaluate(async (hostId) => {
		const api = (window as unknown as { piDesktop: { remoteHosts: { connect: (id: string) => Promise<unknown> } } }).piDesktop;
		return api.remoteHosts.connect(hostId);
	}, added.hostId)) as { ok: boolean; state?: string; code?: string };
	expect(connected.ok, "connect must succeed: " + String(connected.code)).toBe(true);
	expect(connected.state).toBe("ready");
	await dismissRemoteConnectionProgress(window);
	return added.hostId;
}

export async function enrollRemoteProject(window: Page, hostId: string, remotePath: string): Promise<string> {
	return await window.evaluate(
		async ({ hostId: targetHostId, remotePath: targetPath }) => {
			const api = (
				window as unknown as {
					piDesktop: {
						remoteHosts: {
							enrollProject: (hostId: string, path: string, mode?: "existing" | "create") => Promise<unknown>;
							answerProjectEnroll: (requestId: string, choice: "approve" | "deny") => Promise<unknown>;
							onProjectEnrollConfirm: (callback: (request: { requestId: string; canonicalPath: string }) => void) => () => void;
						};
					};
				}
			).piDesktop;
			return await new Promise<string>((resolve, reject) => {
				const timer = globalThis.setTimeout(() => {
					unsubscribe();
					reject(new Error("timed out waiting for project enrollment confirmation"));
				}, 240_000);
				const unsubscribe = api.remoteHosts.onProjectEnrollConfirm((request) => {
					globalThis.clearTimeout(timer);
					unsubscribe();
					if (request.canonicalPath !== targetPath) {
						reject(new Error("enrollment canonical path changed"));
						return;
					}
					void api.remoteHosts.answerProjectEnroll(request.requestId, "approve").then(
						(result) => {
							const answer = result as { ok: boolean; code?: string; value?: { enrolled?: boolean; projectId?: string } };
							if (!answer.ok || answer.value?.enrolled !== true || typeof answer.value.projectId !== "string") {
								reject(new Error("enrollment answer failed: " + String(answer.code)));
								return;
							}
							resolve(answer.value.projectId);
						},
						(error) => reject(error),
					);
				});
				void api.remoteHosts.enrollProject(targetHostId, targetPath, "existing").then(
					(result) => {
						const begin = result as { ok: boolean; code?: string };
						if (!begin.ok) {
							globalThis.clearTimeout(timer);
							unsubscribe();
							reject(new Error("project enrollment failed: " + String(begin.code)));
						}
					},
					(error) => {
						globalThis.clearTimeout(timer);
						unsubscribe();
						reject(error);
					},
				);
			});
		},
		{ hostId, remotePath },
	);
}

export async function listProjects(window: Page): Promise<ProjectView[]> {
	return (await window.evaluate(async () => {
		const api = (window as unknown as { piDesktop: { projects: { list: () => Promise<unknown> } } }).piDesktop;
		return api.projects.list();
	})) as ProjectView[];
}

export async function setOpenDialog(app: ElectronApplication, paths: readonly string[]): Promise<void> {
	await app.evaluate(({ dialog }, filePaths) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [...filePaths] });
	}, paths);
}

export async function setSaveDialog(app: ElectronApplication, path: string): Promise<void> {
	await app.evaluate(({ dialog }, filePath) => {
		dialog.showSaveDialog = async () => ({ canceled: false, filePath });
	}, path);
}

export async function openProjectPanel(window: Page, projectId: string, readyMs = timeouts.helperMs): Promise<number> {
	const started = Date.now();
	await window.getByRole("tab", { name: "项目" }).click();
	await window
		.locator('[data-project-row-id="' + projectId + '"] .conversation-title')
		.first()
		.click();
	await openRemoteProjectFiles(window);
	await expect(window.getByTestId("remote-file-toolbar")).toBeVisible({ timeout: readyMs });
	// Toolbar visibility only proves the drawer mounted. Starting the transfer before the
	// project's root page has loaded races the connection/root switch that owns the transfer.
	await expect(window.getByTestId("remote-file-upload")).toBeEnabled({ timeout: readyMs });
	const elapsed = Date.now() - started;
	expect(elapsed, "project switch including upload readiness").toBeLessThan(readyMs);
	return elapsed;
}

export async function dismissTerminalTransfers(window: Page): Promise<void> {
	for (let index = 0; index < 20; index += 1) {
		const dismiss = window.getByTestId(/remote-transfer-dismiss-/).first();
		if ((await dismiss.count()) === 0) return;
		await dismiss.click();
	}
	throw new Error("too many terminal transfer cards to dismiss");
}

export async function waitForTransferPhase(window: Page, phase: string, timeoutMs: number): Promise<void> {
	await expect(
		window
			.getByTestId("remote-transfer-status")
			.locator('[data-phase="' + phase + '"]')
			.last(),
	).toBeVisible({ timeout: timeoutMs });
}

export async function installTransferRecorder(window: Page): Promise<void> {
	await window.evaluate(() => {
		const holder = window as unknown as {
			__pideckSftpEvents?: unknown[];
			__pideckSftpEvidence?: TransferEvidence;
			__pideckSftpUnsubscribe?: () => void;
			piDesktop: { remoteTransfers: { onEvent: (callback: (event: unknown) => void) => () => void } };
		};
		holder.__pideckSftpUnsubscribe?.();
		holder.__pideckSftpEvents = [];
		holder.__pideckSftpEvidence = { uploadProgress: false, downloadProgress: false, cancelled: false };
		holder.__pideckSftpUnsubscribe = holder.piDesktop.remoteTransfers.onEvent((event) => {
			const events = holder.__pideckSftpEvents;
			if (events !== undefined && events.length < 30_000) events.push(event);
			const evidence = holder.__pideckSftpEvidence;
			if (evidence === undefined || typeof event !== "object" || event === null) return;
			const value = event as Partial<TransferEvent>;
			if (value.kind === "progress" && typeof value.transferred === "number" && value.transferred > 0) {
				if (value.operation === "upload") evidence.uploadProgress = true;
				if (value.operation === "download") evidence.downloadProgress = true;
			}
			if (value.kind === "settled" && value.outcome === "cancelled") evidence.cancelled = true;
		});
	});
}

export async function clearTransferEvents(window: Page): Promise<void> {
	await window.evaluate(() => {
		const holder = window as unknown as { __pideckSftpEvents?: unknown[] };
		holder.__pideckSftpEvents = [];
	});
}

export async function transferEvents(window: Page): Promise<TransferEvent[]> {
	return (await window.evaluate(() => {
		const holder = window as unknown as { __pideckSftpEvents?: unknown[] };
		return holder.__pideckSftpEvents ?? [];
	})) as TransferEvent[];
}

export async function transferEvidence(window: Page): Promise<TransferEvidence> {
	return (await window.evaluate(() => {
		const holder = window as unknown as { __pideckSftpEvidence?: TransferEvidence };
		return holder.__pideckSftpEvidence ?? { uploadProgress: false, downloadProgress: false, cancelled: false };
	})) as TransferEvidence;
}

export async function waitForEvent<T>(window: Page, select: (events: readonly TransferEvent[]) => T | undefined, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const selected = select(await transferEvents(window));
		if (selected !== undefined) return selected;
		await window.waitForTimeout(100);
	}
	throw new Error("timed out waiting for " + label);
}

export async function waitJobSettled(window: Page, jobId: string, timeoutMs: number): Promise<Extract<TransferEvent, { kind: "settled" }>> {
	return await waitForEvent(window, (events) => events.find((event): event is Extract<TransferEvent, { kind: "settled" }> => event.kind === "settled" && event.jobId === jobId), timeoutMs, "transfer " + jobId + " settlement");
}

export async function startPathUpload(window: Page, projectId: string, path: string): Promise<{ jobId: string; total: number }> {
	const receipt = (await window.evaluate(
		async (input) => {
			const api = (window as unknown as { piDesktop: { remoteTransfers: { start: (value: unknown) => Promise<unknown> } } }).piDesktop;
			return api.remoteTransfers.start(input);
		},
		{ operation: "upload", projectId, targetRelativePath: "", source: { kind: "paths", paths: [path] } },
	)) as StartReceipt;
	expect(receipt.ok, "direct upload start must succeed: " + String(receipt.ok ? "" : receipt.code)).toBe(true);
	if (!receipt.ok || receipt.value.canceled === true) throw new Error("direct upload did not start");
	return { jobId: receipt.value.jobId, total: receipt.value.total };
}

export async function cancelJob(window: Page, projectId: string, jobId: string): Promise<void> {
	const receipt = (await window.evaluate(
		async ({ projectId: targetProject, jobId: targetJob }) => {
			const api = (window as unknown as { piDesktop: { remoteTransfers: { cancel: (projectId: string, jobId: string) => Promise<unknown> } } }).piDesktop;
			return api.remoteTransfers.cancel(targetProject, targetJob);
		},
		{ projectId, jobId },
	)) as { ok: boolean; value?: { accepted?: boolean }; code?: string };
	expect(receipt.ok && receipt.value?.accepted === true, "transfer cancel must be accepted: " + String(receipt.code)).toBe(true);
}

export async function removeProject(window: Page, projectId: string): Promise<void> {
	await window.evaluate(async (id) => {
		const api = (window as unknown as { piDesktop: { projects: { remove: (projectId: string) => Promise<unknown> } } }).piDesktop;
		return api.projects.remove(id);
	}, projectId);
}
