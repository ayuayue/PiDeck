import { test, expect } from "./mock-pi-fixture";
import type { ElectronApplication, Page } from "@playwright/test";

/**
 * 回归：活动 run 的内容收缩（live→settled 交接 / 工具 / Markdown 重排）会让浏览器
 * clamp scrollTop 并派发 scroll；controller 旧逻辑仅凭 scrollTop 变小判「用户上滑」，
 * 误调 expandWindowBatched → escapeAutoScroll，导致：
 * 1) 运行中时间线自动脱离吸底；
 * 2) 回底按钮点击后窗口被立刻重新扩回（点击无效、手动下滑也难重锁）。
 *
 * 修复后断言：
 * - 回底后即使内容收缩（clamp 上移），窗口保持 3 轮、按钮不出现、视口贴底；
 * - 真实用户上滚仍能渐进扩窗（历史浏览不受影响）；
 * - 用户下滚到底能重锁，继续下滑（无位移）也不会掉开。
 *
 * 说明：Playwright dispatch 的合成 WheelEvent 不会产生原生滚动位移，
 * 与现有 steer-scroll-repro 一致：dispatch wheel（触发引擎意图/逃逸判定）后再
 * 手动调整 scrollTop（触发原生 scroll 事件），两者时序就是真实滚轮的时序。
 * wheel 必须打在正文节点（.turn-row），不能打在 .message-timeline 自己身上——
 * 真实滚轮的 target 是段落，只打 section 会漏掉 overflowY 回溯回归。
 */
async function sendPrompt(window: Page, text: string) {
	const composer = window.locator(".composer .rich-input");
	await composer.click();
	await composer.fill(text);
	await window.keyboard.press("Enter");
	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText(text.slice(0, 10), { timeout: 15_000 });
	await expect(timeline).toContainText("流式渲染验证完成", { timeout: 15_000 });
	// 等本轮 run 完全结束（发送按钮回到空闲）——否则下一条 prompt 会被 mock 按
	// steer/排队语义合并进同一 run，造不出「超过 3 轮可扩窗」的历史。
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", {
		timeout: 15_000,
	});
}

async function fitNearTopBottom(app: ElectronApplication, window: Page) {
	// 前置：窗口可能被环境干扰最小化（并发 e2e / OS 行为）。Windows 上最小化/隐藏
	// 窗口的 setBounds 会被忽略（实测 bounds 恒为初始值），几何永远不达标；先恢复可见。
	await app.evaluate(({ BrowserWindow }) => {
		const target = BrowserWindow.getAllWindows()[0];
		if (!target) return;
		if (target.isMinimized()) target.restore();
		if (!target.isVisible()) target.showInactive();
		if (target.isMaximized()) target.unmaximize();
	});
	const measure = async () => {
		await window.locator(".message-timeline").evaluate((timeline) => {
			timeline.scrollTop = timeline.scrollHeight;
		});
		await window.waitForTimeout(80);
		return geometry(window);
	};
	const inBand = (current: Awaited<ReturnType<typeof geometry>>) => current.maxTop > 40 && current.maxTop < current.expandThreshold - 20;
	// 1）先只调 zoom：zoom 不依赖窗口可见性/可调整性（窗口被最小化时 setBounds
	//    无效但 setZoomFactor 始终生效），CSS 视口随 zoom 缩小即可得到「内容可滚动
	//    且底部落在自动扩窗阈值内」的几何。
	for (const zoomFactor of [1, 1.05, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5]) {
		await app.evaluate(({ BrowserWindow }, z) => {
			const target = BrowserWindow.getAllWindows()[0];
			if (!target) return;
			target.webContents.setZoomFactor(z);
		}, zoomFactor);
		await window.waitForTimeout(120);
		const current = await measure();
		if (inBand(current)) return current;
	}
	// 2）兜底：窗口可见时再扫窗口高度（原有策略，保留以兼容不同内容高度）。
	for (const zoomFactor of [1, 0.95, 0.9, 0.85]) {
		for (const height of [700, 760, 820, 880, 940, 1020, 1120, 1220]) {
			await app.evaluate(
				({ BrowserWindow }, next) => {
					const target = BrowserWindow.getAllWindows()[0];
					if (!target) return;
					if (target.isMinimized()) target.restore();
					if (!target.isVisible()) target.showInactive();
					if (target.isMaximized()) target.unmaximize();
					target.webContents.setZoomFactor(next.zoomFactor);
					target.setBounds({ width: 900, height: next.height });
				},
				{ height, zoomFactor },
			);
			await window.waitForTimeout(120);
			const current = await measure();
			if (inBand(current)) return current;
		}
	}
	throw new Error(`Could not fit near-top bottom geometry: ${JSON.stringify(await geometry(window))}`);
}

