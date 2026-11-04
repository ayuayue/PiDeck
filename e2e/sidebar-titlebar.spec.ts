import { expect, type Page } from "@playwright/test";
import { test as fixture } from "./fixtures";

/**
 * 侧栏标题行（品牌区所在 40px 行）两种导航模式的共同契约：
 * - 不再有独立的顶部导航条（simple-navigation-bar）；折叠入口在品牌行右端，垂直居中，
 *   因此 mac 红绿灯 / Windows 窗口控件与它落在同一条水平中线上；
 * - 简洁模式不再提供前进 / 后退箭头；
 * - 应用显示名称可长可短，长名必须像会话标题一样截断，不得把字标或折叠按钮挤出标题行。
 */
const LONG_DISPLAY_NAME = "PiDeck超长应用显示名测试用例";

type HeaderMetrics = {
	bar: { height: number; left: number; right: number; clientWidth: number; scrollWidth: number };
	/** 品牌整块左缘：mac 有红绿灯可以居中，Win/Linux 没有红绿灯时必须靠左（否则左边留空白）。 */
	brandLeft: number;
	wordmark: { left: number; right: number; scrollWidth: number; clientWidth: number; centerDy: number };
	toggle: { left: number; right: number; centerDy: number };
	backForwardCount: number;
	navBarCount: number;
};

async function readHeaderMetrics(window: Page): Promise<HeaderMetrics> {
	return window.evaluate(() => {
		const centerY = (rect: DOMRect) => rect.top + rect.height / 2;
		const barElement = document.querySelector(".list-toolbar") as HTMLElement;
		const bar = barElement.getBoundingClientRect();
		// 品牌块（logo + 字标 + 可选的分支副标题）整体居中；只看字标会在开发分支
		// 有副标题时误判（两行块里字标本来就偏上）。垂直对齐的契约是「整块居中」。
		const brandElement = barElement.querySelector(".brand-lockup") as HTMLElement;
		const brandRect = brandElement.getBoundingClientRect();
		const wordmarkElement = barElement.querySelector(".brand-wordmark") as HTMLElement;
		const wordmark = wordmarkElement.getBoundingClientRect();
		const toggleElement = barElement.querySelector(".list-toggle-native") as HTMLElement;
		const toggle = toggleElement.getBoundingClientRect();
		const labels = [...document.querySelectorAll("button")].map((button) => button.getAttribute("aria-label"));
		return {
			bar: { height: bar.height, left: bar.left, right: bar.right, clientWidth: barElement.clientWidth, scrollWidth: barElement.scrollWidth },
			brandLeft: brandRect.left,
			wordmark: {
				left: wordmark.left,
				right: wordmark.right,
				scrollWidth: wordmarkElement.scrollWidth,
				clientWidth: wordmarkElement.clientWidth,
				centerDy: Math.abs(centerY(brandRect) - centerY(bar)),
			},
			toggle: { left: toggle.left, right: toggle.right, centerDy: Math.abs(centerY(toggle) - centerY(bar)) },
			backForwardCount: labels.filter((label) => label === "后退" || label === "前进").length,
			navBarCount: document.querySelectorAll(".simple-navigation-bar").length,
		};
	});
}

