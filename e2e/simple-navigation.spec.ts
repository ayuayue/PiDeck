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
	// 简洁模式与标签模式共用侧栏标题行：不再有独立的顶部导航条，折叠入口在品牌行右端（同屏唯一）。
	await expect(window.locator(".simple-navigation-bar")).toHaveCount(0);
	await expect(window.locator(".list-toolbar .list-toggle-native")).toHaveCount(1);
	await expect(window.locator(".list-toolbar .list-toggle-native")).toBeVisible();
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
	// 两种模式同一套标题行：折叠入口始终在侧栏品牌行右端，不随导航模式增删。
	await expect(window.locator(".simple-navigation-bar")).toHaveCount(0);
	await expect(window.locator(".list-toolbar .list-toggle-native")).toBeVisible();
	await expect(editor).toHaveAttribute("data-instance-proof", "original");
	await expect(editor).toContainText("preserved edit");
	await switchMode(window, "简洁模式");
	// 切回简洁模式：入口没有增删，编辑器实例与撤销历史仍在。
	await expect(window.locator(".list-toolbar .list-toggle-native")).toHaveCount(1);
	await expect(editor).toHaveAttribute("data-instance-proof", "original");
	await editor.click();
	await window.keyboard.press("ControlOrMeta+z");
	await expect(editor).not.toContainText("preserved edit");
	const geometry = await window.evaluate(() => {
		const bar = document.querySelector(".list-toolbar")!.getBoundingClientRect();
		const brand = document.querySelector(".brand-wordmark")!.getBoundingClientRect();
		const toggle = document.querySelector(".list-toolbar .list-toggle-native")!.getBoundingClientRect();
		// mac 用系统红绿灯、不渲染右侧窗口控件条；两条路都必须以同一行高为准。
		const controls = document.querySelector(".window-controls")?.getBoundingClientRect() ?? null;
		const dragHeight = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--window-drag-height")) || 0;
		const centerY = (rect: DOMRect) => rect.top + rect.height / 2;
		return {
			barHeight: bar.height,
			dragHeight,
			controlsHeight: controls?.height ?? null,
			controlsTop: controls?.top ?? null,
			// 字标与折叠按钮都在标题行的垂直中线上（mac 红绿灯同样居 40px 行中央）
			brandOffsetFromCenter: Math.abs(centerY(brand) - centerY(bar)),
			toggleOffsetFromCenter: Math.abs(centerY(toggle) - centerY(bar)),
			// 折叠按钮贴标题行右端
			toggleRightGap: bar.right - toggle.right,
		};
	});
	// 标题行与窗口控件行同高（40px），按钮/字标居中而非贴顶。
	expect(geometry.barHeight).toBe(40);
	expect(geometry.barHeight).toBe(geometry.dragHeight);
	if (geometry.controlsHeight !== null) {
		expect(geometry.controlsHeight).toBe(geometry.barHeight);
		expect(geometry.controlsTop).toBe(0);
	}
	expect(geometry.brandOffsetFromCenter).toBeLessThanOrEqual(1);
	expect(geometry.toggleOffsetFromCenter).toBeLessThanOrEqual(1);
	expect(geometry.toggleRightGap).toBeLessThanOrEqual(12);
	await window.screenshot({ path: testInfo.outputPath("simple-mode.png") });
	await window.locator(".file-diff-header-actions").getByRole("button", { name: "关闭", exact: true }).click();
	await expect(editor).toHaveCount(0);
	await expect.poll(ratio).toBeGreaterThan(0.95);
});
