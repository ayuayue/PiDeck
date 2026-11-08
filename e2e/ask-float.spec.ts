import { test, expect } from "./mock-pi-fixture";
import { openFirstSession } from "./open-session";

// 浮动提问卡：时间线占满整列、贴底时末尾留白、折叠、拖动（位置记忆）、浮层内照常作答。

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

test("floating ask card", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await openFirstSession(window);
	await composer.click();
	await window.keyboard.type("ASK_BATCH 浮层");
	await window.keyboard.press("Enter");
	const layer = window.locator(".session-v-ask--floating");
	await expect(layer).toBeVisible({ timeout: 15_000 });
	await window.waitForTimeout(600);

	const initial = await window.evaluate(geometry);
	// 时间线占满整列（浮层不再挤占高度），且贴底时给时间线末尾留出余量
	expect(Math.abs(initial.column - initial.stage)).toBeLessThan(4);
	expect(Number.parseFloat(initial.reserve)).toBeGreaterThan(100);

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
	expect(dragged.stored).not.toBeNull();

	// 浮层里照样能答题并提交
	await layer.locator(".ask-inline-bar-option", { hasText: "React" }).click();
	await layer.locator(".ask-inline-bar-option-yes").click();
	await layer.locator(".ask-batch-question-body input").fill("float-ok");
	await layer.locator(".ask-batch-question-body").getByRole("button", { name: "提交" }).click();
	await expect(window.locator(".message-timeline")).toContainText("float-ok", { timeout: 15_000 });
	await expect(layer).toHaveCount(0);
	const reserveAfter = await window.evaluate(() => getComputedStyle(document.querySelector('.message-timeline > [role="log"]') as HTMLElement, "::after").height);
	expect(reserveAfter).toBe("0px");
});
