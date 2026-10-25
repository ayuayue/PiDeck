import { test, expect } from "./fixtures";
import { makeSeedProject } from "./open-session";

// 开发机普遍有多份 pi 安装：不预置已检测标记时，启动期「pi 环境检测」弹窗会
// 挡住主界面（多份安装不自动关窗），伪装成业务失败。
// 第二个项目：与内置 Chat 分属两个项目，Tab 栏才会出现组边界分隔线。
const seedProject = makeSeedProject("TabMenuE2E");
test.use({ seedProjects: [seedProject], seedSettings: { piEnvironmentChecked: true } });

/**
 * 会话 Tab 右键菜单回归（用户报「右键菜单没了」）：
 * 根因是 <ContextMenuTrigger asChild> 与 <Tooltip> 嵌套层级——asChild 把
 * onContextMenu 合并到「直接子元素」，中间隔一层 Tooltip.Root（非 DOM 组件）
 * 事件被静默丢弃。修复后 Trigger 必须直接包住 Tab div，此用例守卫该契约。
 */
test("session tab: context menu opens on right click", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 引导页发送创建真实会话并登记 Tab（空态 CTA 只清会话，不建 Tab）
	const composer = window.locator(".composer .rich-input").first();
	await expect(composer).toBeVisible({ timeout: 15_000 });
	await composer.click();
	await window.keyboard.type("你好");
	await window.keyboard.press("Enter");

	const tab = window.locator(".session-tabs-bar [role='tab']").first();
	await expect(tab).toBeVisible({ timeout: 15_000 });

	// 首次在 Chat 项目创建会话会弹「项目信任确认」，信任后继续（可低频重试，幂等）
	const trustButton = window.getByRole("button", { name: "信任并记住" });
	if (await trustButton.isVisible({ timeout: 2000 }).catch(() => false)) {
		await trustButton.click();
	}

	// 右键 Tab → ContextMenu content 出现
	await tab.click({ button: "right" });
	const menu = window.locator("[data-slot='context-menu-content']");
	await expect(menu).toBeVisible({ timeout: 3000 });

	// 菜单内容契约：固定 + 关闭组
	await expect(menu.getByText("固定标签页")).toBeVisible();
	await expect(menu.getByText("关闭标签页")).toBeVisible();
	// 会话操作组（2026-10-02 需求：右键菜单与 ⋯ 菜单结合）：刚发消息的 live 会话
	// 非草稿、有会话文件 → 重命名/复制会话/导出 HTML/路径组都应出现。
	await expect(menu.getByText("重命名")).toBeVisible();
	await expect(menu.getByText("复制会话")).toBeVisible();
	await expect(menu.getByText("导出 HTML")).toBeVisible();
	await expect(menu.getByText("复制会话文件路径")).toBeVisible();

	// ESC 关闭后再次右键仍可打开（排除「只能弹一次」的焦点残留）
	await window.keyboard.press("Escape");
	await expect(menu).toHaveCount(0);
	await tab.click({ button: "right" });
	await expect(window.locator("[data-slot='context-menu-content']")).toBeVisible({ timeout: 3000 });
});

/**
 * 分组分隔竖线可见性（用户报「看不清」）：竖线必须用不透明 border-strong，
 * 禁止回到半透明 bg-border/50（与白底几乎无差）。断言计算后的不透明度与宽度，
 * 颜色深度由 token 层保证（--color-border-strong 浅 #d7d7d7 / 暗 #3a3a3a）。
 */
test("tab bar: group dividers are opaque border-strong", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 会话一：Chat 项目（引导页发送 → 建真实会话并登记 Tab）
	const composer = window.locator(".composer .rich-input").first();
	await expect(composer).toBeVisible({ timeout: 15_000 });
	await composer.click();
	await window.keyboard.type("第一");
	await window.keyboard.press("Enter");
	await expect(window.locator(".session-tabs-bar [role='tab']")).toHaveCount(1, { timeout: 15_000 });
	const trustButton = window.getByRole("button", { name: "信任并记住" });
	if (await trustButton.isVisible({ timeout: 2000 }).catch(() => false)) {
		await trustButton.click();
	}

	// 会话二：Tab 栏「+」下拉选种子项目（不同项目 → 组边界出现分隔线）
	await window.locator(".session-tabs-bar .session-tabs-new").click();
	await window.getByRole("menuitem", { name: seedProject.name }).click();
	await expect(window.locator(".session-tabs-bar [role='tab']")).toHaveCount(2, { timeout: 15_000 });

	// 组边界分隔线：不透明（排除 /50 半透明回归）且高度 ≥18px（h-5 = 20px）
	const dividers = window.locator(".session-tabs-scroll span.h-5");
	await expect(dividers).toHaveCount(1);
	const style = await dividers.first().evaluate((el) => {
		const cs = getComputedStyle(el);
		return { bg: cs.backgroundColor, height: cs.height };
	});
	console.log("DIVIDER STYLE:", JSON.stringify(style));
	// 不透明：实色序列化为 rgb(r, g, b)（无 alpha 通道）；半透明才会是 rgba(..., 0.5)，
	// 即 bg-border/50 的回归形态。
	expect(style.bg.startsWith("rgb(")).toBe(true);
	expect(style.bg.includes("rgba(")).toBe(false);
	expect(Number.parseFloat(style.height)).toBeGreaterThanOrEqual(18);
});
