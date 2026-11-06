import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import { makeSeedProject } from "./open-session";

/**
 * 待办条「条目很多时展开一片空白」回归（2026-11）。
 *
 * 根因：行数 > VIRTUAL_STACK_MIN_ROWS(16) 时待办行走 VirtualStack 虚拟化。展开动作让
 * CollapsibleContent 整棵子树**首次挂载**，而 React 的 layout 阶段是先跑子组件 layout effect、
 * 后 attach 父 host 元素的 ref —— VirtualStack 第一次 virtual-core._willUpdate() 读到
 * `getScrollElement() === null`，与内部 scrollElement(null) 相同即跳过订阅与 notify，此后
 * 没有再渲染的机会：列表一行都不挂载（180px 高的空白窗），必须等外部状态变化把它重渲染
 * 一次才出现 → 用户观感「点开要白屏加载好一会」。
 *
 * 断言：展开后 2s 内必须出现行（修复前恒为 0 行），且只挂视口附近若干行（虚拟化仍生效），
 * 滚到底后末条待办可见（滚动订阅确实建立了）。
 */
const TODO_COUNT = 30;
const seedProject = makeSeedProject("todo-strip-many-seed");

const todos = Array.from({ length: TODO_COUNT }, (_, index) => ({
	id: index + 1,
	text: `待办条目 ${index + 1}`,
	status: index === TODO_COUNT - 1 ? "in_progress" : index < 3 ? "completed" : "pending",
}));

test.use({
	seedProjects: [seedProject],
	seedSessionFiles: [
		{
			projectPath: seedProject.path,
			entries: [
				{
					type: "session",
					version: 3,
					id: "e1",
					parentId: null,
					name: "大列表待办",
					cwd: seedProject.path,
					timestamp: new Date(Date.now() - 60_000).toISOString(),
				},
				{
					type: "message",
					id: "e2",
					parentId: "e1",
					timestamp: new Date(Date.now() - 59_000).toISOString(),
					message: { role: "user", content: [{ type: "text", text: "前置轮" }] },
				},
				{
					type: "message",
					id: "e3",
					parentId: "e2",
					timestamp: new Date(Date.now() - 58_000).toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "前置轮回复，让会话进入有内容的常规态。" }] },
				},
				// 历史会话（未启动 agent）走 sessions:list-session-todo 快照路径。
				{
					type: "custom",
					id: "e4",
					parentId: "e3",
					timestamp: new Date(Date.now() - 57_000).toISOString(),
					customType: "pi-deck-todo",
					data: { version: 3, activePlan: { id: 1, todos } },
				},
			],
		},
	],
});

async function openSeededSession(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目" }).click();
	const projectRow = window.locator(".conversation", { hasText: "todo-strip-many-seed" }).first();
	await expect(projectRow).toBeVisible({ timeout: 30_000 });
	await projectRow.click();
	const historyRow = window.locator(".conversation", { hasText: "大列表待办" }).first();
	await expect(historyRow).toBeVisible({ timeout: 15_000 });
	await historyRow.click();
}

test("条目超过虚拟化阈值时展开立即挂载视口内的行，且仍按虚拟化渲染", async ({ window }) => {
	test.setTimeout(120_000);
	await openSeededSession(window);

	const strip = window.locator('[data-testid="session-todo-strip"]');
	await expect(strip).toBeVisible({ timeout: 30_000 });

	const rows = strip.locator('[role="listitem"]');
	await strip.locator("button[aria-expanded]").click();

	// 修复前：展开后行数恒为 0，只能靠外部重渲染救回（2s 内等不到）。
	await expect.poll(async () => rows.count(), { timeout: 2_000, message: "展开后虚拟化列表必须立刻有行（不等于 0）" }).toBeGreaterThan(0);
	expect(await rows.count()).toBeLessThan(TODO_COUNT); // 虚拟化生效：不是全量渲染

	// 首行与内容盒高度：容器有高度、行有 translateY 定位。
	await expect(rows.first()).toContainText("待办条目 1");
	const stackHeight = await strip.locator("[data-virtual-stack]").evaluate((el) => Number.parseFloat((el as HTMLElement).style.height));
	expect(stackHeight).toBeGreaterThan(0);

	// 滚动订阅确实建立：滚到底后末条待办被拉进视口。
	await strip.locator('[role="list"]').evaluate((el) => {
		el.scrollTop = el.scrollHeight;
	});
	await expect(rows.filter({ hasText: `待办条目 ${TODO_COUNT}` })).toBeVisible({ timeout: 5_000 });
});
