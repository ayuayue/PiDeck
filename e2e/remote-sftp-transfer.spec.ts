import { createHash } from "node:crypto";
import { closeSync, ftruncateSync, mkdtempSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { REMOTE_ACCEPTANCE_ENV, REMOTE_APP_DATA_DIR_NAME, dismissRemoteConnectionProgress, openRemoteProjectFiles, readPinnedHostKeyFingerprint, readRemoteAcceptanceCredentials, readRemoteAcceptanceTimeouts, runRemoteCommand, test, type RemoteAcceptanceCredentials } from "./remote-fixtures";

const credentials = readRemoteAcceptanceCredentials(process.env);
const timeouts = readRemoteAcceptanceTimeouts(process.env);
const HELP_TEXT = "set " + [REMOTE_ACCEPTANCE_ENV.host, REMOTE_ACCEPTANCE_ENV.user, REMOTE_ACCEPTANCE_ENV.fingerprint].join(" / ") + " to run the real-host acceptance test";
const ACCEPTANCE_PARENT_SUFFIX = "/.pideck-acceptance/sftp-1-20261102";
const MiB = 1024 * 1024;

type ProjectView = {
	id: string;
	name: string;
	locator?: { kind: "ssh"; hostId: string; remotePath: string };
};

type TransferEvent =
	| { kind: "progress"; jobId: string; operation: "upload" | "download"; transferred: number; total: number }
	| { kind: "settled"; jobId: string; operation: "upload" | "download"; outcome: "succeeded"; result: unknown }
	| { kind: "settled"; jobId: string; operation: "upload" | "download"; outcome: "failed" | "cancelled" | "unknown"; code: string };

type TransferEvidence = {
	uploadProgress: boolean;
	downloadProgress: boolean;
	cancelled: boolean;
};

type StartReceipt = { ok: true; value: { canceled: true } | { canceled?: false; jobId: string; operation: "upload" | "download"; total: number } } | { ok: false; code: string; outcome?: "rejected" | "unknown" };

function q(value: string): string {
	return "'" + value.replace(/'/g, "'\\''") + "'";
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function makeSparse(path: string, bytes: number): void {
	const fd = openSync(path, "w");
	try {
		ftruncateSync(fd, bytes);
	} finally {
		closeSync(fd);
	}
}

async function remote(credentials: RemoteAcceptanceCredentials, script: string, timeoutMs = 60_000): Promise<string> {
	return (await runRemoteCommand(credentials, script, timeoutMs)).stdout.trim();
}

async function remoteExists(credentials: RemoteAcceptanceCredentials, path: string): Promise<boolean> {
	return (await remote(credentials, "test -e " + q(path) + " && printf YES || printf NO")).trim() === "YES";
}

async function remoteSha(credentials: RemoteAcceptanceCredentials, path: string): Promise<string> {
	const result = await remote(credentials, "sha256sum -- " + q(path) + " | awk '{print $1}'");
	expect(result).toMatch(/^[0-9a-f]{64}$/);
	return result;
}

async function remoteBytes(credentials: RemoteAcceptanceCredentials, path: string): Promise<number> {
	const value = Number(await remote(credentials, "stat -c %s -- " + q(path)));
	expect(Number.isSafeInteger(value) && value >= 0).toBe(true);
	return value;
}

async function dismissOnboarding(window: Page): Promise<void> {
	const dialog = window.locator('[role="dialog"]').filter({ hasText: "用命令面板直达任何设置" });
	await dialog.waitFor({ state: "visible", timeout: 8_000 }).catch(() => undefined);
	if ((await dialog.count()) > 0) {
		await dialog.getByRole("button", { name: "以后再说" }).click();
		await expect(dialog).toHaveCount(0);
	}
}

async function addAndConnectHost(window: Page, credentials: RemoteAcceptanceCredentials): Promise<string> {
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

async function enrollRemoteProject(window: Page, hostId: string, remotePath: string): Promise<string> {
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
				const timer = window.setTimeout(() => {
					unsubscribe();
					reject(new Error("timed out waiting for project enrollment confirmation"));
				}, 240_000);
				const unsubscribe = api.remoteHosts.onProjectEnrollConfirm((request) => {
					window.clearTimeout(timer);
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
							window.clearTimeout(timer);
							unsubscribe();
							reject(new Error("project enrollment failed: " + String(begin.code)));
						}
					},
					(error) => {
						window.clearTimeout(timer);
						unsubscribe();
						reject(error);
					},
				);
			});
		},
		{ hostId, remotePath },
	);
}

