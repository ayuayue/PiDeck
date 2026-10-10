import { test, expect } from "./fixtures";
import { makeSeedProject } from "./open-session";
import type { Page } from "@playwright/test";

/**
 * 右侧边栏下半区「会话状态」面板：拖动调整高度 + 显示位置设置（sessionStatusPlacement）。
 *
 * 不依赖 pi：面板在无会话时也挂载（空态文案），足以验证布局、拖拽与装配。
 * piEnvironmentChecked 预置为 true，避免全新 profile 首启的「Pi 环境检测」弹窗挡住操作。
 */

const STACK_PREFS_KEY = "pid:right-sidebar-stack-v1";
const drawerColumn = (window: Page) => window.locator(".shell-panel-drawer");
const stackSeparator = (window: Page) => drawerColumn(window).locator('[role="separator"][aria-orientation="horizontal"]');
const statusSection = (window: Page) => drawerColumn(window).locator("section[aria-label]");

async function openDrawer(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true");
}

test.describe("默认（右侧边栏）", () => {
	test.use({ seedProjects: [makeSeedProject("SidebarStatus")], seedSettings: { piEnvironmentChecked: true } });

	test("抽屉关闭时分隔条不可聚焦；打开后把手可见，拖动改变下半区高度并持久化比例", async ({ window }) => {
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		// 抽屉列宽为 0 时分隔条仍在 DOM：必须禁用（无 tabindex）且移出无障碍树
		const closedSeparator = stackSeparator(window);
		await expect(closedSeparator).toHaveAttribute("aria-disabled", "true");
		await expect(closedSeparator).not.toHaveAttribute("tabindex", /.*/);

		await openDrawer(window);
		const separator = stackSeparator(window);
		await expect(separator).toHaveAttribute("data-separator", "inactive");
		await expect(separator).toHaveAttribute("tabindex", "0");
		// 居中把手常显（32×4）
		const grip = separator.locator("span").first();
		await expect(grip).toBeVisible();
		const gripBox = await grip.boundingBox();
		expect(gripBox?.width).toBe(32);

		const section = statusSection(window);
		await expect(section).toBeVisible();
		const before = await section.boundingBox();
		const box = await separator.boundingBox();
		if (!before || !box) throw new Error("面板或分隔条未布局");

		// 按住把手所在位置上拖 150px
		const x = box.x + box.width / 2;
		const y = box.y + box.height / 2;
		await window.mouse.move(x, y);
		await window.mouse.down();
		for (let step = 1; step <= 15; step++) await window.mouse.move(x, y - step * 10);
		await expect(separator).toHaveAttribute("data-separator", "active");
		await window.mouse.up();

		await expect.poll(async () => (await section.boundingBox())?.height ?? 0).toBeGreaterThan(before.height + 100);
		const prefs = JSON.parse((await window.evaluate((key) => localStorage.getItem(key), STACK_PREFS_KEY)) ?? "null");
		expect(prefs.collapsed).toBe(false);
		expect(prefs.bottomPct).toBeGreaterThan(50);
	});
});

test.describe("输入框上方", () => {
	test.use({ seedProjects: [makeSeedProject("SidebarStatusComposer")], seedSettings: { piEnvironmentChecked: true, sessionStatusPlacement: "composer" } });

	test("右侧边栏保持单区抽屉：无会话状态面板、无纵向分隔条", async ({ window }) => {
		await openDrawer(window);
		await expect(window.locator(".detail-drawer")).toBeVisible();
		await expect(statusSection(window)).toHaveCount(0);
		await expect(stackSeparator(window)).toHaveCount(0);
	});
});

test.describe("设置页切换", () => {
	test.use({ seedProjects: [makeSeedProject("SidebarStatusSettings")], seedSettings: { piEnvironmentChecked: true } });

	test("外观设置渲染「会话状态位置」二选一；改为「输入框上方」保存后右侧边栏去掉下半区", async ({ window }) => {
		await openDrawer(window);
		await expect(statusSection(window)).toBeVisible();

		await window.getByRole("button", { name: "设置", exact: true }).click();
		const modal = window.locator(".settings-modal");
		await expect(modal).toBeVisible();
		await modal.getByText("外观设置").click();
		const trigger = modal.locator("#settings-section-appearance-session-status-placement").getByRole("combobox");
		await expect(trigger).toHaveText("右侧边栏");
		await trigger.click();
		await expect(window.getByRole("option")).toHaveText(["右侧边栏", "输入框上方"]);
		await window.getByRole("option", { name: "输入框上方" }).click();
		await expect(trigger).toHaveText("输入框上方");
		await modal.getByRole("button", { name: "保存" }).click();
		await modal.getByRole("button", { name: "关闭" }).first().click();
		await expect(modal).toHaveCount(0);

		await expect(window.locator(".detail-drawer")).toBeVisible();
		await expect(statusSection(window)).toHaveCount(0);
		await expect(stackSeparator(window)).toHaveCount(0);
	});
});

test.describe("旧值兼容", () => {
	// 开发期曾有过 "both" 选项，已移除：主进程读盘归一化为默认 sidebar
	test.use({ seedProjects: [makeSeedProject("SidebarStatusLegacy")], seedSettings: { piEnvironmentChecked: true, sessionStatusPlacement: "both" } });

	test("settings.json 里残留 both 时按右侧边栏处理：挂会话状态面板", async ({ window }) => {
		await openDrawer(window);
		await expect(statusSection(window)).toBeVisible();
		await expect(stackSeparator(window)).toHaveCount(1);
	});
});
