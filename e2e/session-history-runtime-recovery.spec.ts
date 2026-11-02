import { test, expect } from "./mock-pi-fixture";

test("Agent 崩溃后的历史编辑会激活新 runtime 再 fork", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	const send = async (text: string) => {
		await composer.click();
		await window.keyboard.type(text);
		await window.keyboard.press("Enter");
	};
	const timeline = window.locator(".message-timeline");
	const firstReply = "Mock 回复：「崩溃前完整轮」流式渲染验证完成。";
	await send("崩溃前完整轮");
	await expect(timeline).toContainText(firstReply, { timeout: 30_000 });
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 20_000 });
	await send("CRASH 崩溃触发");
	await expect(timeline).toContainText("崩溃前最后输出", { timeout: 30_000 });
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 20_000 });

	const turn = timeline.locator(".turn-row").filter({ hasText: firstReply });
	await turn.getByTitle("编辑").click();
	await timeline.locator("textarea").fill("崩溃恢复后的编辑");
	await timeline.getByRole("button", { name: "保存" }).click();

	await expect(timeline).toContainText("崩溃恢复后的编辑", { timeout: 45_000 });
	await expect(timeline).toContainText("Mock 回复：「崩溃恢复后的编辑」流式渲染验证完成。", { timeout: 30_000 });
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 20_000 });
});
