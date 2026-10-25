import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openConfigPane } from "./open-session";

/**
 * 视觉巡检（#115 U5 收口后）：对启动页与各主要页面截图，
 * 供人工审查视觉回退。截图输出到 test-results/visual/。
 *
 * 覆盖：工作台、项目/会话右键菜单、设置各 tab、ConfigModal（pi管理/
 * 模型/认证/技能）、文件抽屉，明暗两套主题。
 */

const OUT_DIR = join(__dirname, "..", "test-results", "visual");
mkdirSync(OUT_DIR, { recursive: true });

async function shot(window: Page, name: string) {
	await window.screenshot({ path: join(OUT_DIR, `${name}.png`) });
}

/** 关闭可能残留的 Radix 浮层 */
async function dismissOverlays(window: Page) {
	for (let i = 0; i < 3; i++) {
		await window.keyboard.press("Escape");
		await window.waitForTimeout(150);
	}
}

async function openContextMenu(window: Page, selector: string, name: string) {
	await dismissOverlays(window);
	const target = window.locator(selector).first();
	await target.click({ button: "right" });
	const menu = window.locator("[data-slot='dropdown-menu-content']").first();
	await expect(menu).toBeVisible({ timeout: 3000 });
	// hover 第一项展示 hover 态
	const item = menu.locator("[data-slot='dropdown-menu-item']").first();
	await item.hover();
	await window.waitForTimeout(250);
	await shot(window, name);
	await window.keyboard.press("Escape");
	await window.waitForTimeout(200);
}

async function openSettings(window: Page) {
	await dismissOverlays(window);
	await window.getByRole("button", { name: /^设置/ }).click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible({ timeout: 5000 });
	await window.waitForTimeout(300);
	return modal;
}

async function closeSettings(window: Page) {
	const modal = window.locator(".settings-modal");
	if (await modal.count()) {
		await modal.getByRole("button", { name: "关闭" }).first().click();
		await expect(modal)
			.toHaveCount(0, { timeout: 3000 })
			.catch(() => {});
	}
}

test("visual tour: light + dark", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.waitForTimeout(1000);

	// ── 亮色 ──
	await shot(window, "01-workbench-light");
	await openContextMenu(window, ".project-group", "02-menu-project-light");
	// 会话右键（真实会话列表来自 ~/.pi，可能没有；有则截）
	const sessionRow = window.locator(".session-card, .session-row, [class*='session-item']").first();
	if (await sessionRow.count()) {
		await openContextMenu(window, ".session-card, .session-row, [class*='session-item']", "03-menu-session-light");
	}

	// 设置：常用
	const modal = await openSettings(window);
	await shot(window, "04-settings-common-light");
	// 开发设置（Switch）
	await modal.getByText("开发设置").click();
	await window.waitForTimeout(300);
	await shot(window, "05-settings-dev-light");
	// 缓存与日志（按钮）
	await modal.getByText("缓存与日志").click();
	await window.waitForTimeout(300);
	await shot(window, "06-settings-storage-light");
	// Select 展开
	const trigger = modal.locator("[data-slot='select-trigger']").first();
	if (await trigger.count()) {
		await trigger.click();
		await window.waitForTimeout(400);
		await shot(window, "07-settings-select-open-light");
		await window.keyboard.press("Escape");
	}
	await closeSettings(window);

	// ConfigModal：模型 / 认证
	await dismissOverlays(window);
	await openConfigPane(window);
	const config = window.locator(".config-modal");
	await expect(config).toBeVisible({ timeout: 5000 });
	await window.waitForTimeout(500);
	await shot(window, "08-config-models-light");
	// 侧栏 nav：认证 / 技能
	const navAuth = config.getByText(/^认证$|^Auth$/).first();
	if (await navAuth.count()) {
		await navAuth.click();
		await window.waitForTimeout(400);
		await shot(window, "09-config-auth-light");
	}
	const navSkills = config.getByText(/^技能$|^Skills$/).first();
	if (await navSkills.count()) {
		await navSkills.click();
		await window.waitForTimeout(400);
		await shot(window, "10-config-skills-light");
	}
	await window.keyboard.press("Escape");
	await window.waitForTimeout(300);

	// 文件抽屉 + tab 条（横排 rail 回归验证）
	const rail = window.locator(".drawer-activity-rail");
	if (await rail.count()) {
		await window
			.locator(".detail-drawer")
			.first()
			.screenshot({ path: join(OUT_DIR, "11-drawer-files-light.png") });
	}

	// ── 暗色：直接切 data-theme（应用主题机制） ──
	await window.evaluate(() => {
		document.documentElement.dataset.theme = "dark";
	});
	await window.waitForTimeout(400);
	await shot(window, "20-workbench-dark");
	await openContextMenu(window, ".project-group", "21-menu-project-dark");
	const modal2 = await openSettings(window);
	await shot(window, "22-settings-common-dark");
	await closeSettings(window);
	// 确认主题没被设置原子回写
	const theme = await window.evaluate(() => document.documentElement.dataset.theme);
	console.log("theme after settings round-trip:", theme);
});
