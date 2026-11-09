import { expect, test } from "./fixtures";

/**
 * #502：配置管理「设置」页的默认供应商/默认模型下拉框曾经整框空白。
 *
 * 真机复现路径：配置管理直接恢复在 settings tab → `SettingsTab` 在 `settingsData`
 * 还是 `{}` 的瞬间挂载 → 挂载期的格式归一回写 `baselineSettingsRef` → 下一轮脏检测
 * 用旧 state 比较后把 `config:settings` 标脏 → `loadConfig` 认为有草稿而 `skipSettings`
 * → 磁盘数据永远不回填。表现就是两个框空着、页头配置项数量缩水。
 *
 * 这条用例只盯「打开即 settings tab 时，磁盘值是否进表单」：`seedPiAgent` 写进被隔离的
 * `$USERPROFILE/.pi/agent`（fixtures 已同时重定向 USERPROFILE/HOME，Windows 与 POSIX 一致），
 * 所以断言的是磁盘值本身，不依赖开发者本机配置。
 */
const piSettings = {
	compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
	retry: { maxRetries: 10, baseDelayMs: 5000 },
	defaultProvider: "probe-provider",
	defaultModel: "probe-model",
};

test.use({
	seedSettings: {},
	seedPiAgent: {
		settings: piSettings,
		models: { providers: { "probe-provider": { baseUrl: "https://example.invalid/v1", api: "openai-completions", models: [{ id: "probe-model" }] } } },
		auth: {},
	},
});

test("直接打开设置 tab 时显示磁盘上的默认供应商与模型", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });

	// 记住上次停留的 tab：配置管理打开即落在「设置」，正是触发竞态的那条路径。
	await window.evaluate(() => {
		localStorage.setItem("pideck:command-palette-onboarding", "1");
		localStorage.setItem("pideck-config-last-tab", "config:settings");
		localStorage.setItem("pideck-config-backend-pane", "pi");
	});
	await window.reload();
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });

	await window.getByRole("button", { name: "设置" }).click();
	const settingsDialog = window.locator(".settings-modal");
	await expect(settingsDialog).toBeVisible();
	await settingsDialog.getByRole("tab", { name: "配置管理", exact: true }).click();

	const tab = window.locator(".config-settings-tab");
	await expect(tab.getByText("默认供应商与模型").first()).toBeVisible({ timeout: 30_000 });

	const provider = tab.locator("input").nth(0);
	const model = tab.locator("input").nth(1);
	await expect(provider).toHaveValue("probe-provider");
	await expect(model).toHaveValue("probe-model");
	// Radix 的 PopoverTrigger 会把 type="button" 合到子 input 上，按钮类型不渲染 placeholder。
	await expect(provider).toHaveAttribute("type", "text");
});

test("空值时显示占位提示，且点击/回车仍能展开下拉", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 30_000 });
	await window.getByRole("button", { name: "设置" }).click();
	const settingsDialog = window.locator(".settings-modal");
	await expect(settingsDialog).toBeVisible();
	await settingsDialog.getByRole("tab", { name: "配置管理", exact: true }).click();

	// 默认落在「模型」tab；切到「设置」才挂载 SettingsTab。
	await window.locator(".config-layout").getByRole("tab", { name: "设置", exact: true }).click();
	const tab = window.locator(".config-settings-tab");
	const provider = tab.locator("input").nth(0);
	await expect(provider).toHaveAttribute("placeholder", /.+/);

	await provider.click();
	const popover = window.locator('[data-slot="popover-content"]').first();
	await expect(popover).toBeVisible({ timeout: 10_000 });
	await window.keyboard.press("Escape");
	await expect(popover).toHaveCount(0, { timeout: 10_000 });

	// readOnly input 不响应键盘激活，组件自己补了 Enter/Space/ArrowDown。
	await provider.focus();
	await window.keyboard.press("Enter");
	await expect(window.locator('[data-slot="popover-content"]').first()).toBeVisible({ timeout: 10_000 });
});
