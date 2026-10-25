import { expect, test } from "./mock-pi-fixture";

/**
 * 收藏页：详情抽屉 + 批量删除（用户需求「点击详情做成弹窗渲染、加批量删除」）。
 *
 * 用 seedFavorites 直接写 <userData>/favorites.json，绕开「必须先发一条消息才能收藏」的造数成本；
 * 收藏正文故意用不同长度的 Markdown，验证抽屉里是渲染后的正文而不是列表里的纯文本摘要。
 */
// 注意：>=2 个种子必须函数式覆盖，否则 Playwright 会把数组当 [value, options] 元组截断。
const SEED_FAVORITES = [
	{ id: "fav-alpha", text: "## Alpha 标题\n\n第一条收藏的**完整正文**，列表里只显示纯文本摘要。", sessionTitle: "会话 Alpha" },
	{ id: "fav-beta", text: "第二条收藏：划选片段原文，保留换行。", kind: "selection" as const, role: "assistant" as const, sessionTitle: "会话 Beta" },
];
test.use({ seedFavorites: async ({}, use) => use(SEED_FAVORITES) });

test("收藏详情用右侧抽屉渲染，Esc 只关抽屉不关页面", async ({ window }) => {
	await window.getByRole("button", { name: "收藏" }).click();
	await expect(window.getByRole("heading", { name: "收藏" })).toBeVisible();

	// 卡片 aria-label 固定为「查看详情」，正文不在可访问名里（列表里两条卡片同名）。
	const alphaCard = window.getByRole("button", { name: "查看收藏详情" }).first();
	await alphaCard.click();

	// 抽屉挂在 body 上（portal），面板是 role=dialog + data-* 标记；背板同标记但无 role。
	const drawer = window.locator('[data-favorite-detail-drawer][role="dialog"]');
	await expect(drawer).toBeVisible();
	await expect(drawer.getByText("Alpha 标题")).toBeVisible();
	await expect(drawer.getByText("会话 Alpha")).toBeVisible();
	// 正文走 MarkdownStream：标题渲染成 h2，而不是 ## 源码
	await expect(drawer.locator("h2", { hasText: "Alpha 标题" })).toBeVisible();

	await window.keyboard.press("Escape");
	await expect(drawer).toHaveCount(0);
	// 页面级 Esc 没被顺带触发：收藏页仍在
	await expect(window.getByRole("heading", { name: "收藏" })).toBeVisible();
});

test("批量删除：全选当前列表 → 确认 → 清空", async ({ window }) => {
	await window.getByRole("button", { name: "收藏" }).click();
	await expect(window.getByRole("heading", { name: "收藏" })).toBeVisible();

	await window.getByRole("button", { name: "批量", exact: true }).click();
	const bar = window.getByRole("group", { name: "批量选择" });
	await expect(bar).toBeVisible();
	await expect(bar.getByText("已选 0 项")).toBeVisible();

	await bar.getByRole("button", { name: "全选" }).click();
	await expect(bar.getByText("已选 2 项")).toBeVisible();

	// 删除所选 → 确认框（batchDeleteBody 带条数）
	await bar.getByRole("button", { name: "删除选中" }).click();
	const dialog = window.getByRole("alertdialog");
	await expect(dialog.getByText("批量删除收藏")).toBeVisible();
	await expect(dialog.getByText("2 条收藏")).toBeVisible();
	await dialog.getByRole("button", { name: "删除" }).click();

	// 列表清空回到空态；批量条随列表清空自动退出
	await expect(window.getByText("还没有收藏")).toBeVisible();
	await expect(window.getByRole("group", { name: "批量选择" })).toHaveCount(0);

	// 落盘也清了：重开页面仍是空态（刷新数据源）
	await window.getByRole("button", { name: "收藏" }).click();
	await expect(window.getByText("还没有收藏")).toBeVisible();
});
