import { test, expect } from "./fixtures";
import { mkdtempSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

/**
 * DSH 重启会话回归：重启后原会话消息不能丢（用户 bug：「重启会话之后，
 * 原来的会话消息都没了」）。
 *
 * 根因历史：DshAgentManager.restart 曾新建 host 会话并把 catalog 换绑到新会话，
 * 旧 host 会话文件被丢弃——重启（应用内/应用级）后时间线只剩空会话。
 * 修复：restart 改为 attach 同一个 host 会话（$DSH_HOME 持久化数据不换），
 * 仅当 host 里已不存在该会话（DSH_HOME 被清/更换）才退回新建；
 * catalog 的 dshSessionId 保持不变，重启后 attach 路径重放历史投影。
 *
 * 隔离：settings.dshHomeDir 指向临时 DSH_HOME（复制真实 settings.yaml）。
 */
test("DSH 重启会话保留原消息并可续聊", async ({ window }) => {
	test.setTimeout(300_000);
	// ── 1. 隔离 DSH_HOME ──────────────────────────────────────────────────────
	const dshHome = mkdtempSync(join(tmpdir(), "pideck-e2e-dsh-"));
	const realSettings = join(homedir(), ".dsh", "settings.yaml");
	if (existsSync(realSettings)) copyFileSync(realSettings, join(dshHome, "settings.yaml"));
	await window.evaluate(async (dir) => {
		await (window as unknown as { piDesktop: { settings: { update: (patch: { dshHomeDir?: string }) => Promise<unknown> } } }).piDesktop.settings.update({ dshHomeDir: dir });
	}, dshHome);

	// ── 2. 新建 DSH 会话并发一条消息 ──────────────────────────────────────────
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const newDsh = window.getByRole("button", { name: "新会话", exact: true });
	await expect(newDsh).toBeVisible({ timeout: 15_000 });
	await newDsh.click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	const timeline = window.locator(".message-timeline");
	const FIRST = "重启前会话消息";
	await composer.click();
	await window.keyboard.type(FIRST);
	await window.keyboard.press("Enter");
	// 标题同步到侧栏 = host 已接受该消息（fallback 标题 = 首条消息文本）
	await expect(window.locator(".chat-list-pane")).toContainText(FIRST, { timeout: 30_000 });
	await expect(timeline).toContainText(FIRST, { timeout: 15_000 });

	const readDshRecords = () =>
		window.evaluate(async () => {
			const pi = (window as unknown as { piDesktop: { sessions: { listCatalog: (projectId: string, opts?: unknown) => Promise<Array<{ id: string; title: string; dshSessionId?: string; backend?: string }>> } } }).piDesktop;
			try {
				const records = await pi.sessions.listCatalog("builtin-chat", { scan: false });
				return records.filter((r) => r.backend === "dsh").map((r) => ({ id: r.id, title: r.title, dsh: r.dshSessionId }));
			} catch (error) {
				return { __error: String(error) };
			}
		});
	const before = await readDshRecords();
	console.log("[dsh-restart] before =>", JSON.stringify(before));
	const records = Array.isArray(before) ? before : [];
	expect(records.length).toBe(1);
	const hostSessionBefore = records[0]?.dsh;
	expect(hostSessionBefore).toBeTruthy();

	// ── 3. 会话 Tab 菜单 → 重启 ───────────────────────────────────────────────
	await window.locator('.session-tab[aria-selected="true"] [role="tab-menu"]').click();
	await window.getByRole("menuitem", { name: "重启", exact: true }).click();
	// 重启完成信号：toast（同 pi 链路；过早操作会撞 replacement reservation）
	await expect(window.getByText("Agent 已重启")).toBeVisible({ timeout: 30_000 });
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// ── 4. 重启后：catalog 换绑不变 + 原消息还在时间线 ───────────────────────
	const after = await readDshRecords();
	console.log("[dsh-restart] after =>", JSON.stringify(after));
	const afterRecords = Array.isArray(after) ? after : [];
	expect(afterRecords.length).toBe(1);
	// 核心断言：重启后仍 attach 同一 host 会话（dshSessionId 不变），
	// 而不是新建空会话换绑（旧实现会让历史「消失」）
	expect(afterRecords[0]?.dsh).toBe(hostSessionBefore);
	// 时间线保留原用户消息（投影重放 / 渲染层缓存）
	await expect(timeline).toContainText(FIRST, { timeout: 15_000 });

	// ── 5. 重启后续聊：新消息能正常进会话 ────────────────────────────────────
	// 注意：会话标题只在首条消息时回退/生成（host session-title 语义），
	// 续聊消息不再改标题，因此这里断言时间线而不是侧栏标题。
	const SECOND = "重启后继续";
	await composer.click();
	await window.keyboard.type(SECOND);
	await window.keyboard.press("Enter");
	await expect(timeline).toContainText(SECOND, { timeout: 30_000 });
	// 时间线同时保留两轮消息（重启前 + 重启后）
	await expect(timeline).toContainText(FIRST, { timeout: 5_000 });
	// 同一 host 会话文件里应同时含两轮消息
	const finalRecords = await readDshRecords();
	const finalList = Array.isArray(finalRecords) ? finalRecords : [];
	expect(finalList.length).toBe(1);
	expect(finalList[0]?.dsh).toBe(hostSessionBefore);
	expect(finalList[0]?.title).toBe(FIRST);
});
