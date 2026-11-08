import { test, expect } from "./mock-pi-fixture";
import { openSettings } from "./open-session";

/**
 * 「减弱动效」应用内开关 E2E：
 * 1. 出厂默认 data-motion="on"，动画照常；
 * 2. 外观设置里打开 → 保存 → html[data-motion="reduced"]（CSS 降级本身的 0.001ms 规则
 *    由 tests/reduceMotion.test.mjs 断言，这里只验端到端接线）；
 * 3. 关掉并保存 → 回到 "on"。
 *
 * 为什么需要这条链：Electron 在部分平台不把系统「减弱动态效果」传给 renderer，
 * 全仓 20+ 处 prefers-reduced-motion 降级会一起失效，应用内开关是唯一退路。
 * 用 mock-pi fixture 隔离 userData，不写用户真实 settings.json。
 */
test("reduce motion switch writes data-motion and neutralizes animations", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await expect(window.locator("html")).toHaveAttribute("data-motion", "on");

	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	await modal.getByText("外观设置").click();

	const row = modal.locator("#settings-section-appearance-reduce-motion");
	await expect(row).toBeVisible();
	await row.getByRole("switch").click();
	await modal.getByRole("button", { name: "保存" }).click();
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await expect(modal).toHaveCount(0);

	await expect(window.locator("html")).toHaveAttribute("data-motion", "reduced");

	// ── 关掉后恢复 ──
	await openSettings(window);
	const modalAgain = window.locator(".settings-modal");
	await expect(modalAgain).toBeVisible();
	await modalAgain.getByText("外观设置").click();
	await modalAgain.locator("#settings-section-appearance-reduce-motion").getByRole("switch").click();
	await modalAgain.getByRole("button", { name: "保存" }).click();
	await modalAgain.getByRole("button", { name: "关闭" }).first().click();
	await expect(modalAgain).toHaveCount(0);
	await expect(window.locator("html")).toHaveAttribute("data-motion", "on");
});
