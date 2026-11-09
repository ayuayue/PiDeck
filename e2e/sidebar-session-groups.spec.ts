import { expect, test } from "./mock-pi-fixture";
import { makeSeedProject, seedProjectsOption } from "./open-session";
import type { Page } from "@playwright/test";
import { resolve } from "node:path";

/**
 * 会话分组侧栏（三点改造的端到端验收）：
 * 1. 分组下面直接是会话（不再有「分组 → 项目文件夹 → 会话」三层）；
 * 2. 已入组的会话不再在下方项目列表里重复出现（并给出「会话都在分组里」提示）；
 * 3. 分组里的会话行右键复用项目树的会话菜单（重命名/置顶…）。
 *
 * 分组数据在宿主 store（<userData>/session-groups.json），写入方是会话分组插件页；
 * 这里用插件页同一条 `sessionGroups.save` IPC 建立分组（不驱动插件页拖拽 UI），
 * 插件包本身由 fixture 的 seedHostPlugins 落位 + 精确指纹授权。
 * 注意：扫描出来的会话 id 由主进程分配，无法在启动前预知，所以分组只能在拿到
 * catalog 之后建立 —— 这也顺带验证了 useSessionGroups 的 onChanged 实时刷新。
 */

const alpha = makeSeedProject("grp-alpha");
const beta = makeSeedProject("grp-beta");
const ALPHA_TITLE = "分组里的阿尔法会话";
const BETA_TITLE = "分组里的贝塔会话";
const GROUP_NAME = "专注组";

function sessionEntries(id: string, title: string, cwd: string, timestamp: string): unknown[] {
	return [
		{ type: "session", version: 3, id, parentId: null, name: title, cwd, timestamp },
		{ type: "message", id: `${id}-u`, parentId: id, message: { role: "user", content: [{ type: "text", text: title }] }, timestamp },
	];
}

test.use({
	seedProjects: seedProjectsOption([alpha, beta]),
	seedSessionFiles: async ({}, use) =>
		use([
			{ projectPath: alpha.path, fileName: "grp-alpha.jsonl", entries: sessionEntries("e2e-grp-alpha", ALPHA_TITLE, alpha.path, "2026-01-02T00:00:00Z") },
			{ projectPath: beta.path, fileName: "grp-beta.jsonl", entries: sessionEntries("e2e-grp-beta", BETA_TITLE, beta.path, "2026-01-02T00:00:01Z") },
		]),
	seedHostPlugins: async ({}, use) => use([{ id: "session-groups", source: resolve(__dirname, "../docs/examples/host-plugins/session-groups") }]),
});

/** 渲染层能用的宿主 API 子集（preload 暴露的 window.piDesktop）。 */
type GroupBridge = {
	sessions: { listCatalog: (projectId: string, options?: { scan?: boolean }) => Promise<Array<{ id: string }>> };
	sessionGroups: { save: (input: unknown) => Promise<unknown> };
};

/** 插件页同一入口：读两个项目的 catalog（含扫描）→ 拿真实会话 id → 建一个跨项目分组。 */
async function createCrossProjectGroup(window: Page): Promise<void> {
	await window.evaluate(
		async ({ alphaId, betaId, groupName }) => {
			const api = (globalThis as unknown as { piDesktop: GroupBridge }).piDesktop;
			const [alphaSessions, betaSessions] = await Promise.all([api.sessions.listCatalog(alphaId, { scan: true }), api.sessions.listCatalog(betaId, { scan: true })]);
			if (alphaSessions.length !== 1 || betaSessions.length !== 1) throw new Error(`unexpected catalog sizes: ${alphaSessions.length}/${betaSessions.length}`);
			await api.sessionGroups.save({ id: "e2e-group-focus", name: groupName, color: "purple", sessionIds: [alphaSessions[0].id, betaSessions[0].id] });
		},
		{ alphaId: alpha.id, betaId: beta.id, groupName: GROUP_NAME },
	);
}

