import { test, expect, type Locator } from "@playwright/test";
import { createServer, type ViteDevServer } from "vite";
import tailwindcss from "@tailwindcss/vite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** 真实 React Ask + Tailwind/legacy 层叠：静态正则只能看到外层 break-words，抓不到子组件的 nowrap。 */
const longQuestion = `请先确认这次变更是否保持单题、多题、返回修改以及自定义回答的一致性，并在提交之前完成验证。\n需要检查的文件：src/${"very-long-module-name/".repeat(8)}request.ts，最后这一句也必须能完整阅读。`;
let server: ViteDevServer;
let baseUrl: string;
let cacheDir: string;

test.beforeAll(async () => {
	cacheDir = await mkdtemp(join(tmpdir(), "pideck-ask-title-vite-"));
	server = await createServer({
		configFile: false,
		root: process.cwd(),
		cacheDir,
		plugins: [tailwindcss()],
		esbuild: { jsx: "automatic" },
		resolve: { alias: { "@": resolve("src/renderer/src"), "@shared": resolve("src/shared") } },
		define: { __PIDECK_DEV_BUILD__: "false" },
		optimizeDeps: { entries: ["e2e/fixtures/ask-title.html"] },
		server: { host: "127.0.0.1", port: 0 },
	});
	await server.listen();
	const address = server.httpServer?.address();
	if (!address || typeof address === "string") throw new Error("Missing fixture server port");
	baseUrl = `http://127.0.0.1:${address.port}/e2e/fixtures/ask-title.html`;
});

test.afterAll(async () => {
	await server?.close();
	if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
});

/** 测可见文字的实际行框，跳过动效隐藏测量副本，避免把 textContent 在场误判为「看得见」。 */
async function visibleTextLayout(locator: Locator) {
	return locator.evaluate((element) => {
		const bounds = element.getBoundingClientRect();
		const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
		const rects: DOMRect[] = [];
		while (walker.nextNode()) {
			const node = walker.currentNode;
			if (!node.textContent?.trim() || node.parentElement?.closest('[aria-hidden="true"], .invisible')) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			rects.push(...range.getClientRects());
		}
		return {
			lineCount: new Set(rects.map((rect) => Math.round(rect.top))).size,
			contained: rects.every((rect) => rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1 && rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1),
			scrollWidth: element.scrollWidth,
			clientWidth: element.clientWidth,
		};
	});
}

test.beforeEach(async ({ page }) => {
	await page.setViewportSize({ width: 480, height: 800 });
	await page.goto(`${baseUrl}?${new URLSearchParams({ question: longQuestion })}`);
	await expect(page.locator(".ask-inline-bar")).toBeVisible();
	await expect(page.getByRole("tab")).toHaveCount(2);
});

test("long Ask question wraps completely without clipping inside a narrow card", async ({ page }) => {
	const title = page.locator('.ask-inline-bar [role="tablist"] + div');
	await expect(title).toContainText(longQuestion);
	await expect.poll(() => visibleTextLayout(title)).toMatchObject({ contained: true });
	const layout = await visibleTextLayout(title);
	expect(layout.lineCount).toBeGreaterThan(2);
	expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
});

test("hovering the question and its short tab exposes the full title", async ({ page }) => {
	const title = page.locator('.ask-inline-bar [role="tablist"] + div');
	await title.hover();
	await expect(page.getByRole("tooltip")).toHaveText(longQuestion);
	// 连续移出触发区与浮层，覆盖 Radix 用来连接两者的指针宽限区，而不是单步传送鼠标。
	await page.mouse.move(0, 0, { steps: 12 });
	await expect(page.getByRole("tooltip")).toHaveCount(0);
	await page.getByRole("tab").first().hover();
	await expect(page.getByRole("tooltip")).toHaveText(longQuestion);
	const tooltip = page.locator('[data-slot="tooltip-content"]');
	const box = await tooltip.boundingBox();
	expect(box).not.toBeNull();
	if (box) {
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(480);
	}
});