function bottomButton(window: Page) {
	return window.locator("button[aria-label='移动到最新'], button[aria-label='Scroll to bottom']");
}

async function geometry(window: Page) {
	return window.locator(".message-timeline").evaluate((timeline) => ({
		scrollTop: timeline.scrollTop,
		scrollHeight: timeline.scrollHeight,
		clientHeight: timeline.clientHeight,
		maxTop: Math.max(0, timeline.scrollHeight - timeline.clientHeight),
		expandThreshold: Math.max(120, Math.round(timeline.clientHeight * 0.4)),
		dist: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
	}));
}

/** 注入一段临时内容再移除：模拟活动 run 中 live 段落挂载/卸载的高度往返。 */
async function pulseShrink(window: Page, pixels = 120) {
	return window.locator(".message-timeline").evaluate(async (timeline, height) => {
		const content = timeline.querySelector<HTMLElement>(":scope > [role='log']");
		if (!content) throw new Error("timeline content missing");
		const pulse = document.createElement("div");
		pulse.dataset.scrollProbe = "pulse";
		pulse.style.cssText = `height:${height}px;min-height:${height}px;flex:0 0 ${height}px`;
		content.append(pulse);
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		timeline.scrollTop = timeline.scrollHeight;
		await new Promise((resolve) => setTimeout(resolve, 60));
		pulse.remove();
		await new Promise((resolve) => setTimeout(resolve, 500));
		return {
			top: timeline.scrollTop,
			height: timeline.scrollHeight,
			client: timeline.clientHeight,
		};
	}, pixels);
}

/**
 * 让输入栏固有高度变大，模拟 todo / 修改文件 / 子代理卡在流式期间出现。
 * 消息内容高度保持不变；吸底必须响应 viewport 的 clientHeight 变化。
 */
async function resizeComposerSibling(window: Page, growBy: number) {
	return window.locator(".session-v-composer").evaluate(async (composer, delta) => {
		const timeline = document.querySelector<HTMLElement>(".message-timeline");
		if (!timeline) throw new Error("timeline missing");
		const previousMinHeight = composer.style.minHeight;
		const before = {
			clientHeight: timeline.clientHeight,
			scrollHeight: timeline.scrollHeight,
		};
		composer.style.minHeight = `${composer.getBoundingClientRect().height + delta}px`;
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		await new Promise((resolve) => setTimeout(resolve, 120));
		const result = {
			before,
			after: {
				clientHeight: timeline.clientHeight,
				scrollHeight: timeline.scrollHeight,
				dist: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
			},
			buttonVisible: Boolean(document.querySelector<HTMLElement>("button[aria-label='移动到最新'], button[aria-label='Scroll to bottom']")?.offsetParent),
		};
		composer.style.minHeight = previousMinHeight;
		await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
		return result;
	}, growBy);
}

/**
 * 普通点击只会留下 collapsed selection，并不表示用户正在拖选正文。
 * 若此时刚好收到布局 scroll 事件，引擎不得把这次点击误判成上滚逃逸。
 */
