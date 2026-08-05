import { test, expect } from "./mock-pi-fixture";

/**
 * 终端 Dock（#113 3.3-12）：开合、xterm 就绪、shell 菜单。
 * 需要真实 agent（outline 的终端入口仅在 activeAgentId 时渲染），
 * 故使用 mock pi fixture；拖拽高度保留手动验证。
 */

test("layout: terminal dock open/shell/collapse", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("button", { name: "启动 Agent" }).click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("aria-disabled", "false", { timeout: 30_000 });

	// 发送一条让 agent 进程真实运行，再打开终端
	await composer.click();
	await window.keyboard.type("终端预热");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline"))
		.toContainText("Mock 回复：「终端预热」流式渲染验证完成", { timeout: 20_000 });

	// outline 右侧条上的终端按钮（aria-label 终端）
	await window.getByRole("button", { name: "终端", exact: true }).first().click();

	const dock = window.locator(".terminal-dock");
	await expect(dock).toBeVisible({ timeout: 8000 });
	await expect(dock).not.toHaveClass(/collapsed/);

	// xterm 就绪（node-pty spawn 真实 shell）
	await expect(dock.locator(".xterm").first()).toBeVisible({ timeout: 20_000 });

	// shell 菜单：点击「选择 Shell」触发器，菜单出现；再点一次触发器收起
	//（菜单的 fixed backdrop 会拦截后续点击）。
	// xterm 的画布层有时会盖住 header 按钮（<div> intercepts pointer events），
	// 菜单开合属于纯渲染层状态机，用 dispatchEvent 直发规避画布层遮挡。
	const shellTrigger = dock.getByTitle("选择 Shell");
	await shellTrigger.dispatchEvent("click");
	await expect(dock.locator(".terminal-shell-menu")).toBeVisible({ timeout: 5000 });
	await shellTrigger.dispatchEvent("click");
	await expect(dock.locator(".terminal-shell-menu")).toBeHidden({ timeout: 3000 });

	// 折叠 dock：「收起终端」按钮 → collapsed 类出现
	await dock.getByTitle("收起终端").dispatchEvent("click");
	await expect(dock).toHaveClass(/collapsed/, { timeout: 3000 });

	// 拖拽高度：react-resizable-panels 在 headless Electron 上 pointer 命中不稳定，
	// 保留 soft check（不 fail 整用例）。硬断言仍以开合/shell 菜单为准。
	await dock.getByTitle("展开终端").dispatchEvent("click").catch(async () => {
		await dock.dispatchEvent("click");
	});
	if (!(await dock.evaluate((el) => el.classList.contains("collapsed")))) {
		const heightBefore = (await dock.boundingBox())?.height ?? 0;
		const splitter = window.locator(".v-splitter").last();
		const box = await splitter.boundingBox().catch(() => null);
		if (box && heightBefore >= 80) {
			const cx = box.x + box.width / 2;
			const cy = box.y + box.height / 2;
			await window.mouse.move(cx, cy);
			await window.mouse.down();
			await window.mouse.move(cx, cy - 100, { steps: 12 });
			await window.mouse.up();
			await window.waitForTimeout(250);
			const heightAfter = (await dock.boundingBox())?.height ?? 0;
			if (heightAfter < heightBefore + 10) {
				console.warn(`[layout-terminal] drag soft-check skipped: ${heightBefore} → ${heightAfter}`);
			}
		}
	}
});

test("layout: terminal stays open while the agent streams", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("button", { name: "启动 Agent" }).click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("aria-disabled", "false", { timeout: 30_000 });

	// 先完成一轮，确保 outline 已有 activeAgentId 和终端入口。
	await composer.click();
	await window.keyboard.type("终端流式预热");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline"))
		.toContainText("Mock 回复：「终端流式预热」流式渲染验证完成", { timeout: 20_000 });

	await window.getByRole("button", { name: "终端", exact: true }).first().click();
	const dock = window.locator(".terminal-dock");
	await expect(dock).toBeVisible({ timeout: 8_000 });
	await expect(dock).not.toHaveClass(/collapsed/);
	await expect(dock.locator(".xterm").first()).toBeVisible({ timeout: 20_000 });

	// mock-pi 的 SLOW 回复约持续 4 秒；流式 runtime-state 更新期间，终端 state
	// 不能被 prune 误删，否则 dock 会在这里消失或进入 collapsed 状态。
	await composer.click();
	await window.keyboard.type("SLOW 保持终端展开");
	await window.keyboard.press("Enter");
	await window.waitForTimeout(800);
	await expect(dock).toBeVisible();
	await expect(dock).not.toHaveClass(/collapsed/);

	await expect(window.locator(".message-timeline"))
		.toContainText("Mock 回复：「SLOW 保持终端展开」流式渲染验证完成", { timeout: 20_000 });
	await expect(dock).toBeVisible();
	await expect(dock).not.toHaveClass(/collapsed/);
});
