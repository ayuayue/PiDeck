import { mkdtempSync, mkdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import type { ElectronApplication, Page } from "@playwright/test";
import { test as mockTest, expect } from "./mock-pi-fixture";

// Launch through the real argument router. Every project, session and profile is disposable.
const test = mockTest.extend<{ quickProject: string }>({
	mockSessionInProject: true,
	quickProject: async ({}, use) => {
		const root = mkdtempSync(join(tmpdir(), "pideck-quick-task-"));
		const project = join(root, "中文 project & task");
		mkdirSync(project);
		try {
			await use(project);
		} finally {
			await rm(root, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 });
		}
	},
	seedProjects: async ({ quickProject }, use) => use([{ id: "quick-project", name: "Quick task project", path: quickProject }]),
	seedSettings: [{ language: "zh-CN", defaultAgentBackend: "pi", singleInstance: true, petEnabled: false }, { option: true }],
	launchArgs: async ({ quickProject }, use) => use(["--quick-task", quickProject]),
});

async function ready(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await expect(window.getByTestId("quick-task-window")).toBeVisible({ timeout: 30_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

async function records(window: Page) {
	return window.evaluate(() => window.piDesktop.sessions.listCatalog("quick-project", { scan: false }));
}

/** A second real process must hand its intent to the original version-lock owner and exit. */
async function invokeAgain(app: ElectronApplication, path: string) {
	const target = await app.evaluate(({ app }) => ({ executable: process.execPath, script: process.argv[1], profile: app.getPath("userData") }));
	const root = dirname(target.profile);
	const env = { ...process.env, PIDECK_E2E: "1", APPDATA: root, LOCALAPPDATA: root, USERPROFILE: root, HOME: root, XDG_CONFIG_HOME: root };
	delete env.ELECTRON_RENDERER_URL;
	const code = await new Promise<number | null>((resolve, reject) => {
		const child = spawn(target.executable, [target.script, `--user-data-dir=${target.profile}`, "--quick-task", path], { env, windowsHide: true, stdio: "ignore" });
		const deadline = setTimeout(() => {
			child.kill();
			reject(new Error("Secondary process did not hand off its quick-task intent"));
		}, 20_000);
		child.once("error", (error) => {
			clearTimeout(deadline);
			reject(error);
		});
		child.once("exit", (code) => {
			clearTimeout(deadline);
			resolve(code);
		});
	});
	expect(code).toBe(0);
}

test("quick task cold launch preserves drafts on repeated invocation and opens the same completed session", async ({ app, window, quickProject }, testInfo) => {
	test.setTimeout(120_000);
	const composer = await ready(window);
	await expect(window.getByTestId("quick-task-path")).toContainText(quickProject);
	await expect.poll(async () => (await records(window)).length).toBe(1);
	const initial = (await records(window))[0];
	expect(initial.status).toBe("draft");
	expect(initial.filePath).toBeUndefined();
	await composer.fill("右键任务保留草稿");
	await invokeAgain(app, quickProject);
	await expect(composer).toContainText("右键任务保留草稿");
	expect((await records(window)).map((record) => record.id)).toEqual([initial.id]);
	await composer.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("Mock 回复：「右键任务保留草稿」流式渲染验证完成", { timeout: 25_000 });
	await window.screenshot({ path: testInfo.outputPath("quick-task.png") });
	await testInfo.attach("catalog-before-workbench", { body: JSON.stringify(await records(window), null, 2), contentType: "application/json" });
	await window.getByTestId("quick-task-workbench").click();
	await expect(window.getByTestId("quick-task-window")).toHaveCount(0);
	await expect(window.locator(".message-timeline")).toContainText("右键任务保留草稿");
	await testInfo.attach("catalog-after-workbench", { body: JSON.stringify(await records(window), null, 2), contentType: "application/json" });
	expect((await records(window)).map((record) => record.id)).toEqual([initial.id]);
});

test("another directory requires consent, and native close restores workbench geometry without losing the draft", async ({ app, window, quickProject }) => {
	test.setTimeout(120_000);
	const composer = await ready(window);
	await composer.fill("这个草稿必须保留");
	const other = join(dirname(quickProject), "other directory");
	mkdirSync(other);
	await invokeAgain(app, other);
	await expect(window.getByTestId("quick-task-path")).toContainText(quickProject);
	await expect(window.getByTestId("quick-task-window")).toContainText(other);
	await expect(composer).toContainText("这个草稿必须保留");
	expect(await records(window)).toHaveLength(1);
	await window.getByRole("button", { name: "保留当前任务", exact: true }).click();
	await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].close());
	await expect(window.getByTestId("quick-task-window")).toHaveCount(0);
	await expect(window.locator(".composer .rich-input")).toContainText("这个草稿必须保留");
	const bounds = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
	expect(bounds.width).toBeGreaterThan(720);
	await invokeAgain(app, quickProject);
	await expect(window.getByTestId("quick-task-window")).toBeVisible();
	await expect(composer).toContainText("这个草稿必须保留");
	expect(await records(window)).toHaveLength(1);
});

test("quick task keeps extension confirmation and stop controls usable in the compact window", async ({ window }) => {
	test.setTimeout(120_000);
	const composer = await ready(window);
	await composer.fill("ASK_CONFIRM 小窗口确认");
	await composer.press("Enter");
	const ask = window.locator(".ask-inline-bar");
	await expect(ask).toContainText("确认继续吗？", { timeout: 20_000 });
	await ask.getByRole("button", { name: "确认", exact: true }).click();
	await expect(window.locator(".message-timeline")).toContainText("答案：true", { timeout: 20_000 });
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 15_000 });
	await composer.fill("SLOW 停止小任务");
	await composer.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("Mock 回复：「SLOW 停止小任务」", { timeout: 15_000 });
	await window.getByRole("button", { name: "停止", exact: true }).click();
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 15_000 });
});

test.describe("unknown project", () => {
	test.use({ seedProjects: [] });
	test("asks before adding a directory and never submits a task on launch", async ({ window, quickProject }) => {
		await expect(window.getByTestId("quick-task-add-project")).toBeVisible({ timeout: 30_000 });
		await expect(window.getByTestId("quick-task-path")).toContainText(quickProject);
		await window.getByTestId("quick-task-add-project").click();
		await ready(window);
		await expect(window.locator(".message-timeline")).not.toContainText("Mock 回复");
	});
});
