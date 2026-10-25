import { test, expect } from "./fixtures";
import { openFirstSession } from "./open-session";

/**
 * E2E 窗口默认「不打扰」回归：
 * Playwright 启动的应用窗口必须摆到屏幕外（不遮挡用户桌面、不抢焦点），
 * 同时渲染/输入链路不受影响（CDP 点击与截图都不依赖窗口真实可见性）。
 * 需要真实窗口几何的用例通过 e2eWindowMode: "visible" 回退（window-memory / quick-task）。
 */

test("e2e windows stay off-screen, visible and unfocused by default", async ({ app, window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const state = await app.evaluate(({ BrowserWindow }) => {
		const target = BrowserWindow.getAllWindows()[0];
		if (!target) return null;
		const bounds = target.getBounds();
		return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, visible: target.isVisible(), focused: target.isFocused() };
	});
	expect(state).not.toBeNull();
	// 屏幕外：远离用户桌面（同时也离开所有常见虚拟桌面范围）
	expect(state!.x).toBeLessThanOrEqual(-10_000);
	expect(state!.y).toBeLessThanOrEqual(-10_000);
	// 仍保持 visible（isVisible 语义/Playwright 窗口发现依赖它），但不持有系统焦点
	expect(state!.visible).toBe(true);
	expect(state!.focused).toBe(false);
});

test("off-screen e2e window still renders and accepts CDP input", async ({ window }) => {
	const composer = await openFirstSession(window);
	await composer.click();
	await window.keyboard.type("离屏窗口也要能输入");
	await expect(composer).toContainText("离屏窗口也要能输入");
	// 截图不能是空白/纯色（离屏窗口若被遮挡节流，PNG 会小到只有几十字节）
	const shot = await window.screenshot();
	expect(shot.length).toBeGreaterThan(20_000);
});
