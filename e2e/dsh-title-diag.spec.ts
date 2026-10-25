import { test, expect } from "./fixtures";
import { mkdtempSync, copyFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

/**
 * DSH 标题同步回归（用户 bug：「新建会话之后，发送消息标题没有同步的更改」）。
 *
 * 根因：DSH tab 带 sessionPath 后，coordinator 的 attachRuntime 走了「文件配对」
 * 分支只写 filePath/piSessionId，从不写 dshSessionId——标题同步依赖的
 * findByDshSessionId 查不到记录，侧栏标题一直停留占位名。
 * 修复：attach/restart 三处 + 事件桥为 DSH tab 补写 dshSessionId；catalog 加载
 * 时把 backend=dsh 且缺 dshSessionId 的旧记录回填 piSessionId。
 */
test("DSH 标题同步诊断", async ({ window, userDataRoot }) => {
	test.setTimeout(240_000);
	const dshHome = mkdtempSync(join(tmpdir(), "pideck-e2e-dsh-"));
	const realSettings = join(homedir(), ".dsh", "settings.yaml");
	if (existsSync(realSettings)) copyFileSync(realSettings, join(dshHome, "settings.yaml"));
	await window.evaluate(async (dir) => {
		await (window as unknown as { piDesktop: { settings: { update: (patch: { dshHomeDir?: string }) => Promise<unknown> } } }).piDesktop.settings.update({ dshHomeDir: dir });
	}, dshHome);

	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// 新会话默认 DSH 后端（其他 Agent 已移除专用 DSH 按钮）
	const newDsh = window.getByRole("button", { name: "新会话", exact: true });
	await expect(newDsh).toBeVisible({ timeout: 15_000 });
	await newDsh.click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.type("帮我看看这个报错");
	await window.keyboard.press("Enter");

	// host 生成标题（fallback = 首条消息文本），侧栏行与 catalog 都应同步
	await expect(window.locator(".chat-list-pane")).toContainText("帮我看看这个报错", { timeout: 30_000 });

	const dump = await window.evaluate(async () => {
		const pi = (window as unknown as { piDesktop: { sessions: { listCatalog: (projectId: string, opts?: unknown) => Promise<Array<{ id: string; title: string; dshSessionId?: string; backend?: string }>> } } }).piDesktop;
		try {
			const records = await pi.sessions.listCatalog("builtin-chat", { scan: false });
			return records.map((r) => ({ id: r.id, title: r.title, dsh: r.dshSessionId, backend: r.backend }));
		} catch (error) {
			return { __error: String(error) };
		}
	});
	console.log("[title-diag] records =>", JSON.stringify(dump, null, 1));
	expect(Array.isArray(dump) && dump.length === 1).toBe(true);
	const record = Array.isArray(dump) ? dump[0] : undefined;
	expect(record?.backend).toBe("dsh");
	expect(record?.title).toBe("帮我看看这个报错");
	// 核心断言：dshSessionId 已持久化（标题同步 + 重启后 attach 恢复依赖它）
	expect(record?.dsh).toBeTruthy();

	// 持久化文件同样带 dshSessionId（attachRuntime flush 后）
	const catalogPath = join(userDataRoot, "profile", "session-catalog.json");
	if (existsSync(catalogPath)) {
		const catalog = JSON.parse(readFileSync(catalogPath, "utf8")) as {
			sessions?: Array<{ dshSessionId?: string }>;
		};
		expect(catalog.sessions?.some((item) => item.dshSessionId === record?.dsh)).toBe(true);
	}
});
