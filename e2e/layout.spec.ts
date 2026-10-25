import { test, expect } from "./fixtures";
import { openFirstSession, makeSeedProject } from "./open-session";

const seedProject = makeSeedProject("LayoutE2E");
test.use({ seedProjects: [seedProject] });

/**
 * 布局手动项自动化（#113 3.3-11）：
 * 左侧栏折叠/展开；右侧抽屉开关、切换 files/git/browser。
 * （3.3-12 终端 Dock 见 layout-terminal.spec.ts，需要 mock pi agent。）
 */

test("layout: sidebar collapse/expand", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const sidebar = window.locator(".shell-panel-list");
	await expect(sidebar).toBeVisible();
	const widthBefore = (await sidebar.boundingBox())!.width;

	// 折叠按钮在 list 面板工具栏（AppSidebar）；展开按钮有两处：AppSidebar（收起后
	// 在极小 panel 内不可见）+ SessionTabsBar 常驻（同一 toggleListCollapsed），
	// 折叠后点 SessionTabsBar 那个（chat 面板内，始终可见）。
	const listPanel = window.getByTestId("list");
	await listPanel.getByRole("button", { name: "折叠列表" }).click();
	const expandButton = window.locator(".shell-panel-chat").getByRole("button", { name: "展开列表" });
	await expect(expandButton).toBeVisible({ timeout: 3000 });
	const widthCollapsed = (await sidebar.boundingBox())!.width;
	expect(widthCollapsed).toBeLessThan(widthBefore);

	// 展开还原
	await expandButton.click();
	await expect(listPanel.getByRole("button", { name: "折叠列表" })).toBeVisible({ timeout: 3000 });
	const widthRestored = (await sidebar.boundingBox())!.width;
	expect(widthRestored).toBeGreaterThan(widthCollapsed);
});

test("layout: drawer open/switch", async ({ window }) => {
	// 新建会话打开工作台后，头部抽屉开关才出现
	await openFirstSession(window);
	await window.locator(".header-drawer-toggle").first().click();

	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true", { timeout: 5000 });

	// 切换 tab：点击当前未选中的 tab，aria-selected 随之移动；
	// 注意点击已激活 tab 会关闭抽屉（toggle 语义），不能乱点。
	const rail = window.locator(".drawer-activity-rail");
	const tabs = rail.locator("[role='tab']");
	const count = await tabs.count();
	expect(count).toBeGreaterThanOrEqual(2);
	const activeIndex = await tabs.evaluateAll((list) => list.findIndex((el) => el.getAttribute("aria-selected") === "true"));
	const nextIndex = activeIndex === 0 ? 1 : 0;
	await tabs.nth(nextIndex).click();
	await expect(tabs.nth(nextIndex)).toHaveAttribute("aria-selected", "true", { timeout: 3000 });
});

test("layout: project present in sidebar hides the add-directory guide", async ({ window }) => {
	// 有真实项目（本文件 seed）时，侧边栏「项目」分组显示项目行，不再渲染空态引导
	// （空态引导只出现在仅内置 Chat 的新用户场景，见 sidebar-empty-state.spec.ts）
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await expect(window.getByText("添加你的项目目录")).toHaveCount(0, { timeout: 10_000 });
	await expect(window.locator(".conversation", { hasText: "pideck-seed-layoute2e-" }).first()).toBeVisible({ timeout: 20_000 });
});
