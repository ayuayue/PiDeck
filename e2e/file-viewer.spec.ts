import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * 文件查看链路回归（阅读面统一走中间栏分屏后重写）：
 * 原抽屉内查看器 + modal 展开/最小化的功能随「编辑器入口迁到分屏
 * （SessionTabsBar + WorkbenchContent）」移除；本测试覆盖迁移后的等价链路：
 * 项目 → 文件树 → 分屏打开查看器 → 关闭阅读面 → 抽屉保持打开。
 * （分屏比例与最大化/恢复的回归由 workbench-split.spec.ts 覆盖。）
 */

// 预置带文件的项目目录（前缀避开 isEphemeralProjectPath 过滤名单，否则种子项目启动时被清掉）
const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-fv-"));
writeFileSync(join(projectDir, "hello.ts"), "export const hello = 1;\n");

test.use({
	seedProjects: [{ id: "p1", name: "file-viewer", path: projectDir }],
});

test("file viewer opens in workbench split and closes back to the drawer", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 侧栏分段(56469f95)后默认停在「聊天」分段，工作区项目行在「项目」分段下，先切换
	await window.getByRole("tab", { name: "项目" }).click();
	// 进入预置项目：侧栏项目行显示项目名（seedProjects[].name；目录名已不再作为行标题）
	const projectItem = window.locator(".conversation", { hasText: "file-viewer" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	// 项目 select 后：点项目行的「新建 Agent」进入会话视图（main 无会话时空）
	// 注：项目行按钮已迁移为 aria-label 定位（旧 .project-action 类已随侧栏重构移除）
	const projectRow = window.locator(".conversation", { hasText: "file-viewer" }).first();
	await projectRow.hover();
	await projectRow.getByRole("button", { name: "普通会话" }).first().click();

	// 打开右侧抽屉（files 面板）
	const toggle = window.locator(".header-drawer-toggle").first();
	await expect(toggle).toBeVisible();
	await toggle.click();
	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true");

	// 刷新文件树后点击文件 → 中间栏分屏打开查看器
	const refreshButton = drawer.getByRole("button", { name: /刷新/ }).first();
	await refreshButton.click().catch(() => undefined);
	const fileRow = drawer.locator(".file-node-row", { hasText: "hello.ts" }).first();
	await expect(fileRow).toBeVisible({ timeout: 15_000 });
	await fileRow.click();

	await expect(window.locator(".workbench-stage-split").first()).toBeVisible({ timeout: 15_000 });
	// 阅读面右上角关闭按钮常驻可点
	const closeBtn = window.locator(".file-diff-header-actions").getByRole("button", { name: "关闭" }).first();
	await expect(closeBtn).toBeVisible({ timeout: 15_000 });

	// 关闭阅读面 → 回到无内容状态，抽屉保持打开（文件树可继续浏览）
	await closeBtn.click();
	await expect(window.locator(".workbench-stage-with-content")).toHaveCount(0, { timeout: 10_000 });
	await expect(drawer).toHaveAttribute("data-open", "true");
});
