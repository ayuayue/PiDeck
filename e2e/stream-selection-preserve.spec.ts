import { test, expect } from "./mock-pi-fixture";
import type { Locator, Page } from "@playwright/test";

/**
 * 流式正文划选保持的端到端回归（用户反馈：「在渲染中的，选中会被清理，导致无法在回复中的时候选中一些文本」）。
 *
 * 为什么只能在这一层守：选区生命周期由 Chromium 的 DOM Selection 与 React 的提交时机共同决定——
 * MarkdownStream 每帧（打字机 ~8ms）重渲染，冻结前缀每推进一个块边界就把尾部子树整体重挂
 * （key = generation:prefixEnd），settle 时 live 副本又被 settled 副本替换。Chromium 在选区覆盖的
 * 文本节点被移除时会把 Selection 折叠掉或重锚到父元素整段文本，纯函数测不到这一层。
 *
 * 真机基线与两处额外根因（修复目标，见对应实现）：
 * 1) 拖选过程本身就丢选区：按下到松开之间来了一个 chunk，文本节点重挂，浏览器当场把拖选收掉，
 *    pointerup 拿到的已是折叠选区（快照都拍不到）→ live 正文在划选期间冻结渲染文本
 *    （useHoldTextWhileSelecting）。
 * 2) 还原端点跨块：偏移正好落在文本节点边界时，起点被映射到行头 <time> 的末尾，
 *    Selection.toString() 多出块级换行（'以下是' → '\n以下是'）→ 起点偏下一个文本节点、
 *    终点偏上一个文本节点（selectionTextOffsets 的 pointAtTextOffset）。
 *
 * 交互注意：量段落坐标与读选区都必须走 page.evaluate。Playwright 的
 * locator.scrollIntoViewIfNeeded()/boundingBox() 会在 React 重挂流式段落时抛
 * 「Element is not attached to the DOM」——流式节点不能用 locator 动作。
 *
 * mock 行为见 e2e/mock-pi.cjs：prompt 含 "SLOW" → 220ms × 18 个 chunk（≈4s）；含 "MDEMO" →
 * 多段落 + 代码块 + 表格 + mermaid 的富文本回复，块边界推进制造真实的尾部重挂。
 */

