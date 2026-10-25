import type { Locator, Page } from "@playwright/test";
import { expect, test } from "./mock-pi-fixture";

/**
 * PiDeck #262 回归：前台子代理（@gotgenes/pi-subagents 21.7.4 的 spawnAndWait 路径）
 * 只发 subagents:started、不发 created，运行期间 composer 上方的子代理条也必须出现，
 * 终态后同一条目迁到完成。
 * 载荷形状依据 @gotgenes/pi-subagents 21.7.4（#262 记录的版本，E2E **不安装/不执行**
 * 该包）；生产桥接 docstring 里的 @tintinweb/pi-subagents 是项目内旧署名，以 #262 为准。
 *
 * 覆盖链路（除 pi 进程内部外全部是仓库真实代码）：
 *   mock-pi 用生产桥接 resources/extensions/pi-deck-subagents.ts 重放出的 widget 快照
 *   → pi 原生 extension_ui_request{method:"setWidget"} RPC → PiRpcClient
 *   → AgentManager.handleUIRequest → agents:ui-request IPC
 *   → session-atoms widgets["pi-deck-subagents"] → useSessionSubagents
 *   → SessionSubagentsStrip 渲染。
 *
 * 不覆盖：真实 pi 进程 + 真实插件 + provider 调用（E2E 全程 mock pi，不发真实模型请求）。
 * 快照里 pluginActive=false（mock 不发 subagents:ready）：条目仍须渲染，不得被遮挡。
 */
const STRIP = '[data-testid="session-subagents-strip"]';

/** 草稿纯文本（composer 只渲染一个段落，textContent 即草稿）。 */
const draftText = (composer: Locator): Promise<string> => composer.evaluate((el) => el.textContent ?? "");

/** 写入草稿：insertText 原子插入 + 回读校验（逐键打字会被冷启动抢焦点吞字符）。 */
async function fillDraft(window: Page, composer: Locator, text: string): Promise<void> {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
		await composer.click();
		await window.keyboard.press("Control+a");
		await window.keyboard.press("Delete");
		await window.keyboard.insertText(text);
		if ((await draftText(composer)) === text) return;
		await window.waitForTimeout(300);
	}
	throw new Error(`草稿未写入：${text}`);
}

/** 提交草稿：冷启动首键会预热 runtime，焦点被抢时 Enter 不生效，草稿未清空就重试。 */
async function submitDraft(window: Page, composer: Locator): Promise<void> {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await composer.click();
		await expect(composer, "提交前焦点必须在输入框").toBeFocused();
		await window.keyboard.press("Enter");
		try {
			await expect(composer).toHaveText("", { timeout: 5_000 });
			return;
		} catch {
			// 焦点被启动流程抢走：重试（草稿仍在，不会重复发送）
		}
	}
	throw new Error("草稿未能提交");
}

test("前台子代理 started-only 运行期间可见、completed 后同条目收尾（#262）", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	// open-session.ts 的 openFirstSession 找的是「新会话」按钮，但该入口在 HEAD 已移入
	// Tab 栏项目下拉（i18n app.new 不再被引用）；侧栏常驻入口的 aria-label 是
	// app.newSession「新建会话」（SidebarContent 顶部按钮）。
	await window.getByRole("button", { name: "新建会话", exact: true }).first().click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// ── 运行期间（插件只发 started，无 created）──
	await fillDraft(window, composer, "SUBAGENTS_FG");
	await submitDraft(window, composer);
	const strip = window.locator(STRIP);
	await expect(strip).toBeVisible({ timeout: 15_000 });
	// 折叠态只有标题；展开横栏后应恰好一条条目
	await strip.locator("button[aria-expanded]").first().click();
	await expect(strip.locator("li")).toHaveCount(1);
	await expect(strip).toContainText("Explore");
	await expect(strip).toContainText("查找认证相关文件");
	// 展开条目行 → 状态徽标必须是「运行中」（#262 的原始现象就是这里整块不渲染）
	await strip.locator("li button").first().click();
	await expect(strip.getByText("运行中", { exact: true })).toBeVisible();

	// ── 终态：同一条目迁到完成 ──
	// 忙碌时发送的 prompt 先落本地「待发送」队列（steer 语义等本轮工具结束才投递），
	// 点行内「加入当前回合」立即投递；mock 收到后重放 completed 帧。
	await fillDraft(window, composer, "SUBAGENTS_FG_DONE");
	await submitDraft(window, composer);
	await window.getByRole("button", { name: "加入当前回合", exact: true }).click();
	await expect(strip.getByText("完成", { exact: true })).toBeVisible({ timeout: 15_000 });
	// toolUses=5 来自终态载荷（运行期间快照为 0），证明行数据确实被终态帧刷新
	await expect(strip).toContainText("工具调用 5");
	await expect(strip.locator("li")).toHaveCount(1);
});
