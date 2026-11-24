import { expect, test } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";
import type { Page } from "@playwright/test";

/**
 * 关联子会话（子对话）不能同时出现在两处。
 *
 * 现场（用户反馈）：父会话下面嵌套显示一个子会话，父会话同级又并列显示一个。
 *
 * 根因是「同一份物理会话被挂上两个会话 ID」：
 *   1. 开子会话先有草稿 ID，首条 prompt 后 pi 建出会话文件，catalog 按 `originKey` 把草稿条目
 *      归并吸收进带文件的那条，旧 ID 进 `mergedSessionIds`；
 *   2. 主进程的绑定表仍以旧 ID 为键（归并发生在绑定之后），于是运行时快照 / 事件流里同时存在
 *      旧 ID 与存活 ID，两者指向同一个会话文件；
 *   3. 渲染层按「运行时表的 key」一行来画 → 同一会话被画成两行。
 * 池化认领（standby）会放大这个窗口：认领把草稿 ID 绑到预热进程上，随后才归并。
 *
 * 覆盖点（两种 standby 模式都要过）：
 * - `sessions:runtime-list` 不报错、会话 ID 不重复（旧实现整个快照会抛 SESSION_RUNTIME_CHANGED）；
 * - 渲染层运行时表里不留「catalog 已归并的旧 ID」；
 * - 活动页同一子会话只有一行；项目页同一会话行不重复出现。
 */

process.env.PIDECK_MOCK_SESSION_PER_DECK = "1";

const activityRows = (window: Page): Promise<Array<{ id: string; text: string }>> =>
	window.evaluate(() => [...document.querySelectorAll(".active-sessions-list [data-sidebar-removal-id]")].map((node) => ({ id: node.getAttribute("data-sidebar-removal-id") ?? "", text: (node.textContent ?? "").replace(/\s+/g, " ").slice(0, 24) })));

const projectRows = (window: Page): Promise<Array<{ id: string; text: string }>> =>
	window.evaluate(() => [...document.querySelectorAll(".history-session-row")].map((node) => ({ id: node.closest("[data-sidebar-removal-id]")?.getAttribute("data-sidebar-removal-id") ?? "", text: (node.textContent ?? "").replace(/\s+/g, " ").slice(0, 24) })));

for (const standby of [true, false] as const) {
	const seedProject = makeSeedProject(`LinkedDedup${standby ? "Standby" : "Direct"}`);
	test.describe(`standbyRuntimeEnabled=${standby}`, () => {
		test.use({ seedProjects: [seedProject], seedSettings: { standbyRuntimeEnabled: standby } });

		test("关联子会话不重复出现在两处", async ({ window }) => {
			test.setTimeout(300_000);
			await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
			await window.getByRole("tab", { name: "项目", exact: true }).click();
			await window.locator(".conversation", { hasText: seedProject.name }).first().click();
			await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
			const composer = window.locator(".composer .rich-input");
			await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
			await composer.click();
			await window.keyboard.insertText("LINKED_START user_asked 补登录页单测");
			await window.keyboard.press("Enter");
			await window.waitForTimeout(15_000);

			const link = await window.evaluate(async () => (await window.piDesktop.linkedSessions.snapshot()).links[0]);
			expect(link, "前置：关联关系已建立").toBeTruthy();

			// ① 运行时快照：必须能拿到，且同一会话只出现一次。
			// （修复前这条会整个抛 SESSION_RUNTIME_CHANGED，渲染层只能靠事件流累积。）
			const runtimes = await window.evaluate(async () => {
				try {
					return { ok: true as const, value: await window.piDesktop.sessions.listRuntimes() };
				} catch (error) {
					return { ok: false as const, error: String(error) };
				}
			});
			expect(runtimes.ok, runtimes.ok ? "" : `运行时快照失败：${runtimes.error}`).toBe(true);
			if (runtimes.ok) {
				const ids = runtimes.value.map((runtime) => runtime.sessionId);
				expect(new Set(ids).size, "运行时快照里会话 ID 不得重复").toBe(ids.length);
			}

			// ② catalog 的别名表说明这份会话确实被归并过（旧 ID 进了 mergedSessionIds）——
			// 这正是重复行的温床：修复必须让存活 ID 成为唯一身份，而不是把两条都摆出来。
			const merged = await window.evaluate(async (projectId) => {
				const records = await window.piDesktop.sessions.listCatalog(projectId, { scan: false });
				return records.flatMap((record) => record.mergedSessionIds ?? []);
			}, seedProject.id);
			// 允许多轮归并累积（同源组会连续吸收），但每个别名都必须能解析回现存记录，不能自己占一行。
			const liveIds = await window.evaluate(async (projectId) => (await window.piDesktop.sessions.listCatalog(projectId, { scan: false })).map((record) => record.id), seedProject.id);
			for (const alias of merged) expect(liveIds, `旧 ID ${alias} 不应仍在 catalog 里单独成条`).not.toContain(alias);

			// ③ 活动页：同一个子会话只能一行（按标题判，标题唯一）。
			await window.getByRole("tab", { name: "活动", exact: true }).click();
			await window.waitForTimeout(1200);
			const active = await activityRows(window);
			expect(active.filter((row) => row.text.includes("补登录页单测")).length, `活动页子会话行数：${JSON.stringify(active)}`).toBe(1);

			// ④ 项目页：子会话要么挂在父行的折叠分组里（默认收起，顶层 0 行），要么顶层 1 行；
			//    无论哪种，同一会话 ID 都不得出现两次。
			await window.getByRole("tab", { name: "项目", exact: true }).click();
			await window.waitForTimeout(1200);
			const project = await projectRows(window);
			expect(project.filter((row) => row.text.includes("补登录页单测")).length, `项目页子会话行数：${JSON.stringify(project)}`).toBeLessThanOrEqual(1);
			const ids = project.map((row) => row.id).filter(Boolean);
			expect(new Set(ids).size, "项目页不得出现重复的会话行").toBe(ids.length);
		});
	});
}
