import { test, expect } from "./mock-pi-fixture";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectDir = mkdtempSync(join(tmpdir(), "pideck-seed-guide-ghost-"));

const PROJECT_NAME = "GuideGhostE2E";

test.use({
	seedProjects: [{ id: "e2e-guide-ghost", name: PROJECT_NAME, path: projectDir }],
});

test("first send from the project empty state leaves exactly one named tab", async ({ window }) => {
	test.setTimeout(150_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("tab", { name: "项目" }).click();
	await window.getByText(PROJECT_NAME, { exact: true }).first().click();

	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await expect(window.locator('.session-tabs-bar [role="tab"]')).toHaveCount(0, { timeout: 10_000 });

	await composer.click();
	await window.keyboard.type("引导页首发");
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText("Mock 回复：「引导页首发」", { timeout: 20_000 });

	const tabs = window.locator('.session-tabs-bar [role="tab"]');
	await expect(tabs).toHaveCount(1, { timeout: 10_000 });
	await expect(window.locator('.session-tabs-bar [role="tab"]', { hasText: "未命名" })).toHaveCount(0);
});

/**
 * issue #481：没有会话标签时点 Tab 栏「+」新建会话，一次点击会派发两次 onSelect
 * （菜单项在 pointerdown/pointerup 之间被 App 重渲染），于是建出两条会话：一条被选中、
 * 另一条留在 Tab 栏里没有任何内容。菜单打开一次只认一个目标即可根治。
 */
test("one click on the new-session menu creates exactly one tab", async ({ window }) => {
	test.setTimeout(150_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("tab", { name: "项目" }).click();
	await window.getByText(PROJECT_NAME, { exact: true }).first().click();
	await expect(window.locator(".composer .rich-input")).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await expect(window.locator('.session-tabs-bar [role="tab"]')).toHaveCount(0, { timeout: 10_000 });

	const tabs = window.locator('.session-tabs-bar [role="tab"]');
	await window.locator(".session-tabs-new").click();
	await window
		.getByRole("menuitem", { name: new RegExp(PROJECT_NAME) })
		.first()
		.click();
	await expect(tabs).toHaveCount(1, { timeout: 15_000 });
	await expect(window.locator('.session-tabs-bar [role="tab"]', { hasText: "未命名" })).toHaveCount(0);

	// 闸门只作用于「一次打开」：再次打开菜单仍要能新建第二条会话。
	// 稍等：Radix 关闭下拉后短暂把 body 设为 pointer-events:none，立刻点击会被吞掉（框架行为，非本用例缺陷）。
	await window.waitForTimeout(500);
	await window.locator(".session-tabs-new").click();
	await window
		.getByRole("menuitem", { name: new RegExp(PROJECT_NAME) })
		.first()
		.click();
	await expect(tabs).toHaveCount(2, { timeout: 15_000 });
});
