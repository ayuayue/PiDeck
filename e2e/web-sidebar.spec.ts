import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

/**
 * Web 侧栏抽屉（v0.11.3 UI 统一改造）的回归契约：
 * - 搜索框、项目行、会话行共用同一左缘与 36px 触屏行高，选中行圆角 10px；
 * - 搜索只保留有命中的项目（空项目不再占位），清除后完整恢复；
 * - 无结果时给统一的空态与「清除」出口。
 *
 * 文案用结构定位（aria-expanded / 组件类名），不依赖 zh/en 具体文案。
 */
const projectA = makeSeedProject("pideck-dev", "sidebar-a");
const projectB = makeSeedProject("proxy-bridge", "sidebar-b");
const projectC = makeSeedProject("mygo-demo", "sidebar-c");

test.use({
	seedProjects: async ({}, use) => use([projectA, projectB, projectC]),
	seedSettings: {
		webServiceEnabled: true,
		webServiceHost: "127.0.0.1",
		webServicePort: 8771,
		webServiceRequiresAuth: false,
	},
});

const BASE = "http://127.0.0.1:8771";

async function waitForHealthy() {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const health = await fetch(`${BASE}/api/health`).catch(() => null);
		if (health?.ok) return true;
	}
	return false;
}

test("web sidebar: unified rows and search only keeps matching projects", async ({ app }) => {
	test.setTimeout(120_000);
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 390, height: 844 });
	await page.goto(BASE);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("textarea#prompt")).toBeVisible();

	// 通过 Web API 造会话：A 两条命中、B 一条、C 故意留空
	const created = await page.evaluate(async () => {
		const state = await (await fetch("/api/state")).json();
		const projects = (state.projects ?? []).filter((p: { kind?: string }) => p.kind !== "chat");
		const seeds = [
			{ projectId: projects[0]?.id, title: "Alpha probe" },
			{ projectId: projects[0]?.id, title: "Alpha follow-up" },
			{ projectId: projects[1]?.id, title: "Beta note" },
		];
		let count = 0;
		for (const seed of seeds) {
			if (!seed.projectId) continue;
			const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: seed.projectId }) });
			const id = (await res.json())?.session?.id;
			if (!id) continue;
			await fetch(`/api/sessions/${encodeURIComponent(id)}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: seed.title }) });
			count += 1;
		}
		return count;
	});
	expect(created).toBe(3);
	await page.reload();
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });

	await page.locator(".mobile-sidebar-toggle").first().click();
	await expect(page.locator(".chat-list-pane")).toHaveClass(/mobile-open/);
	// 抽屉 180ms 滑入动画结束再量几何，否则会读到过渡中的偏移
	await expect.poll(async () => (await page.locator(".chat-list-pane").boundingBox())?.x ?? -1).toBe(0);

	// 展开全部项目（aria-expanded 是这轮新加的可判定状态）
	const projectRows = page.locator(".chat-list-pane .project-row > button");
	await expect(projectRows).toHaveCount(4);
	for (let i = 0; i < 4; i += 1) {
		const row = projectRows.nth(i);
		if ((await row.getAttribute("aria-expanded")) === "false") await row.click();
	}
	await expect(page.locator(".session-row")).toHaveCount(3);
	// 选中会话在窄屏会自动收起抽屉；重新打开后再量几何
	await page.locator(".session-row").first().click();
	await page.locator(".mobile-sidebar-toggle").first().click();
	await expect(page.locator(".chat-list-pane")).toHaveClass(/mobile-open/);
	await expect.poll(async () => (await page.locator(".chat-list-pane").boundingBox())?.x ?? -1).toBe(0);
	await expect(page.locator(".session-row.active")).toHaveCount(1);

	// 统一几何：搜索框/项目行/会话行同为 36px，项目行与搜索框左缘对齐，选中行圆角 10px
	const fieldBox = await page.locator(".search-box").boundingBox();
	const projectBox = await projectRows.first().boundingBox();
	const sessionBox = await page.locator(".session-row").first().boundingBox();
	expect(fieldBox?.height).toBe(36);
	expect(projectBox?.height).toBe(36);
	expect(sessionBox?.height).toBe(36);
	expect(Math.abs((projectBox?.x ?? 0) - (fieldBox?.x ?? 0))).toBeLessThanOrEqual(1);
	const activeRadius = await page.locator(".session-row.active").evaluate((el) => getComputedStyle(el).borderRadius);
	expect(activeRadius).toBe("10px");

	// 有命中：只保留 A 项目（聊天项目无命中也被过滤）
	const input = page.locator(".search-box input");
	await input.fill("Alpha");
	await expect(page.locator(".project-group")).toHaveCount(1);
	await expect(page.locator(".session-row")).toHaveCount(2);
	await expect(page.locator(".web-sidebar-no-results")).toBeHidden();

	// 清除钮恢复完整列表
	await page.locator(".search-box button").click();
	await expect(input).toHaveValue("");
	await expect(page.locator(".project-group")).toHaveCount(4);

	// 无命中：统一空态 + 清除出口
	await input.fill("zzz-no-such-session");
	await expect(page.locator(".web-sidebar-no-results")).toBeVisible();
	await expect(page.locator(".project-group")).toHaveCount(0);
	await page.locator(".web-sidebar-no-results button").click();
	await expect(input).toHaveValue("");
	await expect(page.locator(".project-group")).toHaveCount(4);
});
