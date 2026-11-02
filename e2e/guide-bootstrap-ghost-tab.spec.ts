import { test, expect } from "./mock-pi-fixture";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-guide-ghost-"));

const PROJECT_NAME = "GuideGhostE2E";

test.use({
	seedProjects: [{ id: "e2e-guide-ghost", name: PROJECT_NAME, path: projectDir }],
});

test("first send from the project empty state leaves exactly one named tab", async ({ window }) => {
	test.setTimeout(150_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("tab", { name: "项目" }).click();
	await window.getByText(PROJECT_NAME, { exact: true }).first().click();

	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await expect(window.locator('.session-tabs-bar [role="tab"]')).toHaveCount(0, { timeout: 10_000 });

	await composer.click();
	await window.keyboard.type("引导页首发");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("Mock 回复：「引导页首发」", { timeout: 20_000 });

	const tabs = window.locator('.session-tabs-bar [role="tab"]');
	await expect(tabs).toHaveCount(1, { timeout: 10_000 });
	await expect(window.locator('.session-tabs-bar [role="tab"]', { hasText: "未命名" })).toHaveCount(0);
});
