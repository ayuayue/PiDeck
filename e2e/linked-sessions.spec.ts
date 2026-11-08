import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./mock-pi-fixture";
import { makeSeedProject } from "./open-session";

/**
 * 关联会话（子对话，docs/host-boundaries.md 例外九）端到端：
 *
 *   父会话 agent 调 start_session(offer) → 回环端点挂起 → 时间线卡片出「新会话 / 在此做 / 不要」
 *   → 点「新会话」→ 主进程建草稿并发简报 → 侧栏子会话挂在父会话下、状态点跟随运行时
 *   → 子会话一轮结束 → 回报以 followUp 送回父会话、父会话自动续跑一轮。
 *
 * 除 pi 进程内部外全部是仓库真实代码：mock-pi 按 pi-deck-linked-sessions 扩展的同一线格式
 * 调宿主端点（LINKED_START），不发真实模型请求。
 */

// 同项目里父/子两个 mock 会话要各用各的会话文件（见 mock-pi.cjs 的 deckSessionKey）。
process.env.PIDECK_MOCK_SESSION_PER_DECK = "1";

const seedProject = makeSeedProject("LinkedSessionsE2E");
// standby 池化进程不带 PIDECK_SESSION_ID，会让两个 mock 会话撞同一个文件；关掉只影响启动速度。
test.use({ seedProjects: [seedProject], seedSettings: { standbyRuntimeEnabled: false } });

const shots = process.env.PIDECK_E2E_SHOTS_DIR;

async function snap(window: Page, name: string): Promise<void> {
	if (shots) await window.screenshot({ path: `${shots}/${name}.png` });
}

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

test("offer 卡片 → 新会话 → 侧栏嵌套 + 状态 → 子会话回报父会话并续跑", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
	const composer = window.locator(".composer .rich-input");

	await send(window, composer, "LINKED_START offer 帮我把登录页的单测另开一个会话补上");

	// ── 父会话时间线：提议卡片挂起等用户 ──
	const card = window.locator('.linked-session-card[data-tool-name="start_session"]');
	await expect(card).toBeVisible({ timeout: 20_000 });
	await expect(card).toContainText("提议开新会话");
	await expect(card).toContainText("补登录页单测");
	await expect(card).toHaveAttribute("data-proposal-status", "pending");
	await snap(window, "1-offer-card");

	await card.getByRole("button", { name: "新会话", exact: true }).click();
	await expect(card).toHaveAttribute("data-proposal-status", "started", { timeout: 20_000 });
	await expect(card.getByRole("button", { name: "打开" })).toBeVisible();

	// ── 侧栏：子会话挂在父会话行下面，带关联状态 ──
	const childRow = window.locator(".linked-session-sidebar-row").filter({ hasText: "补登录页单测" });
	await expect(childRow).toBeVisible({ timeout: 20_000 });
	await snap(window, "2-child-in-sidebar");

	// ── 子会话一轮结束 → 回报回到父会话，父会话自动续跑一轮 ──
	await expect(childRow).toHaveAttribute("data-linked-state", "idle", { timeout: 30_000 });
	const report = window.getByText(/子会话「补登录页单测」结束了一轮/).first();
	await expect(report).toBeVisible({ timeout: 30_000 });
	// 父会话被回报拉起一轮：mock 的回复会引用它收到的回报包裹标签
	await expect(window.getByText(/linked-session-report/).first()).toBeVisible({ timeout: 30_000 });
	await snap(window, "3-parent-got-report");

	// ── 点子会话行：能直接打开、看到简报与它自己的回复 ──
	await childRow.click();
	await expect(window.getByText(/给 login\.ts 补单测/).first()).toBeVisible({ timeout: 20_000 });
	await snap(window, "4-child-opened");
});

test("own_initiative 只出卡片不开会话；点「不要」后卡片失效、侧栏无子会话", async ({ window }) => {
	test.setTimeout(90_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
	const composer = window.locator(".composer .rich-input");

	await send(window, composer, "LINKED_START own_initiative 顺手看看还有什么可以清理");
	const card = window.locator('.linked-session-card[data-tool-name="start_session"]');
	await expect(card).toBeVisible({ timeout: 20_000 });
	await expect(card).toContainText("建议的后续任务");
	await expect(card).toHaveAttribute("data-proposal-status", "pending", { timeout: 20_000 });
	await expect(window.locator(".linked-session-sidebar-row")).toHaveCount(0);
	await snap(window, "5-own-initiative-card");

	await card.getByRole("button", { name: "不要", exact: true }).click();
	await expect(card).toHaveAttribute("data-proposal-status", "dismissed", { timeout: 10_000 });
	await expect(card.getByRole("button", { name: "新会话", exact: true })).toHaveCount(0);
	await expect(window.locator(".linked-session-sidebar-row")).toHaveCount(0);
});
