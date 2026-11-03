import { mkdtempSync, statSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "@playwright/test";
import type { PiDesktopApi } from "../src/preload";
import { REMOTE_ACCEPTANCE_ENV, REMOTE_APP_DATA_DIR_NAME, readPinnedHostKeyFingerprint, readRemoteAcceptanceCredentials, readRemoteAcceptanceTimeouts, test } from "./remote-fixtures";
import {
	addAndConnectHost,
	cancelJob,
	clearTransferEvents,
	dismissOnboarding,
	dismissTerminalTransfers,
	enrollRemoteProject,
	installTransferRecorder,
	listProjects,
	makeSparse,
	openProjectPanel,
	q,
	remote,
	remoteBytes,
	remoteExists,
	remoteSha,
	removeProject,
	setOpenDialog,
	setSaveDialog,
	sha256File,
	startPathUpload,
	transferEvents,
	transferEvidence,
	waitForEvent,
	waitForTransferPhase,
	waitJobSettled,
	type StartReceipt,
	type TransferEvent,
} from "./remote-sftp-helpers";
import { assertHelperBudget, assertRootPage, createResourceRecorder, disconnectHost, readPoolLogs, runRootSoak, waitHelpers } from "./remote-root-pooling-acceptance";

const credentials = readRemoteAcceptanceCredentials(process.env);
const timeouts = readRemoteAcceptanceTimeouts(process.env);
const HELP_TEXT = "set " + [REMOTE_ACCEPTANCE_ENV.host, REMOTE_ACCEPTANCE_ENV.user, REMOTE_ACCEPTANCE_ENV.fingerprint].join(" / ") + " to run the real-host acceptance test";
const ACCEPTANCE_PARENT_SUFFIX = "/.pideck-acceptance/root-pooling-prod-20261102";
const MiB = 1024 * 1024;

test.describe("SFTP-1 + 生产 root pooling 真实验收", () => {
	test.skip(credentials === undefined, HELP_TEXT);

	test("系统 OpenSSH SFTP：上传/下载/进度/取消/冲突/双项目隔离", async ({ remoteApp, remoteWindow, remoteUserDataRoot }) => {
		test.setTimeout(1_800_000);
		const creds = credentials;
		if (creds === undefined) {
			test.skip(true, HELP_TEXT);
			return;
		}
		const window = remoteWindow;
		expect(process.env.PIDECK_E2E_REMOTE_ROOT_POOLING, "acceptance must use production assembly without a pooling override").toBeUndefined();
		const runId = "sftp-" + Date.now().toString(36);
		const remoteHome = await remote(creds, 'printf %s "$HOME"', 30_000);
		expect(remoteHome.startsWith("/")).toBe(true);
		const remoteRoot = remoteHome + ACCEPTANCE_PARENT_SUFFIX + "/runs/" + runId;
		const projectAPath = remoteRoot + "/a";
		const projectBPath = remoteRoot + "/b";
		const projectCPath = remoteRoot + "/c";
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
		const reconnectedPath = join(localRoot, "reconnected-a.bin");
		const downloadPath = join(localRoot, "download-result.bin");
		let hostId: string | undefined;
		let projectAId: string | undefined;
		let projectBId: string | undefined;
		let projectCId: string | undefined;
		let deniedRestored = false;
		let spoolBaseline = 0;
		const timings: Record<string, number> = {};
		const resource = createResourceRecorder(creds, remoteRoot, remoteApp.process().pid!);
		let soak: Awaited<ReturnType<typeof runRootSoak>> | undefined;
		let transferProof = { uploadProgress: false, downloadProgress: false, cancelled: false };

		writeFileSync(emptyPath, Buffer.alloc(0));
		writeFileSync(unicodePath, "SFTP unicode and space path\n");
		makeSparse(largePath, 32 * MiB);
		makeSparse(cancelPath, 256 * MiB);
		writeFileSync(batchNewPath, "batch-new\n");
		writeFileSync(batchExistingPath, "local replacement must never be published\n");
		makeSparse(parallelBPath, 128 * MiB);
		writeFileSync(reopenedPath, "reopened project A still transfers\n");
		writeFileSync(reconnectedPath, "reconnected project A still transfers\n");

		try {
			await test.step("远端前置：两个项目根、权限拒绝子目录与同名目标（只写本 run 目录）", async () => {
				await remote(
					creds,
					[
						"set -eu",
						"umask 077",
						"test " + q(remoteHome) + " = " + q("/home/" + creds.user),
						'test "$(realpath -m ' + q(remoteRoot) + ')" = ' + q(remoteRoot),
						"mkdir -p " + q(projectAPath + "/denied") + " " + q(projectBPath),
						"chmod 700 " + q(remoteRoot) + " " + q(projectAPath) + " " + q(projectBPath),
						"chmod 500 " + q(deniedPath),
						"printf 'REMOTE_ORIGINAL\\n' > " + q(projectAPath + "/batch-existing.bin"),
						"printf 'B_PROJECT\\n' > " + q(projectBPath + "/hello-b.txt"),
						...["a", "b", "c", "d", "e", "f"].flatMap((name) => ["mkdir -p " + q(remoteRoot + "/" + name), "printf " + q(name) + " > " + q(remoteRoot + "/" + name + "/root-" + name + ".txt")]),
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
				timings.returnAToUploadReadyMs = await openProjectPanel(window, projectAId, 5_000);
				await assertRootPage(window, projectAId, "a");
				const jobA = await startPathUpload(window, projectAId, cancelPath);
				const progressA = await waitForEvent(window, (events) => events.find((event): event is Extract<TransferEvent, { kind: "progress" }> => event.kind === "progress" && event.jobId === jobA.jobId && event.transferred > 0), timeouts.helperMs, "parallel A progress");
				expect(progressA.operation).toBe("upload");
				const jobB = await startPathUpload(window, projectBId, parallelBPath);
				await waitForEvent(window, (events) => events.find((event) => event.kind === "progress" && event.jobId === jobB.jobId && event.transferred > 0 && event.transferred < event.total), timeouts.helperMs, "parallel B active progress");
				expect((await transferEvents(window)).some((event) => event.kind === "settled" && event.jobId === jobB.jobId)).toBe(false);
				await cancelJob(window, projectAId, jobA.jobId);
				const settledA = await waitJobSettled(window, jobA.jobId, timeouts.helperMs);
				expect(settledA.outcome).toBe("cancelled");
				const settledB = await waitJobSettled(window, jobB.jobId, timeouts.helperMs);
				expect(settledB.outcome).toBe("succeeded");
				expect(await remoteSha(creds, projectBPath + "/parallel-b.bin")).toBe(sha256File(parallelBPath));
				expect(await remoteExists(creds, projectAPath + "/cancel-256MiB.bin")).toBe(false);
			});

			await test.step("关闭 A 不打断 B 的在途传输；重开 A 后仍可传输", async () => {
				if (projectAId === undefined || projectBId === undefined) throw new Error("projects missing");
				transferProof = await transferEvidence(window);
				expect(transferProof).toEqual({ uploadProgress: true, downloadProgress: true, cancelled: true });
				await clearTransferEvents(window);
				const jobA = await startPathUpload(window, projectAId, cancelPath);
				await waitForEvent(window, (events) => events.find((event) => event.kind === "progress" && event.jobId === jobA.jobId && event.transferred > 0), timeouts.helperMs, "close-isolation A progress");
				const jobB = await startPathUpload(window, projectBId, largePath);
				await waitForEvent(window, (events) => events.find((event): event is Extract<TransferEvent, { kind: "progress" }> => event.kind === "progress" && event.jobId === jobB.jobId && event.transferred > 0), timeouts.helperMs, "close-isolation B progress");
				expect((await transferEvents(window)).some((event) => event.kind === "settled" && (event.jobId === jobA.jobId || event.jobId === jobB.jobId))).toBe(false);
				await removeProject(window, projectAId);
				projectAId = undefined;
				await waitHelpers(creds, remoteRoot, [projectBPath]);
				expect(await remoteExists(creds, projectAPath + "/cancel-256MiB.bin")).toBe(false);
				const settledB = await waitJobSettled(window, jobB.jobId, timeouts.helperMs);
				expect(settledB.outcome).toBe("succeeded");
				expect(await remoteSha(creds, projectBPath + "/large-32MiB.bin")).toBe(sha256File(largePath));
				if (hostId === undefined) throw new Error("hostId missing");
				projectAId = await enrollRemoteProject(window, hostId, projectAPath);
				await window.reload({ waitUntil: "domcontentloaded" });
				await dismissOnboarding(window);
				await installTransferRecorder(window);
				await openProjectPanel(window, projectAId);
				const reopened = await startPathUpload(window, projectAId, reopenedPath);
				const settled = await waitJobSettled(window, reopened.jobId, timeouts.helperMs);
				expect(settled.outcome).toBe("succeeded");
				expect(await remoteSha(creds, projectAPath + "/reopened-a.bin")).toBe(sha256File(reopenedPath));
			});

			await test.step("A/B/C 至少 60 秒真实轮换：同代、同 PID、目录 watcher 持续生效", async () => {
				if (!hostId || !projectAId || !projectBId) throw new Error("projects missing");
				projectCId = await enrollRemoteProject(window, hostId, projectCPath);
				await window.reload({ waitUntil: "domcontentloaded" });
				await dismissOnboarding(window);
				soak = await runRootSoak(window, creds, remoteRoot, [
					{ id: projectAId, name: "a" },
					{ id: projectBId, name: "b" },
					{ id: projectCId, name: "c" },
				]);
				assertHelperBudget(await resource.sample("three-watched-roots"), [projectAPath, projectBPath, projectCPath]);
			});

			await test.step("D/E/F 可打开：maxEntries=6 的 helper/SSH/RSS 资源门禁", async () => {
				if (!hostId) throw new Error("host missing");
				for (const name of ["d", "e", "f"]) {
					const id = await enrollRemoteProject(window, hostId, remoteRoot + "/" + name);
					await assertRootPage(window, id, name);
				}
				const roots = ["a", "b", "c", "d", "e", "f"].map((name) => remoteRoot + "/" + name);
				await waitHelpers(creds, remoteRoot, roots);
				for (let index = 0; index < 3; index += 1) {
					assertHelperBudget(await resource.sample("six-watched-roots"), roots);
					await window.waitForTimeout(2_000);
				}
			});

			await test.step("显式断开退休所有 root；后台读不复活；重连后重新建立并上传", async () => {
				if (!hostId || !projectAId) throw new Error("project missing");
				await disconnectHost(window, hostId);
				await waitHelpers(creds, remoteRoot, []);
				const refused = await window.evaluate((id) => (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.remoteHosts.listProject(id, ""), projectAId);
				expect(refused.ok).toBe(false);
				if (!refused.ok) expect(refused.code).toBe("SSH_HOST_DISCONNECTED");
				await window.waitForTimeout(2_000);
				await waitHelpers(creds, remoteRoot, []);
				await expect.poll(async () => (await resource.sample("disconnected")).local.filter((p) => p.name.toLowerCase() === "ssh.exe").length, { timeout: 30_000 }).toBe(0);
				const connected = await window.evaluate((id) => (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.remoteHosts.connect(id), hostId);
				expect(connected.ok).toBe(true);
				await installTransferRecorder(window);
				await openProjectPanel(window, projectAId);
				const job = await startPathUpload(window, projectAId, reconnectedPath);
				expect((await waitJobSettled(window, job.jobId, timeouts.helperMs)).outcome).toBe("succeeded");
				expect(await remoteSha(creds, projectAPath + "/reconnected-a.bin")).toBe(sha256File(reconnectedPath));
			});

			const events = await transferEvents(window);
			const evidence = transferProof;
			const poolLogs = readPoolLogs(join(remoteUserDataRoot, REMOTE_APP_DATA_DIR_NAME));
			expect(poolLogs.some((event) => event.message === "Root pool sweep" && event.detail.before !== undefined)).toBe(true);
			expect(Math.max(...poolLogs.map((event) => event.detail.stats.peakEntries))).toBe(6);
			expect(resource.errors).toEqual([]);
			expect(resource.peaks().helpers).toBe(6);
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
							soak,
							resources: { samples: resource.samples, peaks: resource.peaks() },
							poolLogs,
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
			await resource.stop();
			await test.info().attach("root-pool-resources", { body: Buffer.from(JSON.stringify({ samples: resource.samples, peaks: resource.peaks(), errors: resource.errors })), contentType: "application/json" });
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
			await waitHelpers(creds, remoteRoot, []);
			expect(runId).toMatch(/^sftp-[a-z0-9]+$/);
			expect(remoteRoot).toBe("/home/" + creds.user + ACCEPTANCE_PARENT_SUFFIX + "/runs/" + runId);
			await remote(creds, "set -eu; target=$(realpath -m " + q(remoteRoot) + "); expected=" + q(remoteRoot) + '; test "$target" = "$expected"; ' + (deniedRestored ? "" : "if test -d " + q(deniedPath) + "; then chmod 700 " + q(deniedPath) + "; fi; ") + 'rm -rf -- "$target"; test ! -e "$target"', 60_000);
			await rm(localRoot, { recursive: true, force: true });
		}
	});
});