async function listProjects(window: Page): Promise<ProjectView[]> {
	return (await window.evaluate(async () => {
		const api = (window as unknown as { piDesktop: { projects: { list: () => Promise<unknown> } } }).piDesktop;
		return api.projects.list();
	})) as ProjectView[];
}

async function setOpenDialog(app: ElectronApplication, paths: readonly string[]): Promise<void> {
	await app.evaluate(({ dialog }, filePaths) => {
		dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [...filePaths] });
	}, paths);
}

async function setSaveDialog(app: ElectronApplication, path: string): Promise<void> {
	await app.evaluate(({ dialog }, filePath) => {
		dialog.showSaveDialog = async () => ({ canceled: false, filePath });
	}, path);
}

async function openProjectPanel(window: Page, projectId: string): Promise<void> {
	await dismissOnboarding(window);
	await window.getByRole("tab", { name: "项目" }).click();
	await window
		.locator('[data-project-row-id="' + projectId + '"] .conversation-title')
		.first()
		.click();
	await openRemoteProjectFiles(window);
	await expect(window.getByTestId("remote-file-toolbar")).toBeVisible({ timeout: timeouts.helperMs });
	// Toolbar visibility only proves the drawer mounted. Starting the transfer before the
	// project's root page has loaded races the connection/root switch that owns the transfer.
	await expect(window.getByTestId("remote-file-upload")).toBeEnabled({ timeout: timeouts.helperMs });
}

async function dismissTerminalTransfers(window: Page): Promise<void> {
	for (let index = 0; index < 20; index += 1) {
		const dismiss = window.getByTestId(/remote-transfer-dismiss-/).first();
		if ((await dismiss.count()) === 0) return;
		await dismiss.click();
	}
	throw new Error("too many terminal transfer cards to dismiss");
}

async function waitForTransferPhase(window: Page, phase: string, timeoutMs: number): Promise<void> {
	await expect(
		window
			.getByTestId("remote-transfer-status")
			.locator('[data-phase="' + phase + '"]')
			.last(),
	).toBeVisible({ timeout: timeoutMs });
}

async function installTransferRecorder(window: Page): Promise<void> {
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

async function clearTransferEvents(window: Page): Promise<void> {
	await window.evaluate(() => {
		const holder = window as unknown as { __pideckSftpEvents?: unknown[] };
		holder.__pideckSftpEvents = [];
	});
}

async function transferEvents(window: Page): Promise<TransferEvent[]> {
	return (await window.evaluate(() => {
		const holder = window as unknown as { __pideckSftpEvents?: unknown[] };
		return holder.__pideckSftpEvents ?? [];
	})) as TransferEvent[];
}

async function transferEvidence(window: Page): Promise<TransferEvidence> {
	return (await window.evaluate(() => {
		const holder = window as unknown as { __pideckSftpEvidence?: TransferEvidence };
		return holder.__pideckSftpEvidence ?? { uploadProgress: false, downloadProgress: false, cancelled: false };
	})) as TransferEvidence;
}

async function waitForEvent<T>(window: Page, select: (events: readonly TransferEvent[]) => T | undefined, timeoutMs: number, label: string): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		const selected = select(await transferEvents(window));
		if (selected !== undefined) return selected;
		await window.waitForTimeout(100);
	}
	throw new Error("timed out waiting for " + label);
}

async function waitJobSettled(window: Page, jobId: string, timeoutMs: number): Promise<Extract<TransferEvent, { kind: "settled" }>> {
	return await waitForEvent(window, (events) => events.find((event): event is Extract<TransferEvent, { kind: "settled" }> => event.kind === "settled" && event.jobId === jobId), timeoutMs, "transfer " + jobId + " settlement");
}

