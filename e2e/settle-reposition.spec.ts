import { test, expect } from "./mock-pi-fixture";
import type { ElectronApplication, Page } from "@playwright/test";
import { makeSeedProject } from "./open-session";

/**
 * 最新轮结束及历史加载时的滚动回归：上滚阅读后保持位置，打开历史或启动其 runtime
 * 不额外定位；LONG 回复保证时间线足够高，可观察跟随与手动阅读的区别。
 */

// mock-pi.cjs 的 LONG 分支与这里完全一致：`"Mock 回复：「LONG」"` 后无换行直接
// 拼接 `join("\n")` 的剩余行。
const LONG_REPLY = "Mock 回复：「LONG」" + Array.from({ length: 120 }, (_, i) => `第 ${i + 1} 行：长回答示例文本，用于撑高时间线高度（滚动/贴底类用例需要内容溢出视口）。`).join("\n");

// 预置项目 + 一个已结束的 LONG 历史会话，供历史打开和启动用例使用。
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
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 15_000 });
}

function bottomButton(window: Page) {
	return window.locator("button[aria-label='移动到最新'], button[aria-label='Scroll to bottom']");
}

async function goBackToFollowing(window: Page) {
	if (await bottomButton(window).count()) await bottomButton(window).click();
	await expect(bottomButton(window)).toHaveCount(0);
}

async function geometry(window: Page) {
	return window.locator(".message-timeline").evaluate((timeline) => ({
		scrollTop: timeline.scrollTop,
		scrollHeight: timeline.scrollHeight,
		clientHeight: timeline.clientHeight,
		dist: timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight,
	}));
}

/** 最小化时 rAF 可能暂停；恢复动画推进，沿用屏幕外窗口位置且不抢前台。 */
async function ensureWindowVisible(app: ElectronApplication) {
	await app.evaluate(({ BrowserWindow }) => {
		const target = BrowserWindow.getAllWindows()[0];
		if (!target) return;
		if (target.isMinimized()) target.restore();
		if (!target.isVisible()) target.showInactive();
	});
}

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

	// 等 settle 折叠动画收束再上滚。700ms 仍在 1.5s 阅读停顿窗口内，
	// 场景语义（tick 前上滚）不变。
	await window.waitForTimeout(700);

	// 真实上滚进入历史（wheel + 手动位移模拟滚轮时序，同 timeline-gobottom-lock）
	await ensureWindowVisible(app);
	const before = await window.locator(".message-timeline").evaluate(async (timeline) => {
		for (let i = 0; i < 10; i += 1) {
			const content = timeline.querySelector(".turn-row") ?? timeline.querySelector("p") ?? timeline;
			content.dispatchEvent(new WheelEvent("wheel", { deltaY: -160, bubbles: true, cancelable: true }));
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

async function openSeedHistory(app: ElectronApplication, window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await ensureWindowVisible(app);
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	const projectRow = window.locator(".conversation", { hasText: "settle-reposition-seed" }).first();
	await expect(projectRow).toBeVisible({ timeout: 30_000 });
	await projectRow.click();
	const historyRow = window.locator(".conversation", { hasText: "已结束的最新轮会话" }).first();
	await expect(historyRow).toBeVisible({ timeout: 15_000 });
	await historyRow.click();
	await expect(window.locator(".message-timeline")).toContainText(LONG_REPLY.slice(0, 24), { timeout: 20_000 });
}

test("opening history without a started Agent stays at the bottom", async ({ app, window }) => {
	await openSeedHistory(app, window);
	await expect.poll(async () => (await geometry(window)).dist).toBeLessThan(90);
	const before = await geometry(window);
	await window.waitForTimeout(3300);
	const after = await geometry(window);
	expect(after.dist, `unstarted history must not reposition: ${JSON.stringify(after)}`).toBeLessThan(90);
	// Markdown/窗口布局完成后内容高度仍可变化；应保持贴底，而不是锁死绝对 scrollTop。
	expect(Math.abs(after.dist - before.dist)).toBeLessThan(5);
});

test("starting an Agent for existing history does not reposition without a new turn", async ({ app, window }) => {
	await openSeedHistory(app, window);
	// 旧的「补齐法」会在 runtime 上线时 arm 流水线，把历史轮次拉到 30%；
	// 收口后只有真实的本轮结束才能触发，所以激活实例必须完全不动视口。
	await window.evaluate(async (projectId) => {
		const records = await window.piDesktop.sessions.listCatalog(projectId, { scan: false });
		const record = records.find((item) => item.title === "已结束的最新轮会话");
		if (!record) throw new Error("seed session not found");
		const activated = await window.piDesktop.sessions.activateRuntime(record.id);
		if (!activated.ok) throw new Error(JSON.stringify(activated));
		// 让 activation 事件先到 renderer，再跨过完整的 1.5s + 320ms + 动画窗口。
		await new Promise((resolve) => setTimeout(resolve, 300));
		const stopped = await window.piDesktop.sessions.stopRuntime(activated.value);
		if (!stopped.ok) throw new Error(JSON.stringify(stopped));
	}, settleSeedProject.id);
	await window.waitForTimeout(3300);
	const after = await geometry(window);
	expect(after.dist, `activated history must stay at the bottom: ${JSON.stringify(after)}`).toBeLessThan(90);
});
