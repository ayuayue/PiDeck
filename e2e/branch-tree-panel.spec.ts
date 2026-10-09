import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

/**
 * 右侧抽屉「分支」面板（pi /tree 的桌面只读版）UI 回归：
 * 用户反馈「太丑 + 深度太深看不到 + X 关不掉」，此用例锁定三条修正：
 * 1. 缩进只在分支点增长（线性链同深，不把内容推出可视区）；
 * 2. 连续助手步骤折叠成一段，点「N 步」一次展开整段；
 * 3. 活动栏 X 对已打开的面板是「关闭」而不只是取消常驻。
 *
 * 树形（JSONL 追加序）：session → u1 → a1 → { u2b（被放弃）, u2 → a2 → u3 → a3 → a4 } → c1(compaction, 活动叶)
 */

const seedProject = makeSeedProject("BranchTree");

const message = (id: string, parentId: string, role: string, text: string) => ({ id, parentId, type: "message", message: { role, content: [{ type: "text", text }] } });

const entries: unknown[] = [
	{ id: "session", type: "session" },
	message("u1", "session", "user", "帮我看看更新链路为什么失败"),
	message("a1", "u1", "assistant", "先看日志：这里是失败的调用栈"),
	message("u2b", "a1", "user", "被放弃的另一种问法"),
	message("u2", "a1", "user", "第二种问法：bun 安装的更新不了"),
	message("a2", "u2", "assistant", "第二个回答"),
	message("u3", "a2", "user", "继续"),
	message("a3", "u3", "assistant", "第三回答上半段"),
	message("a4", "a3", "assistant", "第三回答下半段"),
	{ id: "c1", parentId: "a4", type: "compaction", summary: "压缩摘要" },
];

test.use({ seedProjects: [seedProject], seedSessionFiles: [{ projectPath: seedProject.path, entries }] });

/** 打开种子项目里的历史会话（点侧栏会话行；历史会话不 spawn agent）。 */
async function openSeededSession(window: import("@playwright/test").Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const sessionRow = window.locator(".conversation", { hasText: "更新链路" }).first();
	await expect(sessionRow).toBeVisible({ timeout: 30_000 });
	await sessionRow.click();
	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer").first()).toHaveAttribute("data-open", "true", { timeout: 5000 });
}

/** 用活动栏「+」把分支面板加进常驻并打开。 */
async function openBranchPanel(window: import("@playwright/test").Page) {
	await window.getByRole("button", { name: "添加常驻面板" }).click();
	await window.getByRole("menuitemcheckbox", { name: "分支" }).click();
	await expect(window.getByTestId("drawer-rail-branchTree")).toHaveAttribute("aria-selected", "true", { timeout: 5000 });
}

test("branch panel folds assistant steps, indents only at branch points and closes via rail X", async ({ window }) => {
	await openSeededSession(window);
	await openBranchPanel(window);

	const rows = window.locator("[data-branch-row]");
	// 8 行：u1 / a1 / u2b / u2 / a2 / u3 / a3(折叠 1 步) / c1；a3+a4 合成一行
	await expect(rows).toHaveCount(8);
	const ids = await rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-branch-row")));
	expect(ids).toEqual(["u1", "a1", "u2b", "u2", "a2", "u3", "a3", "c1"]);

	// 折叠段：a3 行显示「1 步」，标签取段末内容（a4 的预览）
	const foldedRow = window.locator('[data-branch-row="a3"]');
	await expect(foldedRow).toContainText("1 步");
	await expect(foldedRow).toContainText("第三回答下半段");

	// 缩进只在分支点增长：u1/a1 同深，a1 的两个孩子（u2b/u2）各退一级。
	// 行盒左侧不因缩进移动（缩进走 padding-left），所以量计算样式而不是 boundingBox.x。
	const padLeft = async (id: string) => await window.locator(`[data-branch-row="${id}"]`).evaluate((node) => Number.parseFloat(getComputedStyle(node).paddingLeft));
	const [u1Left, a1Left, u2bLeft, u2Left] = [await padLeft("u1"), await padLeft("a1"), await padLeft("u2b"), await padLeft("u2")];
	expect(a1Left).toBe(u1Left);
	expect(u2Left).toBe(u2bLeft);
	expect(u2Left - a1Left).toBeGreaterThanOrEqual(12);

	// 活动叶与压缩点各自的标记
	await expect(window.locator('[data-branch-row="c1"]')).toContainText("上下文压缩点");
	await expect(window.locator('[data-branch-row="c1"]')).toContainText("当前");

	// 点折叠段一次展开整段：a4 出现，a3 行不再是折叠态
	await foldedRow.getByRole("button", { name: "1 步" }).click();
	await expect(window.locator('[data-branch-row="a4"]')).toHaveCount(1);
	await expect(rows).toHaveCount(9);

	// 「收起全部」把整树收回锚点行
	await window.getByRole("button", { name: "收起全部" }).click();
	await expect(window.locator('[data-branch-row="a4"]')).toHaveCount(0);
	await expect(foldedRow).toContainText("1 步");

	// 视觉留档：评审抽屉内分支树排版
	await window.screenshot({ path: "test-results/branch-tree-panel.png" });

	// X 关掉当前打开的分支面板（不只是取消常驻）
	const railTab = window.getByTestId("drawer-rail-branchTree");
	await window.locator('div.group:has([data-testid="drawer-rail-branchTree"]) .drawer-rail-remove').first().click();
	await expect(window.locator(".detail-drawer").first()).toHaveAttribute("data-open", "false", { timeout: 5000 });
	await expect(railTab).toHaveCount(0);
});
