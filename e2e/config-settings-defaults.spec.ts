import { expect, test, _electron as electron } from "@playwright/test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(__dirname, "..");

test("config settings shows saved defaultProvider/defaultModel when opening the tab directly", async () => {
	const root = mkdtempSync(join(tmpdir(), "pideck-config-defaults-"));
	const home = join(root, "home");
	const profileDir = join(root, "profile");
	mkdirSync(join(home, ".pi", "agent"), { recursive: true });
	mkdirSync(profileDir, { recursive: true });

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

	await expect(tab.locator("input").nth(0)).toHaveValue("probe-provider");
	await expect(tab.locator("input").nth(1)).toHaveValue("probe-model");

	await expect(tab.locator("input").nth(0)).toHaveAttribute("type", "text");

	await app.close();
});
