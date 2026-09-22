import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";

/**
 * 自动重试状态卡（用户反馈回归，真实 DOM 断言）。
 *
 * 背景：pi 的自动重试按「一次 LLM 调用」计数——同一轮 run 内每次 5xx 都会各发一次
 * auto_retry_end(success)，主进程每个周期各留一张卡，于是长时间运行的一轮里时间线上
 * 会堆成一排「自动重试成功，共重试 N 次」（用户截图）。产品要求：
 * 1) 重试进行中时间线只挂一张卡（连续重试不叠加）；
 * 2) 重试成功后这张卡从时间线消失（toast 仍照常报告）；
 * 3) 重试最终失败的卡保留留痕。
 *
 * 断言必须发生在**本轮仍在运行**时：agent_settled 会重读会话文件，PiDeck 本地的重试卡
 * 本来就会随之消失——只断言收尾后的状态等于什么都没测。所以 mock 在 3 个重试周期之后
 * 用 SLOW 节奏输出正常回答，留出轮内断言窗口。
 *
 * 这里用 mock pi 复刻真实 pi 的 auto_retry_start/auto_retry_end 事件序列，断言渲染层真实 DOM。
 */

/** 重试卡正文（不含标题/时间）——正文前缀区分进行中 / 成功 / 失败三态。 */
const RUNNING_RETRY_TEXT = /^正在自动重试/;
const SUCCEEDED_RETRY_TEXT = /^自动重试成功/;
const FAILED_RETRY_TEXT = /^自动重试失败/;

async function startAgent(window: Page) {
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

test("retry card: 连续重试只挂一张卡，成功后卡片消失且 toast 照旧", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await startAgent(window);
	const timeline = window.locator(".message-timeline");

	await composer.click();
	await window.keyboard.type("RETRY_OK 连续重试三次");
	await window.keyboard.press("Enter");

	// 1. 重试进行中：时间线上有且只有一张「正在自动重试」卡
	const runningCards = timeline.getByText(RUNNING_RETRY_TEXT);
	await expect(runningCards).toHaveCount(1, { timeout: 20_000 });
	await expect(runningCards).toContainText("正在自动重试 1/3");

	// 2. 连续重试期间采样：任意时刻时间线上的诊断卡（= 重试卡）都不超过一张。
	//    旧实现每个周期各留一张成功卡，第二轮起就会采到 2～3 张（用户截图那排卡）。
	//    必须用 count() 即时快照而不是 expect().toHaveCount()：后者会轮询到超时，
	//    可能等到「本轮收尾后卡片被文件重读清掉」才碰上 0 而假通过。
	const samples: number[] = [];
	for (let index = 0; index < 30; index += 1) {
		samples.push(await timeline.locator(".diagnostic-card").count());
		await window.waitForTimeout(150);
	}
	expect(Math.max(...samples), `连续重试期间时间线上出现了多张卡（采样：${samples.join(",")}）`).toBeLessThanOrEqual(1);

	// 3. 重试成功仍由 toast 报告（卡片不进时间线不能把 toast 一起吃掉）
	await expect(window.locator("[data-sonner-toaster]")).toContainText("自动重试成功", { timeout: 20_000 });

	// 4. 3 个重试周期全部收敛后、最终回答开始流式时（mock 在此之前保留 4s 空窗）即时断言：
	//    成功卡不在时间线上。旧实现此处是 3 张「自动重试成功」——用户截图里的那排卡。
	//    同样用 count() 即时快照：toHaveCount() 会轮询，可能等到渲染层中途清卡才碰上 0。
	await expect(timeline).toContainText("Mock 回复：「SLOW RETRY_OK", { timeout: 40_000 });
	expect(await timeline.getByText(SUCCEEDED_RETRY_TEXT).count(), "重试成功卡不应留在时间线上").toBe(0);
	expect(await timeline.locator(".diagnostic-card").count(), "重试卡应收敛到零张").toBe(0);

	// 5. 收尾后同样干净，且会话内容不受影响
	await expect(timeline).toContainText("流式渲染验证完成", { timeout: 30_000 });
	expect(await timeline.getByText(SUCCEEDED_RETRY_TEXT).count()).toBe(0);
	await expect(timeline).toContainText("RETRY_OK 连续重试三次");
});

test("retry card: 重试最终失败保留失败卡留痕", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await startAgent(window);
	const timeline = window.locator(".message-timeline");

	await composer.click();
	await window.keyboard.type("RETRY_FAIL 重试耗尽");
	await window.keyboard.press("Enter");

	await expect(timeline.getByText(RUNNING_RETRY_TEXT)).toHaveCount(1, { timeout: 20_000 });
	// 收敛为失败：卡片留在时间线上（用户选择「只隐藏成功卡」）
	const failedCard = timeline.getByText(FAILED_RETRY_TEXT);
	await expect(failedCard).toHaveCount(1, { timeout: 20_000 });
	await expect(failedCard).toContainText("自动重试失败，已重试 1/3 次");
	// 失败原因仍以错误卡呈现（留痕可排查）
	await expect(timeline).toContainText("HTTP 429 Too Many Requests");
});
