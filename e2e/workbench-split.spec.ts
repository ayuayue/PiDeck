import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";

/**
 * 中间栏工作台 split/maximize 回归（issue: 缩小后不在原侧边）：
 *
 * 背景：react-resizable-panels v4 的约束派生把数字尺寸按 px 解析（minSize={20} → 2%），
 * 且 defaultSize 随 layout 切换（48↔0）会触发 Panel 重注册、丢失 expandToSize（折叠前宽度），
 * 导致「最大化 → 缩小」后会话面板只剩 2% 窄缝（正确行为：恢复 ~48%）。
 * 修复：WorkbenchStage 尺寸统一字符串百分比 + defaultSize 恒定。
 *
 * 同时覆盖：文件预览（view）与 DIFF 右上角始终有「关闭」按钮（chromeTabsExternal 不再隐藏）；
 * 以及「占满中间栏的文件面 vs 会话面」互斥（点会话 Tab 让文件面让位，点文件 Tab 复原）。
 */
// 项目目录避开 isEphemeralProjectPath 过滤名单（pideck-wb- 会被启动时清掉）
const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-wb-"));
writeFileSync(join(projectDir, "hello.ts"), "export const hello = 1;\n");

test.use({
	seedProjects: [{ id: "p1", name: "workbench", path: projectDir }],
});

/** 会话面板占工作台宽度比：split ≈0.48、maximize ≈0（会话面板收起） */
async function sessionRatio(window: Page) {
	const sessionBox = await window.locator(".workbench-session-pane").first().boundingBox();
	const stageBox = await window.locator(".workbench-stage-split").first().boundingBox();
	if (!sessionBox || !stageBox || stageBox.width === 0) return 0;
	return sessionBox.width / stageBox.width;
}

/** 进入预置项目（withSession 时先建一个会话，让 Tab 栏里有可点的会话 Tab）→ 打开抽屉文件树 → 点开 hello.ts */
async function openWorkbenchFile(window: Page, options: { withSession?: boolean } = {}) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 侧栏默认停在「聊天」分段，工作区项目行在「项目」分段下
	await window.getByRole("tab", { name: "项目" }).click();
	const projectRow = window.locator(".conversation", { hasText: "workbench" }).first();
	await expect(projectRow).toBeVisible({ timeout: 20_000 });
	await projectRow.click();

	if (options.withSession) {
		await projectRow.hover();
		await projectRow.getByRole("button", { name: "普通会话" }).first().click();
	}

	// 打开右侧抽屉（files 面板）
	const toggle = window.locator(".header-drawer-toggle").first();
	await expect(toggle).toBeVisible();
	await toggle.click();
	await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true");

	// 点击文件 → 中间栏分屏打开（会话在左、文件在右）
	const fileRow = window.locator(".detail-drawer").locator(".file-node-row", { hasText: "hello.ts" }).first();
	await expect(fileRow).toBeVisible({ timeout: 15_000 });
	await fileRow.click();
	await expect(window.locator(".workbench-stage-split").first()).toBeVisible({ timeout: 15_000 });
}

test("workbench: split → maximize → split 恢复会话面板宽度", async ({ window }) => {
	await openWorkbenchFile(window);

	// 初始 split：会话面板 ≈48%
	expect(await sessionRatio(window)).toBeGreaterThan(0.4);

	// 最大化：会话面板收起（≈0%）
	const maximizeBtn = window.getByRole("button", { name: "占满中间栏" });
	await expect(maximizeBtn).toBeVisible({ timeout: 10_000 });
	await maximizeBtn.click();
	await expect.poll(() => sessionRatio(window), { timeout: 5_000 }).toBeLessThan(0.05);

	// 缩小回 split：必须恢复 ≈48%（回归点：修复前只剩 2%）
	const restoreBtn = window.getByRole("button", { name: "恢复分屏" });
	await expect(restoreBtn).toBeVisible({ timeout: 10_000 });
	await restoreBtn.click();
	await expect.poll(() => sessionRatio(window), { timeout: 5_000 }).toBeGreaterThan(0.4);
});

test("workbench: 文件预览右上角始终有关闭按钮", async ({ window }) => {
	await openWorkbenchFile(window);

	// 右上角关闭按钮存在（修复前 chromeTabsExternal 会隐藏它）
	const closeBtn = window
		.locator(".file-diff-header-actions")
		.getByRole("button", {
			name: "关闭",
		})
		.first();
	await expect(closeBtn).toBeVisible({ timeout: 15_000 });

	// 点击后关闭整个阅读面（回到无内容状态）
	await closeBtn.click();
	await expect(window.locator(".workbench-stage-with-content")).toHaveCount(0, { timeout: 10_000 });
});

test("workbench: 点会话 Tab 让占满中间栏的文件面让位，点回文件 Tab 复原", async ({ window }) => {
	// 回归点：修复前点会话 Tab 只改 currentSessionId，文件面仍旧铺满中间栏 → 点了没反应
	await openWorkbenchFile(window, { withSession: true });

	const maximizeBtn = window.getByRole("button", { name: "占满中间栏" });
	await maximizeBtn.click();
	await expect.poll(() => sessionRatio(window), { timeout: 5_000 }).toBeLessThan(0.05);

	const sessionTab = window.locator(".session-tabs-bar [role=tab][data-session-id]").first();
	await expect(sessionTab).toBeVisible();
	await sessionTab.click();
	await expect.poll(() => sessionRatio(window), { timeout: 5_000 }).toBeGreaterThan(0.4);

	// 文件 Tab 保留（只是让位），点回来仍是占满中间栏的文件面
	const fileTab = window.locator(".session-tabs-bar").getByRole("tab", { name: "hello.ts" }).first();
	await expect(fileTab).toBeVisible();
	await fileTab.click();
	await expect.poll(() => sessionRatio(window), { timeout: 5_000 }).toBeLessThan(0.05);
});
