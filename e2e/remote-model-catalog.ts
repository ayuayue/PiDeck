import { expect, type Page } from "@playwright/test";
import { type RemoteAcceptanceCredentials } from "./remote-fixtures";

/**
 * Authored-only e2e step for the remote provider model catalog v1 (Phase 5 row 819).
 *
 * Connected host with pi installed; no project or live runtime is required. The host-level directory is
 * loaded automatically, and the refresh action requests the full catalog including extensions.
 *
 * Not executed by this lane (no real-machine e2e).
 */
export async function verifyRemoteModelCatalog(input: { window: Page; credentials: RemoteAcceptanceCredentials; timeoutMs: number }): Promise<void> {
	const { window, credentials, timeoutMs } = input;
	await window.getByRole("button", { name: /^设置/ }).click();
	const settings = window.locator(".settings-modal");
	await expect(settings).toBeVisible();
	await settings.getByRole("tab", { name: "配置管理", exact: true }).click();
	const layout = settings.locator(".config-layout");
	await expect(layout).toBeVisible();
	await layout.getByRole("tab", { name: "模型", exact: true }).click();

	// Select the verified ssh host in the existing config target selector.
	const selector = settings.getByTestId("config-env-trigger");
	await expect(selector).toBeVisible({ timeout: timeoutMs });
	await selector.click();
	// The option accessible name is "<host label> <ssh host>"; the label is user-chosen, so anchor on the address.
	const hostOption = window.getByRole("menuitem").filter({ hasText: new RegExp(credentials.host.replace(/\./g, "\\.")) });
	await expect(hostOption.first(), "目标选择器必须列出已连接的主机").toBeVisible({ timeout: 30_000 });
	await hostOption.first().click();

	const catalog = layout.getByTestId("remote-model-catalog");
	await expect(catalog).toBeVisible({ timeout: timeoutMs });
	// The models panel must offer the real catalog action, not the old disabled provider-test/fetch entries.
	await expect(catalog).toHaveAttribute("data-phase", "ready", { timeout: timeoutMs });
	await expect(catalog.getByTestId("remote-model-probe")).toContainText("刷新模型目录");
	await catalog.getByTestId("remote-model-probe").click();

	// One host request: must end in a non-empty provider-grouped list (the product-road test's live agent has a
	// working model). A stable-code error would mean the probe did not reach the runtime.
	await expect(catalog.getByTestId("remote-model-providers")).toBeVisible({ timeout: timeoutMs });
	await catalog.getByTestId("remote-model-probe-summary").click();
	await expect(catalog.getByTestId("remote-model-providers").getByTestId("remote-model-provider").first()).toBeVisible();
	const providerCount = await catalog.getByTestId("remote-model-providers").getByTestId("remote-model-provider").count();
	expect(providerCount, "远端模型目录必须至少包含一个 provider").toBeGreaterThan(0);
	const entryCount = await catalog.getByTestId("remote-model-providers").getByTestId("remote-model-entry").count();
	expect(entryCount, "远端模型目录必须至少包含一个模型条目").toBeGreaterThan(0);
	await expect(catalog.getByTestId("remote-model-probe-error")).toHaveCount(0);
	await expect(catalog.getByTestId("remote-model-probe-empty")).toHaveCount(0);

	await settings.getByRole("button", { name: "关闭" }).first().click();
	await expect(settings).toHaveCount(0);
}
