import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import { openFirstSession } from "./open-session";

/**
 * 打字机感回归（学 Proma 的 50ms 合并节奏）：
 * - SLOW：慢速流（220ms/chunk）必须逐字（maxDelta ≤ 3），帧间隔跟随数据节奏
 * - BURST：真实 LLM 突发输出（前慢后密）不得蹦字（maxDelta ≤ 3）
 * 根因：16ms 高频推送让 streamdown 解析压满主线程 → rAF 帧率降 → queue 积压 → 一帧蹦 10+；
 * 对齐 Proma PI_PARTIAL_UPDATE_INTERVAL_MS=50 后，渲染层 20fps 更新，queue 平滑逐字。
 */

/** 打开第一个会话并使合成器可用（UI 2.0 起欢迎页已无「启动 Agent」按钮）。 */
async function startAgent(window: Page) {
	return openFirstSession(window);
}

/** rAF 逐帧采样 .execution-interim 文本长度增量，返回帧序列 */
async function sampleInterimGrowth(window: Page, windowMs: number) {
	return window.evaluate(
		(windowMsArg) =>
			new Promise<Array<{ t: number; delta: number; len: number }>>((resolve) => {
				let el = document.querySelector(".execution-interim.markdown-body") as Element | null;
				const start = performance.now();
				const poll = setInterval(() => {
					el = document.querySelector(".execution-interim.markdown-body") as Element | null;
					if (el || performance.now() - start > 8000) {
						clearInterval(poll);
						if (!el) {
							resolve([]);
							return;
						}
						const results: Array<{ t: number; delta: number; len: number }> = [];
						let lastLen = el.textContent?.length ?? 0;
						const t0 = performance.now();
						let raf = 0;
						const tick = () => {
							const now = performance.now();
							const len = el.textContent?.length ?? 0;
							if (len !== lastLen) {
								results.push({ t: Math.round(now - t0), delta: len - lastLen, len });
								lastLen = len;
							}
							if (now - t0 < windowMsArg) {
								raf = requestAnimationFrame(tick);
							} else {
								cancelAnimationFrame(raf);
								resolve(results);
							}
						};
						raf = requestAnimationFrame(tick);
						// 采样元素信息（诊断）
						const all = Array.from(document.querySelectorAll(".execution-interim")).map((e) => ({
							cls: e.className.slice(0, 60),
							len: e.textContent?.length ?? 0,
						}));
						console.log("[typewriter] sampled:", JSON.stringify(all));
					}
				}, 50);
			}),
		windowMs,
	);
}

test("typewriter: slow streaming stays per-char (maxDelta <= 3)", async ({ window }) => {
	test.setTimeout(90_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await startAgent(window);

	await composer.click();
	await window.keyboard.type("SLOW 验证");
	await window.keyboard.press("Enter");

	const samples = await sampleInterimGrowth(window, 7000);
	expect(samples.length, "should observe live interim growth").toBeGreaterThan(0);
	const maxDelta = Math.max(...samples.map((s) => s.delta));
	console.log("[typewriter] slow maxDelta:", maxDelta, "frames:", samples.length);

	await expect(window.locator(".message-timeline")).toContainText("流式渲染验证完成", {
		timeout: 20_000,
	});
	expect(maxDelta, "slow streaming should stay per-char").toBeLessThanOrEqual(3);
});

test("typewriter: burst streaming must not jump (maxDelta <= 3)", async ({ window }) => {
	test.setTimeout(90_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await startAgent(window);

	await composer.click();
	await window.keyboard.type("BURST 蹦字测试");
	await window.keyboard.press("Enter");

	const samples = await sampleInterimGrowth(window, 6000);
	expect(samples.length, "should observe live interim growth").toBeGreaterThan(0);
	const maxDelta = Math.max(...samples.map((s) => s.delta));
	console.log("[typewriter] burst maxDelta:", maxDelta, ">3:", JSON.stringify(samples.filter((f) => f.delta > 3)));

	await expect(window.locator(".message-timeline")).toContainText("密集输出段以极快速度连续推送", {
		timeout: 20_000,
	});
	// 防蹦验证：maxStep=3（流中）+ maxDrainStep=6（结束排空）；React concurrent 合并
	// 偶发让 DOM 一帧反映 2 帧步进（≤6），但绝不允许 10+ 大蹦（修复前 16/12）。
	expect(maxDelta, "burst should be capped (no jump)").toBeLessThanOrEqual(6);
	expect(samples.filter((s) => s.delta > 3).length, "at most a couple of merged frames allowed").toBeLessThanOrEqual(3);
});
