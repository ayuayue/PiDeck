import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * 文件阅读面「预览 → 源码（编辑）」的落盘链路回归：
 * 编辑停止 500ms 自动保存、Ctrl+S 立即保存。
 * 用户在 dev 包里报「转为编辑后没有自动保存、Ctrl+S 也不行」，本用例钉住真实写盘结果
 * （从磁盘读文件断言，而不是只看界面上的未保存标记）。
 */

const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-autosave-"));
const markdownPath = join(projectDir, "note.md");
writeFileSync(markdownPath, "# 标题\n\n原始内容\n");

test.use({
	seedProjects: [{ id: "p1", name: "autosave", path: projectDir }],
});

test("markdown 预览转源码后自动保存，Ctrl+S 立即落盘", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("tab", { name: "项目" }).click();
	const projectItem = window.locator(".conversation", { hasText: "autosave" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	const projectRow = window.locator(".conversation", { hasText: "autosave" }).first();
	await projectRow.hover();
	await projectRow.getByRole("button", { name: "普通会话" }).first().click();

	const toggle = window.locator(".header-drawer-toggle").first();
	await expect(toggle).toBeVisible();
	await toggle.click();
	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true");

	const refreshButton = drawer.getByRole("button", { name: /刷新/ }).first();
	await refreshButton.click().catch(() => undefined);
	const fileRow = drawer.locator(".file-node-row", { hasText: "note.md" }).first();
	await expect(fileRow).toBeVisible({ timeout: 15_000 });
	await fileRow.click();

	// markdown 默认渲染预览（MarkdownStream），点「源码」才进入编辑态
	await expect(window.locator(".markdown-preview-chrome").first()).toBeVisible({ timeout: 15_000 });
	const sourceButton = window.locator(".file-diff-header-actions").getByRole("button", { name: "源码" }).first();
	await expect(sourceButton).toBeVisible();
	await sourceButton.click();

	const editor = window.locator(".file-diff-body .cm-content").first();
	await expect(editor).toBeVisible({ timeout: 15_000 });
	await editor.click();
	await window.keyboard.press("Control+End");
	await window.keyboard.type("\nAUTOSAVE_PROBE_1");

	// 自动保存：停止编辑 500ms 后静默落盘
	await expect.poll(() => readFileSync(markdownPath, "utf8"), { timeout: 5_000, intervals: [200] }).toContain("AUTOSAVE_PROBE_1");

	// Ctrl+S：按键后 350ms 内就读盘——此时 500ms 防抖还没到期，读到内容只能来自「立即保存」
	// 重新点一次编辑器：上一轮保存会触发 React 重渲染，偶发抢走焦点，键入就落空（实测曾闪失败）
	await editor.click();
	await window.keyboard.press("Control+End");
	await window.keyboard.type("CTRL_S_PROBE");
	await expect(editor).toContainText("CTRL_S_PROBE");
	await window.keyboard.press("Control+s");
	await expect.poll(() => readFileSync(markdownPath, "utf8"), { timeout: 350, intervals: [10], message: "Ctrl+S 应立即落盘，而不是等 500ms 防抖" }).toContain("CTRL_S_PROBE");
});
