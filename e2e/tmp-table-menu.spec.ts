import { test, expect } from "./mock-pi-fixture";
import { openFirstSession } from "./open-session";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * 临时验证：表格工具栏复制/下载下拉菜单与表格内容重叠问题。
 * 复现路径：打开复制下拉 → 鼠标移开（顶栏失去 hover）→ 截图确认菜单仍盖在表格之上。
 */
const OUT_DIR = join(__dirname, "..", "test-results", "tmp-table-menu");
mkdirSync(OUT_DIR, { recursive: true });

test("table toolbar dropdown must not overlap table text", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await openFirstSession(window);
	const timeline = window.locator(".message-timeline");

	await composer.click();
	await window.keyboard.type("MDEMO 表格菜单巡检");
	await window.keyboard.press("Enter");
	await expect(timeline).toContainText("渲染元素巡检", { timeout: 15_000 });
	await expect(timeline.locator('[data-streamdown="table-wrapper"]')).toBeVisible({ timeout: 15_000 });

	const wrapper = timeline.locator('[data-streamdown="table-wrapper"]');
	// 顶栏：复制 / 下载 / 全屏 三个按钮
	const toolbar = wrapper.locator("> div").first();
	const copyBtn = toolbar.locator("button").first();
	const downloadBtn = toolbar.locator("button").nth(1);

	// 1. 打开复制下拉（Copy as Markdown / CSV / TSV）
	await copyBtn.click();
	await expect(timeline.getByText("Copy as Markdown").last()).toBeVisible({ timeout: 5000 });
	// 鼠标移到菜单项上
	await timeline.getByText("Copy as CSV").last().hover();
	await window.screenshot({ path: join(OUT_DIR, "copy-menu-hover.png") });
	// 鼠标移开（顶栏失去 hover、按钮回到半隐态）——旧实现此时菜单掉到表格下面
	await window.mouse.move(10, 10);
	await window.waitForTimeout(300);
	await window.screenshot({ path: join(OUT_DIR, "copy-menu-mouse-away.png") });

	// 用像素对比不现实，改用几何断言：菜单面板应与表格文本区域分离（y 在表格上方/不重叠）
	// 菜单面板 z 层检查：通过 boundingBox 判断菜单右下缘是否在表格顶行之上？直接人工看图更可靠，
	// 这里只输出几何信息供核对。
	const menuBox = await timeline.getByText("Copy as TSV").last().boundingBox();
	const tableBox = await wrapper.locator("[data-streamdown='table']").boundingBox();
	console.log("[tmp] copy-menu tsv item box:", JSON.stringify(menuBox));
	console.log("[tmp] table box:", JSON.stringify(tableBox));

	// 2. 关闭菜单，验证下载下拉
	await window.keyboard.press("Escape");
	await window.waitForTimeout(200);
	await downloadBtn.click();
	await expect(timeline.getByText("Copy as CSV").last()).not.toBeVisible();
	await window.waitForTimeout(300);
	await window.screenshot({ path: join(OUT_DIR, "download-menu-open.png") });
});
