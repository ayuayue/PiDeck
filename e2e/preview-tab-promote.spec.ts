import { test, expect } from "./mock-pi-fixture";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 预览 Tab 发送消息后自动晋升常驻（#20c6e753 行为回归）。
 *
 * 场景：单击侧栏会话 → 预览 Tab（斜体）→ composer 发送消息 →
 * Tab 应自动常驻（斜体消失）。用户反馈：发送后不再常驻，需双击。
 */

// 项目目录避开 isEphemeralProjectPath 过滤名单（pideck-preview-promote-e2e 会被启动时清掉）
const projectDir = join(tmpdir(), "pideck-seed-preview-promote");
rmSync(projectDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });

test.use({
	seedProjects: [{ id: "e2e-preview-proj", name: "PreviewE2E", path: projectDir }],
});

test("preview tab becomes permanent after send", async ({ window }) => {
	test.setTimeout(150_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 侧栏分段(56469f95)后默认停在「聊天」分段，工作区项目行在「项目」分段下，先切换
	await window.getByRole("tab", { name: "项目" }).click();
	// 打开项目 → 新建 Agent → composer 可用（侧栏项目行按路径目录名匹配）
	const projectRow = window.locator(".conversation", { hasText: "pideck-seed-preview-promote" }).first();
	await projectRow.click();
	await projectRow.getByTitle("普通会话").first().click();
	const composer = window.locator(".composer .rich-input");
	// TipTap 迁移后 rich-input 不再输出 aria-disabled；用 contenteditable 判断可用
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// 第一条消息创建会话（Tab 常驻）
	await composer.click();
	await window.keyboard.type("预览会话一号");
	await window.keyboard.press("Enter");
	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("Mock 回复：「预览会话一号」", { timeout: 15_000 });
	await expect(window.locator('.session-tabs-bar [role="tab"]')).toHaveCount(1);

	// 关闭 Tab（会话仍在 catalog）
	await window.locator('.session-tabs-bar [role="tab"]').first().locator('[role="tab-close"]').click();
	await expect(window.locator('.session-tabs-bar [role="tab"]')).toHaveCount(0, { timeout: 10_000 });

	// 关闭 Tab 后 agent 仍在运行：侧栏显示为 agent 行（状态点 + 会话标题，标题已更新为首条消息内容，
	// 不再是 draft 时的「项目名 agent」），点击同样走 preview 模式
	const row = window.locator(".agent-row", { hasText: "预览会话一号" }).first();
	await row.click();
	const previewTab = window.locator('.session-tabs-bar [role="tab"]').first();
	await expect(previewTab).toBeVisible({ timeout: 10_000 });
	await expect(previewTab).toHaveClass(/italic/, { timeout: 10_000 });

	// 发送消息 → Tab 自动常驻（斜体消失）
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.type("第二条消息");
	await window.keyboard.press("Enter");
	await expect(timeline).toContainText("Mock 回复：「第二条消息」", { timeout: 15_000 });
	await expect(previewTab).not.toHaveClass(/italic/, { timeout: 10_000 });
});
