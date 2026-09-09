import { test, expect } from "./mock-pi-fixture";
import type { ElectronApplication, Page } from "@playwright/test";
import { makeSeedProject } from "./open-session";

/**
 * 「最新轮结束后把最终回答开头放到视口 30%」的行为级回归（2026-09 状态驱动重构）：
 * - 触发只由状态决定：最新轮 busy→idle 且仍跟随 → 1.5s 阅读停顿 → 定位；
 *   打开/切回仍跟随的已结束会话同样补齐定位。
 * - 输入不参与取消：1.5s 窗口内移动鼠标、在输入框打字都不取消；
 * - 真实上滚读历史是唯一跳过路径：上滚后位置保持，不被拉回 30%。
 *
 * 说明：mock 的 "LONG" 生成 120 行长回复（约 2500px 高），保证最终回答高过
 * 0.7×视口 + 70px 的「无位移短路」门槛，使定位必然产生可断言的位移。
 */

// mock-pi.cjs 的 LONG 分支与这里完全一致：`"Mock 回复：「LONG」"` 后无换行直接
// 拼接 `join("\n")` 的剩余行。
const LONG_REPLY =
	"Mock 回复：「LONG」" +
	Array.from(
		{ length: 120 },
		(_, i) => `第 ${i + 1} 行：长回答示例文本，用于撑高时间线高度（滚动/贴底类用例需要内容溢出视口）。`,
	).join("\n");

// 预置项目 + 一个已结束的 LONG 历史会话（场景 3 用；场景 1/2 仍走内置聊天项目）。
const settleSeedProject = makeSeedProject("settle-reposition-seed");

test.use({
	seedProjects: [settleSeedProject],
	seedSessionFiles: [
		{
			projectPath: settleSeedProject.path,
			entries: [
				{
					type: "session",
					version: 3,
					id: "e1",
					parentId: null,
					name: "已结束的最新轮会话",
					cwd: settleSeedProject.path,
					timestamp: new Date(Date.now() - 60_000).toISOString(),
				},
				{
					type: "message",
					id: "e2",
					parentId: "e1",
					timestamp: new Date(Date.now() - 59_000).toISOString(),
					message: { role: "user", content: [{ type: "text", text: "已结束的最新轮会话" }] },
				},
				{
					type: "message",
					id: "e3",
					parentId: "e2",
					timestamp: new Date(Date.now() - 58_000).toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: LONG_REPLY }] },
				},
			],
		},
	],
});

async function sendPrompt(window: Page, text: string) {
	const composer = window.locator(".composer .rich-input");
	await composer.click();
	await composer.fill(text);
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText(text.slice(0, 10), { timeout: 15_000 });
	// 等本轮 run 完全结束（发送按钮回到空闲）
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", {
		timeout: 15_000,
	});
}

function bottomButton(window: Page) {
	return window.locator("button[aria-label='移动到最新'], button[aria-label='Scroll to bottom']");
}

async function geometry(window: Page) {
	return window.locator(".message-timeline").evaluate((timeline) => ({
		scrollTop: timeline.scrollTop,
		scrollHeight: timeline.scrollHeight,
		clientHeight: timeline.clientHeight,
		dist: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
	}));
}

/** 定位完成的几何指纹：最新轮的最终回答开头应在视口 30% 附近，且视口距底 > 90px。
 * 注意取最后一个 [data-final-answer]（历史轮次的最终回答在 DOM 中更靠前）。 */
async function anchorFingerprint(window: Page) {
	return window.locator(".message-timeline").evaluate((timeline) => {
		const finals = timeline.querySelectorAll<HTMLElement>("[data-final-answer]");
		const final = finals[finals.length - 1];
		if (!final) return null;
		const host = timeline.getBoundingClientRect();
		const rect = final.getBoundingClientRect();
		return {
			anchorTopInViewport: rect.top - host.top,
			clientHeight: timeline.clientHeight,
			dist: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
		};
	});
}

/** 环境干扰（并发 e2e / OS 行为）会把主窗口最小化；最小化时 rAF 被暂停，
 *  依赖 rAF 的 settle 定位动画不会推进（轮询会一直超时）。测试期间确保窗口可见。 */
async function ensureWindowVisible(app: ElectronApplication) {
	await app.evaluate(({ BrowserWindow }) => {
		const target = BrowserWindow.getAllWindows()[0];
		if (!target) return;
		if (target.isMinimized()) target.restore();
		if (!target.isVisible()) target.showInactive();
	});
}

async function goBackToFollowing(window: Page) {
	if (await bottomButton(window).count()) {
		await bottomButton(window).click();
	}
	await expect(bottomButton(window)).toHaveCount(0);
}

