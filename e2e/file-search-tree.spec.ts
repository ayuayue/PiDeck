import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "./mock-pi-fixture";

/**
 * 文件名搜索结果按命中路径归并成树（用户反馈「搜索结果是平铺的，看不出命中集中在哪个目录」）。
 * 这里守的是渲染链路：前缀目录要真的补出来、缩进随层深递增、目录行能折叠且收起后
 * 显示该目录下的命中数。归并规则本身由 tests/fileSearchTree.test.mjs 兜住。
 */

const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-search-tree-"));
for (const dir of ["src", "src/components", "src/components/deep", "src/utils"]) mkdirSync(join(projectDir, dir), { recursive: true });
writeFileSync(join(projectDir, "README.md"), "# sample\n");
writeFileSync(join(projectDir, "src/index.ts"), "export const a = 1;\n");
writeFileSync(join(projectDir, "src/components/index.ts"), "export const b = 2;\n");
writeFileSync(join(projectDir, "src/components/deep/index.ts"), "export const c = 3;\n");
writeFileSync(join(projectDir, "src/utils/index.ts"), "export const d = 4;\n");

test.use({ seedProjects: [{ id: "p1", name: "search-tree", path: projectDir }] });

test("file search results render as a tree with collapsible directories", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目" }).click();
	const projectItem = window.locator(".conversation", { hasText: "search-tree" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	const projectRow = window.locator(".conversation", { hasText: "search-tree" }).first();
	await projectRow.hover();
	await projectRow.getByRole("button", { name: "普通会话" }).first().click();
	await window.locator(".header-drawer-toggle").first().click();
	const drawer = window.locator(".detail-drawer");
	await expect(drawer).toHaveAttribute("data-open", "true");

	// 面板内 Ctrl+F 进入搜索，输入查询词
	await drawer
		.locator(".files-panel")
		.first()
		.click({ position: { x: 20, y: 120 } });
	await window.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
	const input = drawer.locator(".file-search-input");
	await expect(input).toBeVisible({ timeout: 5_000 });
	await input.fill("index");

	const dirButtons = drawer.locator(".file-node > button.directory");
	const fileButtons = drawer.locator(".file-node > button.file");
	await expect(fileButtons).toHaveCount(4, { timeout: 15_000 });
	// 前缀目录 src → components → deep、以及并列的 utils 都补出来了
	await expect(dirButtons.locator(".file-node-name")).toHaveText(["src", "components", "deep", "utils"]);
	// 缩进按层深递增（depth × 8px，与文件树同一套）
	const indents = await dirButtons.evaluateAll((elements) => elements.map((element) => Number.parseFloat(getComputedStyle(element).paddingLeft)));
	expect(indents).toEqual([8, 16, 24, 16]);

	// 折叠 src：子项整体收起，行右侧给出该目录下的命中数
	await dirButtons.first().click();
	await expect(dirButtons.first()).toHaveAttribute("aria-expanded", "false");
	await expect(fileButtons).toHaveCount(0);
	await expect(dirButtons.first()).toContainText("4");
});
