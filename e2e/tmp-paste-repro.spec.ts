import { test, expect } from "./mock-pi-fixture";

/**
 * 复现：终端打开时粘贴图片 → 终端被压缩；关闭终端 → 输入框高度减半。
 */
test("repro: paste image with terminal open then close terminal", async ({ window }) => {
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

	// 打开终端
	await window.getByRole("button", { name: "终端", exact: true }).first().click();
	const dock = window.locator(".terminal-dock");
	await expect(dock).toBeVisible({ timeout: 8000 });
	await expect(dock.locator(".xterm").first()).toBeVisible({ timeout: 20_000 });

	const measure = () => window.evaluate(() => {
		const pick = (id: string) => {
			const el = document.getElementById(id) as HTMLElement | null;
			return el ? el.offsetHeight : -1;
		};
		const composerBox = document.querySelector(".composer .composer-box") as HTMLElement | null;
		return {
			groupH: (document.querySelector(".session-v-group") as HTMLElement)?.offsetHeight ?? -1,
			timeline: pick("timeline"),
			composer: pick("composer"),
			terminal: pick("terminal"),
			composerBox: composerBox?.offsetHeight ?? -1,
		};
	});

	const dump = (label: string) => window.evaluate((l) => {
		const pick = (id: string) => {
			const el = document.getElementById(id) as HTMLElement | null;
			return el ? el.offsetHeight : -1;
		};
		const composerBox = document.querySelector(".composer .composer-box") as HTMLElement | null;
		console.log(`[REPRO] ${l}`, JSON.stringify({
			timeline: pick("timeline"),
			composer: pick("composer"),
			terminal: pick("terminal"),
			composerBox: composerBox?.offsetHeight ?? -1,
		}));
	}, label);

	await window.waitForTimeout(1500);
	await dump("terminal-open");

	// 粘贴图片：构造 ClipboardEvent 携带 image/png File
	await window.evaluate(() => {
		const input = document.querySelector(".composer .rich-input") as HTMLElement;
		if (!input) throw new Error("no rich-input");
		const dt = new DataTransfer();
		dt.items.add(new File([new Uint8Array([137, 80, 78, 71])], "clip.png", { type: "image/png" }));
		const ev = new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true });
		input.dispatchEvent(ev);
	});
	await expect(window.locator(".composer .attachment-bar, .composer [class*=attachment]").first()).toBeVisible({ timeout: 8000 }).catch(() => {});
	await window.waitForTimeout(1500);
	await dump("after-paste");

	// 关闭终端（terminal dock 的关闭全部按钮 title=关闭全部）
	await dock.getByTitle("关闭全部").dispatchEvent("click");
	// 确认对话框（Radix AlertDialog role=alertdialog）
	const confirmBtn = window.locator("[role=alertdialog] button", { hasText: "关闭全部" });
	if (await confirmBtn.count()) {
		await confirmBtn.click();
	}
	await expect(dock).toHaveCount(0, { timeout: 8000 });
	await window.waitForTimeout(1500);
	await dump("after-close-terminal");

	// 输入内容
	await composer.click();
	await window.keyboard.type("恢复测试");
	await window.waitForTimeout(1200);
	await dump("after-type");

	const m = await measure();
	// 记录断言（宽松）
	expect(m.composer).toBeGreaterThan(0);
});
