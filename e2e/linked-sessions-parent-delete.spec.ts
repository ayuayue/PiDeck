import { expect, test } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";
import type { Locator, Page } from "@playwright/test";

/**
 * 关联会话（子对话）父会话被删除后的收尾。
 *
 * 现场（用户反馈）：删掉父会话后，它开出的关联子会话「自己并列在左侧」，右键删除毫无反应、
 * 「关闭 Agent」只回「会话已不存在，请刷新会话列表」，而刷新也消不掉。
 *
 * 根因不在关联会话本身，而在**删除入口的收敛契约**：`releaseRuntimeForDelete` 只解绑主进程
 * 自己的绑定、不推 detach。侧栏删除会自己清渲染层状态所以看不出来，Web API / 自动化 / 扫描
 * 清理这些入口却会留下一行「运行时还在、catalog 记录已无」：
 *   - 删除项按 `sessionsByProject` 解析记录 → 查不到 → 整段静默跳过（点了没反应）；
 *   - 关闭 Agent → `resolveStopTarget` → `catalog.get` 为空 → SESSION_NOT_FOUND（让用户刷新）。
 *
 * 所以这里**按非侧栏入口删除**（直接调与 Web API 同一个 `sessions:catalog-delete` IPC），
 * 断言渲染层不留幽灵行、子会话回到顶层后仍能删 / 能关。
 */

process.env.PIDECK_MOCK_SESSION_PER_DECK = "1";

const seedProject = makeSeedProject("LinkedParentDelete");
test.use({ seedProjects: [seedProject], seedSettings: { standbyRuntimeEnabled: false } });

type LinkedSnapshot = { links: Array<{ childSessionId: string; parentSessionId: string }> };

const linkedSnapshot = (window: Page): Promise<LinkedSnapshot> => window.evaluate(async () => (await window.piDesktop.linkedSessions.snapshot()) as LinkedSnapshot);

const catalogRecordIds = (window: Page): Promise<string[]> => window.evaluate(async (projectId) => (await window.piDesktop.sessions.listCatalog(projectId, { scan: false })).map((record) => record.id), seedProject.id);

const runtimeSessionIds = (window: Page): Promise<string[]> =>
	window.evaluate(async () => {
		const runtimes = await window.piDesktop.sessions.listRuntimes();
		return runtimes.map((runtime) => runtime.sessionId);
	});

/** 侧栏里还画着、但 catalog 已经没有的行 —— 幽灵行的判据。 */
const ghostRowIds = (window: Page): Promise<string[]> =>
	window.evaluate(async (projectId) => {
		const recordIds = new Set((await window.piDesktop.sessions.listCatalog(projectId, { scan: false })).map((record) => record.id));
		return [...document.querySelectorAll("[data-sidebar-removal-id]")].map((node) => node.getAttribute("data-sidebar-removal-id") ?? "").filter((id) => id && id !== projectId && !recordIds.has(id));
	}, seedProject.id);

/** 与 Web API / 自动化同一个入口：只调 IPC，不经过侧栏的本地清理。 */
const deleteRecordViaIpc = (window: Page, sessionId: string): Promise<boolean> => window.evaluate(async (id) => await window.piDesktop.sessions.deleteRecord(id), sessionId);

const draftText = (composer: Locator): Promise<string> => composer.evaluate((el) => el.textContent ?? "");

async function send(window: Page, composer: Locator, text: string): Promise<void> {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
		await composer.click();
		await window.keyboard.press("Control+a");
		await window.keyboard.press("Delete");
		await window.keyboard.insertText(text);
		if ((await draftText(composer)) !== text) continue;
		await window.keyboard.press("Enter");
		try {
			await expect(composer).toHaveText("", { timeout: 5_000 });
			return;
		} catch {
			// 冷启动抢焦点：草稿仍在，重试不会重复发送
		}
	}
	throw new Error(`未能发送：${text}`);
}

/** 行一律按真实 id 定位：关联子会话的标题里可能包含父会话标题，按文字匹配会命中两行。 */
const rowById = (window: Page, sessionId: string) =>
	window
		.locator(`[data-sidebar-removal-id="${sessionId}"]`)
		.first()
		// 外层包装同时包住「行 + 子项区块」：右键要落在真正的行按钮上才走得通 onContextMenu。
		.locator(".session-row")
		.first();

