import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * 中间栏工作台 split/maximize 回归（issue: 缩小后不在原侧边）：
 *
 * 背景：react-resizable-panels v4 的约束派生把数字尺寸按 px 解析（minSize={20} → 2%），
 * 且 defaultSize 随 layout 切换（48↔0）会触发 Panel 重注册、丢失 expandToSize（折叠前宽度），
 * 导致「最大化 → 缩小」后会话面板只剩 2% 窄缝（正确行为：恢复 ~48%）。
 * 修复：WorkbenchStage 尺寸统一字符串百分比 + defaultSize 恒定。
 *
 * 同时覆盖：文件预览（view）与 DIFF 右上角始终有「关闭」按钮（chromeTabsExternal 不再隐藏）。
 */
// 项目目录避开 isEphemeralProjectPath 过滤名单（pideck-wb- 会被启动时清掉）
const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-wb-"));
writeFileSync(join(projectDir, "hello.ts"), "export const hello = 1;\n");

test.use({
	seedProjects: [{ id: "p1", name: "workbench", path: projectDir }],
});

test("workbench: split → maximize → split 恢复会话面板宽度", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 侧栏默认停在「聊天」分段，工作区项目行在「项目」分段下
	await window.getByRole("tab", { name: "项目" }).click();
	// 进入预置项目，打开右侧抽屉文件树
	const projectItem = window.locator(".conversation", { hasText: "workbench" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	const toggle = window.locator(".header-drawer-toggle").first();
	await expect(toggle).toBeVisible();
	await toggle.click();
	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true");

	// 点击文件 → 中间栏 split 打开（会话在左、文件在右）
	const fileRow = drawer.locator(".file-node-row", { hasText: "hello.ts" }).first();
	await expect(fileRow).toBeVisible({ timeout: 15_000 });
	await fileRow.click();

	const sessionPane = window.locator(".workbench-session-pane").first();
	await expect(sessionPane).toBeVisible({ timeout: 15_000 });
	const stage = window.locator(".workbench-stage-split").first();
	await expect(stage).toBeVisible();

	const sessionRatio = async () => {
		const box = await sessionPane.boundingBox();
		const stageBox = await stage.boundingBox();
		if (!box || !stageBox || stageBox.width === 0) return 0;
		return box.width / stageBox.width;
	};

	// 初始 split：会话面板 ≈48%
	const initialRatio = await sessionRatio();
	expect(initialRatio).toBeGreaterThan(0.4);

	// 最大化：会话面板收起（≈0%）
	const maximizeBtn = window.getByRole("button", { name: "占满中间栏" });
	await expect(maximizeBtn).toBeVisible({ timeout: 10_000 });
	await maximizeBtn.click();
	await expect.poll(async () => sessionRatio(), { timeout: 5_000 }).toBeLessThan(0.05);

	// 缩小回 split：必须恢复 ≈48%（回归点：修复前只剩 2%）
	const restoreBtn = window.getByRole("button", { name: "恢复分屏" });
	await expect(restoreBtn).toBeVisible({ timeout: 10_000 });
	await restoreBtn.click();
	await expect.poll(async () => sessionRatio(), { timeout: 5_000 }).toBeGreaterThan(0.4);
});

test("workbench: 文件预览右上角始终有关闭按钮", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 侧栏默认停在「聊天」分段，工作区项目行在「项目」分段下
	await window.getByRole("tab", { name: "项目" }).click();
	const projectItem = window.locator(".conversation", { hasText: "workbench" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	const toggle = window.locator(".header-drawer-toggle").first();
	await expect(toggle).toBeVisible();
	await toggle.click();
	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true");

	// 打开文件（view 预览模式）
	const fileRow = drawer.locator(".file-node-row", { hasText: "hello.ts" }).first();
	await expect(fileRow).toBeVisible({ timeout: 15_000 });
	await fileRow.click();

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