test("mouse move + typing during the settle window do not cancel repositioning", async ({ app, window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await ensureWindowVisible(app);
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// 前置 3 轮：制造可滚动历史 + 前置轮自身的 settle 定位已完成
	for (let i = 1; i <= 3; i += 1) {
		await sendPrompt(window, `输入不取消定位前置第 ${i} 轮：制造历史高度。`);
	}
	await window.waitForTimeout(2000);
	await goBackToFollowing(window);

	// 新一轮（LONG 高回复），结束后立即产生输入：鼠标移动 + 输入框打字
	await composer.click();
	await composer.fill("SLOW LONG 输入不取消定位回归");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText(LONG_REPLY.slice(0, 24), { timeout: 20_000 });
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 20_000 });

	// 1.5s 阅读停顿窗口内的真实输入：鼠标到处移动 + 在 composer 打字
	for (let i = 0; i < 6; i += 1) {
		await window.mouse.move(120 + i * 30, 120 + (i % 3) * 40);
		await window.waitForTimeout(60);
	}
	await composer.click();
	await window.keyboard.type("不会发送的草稿文本，模拟开始打下一轮");

	// 定位必须在这些输入之后仍然发生：最终回答开头滚到视口 30% 处并稳定下来。
	// 注意：不能只轮询 anchor 偏差（动画中间帧 anchor 滚过 135~315px 区间也会命中，
	// 此时 dist 还很小）；也不能只轮询 dist（动画拉起第一帧就满足）。
	// 双条件同时成立才算动画完成：已离开底部（dist>90）且已到 30% 目标。
	await expect
		.poll(async () => {
			await ensureWindowVisible(app);
			const f = await anchorFingerprint(window);
			if (!f || f.dist <= 90) return Number.POSITIVE_INFINITY;
			return Math.abs(f.anchorTopInViewport - f.clientHeight * 0.3);
		}, { timeout: 8_000 })
		.toBeLessThan(90);
	const fingerprint = await anchorFingerprint(window);
	expect(fingerprint).not.toBeNull();
	expect(fingerprint.dist, `repositioning must leave the bottom: ${JSON.stringify(fingerprint)}`).toBeGreaterThan(90);
});

test("real up-scroll before settle keeps the manual history position", async ({ app, window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await ensureWindowVisible(app);
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	for (let i = 1; i <= 3; i += 1) {
		await sendPrompt(window, `上滚不打扰前置第 ${i} 轮：制造历史高度。`);
	}
	await window.waitForTimeout(2000);
	await goBackToFollowing(window);

	await composer.click();
	await composer.fill("SLOW LONG 上滚不打扰回归");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText(LONG_REPLY.slice(0, 24), { timeout: 20_000 });
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 20_000 });

	// 等尾部正增长守卫带（500ms）过期再上滚：run 刚结束时 settle 重排仍在刷新
	// lastPositiveResizeAt，守卫带会吞掉合成上滚的逃逸意图（按钮不出现）。
	// 700ms 仍在 1.5s 阅读停顿窗口内，场景语义（tick 前上滚）不变。
	await window.waitForTimeout(700);

	// 真实上滚进入历史（wheel + 手动位移模拟滚轮时序，同 timeline-gobottom-lock）
	await ensureWindowVisible(app);
	const before = await window.locator(".message-timeline").evaluate(async (timeline) => {
		for (let i = 0; i < 10; i += 1) {
			timeline.dispatchEvent(
				new WheelEvent("wheel", { deltaY: -160, bubbles: true, cancelable: true }),
			);
			timeline.scrollTop = Math.max(0, timeline.scrollTop - 160);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		return { top: timeline.scrollTop, scrollHeight: timeline.scrollHeight, clientHeight: timeline.clientHeight };
	});
	await expect(bottomButton(window)).toHaveCount(1);

	// 跨过 1.5s tick + 320ms + 动画窗口：位置必须保持不变（不被定位拉回 30%）
	await window.waitForTimeout(2600);
	const after = await geometry(window);
	expect(Math.abs(after.scrollTop - before.top), `viewport must stay at manual history position: before=${before.top} after=${JSON.stringify(after)}`).toBeLessThan(5);
	expect(after.scrollHeight).toBe(before.scrollHeight);
});

test("opening a settled session while following still repositions without input", async ({ app, window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await ensureWindowVisible(app);

	// 侧栏分段后默认停在「聊天」分段，项目行在「项目」分段下（见 file-viewer.spec.ts）
	await window.getByRole("tab", { name: "项目" }).click();
	// 项目行显示项目 name（makeSeedProject 传入的 name），非目录前缀
	const projectRow = window.locator(".conversation", { hasText: "settle-reposition-seed" }).first();
	await expect(projectRow).toBeVisible({ timeout: 30_000 });
	await projectRow.click();
	const historyRow = window.locator(".conversation", { hasText: "已结束的最新轮会话" }).first();
	await expect(historyRow).toBeVisible({ timeout: 15_000 });
	await historyRow.click();
	await expect(window.locator(".message-timeline")).toContainText(LONG_REPLY.slice(0, 24), { timeout: 20_000 });
	// 打开瞬间跟随尾部（无保存锚点）：挂载补齐流水线生效，无需任何输入。
	// seed 会话内容较短时定位目标会被 clamp 到顶部（anchor 未必精确在 30%），
	// 因此这里只轮询「最终回答进入视口上半部且视口离开底部」的稳定终态，
	// 而不是死磕 30% 像素——30% 的精确锚定由场景 1（长内容）覆盖。
	await expect
		.poll(async () => {
			await ensureWindowVisible(app);
			const f = await anchorFingerprint(window);
			if (!f) return Number.POSITIVE_INFINITY;
			if (f.dist <= 300) return Number.POSITIVE_INFINITY;
			// 最终回答顶部应在视口内（上方 10% 到 60% 高度区间）
			return f.anchorTopInViewport > -f.clientHeight * 0.1 &&
				f.anchorTopInViewport < f.clientHeight * 0.6
				? 0
				: Number.POSITIVE_INFINITY;
		}, { timeout: 8_000 })
		.toBeLessThan(90);
	const fingerprint = await anchorFingerprint(window);
	expect(fingerprint).not.toBeNull();
	expect(
		fingerprint.dist,
		`settled session reopen should leave the bottom: ${JSON.stringify(fingerprint)}`,
	).toBeGreaterThan(300);
});