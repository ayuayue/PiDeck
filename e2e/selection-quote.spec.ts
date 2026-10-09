import { test, expect } from "./mock-pi-fixture";
import type { Locator, Page } from "@playwright/test";

/**
 * 划选引用浮层的跨段落回归（用户反馈：「引用中间结果/最终回答时，跨段落没办法引用」）。
 *
 * 为什么必须在这一层守（只有真跑起来才能证明的那部分）：
 * 浮层展示后由 rAF 跟随循环逐帧校验「实时选区是否仍是同一段文本」，而 Chromium 的
 * `Selection.toString()` 会在块级边界补 `\n\n`（`<p>` / `<li>` / 代码块之间），
 * `Range.toString()` 只按文本节点顺序拼接、不留块分隔——跨段落划选时两个字符串必然不等。
 * 只比纯函数（tests/selectionToolbarPolicy.test.mjs 的 isQuotableRange）永远测不到这个分叉：
 * 判定函数返回 true、浮层也确实展示了，但下一帧就被自己撤掉，用户根本点不到按钮。
 *
 * 断言设计：
 * 1. 段内划选（对照）：两侧字符串恰好相等 → 浮层必须存活（修复不能把它弄坏）；
 * 2. 跨段落划选：浮层必须「出现后还活着」（等到十几帧之后再断言，抓「闪一下就没了」）；
 * 3. 点击插入 → 发送 → 用户气泡里的引用 chip title 必须保留两段之间的段落换行，
 *    证明跨段落原文完整带进了引用。
 */

/** 等待合成器可用（UI 2.0 首次输入即激活 runtime，同 session-history-mutation.spec.ts）。 */
async function startComposer(window: Page): Promise<Locator> {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

/**
 * 真实鼠标拖选（必须走真实指针事件：浮层评估挂在容器 pointerup 上）。
 * 从 startX 拖到 endX，两端都在同一行的垂直中线上。
 */
async function dragSelect(window: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	await window.mouse.move(from.x, from.y);
	await window.mouse.down();
	await window.mouse.move(to.x, to.y, { steps: 12 });
	await window.mouse.up();
}

/** 当前浏览器选区文本（用于断言这次的拖选真的是跨段落，而不是退化成段内选区）。 */
function selectedText(window: Page): Promise<string> {
	return window.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** 浮层必须存活：出现后等到「下一轮 rAF 早就跑过」的时长再复检一次。 */
async function expectToolbarSurvives(window: Page, toolbar: Locator) {
	await expect(toolbar).toBeVisible({ timeout: 5_000 });
	// 60ms 延迟评估 + 每帧跟随循环：600ms 足够跑完十几帧，被误撤的话这里必然已经不可见。
	await window.waitForTimeout(600);
	await expect(toolbar).toBeVisible();
}

test("selection quote: cross-paragraph selection keeps the toolbar and quotes the full text", async ({ window }) => {
	test.setTimeout(180_000);
	const composer = await startComposer(window);
	const timeline = window.locator(".message-timeline");

	// MDEMO 让 mock pi 回复多段落富文本；最终回答常驻（大折叠栏外），带 data-message-id 锚点。
	await composer.click();
	await window.keyboard.type("MDEMO 跨段落引用回归");
	await window.keyboard.press("Enter");
	const answer = window.locator(".message-timeline [data-final-answer]").last();
	await expect(answer).toContainText("以下是渲染元素巡检", { timeout: 30_000 });
	// 只验证 settled 正文：本轮跑完 + live 副本已卸载 + 让结算期自动定位流水线走完
	await expect(timeline.locator(".turn-row--complete")).toHaveCount(1, { timeout: 60_000 });
	await expect(timeline.locator("[data-live-answer]")).toHaveCount(0, { timeout: 30_000 });
	await window.waitForTimeout(1_200);

	const paragraphs = answer.locator("p");
	const toolbar = window.locator("[data-quote-toolbar]");
	// 两段必须同时在视口内（boundingBox 是视口坐标，鼠标事件落在视口外就选不中文本）
	await paragraphs.nth(0).scrollIntoViewIfNeeded();
	await paragraphs.nth(1).scrollIntoViewIfNeeded();
	const firstBox = (await paragraphs.nth(0).boundingBox())!;
	const secondBox = (await paragraphs.nth(1).boundingBox())!;
	expect(firstBox.y, "第一段必须落在视口内").toBeGreaterThan(0);
	expect(secondBox.y, "第二段必须落在视口内").toBeGreaterThan(0);

	// —— 对照：段内划选（不跨块级边界，两侧 toString 相等）——
	await dragSelect(window, { x: secondBox.x + 20, y: secondBox.y + secondBox.height / 2 }, { x: secondBox.x + 120, y: secondBox.y + secondBox.height / 2 });
	expect(await selectedText(window), "对照组必须是不跨段的选区").not.toContain("\n");
	await expectToolbarSurvives(window, toolbar);
	await window.keyboard.press("Escape");
	await expect(toolbar).toHaveCount(0);

	// —— 回归点：跨段落划选（起点在第一段正文内、终点在第二段正文内）——
	await dragSelect(window, { x: firstBox.x + 20, y: firstBox.y + firstBox.height / 2 }, { x: secondBox.x + 200, y: secondBox.y + secondBox.height / 2 });
	// 自校验：拖选真的跨了块级边界（否则本用例会退化成上面的对照组，测不到本 bug）
	expect(await selectedText(window), "回归组必须是真正的跨段落选区").toMatch(/.+\n+.+/s);
	await expectToolbarSurvives(window, toolbar);

	await toolbar.click();
	const quoteChip = window.locator(".composer .input-chip--quote");
	await expect(quoteChip).toHaveCount(1, { timeout: 5_000 });

	// 发送后：引用块被解析回 chip，title 带快照全文——跨段落原文必须连空行一起保留。
	await composer.click();
	await window.keyboard.type("这段怎么理解？");
	await window.keyboard.press("Enter");
	const bubbleChip = window.locator(".user-turn .input-chip--quote").last();
	await expect(bubbleChip).toBeVisible({ timeout: 30_000 });
	const quoted = (await bubbleChip.getAttribute("title")) ?? "";
	expect(quoted).toContain("渲染元素巡检");
	expect(quoted).toContain("修改了 src/main/index.ts");
	// 段落换行必须落在两段之间（markdown 段落间距归零时为 1 个 \n，带块间距时为 2 个，
	// 所以只断言「至少一个换行」；用 JSON 形态断言便于失败时看到真实字符）。
	expect(JSON.stringify(quoted)).toMatch(/渲染元素巡检[：:](?:\\n)+修改了/);
	// 展开后的 XML 原文不得出现在气泡里（chip 折叠链路完整）
	await expect(window.locator(".user-turn").last()).not.toContainText("quoted_context");
});
