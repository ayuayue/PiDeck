import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * 文件阅读面「重新加载」回归：文件内容只在打开/切 Tab 时读一次，
 * AI 或外部编辑器改了磁盘后，面板不会自己变，要靠顶栏刷新钮重读。
 * 断言真实读盘结果（改写磁盘 → 点刷新 → 编辑器显示新内容），而不是只看按钮存在。
 */

const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-reload-"));
const filePath = join(projectDir, "reload-probe.txt");
writeFileSync(filePath, "DISK_CONTENT_V1\n");

test.use({
	seedProjects: [{ id: "p1", name: "reload", path: projectDir }],
});

test("文件阅读面的重新加载读回磁盘最新内容", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("tab", { name: "项目" }).click();
	const projectItem = window.locator(".conversation", { hasText: "reload" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	const projectRow = window.locator(".conversation", { hasText: "reload" }).first();
	await projectRow.hover();
	await projectRow.getByRole("button", { name: "普通会话" }).first().click();

	const toggle = window.locator(".header-drawer-toggle").first();
	await expect(toggle).toBeVisible();
	await toggle.click();
	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true");

	const refreshButton = drawer.getByRole("button", { name: /刷新/ }).first();
	await refreshButton.click().catch(() => undefined);
	const fileRow = drawer.locator(".file-node-row", { hasText: "reload-probe.txt" }).first();
	await expect(fileRow).toBeVisible({ timeout: 15_000 });
	await fileRow.click();

	const editor = window.locator(".file-diff-body .cm-content").first();
	await expect(editor).toContainText("DISK_CONTENT_V1", { timeout: 15_000 });

	// 模拟 AI / 外部编辑器改写磁盘：面板此时仍是旧快照
	writeFileSync(filePath, "DISK_CONTENT_V2\n");
	await expect(editor).toContainText("DISK_CONTENT_V1");

	const reloadButton = window.locator(".file-diff-header-actions").getByRole("button", { name: "重新加载" }).first();
	await expect(reloadButton).toBeVisible({ timeout: 10_000 });
	await reloadButton.click();

	await expect(editor).toContainText("DISK_CONTENT_V2", { timeout: 15_000 });
	await expect(editor).not.toContainText("DISK_CONTENT_V1");
});
