import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import type { ElectronApplication } from "@playwright/test";

/**
 * 复现：agent 流式输出中，用户插入一条「下次调用前」（steer）消息后，
 * 时间线视口不贴底 / 下滑被弹回（跳上去），过一会儿才恢复。
 *
 * 前置：先构造一个真实可滚动的长对话（scrollHeight > clientHeight），
 * 否则「贴底跟随」和「下滑跳回」都无从谈起（短内容 no-op）。
 *
 * 测量：
 * - distToBottom = scrollHeight - scrollTop - clientHeight；贴底期间应 ≈ 0。
 * - 主动模拟用户滚轮向下，观察 scrollTop 是否被拉回（跳上去 = finalTop < maxTop - 阈值）。
 */
async function startAgent(window: Page) {
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

async function sendPrompt(window: Page, text: string) {
	const composer = window.locator(".composer .rich-input");
	await composer.click();
	await composer.fill(text);
	await expect(composer).toContainText(text);
	await window.keyboard.press("Enter");
}

async function constrainTimelineViewport(app: ElectronApplication) {
	await app.evaluate(({ BrowserWindow }) => {
		const window = BrowserWindow.getAllWindows()[0];
		if (!window) return;
		if (window.isMaximized()) window.unmaximize();
		window.setBounds({ width: 900, height: 400 });
	});
}

type ScrollSample = {
	t: number;
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	distToBottom: number;
	overflow: boolean;
};

async function sampleScroll(window: Page, windowMs: number, intervalMs = 40) {
	return window.evaluate(
		({ windowMsArg, intervalMsArg }) =>
			new Promise<ScrollSample[]>((resolve) => {
				const timeline = document.querySelector<HTMLElement>(".message-timeline");
				if (!timeline) {
					resolve([]);
					return;
				}
				const samples: ScrollSample[] = [];
				const start = performance.now();
				const tick = () => {
					samples.push({
						t: Math.round(performance.now() - start),
						scrollTop: timeline.scrollTop,
						scrollHeight: timeline.scrollHeight,
						clientHeight: timeline.clientHeight,
						distToBottom: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
						overflow: timeline.scrollHeight > timeline.clientHeight + 10,
					});
					if (performance.now() - start < windowMsArg) {
						setTimeout(tick, intervalMsArg);
					} else {
						resolve(samples);
					}
				};
				tick();
			}),
		{ windowMsArg: windowMs, intervalMsArg: intervalMs },
	);
}

/** 模拟用户滚轮向下滚动 N 格，观察滚动后是否被拉回（跳上去）。 */
async function wheelDownAndCheckJumpBack(
	window: Page,
	steps = 10,
	deltaPerStep = 140,
	settleMs = 700,
): Promise<{ maxTop: number; finalTop: number; jumpedBack: boolean; lastDist: number }> {
	return window.evaluate(
		({ stepsArg, deltaArg, settleMsArg }) =>
			new Promise((resolve) => {
				const timeline = document.querySelector<HTMLElement>(".message-timeline");
				if (!timeline) {
					resolve({ maxTop: 0, finalTop: 0, jumpedBack: false, lastDist: 0 });
					return;
				}
				const tops: number[] = [];
				tops.push(timeline.scrollTop);
				let step = 0;
				const scrollStep = () => {
					if (step >= stepsArg) {
						setTimeout(() => {
							const finalTop = timeline.scrollTop;
							const maxTop = Math.max(...tops, finalTop);
							resolve({
								maxTop,
								finalTop,
								jumpedBack: finalTop < maxTop - 10,
								lastDist: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
							});
						}, settleMsArg);
						return;
					}
					timeline.dispatchEvent(
						new WheelEvent("wheel", { deltaY: deltaArg, bubbles: true, cancelable: true }),
					);
					timeline.scrollTop += deltaArg;
					tops.push(timeline.scrollTop);
					step += 1;
					setTimeout(scrollStep, 30);
				};
				scrollStep();
			}),
		{ stepsArg: steps, deltaArg: deltaPerStep, settleMsArg: settleMs },
	);
}

test("steer insertion during stream keeps viewport pinned at bottom", async ({ app, window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await constrainTimelineViewport(app);
	const composer = await startAgent(window);
	const timeline = window.locator(".message-timeline");

	// ── 构造长对话：连续 6 轮，确保时间线真正溢出可滚动 ──
	for (let i = 1; i <= 6; i += 1) {
		const text = `前置对话第 ${i} 轮：让时间线足够长以便滚动复现。`;
		await sendPrompt(window, text);
		await expect(timeline).toContainText(text.slice(0, 10), { timeout: 15_000 });
		await expect(timeline).toContainText("流式渲染验证完成", { timeout: 15_000 });
	}
	// 确认可滚动
	const pre = await sampleScroll(window, 120, 40);
	const lastPre = pre[pre.length - 1];
	expect(lastPre?.overflow, "timeline should overflow after 6 turns").toBe(true);
	console.log("[steer-scroll] pre-check overflow:", lastPre?.overflow, "scrollH:", lastPre?.scrollHeight, "clientH:", lastPre?.clientHeight);

	// ── Phase A：启动慢速流式回复（约 4s）──
	await sendPrompt(window, "SLOW 第一条 正在长输出");
	await expect(timeline).toContainText("Mock 回复：「SLOW 第一条 正在长输出」", { timeout: 15_000 });
	// 等流式进行中
	await window.waitForTimeout(1000);

	// ── Phase B：流式中插入一条「下次调用前」消息（忙碌时默认投递 = steer）──
	await sendPrompt(window, "steer 插一句：继续！");
	await window.waitForTimeout(300);

	// ── Phase C：采样 4s（覆盖首轮收尾 + steer 第二轮）──
	const samples = await sampleScroll(window, 4000, 40);
	expect(samples.length).toBeGreaterThan(20);
	const offBottom = samples.filter((s) => s.distToBottom > 40).length;
	const offBottomRatio = offBottom / samples.length;
	console.log(
		"[steer-scroll] samples:", samples.length,
		"offBottom>40px:", offBottom, "ratio:", offBottomRatio.toFixed(2),
		"lastDist:", samples[samples.length - 1]?.distToBottom,
		"scrollTop trace:", samples.map((s) => `${s.t}:${s.scrollTop}/${s.distToBottom}`).join(" "),
	);
	expect(offBottomRatio, "viewport should stay pinned to bottom during steer delivery").toBeLessThan(0.5);

	// ── Phase D：模拟用户持续下滑，验证不会被「跳上去」──
	const jump = await wheelDownAndCheckJumpBack(window, 10, 140, 700);
	console.log(
		"[steer-scroll] wheelDown maxTop:", jump.maxTop,
		"finalTop:", jump.finalTop,
		"jumpedBack:", jump.jumpedBack,
		"lastDist:", jump.lastDist,
	);
	expect(jump.jumpedBack, "scrolling down should not be yanked back up").toBe(false);
});