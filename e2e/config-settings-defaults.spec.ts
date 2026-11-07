import { expect, test, _electron as electron } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * 回归（e2e）：配置管理「设置」页的两个下拉框读不到磁盘上的 defaultProvider/defaultModel。
 *
 * 用户可见症状：settings.json 里明明有默认供应商/模型（pi 会话也确实在用），
 * 打开 设置 → 配置管理 → 设置 看到的却是两个**完全空白**的输入框，页头配置项数量也缩水。
 *
 * 触发条件必须精确复刻，否则测不出来：
 * - 配置管理要**直接落在 settings tab**（localStorage 记忆），此时 SettingsTab 会在
 *   settingsData 仍是 {} 的瞬间挂载，挂载期的格式归一用空 data 回写 → 假脏 →
 *   loadConfig 为「保护草稿」跳过磁盘写回；
 * - 若测试路径先经过「模型」页，磁盘数据会提前进 state，竞态被掩盖（假绿）。
 */

const repoRoot = resolve(__dirname, "..");

test("config settings shows saved defaultProvider/defaultModel when opening the tab directly", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-config-defaults-"));
	const home = join(root, "home");
	const profileDir = join(root, "profile");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	mkdirSync(profileDir, { recursive: true });

	// 磁盘上真实存在的默认供应商/模型（pi 侧生效的来源）
	writeFileSync(
		join(home, ".pi", "agent", "settings.json"),
		JSON.stringify({
			compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 },
			retry: { maxRetries: 10, baseDelayMs: 5000 },
			defaultProvider: "probe-provider",
			defaultModel: "probe-model",
		}),
	);
	writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { "probe-provider": { baseUrl: "https://example.invalid/v1", api: "openai-completions", models: [{ id: "probe-model" }] } } }));
	writeFileSync(join(home, ".pi", "agent", "auth.json"), JSON.stringify({}));
	writeFileSync(join(profileDir, "settings.json"), JSON.stringify({ piEnvironmentChecked: true, language: "zh-CN" }));

	const app = await electron.launch({
		args: [repoRoot, `--user-data-dir=${profileDir}`],
		env: {
			...process.env,
			PIDECK_E2E_USER_DATA_DIR: profileDir,
			ELECTRON_RENDERER_URL: "",
			XDG_CONFIG_HOME: join(root, "config"),
			HOME: home,
			PIDECK_E2E: "1",
			PIDECK_E2E_WINDOW_MODE: "quiet",
			CI: "1",
		},
	});
	const window = await app.firstWindow();
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 60_000 });

	// 关掉一次性引导 + 让配置管理直接恢复在 settings tab（复刻用户的打开路径）
	await app.context().addInitScript(() => {
		try {
			localStorage.setItem("pideck:command-palette-onboarding", "1");
			localStorage.setItem("pideck-config-last-tab", "config:settings");
			localStorage.setItem("pideck-config-backend-pane", "pi");
		} catch {
			/* localStorage 不可用时用例会因引导遮挡而失败，属可接受的环境前提 */
		}
	});
	await window.reload();
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 60_000 });

	await window.getByRole("button", { name: "设置" }).click();
	await window.getByText("配置管理", { exact: true }).first().click();

	const tab = window.locator(".config-settings-tab");
	await expect(tab.getByText("默认供应商与模型").first()).toBeVisible({ timeout: 30_000 });

	// 值必须来自磁盘（修复前这里读到 ""）
	await expect(tab.locator("input").nth(0)).toHaveValue("probe-provider");
	await expect(tab.locator("input").nth(1)).toHaveValue("probe-model");

	// 触发器必须是文本框：type=button 时空值连 placeholder 都不画，症状被放大成「整个框全白」
	await expect(tab.locator("input").nth(0)).toHaveAttribute("type", "text");

	await app.close();
});
