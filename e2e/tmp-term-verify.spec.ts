import { test, expect } from "./mock-pi-fixture";

/**
 * 决定性验证：壁纸模式下终端 xterm 实际背景（scrollableElement inline style）。
 */
test("diag: terminal xterm actual bg", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("button", { name: "启动 Agent" }).click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("aria-disabled", "false", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.type("终端预热");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline"))
		.toContainText("Mock 回复：「终端预热」流式渲染验证完成", { timeout: 20_000 });
	await window.getByRole("button", { name: "终端", exact: true }).first().click();
	const dock = window.locator(".terminal-dock");
	await expect(dock).toBeVisible({ timeout: 8000 });
	await expect(dock.locator(".xterm").first()).toBeVisible({ timeout: 20_000 });

	// 开壁纸：手动注入（data-bg-image 触发 TerminalDock MutationObserver → 重建 xterm）
	await window.evaluate(() => {
		const root = document.documentElement;
		root.dataset.bgImage = "on";
		root.style.setProperty("--wallpaper-panel-alpha", "80%");
		root.style.setProperty("--color-bg-panel", "color-mix(in srgb, #ffffff 80%, transparent)");
	});
	// 等 MutationObserver 触发 + 终端重建
	await window.waitForTimeout(3000);

	const result = await window.evaluate(() => {
		const dock = document.querySelector(".terminal-dock") as HTMLElement | null;
		const xterm = dock?.querySelector(".xterm") as HTMLElement | null;
		const scrollable = dock?.querySelector(".xterm-scrollable-element") as HTMLElement | null;
		const layers = [".terminal-xterm", ".xterm", ".xterm-screen", ".xterm-viewport", ".xterm-scrollable-element"];
		const bg = (sel: string) => {
			const el = dock?.querySelector(sel) as HTMLElement | null;
			return el ? `${sel}: computed=${getComputedStyle(el).backgroundColor} inline=${el.style.backgroundColor || "-"}` : `${sel}: missing`;
		};
		return {
			dockBg: dock ? getComputedStyle(dock).backgroundColor : "missing",
			layers: layers.map(bg),
		};
	});
	console.log("VERIFY:", JSON.stringify(result, null, 2));
	await window.screenshot({ path: "/tmp/term-final.png" });
});
