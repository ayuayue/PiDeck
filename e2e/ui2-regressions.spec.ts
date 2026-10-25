import { test, expect } from "./fixtures";
import { openFirstSession, makeSeedProject, openSettings } from "./open-session";

const seedProject = makeSeedProject("Ui2RegE2E");
test.use({ seedProjects: [seedProject] });

/**
 * 设置页 Select 可交互回归（#115）：旧 .modal-backdrop z-index 100 曾盖住
 * Radix Select 的 z-50 portal，导致下拉点开点不动。此用例断言选项真实可点、
 * 选择生效（主题切换到暗色并反映到 data-theme）。
 */
test("settings select: option is clickable through dialog layers", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();

	// 主题 Select 已移入外观设置 tab（主题字段迁移后）
	await modal.getByText("外观设置").click();
	const trigger = modal.locator("[data-slot='select-trigger']").first();
	await trigger.click();
	const content = window.locator("[data-slot='select-content']");
	await expect(content).toBeVisible();

	// 点「暗色」——z-index 战争时期这一下会点到下层的 modal，选择不生效
	await content.getByText("暗色").click();

	// 选择生效：draft 更新后保存按钮出现；保存并等待主题落盘
	const saveButton = modal.getByRole("button", { name: "保存" });
	await expect(saveButton).toBeVisible({ timeout: 3000 });
	await saveButton.click();
	await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme), { timeout: 5000 }).toBe("dark");

	// 恢复亮色，避免影响同 worker 的其他用例
	await modal.locator("[data-slot='select-trigger']").first().click();
	await window.locator("[data-slot='select-content']").getByText("浅色").click();
	await modal.getByRole("button", { name: "保存" }).click();
	await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme), { timeout: 5000 }).toBe("light");
});

/**
 * 抽屉 tab 横排回归（#115）：activity rail 曾竖排在抽屉左缘，
 * 用户期望横排 tab。断言 rail 是水平布局（宽 > 高）。
 */
test("drawer rail: tabs are laid out horizontally", async ({ window }) => {
	// 新建会话打开工作台后，头部抽屉开关才出现
	await openFirstSession(window);
	await window.locator(".header-drawer-toggle").first().click();

	const rail = window.locator(".drawer-activity-rail");
	await expect(rail).toBeVisible({ timeout: 5000 });
	const box = await rail.boundingBox();
	expect(box).toBeTruthy();
	expect(box!.width).toBeGreaterThan(box!.height);

	// tab 按钮横向排布：后一个 tab 的 x 应大于前一个，y 相同
	const tabs = rail.locator("[role='tab']");
	const count = await tabs.count();
	expect(count).toBeGreaterThan(1);
	const first = await tabs.nth(0).boundingBox();
	const second = await tabs.nth(1).boundingBox();
	expect(second!.x).toBeGreaterThan(first!.x);
	expect(Math.abs(second!.y - first!.y)).toBeLessThan(4);
});
