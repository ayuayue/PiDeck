import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";

test.use({
	seedSettings: { webServiceEnabled: true, webServiceHost: "127.0.0.1", webServicePort: 8795, webServiceRequiresAuth: false },
});

const BASE = "http://127.0.0.1:8795";

async function waitForHealthy() {
	for (let i = 0; i < 40; i += 1) {
		const health = await fetch(`${BASE}/api/health`).catch(() => null);
		if (health?.ok) return true;
		await new Promise((r) => setTimeout(r, 500));
	}
	return false;
}

/**
 * 历史会话里发送消息的渲染稳定性（用户报障：从历史会话发消息后，刚发出的消息与回复
 * 都看不见，刷新才恢复）。
 *
 * 根因：活跃会话的历史快照是异步拉取的，慢网/大会话时可能在发送前取回、发送完成后
 * 才落地；旧实现直接 `setMessages(snapshot)`，把这一轮（乐观用户消息 + 流式回复）
 * 整段抹掉，而且此后没有新的刷新，页面就停在旧历史上。
 *
 * 回归机制：
 * - 本地发送推进「发送代际」，快照返回时代际变了 → 丢弃；
 * - 流式期间发起的快照一律不落地；
 * - 快照比本地短且本地有快照外的消息（发送前旧窗口 / 乐观/流式尾巴）→ 丢弃；
 * - 发送后的收尾重拉不复用发送前的在途请求（按代际去重），确保最终对齐磁盘。
 *
 * 五个场景（全部真实 /api/chat + mock pi，不桩消息层）：
 * 1. 首屏历史请求被延迟到本轮结束后才返回；
 * 2. 发送早于历史请求返回（正常速度）；
 * 3. 历史会话里排队补发（followUp）；
 * 4. 本轮流式中切走再切回；
 * 5. 本轮流式中整页刷新后收敛到落盘回复。
 */

/** 造一条已有一轮对话的会话，返回会话 id（消息在磁盘上，刷新后靠历史接口加载）。 */
async function seedSessionWithReply(page: Page): Promise<string> {
	const sessionId = await page.evaluate(async () => {
		const state = await (await fetch("/api/state")).json();
		const project = (state.projects ?? [])[0];
		const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id }) });
		return (await res.json())?.session?.id as string;
	});
	expect(sessionId).toBeTruthy();
	await page.goto(`${BASE}/s/${sessionId}`);
	const textarea = page.locator("textarea#prompt");
	await expect(textarea).toBeVisible({ timeout: 20_000 });
	await textarea.fill("first");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text").last()).toContainText("流式渲染验证完成", { timeout: 30_000 });
	await expect(page.locator(".user-bubble")).toHaveCount(1);
	return sessionId;
}

