import { test, expect } from "./mock-pi-fixture";
import { settleStartupOverlays } from "./startupOverlays";
import type { Locator, Page } from "@playwright/test";

/**
 * Composer ↑/↓ 历史回填的「视觉行边界」端到端验证（真机 Chromium 布局）。
 *
 * 为什么必须走 e2e：这条规则依赖**真实软换行**——一行超长文本折成 N 个视觉行时，
 * ↑ 必须先把光标逐行上移（N-1 次草稿不变），到首视觉行后再按一次才回填历史。
 * 单元测试只能用 stub 注入 atVisualTop/atVisualBottom，行盒测量本身（ProseMirror
 * 的 endOfTextblock + getClientRects）只有真机才跑得到，缩放/字号也在这里才真实。
 *
 * 回归前（只判逻辑行）的行为：整段没有 \n 被当成「首行」，第一次 ↑ 就回填历史。
 */

const HISTORY_PROMPT = "e2e 历史消息";
const SHORT_DRAFT = "e2e short draft";
// 安全字母表：不含 @ / & / 斜杠，避免触发 chip 与命令解析；足够长以保证多视觉行
const LONG_DRAFT = Array.from({ length: 70 }, (_, index) => `wrap${index}`).join(" ");

async function startComposer(window: Page): Promise<Locator> {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await settleStartupOverlays(window);
	return composer;
}

/**
 * 写入草稿：用 insertText 一次原子插入，不用逐键打字。
 * 逐键在真实窗口里会被「启动浮层抢焦点」这类与输入框无关的事件吞掉字符，
 * 而本用例只关心文字进去之后的 ↑/↓ 行为。
 */
async function fillDraft(window: Page, composer: Locator, text: string): Promise<void> {
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	await composer.click();
	await window.keyboard.press("Control+a");
	await window.keyboard.press("Delete");
	await composer.click();
	await window.keyboard.insertText(text);
	expect(await draftText(composer), "草稿写入必须完整（否则用例前提不成立）").toBe(text);
}

/** 发一条历史消息（mock pi 回包后本轮结束、composer 回到空闲）。 */
async function sendHistoryPrompt(window: Page, composer: Locator): Promise<void> {
	// 新会话的首键会预热/启动 runtime，composer 可能瞬时 disabled 导致字符被丢：
	// 输入后核对草稿，没进去就重新来一次（不依赖固定等待）。
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
		await composer.click();
		await window.keyboard.type(HISTORY_PROMPT);
		if ((await draftText(composer)) === HISTORY_PROMPT) break;
		await window.keyboard.press("Control+a");
		await window.keyboard.press("Delete");
		await window.waitForTimeout(400);
	}
	expect(await draftText(composer), "历史消息必须先完整进草稿，否则本用例前提不成立").toBe(HISTORY_PROMPT);
	// 冷启动第一次发送可能碰上 runtime 正在启动 / 焦点被启动浮层抢走：
	// 先确认焦点，再发；没等到回包就重试一次（草稿仍在，不会重复发送）。
	for (let attempt = 1; attempt <= 2; attempt += 1) {
		await composer.click();
		await expect(composer, "发送前焦点必须在输入框").toBeFocused();
		await window.keyboard.press("Enter");
		try {
			await expect(window.locator(".message-timeline")).toContainText(`Mock 回复：「${HISTORY_PROMPT}」`, { timeout: 15_000 });
			break;
		} catch (error) {
			if (attempt === 2) throw error;
		}
	}
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 10_000 });
}

/** 草稿纯文本（composer 只渲染一个段落，textContent 即草稿）。 */
const draftText = (composer: Locator): Promise<string> => composer.evaluate((el) => el.textContent ?? "");

/**
 * 软换行后的视觉行数。
 * 注意：Chromium 的 range.getClientRects() 会把**整个 range 的包围盒**也放进来
 * （实测高度 = 行数 × 行高），必须按「最矮的矩形 = 一行」过滤掉它，
 * 否则行数会多算 1。用实测高度而不是 getComputedStyle().lineHeight：后者不随缩放变化。
 */
async function visualRows(composer: Locator): Promise<number> {
	return composer.evaluate((el) => {
		const range = document.createRange();
		range.selectNodeContents(el);
		const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0 && rect.width > 0);
		const rowHeight = Math.min(...rects.map((rect) => rect.height));
		const rows = rects.filter((rect) => rect.height <= rowHeight * 1.5);
		return new Set(rows.map((rect) => Math.round(rect.top))).size;
	});
}

