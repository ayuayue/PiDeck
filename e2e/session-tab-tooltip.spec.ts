import { test, expect } from "./mock-pi-fixture";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 会话 Tab 富提示只跟随悬停（用户反馈「切回 PiDeck 就自动展开 Tab 的项目与路径」）。
 *
 * 根因：Radix Tooltip 默认在触发元素获得 focus 时也弹泡；窗口重获焦点会把焦点还给
 * 上次聚焦的 Tab，于是切回来就自动展开。修复用受控 open + 悬停标记只放行指针悬停。
 *
 * 最后一步是对照组：未加悬停门控的侧栏 Tooltip 仍然 focus 即开——证明本仓库的
 * Radix 确实会因 focus 弹泡，Tab 的修复不是「本来就不弹」。
 */
const projectDir = mkdtempSync(join(tmpdir(), "pideck-tab-tooltip-"));
rmSync(projectDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });

test.use({ seedProjects: [{ id: "e2e-tooltip-proj", name: "TooltipE2E", path: projectDir }] });

test("tab tooltip only on hover", async ({ window }) => {
	test.setTimeout(150_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("tab", { name: "项目" }).click();
	const projectRow = window.locator(".conversation", { hasText: "TooltipE2E" }).first();
	await projectRow.click();
	await projectRow.getByTitle("普通会话").first().click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.type("提示框测试会话");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("Mock 回复：「提示框测试会话」", { timeout: 15_000 });

	const tab = window.locator('.session-tabs-bar [role="tab"]').first();
	await expect(tab).toBeVisible({ timeout: 10_000 });
	const tooltip = window.locator('[data-slot="tooltip-content"]');

	// 1) 焦点（模拟切回窗口时浏览器把焦点还给上次聚焦的 Tab）不应弹出
	await window.mouse.move(5, 400);
	await tab.evaluate((node) => (node as HTMLElement).focus());
	await window.waitForTimeout(900);
	await expect(tooltip).toHaveCount(0);

	// 2) 悬停仍然弹出（标题 + 工作区两行）
	await tab.hover();
	await expect(tooltip).toBeVisible({ timeout: 5_000 });
	await expect(tooltip).toContainText("TooltipE2E");

	// 3) 移开指针即收起
	await window.mouse.move(5, 400, { steps: 12 });
	await expect(tooltip).toHaveCount(0, { timeout: 5_000 });

	// 4) 悬停收起的这一刻再给焦点，仍然不弹
	await tab.evaluate((node) => (node as HTMLElement).focus());
	await window.waitForTimeout(900);
	await expect(tooltip).toHaveCount(0);

	// 5) 对照组：未加悬停门控的侧栏 Tooltip 仍会在 focus 时弹出，
	// 证明本仓库的 Radix 确实是 focus 即开（Tab 的修复不是「本来就不弹」）。
	const themeButton = window.getByRole("button", { name: /主题/ }).first();
	await themeButton.evaluate((node) => (node as HTMLElement).focus());
	await expect(tooltip).toBeVisible({ timeout: 5_000 });
});
