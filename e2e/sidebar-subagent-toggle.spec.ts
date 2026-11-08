import { join } from "node:path";
import { expect, test } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

const project = makeSeedProject("subagent-toggle");
const parentPath = join(project.path, ".pi", "sessions", "parent.jsonl");
const parentTitle = "主会话：检查侧栏折叠";
const now = new Date().toISOString();

test.use({
	seedProjects: [project],
	seedSessionFiles: async ({}, use) =>
		use([
			{
				projectPath: project.path,
				fileName: "parent.jsonl",
				entries: [
					{ type: "session", version: 3, id: "parent-toggle", parentId: null, name: parentTitle, cwd: project.path, timestamp: now },
					{ type: "message", id: "parent-user", parentId: "parent-toggle", message: { role: "user", content: [{ type: "text", text: "检查折叠" }] }, timestamp: now },
				],
			},
			{
				projectPath: project.path,
				fileName: "child.jsonl",
				entries: [
					{ type: "session", version: 3, id: "child-toggle", parentId: null, parentSession: parentPath, cwd: project.path, timestamp: now },
					{ type: "session_info", id: "child-title", parentId: "child-toggle", name: "Explore#a1b2c3d4", timestamp: now },
					{ type: "message", id: "child-user", parentId: "child-title", message: { role: "user", content: [{ type: "text", text: "子会话" }] }, timestamp: now },
				],
			},
		]),
});

test("侧栏子会话折叠按钮可键盘操作且不嵌套在会话按钮内", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目", exact: true }).click();
	await window.locator(`[data-project-row-id="${project.id}"]`).locator("strong", { hasText: project.name }).click();

	const parentRow = window.locator(".session-toggle-row", { hasText: parentTitle });
	const sessionButton = parentRow.locator(".history-session-row");
	const toggle = parentRow.getByRole("button", { name: "子会话 1 个" });
	await expect(toggle).toBeVisible({ timeout: 20_000 });
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(sessionButton.locator("button")).toHaveCount(0);

	// 隐形布局占位与真实按钮几何重合，确保鼠标命中区域没有从原来的行尾漂移。
	const alignment = await parentRow.evaluate((row) => {
		const slot = row.querySelector(".subagent-toggle-slot")?.getBoundingClientRect();
		const button = row.querySelector(".subagent-toggle-button")?.getBoundingClientRect();
		if (!slot || !button) return null;
		return { dx: Math.abs(slot.left - button.left), dy: Math.abs(slot.top - button.top), width: button.width, height: button.height };
	});
	expect(alignment).not.toBeNull();
	expect(alignment!.dx).toBeLessThan(2);
	expect(alignment!.dy).toBeLessThan(2);
	expect(alignment!.width).toBeGreaterThan(16);
	expect(alignment!.height).toBeGreaterThan(16);

	await sessionButton.focus();
	await sessionButton.press("Tab");
	await expect(toggle).toBeFocused();
	await toggle.press("Enter");
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(window.locator(".codex-subagent-sidebar-group", { hasText: "Explore" })).toBeVisible();
	const hitTest = await parentRow.evaluate((row) => {
		const button = row.querySelector<HTMLButtonElement>(".subagent-toggle-button");
		const more = row.querySelector<HTMLElement>(".row-more-actions");
		if (!button || !more) return null;
		const rect = button.getBoundingClientRect();
		return {
			clickable: button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)),
			gapToMore: more.getBoundingClientRect().left - rect.right,
		};
	});
	expect(hitTest?.clickable).toBe(true);
	expect(hitTest?.gapToMore).toBeGreaterThanOrEqual(0);
	await toggle.press("Space");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
});