async function setupLinkedChild(window: Page): Promise<{ parentId: string; childId: string }> {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 选中预置项目再开会话：否则「新建会话」落在内置 Chat 项目里，catalog 断言就查错了项目。
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	await window.locator(".conversation", { hasText: seedProject.name }).first().click();
	await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
	await send(window, window.locator(".composer .rich-input"), "LINKED_START user_asked 帮我补登录页单测");

	let pair: { parentId: string; childId: string } | undefined;
	await expect
		.poll(
			async () => {
				const [snapshot, records] = await Promise.all([linkedSnapshot(window), catalogRecordIds(window)]);
				const link = snapshot.links[0];
				if (!link || !records.includes(link.childSessionId) || !records.includes(link.parentSessionId)) return false;
				pair = { parentId: link.parentSessionId, childId: link.childSessionId };
				return true;
			},
			{ timeout: 60_000 },
		)
		.toBe(true);
	if (!pair) throw new Error("linked pair not found");
	return pair;
}

test("非侧栏入口删掉父会话后，侧栏不留删不掉的幽灵行，子会话回到顶层仍可删除", async ({ window }) => {
	test.setTimeout(180_000);
	const { parentId, childId } = await setupLinkedChild(window);
	// 前置：父会话有活运行时（子会话的进程是它首条消息之后才起的，这里只等父的那一个）。
	await expect.poll(async () => (await runtimeSessionIds(window)).includes(parentId), { timeout: 30_000 }).toBe(true);

	expect(await deleteRecordViaIpc(window, parentId)).toBe(true);
	await expect(rowById(window, parentId)).toHaveCount(0, { timeout: 20_000 });
	expect(await catalogRecordIds(window)).not.toContain(parentId);

	// 关键回归：父会话的运行态必须跟着 catalog 一起消失（否则它作为幽灵行留在侧栏，
	// 删除项解析不到记录 → 点了没反应；关闭 Agent → 会话已不存在 + 让用户刷新）。
	expect(await ghostRowIds(window)).toEqual([]);

	// 设计语义：父会话没了，子会话回到顶层普通行，仍然可以正常删除。
	const childRow = rowById(window, childId);
	await expect(childRow).toBeVisible({ timeout: 20_000 });
	await childRow.click({ button: "right" });
	const deleteItem = window.getByRole("menuitem", { name: "删除", exact: true });
	await expect(deleteItem).toBeVisible({ timeout: 10_000 });
	await deleteItem.click();

	await expect(rowById(window, childId)).toHaveCount(0, { timeout: 20_000 });
	const remaining = await catalogRecordIds(window);
	expect(remaining).not.toContain(childId);
	expect(await ghostRowIds(window)).toEqual([]);
});

test("非侧栏入口删掉父会话后，子会话的「关闭 Agent」不报会话不存在", async ({ window }) => {
	test.setTimeout(180_000);
	const { parentId, childId } = await setupLinkedChild(window);

	expect(await deleteRecordViaIpc(window, parentId)).toBe(true);
	await expect(rowById(window, parentId)).toHaveCount(0, { timeout: 20_000 });

	const childRow = rowById(window, childId);
	await expect(childRow).toBeVisible({ timeout: 20_000 });
	await childRow.click({ button: "right" });
	const closeAgent = window.getByRole("menuitem", { name: "关闭 Agent", exact: true });
	await expect(closeAgent).toBeVisible({ timeout: 10_000 });
	await closeAgent.click();

	// 关闭要么真的停掉进程，要么明确告知「运行实例已不在」；不能甩「会话已不存在，请刷新」。
	await expect(window.getByText(/会话已不存在/)).toHaveCount(0);
	await expect.poll(async () => (await runtimeSessionIds(window)).filter((id) => id === childId), { timeout: 45_000 }).toEqual([]);
	expect(await catalogRecordIds(window)).toContain(childId);
	expect(await ghostRowIds(window)).toEqual([]);
});
