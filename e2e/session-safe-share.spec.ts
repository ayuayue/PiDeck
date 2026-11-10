import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

const project = makeSeedProject("safe-share-520");
const title = "安全分享隔离样本";
const sessionFile = join(project.path, ".pi", "sessions", "share-sample.jsonl");
const image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const entries = [
	{ type: "session", version: 3, id: "share-header", parentId: null, name: title, cwd: project.path, timestamp: "2026-11-01T00:00:00Z" },
	{
		type: "message",
		id: "share-user",
		parentId: "share-header",
		message: {
			role: "user",
			content: [
				{ type: "text", text: `public question ${project.path}/fake.ts token=FAKE_USER_TOKEN_520` },
				{ type: "image", mimeType: "image/png", data: image },
			],
		},
	},
	{
		type: "message",
		id: "share-call",
		parentId: "share-user",
		message: {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "PRIVATE_THINKING_520" },
				{ type: "toolCall", id: "call", name: "read", arguments: { path: "PRIVATE_ARG_520" } },
			],
			stopReason: "toolUse",
		},
	},
	{ type: "message", id: "share-result", parentId: "share-call", message: { role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "text", text: "PRIVATE_RESULT_520" }] } },
	{ type: "message", id: "share-answer", parentId: "share-result", message: { role: "assistant", content: [{ type: "text", text: "public final answer" }], stopReason: "stop" } },
];

test.use({ seedProjects: [project], seedSessionFiles: [{ projectPath: project.path, fileName: "share-sample.jsonl", entries }], seedSettings: { standbyRuntimeEnabled: false, telemetryEnabled: false } });

test("Pi safe sharing previews excluded fields, requires review, writes identical bytes and leaves the session untouched", async ({ window, app }, testInfo) => {
	const original = await readFile(sessionFile, "utf8");
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	await window
		.getByRole("button", { name: new RegExp(project.name) })
		.first()
		.press("Enter");
	const row = window.getByRole("button", { name: title, exact: false }).first();
	await expect(row).toBeVisible({ timeout: 20_000 });
	await row.click();
	await expect(window.locator(".message-timeline")).toContainText("public final answer", { timeout: 20_000 });
	const tab = window.locator(".session-tabs-bar [role='tab']").filter({ hasText: title }).first();
	await tab.click({ button: "right" });
	await window.getByRole("menuitem", { name: "导出 HTML", exact: true }).click();
	const dialog = window.getByRole("dialog", { name: "导出会话", exact: true });
	await expect(dialog).toBeVisible();
	const save = dialog.getByRole("button", { name: "保存已预览的 HTML", exact: true });
	await expect(save).toBeDisabled();
	await dialog.getByRole("button", { name: "生成脱敏预览", exact: true }).click();
	const frame = dialog.locator("iframe");
	await expect(frame).toBeVisible();
	const html = await frame.getAttribute("srcdoc");
	expect(html).toContain("public final answer");
	for (const marker of ["PRIVATE_THINKING_520", "PRIVATE_ARG_520", "PRIVATE_RESULT_520", "FAKE_USER_TOKEN_520", image, project.path]) expect(html).not.toContain(marker);
	await expect(save).toBeDisabled();
	await dialog.getByRole("checkbox", { name: /^排除工具结果/ }).uncheck();
	await expect(frame).toHaveCount(0);
	await expect(save).toBeDisabled();
	await dialog.getByRole("button", { name: "生成脱敏预览", exact: true }).click();
	await expect(frame).toBeVisible();
	expect(await frame.getAttribute("srcdoc")).toContain("PRIVATE_RESULT_520");
	await dialog.getByRole("checkbox", { name: /^排除工具结果/ }).check();
	await dialog.getByRole("button", { name: "生成脱敏预览", exact: true }).click();
	await expect(frame).toBeVisible();
	const reviewedHtml = await frame.getAttribute("srcdoc");
	expect(reviewedHtml).not.toContain("PRIVATE_RESULT_520");
	await dialog.getByRole("checkbox", { name: "我已检查预览，确认这份副本可以分享。" }).check();
	await expect(save).toBeEnabled();
	await window.screenshot({ path: testInfo.outputPath("safe-share-preview.png") });
	await app.evaluate(({ BrowserWindow }) =>
		BrowserWindow.getAllWindows()
			.find((win) => win.webContents.getURL().includes("index.html"))
			?.setSize(1050, 720),
	);
	await window.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
	});
	await expect(save).toBeVisible();
	const bounds = await dialog.boundingBox();
	const viewport = window.viewportSize() ?? (await window.evaluate(() => ({ width: innerWidth, height: innerHeight })));
	expect(bounds!.y).toBeGreaterThanOrEqual(0);
	expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height);
	await window.screenshot({ path: testInfo.outputPath("safe-share-narrow-dark.png") });
	await save.click();
	await expect(dialog).toHaveCount(0);
	const exportDir = join(await app.evaluate(({ app }) => app.getPath("userData")), "exports");
	const files = await readdir(exportDir);
	const sharedFile = files.find((file: string) => /^shared-session-.*\.html$/.test(file));
	expect(sharedFile).toBeTruthy();
	expect(await readFile(join(exportDir, sharedFile!), "utf8")).toBe(reviewedHtml);
	expect(await readFile(sessionFile, "utf8")).toBe(original);
	await testInfo.attach("safe-share-preview", { path: testInfo.outputPath("safe-share-preview.png"), contentType: "image/png" });
});