/** 合成 keydown：真机无法驱动输入法引擎，只能覆盖 isComposing 判定口本身。 */
async function dispatchComposerKeydown(window: Page, init: { isComposing?: boolean }): Promise<void> {
	await window.evaluate((options) => {
		const el = document.querySelector(".composer .rich-input");
		if (!el) throw new Error("composer not found");
		el.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true, ...options }));
	}, init);
}

/**
 * 核心流程：输入超长单行草稿 → 光标在末视觉行逐行上移（每次草稿必须不变）
 * → 到首视觉行后再按一次才回填 → ↓ 还原被打断的草稿。
 */
async function expectEdgeFirstArrowUp(window: Page, composer: Locator): Promise<void> {
	await sendHistoryPrompt(window, composer);
	await fillDraft(window, composer, LONG_DRAFT);

	const rows = await visualRows(composer);
	// 前提校验：没有软换行这条用例就没有意义（缩放变小/窗口更宽都会减少行数）
	expect(rows, "长草稿必须软换行成多个视觉行").toBeGreaterThanOrEqual(3);

	// 光标到文本末尾（末视觉行）
	await window.keyboard.press("End");

	// 核心回归：第一次 ↑ 只能上移光标（修复前整段无 \n 被判成首行，这里就回填了）
	await window.keyboard.press("ArrowUp");
	expect(await draftText(composer), "末视觉行的 ↑ 只能上移光标").toBe(LONG_DRAFT);

	// 继续逐行上移，直到回填。
	// 不断言「第 N 次正好回填」：本用例的视觉行数是用 range 矩形量的，而 Chromium 在软换行
	// 断点上的 collapsed-range rect 会报告上一行（PM 的 endOfTextblock 用 side=1 偏向下一行），
	// 两边在断点处可能差一行。因此只锁「必须先爬完视觉行才允许回填」+「不会无休止地不回填」。
	let presses = 1;
	while (presses < rows + 2) {
		await expect(composer, "按键期间焦点必须留在输入框").toBeFocused();
		await window.keyboard.press("ArrowUp");
		presses += 1;
		if ((await draftText(composer)) !== LONG_DRAFT) break;
	}
	expect(presses, "↑ 必须先走完视觉行才允许回填").toBeGreaterThanOrEqual(rows);
	expect(presses, "↑ 不能一直不回填").toBeLessThanOrEqual(rows + 2);
	expect(await draftText(composer)).toBe(HISTORY_PROMPT);

	// 浏览态在末视觉行按 ↓：还原被历史打断的草稿（证明 stash 生效）
	await window.keyboard.press("ArrowDown");
	expect(await draftText(composer)).toBe(LONG_DRAFT);
}

test.describe("composer 历史回填的视觉行边界", () => {
	test("100% 缩放：软换行草稿逐行上移，到首视觉行才回填，且守卫齐全", async ({ window }) => {
		test.setTimeout(150_000);
		const composer = await startComposer(window);
		await expectEdgeFirstArrowUp(window, composer);

		// --- Shift+↑ 守卫：扩选不得被历史回填劫持 ---
		await window.keyboard.press("Shift+ArrowUp");
		expect(await draftText(composer), "Shift+↑ 必须扩选而不是回填").toBe(LONG_DRAFT);
		expect(await window.evaluate(() => window.getSelection()?.toString() ?? "")).not.toBe("");

		// --- IME 合成态守卫 ---
		// 换成单视觉行草稿：光标必在首视觉行，历史回填条件成立，才能验证守卫本身。
		await fillDraft(window, composer, SHORT_DRAFT);

		// A/B 前提：同形状的非合成事件确实会走到 composer 的 keydown 处理器并回填
		await dispatchComposerKeydown(window, {});
		expect(await draftText(composer), "非合成态 ↑ 应回填（证明事件路径可达）").toBe(HISTORY_PROMPT);
		await window.keyboard.press("ArrowDown");
		expect(await draftText(composer)).toBe(SHORT_DRAFT);

		await dispatchComposerKeydown(window, { isComposing: true });
		expect(await draftText(composer), "合成态 ↑ 不得回填历史").toBe(SHORT_DRAFT);
	});

	test.describe("150% 缩放", () => {
		test.use({ seedSettings: { zoomFactor: 1.5 } });
		test("放大后视觉行判定不变（行盒容差与缩放无关）", async ({ window }) => {
			test.setTimeout(150_000);
			const composer = await startComposer(window);
			await expectEdgeFirstArrowUp(window, composer);
		});
	});

	test.describe("80% 缩放", () => {
		test.use({ seedSettings: { zoomFactor: 0.8 } });
		test("缩小后视觉行判定不变（行盒容差与缩放无关）", async ({ window }) => {
			test.setTimeout(150_000);
			const composer = await startComposer(window);
			await expectEdgeFirstArrowUp(window, composer);
		});
	});
});
