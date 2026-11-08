import type { Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";
import { openFirstSession } from "./open-session";

// 浮动提问卡：时间线占满整列、贴底时末尾留白（最后一行不被盖住）、不盖「回到底部」与大纲刻度、
// 折叠、拖动（位置记忆）、浮层内照常作答。

function geometry() {
	const layer = document.querySelector(".session-v-ask--floating") as HTMLElement;
	const column = layer.parentElement as HTMLElement;
	const stage = column.querySelector(".session-v-timeline-stage") as HTMLElement;
	const log = column.querySelector('.message-timeline > [role="log"]') as HTMLElement;
	const l = layer.getBoundingClientRect();
	const c = column.getBoundingClientRect();
	return {
		column: c.height,
		stage: stage.getBoundingClientRect().height,
		layerTop: l.top - c.top,
		reserve: getComputedStyle(log, "::after").height,
		stored: localStorage.getItem("pideck:ask-float-offset:v1"),
	};
}

async function send(window: Page, text: string) {
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.type(text);
	await window.keyboard.press("Enter");
}

test("floating ask card", async ({ window }) => {
	test.setTimeout(240_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await openFirstSession(window);
	// 先铺几轮长回复：时间线要能滚动，大纲刻度轴才会出现
	for (const marker of ["LONG 一", "LONG 二", "LONG 三"]) {
		await send(window, marker);
		await expect(window.locator(".message-timeline")).toContainText(`Mock 回复：「LONG」`, { timeout: 15_000 });
		await window.waitForTimeout(1500);
	}
	await send(window, "ASK_BATCH 浮层");
	const layer = window.locator(".session-v-ask--floating");
	await expect(layer).toBeVisible({ timeout: 15_000 });
	await window.waitForTimeout(600);

	const initial = await window.evaluate(geometry);
	// 时间线占满整列（浮层不再挤占高度），贴底时余量 = 卡片顶边到列底 + 缓冲
	expect(Math.abs(initial.column - initial.stage)).toBeLessThan(4);
	expect(Math.abs(Number.parseFloat(initial.reserve) - (initial.column - initial.layerTop + 8))).toBeLessThan(3);

	// 滚到底：最后一条消息停在卡片上方，不被盖住
	const tail = await window.evaluate(async () => {
		const timeline = document.querySelector(".message-timeline") as HTMLElement;
		timeline.scrollTop = timeline.scrollHeight;
		await new Promise((resolve) => setTimeout(resolve, 400));
		const log = timeline.querySelector('[role="log"]') as HTMLElement;
		const last = log.lastElementChild as HTMLElement;
		return { lastBottom: last.getBoundingClientRect().bottom, layerTop: (document.querySelector(".session-v-ask--floating") as HTMLElement).getBoundingClientRect().top };
	});
	expect(tail.lastBottom).toBeLessThanOrEqual(tail.layerTop + 1);

	// 大纲刻度轴：卡片右缘停在刻度左侧，刻度中心点命中刻度而不是卡片
	const rail = await window.evaluate(() => {
		const pane = document.querySelector(".session-outline-pane") as HTMLElement | null;
		const ticks = pane?.firstElementChild as HTMLElement | null;
		const card = (document.querySelector(".session-v-ask--floating") as HTMLElement).getBoundingClientRect();
		if (!pane || !ticks) return null;
		const r = ticks.getBoundingClientRect();
		const probes = [0.25, 0.5, 0.75, 0.95].map((f) => document.elementFromPoint(r.left + r.width / 2, r.top + r.height * f));
		return { cardRight: card.right, railLeft: r.left, hitsCard: probes.filter((el) => el?.closest(".session-v-ask--floating")).length };
	});
	expect(rail, "三轮对话后应出现大纲刻度轴").not.toBeNull();
	expect(rail!.cardRight).toBeLessThanOrEqual(rail!.railLeft);
	expect(rail!.hitsCard).toBe(0);

	// 上翻读历史：「回到底部」按钮出现在卡片上方，点得到
	// 「回到底部」只认用户上翻（滚轮），直接改 scrollTop 不会让它出现
	const timelineBox = await window.locator(".message-timeline").evaluate((el) => {
		const r = el.getBoundingClientRect();
		return { x: r.left + 80, y: r.top + 120 };
	});
	await window.mouse.move(timelineBox.x, timelineBox.y);
	for (let i = 0; i < 6; i += 1) {
		await window.mouse.wheel(0, -600);
		await window.waitForTimeout(100);
	}
	const scrollButton = window.locator("[data-scroll-to-bottom]");
	await expect(scrollButton).toBeVisible({ timeout: 5_000 });
	await window.waitForTimeout(300);
	const buttonHit = await scrollButton.evaluate((el) => {
		const r = el.getBoundingClientRect();
		return Boolean(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest("[data-scroll-to-bottom]"));
	});
	expect(buttonHit).toBe(true);
	await scrollButton.click();

	await layer.getByRole("button", { name: "收起选项" }).click();
	await window.waitForTimeout(500);
	await layer.getByRole("button", { name: "展开选项" }).click();

	// boundingBox 与 Electron 缩放后的坐标系不一致：用 hover 定位起点，再按页面坐标相对位移拖动
	const grip = window.locator(".ask-float-grip");
	const start = await grip.evaluate((el) => {
		const r = el.getBoundingClientRect();
		return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
	});
	await grip.hover();
	await window.mouse.down();
	await window.mouse.move(start.x - 200, start.y - 900, { steps: 8 });
	await window.mouse.up();
	await window.waitForTimeout(500);
	const dragged = await window.evaluate(geometry);
	expect(dragged.layerTop).toBeGreaterThanOrEqual(11);
	expect(dragged.layerTop).toBeLessThan(20);
	expect(dragged.reserve).toBe("0px");
	// 真正记住了拖动后的位置（不是默认的 {0,0}）
	const stored = JSON.parse(dragged.stored ?? "null") as { x: number; y: number } | null;
	expect(stored?.y ?? 0).toBeLessThan(-100);
	expect(stored?.x ?? 0).toBeLessThan(0);

	// 浮层里照样能答题并提交
	await layer.locator(".ask-inline-bar-option", { hasText: "React" }).click();
	await layer.locator(".ask-inline-bar-option-yes").click();
	await layer.locator(".ask-batch-question-body input").fill("float-ok");
	await layer.locator(".ask-batch-question-body").getByRole("button", { name: "提交" }).click();
	await expect(window.locator(".message-timeline")).toContainText("float-ok", { timeout: 15_000 });
	await expect(layer).toHaveCount(0);
	const after = await window.evaluate(() => {
		const column = document.querySelector(".session-v-timeline") as HTMLElement;
		return { reserve: getComputedStyle(document.querySelector('.message-timeline > [role="log"]') as HTMLElement, "::after").height, flagged: column.hasAttribute("data-ask-floating") };
	});
	expect(after.reserve).toBe("0px");
	expect(after.flagged).toBe(false);

	// 下一次提问：卡片出现在上次拖到的位置
	await window.waitForTimeout(1500);
	await send(window, "ASK_BATCH 记住位置");
	await expect(layer).toBeVisible({ timeout: 15_000 });
	await window.waitForTimeout(600);
	const reopened = await window.evaluate(geometry);
	expect(reopened.layerTop).toBeLessThan(20);
});
