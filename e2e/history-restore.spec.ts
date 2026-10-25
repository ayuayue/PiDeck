import { test as base, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openFirstSession } from "./open-session";

/**
 * 历史会话恢复（#113 3.2-9）：
 * 第一轮 launch 完成对话 → mock 把 JSONL 落到 ~/.pi/agent/sessions；
 * 关闭应用后第二轮 launch 同一 userData/HOME → 侧栏应出现历史会话，
 * 点开后时间线恢复原文。
 *
 * 本 fixture 自管双次 launch（标准 mock-pi fixture 单次生命周期不够用）。
 */

const repoRoot = resolve(__dirname, "..");

/** 打开第一个会话（合成器可用）；UI 2.0 起欢迎页已无「启动 Agent」按钮。 */
async function startAgent(window: Page) {
	return openFirstSession(window);
}

async function launchApp(userDataRoot: string): Promise<ElectronApplication> {
	// 与 mock-pi-fixture 一致：只隔离 APPDATA/userData，不改 HOME。
	// 会话落盘走项目 cwd 的 .pi/sessions（mock 写 sessionDir），扫描不依赖全局 ~/.pi。
	const env = {
		...process.env,
		// 自管双次 launch 也走 E2E 静默模式（屏幕外窗口），否则窗口会弹到用户桌面最前。
		PIDECK_E2E: "1",
		PIDECK_E2E_WINDOW_MODE: "quiet",
		CI: "1",
		...(process.platform === "win32" ? { APPDATA: userDataRoot } : process.platform === "darwin" ? { HOME: userDataRoot } : { XDG_CONFIG_HOME: userDataRoot, HOME: userDataRoot }),
	};
	delete env.ELECTRON_RENDERER_URL;
	return electron.launch({
		args: [join(repoRoot, "out", "main", "index.js"), `--user-data-dir=${join(userDataRoot, "profile")}`],
		env,
	});
}

const test = base;

test("history restore: close app and reopen recovers prior session", async () => {
	test.setTimeout(180_000);
	const userDataRoot = mkdtempSync(join(tmpdir(), "pideck-history-"));
	const shimPath = join(userDataRoot, "mock-pi.cmd");
	const scriptPath = join(repoRoot, "e2e", "mock-pi.cjs");
	writeFileSync(shimPath, `@echo off\r\n"${process.execPath}" "${scriptPath}" %*\r\n`);
	mkdirSync(join(userDataRoot, "profile"), { recursive: true });
	writeFileSync(join(userDataRoot, "profile", "settings.json"), JSON.stringify({ customPiPath: shimPath, piEnvironmentChecked: true }));

	let app1: ElectronApplication | undefined;
	let app2: ElectronApplication | undefined;
	try {
		// ── 第一轮：对话并落盘 ──
		app1 = await launchApp(userDataRoot);
		const window1 = await app1.firstWindow();
		await window1.waitForLoadState("domcontentloaded");
		await expect(window1.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

		const composer = await startAgent(window1);
		await composer.click();
		await window1.keyboard.type("历史恢复锚点");
		await window1.keyboard.press("Enter");
		await expect(window1.locator(".message-timeline")).toContainText("Mock 回复：「历史恢复锚点」流式渲染验证完成", { timeout: 20_000 });

		await app1.close();
		app1 = undefined;

		// ── 第二轮：同 userData 再开，侧栏应出现历史会话 ──
		app2 = await launchApp(userDataRoot);
		const window2 = await app2.firstWindow();
		await window2.waitForLoadState("domcontentloaded");
		await expect(window2.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

		// 侧栏会话行：标题来自 session_info.name（首条用户消息截断）
		const historyRow = window2.locator(".conversation", { hasText: "历史恢复锚点" }).first();
		await expect(historyRow).toBeVisible({ timeout: 30_000 });
		await historyRow.click();

		// 点开后时间线恢复原文（不依赖再 spawn agent 也能读历史 JSONL）
		await expect(window2.locator(".message-timeline")).toContainText("历史恢复锚点", { timeout: 20_000 });
		await expect(window2.locator(".message-timeline")).toContainText("Mock 回复：「历史恢复锚点」流式渲染验证完成", { timeout: 20_000 });
	} finally {
		try {
			await app1?.close();
		} catch {
			/* ignore */
		}
		try {
			await app2?.close();
		} catch {
			/* ignore */
		}
		if (!process.env.PIDECK_E2E_KEEP) {
			try {
				rmSync(userDataRoot, { recursive: true, force: true });
			} catch {
				/* ignore */
			}
		} else {
			console.log("[history-restore] kept userDataRoot:", userDataRoot);
		}
	}
});