// 键盘查看不应触发作答；换题时提示内容跟随当前问题，不能残留上一题。
test("keyboard focus exposes the full tab title and question switching stays usable", async ({ page }) => {
	await page.emulateMedia({ reducedMotion: "reduce" });
	await page.locator("html").evaluate((element) => element.classList.add("dark"));
	const firstTab = page.getByRole("tab").first();
	await firstTab.focus();
	await expect(page.getByRole("tooltip")).toHaveText(longQuestion);
	await page.keyboard.press("Escape");
	await expect(page.getByRole("tooltip")).toHaveCount(0);
	await expect(firstTab).toHaveAttribute("aria-selected", "true");
	await page.getByRole("tab").nth(1).click();
	const title = page.locator('.ask-inline-bar [role="tablist"] + div');
	await expect(title).toHaveText("下一题");
	await page.getByRole("tab").first().click();
	await expect(title).toHaveText(longQuestion);
	await expect.poll(() => visibleTextLayout(title)).toMatchObject({ contained: true });
});

// 单题/计划卡仍采用两行摘要，但全文 hover 与眼睛展开都必须可用。
test("single-question preview exposes full text and can expand without folding options", async ({ page }) => {
	await page.goto(`${baseUrl}?${new URLSearchParams({ mode: "single", question: longQuestion })}`);
	const description = page.locator('.ask-inline-bar div[data-slot="tooltip-trigger"]').filter({ hasText: longQuestion });
	await expect(description).toHaveClass(/line-clamp-2/);
	await description.hover();
	await expect(page.getByRole("tooltip")).toHaveText(longQuestion);
	await page.keyboard.press("Escape");
	await page.getByRole("button", { name: /^(展开全部|Expand all)$/ }).click();
	await expect(description).not.toHaveClass(/line-clamp-2/);
	await expect.poll(() => visibleTextLayout(description)).toMatchObject({ contained: true });
	await expect(page.getByRole("button", { name: "保留", exact: true })).toBeVisible();
});

test("long card heading wraps beside its status and action buttons", async ({ page }) => {
	await page.goto(`${baseUrl}?${new URLSearchParams({ question: "短问题", heading: longQuestion })}`);
	const heading = page.locator('.ask-inline-bar div[data-slot="tooltip-trigger"]').filter({ hasText: longQuestion });
	await expect.poll(() => visibleTextLayout(heading)).toMatchObject({ contained: true });
	await heading.hover();
	await expect(page.getByRole("tooltip")).toHaveText(longQuestion);
});

// 超长全文的容器必须真正可滚动，不能只断言 DOM 中存在看不见的尾部字符串。
test("very long prompt tooltip stays hoverable and scrolls to its last line", async ({ page }) => {
	const veryLongQuestion = Array.from({ length: 45 }, (_, index) => `第 ${index + 1} 项：需要完整阅读的确认内容，不应在全文提示中被截断。`).join("\n");
	await page.goto(`${baseUrl}?${new URLSearchParams({ question: veryLongQuestion })}`);
	await page.getByRole("tab").first().hover();
	await expect(page.getByRole("tooltip")).toHaveText(veryLongQuestion);
	const tooltip = page.locator('[data-slot="tooltip-content"]');
	const box = await tooltip.boundingBox();
	expect(box).not.toBeNull();
	if (!box) throw new Error("Tooltip must have visible bounds");
	expect(box.y).toBeGreaterThanOrEqual(0);
	expect(box.y + box.height).toBeLessThanOrEqual(800);
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
	await expect(tooltip).toBeVisible();
	expect(await tooltip.evaluate((element) => getComputedStyle(element).userSelect)).toBe("text");
	const scrollRange = await tooltip.evaluate((element) => element.scrollHeight - element.clientHeight);
	expect(scrollRange).toBeGreaterThan(0);
	await page.mouse.wheel(0, 10_000);
	await expect.poll(() => tooltip.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop)).toBeLessThanOrEqual(1);
	await expect(tooltip).toBeVisible();
});
