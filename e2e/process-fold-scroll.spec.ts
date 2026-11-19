import { test, expect, type Page } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";

let server: ViteDevServer;
let baseUrl: string;

test.beforeAll(async () => {
	server = await createServer({
		configFile: false,
		root: process.cwd(),
		cacheDir: "node_modules/.vite-process-scroll",
		plugins: [tailwindcss()],
		esbuild: { jsx: "automatic" },
		resolve: { alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
		define: { __PIDECK_DEV_BUILD__: "false" },
		optimizeDeps: { entries: ["e2e/fixtures/process-scroll.html"] },
		server: { host: "127.0.0.1", port: 0 },
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server port");
	baseUrl = `http://127.0.0.1:${address.port}/e2e/fixtures/process-scroll.html`;
});

test.afterAll(async () => {
	await server?.close();
});

async function openOutput(page: Page) {
	const card = page.locator(".tool-card").first();
	const trigger = card.locator("button[aria-expanded]").first();
	await trigger.click();
	await expect(card.locator('[role="log"]')).toBeVisible();
	return card;
}

const groupBody = (page: Page) => page.locator("[data-process-group-scroller]").first();

for (const viewport of [
	{ width: 1000, height: 760 },
	{ width: 560, height: 600 },
]) {
	test(`组体是唯一的内层滚轮：先滚组体，到边后交给会话，${viewport.width}px 窗口`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.goto(`${baseUrl}?height=400`);
		const timeline = page.locator(".message-timeline");
		const body = groupBody(page);
		await expect(body).toBeVisible();

		// ① 组体限高 = min(640px, 60vh)（行高 28px ≈ 22 行；小窗口按 60vh 收缩）、滚动条隐藏、
		//    到边不切断滚动链。overscroll contain 是旧版「组体到底、会话一像素不动」的死区，禁止回归。
		await expect
			.poll(() =>
				body.evaluate((element) => {
					const style = window.getComputedStyle(element);
					return {
						maxHeight: Number.parseFloat(style.maxHeight),
						expected: Math.min(640, window.innerHeight * 0.6),
						overflowY: style.overflowY,
						scrollbarWidth: style.scrollbarWidth,
						overscrollY: style.overscrollBehaviorY,
					};
				}),
			)
			.toEqual({ maxHeight: Math.min(640, viewport.height * 0.6), expected: Math.min(640, viewport.height * 0.6), overflowY: "auto", scrollbarWidth: "none", overscrollY: "auto" });

		// ② 长工具输出在组内让位（不限高、不自转纵向滚轮）→ 整条会话只有组体这一个内层滚动容器。
		const card = await openOutput(page);
		const log = card.locator('[role="log"]');
		await expect.poll(() => log.evaluate((element) => element.clientHeight)).toBeGreaterThan(500);
		expect(await log.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(2);
		const nested = await timeline.evaluate((element) =>
			Array.from(element.querySelectorAll<HTMLElement>("*"))
				.filter((child) => {
					const style = window.getComputedStyle(child);
					return /auto|scroll/.test(style.overflowY) && child.scrollHeight - child.clientHeight > 2;
				})
				.map((child) => ({ tag: child.tagName, className: child.className, scroller: child.hasAttribute("data-process-group-scroller") })),
		);
		expect(nested).toHaveLength(1);
		expect(nested[0]?.scroller).toBe(true);

		// ③ 点组内成员会暂停会话跟随（与折叠区同语义），先回底恢复；
		//    之后在组内上滚：只滚组体，会话一像素不动、跟随态也不变。
		await page.getByTestId("bottom").click();
		await expect(page.getByTestId("following")).toHaveText("true");
		// 先 hover 再测量：Playwright 的 hover 会把目标滚进视口，可能顺带移动会话。
		await body.hover({ position: { x: 40, y: 40 } });
		await body.evaluate((element) => {
			element.scrollTop = element.scrollHeight;
		});
		const bodyBottom = await body.evaluate((element) => element.scrollTop);
		expect(bodyBottom).toBeGreaterThan(0);
		const outerBefore = await timeline.evaluate((element) => element.scrollTop);
		await page.mouse.wheel(0, -160);
		await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeLessThan(bodyBottom);
		expect(await timeline.evaluate((element) => element.scrollTop)).toBe(outerBefore);
		await expect(page.getByTestId("following")).toHaveText("true");

		// ④ 组体到顶后继续上滚：手势交还会话（没有死区），跟随态按会话的真实位移翻转。
		await body.evaluate((element) => {
			element.scrollTop = 0;
		});
		await body.hover({ position: { x: 40, y: 40 } });
		const outerTopBeforeEdge = await timeline.evaluate((element) => element.scrollTop);
		await page.mouse.wheel(0, -200);
		await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeLessThan(outerTopBeforeEdge);
		await expect(page.getByTestId("following")).toHaveText("false");
	});
}

test("隐藏滚动条时用左侧竖线的上下提示表示还有内容", async ({ page }) => {
	await page.goto(`${baseUrl}?height=360`);
	const body = groupBody(page);
	await openOutput(page);
	const up = page.locator('[data-process-group-overflow="up"]');
	const down = page.locator('[data-process-group-overflow="down"]');
	await expect.poll(() => body.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(50);

	// 到底：只提示上方还有内容（自动贴底时也是这个形态）。
	await body.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect(up).toHaveCount(1);
	await expect(down).toHaveCount(0);

	// 到顶：只提示下方还有内容。
	await body.evaluate((element) => {
		element.scrollTop = 0;
	});
	await expect(down).toHaveCount(1);
	await expect(up).toHaveCount(0);

	// 短组（内容装得下）两条都不画，也不占 Tab 位。
	await page.goto(`${baseUrl}?height=360&count=2`);
	const shortBody = groupBody(page);
	await expect(shortBody).toBeVisible();
	await expect(page.locator('[data-process-group-overflow="up"], [data-process-group-overflow="down"]')).toHaveCount(0);
	await expect(shortBody).not.toHaveAttribute("tabindex", "0");
});

test("跳转落位：被组体裁掉的目标先由内层重新露出来", async ({ page }) => {
	await page.goto(`${baseUrl}?height=400&count=20`);
	const body = groupBody(page);
	await expect(body).toBeVisible();
	const row = page.locator('.tool-card[data-message-id="tool-5"]');
	// 目标在组体窗口里的可见高度：被裁掉时是 0（矩形仍在、getClientRects 非空，
	// 所以会话跳转不会退到轮次行——旧实现就停在这样一条「空白」上）。
	const visibleInBody = () =>
		row.evaluate((element) => {
			const line = element.getBoundingClientRect();
			const group = document.querySelector("[data-process-group-scroller]")?.getBoundingClientRect();
			if (!group) return -1;
			return Math.max(0, Math.min(line.bottom, group.bottom) - Math.max(line.top, group.top));
		});

	await body.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	expect(await visibleInBody()).toBe(0);

	await page.getByTestId("reveal").click();
	await expect.poll(visibleInBody).toBeGreaterThan(0);
	// 露出之后组体停在目标处，而不是被引擎拽回底部。
	expect(await body.evaluate((element) => element.scrollTop)).toBeLessThan(await body.evaluate((element) => element.scrollHeight - element.clientHeight));
});

test("运行中的组体自己贴底：新增成员可见，上滚后的阅读位置不被增长抢走", async ({ page }) => {
	await page.goto(`${baseUrl}?live&count=30&height=360`);
	const body = groupBody(page);
	await expect(body).toBeVisible();
	const gap = () => body.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);

	// 自动展开的最新组：落底跟随，新增成员后仍贴底（外层时间线收不到增高通知，由组体自己跟）。
	await expect.poll(gap).toBeLessThanOrEqual(2);
	await page.getByTestId("grow").click();
	await expect(page.locator(".tool-card")).toHaveCount(31);
	await expect.poll(gap).toBeLessThanOrEqual(2);

	// 组内上滚阅读：只有组体脱锁，外层时间线跟随态不变；随后增长不得把组体拽回底部。
	await page.locator(".tool-card").last().hover();
	await page.mouse.wheel(0, -180);
	await expect.poll(gap).toBeGreaterThan(100);
	await expect(page.getByTestId("following")).toHaveText("true");
	const readingPosition = await body.evaluate((element) => element.scrollTop);
	await page.getByTestId("grow").click();
	await expect(page.locator(".tool-card")).toHaveCount(32);
	await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(readingPosition);
});

test("手动重开过程组从组体开头读，保留组头位置", async ({ page }) => {
	await page.goto(`${baseUrl}?live&count=20&height=360`);
	const head = page.locator("[data-process-group-head]");
	const body = groupBody(page);
	await head.click();
	await expect(head).toHaveAttribute("aria-expanded", "false");
	await page.getByTestId("bottom").click();
	const before = await head.evaluate((element) => element.getBoundingClientRect().top);
	await head.click();
	await expect(head).toHaveAttribute("aria-expanded", "true");
	// 手动通道 = 从头读（点开组体想看的是一开始执行了什么，不是末尾）。
	await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(0);
	await expect(head).toBeInViewport();
	await expect.poll(() => head.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0);
});

test("长输出标题相对组体吸顶，回到本项开头可达", async ({ page }) => {
	await page.goto(`${baseUrl}?height=360`);
	const body = groupBody(page);
	const card = await openOutput(page);
	await card.locator("pre").hover({ position: { x: 30, y: 80 } });
	await page.mouse.wheel(0, 240);
	const header = card.locator("[data-process-entry-header]");
	await expect(header).toHaveAttribute("data-process-entry-pinned", "true");
	// 吸顶的参照系是组体视口，不是会话视口（组体是最近的滚动容器）。
	const viewport = await body.evaluate((element) => ({ top: element.getBoundingClientRect().top, inset: Number.parseFloat(window.getComputedStyle(element).paddingTop) }));
	expect(Math.abs((await header.boundingBox())!.y - viewport.top - viewport.inset)).toBeLessThanOrEqual(2);
	await card.locator("[data-process-entry-return-to-start]").click();
	await expect.poll(() => card.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(viewport.top, 0);
});

test("展开工具输出时组体不被增长拽到末尾，从标题开始读", async ({ page }) => {
	await page.goto(`${baseUrl}?live&height=360`);
	const body = groupBody(page);
	const card = page.locator(".tool-card").last();
	await expect(card).toBeInViewport();
	const innerBefore = await body.evaluate((element) => element.scrollTop);
	const before = await card.evaluate((element) => element.getBoundingClientRect().top);
	await card.locator("button[aria-expanded]").first().click();
	await expect(card.locator('[role="log"]')).toBeVisible();
	await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBe(innerBefore);
	await expect.poll(() => card.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0);
});

test("组内长 diff 保留横向滚动，纵向滚轮先滚组体", async ({ page }) => {
	await page.goto(`${baseUrl}?diff&count=2&height=360`);
	const body = groupBody(page);
	const card = await openOutput(page);
	await card.getByRole("button", { name: /result-0\.ts .*Changes/ }).click();
	const diff = card.locator('[data-slot="file-diff-viewport"]');
	await expect.poll(() => diff.evaluate((element) => element.clientHeight)).toBeGreaterThan(800);
	// 组内让位：diff 不自转纵向滚轮，横向照旧可滚。
	expect(await diff.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(2);
	expect(await diff.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(100);
	const before = await body.evaluate((element) => element.scrollTop);
	await diff.hover({ position: { x: 60, y: 80 } });
	await page.mouse.wheel(0, 160);
	await expect.poll(() => body.evaluate((element) => element.scrollTop)).toBeGreaterThan(before);
});
