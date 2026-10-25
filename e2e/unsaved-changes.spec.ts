import { test, expect, type Locator } from "./fixtures";
import { openSettings, openConfigPane } from "./open-session";

/**
 * 设置/配置弹窗「未保存变更」确认链路回归：
 * - 改回原值 = 无真实差异 → 关闭不弹确认（假脏标记根因）
 * - 单项变更 → 关闭弹确认并点名变更项
 * - 多项变更 → 关闭确认列出全部变更项（不再只点第一条）
 *
 * 以「常用设置」的两个开关为锚点：closeToTray / singleInstance 都属 common tab，
 * 且目录 itemKey 与标题文案一致，便于断言。
 */

/** 定位某行标题文本对应的开关：SettingRow 是 div.grid，标题 + Switch 在同一行内。 */
function switchInRow(scope: Locator, label: string): Locator {
	return scope.locator("div.grid").filter({ hasText: label }).last().getByRole("switch");
}

test("改回原值后关闭不弹未保存确认", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();

	const sw = switchInRow(modal, "关闭窗口时隐藏到系统托盘");
	const before = await sw.getAttribute("aria-checked");
	await sw.click();
	await sw.click();
	expect(await sw.getAttribute("aria-checked")).toBe(before);

	// 无真实差异：直接关闭，不出现「未保存的更改」确认框
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await expect(modal).toHaveCount(0);
	await expect(window.getByRole("alertdialog")).toHaveCount(0);
});

test("单项变更时关闭弹确认并点名变更项", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();

	const sw = switchInRow(modal, "关闭窗口时隐藏到系统托盘");
	const before = await sw.getAttribute("aria-checked");
	await sw.click();
	expect(await sw.getAttribute("aria-checked")).not.toBe(before);

	await modal.getByRole("button", { name: "关闭" }).first().click();

	const dialog = window.getByRole("alertdialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("未保存的更改");
	await expect(dialog).toContainText("关闭窗口时隐藏到系统托盘");

	// 放弃更改关闭
	await dialog.getByRole("button", { name: "放弃更改" }).click();
	await expect(modal).toHaveCount(0);
});

test("配置管理：修改后关闭弹确认并点名变更项", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await openConfigPane(window);
	const modal = window.locator(".config-modal");
	await expect(modal).toBeVisible();

	// 默认「模型」tab：新增一个供应商 = 真实脏变更
	await modal.getByRole("button", { name: "+ 添加供应商" }).click();
	const nameInput = modal.getByPlaceholder("供应商名称，如 openai");
	await nameInput.fill("e2e-provider");
	await modal.getByRole("button", { name: "确认" }).click();

	await modal.getByRole("button", { name: "关闭" }).first().click();

	const dialog = window.getByRole("alertdialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("未保存的更改");
	await expect(dialog).toContainText("模型");

	await dialog.getByRole("button", { name: "放弃更改" }).click();
	await expect(modal).toHaveCount(0);
});

test("多项变更时关闭确认列出全部变更项", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await openSettings(window);
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();

	await switchInRow(modal, "关闭窗口时隐藏到系统托盘").click();
	await switchInRow(modal, "单实例运行（复用窗口）").click();

	await modal.getByRole("button", { name: "关闭" }).first().click();

	const dialog = window.getByRole("alertdialog");
	await expect(dialog).toBeVisible();
	await expect(dialog).toContainText("以下 2 项有未保存的更改");
	// 列表应逐条点名两个变更项
	const list = dialog.locator("ul");
	await expect(list.getByText("关闭窗口时隐藏到系统托盘")).toBeVisible();
	await expect(list.getByText("单实例运行（复用窗口）")).toBeVisible();

	await dialog.getByRole("button", { name: "放弃更改" }).click();
	await expect(modal).toHaveCount(0);
});
