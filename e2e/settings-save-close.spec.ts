import { test, expect } from "./mock-pi-fixture";
import { openSettings } from "./open-session";

type SettingsSaveGateWindow = {
	piDesktop: {
		settings: {
			update: (patch: Record<string, unknown>) => Promise<unknown>;
		};
	};
	__releaseSettingsUpdate: () => void;
};

test("保存设置时可以立即关闭，且保存中不会误报未保存修改", async ({ window }) => {
	const errors: string[] = [];
	window.on("pageerror", (error) => errors.push(error.message));
	window.on("console", (message) => {
		if (message.type() === "error") errors.push(message.text());
	});

	// 用可控 IPC 闸门稳定覆盖保存 Promise 未结算的窗口，不依赖机器速度碰运气。
	await window.evaluate(() => {
		const target = window as unknown as SettingsSaveGateWindow;
		const update = target.piDesktop.settings.update;
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		target.__releaseSettingsUpdate = release;
		target.piDesktop.settings.update = async (patch) => {
			await gate;
			return update(patch);
		};
	});

	const settings = await openSettings(window);
	await settings.getByRole("tab", { name: "外观设置", exact: true }).click();
	const slider = settings.locator('input[type="range"][aria-label="聊天内容宽度"]');
	await expect(slider).toBeVisible({ timeout: 15_000 });
	await slider.evaluate((element) => {
		const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
		setter.call(element, "85");
		element.dispatchEvent(new Event("input", { bubbles: true }));
		element.dispatchEvent(new Event("change", { bubbles: true }));
	});
	await expect(settings.getByText("85%", { exact: true })).toBeVisible();

	await settings.getByRole("button", { name: "保存", exact: true }).click();
	const saving = settings.getByRole("button", { name: /^保存中/ });
	const close = settings.getByRole("button", { name: "关闭", exact: true });
	const cancel = settings.getByRole("button", { name: "取消", exact: true });
	await expect(saving).toBeDisabled();
	await expect(saving).toHaveAttribute("aria-busy", "true");
	await expect(cancel).toBeDisabled();
	await expect(close).toBeDisabled();
	await window.keyboard.press("Escape");
	await expect(settings).toBeVisible();

	await window.evaluate(() => {
		(window as unknown as SettingsSaveGateWindow).__releaseSettingsUpdate();
	});
	await close.click();
	await expect(settings).toBeHidden();

	await window.getByRole("button", { name: /^设置/ }).first().click();
	const reopened = window.getByRole("dialog", { name: "设置", exact: true });
	await expect(reopened).toBeVisible();
	await expect(reopened.locator('input[type="range"][aria-label="聊天内容宽度"]')).toHaveValue("85");
	await reopened.getByRole("button", { name: "关闭", exact: true }).click();
	await expect(reopened).toBeHidden();
	expect(errors).toEqual([]);
});
