import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";

/**
 * 历史消息编辑/删除/重发 E2E（回归：2026-11 用户反馈「删除后消息没有删除、还重复了」）。
 *
 * 覆盖的决策矩阵（见 src/renderer/src/utils/sessionHistoryMutationPolicy.ts）：
 * - 有会话文件 + agent 运行中：删除/编辑/重发 → 弹「先停止 Agent」确认 → 停止 →
 *   改 JSONL → 立即从磁盘重载（force 覆盖缓存）→ 时间线即时刷新。
 * - 有会话文件 + agent 已停止：直接改 JSONL → 立即重载。
 * - 匿名会话：编辑/删除明确告知不支持（toast），不做无意义的 runtime 调用。
 *
 * 三个用例分别验证：
 * 1) 连续两次删除都即时生效（首次删后缓存已切 disk 源，第二次删除是 revision 守卫
 *    回归点——修复前 force disk 重载被守卫吞掉，表现为「删了没反应」）；
 *    且时间线无重复消息。
 * 2) 编辑立即生效：新文本出现、旧文本消失。
 * 3) 重发：截断旧轮次后重发，最终只有一份回复（无重复）。
 */
async function startAgent(window: Page) {
	// UI 2.0 合成器优先欢迎页：不再有「启动 Agent」按钮，首次输入即激活 runtime
	//（ComposerArea 首键预热 activateRuntime）。这里只等合成器可用。
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

/** 发送一条消息并等待 mock 完整回复（含「流式渲染验证完成」收尾标记）。 */
async function sendTurn(window: Page, text: string) {
	const composer = window.locator(".composer .rich-input");
	await composer.click();
	await window.keyboard.type(text);
	await window.keyboard.press("Enter");
	const reply = `Mock 回复：「${text}」流式渲染验证完成。`;
	await expect(window.locator(".message-timeline")).toContainText(reply, { timeout: 30_000 });
	return reply;
}

/** 时间线中某段文本的出现次数（去重断言用）。 */
async function countOccurrences(window: Page, text: string): Promise<number> {
	const contents = await window.locator(".message-timeline").allTextContents();
	return contents.join("\n").split(text).length - 1;
}

/** 等待 agent 空闲（操作栏按钮只在非运行态渲染；发送键 busy 时切换为「停止」）。 */
async function waitIdle(window: Page) {
	const sendControl = window.locator(".composer-send-primary");
	await expect(sendControl).toHaveAttribute("aria-label", "发送", { timeout: 20_000 });
}

test("delete: repeated deletes apply immediately with no duplicates", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	const timeline = window.locator(".message-timeline");

	const reply1 = await sendTurn(window, "第一轮问题");
	const reply2 = await sendTurn(window, "第二轮问题");
	await waitIdle(window);

	// ── 第一次删除：最后一条 assistant 回复。会话仍 live（但已 idle）→ 弹确认，
	//    文案用 idle 变体（historyStopToDeleteBodyIdle）：只有正在流式时才带「会话正在运行。」前缀，
	//    因为 idle 时并不需要真的打断什么。点「停止」→ 停止 → 改文件 → 立即重载。
	const lastTurn = timeline.locator(".turn-row").filter({ hasText: reply2 });
	await lastTurn.getByTitle("删除").click();
	const stopDialog = window.getByRole("alertdialog");
	await expect(stopDialog).toBeVisible({ timeout: 10_000 });
	await expect(stopDialog).toContainText("删除消息会先停止 Agent，再改会话文件");
	await stopDialog.getByRole("button", { name: "停止" }).click();

	// 删除立即生效：第二轮回复从时间线消失（不再需要手动重载会话）
	await expect(timeline).not.toContainText(reply2, { timeout: 30_000 });
	await expect(timeline).toContainText(reply1);

	// ── 第二次删除：第一轮 user 消息。删除语义 = 移除该消息本身，后续对话
	//    重新挂到父节点保留（SessionFileEditor 的 reparent 设计，见
	//    tests/sessionFileEditor.test.mjs「delete tombstones the target, reparents direct children」）
	//    agent 已停止 → 弹「删除后该消息将从会话中移除…」确认，点「删除」。
	//    修复前：缓存已切 disk 源但 revision 不清零，force disk 重载被 revision 守卫
	//    吞掉 → 文件已删、时间线不变（「删除没反应」）；修复后立即生效。
	const firstUser = timeline.locator(".user-turn").filter({ hasText: "第一轮问题" });
	await firstUser.locator(".user-turn-actions").getByTitle("删除").click();
	await expect(stopDialog).toBeVisible({ timeout: 10_000 });
	await expect(stopDialog).toContainText("删除后该消息将从会话中移除");
	await stopDialog.getByRole("button", { name: "删除" }).click();

	// 用户消息被移除（按 user-turn 气泡断言，避免撞上回复正文里的同名字串）；
	// 其后续回复按 reparent 语义保留（第一段回复仍可见，仅此一份）
	await expect(timeline.locator(".user-turn").filter({ hasText: "第一轮问题" })).toHaveCount(0, { timeout: 30_000 });
	await expect(timeline).toContainText(reply1);
	expect(await countOccurrences(window, "第一轮问题")).toBe(1); // 仅剩回复正文里的引用
	expect(await countOccurrences(window, reply2)).toBe(0);

	// ── 无重复：每条回复恰好一份
	expect(await countOccurrences(window, reply1)).toBe(1);
	expect(await countOccurrences(window, reply2)).toBe(0);
});

