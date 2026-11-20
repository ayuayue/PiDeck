import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject, openFirstSession, openSettings } from "./open-session";

// Page.keyboard injects renderer events and bypasses Electron's before-input-event.
async function pressClose(app: ElectronApplication, window: Page) {
	const nativeWindow = await app.browserWindow(window);
	await nativeWindow.evaluate((win) => {
		const modifiers: Array<"meta" | "control"> = [process.platform === "darwin" ? "meta" : "control"];
		win.webContents.sendInputEvent({ type: "keyDown", keyCode: "W", modifiers });
		win.webContents.sendInputEvent({ type: "keyUp", keyCode: "W", modifiers });
	});
	await nativeWindow.dispose();
}

test("close shortcut closes focused Settings and restores the underlying session", async ({ window, app }) => {
	const composer = await openFirstSession(window);
	await composer.fill("Keep this draft");
	const settings = await openSettings(window);
	await expect(settings).toBeFocused();
	await pressClose(app, window);
	await expect(settings).toHaveCount(0);
	await expect(composer).toBeVisible();
	await expect(composer).toHaveText("Keep this draft");
});

test("close shortcut respects the settings draft confirmation", async ({ window, app }) => {
	const settings = await openSettings(window);
	await settings.getByRole("tab", { name: "外观设置", exact: true }).click();
	const slider = settings.locator('input[type="range"][aria-label="聊天内容宽度"]');
	await slider.focus();
	await window.keyboard.press("ArrowRight");
	await expect(settings.getByRole("button", { name: "保存", exact: true })).toBeEnabled();
	await pressClose(app, window);
	const confirmation = window.getByRole("alertdialog");
	await expect(confirmation).toBeVisible();
	await pressClose(app, window);
	await expect(confirmation).toHaveCount(1);
	await window.keyboard.press("Escape");
	await expect(confirmation).toHaveCount(0);
	await expect(settings).toBeVisible();
});

test("Favorites opened from the sidebar gets focus and closes independently", async ({ window, app }) => {
	const composer = await openFirstSession(window);
	await window.getByRole("button", { name: "更多", exact: true }).click();
	await window.getByRole("button", { name: "收藏", exact: true }).click();
	const favorites = window.getByRole("region", { name: "收藏" });
	await expect(favorites).toBeFocused();
	await pressClose(app, window);
	await expect(favorites).toHaveCount(0);
	await expect(composer).toBeVisible();
});

test("window-level shortcut minimizes and restores the same workbench with its draft", async ({ window, app }) => {
	const composer = await openFirstSession(window);
	await composer.fill("Draft survives minimization");
	await window.getByRole("button", { name: "新建会话", exact: true }).first().focus();
	await pressClose(app, window);
	const confirmation = window.getByRole("alertdialog", { name: "收起 PiDeck 窗口？" });
	await expect(confirmation).toContainText("1 个会话有未发送的草稿");
	await confirmation.getByRole("button", { name: "收起窗口" }).focus();
	await window.keyboard.press("Enter");
	const nativeWindow = await app.browserWindow(window);
	await expect.poll(() => nativeWindow.evaluate((win) => win.isMinimized())).toBe(true);
	await app.evaluate(({ app }) => app.emit("activate", {}, false));
	await expect.poll(() => nativeWindow.evaluate((win) => win.isMinimized())).toBe(false);
	await expect(composer).toHaveText("Draft survives minimization");
	await nativeWindow.dispose();
});

test.describe("terminal shortcut", () => {
	const project = makeSeedProject("focused-close-terminal");
	test.use({ seedProjects: [project] });

	test("closing a focused terminal prompts while its command is running", async ({ window, app }) => {
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await window.getByRole("tab", { name: "项目", exact: true }).click();
		const projectRow = window.locator(`[data-sidebar-removal-id="${project.id}"]`);
		await projectRow.hover();
		await projectRow.getByRole("button", { name: "普通会话", exact: true }).click();
		const composer = window.locator(".composer .rich-input");
		await expect(composer).toHaveAttribute("contenteditable", "true");
		await window.getByRole("button", { name: "更多运行操作", exact: true }).click();
		await window.getByRole("menuitem", { name: "终端", exact: true }).click();
		const dock = window.locator(".terminal-dock");
		const terminal = dock.locator(".xterm-helper-textarea");
		await terminal.focus();
		await window.keyboard.type(process.platform === "win32" ? "ping.exe -n 30 127.0.0.1" : "sleep 30");
		await window.keyboard.press("Enter");
		await expect.poll(() => window.evaluate(async (projectId) => (await globalThis.window.piDesktop.terminal.list({ kind: "project", projectId })).map((tab) => tab.frontProcess ?? ""), project.id)).toEqual([expect.stringMatching(/(?:sleep|ping)(?:\.exe)?$/i)]);
		await pressClose(app, window);
		const confirmation = window.getByRole("alertdialog", { name: "关闭此终端？" });
		await expect(confirmation).toBeVisible();
		await window.keyboard.press("Escape");
		await expect(confirmation).toHaveCount(0);
		await expect(dock).toBeVisible();
		await expect(composer).toBeVisible();
	});
});
