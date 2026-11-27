import { writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { expect, test } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

const project = makeSeedProject("BrowserHtmlPreview");
const fileName = "生成网页.htm";
const largeHtmlPath = join(project.path, "large.html");
const markdownAbsolutePath = largeHtmlPath.replace(/\\/g, "/");
const sessionName = "生成单文件网页";
const timestamp = new Date().toISOString();
const server = createServer((_req, res) => {
	res.setHeader("Content-Type", "text/html; charset=utf-8");
	res.end("<!doctype html><title>链接目标页</title><main>内置浏览器已打开链接</main>");
});
let origin: string;

test.beforeAll(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Missing preview test server address");
	origin = `http://127.0.0.1:${address.port}`;
	writeFileSync(largeHtmlPath, "<!doctype html><meta charset=utf-8><title>大型本地预览</title><!--" + "x".repeat(9_515_781) + "--><h1>大型 HTML 已渲染</h1>");
	writeFileSync(
		join(project.path, fileName),
		`<!doctype html><meta charset="utf-8"><title>网页交互演示</title>
		<h1 id="status">加载中</h1><a id="site" href="${origin}/from-preview">预览里的链接</a><script>
			document.querySelector("#status").textContent = "交互脚本已运行";
			document.body.dataset.loadId = crypto.randomUUID();
		</script>`,
	);
});

test.afterAll(async () => {
	await new Promise<void>((resolve) => server.close(() => resolve()));
});

test.use({
	seedProjects: [project],
	seedSettings: { linkOpenMode: "external" },
	seedSessionFiles: async ({}, use) =>
		use([
			{
				projectPath: project.path,
				entries: [
					{ type: "session", version: 3, id: "html-preview", parentId: null, name: sessionName, cwd: project.path, timestamp },
					{ type: "message", id: "html-user", parentId: "html-preview", timestamp, message: { role: "user", content: [{ type: "text", text: "生成网页" }] } },
					{ type: "message", id: "html-assistant", parentId: "html-user", timestamp, message: { role: "assistant", content: [{ type: "text", text: `[查看生成网页](./${fileName})\n\n[聊天里的网页链接](${origin}/from-chat)\n\n[查看大型本地页](<${markdownAbsolutePath}>)` }] } },
				],
			},
		]),
});

test("generated HTML and HTTP links from chat and preview open in built-in browser tabs", async ({ app, window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目" }).click();
	await window.locator(".conversation", { hasText: project.name }).first().click();
	await window.locator(".conversation", { hasText: sessionName }).first().click();
	const timeline = window.locator(".message-timeline");
	const panel = window.locator(".browser-panel");
	const openLabel = "在内置浏览器打开";
	await timeline.getByRole("link", { name: "聊天里的网页链接" }).click({ button: "right" });
	await window.getByRole("menuitem", { name: openLabel }).click();
	await expect(panel.getByRole("tab", { name: /链接目标页/ })).toHaveAttribute("aria-selected", "true");
	await expect(panel.locator("input")).toHaveValue(origin + "/from-chat");

	await timeline.getByText("查看生成网页").click();

	const editor = window.locator(".file-diff-header-actions");
	await expect(window.getByTitle("HTML 预览")).toBeVisible();
	await editor.getByRole("button", { name: openLabel }).click();
	await expect(panel).toBeVisible();
	await expect(panel.getByRole("tab", { name: /网页交互演示/ })).toHaveAttribute("aria-selected", "true");
	await expect(panel.locator("input")).toHaveAttribute("placeholder", fileName);
	await expect(panel.locator("input")).toHaveValue("");
	const guest = panel.locator("webview");
	const readGuest = (script: string) => guest.evaluate((node, code) => (node as unknown as { executeJavaScript: (script: string) => Promise<string> }).executeJavaScript(code), script);
	await expect.poll(() => readGuest("document.querySelector('#status')?.textContent")).toBe("交互脚本已运行");
	await expect.poll(() => readGuest("window.origin")).toBe("null");
	await expect.poll(() => readGuest("document.body.dataset.loadId ?? ''")).not.toBe("");
	const firstLoad = await readGuest("document.body.dataset.loadId");
	await panel.getByRole("button", { name: "刷新", exact: true }).click();
	await expect
		.poll(async () => {
			const id = await readGuest("document.body.dataset.loadId ?? ''");
			return id !== "" && id !== firstLoad;
		})
		.toBe(true);

	// Playwright 控制不到原生菜单。在真实 guest 右键事件创建菜单后，选择对应菜单项。
	await app.evaluate(({ Menu }, label) => {
		const originalPopup = Menu.prototype.popup;
		Menu.prototype.popup = function (options) {
			const item = this.items.find((item) => item.label === label);
			if (!item) return originalPopup.call(this, options);
			Menu.prototype.popup = originalPopup;
			Reflect.apply(item.click, item, [undefined, options?.window, options?.window?.webContents]);
		};
	}, openLabel);
	const point = JSON.parse(await readGuest("JSON.stringify((() => { const rect = document.querySelector('#site').getBoundingClientRect(); return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; })())"));
	// 输入直接发给 guest，避开主窗口与 webview 的坐标换算和重新加载时的焦点竞争。
	await app.evaluate(async ({ webContents }, point) => {
		const target = webContents.getAllWebContents().find((contents) => contents.getType() === "webview" && contents.getURL().startsWith("pideck-html://browser/"));
		if (!target) throw new Error("Missing HTML browser guest");
		target.debugger.attach("1.3");
		try {
			const data = { x: point.x, y: point.y, button: "right", clickCount: 1 };
			await target.debugger.sendCommand("Input.dispatchMouseEvent", { ...data, type: "mousePressed" });
			await target.debugger.sendCommand("Input.dispatchMouseEvent", { ...data, type: "mouseReleased" });
		} finally {
			target.debugger.detach();
		}
	}, point);
	await expect(panel.locator("input")).toHaveValue(origin + "/from-preview");
	await expect(panel.getByRole("tab", { name: /网页交互演示/ })).toHaveAttribute("aria-selected", "false");

	await timeline.getByText("查看大型本地页").click({ button: "right" });
	await window.getByRole("menuitem", { name: openLabel }).click();
	await expect(panel.getByRole("tab", { name: /大型本地预览/ })).toHaveAttribute("aria-selected", "true");
	await expect(panel.locator("input")).toHaveAttribute("placeholder", "large.html");
	await expect.poll(() => readGuest("document.querySelector('h1')?.textContent")).toBe("大型 HTML 已渲染");
});
