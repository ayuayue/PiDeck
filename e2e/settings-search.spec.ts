import { test, expect } from "./fixtures";
import { openSettings } from "./open-session";

/**
 * 设置页搜索：内容列顶部工具条输入 → 命中条目替换内容区 → 选中后切到对应 tab 并滚到锚点高亮。
 *
 * 背景（issue 反馈）：设置项分散在 20+ 个 tab，不熟悉 Ctrl+P 的用户找不到开关；
 * 搜索要求支持中文、英文别名与拼音首字母（dl → 代理、ylcx → 用量查询）。
 * 首版曾把搜索框塞进左侧 196px tab 栏，提示文案与结果行窄列换行截断不可读，
 * 现改为内容列顶部工具条 + 结果替换内容区（VS Code 设置搜索形态）。
 * 打分内核由 tests/settingsSearch.test.mjs 覆盖，这里验证接线与真实跳转。
 */
async function openSearch(window: import("@playwright/test").Page) {
	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	return { modal, input: modal.getByRole("combobox", { name: "搜索设置项" }) };
}

test("settings search toolbar lives in the content column and keeps its hint on one line", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const { modal, input } = await openSearch(window);

	// 回归守卫：搜索框必须在内容列（左侧 196px 侧栏的右边），不能回到窄列里
	const inputBox = await input.boundingBox();
	expect(inputBox).not.toBeNull();
	const sidebar = modal.locator(".settings-tabs");
	const sidebarBox = await sidebar.boundingBox();
	expect(inputBox.x).toBeGreaterThan(sidebarBox.x + sidebarBox.width - 1);

	// 提示文案（中文/英文/拼音说明）必须单行显示：高度不超过一行 caption 的 1.5 倍
	const hint = modal.locator("p", { hasText: "拼音首字母" });
	await expect(hint).toBeVisible();
	const hintBox = await hint.boundingBox();
	expect(hintBox.height).toBeLessThanOrEqual(20);
});

test("settings search jumps to a tab by pinyin", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await openSearch(window);
	const modal = window.locator(".settings-modal");
	const input = modal.getByRole("combobox", { name: "搜索设置项" });
	await input.fill("daili");

	const results = modal.getByRole("listbox", { name: "搜索设置项" });
	await expect(results).toBeVisible();
	// 「代理设置」tab 名全拼命中；tab 名通道保证它排在只靠关键词的条目之前
	const first = results.getByRole("option").first();
	await expect(first).toContainText("代理设置");

	// Enter 走选中项（无需鼠标），跳转后搜索框清空、tab 内容回来、目标 tab 激活
	await input.press("Enter");
	await expect(input).toHaveValue("");
	await expect(modal.getByRole("tab", { name: "代理设置" })).toHaveAttribute("aria-selected", "true");
});

test("settings search reaches a single setting and highlights its anchor", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const { modal, input } = await openSearch(window);
	// 英文关键词命中「启用桌面端网络代理」（settingsFieldAnchors 里的 desktop proxy）
	await input.fill("desktop proxy");
	const results = modal.getByRole("listbox", { name: "搜索设置项" });
	const option = results.getByRole("option", { name: /启用桌面端网络代理/ });
	await expect(option).toBeVisible();
	await option.click();

	// 落到代理设置 tab，并且目标行真的被定位（settings-anchor-flash 高亮 1.6s 后消失，故用短超时 poll）
	await expect(modal.getByRole("tab", { name: "代理设置" })).toHaveAttribute("aria-selected", "true");
	const anchor = modal.locator("#settings-section-proxy-enable-desktop");
	await expect(anchor).toBeVisible();
	await expect(anchor).toHaveClass(/settings-anchor-flash/, { timeout: 1200 });
});

test("settings search highlights the matched text for literal queries", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const { modal, input } = await openSearch(window);
	await input.fill("代理");
	const results = modal.getByRole("listbox", { name: "搜索设置项" });
	const first = results.getByRole("option").first();
	// 字面命中才标黄；拼音命中无法映射回汉字位置，不造假高亮（见 settingsSearch.ts）
	await expect(first.locator("mark")).toHaveText("代理");
	await expect(first).toContainText("代理设置");
});

test("settings search Esc clears the query first instead of closing the dialog", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const { modal, input } = await openSearch(window);
	await input.fill("daili");
	await expect(modal.getByRole("listbox", { name: "搜索设置项" })).toBeVisible();

	// 搜索中 Esc = 只清搜索（DialogContent 的 onEscapeKeyDown 拦截），弹窗保持打开
	await input.press("Escape");
	await expect(input).toHaveValue("");
	await expect(modal.getByRole("listbox", { name: "搜索设置项" })).toHaveCount(0);
	await expect(modal).toBeVisible();
	// 清空后 tab 内容回来
	await expect(modal.getByRole("tabpanel").first()).toBeVisible();
});

test("settings search shows an empty state and clears via the clear button", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const { modal, input } = await openSearch(window);
	await input.fill("zzzzzzzz");
	await expect(modal.getByText("没有匹配的设置项")).toBeVisible();

	await modal.getByRole("button", { name: "清除" }).click();
	await expect(input).toHaveValue("");
	// 清空后回到 tab 列表
	await expect(modal.getByRole("tab").first()).toBeVisible();
});
