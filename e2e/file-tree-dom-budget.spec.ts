import { test, expect } from "./fixtures";
import { makeSeedProject } from "./open-session";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * 文件抽屉渲染预算回归（性能）。
 *
 * 背景：文件树原本对根层与每个目录的 children 全量 `.map`，一个 2000 项的目录
 * （主进程单层上限，见 shared/fileTree.ts）会在一次 commit 里同步挂满整棵子树；
 * 行内还有 Seti SVG / 缩进 guide / Radix Collapsible，DOM 数万级、打开即卡。
 *
 * 契约：首屏只挂一批（FILE_TREE_RENDER_BATCH = 200），滚动到列表底部再追加一批；
 * 因此 1200 个根文件打开抽屉后挂载行数必须显著小于总数，滚动后最多再多一批。
 * 这个断言防的是「有人把 useLazyListWindow 去掉、退回全量 map」。
 */
const ROOT_FILE_COUNT = 1200;
/** 与 utils/fileTreeRenderBudget.ts 的 FILE_TREE_RENDER_BATCH 一致；单独写死是为了让本测试在
 *  实现常量被悄悄改大时也能失败（契约测试不读实现常量）。 */
const RENDER_BATCH = 200;
/** 两批 + 余量的 DOM 上限（追加由 IntersectionObserver 触发，可能有竞态多挂一批）。 */
const MOUNTED_ROW_BUDGET = RENDER_BATCH * 3;

const seedProject = makeSeedProject("FileTreeDomBudget");
test.use({ seedProjects: [seedProject] });

for (let index = 0; index < ROOT_FILE_COUNT; index += 1) {
	writeFileSync(join(seedProject.path, `bulk-${String(index).padStart(4, "0")}.ts`), `export const v${index} = ${index};\n`);
}

test("file tree mounts root rows in batches instead of all at once", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 侧栏默认停在「聊天」分段，工作区项目行在「项目」分段下
	await window.getByRole("tab", { name: "项目" }).click();
	const projectItem = window.locator(".conversation", { hasText: "FileTreeDomBudget" }).first();
	await expect(projectItem).toBeVisible({ timeout: 20_000 });
	await projectItem.click();
	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true", { timeout: 5000 });

	const panel = window.locator(".files-panel");
	const rows = panel.locator(".file-node-row");
	await expect(rows.first()).toBeVisible({ timeout: 15_000 });

	// 首屏窗口封顶：1200 个根文件不应一次全部挂进 DOM。
	const initialCount = await rows.count();
	expect(initialCount).toBeLessThanOrEqual(RENDER_BATCH + 60);
	expect(initialCount).toBeLessThan(ROOT_FILE_COUNT / 2);
	expect(initialCount).toBeGreaterThan(0);

	// 滚动到底触发哨兵追加：行数增加，但仍受「每批 200」约束（不是全量）。
	await panel.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect.poll(async () => rows.count(), { timeout: 10_000 }).toBeGreaterThan(initialCount);
	const grownCount = await rows.count();
	expect(grownCount).toBeLessThanOrEqual(MOUNTED_ROW_BUDGET);
	expect(grownCount).toBeLessThan(ROOT_FILE_COUNT);
});
