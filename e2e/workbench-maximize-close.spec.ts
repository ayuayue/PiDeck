import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * 回归：文件预览「占满中间栏 → 关闭」后会话面板必须恢复满宽。
 *
 * 现场（2026-10-21）：右侧文件树打开 markdown → 点「占满中间栏」→ 在最大化状态点右上角关闭，
 * 会话面板只回到 ~48%，右半边留一片空白；再打开一个文件再关才恢复正常。
 * 根因是 WorkbenchStage 无内容分支的 expand/collapse 顺序（详见组件内注释与
 * tests/workbenchContentHost.test.mjs 的顺序守卫）。
 */
const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-wbclose-"));
writeFileSync(join(projectDir, "note.md"), ["# Note", "", "hello", ""].join("\n"));

test.use({
	seedProjects: [{ id: "p1", name: "workbench-close", path: projectDir }],
});

/** 打开预置项目并新建一条会话（会话栏渲染栈的宿主）。 */
async function openProjectSession(window: import("@playwright/test").Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await window.getByRole("tab", { name: "项目" }).click();
	const projectItem = window.locator(".conversation", { hasText: "workbench-close" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	await projectItem.hover();
	await projectItem.getByRole("button", { name: "普通会话" }).first().click();
}

/** 打开右侧抽屉文件树并点开 note.md（进工作台阅读面）。 */
async function openNoteFile(window: import("@playwright/test").Page) {
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
}

/** 会话面板占整条工作台宽度的比例。 */
function sessionRatio(window: import("@playwright/test").Page) {
	return async () => {
		const box = await window.locator(".workbench-session-pane").first().boundingBox();
		const stageBox = await window.locator(".workbench-stage-split").first().boundingBox();
		if (!box || !stageBox || stageBox.width === 0) return 0;
		return box.width / stageBox.width;
	};
}

const closeReadingSurface = (window: import("@playwright/test").Page) => window.locator(".file-diff-header-actions").getByRole("button", { name: "关闭" }).first();

test("closing the maximized file preview restores the session pane to full width", async ({ window }) => {
	await openProjectSession(window);
	await openNoteFile(window);
	await expect(window.locator(".workbench-stage-split").first()).toBeVisible({ timeout: 15_000 });
	const ratio = sessionRatio(window);
	await expect.poll(ratio, { timeout: 5_000 }).toBeGreaterThan(0.4);

	const maximizeBtn = window.getByRole("button", { name: "占满中间栏" });
	await expect(maximizeBtn).toBeVisible({ timeout: 10_000 });
	await maximizeBtn.click();
	await expect.poll(ratio, { timeout: 5_000 }).toBeLessThan(0.05);

	const closeBtn = closeReadingSurface(window);
	await expect(closeBtn).toBeVisible({ timeout: 10_000 });
	await closeBtn.click();
	await expect(window.locator(".workbench-stage-with-content")).toHaveCount(0, { timeout: 10_000 });
	// 修复前这里是 0.48（内容面板被尺寸再平衡弹回 52%，右半边留白）。
	await expect.poll(ratio, { timeout: 5_000 }).toBeGreaterThan(0.95);
});

test("closing the file preview from split mode keeps restoring full width", async ({ window }) => {
	await openProjectSession(window);
	await openNoteFile(window);
	await expect(window.locator(".workbench-stage-split").first()).toBeVisible({ timeout: 15_000 });
	const ratio = sessionRatio(window);
	await expect.poll(ratio, { timeout: 5_000 }).toBeGreaterThan(0.4);

	const closeBtn = closeReadingSurface(window);
	await expect(closeBtn).toBeVisible({ timeout: 10_000 });
	await closeBtn.click();
	await expect(window.locator(".workbench-stage-with-content")).toHaveCount(0, { timeout: 10_000 });
	await expect.poll(ratio, { timeout: 5_000 }).toBeGreaterThan(0.95);
});

test("maximize → restore split still returns the session pane to ~48%", async ({ window }) => {
	await openProjectSession(window);
	await openNoteFile(window);
	await expect(window.locator(".workbench-stage-split").first()).toBeVisible({ timeout: 15_000 });
	const ratio = sessionRatio(window);

	await window.getByRole("button", { name: "占满中间栏" }).click();
	await expect.poll(ratio, { timeout: 5_000 }).toBeLessThan(0.05);

	// 反向路径（workbench-split.spec 记录的回归点）：恢复分屏必须回到 ~48%，不能只剩窄缝。
	await window.getByRole("button", { name: "恢复分屏" }).click();
	await expect.poll(ratio, { timeout: 5_000 }).toBeGreaterThan(0.4);
});
