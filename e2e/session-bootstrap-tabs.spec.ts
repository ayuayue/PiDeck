import { test, expect } from "./mock-pi-fixture";

test("首次发送提升为真实会话后，不保留未命名占位 Tab", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.type("首次发送替换占位 Tab");
	await window.keyboard.press("Enter");
	await expect(window.getByText(/Mock 回复：「首次发送替换占位 Tab」/)).toBeVisible({ timeout: 30_000 });

	const sessionTabs = window.locator('[role="tab"][data-session-id]');
	await expect(sessionTabs).toHaveCount(1);
	await expect(sessionTabs.first()).toHaveAttribute("aria-selected", "true");
	await expect(sessionTabs.first()).not.toHaveAttribute("data-session-id", "renderer:guide-bootstrap");
	await expect(window.getByRole("tab", { name: "未命名", exact: true })).toHaveCount(0);
});
