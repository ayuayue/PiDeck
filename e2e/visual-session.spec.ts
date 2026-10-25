import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openFirstSession, openSettings } from "./open-session";

/**
 * 会话态视觉巡检（#115）：借助 mock pi 截图真实会话运行中的关键状态，
 * 供人工审查。输出 test-results/visual/。
 *
 * 覆盖：流式输出中（含停止按钮）、完整对话 + composer 状态栏
 * （模型/thinking、上下文圆环）、排队条、模型选择器、thinking 选择器。
 */

const OUT_DIR = join(__dirname, "..", "test-results", "visual");
mkdirSync(OUT_DIR, { recursive: true });

async function shot(window: Page, name: string) {
	await window.screenshot({ path: join(OUT_DIR, `${name}.png`) });
}

test("visual tour: live session states", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await openFirstSession(window);
	const timeline = window.locator(".message-timeline");

	// 1. 流式输出中（慢速流，抓中间态 + 停止按钮）
	await composer.click();
	await window.keyboard.type("SLOW 视觉巡检");
	await window.keyboard.press("Enter");
	await expect(timeline).toContainText("Mock 回复：「SLOW 视觉巡检」", { timeout: 10_000 });
	await expect(window.locator(".composer-bar-btn.stop")).toBeVisible();
	await window.waitForTimeout(400);
	await shot(window, "30-session-streaming");

	// 2. 完整对话 + composer 状态栏（等本轮结束）
	await expect(timeline).toContainText("SLOW 视觉巡检」流式渲染验证完成", { timeout: 20_000 });
	// 发送按钮已从 composer-bar-btn.send 迁到 send-behavior-primary（ComposerPanels）
	await expect(window.locator(".send-behavior-primary")).toBeVisible({ timeout: 10_000 });
	// 上下文圆环常驻（mock 占比 45%）；压缩入口在面板内
	await expect(window.getByTestId("session-context-meter")).toBeVisible({ timeout: 10_000 });
	await shot(window, "31-session-idle-composer");

	// 3. 排队条：慢速流中再发一条
	await composer.click();
	await window.keyboard.type("SLOW 排队甲");
	await window.keyboard.press("Enter");
	await expect(timeline).toContainText("Mock 回复：「SLOW 排队甲」", { timeout: 10_000 });
	await composer.click();
	await window.keyboard.type("排队乙");
	await window.keyboard.press("Enter");
	const queuedTrack = window.locator(".queued-track");
	if (await queuedTrack.isVisible().catch(() => false)) {
		await shot(window, "32-session-queued");
	}
	// 等两段跑完，回到空闲
	await expect(timeline).toContainText("排队乙」流式渲染验证完成", { timeout: 30_000 });

	// 4. 模型选择器
	await window.locator(".composer-bar-btn.model").click();
	const modelPalette = window.locator("[data-slot='dialog-content'].model-picker");
	await expect(modelPalette).toBeVisible({ timeout: 5000 });
	await shot(window, "33-model-picker");
	await modelPalette.getByRole("button", { name: /关闭|Close/ }).click();

	// 5. thinking 选择器
	await window.locator(".composer-bar-btn.thinking").click();
	const thinkingPalette = window.locator("[data-slot='dialog-content'].thinking-picker");
	await expect(thinkingPalette).toBeVisible({ timeout: 5000 });
	await shot(window, "34-thinking-picker");
	await thinkingPalette.getByRole("button", { name: /关闭|Close/ }).click();

	// 6. markdown 渲染元素巡检（MDEMO 触发 mock 富文本回复：文件链接/外链/引用/行内代码/代码块/表格）
	await composer.click();
	await window.keyboard.type("MDEMO 元素巡检");
	await window.keyboard.press("Enter");
	await expect(timeline).toContainText("渲染元素巡检", { timeout: 15_000 });
	await expect(window.locator(".send-behavior-primary")).toBeVisible({ timeout: 15_000 });
	await shot(window, "36-markdown-elements");

	// 7. 暗色主题下的会话页：切主题后重截一张完整对话 + markdown 元素
	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	await modal.getByText("外观设置").click();
	await modal.locator("[data-slot='select-trigger']").first().click();
	await window.locator("[data-slot='select-content']").getByText("暗色").click();
	await modal.getByRole("button", { name: "保存" }).click();
	await expect.poll(() => window.evaluate(() => document.documentElement.dataset.theme), { timeout: 5000 }).toBe("dark");
	await window.keyboard.press("Escape");
	await expect(modal)
		.toBeHidden({ timeout: 5000 })
		.catch(() => undefined);
	await shot(window, "35-session-dark");
	await shot(window, "37-markdown-elements-dark");
});
