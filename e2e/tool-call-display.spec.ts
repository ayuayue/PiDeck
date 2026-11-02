import { test, expect } from "./mock-pi-fixture";

test.use({ seedSettings: { processGroupDisplay: true } });

test("工具完成后保留 bash 身份与语义动词", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.type("SLOW TOOLMANY 1 工具身份");
	await window.keyboard.press("Enter");

	const row = window.locator("[data-process-group-body] .tool-card").first();
	await expect(row).toBeVisible({ timeout: 30_000 });
	await expect(row).toHaveAttribute("data-tool-kind", "builtin");
	await expect(row.locator("[data-row-text] > span").first()).toHaveText("执行");
	await expect(row).toContainText("echo step-0");
	await expect(row.locator("button").first()).toHaveAttribute("title", /^bash\n/);
});
