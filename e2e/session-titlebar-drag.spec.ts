import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";

const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-titlebar-"));
writeFileSync(join(projectDir, "hello.ts"), "export const hello = 1;\n");
test.afterAll(() => rmSync(projectDir, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }));

/** A scrollable conversation with real process buttons that can move behind the titlebar. */
function historyEntries() {
	const entries: unknown[] = [{ type: "session", version: 3, id: "titlebar-header", name: "Titlebar history", cwd: projectDir, timestamp: new Date().toISOString() }];
	let parentId = "titlebar-header";
	for (let turn = 0; turn < 3; turn += 1) {
		for (const message of [
			{ role: "user", content: [{ type: "text", text: `question-${turn}` }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: `step-${turn}` },
					{ type: "toolCall", id: `tool-${turn}`, name: "read", arguments: { path: "hello.ts" } },
				],
				stopReason: "toolUse",
			},
			{ role: "toolResult", toolCallId: `tool-${turn}`, toolName: "read", content: [{ type: "text", text: "file content" }] },
			{ role: "assistant", content: [{ type: "text", text: `answer-${turn}\n\n${"Long titlebar regression answer.\n\n".repeat(60)}` }], stopReason: "stop" },
		]) {
			const id = `entry-${entries.length}`;
			entries.push({ type: "message", id, parentId, timestamp: new Date().toISOString(), message });
			parentId = id;
		}
	}
	return entries;
}

type HitPoint = { x: number; y: number };
const HTCLIENT = 1;
const HTCAPTION = 2;

/** WM_NCHITTEST reads Electron's native drag region; CDP mouse events bypass that region. */
async function nativeHitTest(app: ElectronApplication, page: Page, point: HitPoint): Promise<number> {
	const mainWindow = await app.browserWindow(page);
	const handle = await mainWindow.evaluate((win) => win.getNativeWindowHandle().readBigUInt64LE().toString());
	const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
	// Lazy loading keeps non-Windows runners from attempting to load user32 or a native addon.
	const koffi: typeof import("koffi") = createRequire(__filename)("koffi");
	const user32 = koffi.load("user32.dll");
	const setDpi = user32.func("intptr_t __stdcall SetThreadDpiAwarenessContext(intptr_t context)");
	const getClientRect = user32.func("bool __stdcall GetClientRect(uintptr_t hwnd, _Out_ int32_t *rect)");
	const toScreen = user32.func("bool __stdcall ClientToScreen(uintptr_t hwnd, _Inout_ int32_t *point)");
	const send = user32.func("intptr_t __stdcall SendMessageTimeoutW(uintptr_t hwnd, uint32_t message, uintptr_t wParam, intptr_t lParam, uint32_t flags, uint32_t timeout, _Out_ uintptr_t *result)");
	const previous = setDpi(-4);
	try {
		const rect = [0, 0, 0, 0];
		const origin = [0, 0];
		expect(getClientRect(BigInt(handle), rect)).toBe(true);
		expect(toScreen(BigInt(handle), origin)).toBe(true);
		// Native pixels / CSS viewport also accounts for Windows DPI and Electron zoom.
		const x = Math.round(origin[0] + (point.x * rect[2]) / viewport.width);
		const y = Math.round(origin[1] + (point.y * rect[3]) / viewport.height);
		const result = [0];
		expect(Number(send(BigInt(handle), 0x84, 0, (y << 16) | (x & 0xffff), 2, 1000, result))).not.toBe(0);
		return Number(result[0]);
	} finally {
		setDpi(previous);
	}
}

for (const navigationMode of ["tabs", "simple"] as const) {
	test.describe(`session titlebar (${navigationMode})`, () => {
		test.skip(process.platform !== "win32", "Native Windows hit testing regression");
		test.use({
			seedProjects: [{ id: "p1", name: "titlebar", path: projectDir }],
			seedSettings: { navigationMode, processGroupDisplay: true },
			seedSessionFiles: async ({}, use) => use([{ projectPath: projectDir, fileName: "titlebar.jsonl", entries: historyEntries() }]),
		});

		test("scrolled-out chat controls cannot block maximized titlebar dragging", async ({ app, window }) => {
			await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
			if (navigationMode === "tabs") await window.getByRole("tab", { name: "项目", exact: true }).click();
			await window.locator(".conversation", { hasText: "titlebar" }).first().click();
			await window.getByRole("button", { name: "Titlebar history", exact: false }).first().click();
			const timeline = window.locator(".message-timeline");
			await expect(timeline).toContainText("answer-2", { timeout: 20_000 });
			const processToggle = window.locator(".execution-summary-toggle").first();
			await expect(window.locator(".execution-summary-toggle")).toHaveCount(3);

			const mainWindow = await app.browserWindow(window);
			// Remain invisible and unfocused even while exercising genuine maximize geometry.
			await mainWindow.evaluate((win) => {
				win.setOpacity(0);
				win.setFocusable(false);
				win.setIgnoreMouseEvents(true);
				win.maximize();
			});
			await expect.poll(() => mainWindow.evaluate((win) => win.isMaximized())).toBe(true);
			await expect.poll(() => mainWindow.evaluate((win) => win.isFocused())).toBe(false);
			await window.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
			// Establish reading intent directly: this transparent window ignores OS mouse input.
			await timeline.dispatchEvent("wheel", { deltaY: -300, bubbles: true });
			await expect
				.poll(async () =>
					timeline.evaluate((element) => {
						const button = element.querySelector(".execution-summary-toggle");
						if (!button) throw new Error("process toggle missing");
						// Its un-clipped box overlaps the titlebar, but the timeline clips it completely.
						element.scrollTop += button.getBoundingClientRect().top - 4;
						return Math.abs(button.getBoundingClientRect().top - 4);
					}),
				)
				.toBeLessThan(2);
			await expect(processToggle).not.toBeInViewport();
			const point = await processToggle.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return { x: rect.x + rect.width / 2, y: 20 };
			});
			const hit = await window.evaluate(({ x, y }) => ({ point: { x, y }, target: document.elementFromPoint(x, y)?.getAttribute("class"), titlebar: Boolean(document.elementFromPoint(x, y)?.closest(".session-tabs-bar, .window-drag-layer")) }), point);
			expect(hit.titlebar, JSON.stringify(hit)).toBe(true);
			await expect.poll(() => nativeHitTest(app, window, point)).toBe(HTCAPTION);

			// Controls that really occupy the drag strip must still receive normal clicks.
			const drawerToggle = window.locator(".header-drawer-toggle").first();
			const drawerPoint = await drawerToggle.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
			});
			expect(await nativeHitTest(app, window, drawerPoint)).toBe(HTCLIENT);
			if (navigationMode === "tabs") {
				const tabPoint = await window
					.locator(".session-tab")
					.first()
					.evaluate((element) => {
						const rect = element.getBoundingClientRect();
						return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
					});
				expect(await nativeHitTest(app, window, tabPoint)).toBe(HTCLIENT);
			}

			await drawerToggle.click();
			await window.locator(".detail-drawer .file-node-row", { hasText: "hello.ts" }).first().click();
			await expect(window.locator(".workbench-stage-with-content")).toBeVisible();
			await expect.poll(() => nativeHitTest(app, window, point)).toBe(HTCAPTION);
			await window.locator(".file-diff-header-actions").getByRole("button", { name: "关闭", exact: true }).first().click();
			await expect(window.locator(".workbench-stage-with-content")).toHaveCount(0);
			await expect.poll(() => nativeHitTest(app, window, point)).toBe(HTCAPTION);
			await window.screenshot({ path: test.info().outputPath("titlebar.png") });
		});
	});
}
