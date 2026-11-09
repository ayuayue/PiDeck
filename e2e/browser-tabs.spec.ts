import { test, expect } from "./fixtures";
import { openFirstSession, makeSeedProject } from "./open-session";

const seedProject = makeSeedProject("BrowserTabsE2E");
test.use({ seedProjects: [seedProject] });

/**
 * 内置浏览器 tab 关闭回归守卫（issue：点叉无法关闭 tab / 最后 tab 关闭应收起侧边栏）。
 * 通过打包产物启动（webview 管线为默认值），断言：
 * 1. 关闭非最后 tab：该 tab 消失，其余 tab 保留，抽屉仍打开。
 * 2. 关闭最后一个 tab：整个浏览器抽屉关闭（侧边栏收起）。
 */
async function openBrowserPanel(window: import("@playwright/test").Page) {
	// 新建会话打开工作台后，头部抽屉开关才出现
	await openFirstSession(window);
	const toggle = window.locator(".header-drawer-toggle").first();
	await expect(toggle).toBeVisible();
	await toggle.click();
	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true");
	// browser 默认未钉住：先从「添加常驻面板」加入
	await window.getByRole("button", { name: "添加常驻面板" }).click();
	await window.getByRole("menuitemcheckbox", { name: "内置浏览器" }).click();
	// 切到浏览器面板
	await window.getByTestId("drawer-rail-browser").click();
	await expect(window.getByTestId("drawer-rail-browser")).toHaveAttribute("aria-selected", "true");
}

test("closing a non-last browser tab removes it and keeps the drawer open", async ({ window }) => {
	await openBrowserPanel(window);

	// 初始一个 tab（PiDeck 默认页），X 按钮数量即 tab 数
	const closeButtons = window.locator(".browser-tab-close");
	await expect(closeButtons).toHaveCount(1);

	// 点 "+" 新建第二个 tab（lucide-plus 图标定位，避免 i18n 文案耦合）
	await window.locator(".browser-panel svg.lucide-plus").click();
	await expect(closeButtons).toHaveCount(2);

	// 关闭第一个 tab
	await closeButtons.first().click();

	// 该 tab 消失，抽屉仍处于打开状态
	await expect(closeButtons).toHaveCount(1);
	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true");
});

test("closing the last browser tab collapses the sidebar", async ({ window }) => {
	await openBrowserPanel(window);

	// 初始一个 tab
	const closeButtons = window.locator(".browser-tab-close");
	await expect(closeButtons).toHaveCount(1);

	// 关闭最后一个 tab：应直接收起浏览器侧边栏
	await closeButtons.first().click();

	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "false");
});
