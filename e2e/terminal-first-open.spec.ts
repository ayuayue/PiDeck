import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

const project = makeSeedProject("terminal-first-open");
test.use({ seedProjects: [project] });

/** #333: 首次打开终端覆盖尚未发送的新会话，以及小窗口/历史高度恢复的边界。 */
for (const scenario of [
	{ name: "default window", compact: false },
	{ name: "minimum-height window", compact: true },
	{ name: "restored oversized height", compact: true, storedHeight: 900 },
]) {
	test(`terminal: first open in an unsent session (${scenario.name})`, async ({ app, window }) => {
		const errors: string[] = [];
		window.on("pageerror", (error) => errors.push(error.message));
		// fixture 只等待 domcontentloaded；先等首屏装配完成再调整窗口或刷新恢复高度。
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await expect(window.getByRole("tab", { name: "项目", exact: true })).toBeVisible();
		if (scenario.compact) {
			await app.evaluate(({ BrowserWindow }) => {
				const mainWindow = BrowserWindow.getAllWindows()[0];
				mainWindow.unmaximize();
				mainWindow.setSize(1000, 640);
			});
		}
		if (scenario.storedHeight) {
			await window.evaluate((height) => localStorage.setItem("pid:terminal-dock-height", String(height)), scenario.storedHeight);
			await window.reload();
		}
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await window.getByRole("tab", { name: "项目", exact: true }).click();
		const projectRow = window.locator(`[data-sidebar-removal-id="${project.id}"]`);
		await projectRow.hover();
		await projectRow.getByRole("button", { name: "普通会话", exact: true }).click();
		await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true");
		await window.locator(".session-tabs-actions").getByRole("button", { name: "更多操作", exact: true }).click();
		await window.getByRole("menuitem", { name: "终端", exact: true }).click();
		const dock = window.locator(".terminal-dock");
		await expect(dock).toBeVisible();
		await expect(dock.locator(".xterm").first()).toBeVisible({ timeout: 15_000 });
		await expect(window.locator(".app-error-boundary")).toHaveCount(0);
		expect(errors).toEqual([]);
	});
}
