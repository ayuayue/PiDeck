import { test, expect } from "./mock-pi-fixture";
import type { PiDesktopApi } from "../src/preload";

test.beforeEach(async ({ window }) => {
	await window.addLocatorHandler(window.getByRole("heading", { name: "用命令面板直达任何设置", exact: true }), async () => {
		await window.getByRole("button", { name: "以后再说", exact: true }).click();
	});
});

test("供应商中文名可新建和重命名，窄窗添加/编辑表单不横向溢出", async ({ app, window }, testInfo) => {
	test.setTimeout(90_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 25_000 });
	const config = window.locator(".settings-modal");
	if (!(await config.isVisible())) await window.getByRole("button", { name: "设置", exact: true }).click();
	await expect(config).toBeVisible();
	await config.getByRole("tab", { name: "配置管理", exact: true }).click();
	await config.getByRole("tab", { name: "Pi 配置管理", exact: true }).click();
	await config.getByRole("tab", { name: "模型", exact: true }).click();
	await config.getByRole("button", { name: "+ 添加供应商", exact: true }).click();
	const page = config.locator(".provider-add-page");
	await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("中文供应商");
	await page.getByRole("textbox", { name: "Base URL", exact: true }).fill("https://example.com/v1");
	await page.getByRole("button", { name: "+ 手动添加", exact: true }).click();
	await page.getByPlaceholder("model-id", { exact: true }).fill("test-model");
	await expect(page.getByRole("button", { name: "添加", exact: true })).toBeEnabled();

	for (const width of [1100, 880, 640]) {
		await app.evaluate(({ BrowserWindow }, size) => {
			const win = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
			if (!win) throw new Error("Test window missing");
			win.unmaximize();
			win.setMinimumSize(0, 0);
			win.setContentSize(size, 900);
		}, width);
		await expect.poll(() => page.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
		const forms = await page.locator(".config-provider-form").evaluateAll((nodes) => nodes.map((form) => ({ width: form.clientWidth, scroll: form.scrollWidth, layout: getComputedStyle(form.closest(".config-layout")!).display })));
		for (const form of forms) {
			expect(form.scroll, `Form overflow at ${width}px`).toBeLessThanOrEqual(form.width + 1);
			expect(form.layout).toBe("grid");
		}
		await expect(page.getByRole("button", { name: "添加", exact: true })).toBeVisible();
		if (width === 1100) await page.getByRole("textbox", { name: "供应商名称", exact: true }).scrollIntoViewIfNeeded();
		else await page.getByPlaceholder("model-id", { exact: true }).scrollIntoViewIfNeeded();
		await window.screenshot({ path: testInfo.outputPath(`provider-add-${width}.png`) });
	}

	await page.getByRole("button", { name: "添加", exact: true }).click();
	await expect(page).toHaveCount(0);
	await config.getByRole("button", { name: "保存", exact: true }).first().click();
	await expect.poll(() => window.evaluate(async () => Object.keys((await (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.config.getModels()).parsed.providers))).toContain("中文供应商");
	const card = config.locator(".config-provider-card").filter({ hasText: "中文供应商" });
	await card.getByTitle("编辑供应商配置", { exact: true }).click();
	await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill("数字 2 中文供应商");
	await expect.poll(() => page.evaluate((node) => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
	await window.screenshot({ path: testInfo.outputPath("provider-edit-640.png") });
	await page.getByRole("button", { name: "保存", exact: true }).click();
	await config.getByRole("button", { name: "保存", exact: true }).first().click();
	const names = await window.evaluate(async () => Object.keys((await (window as unknown as { piDesktop: PiDesktopApi }).piDesktop.config.getModels()).parsed.providers));
	expect(names).toContain("数字 2 中文供应商");
	expect(names).not.toContain("中文供应商");
});

test("引导页清空预选只移除当前后端模型，不覆盖另一后端偏好", async ({ window }, testInfo) => {
	await window.evaluate(() => {
		localStorage.setItem("pideck:welcome-backend", "pi");
		localStorage.setItem("pideck:welcome-model", JSON.stringify({ provider: "mock", modelId: "mock-model", modelName: "预选模型" }));
		localStorage.setItem("pideck:welcome-dsh-model", JSON.stringify({ provider: "dsh-provider", modelId: "dsh-model", modelName: "DSH预选" }));
		localStorage.setItem("pideck:command-palette-onboarding", "1");
	});
	await window.reload();
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 25_000 });
	const settings = window.locator(".settings-modal");
	if (await settings.isVisible()) await settings.getByRole("button", { name: "关闭", exact: true }).click();
	const composer = window.locator(".composer");
	await composer.locator(".model-thinking").click();
	await window.locator('[data-slot="popover-content"]').getByTitle("选择模型", { exact: true }).click();
	const picker = window.locator(".model-picker");
	await expect(picker.getByRole("button", { name: "清空预选", exact: true })).toBeVisible();
	await window.screenshot({ path: testInfo.outputPath("model-clear-selection.png") });
	await picker.getByRole("button", { name: "清空预选", exact: true }).click();
	await expect(picker).toHaveCount(0);
	const preferences = await window.evaluate(() => ({ pi: localStorage.getItem("pideck:welcome-model"), dsh: localStorage.getItem("pideck:welcome-dsh-model") }));
	expect(preferences.pi).toBeNull();
	expect(preferences.dsh).toContain("dsh-model");
});