test("edit: edited text takes effect immediately and old text is gone", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	const timeline = window.locator(".message-timeline");

	const reply1 = await sendTurn(window, "编辑测试问题");
	await sendTurn(window, "第二段问题");
	await waitIdle(window);

	// 编辑最后一条 assistant 回复：agent 运行中 → 「停止后编辑」确认 → 停止 → 改文件 → 重载
	const lastTurn = timeline.locator(".turn-row").filter({ hasText: reply1 });
	await lastTurn.getByTitle("编辑").click();
	const editArea = timeline.locator("textarea");
	await expect(editArea).toBeVisible({ timeout: 10_000 });
	await editArea.fill("这是修改后的回复内容");
	// 编辑态会替换掉回复正文，hasText 过滤器失效；时间线里唯一的「保存」按钮就在编辑框旁
	await timeline.getByRole("button", { name: "保存" }).click();

	const stopDialog = window.getByRole("alertdialog");
	await expect(stopDialog).toBeVisible({ timeout: 10_000 });
	await stopDialog.getByRole("button", { name: "停止" }).click();

	// 新文本出现、旧文本消失（立即生效，无需重新加载会话）
	await expect(timeline).toContainText("这是修改后的回复内容", { timeout: 30_000 });
	await expect(timeline).not.toContainText(reply1, { timeout: 10_000 });
});

test("resend: truncates the old turn and re-sends without duplicates", async ({ window }) => {
	test.setTimeout(180_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await startAgent(window);
	const timeline = window.locator(".message-timeline");

	await sendTurn(window, "重发第一段");
	const reply2 = await sendTurn(window, "重发目标消息");
	await waitIdle(window);

	// 重发最后一条 user 消息：agent 运行中 → 「停止后重发」确认 → 停止 →
	// 截断该消息之后的 JSONL → 重新发送（自动激活 runtime）→ mock 再流式回复一次。
	const lastUser = timeline.locator(".user-turn").filter({ hasText: "重发目标消息" });
	await lastUser.locator(".user-turn-actions").getByTitle("用同一条用户消息再次发送给 AI").click();

	const stopDialog = window.getByRole("alertdialog");
	await expect(stopDialog).toBeVisible({ timeout: 10_000 });
	await expect(stopDialog).toContainText("会话正在运行。重发会先停止 Agent");
	await stopDialog.getByRole("button", { name: "停止" }).click();

	// 截断旧轮次后重发：旧回复先消失（截断生效），随后重新流式输出新回复 → 恰好一份
	//（若截断未生效，时间线始终保留旧回复，下面的「先消失」断言会失败——防止假绿）。
	await expect(timeline).not.toContainText(reply2, { timeout: 30_000 });
	await expect(timeline).toContainText(reply2, { timeout: 45_000 });
	await window.waitForTimeout(1500);
	expect(await countOccurrences(window, reply2)).toBe(1);
	// 第一段不受影响
	expect(await countOccurrences(window, "Mock 回复：「重发第一段」流式渲染验证完成。")).toBe(1);
});