/** 造两条带标题的会话（S1 已有一轮对话），返回 id；用于「切走/切回」场景。 */
async function seedTwoTitledSessions(page: Page): Promise<string[]> {
	const ids = await page.evaluate(async () => {
		const state = await (await fetch("/api/state")).json();
		const project = (state.projects ?? [])[0];
		const created: string[] = [];
		for (const title of ["S1", "S2"]) {
			const res = await fetch("/api/sessions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ projectId: project.id }) });
			const id = (await res.json())?.session?.id as string;
			await fetch(`/api/sessions/${id}/update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title }) });
			created.push(id);
		}
		return created;
	});
	await page.goto(`${BASE}/s/${ids[0]}`);
	const textarea = page.locator("textarea#prompt");
	await expect(textarea).toBeVisible({ timeout: 20_000 });
	await textarea.fill("first");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text").last()).toContainText("流式渲染验证完成", { timeout: 30_000 });
	return ids;
}

test("web history: a stale pre-send snapshot must not wipe the turn just sent", async ({ app }) => {
	test.setTimeout(180_000);
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto(BASE);
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	await seedSessionWithReply(page);

	// 首次历史请求故意延迟到本轮结束之后才到（模拟慢网/大会话的竞态）
	let delayed = false;
	await page.route("**/messages/page*", async (route) => {
		if (delayed) {
			await route.continue();
			return;
		}
		delayed = true;
		const response = await route.fetch();
		await new Promise((resolve) => setTimeout(resolve, 6000));
		await route.fulfill({ response });
	});

	await page.reload();
	const textarea = page.locator("textarea#prompt");
	await expect(textarea).toBeVisible({ timeout: 20_000 });
	await textarea.fill("second");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text").last()).toContainText("流式渲染验证完成", { timeout: 30_000 });
	// 等被延迟的旧快照抵达
	await page.waitForTimeout(7000);
	const userTexts = await page.locator(".user-bubble").allInnerTexts();
	const assistantTexts = await page.locator(".assistant-text").allInnerTexts();
	expect(userTexts.join(" ")).toContain("second");
	expect(assistantTexts.join(" ")).toContain("second");
	// 旧历史仍在、且没有被本轮的乐观消息重复成两条
	expect(userTexts.join(" ")).toContain("first");
	expect(userTexts.filter((text) => text.includes("second")).length).toBe(1);
	// 时间线最终与磁盘一致：两条用户消息、顺序正确、没有重复气泡
	expect(userTexts.map((text) => text.trim())).toEqual(["first", "second"]);

	// 竞态之后同一会话继续发送仍要正常（代际护栏不会卡住后续轮次）
	await textarea.fill("third");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text").last()).toContainText("third", { timeout: 30_000 });
	await expect(page.locator(".user-bubble", { hasText: "third" })).toHaveCount(1);
});

test("web history: sending before the history request returns still renders the turn", async ({ app }) => {
	test.setTimeout(180_000);
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto(BASE);
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	await seedSessionWithReply(page);

	// 正常速度下重开会话并立刻发送：历史请求与本轮并发，本轮不能被首屏快照覆盖。
	await page.reload();
	const textarea = page.locator("textarea#prompt");
	await expect(textarea).toBeVisible({ timeout: 20_000 });
	await textarea.fill("second");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text").last()).toContainText("second", { timeout: 30_000 });
	await expect(page.locator(".user-bubble", { hasText: "second" })).toHaveCount(1);
	// 旧历史最终要收敛回来（发送后的收尾重拉），不能停在新一轮而丢掉 history。
	await expect(page.locator(".user-bubble", { hasText: "first" })).toHaveCount(1, { timeout: 30_000 });
});

test("web history: queued follow-ups after a history send all render", async ({ app }) => {
	test.setTimeout(180_000);
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto(BASE);
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	await seedSessionWithReply(page);

	await page.reload();
	const textarea = page.locator("textarea#prompt");
	await expect(textarea).toBeVisible({ timeout: 20_000 });

	// 第一轮进行中把下一条排队（桌面 followUp 语义）：两轮都必须上屏
	await textarea.fill("second");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text").last()).toBeVisible({ timeout: 30_000 });
	await textarea.fill("third");
	await page.keyboard.press("Enter");

	await expect(page.locator(".user-bubble", { hasText: "second" })).toHaveCount(1, { timeout: 30_000 });
	await expect(page.locator(".user-bubble", { hasText: "third" })).toHaveCount(1, { timeout: 30_000 });
	await expect(page.locator(".assistant-text", { hasText: "third" })).toHaveCount(1, { timeout: 30_000 });
	// 旧历史同样收敛回来
	await expect(page.locator(".user-bubble", { hasText: "first" })).toHaveCount(1, { timeout: 30_000 });
});

test("web history: switching away and back mid-turn keeps the reply", async ({ app }) => {
	test.setTimeout(180_000);
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto(BASE);
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	await seedTwoTitledSessions(page);

	const textarea = page.locator("textarea#prompt");
	await textarea.fill("second");
	await page.keyboard.press("Enter");
	await expect(page.locator(".user-bubble", { hasText: "second" })).toHaveCount(1);
	// 立刻切走再切回
	await page.locator(".session-row", { hasText: "S2" }).first().click();
	await page.waitForTimeout(400);
	await page.locator(".session-row", { hasText: "S1" }).first().click();
	await expect(page.locator(".assistant-text", { hasText: "second" })).toHaveCount(1, { timeout: 40_000 });
	await expect(page.locator(".user-bubble", { hasText: "second" })).toHaveCount(1);
});

test("web history: reloading mid-turn converges to the persisted reply", async ({ app }) => {
	test.setTimeout(180_000);
	expect(await waitForHealthy()).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize({ width: 900, height: 900 });
	await page.goto(BASE);
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	await seedTwoTitledSessions(page);

	const textarea = page.locator("textarea#prompt");
	await textarea.fill("second");
	await page.keyboard.press("Enter");
	await expect(page.locator(".user-bubble", { hasText: "second" })).toHaveCount(1);
	// 流式中刷新（用户的临时 workaround 也要保证收敛）
	await page.reload();
	await expect(page.locator("textarea#prompt")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator(".assistant-text", { hasText: "second" })).toHaveCount(1, { timeout: 40_000 });
	await expect(page.locator(".user-bubble", { hasText: "second" })).toHaveCount(1);
});
