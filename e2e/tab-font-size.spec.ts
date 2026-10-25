import type { Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";

test.use({
	seedSettings: {
		// 跳过首次启动的 pi 环境检测引导弹窗（会遮挡侧栏设置入口）
		piEnvironmentChecked: true,
		defaultAgentBackend: "pi",
	},
});

/** 同时断言激活/非激活 Tab 和其标题，禁止在没有 Tab 时静默跳过消费链验证。 */
async function expectTabFontSize(window: Page, fontSize: string, lineHeight: string): Promise<void> {
	const tabs = window.locator('.session-tabs-bar .session-tab[role="tab"]');
	const titles = tabs.locator("strong");
	await expect(tabs).toHaveCount(2);
	await expect(titles).toHaveCount(2);
	await expect(window.locator('.session-tabs-bar .session-tab[aria-selected="true"]')).toHaveCount(1);
	await expect(window.locator('.session-tabs-bar .session-tab[aria-selected="false"]')).toHaveCount(1);
	for (let index = 0; index < 2; index += 1) {
		await expect(tabs.nth(index)).toHaveCSS("font-size", fontSize);
		await expect(titles.nth(index)).toHaveCSS("font-size", fontSize);
		// 行高走 leading-(--line-height-tab) 简写：该 utility 拼写无效时 Tailwind 静默不产出，必须实测。
		await expect(titles.nth(index)).toHaveCSS("line-height", lineHeight);
	}
}

/**
 * 会话 Tab 栏字号：真实标题的实时预览 + 放弃回滚 + 保存后即时生效。
 * 使用隔离 profile 与 mock pi，不访问真实模型。必须先创建两个 Tab，再检查计算样式。
 * 仅断言 dataset/token 会漏掉 cn 把 text-tab 当颜色类、被状态颜色合并删除的回归。
 */
test("tab bar font size change applies immediately after save", async ({ window }) => {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

	// 欢迎页发送登记首个 Tab；第二个用「+」建立草稿，覆盖激活与非激活两种文字颜色。
	const composer = window.locator(".composer .rich-input").first();
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.insertText("Tab 字号回归");
	await window.keyboard.press("Enter");
	await expect(window.locator(".session-tab")).toHaveCount(1);
	await window.locator(".session-tabs-new").click();
	await window.getByRole("menuitem").first().click();
	await expect(window.locator('.session-tab[aria-selected="true"]')).toHaveCount(1);
	await expect(window.locator('.session-tab[aria-selected="false"]')).toHaveCount(1);

	// 默认未单独设置：跟随界面字号 medium（12px）
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "medium");
	await expect(await window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-size-tab").trim())).toBe("12px");
	await expectTabFontSize(window, "12px", "18px");

	await window.getByRole("button", { name: /^设置/ }).click();
	const modal = window.locator(".settings-modal");
	await expect(modal).toBeVisible();

	await modal.getByText("外观设置").click();

	// 「自定义各区域字号」开关：开启后才渲染 界面/Tab 栏/会话/输入 字号四行
	const perAreaSwitch = modal.locator("div.min-h-\\[54px\\]").filter({ hasText: "自定义各区域字号" }).getByRole("switch");
	if (!(await perAreaSwitch.isChecked())) {
		await perAreaSwitch.click();
	}

	// 「会话 Tab 栏字号」行（SettingRow 网格）内的 Select trigger
	const row = modal.locator("div.min-h-\\[54px\\]").filter({ hasText: "会话 Tab 栏字号" });
	await expect(row).toHaveCount(1);
	await row.getByRole("combobox").click();

	// Radix Select 弹层 portal 到 body
	await window.getByRole("option", { name: "紧凑" }).click();

	// 实时预览：选档位后、保存前，两个真实标题立即变化。
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "compact");
	await expect(await window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-size-tab").trim())).toBe("10px");
	await expectTabFontSize(window, "10px", "15px");

	// 放弃回滚：改「特大」（未保存）→ 关闭弹窗 → 选「放弃更改」→ 预览回滚为打开弹窗时的快照 medium
	// （compact 只选过未保存，快照始终是 medium）
	await row.getByRole("combobox").click();
	await window.getByRole("option", { name: "特大" }).click();
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "xlarge");
	await expectTabFontSize(window, "14px", "20px");
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await window.getByRole("button", { name: "放弃更改" }).click();
	await expect(modal).toHaveCount(0);
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "medium");
	await expectTabFontSize(window, "12px", "18px");

	// 重新打开：改为「大」并保存，验证保存链（onSettingsApplied → useAppAppearance 接管）。
	// 快照里各区域字号均为 null，重开弹窗时「自定义各区域字号」开关回到关，需重新打开
	await window.getByRole("button", { name: /^设置/ }).click();
	await expect(modal).toBeVisible();
	await modal.getByText("外观设置").click();
	if (!(await perAreaSwitch.isChecked())) {
		await perAreaSwitch.click();
	}
	await row.getByRole("combobox").click();
	await window.getByRole("option", { name: "大", exact: true }).click();
	await modal.getByRole("button", { name: "保存" }).click();

	// 保存后即时生效：dataset 档位 + CSS 变量计算值同时更新为大档 13px
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "large");
	await expect(await window.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--font-size-tab").trim())).toBe("13px");
	await expectTabFontSize(window, "13px", "19px");

	// 关闭弹窗后两个真实标题仍保持保存后的字号。
	await modal.getByRole("button", { name: "关闭" }).first().click();
	await expect(modal).toHaveCount(0);
	await expect(window.locator("html")).toHaveAttribute("data-tab-font-size", "large");
	await expectTabFontSize(window, "13px", "19px");
});