async function dispatchCollapsedSelectionScroll(window: Page) {
	await window.locator(".message-timeline").evaluate(async (timeline) => {
		const target = timeline.querySelector<HTMLElement>(".turn-row") ?? timeline;
		const selection = window.getSelection();
		if (!selection) throw new Error("selection unavailable");
		const range = document.createRange();
		range.selectNodeContents(target);
		range.collapse(true);
		selection.removeAllRanges();
		selection.addRange(range);

		// 先消费可能由前一次回底留下的 ignoreScrollToTop，再模拟点击与布局 scroll 重合。
		timeline.dispatchEvent(new Event("scroll"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		target.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
		timeline.dispatchEvent(new Event("scroll"));
		await new Promise((resolve) => setTimeout(resolve, 20));
		document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
		selection.removeAllRanges();
	});
}

/**
 * 模拟流式弹簧欠账后再来一次 1px 上滚：布局位移本身不得改跟随态，
 * 读者自身位移也未过带宽，按钮必须继续隐藏。
 */
async function onePixelNudgeDuringLag(window: Page, lagPx = 36) {
	return window.locator(".message-timeline").evaluate(async (timeline, lag) => {
		const maxTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
		timeline.scrollTop = Math.max(0, maxTop - lag);
		await new Promise((resolve) => setTimeout(resolve, 20));
		const content = timeline.querySelector(".turn-row") ?? timeline.querySelector("p") ?? timeline;
		content.dispatchEvent(new WheelEvent("wheel", { deltaY: -1, bubbles: true, cancelable: true }));
		timeline.scrollTop = Math.max(0, timeline.scrollTop - 1);
		await new Promise((resolve) => setTimeout(resolve, 80));
		const buttonVisible = Boolean(document.querySelector<HTMLElement>("button[aria-label='移动到最新'], button[aria-label='Scroll to bottom']")?.offsetParent);
		timeline.scrollTop = Math.max(0, timeline.scrollHeight - timeline.clientHeight);
		await new Promise((resolve) => setTimeout(resolve, 20));
		return {
			dist: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
			buttonVisible,
		};
	}, lagPx);
}

/** dispatch wheel（引擎意图判定）+ 手动位移（原生 scroll 事件），模拟真实滚轮。 */
async function wheel(window: Page, deltaY: number, steps = 14, stepPx = 160) {
	return window.locator(".message-timeline").evaluate(
		async (timeline, { delta, n, px }) => {
			const maxTop = () => Math.max(0, timeline.scrollHeight - timeline.clientHeight);
			for (let i = 0; i < n; i += 1) {
				const content = timeline.querySelector(".turn-row") ?? timeline.querySelector("p") ?? timeline;
				content.dispatchEvent(new WheelEvent("wheel", { deltaY: delta, bubbles: true, cancelable: true }));
				const next = timeline.scrollTop + (delta > 0 ? px : -px);
				timeline.scrollTop = delta > 0 ? Math.min(maxTop(), next) : Math.max(0, next);
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
			await new Promise((resolve) => setTimeout(resolve, 250));
			return {
				top: timeline.scrollTop,
				height: timeline.scrollHeight,
				client: timeline.clientHeight,
			};
		},
		{ delta: deltaY, n: steps, px: stepPx },
	);
}

test("go-bottom survives shrink clamp; real browsing still expands and relocks", async ({ app, window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// 构造 9 轮长对话：一次持续上滚必须跨过两个 3 轮窗口，才能证明首次扩窗补偿
	// 没有把后续真实上滚永久误判为程序化滚动。
	for (let i = 1; i <= 9; i += 1) {
		await sendPrompt(window, `滚动回归前置第 ${i} 轮：制造超过三轮的隐藏历史。`);
	}
	// 留出「最新轮安静收起」的 1.5s 窗口，避免它干扰后续断言。
	await window.waitForTimeout(2000);

	// ── 回底：窗口收回 3 轮并贴底 ──
	if (await bottomButton(window).count()) {
		await bottomButton(window).click();
	}
	await expect(bottomButton(window)).toHaveCount(0);
	await window.waitForTimeout(400);
	expect(await window.locator(".turn-row").count()).toBe(3);
	const fitted = await fitNearTopBottom(app, window);
	expect(fitted.maxTop).toBeLessThan(fitted.expandThreshold);
	const bottom = await geometry(window);
	expect(bottom.dist, "after go-bottom viewport should be at the physical bottom").toBeLessThanOrEqual(2);

	await dispatchCollapsedSelectionScroll(window);
	await expect(bottomButton(window), "a plain click overlapping layout scroll must not show the go-bottom button").toHaveCount(0);

	// 输入栏兄弟增高只会压缩 timeline viewport，不改变消息 content 高度。旧引擎只观察
	// contentRef，因此 clientHeight 变小后 scrollTop 留在旧值，视觉上脱离吸底。
	const composerResize = await resizeComposerSibling(window, 72);
	expect(composerResize.after.clientHeight, "composer growth must shrink the timeline viewport").toBeLessThan(composerResize.before.clientHeight);
	expect(Math.abs(composerResize.after.scrollHeight - composerResize.before.scrollHeight), "the regression requires unchanged message content height").toBeLessThanOrEqual(2);
	expect(composerResize.after.dist, "viewport-only resize must stay physically pinned to the bottom").toBeLessThanOrEqual(2);
	expect(composerResize.buttonVisible, "viewport-only resize must not escape follow mode").toBe(false);

	// ── 活动 run 内容收缩（clamp scrollTop 上移）：不得误扩窗或弹出按钮 ──
	await composer.click();
	await composer.fill("SLOW THINK TOOL 活动运行中的收缩回归");
	await window.keyboard.press("Enter");
	await expect(window.getByRole("button", { name: "停止" })).toBeVisible({ timeout: 10_000 });
	await expect(window.locator(".message-timeline")).toContainText("Mock 回复：「SLOW THINK TOOL 活动运行中的收缩回归」", {
		timeout: 10_000,
	});
	// 再排一个慢速 steer，把同一活动周期延长到足以覆盖动态几何搜索；
	// 后续两处「停止」断言确保收缩不是在 run 已结束后才发生。
	await composer.click();
	await composer.fill("SLOW 收缩探针后的同一运行延续");
	await window.keyboard.press("Enter");
	const activeFitted = await fitNearTopBottom(app, window);
	await expect(window.getByRole("button", { name: "停止" })).toBeVisible();
	expect(activeFitted.maxTop).toBeLessThan(activeFitted.expandThreshold);
	await pulseShrink(window, 180);
	await expect(window.getByRole("button", { name: "停止" })).toBeVisible();
	expect(await window.locator(".turn-row").count(), "active shrink clamp must not re-expand the window").toBe(3);
	await expect(bottomButton(window), "active shrink clamp must not re-show the go-bottom button").toHaveCount(0);
	const afterShrink = await geometry(window);
	expect(afterShrink.dist, "viewport stays at the bottom after active shrink").toBeLessThanOrEqual(2);

	// 流式弹簧滞后 ~36px 时，1px 触控板抖动不得逃逸（commit 56dc1d90 回归）。
	const jitter = await onePixelNudgeDuringLag(window, 36);
	expect(jitter.buttonVisible, "1px up-nudge during stream lag must not escape follow").toBe(false);
	await expect(window.getByRole("button", { name: "停止" })).toBeVisible();

	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", {
		timeout: 15_000,
	});
	// 等 live→settled 交接收束，再验证明确的历史浏览手势。
	await window.waitForTimeout(400);
	expect(await window.locator(".turn-row").count(), "live-to-settled handoff must keep the tail window").toBe(3);
	await expect(bottomButton(window), "live-to-settled handoff must keep following").toHaveCount(0);

	// ── 真实用户上滚读历史：渐进扩窗仍工作 ──
	// 先等自动收起（1.5s tick + 320ms + 折叠动画）与 settle 定位跑完：折叠会让
	// 内容回落到 3 轮高度，若此时视口不可滚动（maxTop=0），上滚没有任何位移、
	// 扩窗断言失去意义。重新适配几何，保证上滚前内容确实溢出视口。
	await window.waitForTimeout(2600);
	await fitNearTopBottom(app, window);
	await wheel(window, -160, 20, 160);
	expect(await window.locator(".turn-row").count(), "continuous real up-scroll must cross more than one render-window cohort").toBeGreaterThan(6);
	await expect(bottomButton(window)).toHaveCount(1);

	// ── 按钮回底必须原子收回 3 轮，不得被收缩 clamp 重新扩回 ──
	await bottomButton(window).click();
	await expect(bottomButton(window)).toHaveCount(0);
	await window.waitForTimeout(400);
	expect(await window.locator(".turn-row").count(), "go-bottom must remain at 3 turns across later scroll events").toBe(3);
	await expect.poll(async () => Math.abs((await geometry(window)).dist), { timeout: 1_200 }).toBeLessThanOrEqual(2);

	// ── 回底后再次上滚仍须上报新的 up 意图；方向去重不能吞掉新浏览周期 ──
	const secondUpResult = await wheel(window, -160, 20, 160);
	const secondUpButtons = await bottomButton(window).count();
	expect(await window.locator(".turn-row").count(), `a second up-scroll after go-bottom must cross multiple cohorts; geometry=${JSON.stringify(secondUpResult)} buttons=${secondUpButtons}`).toBeGreaterThan(6);
	await expect(bottomButton(window)).toHaveCount(1);

	// ── 用户下滚回底部：重锁 + 窗口收回 3 轮 + 按钮消失 ──
	await wheel(window, 160, 20, 160);
	await window.waitForTimeout(200);
	await expect(bottomButton(window)).toHaveCount(0);
	const back = await geometry(window);
	expect(back.dist, "after scrolling down to the bottom viewport must be at the physical bottom").toBeLessThanOrEqual(2);
	expect(await window.locator(".turn-row").count(), "re-lock must reset the window to 3 turns").toBe(3);

	// ── 已到底后继续下滑（无位移）：不得掉开 / 弹出按钮 ──
	await wheel(window, 160, 6, 160);
	await window.waitForTimeout(150);
	await expect(bottomButton(window)).toHaveCount(0);
	expect(await window.locator(".turn-row").count()).toBe(3);
});
