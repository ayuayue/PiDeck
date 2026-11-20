import { test, expect } from "./mock-pi-fixture";
import { openFirstSession, openSettings } from "./open-session";

const closeKey = process.platform === "darwin" ? "Meta+w" : "Control+w";

test("close shortcut closes focused Settings and restores the underlying session", async ({ window }) => {
	const composer = await openFirstSession(window);
	await composer.fill("Keep this draft");
	const settings = await openSettings(window);
	await window.keyboard.press(closeKey);
	await expect(settings).toHaveCount(0);
	await expect(composer).toBeVisible();
	await expect(composer).toHaveText("Keep this draft");
});

test("close shortcut respects the settings draft confirmation", async ({ window }) => {
	const settings = await openSettings(window);
	await settings.getByRole("tab", { name: "外观设置", exact: true }).click();
	const slider = settings.locator('input[type="range"][aria-label="聊天内容宽度"]');
	await slider.focus();
	await window.keyboard.press("ArrowRight");
	await window.keyboard.press(closeKey);
	const confirmation = window.getByRole("alertdialog");
	await expect(confirmation).toBeVisible();
	await window.keyboard.press(closeKey);
	await expect(confirmation).toHaveCount(1);
	await window.keyboard.press("Escape");
	await expect(confirmation).toHaveCount(0);
	await expect(settings).toBeVisible();
});
