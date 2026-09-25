import { expect, type Page } from "@playwright/test";
import { test as fixture } from "./fixtures";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

const base = resolve(".cache/simple-navigation-e2e");
mkdirSync(base, { recursive: true });
const projectDir = mkdtempSync(join(base, "simple-project-"));
writeFileSync(join(projectDir, "hello.ts"), "export const hello = 1;\n");
fixture.afterAll(() => rmSync(projectDir, { recursive: true, force: true }));
fixture.use({ seedProjects: [{ id: "simple-project", name: "simple-project", path: projectDir }], seedSettings: { navigationMode: "simple", sidebarExpandedProjectIds: ["simple-project"], piEnvironmentChecked: true, dshHomeDir: join(projectDir, ".dsh"), checkUpdateOnStartup: false } });

async function switchMode(window: Page, label: string) {
	await window.getByRole("button", { name: /^设置/ }).first().click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	await modal.getByRole("tab", { name: "外观设置", exact: true }).click();
	await modal.locator("#settings-section-appearance-navigation-mode").getByRole("combobox").click();
	await window.getByRole("option", { name: label, exact: true }).click();
	await modal.getByRole("button", { name: "保存", exact: true }).click();
	await modal.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(modal).toHaveCount(0);
}

fixture("simple layout: right file tabs, expand/restore, switch modes without remounting editor", async ({ window }, testInfo) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await expect(window.locator(".simple-navigation-bar")).toBeVisible();
	await expect(window.getByRole("tab", { name: "项目", exact: true })).toHaveCount(0);
	const project = window.locator(".conversation").filter({ hasText: "simple-project" }).first();
	await project
		.locator(":scope > button")
		.nth(1)
		.click({ position: { x: 8, y: 12 } });
	await window.locator(".header-drawer-toggle").first().click();
	const row = window.locator(".detail-drawer .file-node-row").filter({ hasText: "hello.ts" }).first();
	await expect(row).toBeVisible();
	await row.dblclick();
	const editor = window.locator(".cm-content");
	await expect(editor).toBeVisible();
	await expect(window.locator(".simple-file-tabs").getByRole("tab", { name: "hello.ts" })).toBeVisible();
	await expect(window.locator(".simple-session-header").getByRole("tab", { name: "hello.ts" })).toHaveCount(0);
	await editor.evaluate((element) => {
		element.setAttribute("data-instance-proof", "original");
	});
	const ratio = async () => window.locator(".workbench-session-pane").evaluate((element) => element.getBoundingClientRect().width / element.closest(".workbench-stage-split")!.getBoundingClientRect().width);
	await expect.poll(ratio).toBeGreaterThan(0.35);
	await window.getByRole("button", { name: "占满中间栏", exact: true }).click();
	await expect.poll(ratio).toBeLessThan(0.05);
	await window.getByRole("button", { name: "恢复分屏", exact: true }).click();
	await expect.poll(ratio).toBeGreaterThan(0.35);
	await editor.click();
	await window.keyboard.press("ControlOrMeta+End");
	await window.keyboard.insertText("// preserved edit");
	await switchMode(window, "标签模式");
	await expect(window.locator(".simple-navigation-bar")).toHaveCount(0);
	await expect(editor).toHaveAttribute("data-instance-proof", "original");
	await expect(editor).toContainText("preserved edit");
	await switchMode(window, "简洁模式");
	await expect(editor).toHaveAttribute("data-instance-proof", "original");
	await editor.click();
	await window.keyboard.press("ControlOrMeta+z");
	await expect(editor).not.toContainText("preserved edit");
	const geometry = await window.evaluate(() => {
		const top = document.querySelector(".simple-navigation-bar")!.getBoundingClientRect();
		const controls = document.querySelector(".window-controls")!.getBoundingClientRect();
		return { topHeight: top.height, controlsHeight: controls.height, controlsTop: controls.top };
	});
	expect(geometry).toEqual({ topHeight: 32, controlsHeight: 32, controlsTop: 0 });
	await window.screenshot({ path: testInfo.outputPath("simple-mode.png") });
	await window.locator(".file-diff-header-actions").getByRole("button", { name: "关闭", exact: true }).click();
	await expect(editor).toHaveCount(0);
	await expect.poll(ratio).toBeGreaterThan(0.95);
});
