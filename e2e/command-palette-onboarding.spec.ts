import { test, expect } from "./mock-pi-fixture";

test.use({ dismissStartupOverlays: false });

const onboardingTitle = "用命令面板直达任何设置";

async function focusComposer(window: import("@playwright/test").Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	return composer;
}

test("Agent 回复期间不弹出首次引导，结束后才提示", async ({ window }) => {
	const composer = await focusComposer(window);
	await window.keyboard.type("SLOW LONG 首次引导不能打断回复");
	await window.keyboard.press("Enter");
	const stop = window.locator('button[aria-label="停止"]');
	await expect(stop).toBeVisible({ timeout: 10_000 });
	await composer.evaluate((element) => element.blur());
	const onboarding = window.getByRole("dialog", { name: onboardingTitle });

	await window.waitForTimeout(3_200);
	await expect(stop).toBeVisible();
	await expect(onboarding).toHaveCount(0);

	await expect(stop).toHaveCount(0, { timeout: 30_000 });
	await expect(onboarding).toBeVisible({ timeout: 6_000 });
});

test("设置已打开时不叠加首次引导，关闭设置后才提示", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("button", { name: "设置", exact: true }).click();
	const settings = window.getByRole("dialog", { name: "设置", exact: true });
	await expect(settings).toBeVisible();
	const onboarding = window.getByRole("dialog", { name: onboardingTitle });

	await window.waitForTimeout(3_200);
	await expect(onboarding).toHaveCount(0);

	await window.keyboard.press("Escape");
	await expect(settings).toBeHidden();
	await expect(onboarding).toBeVisible({ timeout: 6_000 });
});

test("正在输入时不弹出首次引导，离开输入框后才提示", async ({ window }) => {
	const composer = await focusComposer(window);
	await window.keyboard.type("先让我把这条消息写完");
	const onboarding = window.getByRole("dialog", { name: onboardingTitle });

	await window.waitForTimeout(3_200);
	await expect(onboarding).toHaveCount(0);

	await composer.evaluate((element) => element.blur());
	await expect(onboarding).toBeVisible({ timeout: 6_000 });
});
