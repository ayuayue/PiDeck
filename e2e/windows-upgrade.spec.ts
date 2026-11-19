import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { ensureWindowsProfileSkeleton } from "./win-profile";
import { armStartupOverlayDismissal } from "./startupOverlays";
import { openFirstSession } from "./open-session";

// Opt-in: both executables must be actual packaged applications. Evidence and
// profiles survive the run so an upgrade failure can be inspected or replayed.
const oldExecutable = process.env.PIDECK_UPGRADE_OLD_EXE;
const newExecutable = process.env.PIDECK_UPGRADE_NEW_EXE;
const labRoot = process.env.PIDECK_UPGRADE_LAB_ROOT;
const fakeSecret = "pideck-upgrade-lab-fake-secret";
const anchor = "Windows 0.12 升级保留锚点";
const draftContent = "# Windows upgrade lab\n旧版本保存的草稿，升级和重启后必须逐字保留。\n";
const quickMessages = ["Windows 升级验收快捷消息", "保留顺序与内容"];

function digest(file: string): string {
	return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function filesBelow(root: string, suffix: string): string[] {
	if (!existsSync(root)) return [];
	return readdirSync(root, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? filesBelow(join(root, entry.name), suffix) : entry.isFile() && entry.name.endsWith(suffix) ? [join(root, entry.name)] : []));
}

