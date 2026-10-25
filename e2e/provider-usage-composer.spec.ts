import { test, expect } from "./mock-pi-fixture";

/**
 * 会话内用量链路 E2E（mock pi，真实 spawn + stdio JSON-RPC）：
 * - 模型选择器分组行尾 inline 用量（cc-switch 单行彩色数值）；
 * - 圆球面板（SessionContextMeter）内 ProviderUsageDetails 余额行。
 *
 * 主进程 config:fetch-usage 重注册为确定性 stub（按 provider 返回固定余额），
 * 不访问真实网络；models/catalog 走 mock-pi 的 --list-models（provider=mock）。
 */
test("usage: picker group row and context meter panel show provider usage", async ({ app, window }) => {
	test.setTimeout(150_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// fetch-usage stub：provider "mock" → $88.5 余额（绿）；其余 unsupported
	await app.evaluate(
		(electron, usageByProvider) => {
			// app.evaluate 只序列化函数体：通道名就地字面量、函数体内解构（见 provider-usage.spec.ts 注释）
			const { ipcMain } = electron;
			ipcMain.removeHandler("config:fetch-usage");
			ipcMain.handle("config:fetch-usage", (_event, payload: { provider?: string }) => {
				const hit = payload?.provider ? usageByProvider[payload.provider] : undefined;
				return hit ?? { success: false, error: "unsupported provider (e2e stub)" };
			});
		},
		{
			mock: { success: true, kind: "balance", balance: { value: 88.5, currency: "USD" }, at: Date.now() },
		} as Record<string, unknown>,
	);

	// 合成器就绪（欢迎页直接可用）
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });

	// 1) 模型选择器：mock 分组行尾出现 inline 用量（打开 picker 批量触发 TTL 去重查询）
	// UI 2.0 composer：芯片是下拉菜单触发器，模型 Dialog 从菜单「模型」行 drill-in 打开
	// （该行可访问名为 "模型 模型: -"，与芯片 "模型: - 思考" 区分开）
	await window.locator(".model-thinking").click();
	await window.getByRole("button", { name: /^模型 模型/ }).click();
	const picker = window.locator(".model-picker");
	await expect(picker).toBeVisible({ timeout: 10_000 });
	await expect(picker).toContainText("$88.5", { timeout: 15_000 });
	await expect(picker).toContainText("剩");
	await window.keyboard.press("Escape");
	await expect(picker).toBeHidden({ timeout: 5_000 });

	// 2) 圆球面板：激活 runtime（发一条消息拿 provider=mock 的 live state），打开面板看详情
	await composer.click();
	await window.keyboard.type("你好 mock");
	await window.keyboard.press("Enter");
	const timeline = window.locator(".message-timeline");
	await expect(timeline).toContainText("Mock 回复：「你好 mock」", { timeout: 30_000 });

	await window.locator('[data-testid="session-context-meter"] button').click();
	const usageBlock = window.locator('[data-testid="session-context-usage"]');
	await expect(usageBlock).toBeVisible({ timeout: 10_000 });
	const details = window.locator('[data-testid="provider-usage-details"]');
	await expect(details).toBeVisible();
	await expect(details).toContainText("剩余额度");
	await expect(details).toContainText("$88.5", { timeout: 15_000 });
	// 相对更新时间 + 刷新按钮（cc-switch 详情头部同款）
	await expect(details.locator('[data-testid="provider-usage-refresh"]')).toBeVisible();
});
