import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

const project = makeSeedProject("running-scroll");

function entries(title: string) {
	const rows: unknown[] = [{ type: "session", version: 3, id: `${title}-header`, parentId: null, name: title, cwd: project.path, timestamp: new Date(Date.now() - 60_000).toISOString() }];
	for (let index = 1; index <= 5; index += 1) {
		rows.push(
			{ type: "message", id: `${title}-u${index}`, parentId: index === 1 ? `${title}-header` : `${title}-a${index - 1}`, timestamp: new Date(Date.now() - 55_000 + index * 1_000).toISOString(), message: { role: "user", content: [{ type: "text", text: `${title}-question-${index}` }] } },
			{ type: "message", id: `${title}-a${index}`, parentId: `${title}-u${index}`, timestamp: new Date(Date.now() - 55_500 + index * 1_000).toISOString(), message: { role: "assistant", content: [{ type: "text", text: `${title}-answer-${index}\n${"long context line\n".repeat(8)}` }] } },
		);
	}
	return rows;
}

test.use({
	seedProjects: [project],
	seedSessionFiles: async ({}, use) =>
		use([
			{ projectPath: project.path, fileName: "running-a.jsonl", entries: entries("Running A") },
			{ projectPath: project.path, fileName: "running-b.jsonl", entries: entries("Running B") },
		]),
	seedSettings: { sessionTabOpenMode: "permanent", processGroupDisplay: true },
});

async function openRunningProject(app: ElectronApplication, window: Page) {
	await app.evaluate(({ BrowserWindow }) => {
		const win = BrowserWindow.getAllWindows()[0];
		if (win?.isMaximized()) win.unmaximize();
		win?.setBounds({ width: 1000, height: 560 });
	});
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	await window
		.getByRole("button", { name: new RegExp(project.name) })
		.first()
		.press("Enter");
}

async function openSeeded(window: Page, title: string) {
	await window
		.getByRole("button", { name: new RegExp(title) })
		.first()
		.click();
	await expect(window.locator(".message-timeline")).toContainText(`${title}-answer-5`, { timeout: 20_000 });
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true");
}

async function startTools(window: Page, prompt: string, count: number) {
	await window.locator(".composer .rich-input").fill(prompt);
	await window.getByRole("button", { name: "发送", exact: true }).click();
	await expect.poll(async () => window.locator(".message-timeline .tool-card").count(), { timeout: 20_000 }).toBeGreaterThanOrEqual(count);
}

async function scrollMetrics(window: Page) {
	return window.evaluate(() => {
		const timeline = document.querySelector<HTMLElement>(".message-timeline");
		return {
			distance: timeline ? timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight : null,
			button: Boolean(document.querySelector("[data-scroll-to-bottom]")),
			selected: document.querySelector('[role="tab"][data-session-id][aria-selected="true"]')?.textContent,
		};
	});
}

test("运行中的过程组只保留外层可见滚动条，不破坏内部滚动契约", async ({ app, window }) => {
	test.setTimeout(90_000);
	await openRunningProject(app, window);
	await openSeeded(window, "Running A");
	await startTools(window, "SLOW TOOLMANY 40 running-scrollbar", 20);
	const styles = await window
		.locator("[data-process-group-scroller]")
		.first()
		.evaluate((element) => {
			const style = getComputedStyle(element);
			return { scrollbarWidth: style.scrollbarWidth, overflowY: style.overflowY, maxHeight: style.maxHeight, overscrollY: style.overscrollBehaviorY };
		});
	expect(styles.scrollbarWidth).toBe("none");
	expect(styles.overflowY).toBe("auto");
	expect(styles.maxHeight).not.toBe("none");
	expect(styles.overscrollY).toBe("contain");
});

test("两个运行中工具会话切回时持续跟随，且不误显回底按钮", async ({ app, window }) => {
	test.setTimeout(120_000);
	await openRunningProject(app, window);
	await openSeeded(window, "Running A");
	await startTools(window, "SLOW TOOLMANY 40 running-live-edge-A", 20);
	const sourceTab = window.locator('[role="tab"][data-session-id][aria-selected="true"]');
	const sourceId = await sourceTab.getAttribute("data-session-id");
	expect(sourceId).toBeTruthy();
	const moveToLatest = window.locator("[data-scroll-to-bottom]");
	if (await moveToLatest.isVisible().catch(() => false)) await moveToLatest.click();
	await window.waitForTimeout(300);

	await openSeeded(window, "Running B");
	await startTools(window, "SLOW TOOLMANY 40 running-live-edge-B", 5);
	await window.locator(`[role="tab"][data-session-id="${sourceId}"]`).click();
	for (let index = 0; index < 10; index += 1) {
		await window.waitForTimeout(200);
		const sample = await scrollMetrics(window);
		expect(sample.distance ?? Number.POSITIVE_INFINITY).toBeLessThanOrEqual(28);
		expect(sample.button).toBe(false);
		expect(sample.selected).toContain("Running A");
	}
});

test("运行中工具尾部在历史阅读切回后保持锚点与回底入口", async ({ app, window }) => {
	test.setTimeout(180_000);
	await openRunningProject(app, window);
	await openSeeded(window, "Running A");
	for (const prompt of ["running-anchor-one", "running-anchor-two", "running-anchor-three", "running-anchor-four", "running-anchor-five", "running-anchor-six", "running-anchor-seven"]) {
		const composer = window.locator(".composer .rich-input");
		await composer.fill(prompt);
		await window.waitForTimeout(250);
		const trust = window.getByRole("button", { name: "本次信任", exact: true });
		if (await trust.isVisible().catch(() => false)) await trust.click();
		await window.getByRole("button", { name: "发送", exact: true }).click();
		await expect(window.locator(".message-timeline")).toContainText(`Mock 回复：「${prompt}」流式渲染验证完成`, { timeout: 20_000 });
	}
	await startTools(window, "SLOW TOOLMANY 40 running-anchor-tools", 20);
	const sourceId = await window.locator('[role="tab"][data-session-id][aria-selected="true"]').getAttribute("data-session-id");
	const readOffset = () =>
		window.evaluate(() => {
			const timeline = document.querySelector<HTMLElement>(".message-timeline");
			const anchor = Array.from(document.querySelectorAll<HTMLElement>("article.user-turn")).find((element) => element.textContent?.includes("running-anchor-seven"));
			return timeline && anchor ? anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top : null;
		});
	await window.evaluate(() => {
		const timeline = document.querySelector<HTMLElement>(".message-timeline");
		const anchor = Array.from(document.querySelectorAll<HTMLElement>("article.user-turn")).find((element) => element.textContent?.includes("running-anchor-seven"));
		if (!timeline || !anchor) throw new Error("anchor is not mounted");
		const current = anchor.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
		timeline.scrollTop += current - 96;
		timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
	});
	await window.waitForTimeout(350);
	const before = await readOffset();
	expect(before).not.toBeNull();
	expect(Math.abs((before ?? 0) - 96)).toBeLessThanOrEqual(28);
	expect((await scrollMetrics(window)).distance ?? 0).toBeGreaterThan(16);

	await openSeeded(window, "Running B");
	await window.locator(`[role="tab"][data-session-id="${sourceId}"]`).click();
	await expect(window.locator("article.user-turn", { hasText: "running-anchor-seven" })).toBeVisible({ timeout: 15_000 });
	await expect.poll(async () => Math.abs(((await readOffset()) ?? 10_000) - (before ?? 0)), { timeout: 8_000 }).toBeLessThanOrEqual(28);
	await expect(window.locator("[data-scroll-to-bottom]")).toBeVisible();
});
