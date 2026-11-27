import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import { REVEAL_TIMELINE_ENTRY_EVENT } from "../src/renderer/src/hooks/timeline/timelineRevealChannel";

async function reveal(page: Page, id: string) {
	await page.evaluate(({ event, entryId }) => window.dispatchEvent(new CustomEvent(event, { detail: { entryId } })), { event: REVEAL_TIMELINE_ENTRY_EVENT, entryId: id });
	await expect
		.poll(
			() =>
				page.locator(".message-timeline").evaluate((timeline, messageId) => {
					const node = Array.from(timeline.querySelectorAll<HTMLElement>("[data-message-id]")).find((row) => row.dataset.messageId === messageId);
					if (!node) return false;
					const visible = node.getBoundingClientRect();
					const viewport = timeline.getBoundingClientRect();
					return visible.height > 0 && visible.bottom > viewport.top && visible.top < viewport.bottom && timeline.querySelectorAll("[data-message-id]").length > 0;
				}, id),
			{ timeout: 8000 },
		)
		.toBe(true);
}

test("双向遍历已加载刻度，流式输出时连续点击末尾三条仍保留完整消息区", async ({ window }) => {
	test.setTimeout(120000);
	const errors: string[] = [];
	window.on("pageerror", (error) => errors.push(error.message));
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20000 });
	await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30000 });
	for (let index = 0; index < 6; index++) {
		await composer.fill("jump-check-" + index);
		await window.keyboard.press("Enter");
		await expect(window.locator(".message-timeline")).toContainText("Mock 回复：「jump-check-" + index + "」", { timeout: 20000 });
		await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 20000 });
	}
	const ids = await window.locator(".message-timeline [data-message-id]").evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute("data-message-id")).filter((id): id is string => Boolean(id)))]);
	expect(ids.length).toBeGreaterThanOrEqual(3);
	for (const id of [...ids, ...ids.slice().reverse()]) await reveal(window, id);
	await composer.fill("LONG jump-running");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("jump-running", { timeout: 20000 });
	const tail = await window.locator(".message-timeline [data-message-id]").evaluateAll((nodes) => [...new Set(nodes.map((node) => node.getAttribute("data-message-id")).filter((id): id is string => Boolean(id)))].slice(-3));
	expect(tail.length).toBe(3);
	for (const id of tail.concat(tail.slice().reverse())) await reveal(window, id);
	await expect(window.locator(".message-timeline")).toContainText("jump-running");
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 30000 });
	expect(errors).toEqual([]);
});
