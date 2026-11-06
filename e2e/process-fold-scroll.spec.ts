import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

const project = makeSeedProject("process-fold-scroll");
const title = "Process fold scroll";

function historyEntries() {
	const rows: unknown[] = [{ type: "session", version: 3, id: "fold-header", parentId: null, name: title, cwd: project.path, timestamp: new Date().toISOString() }];
	let parentId = "fold-header";
	let index = 0;
	const append = (message: unknown) => {
		const id = `fold-entry-${index++}`;
		rows.push({ type: "message", id, parentId, timestamp: new Date().toISOString(), message });
		parentId = id;
	};
	append({ role: "user", content: [{ type: "text", text: "fold scroll question" }] });
	for (let step = 0; step < 6; step += 1) {
		append({
			role: "assistant",
			content: [
				{ type: "text", text: `interim-${step}\n\n${Array.from({ length: 12 }, (_, line) => `process detail ${step}-${line}`).join("\n\n")}` },
				{ type: "toolCall", id: `fold-tool-${step}`, name: "read", arguments: { path: `step-${step}.txt` } },
			],
			stopReason: "toolUse",
		});
		append({ role: "toolResult", toolCallId: `fold-tool-${step}`, toolName: "read", content: [{ type: "text", text: `result-${step}` }] });
	}
	append({ role: "assistant", content: [{ type: "text", text: "fold scroll final answer" }], stopReason: "stop" });
	return rows;
}

test.use({
	seedProjects: [project],
	seedSessionFiles: async ({}, use) => use([{ projectPath: project.path, fileName: "process-fold.jsonl", entries: historyEntries() }]),
	seedSettings: { processGroupDisplay: true },
});

async function openFold(app: ElectronApplication, window: Page) {
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
	await window.getByRole("button", { name: title, exact: false }).first().click();
	await expect(window.locator(".message-timeline")).toContainText("fold scroll final answer", { timeout: 20_000 });
	const toggle = window.locator(".execution-summary-toggle").first();
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
	const fold = window.locator("[data-process-fold-scroller]").first();
	await expect(fold).toBeVisible();
	await expect.poll(() => fold.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(500);
	return fold;
}

test("fold growth follows prior bottom intent without pulling an upward reader back", async ({ app, window }) => {
	const fold = await openFold(app, window);
	// 静止历史展开从头读；后续跟随只能由真实滚轮输入建立。
	await expect.poll(() => fold.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
	await fold.hover();
	await window.mouse.wheel(0, 20_000);
	const gap = () => fold.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight);
	await expect.poll(gap).toBeLessThanOrEqual(2);

	// 模拟 Markdown/工具结果在同一节点后增高：行数不变，必须由内容盒 ResizeObserver 感知。
	const grow = () =>
		fold.evaluate((element) => {
			const content = element.firstElementChild;
			if (!(content instanceof HTMLElement)) throw new Error("fold content box missing");
			content.style.minHeight = `${content.getBoundingClientRect().height + 350}px`;
		});
	await grow();
	await expect.poll(gap).toBeLessThanOrEqual(2);
	await window.mouse.wheel(0, -180);
	await expect.poll(gap).toBeGreaterThan(120);
	await window.waitForTimeout(150);
	const before = await fold.evaluate((element) => element.scrollTop);
	await grow();
	await window.waitForTimeout(250);
	expect(Math.abs((await fold.evaluate((element) => element.scrollTop)) - before)).toBeLessThanOrEqual(2);
	// 内层阅读不能让外层误判为离底；否则这里会出现“工具区滚轮解锁整页”的回归。
	await expect(window.locator("[data-scroll-to-bottom]")).toHaveCount(0);

	// 收起再展开不能带回上次的内层跟随动画；静止历史仍从头读，完整内容仍可到达。
	const toggle = window.locator(".execution-summary-toggle").first();
	await toggle.click();
	await expect(fold).toHaveCount(0);
	await toggle.click();
	await expect(fold).toBeVisible();
	await expect.poll(() => fold.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
	await fold.hover();
	await window.mouse.wheel(0, 20_000);
	await expect.poll(gap).toBeLessThanOrEqual(2);
	await expect(window.locator("[data-scroll-to-bottom]")).toHaveCount(0);
});
