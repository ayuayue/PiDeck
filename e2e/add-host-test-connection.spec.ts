import { test, expect } from "./mock-pi-fixture";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * 「新建连接」的测试连接按钮 + 可读失败原因（用户反馈：添加失败只给一个稳定码，不知道改哪里）。
 *
 * 全部在本机完成：127.0.0.1 上一个没人监听的端口，不连任何外部主机。断言重点是
 * 「用户看到的是可行动的句子，不是裸 SSH_HOST_* 码」，以及密码方式不做假测试。
 */
const projectDir = mkdtempSync(join(tmpdir(), "pideck-addhost-probe-"));
rmSync(projectDir, { recursive: true, force: true });
const keyDir = mkdtempSync(join(tmpdir(), "pideck-key-"));
const fakeKey = join(keyDir, "not-a-key.pem");
writeFileSync(fakeKey, "not a private key\n");

test.use({ seedProjects: [{ id: "e2e-addhost", name: "AddHostE2E", path: projectDir }] });

test("add host dialog: test connection shows a readable reason", async ({ window }) => {
	test.setTimeout(120_000);
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	await window.getByRole("button", { name: /^设置/ }).click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();
	const tab = modal.getByRole("tab", { name: "连接", exact: true });
	await expect(tab).toBeVisible({ timeout: 15_000 });
	await tab.click();
	await modal.getByRole("button", { name: "新建连接" }).click();

	const dialog = window.getByRole("dialog").filter({ hasText: "新建连接" }).first();
	await expect(dialog).toBeVisible({ timeout: 10_000 });

	await dialog.locator("#remote-host-name").fill("127.0.0.1");
	await dialog.locator("#remote-host-port").fill("9");
	await dialog.locator("#remote-host-user").fill("nobody");
	await dialog.locator("#remote-host-label").fill("refused-host");
	await dialog.getByRole("button", { name: "指定私钥" }).click();
	await dialog.locator("#remote-host-identity").fill(fakeKey);
	await window.screenshot({ path: "test-results/v5-addhost.png" });

	const testButton = dialog.getByRole("button", { name: "测试连接" });
	await expect(testButton).toBeVisible();
	await testButton.click();
	// 失败必须是可行动的句子，不能是裸稳定码（本机恰好有别的东西监听该端口时分类可能变成
	// 认证失败，所以这里只钉「有说明、不泄码」这两条契约）。
	const failure = dialog.getByText(/^测试失败：/);
	await expect(failure).toBeVisible({ timeout: 30_000 });
	await expect(failure).not.toContainText("SSH_");
	await window.screenshot({ path: "test-results/v5-addhost-test-failure.png" });

	// 密码方式：按钮禁用并说明原因（探针不接受交互式密码）。
	await dialog.getByRole("button", { name: "密码", exact: true }).click();
	await expect(dialog.getByRole("button", { name: "测试连接" })).toBeDisabled();
});