test("分组区是两层、项目列表不重复、分组会话可右键", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();

	// 前置：两个项目各有 1 条历史会话，展开项目时先按普通会话渲染（证明种子会话真实存在）。
	for (const project of [alpha, beta]) {
		await window.locator(`[data-project-row-id="${project.id}"]`).locator("strong", { hasText: project.name }).click();
	}
	await expect(window.locator(".history-session-row", { hasText: ALPHA_TITLE })).toBeVisible({ timeout: 20_000 });
	await expect(window.locator(".history-session-row", { hasText: BETA_TITLE })).toBeVisible({ timeout: 20_000 });

	// 分组由插件侧写入，侧栏经 onChanged 实时收到；分组区内应是「分组 → 会话」两层。
	await createCrossProjectGroup(window);
	const groups = window.locator('section[aria-label="分组"]');
	await expect(groups.getByRole("button", { name: new RegExp(GROUP_NAME) })).toBeVisible({ timeout: 20_000 });
	const groupList = groups.locator("div.ml-3").first();
	await expect(groupList.locator(".group\\/row")).toHaveCount(2, { timeout: 20_000 });
	// 行内没有中间的文件夹层：会话行直接挂着标题（多项目分组才附项目名标签）。
	await expect(groupList.getByText(ALPHA_TITLE)).toHaveCount(1);
	await expect(groupList.getByText(BETA_TITLE)).toHaveCount(1);
	await expect(groupList.getByText(alpha.name)).toHaveCount(1);
	await expect(groupList.getByText(beta.name)).toHaveCount(1);

	// 项目列表不再重复显示已入组会话，只留「会话都在分组里」提示。
	await expect(window.getByTestId("sessions-in-groups-only")).toHaveCount(2, { timeout: 20_000 });
	await expect(window.locator(".history-session-row", { hasText: ALPHA_TITLE })).toHaveCount(0);
	await expect(window.locator(".history-session-row", { hasText: BETA_TITLE })).toHaveCount(0);

	// 分组会话行右键 = 项目树同一条会话菜单（不是空菜单，也不是浏览器默认菜单）。
	await groupList.locator(".group\\/row").filter({ hasText: ALPHA_TITLE }).locator("button").first().click({ button: "right" });
	await expect(window.getByRole("menuitem", { name: "重命名", exact: true })).toBeVisible();
	await expect(window.getByRole("menuitem", { name: "置顶会话", exact: true })).toBeVisible();
});

test("分组只出现在对应栏目：活动不挂分组、项目分组不进聊天栏目", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();

	// 先展开两个项目：catalog 未加载的项目不参与扫描，建组需要真实会话 id。
	for (const project of [alpha, beta]) {
		await window.locator(`[data-project-row-id="${project.id}"]`).locator("strong", { hasText: project.name }).click();
	}
	await expect(window.locator(".history-session-row", { hasText: ALPHA_TITLE })).toBeVisible({ timeout: 20_000 });
	await expect(window.locator(".history-session-row", { hasText: BETA_TITLE })).toBeVisible({ timeout: 20_000 });

	// 建一个只含工作区项目会话的分组（聊天项目在本用例里没有会话）。
	await createCrossProjectGroup(window);
	const groups = window.locator('section[aria-label="分组"]');
	await expect(groups).toHaveCount(1, { timeout: 20_000 });
	await expect(groups.getByRole("button", { name: new RegExp(GROUP_NAME) })).toBeVisible();

	// 活动栏目：不挂分组（活动 / 最近会话本来就是跨项目的实时视图）。
	await window.getByRole("tab", { name: "活动", exact: true }).click();
	await expect(groups).toHaveCount(0);

	// 聊天栏目：分组里全是工作区项目的会话，按栏目裁剪后整组不出现在这里。
	await window.getByRole("tab", { name: "聊天", exact: true }).click();
	await expect(groups).toHaveCount(0);

	// 回到项目栏目：分组仍在（范围裁剪只影响别的栏目，不删数据）。
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	await expect(groups).toHaveCount(1);
});
