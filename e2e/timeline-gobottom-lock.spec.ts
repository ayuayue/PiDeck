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
	const inBand = (current: Awaited<ReturnType<typeof geometry>>) =>
		current.maxTop > 40 && current.maxTop < current.expandThreshold - 20;
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
			await app.evaluate(({ BrowserWindow }, next) => {
				const target = BrowserWindow.getAllWindows()[0];
				if (!target) return;
				if (target.isMinimized()) target.restore();
				if (!target.isVisible()) target.showInactive();
				if (target.isMaximized()) target.unmaximize();
				target.webContents.setZoomFactor(next.zoomFactor);
				target.setBounds({ width: 900, height: next.height });
			}, { height, zoomFactor });
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

/** dispatch wheel（引擎意图判定）+ 手动位移（原生 scroll 事件），模拟真实滚轮。 */
async function wheel(window: Page, deltaY: number, steps = 14, stepPx = 160) {
	return window.locator(".message-timeline").evaluate(
		async (timeline, { delta, n, px }) => {
			const maxTop = () => Math.max(0, timeline.scrollHeight - timeline.clientHeight);
			for (let i = 0; i < n; i += 1) {
				timeline.dispatchEvent(
					new WheelEvent("wheel", { deltaY: delta, bubbles: true, cancelable: true }),
				);
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

	// 构造 6 轮长对话：贴底窗口 3 轮之外存在可扩/可收回的隐藏轮次。
	for (let i = 1; i <= 6; i += 1) {
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
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", {
		timeout: 15_000,
	});
	// 等既有 500ms 流式增长逃逸保护带结束，再验证明确的历史浏览手势。
	await window.waitForTimeout(650);
	expect(await window.locator(".turn-row").count(), "live-to-settled handoff must keep the tail window").toBe(3);
	await expect(bottomButton(window), "live-to-settled handoff must keep following").toHaveCount(0);

	// ── 真实用户上滚读历史：渐进扩窗仍工作 ──
	// 先等自动收起（1.5s tick + 320ms + 折叠动画）与 settle 定位跑完：折叠会让
	// 内容回落到 3 轮高度，若此时视口不可滚动（maxTop=0），上滚没有任何位移、
	// 扩窗断言失去意义。重新适配几何，保证上滚前内容确实溢出视口。
	await window.waitForTimeout(2600);
	await fitNearTopBottom(app, window);
	await wheel(window, -160, 14, 160);
	expect(await window.locator(".turn-row").count(), "real up-scroll must still expand the window").toBeGreaterThan(3);
	await expect(bottomButton(window)).toHaveCount(1);

	// ── 按钮回底必须原子收回 3 轮，不得被收缩 clamp 重新扩回 ──
	await bottomButton(window).click();
	await expect(bottomButton(window)).toHaveCount(0);
	await window.waitForTimeout(400);
	expect(await window.locator(".turn-row").count(), "go-bottom must remain at 3 turns across later scroll events").toBe(3);
	await expect
		.poll(async () => Math.abs((await geometry(window)).dist), { timeout: 1_200 })
		.toBeLessThanOrEqual(2);

	// ── 回底后再次上滚仍须上报新的 up 意图；方向去重不能吞掉新浏览周期 ──
	const secondUpResult = await wheel(window, -160, 14, 160);
	const secondUpButtons = await bottomButton(window).count();
	expect(
		await window.locator(".turn-row").count(),
		`a second up-scroll after go-bottom must expand again; geometry=${JSON.stringify(secondUpResult)} buttons=${secondUpButtons}`,
	).toBeGreaterThan(3);
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