async function startComposer(window: Page): Promise<Locator> {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

/** 真实鼠标拖选：选区保持/冻结都挂在真实 pointer 事件语义上（pointerdown 清快照并冻结正文）。 */
async function dragSelect(window: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	await window.mouse.move(from.x, from.y);
	await window.mouse.down();
	await window.mouse.move(to.x, to.y, { steps: 12 });
	await window.mouse.up();
}

/** Selection.toString()：用户实际看到/复制到的高亮文本（跨块级边界时 Chromium 会补 \n）。 */
function selectedText(window: Page): Promise<string> {
	return window.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** Range.toString()：与 lib/selectionTextOffsets 的校验口径一致（纯文本节点拼接，不补块级分隔）。 */
function selectedRangeText(window: Page): Promise<string> {
	return window.evaluate(() => {
		const selection = window.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) return "";
		return selection.getRangeAt(0).toString();
	});
}

type ParagraphRect = { x: number; y: number; width: number; height: number };

/**
 * 量当前 live 正文第一个段落的视口坐标（一步 evaluate：取节点 → 滚到中间 → 读 rect）。
 * 不用 locator：流式段落每个块边界都会重挂，locator 的等待/滚动动作会因节点脱离 DOM 直接失败。
 */
function liveParagraphRect(window: Page): Promise<ParagraphRect | null> {
	return window.evaluate(() => {
		const liveAnswers = document.querySelectorAll<HTMLElement>(".message-timeline [data-live-answer]");
		const live = liveAnswers[liveAnswers.length - 1];
		const paragraph = live?.querySelector<HTMLElement>("p");
		if (!paragraph) return null;
		try {
			paragraph.scrollIntoView({ block: "center" });
		} catch {
			// 段落正被 React 重挂：下一轮 poll/重试再来
			return null;
		}
		const rect = paragraph.getBoundingClientRect();
		if (rect.width < 40 || rect.height <= 0) return null;
		// 必须完整落在视口内，否则鼠标事件会点到视口外，选不中文字
		if (rect.top < 8 || rect.bottom > window.innerHeight - 8) return null;
		return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
	});
}

/**
 * 选区文本是否适合当「稳定短语」基线：
 * 非空、不含块级换行（必须落在同一段内，否则 Selection.toString() 带 \n，settle 前后不可比）、
 * 不含会被 markdown 渲染掉的语法字符（settle 后原文不存在时选区本该收起，不属于本 bug）、
 * 长度上限（拖 42px 只该选中 2-4 个字；一下子选中大半段说明拖选期间就被 churn 重锚了）。
 */
function isStablePhraseText(text: string): boolean {
	return text.trim().length > 0 && text.length <= 24 && !text.includes("\n") && !/[`*_#|>[\]]/.test(text);
}

/** 读一次选区，跨过一个 chunk 的渲染后再读一次：两次逐字一致才算稳定基线（不稳定就重试）。 */
async function readStableSelection(window: Page): Promise<string | null> {
	const first = await selectedText(window);
	if (!isStablePhraseText(first)) return null;
	await window.waitForTimeout(140);
	const second = await selectedText(window);
	if (second !== first) return null;
	return first;
}

/** 在 live 正文第一个段落里拖出稳定的段内选区；返回校验过的基线文本。 */
async function selectStablePhrase(window: Page): Promise<string> {
	await expect.poll(async () => (await liveParagraphRect(window)) !== null, { timeout: 30_000, intervals: [100, 200, 400] }).toBe(true);
	let last = "";
	for (let attempt = 0; attempt < 8; attempt += 1) {
		const rect = await liveParagraphRect(window);
		if (rect) {
			const y = rect.y + rect.height / 2;
			// 只拖段落开头的 ~44px：落在纯正文里，避免拖到行内代码/链接等 markdown 结构上
			await dragSelect(window, { x: rect.x + 2, y }, { x: rect.x + Math.min(rect.width - 2, 44), y });
			const stable = await readStableSelection(window);
			if (stable) return stable;
			last = await selectedText(window);
		}
		await window.waitForTimeout(150);
	}
	throw new Error(`拖不出稳定的段内选区（最后一次：${JSON.stringify(last)}）`);
}

/**
 * 发一条 SLOW MDEMO 并返回 live 正文容器。
 *
 * 选段策略：只等第一个块「以下是渲染元素巡检：」出现（≈0.2-0.5s，整条流共 ~4s），把剩下的
 * ~3.5s 全部留给等待窗口。此刻整条回答只有 tail 块（prefixEnd=0，整树同一渲染单元），第一个
 * 块边界推进（代码块/表格/mermaid）就会触发整树重挂——正是要把选区挤掉的 churn。选第一个段落
 * 而不是最后一个：它的文本此刻已完整、settle 前后逐字不变，锚点稳定、重试时也总是同一段。
 */
async function startSlowMarkdownStream(window: Page): Promise<{ liveAnswer: Locator }> {
	const composer = await startComposer(window);
	const timeline = window.locator(".message-timeline");
	await composer.click();
	await window.keyboard.type("SLOW MDEMO 选中保持回归");
	await window.keyboard.press("Enter");
	const liveAnswer = timeline.locator("[data-live-answer]").last();
	await expect(liveAnswer).toBeVisible({ timeout: 30_000 });
	// 等第一个块出现即开始选（理由见函数头注释）：第一个段落文本完整、settle 前后逐字不变
	await expect(liveAnswer).toContainText("以下是渲染元素巡检", { timeout: 30_000 });
	return { liveAnswer };
}

test("selection inside a streaming answer survives the markdown DOM churn", async ({ window }) => {
	test.setTimeout(180_000);
	const { liveAnswer } = await startSlowMarkdownStream(window);

	const initialSelection = await selectStablePhrase(window);
	const initialRangeText = await selectedRangeText(window);
	expect(initialRangeText.length, "拖选必须产生非空选区").toBeGreaterThan(0);

	const lengthBeforeWait = (await liveAnswer.innerText()).length;
	// 关键等待期：mock 每 220ms 一个 chunk，期间尾部子树重挂若干次
	await window.waitForTimeout(1_500);
	// 流式若在这个窗口内结束（live 副本先卸载），innerText 会一直等元素 → 用短超时给出可读失败
	const lengthAfterWait = await liveAnswer.innerText({ timeout: 5_000 }).then(
		(text) => text.length,
		() => -1,
	);
	expect(lengthAfterWait, "等待窗口内 live 正文已卸载：选段太晚，等待期没落在流式期间（用例/时序问题，不是选区 bug）").toBeGreaterThan(0);
	expect(lengthAfterWait, "等待期间流式正文必须继续增长（否则本用例没覆盖到 churn）").toBeGreaterThan(lengthBeforeWait);

	// 主断言：流式期间选区文本必须逐字不变（基线：清理/重锚成整段 live 正文/多出块级换行）
	expect(await selectedText(window), "流式 DOM 变更后选区被清理或重锚").toBe(initialSelection);
	expect(await selectedRangeText(window), "Range 口径的选区文本也必须一致").toBe(initialRangeText);
});

test("selection survives the live-to-settled answer swap at stream end", async ({ window }) => {
	test.setTimeout(180_000);
	const timeline = window.locator(".message-timeline");
	await startSlowMarkdownStream(window);

	const initialSelection = await selectStablePhrase(window);
	expect(initialSelection.trim().length, "拖选必须产生非空选区").toBeGreaterThan(0);

	// settle：live 副本卸载、settled 正文接管（TurnRow 的 live→settled 换树）
	await expect(timeline.locator("[data-live-answer]")).toHaveCount(0, { timeout: 60_000 });
	await expect(timeline.locator(".turn-row--complete")).toHaveCount(1, { timeout: 60_000 });
	// 等 settle 后的全量渲染（requestIdleCallback 调度 heavy 插件管线）再断言
	await window.waitForTimeout(1_200);

	expect(await selectedText(window), "settle 换树后选区被清理").toBe(initialSelection);
});
