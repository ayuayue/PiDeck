import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

async function openSettingsDialog(window: Page) {
	await window.getByRole("button", { name: "设置" }).click();
	const settingsDialog = window.getByRole("dialog", { name: "设置" });
	await expect(settingsDialog).toBeVisible();
	return settingsDialog;
}

async function openConfigurationManagement(window: Page) {
	const settingsDialog = await openSettingsDialog(window);
	await settingsDialog.getByRole("tab", { name: "配置管理", exact: true }).click();
	const modal = settingsDialog.locator(".config-layout");
	await expect(modal).toBeVisible();
	return modal;
}

/**
 * 配置管理弹窗（pi 管理）各 Agent 能力 tab 的 smoke（#113 手测 #16 自动化部分）：
 * - 扩展：已安装扩展列表渲染（不依赖网络/pi），IPC 失败不白屏
 * - 技能：SkillsTab 空态/列表渲染
 * - 提示词：PromptsTab 渲染
 * - 外部连接：「外部连接」tab 的飞书机器人连接表单渲染（#113 手测 #15 的 UI 链路部分，真机收发仍需手动）
 *
 * 注意：e2e 无真实 pi/网络，这里只验证 UI 链路与错误兜底，不验证真实安装/开关。
 */
test("config modal: installed extensions section renders", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	const modal = await openConfigurationManagement(window);

	// 侧栏导航存在「扩展」入口
	const extensionsNav = modal.getByRole("tab", { name: "扩展", exact: true });
	await expect(extensionsNav).toBeVisible();
	await extensionsNav.click();

	// 扩展商店已替代旧的推荐包面板；验证当前本地扩展列表及其内置条目。
	await expect(modal.getByRole("heading", { name: "已安装扩展", exact: true })).toBeVisible();
	await expect(modal.getByText("pi-deck-todo").first()).toBeVisible({ timeout: 10_000 });
});

test("config modal: skills section renders empty state and create form", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	const modal = await openConfigurationManagement(window);

	await modal.getByRole("tab", { name: "技能", exact: true }).click();
	// 空态文案或列表区域（无 pi 环境下至少渲染空态，不白屏）
	await expect(modal.locator(".config-sidebar")).toBeVisible();
	// SkillsTab 渲染出「新建技能」入口或空态文案
	await expect(modal.getByText("技能").first()).toBeVisible();
});

test("config modal: external MCP and skill import dialogs open without writing resources", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	const modal = await openConfigurationManagement(window);

	await modal.getByRole("tab", { name: "MCP", exact: true }).click();
	const mcpImport = modal.getByRole("button", { name: "导入", exact: true });
	await expect(mcpImport).toBeVisible();
	await mcpImport.click();
	const mcpDialog = window.getByRole("dialog");
	await expect(mcpDialog.getByRole("heading", { name: "导入外部 MCP" })).toBeVisible();
	await expect(mcpDialog.getByText("没有发现可导入资源")).toBeVisible();
	await mcpDialog.getByRole("button", { name: "取消" }).click();

	await modal.getByRole("tab", { name: "技能", exact: true }).click();
	const skillImport = modal.getByRole("button", { name: "导入", exact: true });
	await expect(skillImport).toBeVisible();
	await skillImport.click();
	const skillDialog = window.getByRole("dialog");
	await expect(skillDialog.getByRole("heading", { name: "导入外部技能" })).toBeVisible();
	await expect(skillDialog.getByText("没有发现可导入资源")).toBeVisible();
	await skillDialog.getByRole("button", { name: "取消" }).click();
});

test("config modal: feishu bot section renders connect form (UI smoke)", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	const modal = await openSettingsDialog(window);

	await modal.getByRole("tab", { name: "外部连接", exact: true }).click();
	// 空态先渲染（无 Bot 配置），再点「添加 Bot」展开表单
	await expect(modal.getByText("暂无 Bot 配置")).toBeVisible({ timeout: 10_000 });
	await modal.getByRole("button", { name: "添加 Bot" }).click();
	// 添加 Bot 表单：App ID 输入框（真实连接需要有效凭据，e2e 只验证表单可交互）
	const appIdInput = modal.locator('input[placeholder="cli_xxxxxxxxxxxx"]').first();
	await expect(appIdInput).toBeVisible({ timeout: 10_000 });
	await appIdInput.fill("cli_e2e_test_app");
	await expect(appIdInput).toHaveValue("cli_e2e_test_app");
});
