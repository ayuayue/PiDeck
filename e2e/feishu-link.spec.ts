import { test, expect } from "./mock-pi-fixture";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 输入框飞书链接入口回归（#113 main 对齐项）：
 * - 有已配置 Bot 且项目会话有 runtime 时，composer 底栏显示飞书三色 Logo 入口
 * - 点击入口弹出绑定菜单，显示 Bot 名称（按会话绑定/切换的入口）
 * 注：e2e 无真实飞书连接，status 为 disconnected，验证的是入口与菜单渲染链路。
 */

// 注意：目录名必须避开 projectPathPolicy.isEphemeralProjectPath 的过滤名单（pideck-feishu-e2e 等），
// 否则启动时种子项目会被 ProjectStore.dropEphemeralProjects 清掉，项目行不渲染。
const projectDir = join(tmpdir(), "pideck-seed-feishu-proj");
rmSync(projectDir, { recursive: true, force: true });
mkdirSync(projectDir, { recursive: true });
writeFileSync(join(projectDir, "readme.md"), "# Feishu E2E\n");

test.use({
	seedProjects: [{ id: "e2e-feishu-proj", name: "FeishuE2E", path: projectDir }],
	seedFeishuBots: [{ id: "bot-e2e", name: "E2E 测试机器人", appId: "cli_e2e_test" }],
});

test("composer shows Feishu logo entry in project session; menu lists bot", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 侧栏分段(56469f95)后默认停在「聊天」分段，项目行渲染在「项目」分段下，先切换
	await window.getByRole("tab", { name: "项目" }).click();
	// 项目行 → 项目内「新建 Agent」→ 会话视图（composer 可用）
	const projectRow = window.locator(".conversation", { hasText: "pideck-seed-feishu-proj" }).first();
	await projectRow.click();
	await projectRow.getByTitle("普通会话").first().click();
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// 飞书入口：logo（SVG）而非圆点/文字（main 对齐项）
	const trigger = window.locator(".composer-bottom-left .feishu-link-trigger").first();
	await expect(trigger).toBeVisible({ timeout: 15_000 });
	await expect(trigger.locator(".feishu-link-logo svg")).toHaveCount(1);
	// 状态未连接时 logo 半透明（disconnected opacity）
	await expect(trigger.locator(".feishu-link-logo.disconnected")).toHaveCount(1);

	// 点击入口 → 绑定菜单列出已配置 Bot
	await trigger.click();
	const popover = window.locator(".feishu-link-popover");
	await expect(popover).toBeVisible();
	await expect(popover.getByText("E2E 测试机器人")).toBeVisible();

	// 强可见性断言：popover 中心点必须真正命中 popover 自身。
	// toBeVisible 只检查非空 bbox，被 overflow-y:hidden 裁剪的元素仍会被判定可见，
	// 此处防裁剪回归（da415c99 把 composer 底栏改为单行滚动容器后曾导致 popover 被裁掉）。
	const popoverBox = await popover.boundingBox();
	expect(popoverBox).not.toBeNull();
	const hitPopup = await window.evaluate(
		([x, y]) => {
			const el = document.elementFromPoint(x, y);
			return el !== null && el.closest(".feishu-link-popover") !== null;
		},
		[popoverBox!.x + popoverBox!.width / 2, popoverBox!.y + popoverBox!.height / 2],
	);
	expect(hitPopup).toBe(true);
});
