import { test, expect } from "./mock-pi-fixture";
import type { Page, Locator } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 会话区配色调优巡检（不进常规门禁，手动/调优时跑）：
 * 用 mock pi 铺一条「过程层（思考/工具）+ 富文本」的时间线，
 * 明暗各截一张全页图，输出 test-results/visual-tune/。
 * 用于核对画布档/白卡/墨水罩染阶梯（Phase 5）。
 */

const OUT_DIR = join(__dirname, "..", "test-results", "visual-tune");
mkdirSync(OUT_DIR, { recursive: true });

async function shot(window: Page, name: string) {
	await window.screenshot({ path: join(OUT_DIR, `${name}.png`) });
}

async function send(composer: Locator, window: Page, text: string, doneText: string) {
	await composer.click();
	await window.keyboard.type(text);
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText(doneText, { timeout: 20_000 });
}

async function runSession(window: Page, baseName: string) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	await send(composer, window, "TOOL THINK 过程层巡检", "流式渲染验证完成");
	await send(composer, window, "MDEMO 渲染元素巡检", "渲染元素巡检");
	await send(composer, window, "HDEMO 标题刻度巡检", "标题压平后的行内代码");
	await window.waitForTimeout(600);
	await shot(window, baseName);
}

test.describe("light", () => {
	test("session surfaces", async ({ window }) => {
		test.setTimeout(120_000);
		await runSession(window, "10-session-light");
	});
});

test.describe("dark", () => {
	test.use({ seedSettings: { theme: "dark" } });
	test("session surfaces", async ({ window }) => {
		test.setTimeout(120_000);
		await runSession(window, "20-session-dark");
	});
});
