import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";

/**
 * 配置管理里的供应商列表搜索：「模型」与「认证」两页各一个关键词过滤框。
 *
 * e2e 沙箱没有 models.json / auth.json，所以先经 UI 建数据再验证过滤。两页的搜索框都只在列表非空时
 * 渲染；认证页额外要认预设展示名（provider 名是 google、展示名是 Google Gemini）。
 *
 * 定位说明：设置入口可能是弹窗也可能是整页 tab（两种形态都出现过），所以这里不 assume `role=dialog`，
 * 一律用 window 级定位；`.config-layout` / `.settings-modal` 这类容器类名也不作为锚点。
 */
async function openConfigPane(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("button", { name: "设置", exact: true }).first().click();
	// 顶层「配置管理」入口：弹窗版与整页版分别渲染成 tab / button，认哪个都行。
	const configEntry = window
		.getByRole("tab", { name: "配置管理", exact: true })
		.or(window.getByRole("button", { name: "配置管理", exact: true }))
		.first();
	await expect(configEntry).toBeVisible({ timeout: 20_000 });
	await configEntry.click();
	// 配置页骨架：左侧「配置文件」里的模型/认证子页签。
	await expect(window.getByRole("tab", { name: "认证", exact: true })).toBeVisible({ timeout: 20_000 });
}

async function addAuth(window: Page, preset: string) {
	await window.getByRole("button", { name: "+ 添加认证", exact: true }).click();
	// 预设卡片是 button，可访问名 = 展示名 + provider 名（如「Google Gemini google」）。
	await window
		.getByRole("button", { name: new RegExp(preset) })
		.first()
		.click();
	await window.getByRole("button", { name: "添加选中供应商", exact: true }).click();
}

async function addProvider(window: Page, name: string) {
	await window.getByRole("button", { name: "+ 添加供应商", exact: true }).click();
	const page = window.locator(".provider-add-page");
	await expect(page).toBeVisible();
	await page.getByRole("textbox", { name: "供应商名称", exact: true }).fill(name);
	await page.getByRole("textbox", { name: "Base URL", exact: true }).fill("https://example.com/v1");
	await page.getByRole("button", { name: "+ 手动添加", exact: true }).click();
	await page.getByPlaceholder("model-id", { exact: true }).fill(`${name}-model`);
	await page.getByRole("button", { name: "添加", exact: true }).click();
	await expect(page).toHaveCount(0);
}

test("配置管理：认证列表按关键词过滤（含预设展示名），清空恢复", async ({ window }) => {
	await openConfigPane(window);
	await window.getByRole("tab", { name: "认证", exact: true }).click();
	await addAuth(window, "OpenAI");
	await addAuth(window, "Google Gemini");

	const cards = window.locator("[data-provider-head]");
	await expect(cards).toHaveCount(2);

	const search = window.getByPlaceholder("搜索供应商");
	await expect(search).toBeVisible();

	// 用展示名「gemini」命中 provider 名是 google 的卡片：只按 provider 名匹配的话这里会搜不到。
	await search.fill("gemini");
	await expect(cards).toHaveCount(1);
	await expect(cards.first()).toContainText("google");
	await expect(window.getByText("1 / 2")).toBeVisible();

	await search.fill("zzz");
	await expect(cards).toHaveCount(0);
	await expect(window.getByText("没有匹配的供应商")).toBeVisible();

	await search.fill("");
	await expect(search).toHaveValue("");
	await expect(cards).toHaveCount(2);
});

test("配置管理：模型列表按供应商名过滤，清空恢复", async ({ window }) => {
	await openConfigPane(window);
	await window.getByRole("tab", { name: "模型", exact: true }).click();
	await addProvider(window, "alpha-gw");
	await addProvider(window, "beta-gw");

	const cards = window.locator("[data-provider-head]");
	await expect(cards).toHaveCount(2);

	const search = window.getByPlaceholder("搜索供应商");
	await expect(search).toBeVisible();

	await search.fill("ALPHA");
	await expect(cards).toHaveCount(1);
	await expect(cards.first()).toContainText("alpha-gw");
	await expect(window.getByText("1 / 2")).toBeVisible();

	await search.fill("zzz");
	await expect(cards).toHaveCount(0);
	await expect(window.getByText("没有匹配的供应商")).toBeVisible();

	await search.fill("");
	await expect(cards).toHaveCount(2);
});