for (const [mode, navigationMode] of [
	["tabs", "tabs"],
	["simple", "simple"],
] as const) {
	fixture.describe(`sidebar titlebar (${mode})`, () => {
		fixture.use({
			seedProjects: [{ id: "titlebar-project", name: "TitlebarProject", path: process.cwd() }],
			seedSettings: { navigationMode, appDisplayName: LONG_DISPLAY_NAME },
		});

		fixture("brand row keeps one 40px title row and truncates a long app name", async ({ window }) => {
			await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
			await expect(window.locator(".list-toolbar")).toBeVisible();

			const metrics = await readHeaderMetrics(window);
			// 顶部不再有独立导航条，前进/后退箭头已移除。
			expect(metrics.navBarCount).toBe(0);
			expect(metrics.backForwardCount).toBe(0);
			// 与窗口控件行同高，字标与折叠按钮都落在行的垂直中线上。
			expect(metrics.bar.height).toBe(40);
			expect(metrics.wordmark.centerDy).toBeLessThanOrEqual(1);
			expect(metrics.toggle.centerDy).toBeLessThanOrEqual(1);
			// 长应用名截断而不是撑开：字标右缘不进按钮区，标题行自身也不横向溢出。
			expect(metrics.wordmark.scrollWidth).toBeGreaterThan(metrics.wordmark.clientWidth);
			expect(metrics.wordmark.right).toBeLessThanOrEqual(metrics.toggle.left);
			expect(metrics.wordmark.right).toBeLessThanOrEqual(metrics.bar.right);
			expect(metrics.bar.scrollWidth).toBeLessThanOrEqual(metrics.bar.clientWidth);
			// 折叠入口贴标题行右端（不是跟在 mac 红绿灯后面靠左）。
			expect(metrics.bar.right - metrics.toggle.right).toBeLessThanOrEqual(12);
			// Win/Linux 没有红绿灯：品牌必须靠左，居中会在左边留一条空白（2026-10 用户反馈）。
			const isMacChrome = await window.evaluate(() => Boolean(document.querySelector(".mac-custom-titlebar")));
			if (!isMacChrome) {
				expect(metrics.brandLeft - metrics.bar.left).toBeLessThanOrEqual(24);
			}
		});

		fixture("collapsed sidebar keeps its only restore entry clear of the traffic lights", async ({ window }) => {
			await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
			await window.locator(".list-toolbar .list-toggle-native").click();
			const expand = window.locator(".session-tabs-bar .list-toggle-native");
			await expect(expand).toBeVisible();

			const box = await expand.boundingBox();
			expect(box).not.toBeNull();
			const isMacChrome = await window.evaluate(() => Boolean(document.querySelector(".mac-custom-titlebar")));
			if (isMacChrome) {
				// mac 红绿灯占窗口左上约 78px：恢复按钮必须让位，否则叠在关闭键上点不到。
				expect(box!.x).toBeGreaterThanOrEqual(78);
			}
			// 恢复后侧栏回到展开宽度，折叠入口回到标题行右端。
			await expand.click();
			await expect(window.locator(".list-toolbar .list-toggle-native")).toBeVisible();
			await expect.poll(async () => (await window.locator(".shell-panel-list").boundingBox())!.width).toBeGreaterThan(100);
		});
	});
}

/**
 * issue #486：品牌区的点击热区是 `.app-badge`，foundation.css 把它整块置为 no-drag。
 * 它一旦撑满标题行，右侧空白也不再是 drag 区——整条顶栏拖不动窗口，松手还会误开「关于」。
 * 默认应用名下量几何：热区右缘到折叠按钮之间必须留出一段可拖拽空白。
 */
fixture.describe("sidebar titlebar drag area", () => {
	fixture.use({ seedProjects: [{ id: "titlebar-drag-project", name: "TitlebarProject", path: process.cwd() }] });

	fixture("brand hot area leaves a draggable gap before the collapse button", async ({ window }) => {
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await expect(window.locator(".list-toolbar")).toBeVisible();
		const metrics = await window.evaluate(() => {
			const barElement = document.querySelector(".list-toolbar") as HTMLElement;
			const badge = barElement.querySelector(".app-badge")!.getBoundingClientRect();
			const toggle = barElement.querySelector(".list-toggle-native")!.getBoundingClientRect();
			return { barWidth: barElement.getBoundingClientRect().width, badgeWidth: badge.width, badgeRight: badge.right, toggleLeft: toggle.left };
		});
		// 热区只包住 logo 与字标，不随 flex 撑满（撑满 = 又变回 flex-1）。
		expect(metrics.badgeWidth).toBeLessThan(metrics.barWidth / 2);
		expect(metrics.toggleLeft - metrics.badgeRight).toBeGreaterThanOrEqual(24);
	});
});
