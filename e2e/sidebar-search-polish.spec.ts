import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject, seedProjectsOption } from "./open-session";

const projects = [makeSeedProject("search-alpha"), makeSeedProject("search-beta")];
const sessionTitle = "同名任务：修复消息列表过长时的布局与交互";

// 两个项目各有同名历史会话，搜索结果必须能在同一屏内辨认归属。
test.use({
	seedProjects: seedProjectsOption(projects),
	seedSessionFiles: async ({}, use) =>
		use(
			projects.map((project, index) => ({
				projectPath: project.path,
				fileName: `search-${index}.jsonl`,
				entries: [
					{ type: "session", version: 3, id: `search-${index}`, parentId: null, name: sessionTitle, cwd: project.path, timestamp: new Date().toISOString() },
					{ type: "message", id: `u${index}`, parentId: `search-${index}`, message: { role: "user", content: [{ type: "text", text: "检查会话列表" }] }, timestamp: new Date().toISOString() },
				],
			})),
		),
});

test("search distinguishes identically named sessions and restores visible focus", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// catalog 按需扫描；主动选择两个项目让会话都进入搜索索引。
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	for (const project of projects) {
		const projectRow = window.locator(`[data-project-row-id="${project.id}"]`).locator("button", { hasText: project.name });
		await projectRow.locator("strong", { hasText: project.name }).click();
		await expect(window.locator(".history-session-row", { hasText: sessionTitle }).first()).toBeVisible({ timeout: 20_000 });
	}

	const trigger = window.getByRole("button", { name: "搜索会话", exact: true }).first();
	await trigger.click();
	const dialog = window.getByRole("dialog", { name: "搜索会话" });
	await expect(dialog).toBeVisible();
	const input = dialog.getByRole("combobox", { name: "搜索会话" });
	await expect(input).toBeFocused();
	const results = dialog.getByRole("listbox", { name: "搜索结果" });
	await input.fill("同名任务");
	const rows = results.getByRole("option");
	await expect(rows).toHaveCount(2);
	const panel = dialog.locator('[role="listbox"]');
	const panelHeight = await panel.evaluate((element) => element.getBoundingClientRect().height);
	expect(panelHeight).toBeLessThan(180);
	for (const project of projects) {
		const row = rows.filter({ hasText: project.name });
		await expect(row).toHaveCount(1);
		await expect(row).toContainText(sessionTitle);
		await expect(row.getByTitle(project.path, { exact: true })).toHaveText(project.name);
		await expect(row.getByTitle(sessionTitle, { exact: true })).toHaveText(sessionTitle);
	}

	await input.press("Escape");
	await expect(dialog).toHaveCount(0);
	await expect(trigger).toBeFocused();
	await trigger.press("Enter");
	await expect(dialog.getByRole("combobox")).toHaveValue("");
	await window.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(trigger).toBeFocused();
});