async function launch(executablePath: string, home: string) {
	const env = {
		...process.env,
		USERPROFILE: home,
		HOME: home,
		APPDATA: join(home, "AppData", "Roaming"),
		LOCALAPPDATA: join(home, "AppData", "Local"),
		TEMP: join(home, "tmp"),
		TMP: join(home, "tmp"),
		PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
		DSH_HOME: join(home, ".dsh"),
		PIDECK_E2E: "1",
		PIDECK_E2E_WINDOW_MODE: "quiet",
		PIDECK_UPGRADE_HOME: home,
		PIDECK_MOCK_SESSION_IN_PROJECT: "1",
		CI: "1",
	};
	for (const key of ["ELECTRON_RENDERER_URL", "ELECTRON_RUN_AS_NODE", "PIDECK_E2E_USER_DATA_DIR", "PIDECK_E2E_REGISTER_PROTOCOL", "PORTABLE_EXECUTABLE_DIR", "PORTABLE_EXECUTABLE_FILE", "PIDEK_UPDATE_FEED_URL"]) delete env[key];
	const app = await electron.launch({ executablePath: resolve(executablePath), args: [], env, timeout: 60_000 });
	try {
		const identity = await app.evaluate(({ app, safeStorage }) => ({ version: app.getVersion(), packaged: app.isPackaged, executable: process.execPath, home: app.getPath("home"), appData: app.getPath("appData"), userData: app.getPath("userData"), encryptionAvailable: safeStorage.isEncryptionAvailable() }));
		for (const key of ["home", "appData", "userData"] as const)
			expect(resolve(identity[key]).toLowerCase()).toMatch(
				new RegExp(
					`^${resolve(home)
						.toLowerCase()
						.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:${sep === "\\" ? "\\\\" : "/"}|$)`,
				),
			);
		expect(identity.packaged).toBe(true);
		let page: Page | undefined;
		await expect
			.poll(
				() => {
					page = app.windows().find((candidate) => /index\.html(?:[?#]|$)/.test(candidate.url()) && !candidate.url().includes("selection-tool"));
					return Boolean(page);
				},
				{ timeout: 60_000 },
			)
			.toBe(true);
		if (!page) throw new Error("Packaged main window missing");
		await armStartupOverlayDismissal(page);
		await expect(page.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
		return { app, page, identity };
	} catch (error) {
		await app.close();
		throw error;
	}
}

test("Windows: official 0.12 data survives candidate upgrade, resume and second restart", async () => {
	test.skip(process.platform !== "win32" || !oldExecutable || !newExecutable || !labRoot, "Set PIDECK_UPGRADE_OLD_EXE, PIDECK_UPGRADE_NEW_EXE and PIDECK_UPGRADE_LAB_ROOT to run the packaged Windows lab");
	test.setTimeout(300_000);
	if (!oldExecutable || !newExecutable || !labRoot) throw new Error("Upgrade lab paths missing");
	mkdirSync(labRoot, { recursive: true });
	const runRoot = mkdtempSync(join(resolve(labRoot), "run-"));
	const home = join(runRoot, "home");
	ensureWindowsProfileSkeleton(home);
	const profile = join(home, "AppData", "Roaming", "PiDeck");
	const project = join(home, "upgrade-project");
	const shim = join(home, "mock-pi.cmd");
	for (const dir of [profile, project, join(home, "tmp"), join(home, ".pi", "agent")]) mkdirSync(dir, { recursive: true });
	writeFileSync(join(home, "windows-upgrade-lab.json"), JSON.stringify({ identity: "cc.debugtools.pideck.windows-upgrade-lab", home }));
	writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${resolve("e2e/mock-pi.cjs")}" %*\r\n`);
	writeFileSync(join(home, ".pi", "agent", "trust.json"), JSON.stringify({ [home]: true, [project]: true }));
	writeFileSync(
		join(profile, "settings.json"),
		JSON.stringify({
			customPiPath: shim,
			piEnvironmentChecked: true,
			language: "zh-CN",
			dshHomeDir: join(home, ".dsh"),
			dshAutoImportExternalSessions: false,
			autoDownloadUpdates: false,
			autoUpdateExtensions: false,
			standbyRuntimeEnabled: false,
			telemetryEnabled: false,
			catalogAutoUpdate: false,
			closeToTray: false,
			processGroupDisplay: true,
		}),
	);
	const evidence: Record<string, unknown> = { runRoot, startedAt: new Date().toISOString(), stages: [] };
	const stages: unknown[] = [];
	evidence.stages = stages;
	let active: ElectronApplication | undefined;
	try {
		const old = await launch(oldExecutable, home);
		active = old.app;
		expect(old.identity.version).toBe("0.12.0");
		const saved = await old.page.evaluate(
			async ({ project, fakeSecret, draftContent, quickMessages }) => {
				await window.piDesktop.settings.update({ chatContentWidthPct: 83 });
				const addedProject = await window.piDesktop.projects.addByPath(project);
				await window.piDesktop.projects.rename(addedProject.id, "Windows upgrade project");
				const draft = await window.piDesktop.scratchPad.create();
				await window.piDesktop.scratchPad.save(draft.path, draftContent, 7);
				const quick = await window.piDesktop.quickMessages.save(quickMessages);
				const bot = await window.piDesktop.feishu.botAdd({ name: "Upgrade lab offline bot", appId: "cli_upgrade_lab_fake", appSecret: fakeSecret });
				if (!bot.success || !bot.bot || !quick.ok) throw new Error("Old version could not save lab data");
				await window.piDesktop.feishu.botConfig(bot.bot.id, { enabled: false });
				return { draftPath: draft.path, projectId: addedProject.id, botId: bot.bot.id, secretMatches: (await window.piDesktop.feishu.botSecret(bot.bot.id)) === fakeSecret };
			},
			{ project, fakeSecret, draftContent, quickMessages },
		);
		expect(saved.secretMatches).toBe(true);
		const composer = await openFirstSession(old.page);
		await composer.fill(anchor);
		await old.page.keyboard.press("Enter");
		await expect(old.page.locator(".message-timeline")).toContainText(`Mock 回复：「${anchor}」流式渲染验证完成`, { timeout: 30_000 });
		await old.page.screenshot({ path: join(runRoot, "01-official-0.12.png") });
		stages.push({ stage: "official-0.12-created-data", ...old.identity, ...saved });
		await old.app.close();
		active = undefined;
		const historyFiles = filesBelow(home, ".jsonl").filter((file) => readFileSync(file, "utf8").includes(anchor));
		expect(historyFiles.length).toBeGreaterThan(0);
		const oldHistory = historyFiles.map((file) => ({ file, bytes: readFileSync(file), hash: digest(file) }));
		const feishuPath = join(profile, "feishu", "feishu.json");
		const oldFeishu = digest(feishuPath);
		expect(JSON.parse(readFileSync(feishuPath, "utf8")).bots[0].appSecret.startsWith("v2:")).toBe(true);
		const bindingPath = join(profile, "feishu", `feishu-bindings-${saved.botId}.json`);
		writeFileSync(bindingPath, JSON.stringify([{ botId: saved.botId, chatId: "oc_lab_fake", userId: "ou_lab_fake", sessionId: "lab-session", sessionPath: historyFiles[0], workspaceId: "builtin-chat", source: "lab", chatType: "group", createdAt: Date.now() }]));
		const bindingHash = digest(bindingPath);

		for (const stage of ["candidate-first-start", "candidate-second-start"]) {
			const current = await launch(newExecutable, home);
			active = current.app;
			expect(current.identity.version).toBe("0.13.0-rc.1");
			const restored = await current.page.evaluate(
				async ({ saved, fakeSecret, draftContent, quickMessages }) => {
					const projects = await window.piDesktop.projects.list();
					const drafts = await window.piDesktop.scratchPad.list();
					return {
						width: (await window.piDesktop.settings.get()).chatContentWidthPct,
						projectMatches: projects.some((item) => item.id === saved.projectId && item.name === "Windows upgrade project"),
						draftMatches: drafts.some((item) => item.path === saved.draftPath) && (await window.piDesktop.scratchPad.load(saved.draftPath)).content === draftContent,
						quickMatches: JSON.stringify((await window.piDesktop.quickMessages.get()).items) === JSON.stringify(quickMessages),
						botMatches: (await window.piDesktop.feishu.botsList()).some((item) => item.id === saved.botId && !item.enabled),
						secretMatches: (await window.piDesktop.feishu.botSecret(saved.botId)) === fakeSecret,
					};
				},
				{ saved, fakeSecret, draftContent, quickMessages },
			);
			expect(restored).toEqual({ width: 83, projectMatches: true, draftMatches: true, quickMatches: true, botMatches: true, secretMatches: true });
			expect(digest(feishuPath)).toBe(oldFeishu);
			expect(digest(bindingPath)).toBe(bindingHash);
			for (const item of oldHistory) expect(readFileSync(item.file).subarray(0, item.bytes.length).equals(item.bytes)).toBe(true);
			const historyRow = current.page.locator(".conversation", { hasText: anchor }).first();
			await expect(historyRow).toBeVisible({ timeout: 30_000 });
			await historyRow.click();
			await expect(current.page.locator(".message-timeline")).toContainText(`Mock 回复：「${anchor}」流式渲染验证完成`, { timeout: 30_000 });
			if (stage === "candidate-first-start") {
				const input = current.page.locator(".composer .rich-input");
				await expect(input).toHaveAttribute("contenteditable", "true");
				await input.fill("升级后继续对话");
				await current.page.keyboard.press("Enter");
				await expect(current.page.locator(".message-timeline")).toContainText("Mock 回复：「升级后继续对话」流式渲染验证完成", { timeout: 30_000 });
				const terminal = await current.page.evaluate(async (projectId) => {
					const tabs = await window.piDesktop.terminal.ensure({ kind: "project", projectId });
					if (!tabs.length) throw new Error("Packaged terminal did not start");
					await window.piDesktop.terminal.input(tabs[0].id, "echo PIDECK_UPGRADE_PTY_OK\r");
					return tabs[0].id;
				}, saved.projectId);
				await expect.poll(() => current.page.evaluate(async (projectId) => (await window.piDesktop.terminal.list({ kind: "project", projectId })).map((tab) => tab.buffer ?? "").join(""), saved.projectId)).toContain("PIDECK_UPGRADE_PTY_OK");
				await current.page.evaluate((id) => window.piDesktop.terminal.close(id), terminal);
			} else {
				await expect(current.page.locator(".message-timeline")).toContainText("升级后继续对话", { timeout: 30_000 });
				await current.page.locator(".composer .rich-input").fill("SLOWDRIP TOOLMANY 30 Windows unified scroll");
				await current.page.keyboard.press("Enter");
				const content = current.page.locator("[data-process-group-content]").last();
				await expect.poll(() => content.locator(".tool-card").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(20);
				expect(await content.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(2);
				const timeline = current.page.locator(".message-timeline").first();
				await content.locator(".tool-card").last().hover();
				await current.page.mouse.wheel(0, -220);
				await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeGreaterThan(100);
				await expect(current.page.locator("[data-scroll-to-bottom]")).toBeVisible();
				await current.page.screenshot({ path: join(runRoot, "03-candidate-reading-tools.png") });
				await current.page.locator("[data-scroll-to-bottom]").click();
				await expect.poll(() => timeline.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(28);
			}
			await current.page.screenshot({ path: join(runRoot, `${stage}.png`) });
			stages.push({ stage, ...current.identity, ...restored, originalHistoryPreserved: true, feishuCiphertextPreserved: true, bindingBytesPreserved: true });
			await current.app.close();
			active = undefined;
		}
		evidence.status = "passed";
		evidence.history = oldHistory.map(({ file, hash }) => ({ file, hash }));
	} catch (error) {
		evidence.status = "failed";
		evidence.error = error instanceof Error ? error.message : String(error);
		throw error;
	} finally {
		await active?.close();
		evidence.finishedAt = new Date().toISOString();
		writeFileSync(join(runRoot, "evidence.json"), JSON.stringify(evidence, null, 2));
		console.log(`Windows upgrade evidence: ${join(runRoot, "evidence.json")}`);
	}
});