async function startPathUpload(window: Page, projectId: string, path: string): Promise<{ jobId: string; total: number }> {
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

async function cancelJob(window: Page, projectId: string, jobId: string): Promise<void> {
	const receipt = (await window.evaluate(
		async ({ projectId: targetProject, jobId: targetJob }) => {
			const api = (window as unknown as { piDesktop: { remoteTransfers: { cancel: (projectId: string, jobId: string) => Promise<unknown> } } }).piDesktop;
			return api.remoteTransfers.cancel(targetProject, targetJob);
		},
		{ projectId, jobId },
	)) as { ok: boolean; value?: { accepted?: boolean }; code?: string };
	expect(receipt.ok && receipt.value?.accepted === true, "transfer cancel must be accepted: " + String(receipt.code)).toBe(true);
}

async function removeProject(window: Page, projectId: string): Promise<void> {
	await window.evaluate(async (id) => {
		const api = (window as unknown as { piDesktop: { projects: { remove: (projectId: string) => Promise<unknown> } } }).piDesktop;
		return api.projects.remove(id);
	}, projectId);
}

test.describe("SFTP-1 真实传输验收", () => {
	test.skip(credentials === undefined, HELP_TEXT);

	test("系统 OpenSSH SFTP：上传/下载/进度/取消/冲突/双项目隔离", async ({ remoteApp, remoteWindow, remoteUserDataRoot }) => {
		test.setTimeout(1_800_000);
		const creds = credentials;
		if (creds === undefined) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const window = remoteWindow;
		const runId = "sftp-" + Date.now().toString(36);
		const remoteHome = await remote(creds, 'printf %s "$HOME"', 30_000);
		expect(remoteHome.startsWith("/")).toBe(true);
		const remoteRoot = remoteHome + ACCEPTANCE_PARENT_SUFFIX + "/runs/" + runId;
		const projectAPath = remoteRoot + "/a";
		const projectBPath = remoteRoot + "/b";
		const deniedPath = projectAPath + "/denied";
		const localRoot = mkdtempSync(join(tmpdir(), "pideck-sftp-e2e-"));
		const emptyPath = join(localRoot, "empty.bin");
		const unicodePath = join(localRoot, "中文 空格.bin");
		const largePath = join(localRoot, "large-32MiB.bin");
		const cancelPath = join(localRoot, "cancel-256MiB.bin");
		const batchNewPath = join(localRoot, "batch-new.bin");
		const batchExistingPath = join(localRoot, "batch-existing.bin");
		const parallelBPath = join(localRoot, "parallel-b.bin");
		const reopenedPath = join(localRoot, "reopened-a.bin");
		const downloadPath = join(localRoot, "download-result.bin");
		let hostId: string | undefined;
		let projectAId: string | undefined;
		let projectBId: string | undefined;
		let deniedRestored = false;
		let spoolBaseline = 0;
		const timings: Record<string, number> = {};

		writeFileSync(emptyPath, Buffer.alloc(0));
		writeFileSync(unicodePath, "SFTP unicode and space path\n");
		makeSparse(largePath, 32 * MiB);
		makeSparse(cancelPath, 256 * MiB);
		writeFileSync(batchNewPath, "batch-new\n");
		writeFileSync(batchExistingPath, "local replacement must never be published\n");
		writeFileSync(parallelBPath, "parallel project B survives A cancellation\n");
		writeFileSync(reopenedPath, "reopened project A still transfers\n");

		try {
			await test.step("远端前置：两个项目根、权限拒绝子目录与同名目标（只写本 run 目录）", async () => {
				await remote(
					creds,
					[
						"set -eu",
						"umask 077",
						"mkdir -p " + q(projectAPath + "/denied") + " " + q(projectBPath),
						"chmod 700 " + q(remoteRoot) + " " + q(projectAPath) + " " + q(projectBPath),
						"chmod 500 " + q(deniedPath),
						"printf 'REMOTE_ORIGINAL\\n' > " + q(projectAPath + "/batch-existing.bin"),
						"printf 'B_PROJECT\\n' > " + q(projectBPath + "/hello-b.txt"),
					].join("; "),
					60_000,
				);
				spoolBaseline = Number(await remote(creds, "find \"$HOME/.pideck/remote-host/upload-spool\" -maxdepth 1 -type f -name '*.part' -printf '.\\n' 2>/dev/null | wc -l"));
				expect(await remoteExists(creds, deniedPath)).toBe(true);
				await dismissOnboarding(window);
			});

			await test.step("加主机并连接；主机密钥 pin 命中注入指纹", async () => {
				hostId = await addAndConnectHost(window, creds);
				const pinDeadline = Date.now() + 30_000;
				let pinned: string | undefined;
				while (Date.now() < pinDeadline && pinned === undefined) {
					pinned = readPinnedHostKeyFingerprint(join(remoteUserDataRoot, REMOTE_APP_DATA_DIR_NAME), creds.host);
					if (pinned === undefined) await window.waitForTimeout(200);
				}
				expect(pinned).toBe(creds.fingerprint);
			});

			await test.step("登记同 host 的两个远端项目（产品登记链路 + canonical 再核验）", async () => {
				if (hostId === undefined) throw new Error("hostId missing");
				projectAId = await enrollRemoteProject(window, hostId, projectAPath);
				projectBId = await enrollRemoteProject(window, hostId, projectBPath);
				const projects = await listProjects(window);
				expect(projects.find((project) => project.id === projectAId)?.locator?.remotePath).toBe(projectAPath);
				expect(projects.find((project) => project.id === projectBId)?.locator?.remotePath).toBe(projectBPath);
				// The spec answers the enrollment confirmation directly instead of going through
				// useRemoteProjectEnroll, whose onEnrolled callback refreshes the renderer inventory. Reload
				// the renderer so the sidebar consumes the durable projects that main just wrote.
				await window.reload({ waitUntil: "domcontentloaded" });
				await window
					.locator("#boot-overlay")
					.waitFor({ state: "detached", timeout: 30_000 })
					.catch(() => undefined);
				await dismissOnboarding(window);
			});

			await installTransferRecorder(window);

			await test.step("UI 上传空文件 + 中文/空格文件名：真实字节与文件名一致", async () => {
				if (projectAId === undefined) throw new Error("project A missing");
				await openProjectPanel(window, projectAId);
				await setOpenDialog(remoteApp, [emptyPath, unicodePath]);
				await expect(window.getByTestId("remote-file-upload")).toBeEnabled();
				const startedAt = Date.now();
				await window.getByTestId("remote-file-upload").click();
				await expect(window.getByTestId("remote-transfer-status")).toBeVisible();
				await waitForTransferPhase(window, "succeeded", timeouts.helperMs);
				timings.unicodeUploadMs = Date.now() - startedAt;
				expect(await remoteBytes(creds, projectAPath + "/empty.bin")).toBe(0);
				expect(await remoteSha(creds, projectAPath + "/中文 空格.bin")).toBe(sha256File(unicodePath));
				await dismissTerminalTransfers(window);
			});

			await test.step("UI 上传 32 MiB：观察 running/progress，完成后独立核对摘要", async () => {
				await clearTransferEvents(window);
				await setOpenDialog(remoteApp, [largePath]);
				const startedAt = Date.now();
				await window.getByTestId("remote-file-upload").click();
				await waitForTransferPhase(window, "running", 30_000);
				await expect(window.getByRole("progressbar").last()).toBeVisible();
				const progress = await waitForEvent(window, (events) => events.find((event): event is Extract<TransferEvent, { kind: "progress" }> => event.kind === "progress" && event.operation === "upload" && event.transferred > 0), timeouts.helperMs, "32 MiB upload progress");
				expect(progress.total).toBe(32 * MiB);
				await waitForTransferPhase(window, "succeeded", timeouts.helperMs);
				timings.largeUploadMs = Date.now() - startedAt;
				const settled = await waitJobSettled(window, progress.jobId, timeouts.helperMs);
				expect(settled.outcome).toBe("succeeded");
				expect(await remoteSha(creds, projectAPath + "/large-32MiB.bin")).toBe(sha256File(largePath));
				await dismissTerminalTransfers(window);
			});

			await test.step("UI 同名再传：明确失败且远端原文件摘要不变（不覆盖）", async () => {
				const before = await remoteSha(creds, projectAPath + "/large-32MiB.bin");
				await setOpenDialog(remoteApp, [largePath]);
				await window.getByTestId("remote-file-upload").click();
				await waitForTransferPhase(window, "failed", timeouts.helperMs);
				await expect(window.getByTestId("remote-transfer-status")).toContainText("未覆盖");
				expect(await remoteSha(creds, projectAPath + "/large-32MiB.bin")).toBe(before);
				await dismissTerminalTransfers(window);
			});

			await test.step("UI 批量上传部分失败：新文件成功、已有目标保持原字节", async () => {
				await setOpenDialog(remoteApp, [batchNewPath, batchExistingPath]);
				await window.getByTestId("remote-file-upload").click();
				await waitForTransferPhase(window, "partial", timeouts.helperMs);
				await expect(window.getByTestId("remote-transfer-status")).toContainText("1");
				expect(await remoteSha(creds, projectAPath + "/batch-new.bin")).toBe(sha256File(batchNewPath));
				expect(await remote(creds, "cat -- " + q(projectAPath + "/batch-existing.bin"))).toBe("REMOTE_ORIGINAL");
				await dismissTerminalTransfers(window);
			});

			await test.step("UI 下载 32 MiB：观察进度，保存到本地后摘要与远端一致", async () => {
				await clearTransferEvents(window);
				await setSaveDialog(remoteApp, downloadPath);
				const row = window
					.locator(".file-node")
					.filter({ has: window.locator(".file-node-name", { hasText: "large-32MiB.bin" }) })
					.last();
				await expect(row).toBeVisible();
				await row.locator("button").first().click({ button: "right" });
				await window.getByTestId("remote-file-row-download").click();
				await waitForTransferPhase(window, "running", 30_000);
				await expect(window.getByRole("progressbar").last()).toBeVisible();
				const progress = await waitForEvent(window, (events) => events.find((event): event is Extract<TransferEvent, { kind: "progress" }> => event.kind === "progress" && event.operation === "download" && event.transferred > 0), timeouts.helperMs, "32 MiB download progress");
				expect(progress.total).toBe(32 * MiB);
				await waitForTransferPhase(window, "succeeded", timeouts.helperMs);
				expect(statSync(downloadPath).size).toBe(32 * MiB);
				expect(sha256File(downloadPath)).toBe(sha256File(largePath));
				await dismissTerminalTransfers(window);
			});

			await test.step("UI 在 SFTP 分块进度后取消 256 MiB：目标不发布、spool 收敛", async () => {
				await clearTransferEvents(window);
				await setOpenDialog(remoteApp, [cancelPath]);
				await window.getByTestId("remote-file-upload").click();
				const progress = await waitForEvent(window, (events) => events.find((event): event is Extract<TransferEvent, { kind: "progress" }> => event.kind === "progress" && event.operation === "upload" && event.transferred > 0), timeouts.helperMs, "cancel fixture SFTP progress");
				await expect(window.getByTestId("remote-transfer-status").locator('[data-phase="running"]').last()).toBeVisible();
				expect(progress.transferred).toBeGreaterThan(0);
				const cancel = window.getByTestId(/remote-transfer-cancel-/).last();
				await cancel.click();
				await waitForTransferPhase(window, "cancelled", timeouts.helperMs);
				expect(await remoteExists(creds, projectAPath + "/cancel-256MiB.bin")).toBe(false);
				let spoolCount = Number.MIN_SAFE_INTEGER;
				const deadline = Date.now() + 20_000;
				while (Date.now() < deadline) {
					spoolCount = Number(await remote(creds, "find \"$HOME/.pideck/remote-host/upload-spool\" -maxdepth 1 -type f -name '*.part' -printf '.\\n' 2>/dev/null | wc -l"));
					if (spoolCount <= spoolBaseline) break;
					await window.waitForTimeout(250);
				}
				expect(spoolCount).toBeLessThanOrEqual(spoolBaseline);
				await dismissTerminalTransfers(window);
			});

			await test.step("权限拒绝目录：上传失败且目标不出现", async () => {
				if (projectAId === undefined) throw new Error("project A missing");
				await clearTransferEvents(window);
				const receipt = (await window.evaluate(
					async ({ projectId, path }) => {
						const api = (window as unknown as { piDesktop: { remoteTransfers: { start: (value: unknown) => Promise<unknown> } } }).piDesktop;
						return api.remoteTransfers.start({ operation: "upload", projectId, targetRelativePath: "denied", source: { kind: "paths", paths: [path] } });
					},
					{ projectId: projectAId, path: reopenedPath },
				)) as StartReceipt;
				expect(receipt.ok, "permission-denied upload must enter the job state machine: " + String(receipt.ok ? "" : receipt.code)).toBe(true);
				if (!receipt.ok || receipt.value.canceled === true) throw new Error("permission-denied upload did not start");
				const settled = await waitJobSettled(window, receipt.value.jobId, timeouts.helperMs);
				expect(settled.outcome).toBe("failed");
				expect(await remoteExists(creds, deniedPath + "/reopened-a.bin")).toBe(false);
				await remote(creds, "chmod 700 " + q(deniedPath));
				deniedRestored = true;
			});

			await test.step("同 host 双项目并行：A 取消不影响 B 成功", async () => {
				if (projectAId === undefined || projectBId === undefined) throw new Error("projects missing");
				await clearTransferEvents(window);
				// The product UI starts transfers from a project file drawer, which has already read that
				// project's root. Warm both roots before exercising the lower-level IPC in parallel; starting
				// from an unopened project would test a pre-start state the UI never exposes.
				await openProjectPanel(window, projectBId);
				await openProjectPanel(window, projectAId);
				const jobA = await startPathUpload(window, projectAId, cancelPath);
				const progressA = await waitForEvent(window, (events) => events.find((event): event is Extract<TransferEvent, { kind: "progress" }> => event.kind === "progress" && event.jobId === jobA.jobId && event.transferred > 0), timeouts.helperMs, "parallel A progress");
				expect(progressA.operation).toBe("upload");
				const jobB = await startPathUpload(window, projectBId, parallelBPath);
				const settledB = await waitJobSettled(window, jobB.jobId, timeouts.helperMs);
				expect(settledB.outcome).toBe("succeeded");
				expect(await remoteSha(creds, projectBPath + "/parallel-b.bin")).toBe(sha256File(parallelBPath));
				await cancelJob(window, projectAId, jobA.jobId);
				const settledA = await waitJobSettled(window, jobA.jobId, timeouts.helperMs);
				expect(settledA.outcome).toBe("cancelled");
				expect(await remoteExists(creds, projectAPath + "/cancel-256MiB.bin")).toBe(false);
			});

			await test.step("关闭 A 不打断 B 的在途传输；重开 A 后仍可传输", async () => {
				if (projectAId === undefined || projectBId === undefined) throw new Error("projects missing");
				await clearTransferEvents(window);
				const jobB = await startPathUpload(window, projectBId, largePath);
				await waitForEvent(window, (events) => events.find((event): event is Extract<TransferEvent, { kind: "progress" }> => event.kind === "progress" && event.jobId === jobB.jobId && event.transferred > 0), timeouts.helperMs, "close-isolation B progress");
				await removeProject(window, projectAId);
				projectAId = undefined;
				const settledB = await waitJobSettled(window, jobB.jobId, timeouts.helperMs);
				expect(settledB.outcome).toBe("succeeded");
				expect(await remoteSha(creds, projectBPath + "/large-32MiB.bin")).toBe(sha256File(largePath));
				if (hostId === undefined) throw new Error("hostId missing");
				projectAId = await enrollRemoteProject(window, hostId, projectAPath);
				const reopened = await startPathUpload(window, projectAId, reopenedPath);
				const settled = await waitJobSettled(window, reopened.jobId, timeouts.helperMs);
				expect(settled.outcome).toBe("succeeded");
				expect(await remoteSha(creds, projectAPath + "/reopened-a.bin")).toBe(sha256File(reopenedPath));
			});

			const events = await transferEvents(window);
			const evidence = await transferEvidence(window);
			expect(evidence.uploadProgress).toBe(true);
			expect(evidence.downloadProgress).toBe(true);
			expect(evidence.cancelled).toBe(true);
			await test.info().attach("remote-sftp-acceptance", {
				body: Buffer.from(
					JSON.stringify(
						{
							host: creds.host,
							user: creds.user,
							acceptanceRoot: remoteRoot,
							projectAId,
							projectBId,
							timings,
							eventCount: events.length,
							evidence,
							largeUpload: {
								bytes: statSync(largePath).size,
								sha256: sha256File(largePath),
							},
							unicodeBytes: statSync(unicodePath).size,
							downloadBytes: statSync(downloadPath).size,
							cancelTargetPublished: await remoteExists(creds, projectAPath + "/cancel-256MiB.bin"),
						},
						null,
						2,
					),
				),
				contentType: "application/json",
			});
		} finally {
			try {
				const projects = await listProjects(window);
				for (const project of projects) {
					if (project.locator?.hostId === hostId) await removeProject(window, project.id);
				}
			} catch {
				// The renderer may already be closing; the isolated profile still prevents persistent references.
			}
			if (hostId !== undefined) {
				try {
					await window.evaluate(async (id) => {
						const api = (window as unknown as { piDesktop: { remoteHosts: { remove: (hostId: string) => Promise<unknown> } } }).piDesktop;
						return api.remoteHosts.remove(id);
					}, hostId);
				} catch {
					// Best effort cleanup after the acceptance assertions.
				}
			}
			if (!deniedRestored) await remote(creds, "chmod 700 " + q(deniedPath) + " 2>/dev/null || true").catch(() => undefined);
			await remote(creds, "target=$(realpath -m " + q(remoteRoot) + "); " + "expected=" + q(remoteRoot) + '; test "$target" = "$expected" && rm -rf -- "$target"', 120_000).catch(() => undefined);
			await rm(localRoot, { recursive: true, force: true });
		}
	});
});
