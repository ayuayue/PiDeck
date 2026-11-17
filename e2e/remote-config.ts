import { expect, type Page } from "@playwright/test";
import { runRemoteCommand, type RemoteAcceptanceCredentials } from "./remote-fixtures";

/**
 * Remote config selector → shared source editor → one versioned document save → read-only auth view.
 *
 * Safety on a real acceptance host: the remote models.json (or its absence) is backed up before the test and
 * restored byte-for-byte in finally. The document adds a unique top-level marker and preserves existing
 * sanitized fields; the helper retains the credentials. Env-gated like the surrounding acceptance spec (this
 * helper is only called from a test whose credentials are present).
 *
 * Isolated UI coverage lives in remote-config-editing.spec.ts; this helper requires a real acceptance host.
 */
export async function verifyRemoteConfig(input: { window: Page; credentials: RemoteAcceptanceCredentials; runId: string; timeoutMs: number }): Promise<void> {
	const { window, credentials, timeoutMs } = input;
	const marker = "pideckE2eMarker" + input.runId.replace(/[^a-zA-Z0-9]/g, "");
	const backupFile = "$HOME/.pideck/e2e-config-backup-" + input.runId.replace(/[^a-zA-Z0-9]/g, "") + ".b64";
	const shaCommand = "sha256sum \"$HOME/.pi/agent/models.json\" 2>/dev/null | cut -d' ' -f1";
	const backupCommand = 'set -e; mkdir -p "$HOME/.pideck"; d="$HOME/.pi/agent"; ' + 'if [ -f "$d/models.json" ]; then base64 < "$d/models.json" > "' + backupFile + '"; echo PRESENT; else rm -f "' + backupFile + '"; echo MISSING; fi';

	const original = await runRemoteCommand(credentials, backupCommand + "; " + shaCommand, timeoutMs);
	const wasPresent = original.stdout.trim().split("\n")[0] === "PRESENT";
	const originalSha = original.stdout.trim().split("\n")[1] ?? "";

	const restoreCommand = wasPresent
		? 'set -e; d="$HOME/.pi/agent"; base64 -d < "' + backupFile + '" > "$d/models.json.tmp-restore"; mv "$d/models.json.tmp-restore" "$d/models.json"; rm -f "' + backupFile + '"; ' + shaCommand
		: 'rm -f "$HOME/.pi/agent/models.json" "' + backupFile + '"; test ! -e "$HOME/.pi/agent/models.json" && echo REMOVED';
	try {
		// Open Settings → 配置管理 → Pi 管理 → 模型. Host label is the ssh-config candidate label (user@host).
		await window.getByRole("button", { name: /^设置/ }).click();
		const settings = window.locator(".settings-modal");
		await expect(settings).toBeVisible();
		await settings.getByRole("tab", { name: "配置管理", exact: true }).click();
		const layout = settings.locator(".config-layout");
		await expect(layout).toBeVisible();
		await layout.getByRole("tab", { name: "模型", exact: true }).click();

		// Pi 环境下拉挂在「Pi 配置管理」分页上：本机是默认，选中验收用的那台 SSH 主机后整页按它重载。
		const envTrigger = settings.getByTestId("config-env-trigger");
		await expect(envTrigger).toBeVisible({ timeout: timeoutMs });
		await envTrigger.click();
		// 菜单项文案是「<主机 label> <user@host>」；label 由用户填写，所以锚定地址。
		const hostOption = window.getByRole("menuitem").filter({ hasText: new RegExp(credentials.host.replace(/\./g, "\\.")) });
		await expect(hostOption.first(), "环境下拉必须列出已连接的主机").toBeVisible({ timeout: 30_000 });
		await hostOption.first().click();
		const envStatus = settings.getByTestId("config-environment-status");
		await expect(envStatus).toHaveAttribute("data-kind", "ssh", { timeout: timeoutMs });

		const catalog = layout.getByTestId("remote-model-catalog");
		await expect(catalog).toBeVisible({ timeout: timeoutMs });
		await expect(catalog.getByTestId("remote-model-probe")).toBeVisible();
		await layout.getByRole("tab", { name: "源文件", exact: true }).click();
		const source = layout.locator(".config-raw-tab:visible .cm-content");
		await expect(source).toContainText("providers", { timeout: timeoutMs });
		const document: Record<string, unknown> = JSON.parse(await source.innerText());
		document[marker] = input.runId;
		await source.click();
		await window.keyboard.press("ControlOrMeta+A");
		await window.keyboard.insertText(JSON.stringify(document, null, 2));
		await settings.getByRole("button", { name: "保存", exact: true }).first().click();
		await expect(layout.getByRole("alert")).toHaveCount(0);

		// First-party evidence on disk: the marker is really in the remote file.
		const check = await runRemoteCommand(credentials, "grep -F " + marker + ' "$HOME/.pi/agent/models.json" >/dev/null && echo MARKER_ON_REMOTE', 60_000);
		expect(check.stdout.trim()).toContain("MARKER_ON_REMOTE");

		// Authentication remains a derived view; source editing covers the four writable files.
		await layout.getByRole("tab", { name: "认证", exact: true }).click();
		await expect(layout.getByTestId("remote-auth-panel")).toBeVisible({ timeout: timeoutMs });
		await expect(layout.getByTestId("remote-auth-readonly")).toBeVisible();
		// 只读证据：本机 AuthTab 的「添加认证」入口在这里不存在（页面不能看起来能改、其实写不进去）。
		await expect(layout.getByRole("button", { name: "+ 添加认证", exact: true })).toHaveCount(0);
		await expect(layout.getByRole("tab", { name: "源文件", exact: true })).toBeVisible();
		await layout.getByRole("tab", { name: "信任", exact: true }).click();
		await expect(layout.locator(".config-trust-tab")).toBeVisible({ timeout: timeoutMs });
		await layout.getByRole("tab", { name: "MCP", exact: true }).click();
		await expect(layout.locator(".config-raw-tab:visible .cm-content")).toBeVisible({ timeout: timeoutMs });
	} finally {
		const restored = await runRemoteCommand(credentials, restoreCommand, timeoutMs);
		const restoredText = restored.stdout.trim();
		if (wasPresent) {
			expect(restoredText.split("\n")[0], "finally 必须把远端 models.json 还原成测试前的字节").toBe(originalSha);
		} else {
			expect(restoredText).toBe("REMOVED");
		}
		await window
			.locator(".settings-modal")
			.getByRole("button", { name: "关闭" })
			.click()
			.catch(() => undefined);
	}
}
