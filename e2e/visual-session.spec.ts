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
	// 发送/停止是同一颗主钮（ComposerPanels 的 .composer-send-primary），忙时 aria-label 变「停止」。
	await expect(window.locator('.composer-send-primary[aria-label="停止"]')).toBeVisible();
	await window.waitForTimeout(400);
	await shot(window, "30-session-streaming");

	// 2. 完整对话 + composer 状态栏（等本轮结束）
	await expect(timeline).toContainText("SLOW 视觉巡检」流式渲染验证完成", { timeout: 20_000 });
	// 发送按钮是 ComposerPanels 的主钮 .composer-send-primary（空闲时 aria-label=发送；
	// 旧的 .composer-bar-btn.send / .send-behavior-primary 都已不存在）。
	await expect(window.locator('.composer-send-primary[aria-label="发送"]')).toBeVisible({ timeout: 10_000 });
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
	// 模型名按钮在 .model-thinking 芯片里，aria-label = app.modelPickerTitle「选择模型」
	await window.locator('.model-thinking button[aria-label="选择模型"]').click();
	const modelPalette = window.locator("[data-slot='dialog-content'].model-picker");
	await expect(modelPalette).toBeVisible({ timeout: 5000 });
	await shot(window, "33-model-picker");
	await modelPalette.getByRole("button", { name: /关闭|Close/ }).click();

	// 5. thinking 选择器
	// 思考档位已并入 .model-thinking 芯片（不再是独立 *.thinking-picker dialog）：
	// 这里只验证触发钮可见、能点开并截一张图，不绑定具体容器。
	const thinkingTrigger = window.locator('[aria-label="选择思考级别"]').first();
	await expect(thinkingTrigger).toBeVisible({ timeout: 5000 });
	await thinkingTrigger.click();
	await window.waitForTimeout(300);
	await shot(window, "34-thinking-picker");
	await window.keyboard.press("Escape");

	// 6. markdown 渲染元素巡检（MDEMO 触发 mock 富文本回复：文件链接/外链/引用/行内代码/代码块/表格）
	await composer.click();
	await window.keyboard.type("MDEMO 元素巡检");
	await window.keyboard.press("Enter");
	await expect(timeline).toContainText("渲染元素巡检", { timeout: 15_000 });
	await expect(window.locator('.composer-send-primary[aria-label="发送"]')).toBeVisible({ timeout: 15_000 });
	await shot(window, "36-markdown-elements");

	// 7. 暗色主题下的会话页：直接切 dataset.theme。
	// 这条是「视觉巡检 + 截图」，只关心暗色下的渲染效果；设置面板的主题控件选择器
	// 随外观设置改版易变（旧的 select-trigger 已不存在），主题持久化由设置相关用例覆盖。
	await window.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
	});
	await window.waitForTimeout(400);
	await shot(window, "35-session-dark");
	await shot(window, "37-markdown-elements-dark");
});
