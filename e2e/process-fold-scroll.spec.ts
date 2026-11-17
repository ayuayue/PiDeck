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

for (const viewport of [
	{ width: 1000, height: 760 },
	{ width: 560, height: 600 },
]) {
	test(`长工具输出和过程区只滚动会话，${viewport.width}px 窗口`, async ({ page }) => {
		await page.setViewportSize(viewport);
		await page.goto(`${baseUrl}?height=400`);
		const timeline = page.locator(".message-timeline");
		const card = await openOutput(page);
		const log = card.locator('[role="log"]');
		await expect.poll(() => log.evaluate((element) => element.clientHeight)).toBeGreaterThan(500);
		const nested = await timeline.evaluate((element) =>
			Array.from(element.querySelectorAll<HTMLElement>("*"))
				.filter((child) => {
					const style = window.getComputedStyle(child);
					return /auto|scroll/.test(style.overflowY) && child.scrollHeight - child.clientHeight > 2;
				})
				.map((child) => ({ tag: child.tagName, className: child.className })),
		);
		expect(nested).toEqual([]);
		const text = log.locator("pre");
		await text.hover({ position: { x: 30, y: 60 } });
		const before = await timeline.evaluate((element) => element.scrollTop);
		await page.mouse.wheel(0, 160);
		await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(before + 100);
		await expect.poll(() => log.evaluate((element) => element.scrollTop)).toBe(0);
		await page.mouse.wheel(0, -120);
		await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeLessThan(before + 80);
		await expect(page.getByTestId("following")).toHaveText("false");
		await page.screenshot({ path: test.info().outputPath("process-scroll.png") });
	});
}

test("统一会话跟随新增过程，向上阅读后内容增长不抢走位置", async ({ page }) => {
	await page.goto(`${baseUrl}?live&count=12&height=360`);
	const timeline = page.locator(".message-timeline");
	const gap = () => timeline.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
	await page.getByTestId("bottom").click();
	await expect.poll(gap).toBeLessThanOrEqual(2);
	const oldHeight = await timeline.evaluate((element) => element.scrollHeight);
	await page.getByTestId("grow").click();
	await expect.poll(() => timeline.evaluate((element) => element.scrollHeight)).toBeGreaterThan(oldHeight);
	await expect.poll(gap).toBeLessThanOrEqual(2);
	await page.locator(".tool-card").last().hover();
	await page.mouse.wheel(0, -180);
	await expect(page.getByTestId("following")).toHaveText("false");
	await expect.poll(gap).toBeGreaterThan(100);
	const readingPosition = await timeline.evaluate((element) => element.scrollTop);
	await page.getByTestId("grow").click();
	await expect(page.locator(".tool-card")).toHaveCount(14);
	await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBe(readingPosition);
	await page.getByTestId("bottom").click();
	await expect.poll(gap).toBeLessThanOrEqual(2);
	await expect(page.getByTestId("following")).toHaveText("true");
});

test("手动重开过程组保留组头位置，不被新增高度拉到底部", async ({ page }) => {
	await page.goto(`${baseUrl}?live&count=20&height=360`);
	const head = page.locator("[data-process-group-head]");
	await head.click();
	await expect(head).toHaveAttribute("aria-expanded", "false");
	await page.getByTestId("bottom").click();
	const before = await head.evaluate((element) => element.getBoundingClientRect().top);
	await head.click();
	await expect(head).toHaveAttribute("aria-expanded", "true");
	await expect(head).toBeInViewport();
	await expect.poll(() => head.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0);
});

test("长输出标题相对会话吸顶，回到本项开头可达", async ({ page }) => {
	await page.goto(`${baseUrl}?height=360`);
	const timeline = page.locator(".message-timeline");
	const card = await openOutput(page);
	await card.locator("pre").hover({ position: { x: 30, y: 80 } });
	await page.mouse.wheel(0, 240);
	const header = card.locator("[data-process-entry-header]");
	await expect(header).toHaveAttribute("data-process-entry-pinned", "true");
	const top = await timeline.evaluate((element) => element.getBoundingClientRect().top);
	const inset = await timeline.evaluate((element) => Number.parseFloat(window.getComputedStyle(element).paddingTop));
	expect(Math.abs((await header.boundingBox())!.y - top - inset)).toBeLessThanOrEqual(2);
	await card.locator("[data-process-entry-return-to-start]").click();
	await expect.poll(() => card.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(top, 0);
});

test("在会话底部手动展开工具输出，从标题开始读而非跳到输出末尾", async ({ page }) => {
	await page.goto(`${baseUrl}?live&height=360`);
	const card = page.locator(".tool-card").last();
	await page.getByTestId("bottom").click();
	await expect(card).toBeInViewport();
	const before = await card.evaluate((element) => element.getBoundingClientRect().top);
	await card.locator("button[aria-expanded]").first().click();
	await expect(card.locator('[role="log"]')).toBeVisible();
	await expect.poll(() => card.evaluate((element) => element.getBoundingClientRect().top)).toBeCloseTo(before, 0);
	await expect(page.getByTestId("following")).toHaveText("false");
});

test("组内长 diff 保留横向滚动，纵向滚轮继续滚会话", async ({ page }) => {
	await page.goto(`${baseUrl}?diff&count=2&height=360`);
	const card = await openOutput(page);
	await card.getByRole("button", { name: /result-0\.ts .*Changes/ }).click();
	const diff = card.locator('[data-slot="file-diff-viewport"]');
	await expect.poll(() => diff.evaluate((element) => element.clientHeight)).toBeGreaterThan(800);
	expect(await diff.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeLessThanOrEqual(2);
	expect(await diff.evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(100);
	await diff.hover({ position: { x: 60, y: 80 } });
	const timeline = page.locator(".message-timeline");
	const before = await timeline.evaluate((element) => element.scrollTop);
	await page.mouse.wheel(0, 160);
	await expect.poll(() => timeline.evaluate((element) => element.scrollTop)).toBeGreaterThan(before + 100);
});
