import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";

/**
 * 过程组显示（设置项 `processGroupDisplay`）的**真实 DOM 验证**。
 *
 * 为什么必须有这一层：typecheck / 单测 / 源码正则断言全都证明不了「界面上真的长这样」。
 * 尤其这三件事只有真跑起来才知道：
 * 1. 组头宽度是否等于内容列宽度 —— 用户反复强调「hover 框要和流式输出同宽，不许按文字宽度收缩」，
 *    `inline-flex` 或 `self-start` 会让它退化成「文字多宽框多宽」；
 * 2. 组体自然展开且不生成第二条纵向滚动；
 * 3. 默认（开关关闭）必须完整保留原平铺渲染 —— 新路径不能把旧路径挤掉。
 *
 * mock pi 按 prompt 关键字分支：含 THINK 推 thinking_delta、含 TOOL 推 tool_execution_start/end，
 * 因此一条消息即可产出「思考 + bash 工具调用」→ 形成过程组。
 */

/**
 * 等待合成器可用（UI 2.0 合成器优先欢迎页）：不再有「启动 Agent」按钮，
 * 首次输入即预热并激活 runtime（ComposerArea 首键 activateRuntime）。
 * 与 agent-flow.spec.ts 保持同一份逻辑 —— 本文件早期版本还在点「启动 Agent」，
 * 那个按钮已被 UI 2.0 欢迎页移除，导致本 spec 在真机上一直无效。
 */
async function startAgent(window: Page) {
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

/**
 * 发送一条同时触发思考与工具调用的消息。
 * 前置两步与既有 e2e（typewriter.spec.ts）一致：先等启动遮罩消失、再点 composer 取焦点，
 * 否则 `启动 Agent` 根本还没渲染出来（首帧只有窗口控制按钮）。
 */
async function runProcessTurn(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = await startAgent(window);
	await composer.click();
	// `SLOW` 是 mock 的既有节流标记（chunk 间隔 80ms → 220ms）。
	//
	// 为什么必须放慢：mock 的 jsonl 只落盘最终文本（appendSessionMessages），不落思考/工具块；
	// 本轮结束后 PiDeck 会重新读回会话文件，思考/工具连同整个折叠栏一起从 DOM 消失
	// （实测：结算后 `.execution-summary-toggle` 直接不存在了）。因此这两条用例只能在
	// 「流式进行中」断言——放慢后窗口从 ~0.4s 拉到 ~2.5s，断言才能稳定跑完。
	await window.keyboard.type("SLOW THINK TOOL 过程组验证");
	await window.keyboard.press("Enter");
}

/**
 * 把折叠栏开到展开态（幂等）。
 *
 * `expandInterimDuringStream` 默认开 → 流式中 `stepsVisible` 已经是 true，
 * 此时再 click 反而会把它关掉（旧实现就是直接 click，所以旧断言时好时坏）。
 */
async function ensureFoldOpen(window: Page) {
	const toggle = window.locator(".execution-summary-toggle").first();
	await expect(toggle).toBeVisible({ timeout: 30_000 });
	if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
}

/**
 * 读取一行内**所有**文本项的文字基线（0×0 inline-block 探针：其 top 即该行基线）。
 *
 * 只取 `[data-row-text]` 文本段的**直接子元素**，且跳过盒子类元素
 * （徽章 / chevron / 状态 pill 由 `self-center` 单独居中，基线与文字没有同一性要求）。
 *
 * 为什么把字体族分组是**错的**：本 bug 恰恰是「等宽详情 vs 正文」的**跨字体**基线差，
 * 按字体族分组后 mono 组只剩 1 项 → 极差恒为 0，断言退化成空气断言（2026-09 踩过）。
 * 所以这里必须把同组所有文本放在**同一个极差**里比。
 */
function readRowTextBaselines(row: import("@playwright/test").Locator) {
	return row.locator("[data-row-text] > *").evaluateAll((els) =>
		els
			.filter((el) => (el.textContent ?? "").trim().length > 0)
			.filter((el) => getComputedStyle(el).alignSelf !== "center")
			.filter((el) => {
				const d = getComputedStyle(el).display;
				return d !== "flex" && !d.startsWith("inline-flex");
			})
			.map((el) => {
				const probe = document.createElement("span");
				probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline;";
				el.appendChild(probe);
				const top = probe.getBoundingClientRect().top;
				probe.remove();
				return top;
			}),
	);
}

/**
 * 断言「同一行的文本共基线」：极差 ≤0.75px，且至少 `minItems` 项参与。
 *
 * `minItems` 是防退化门槛：工具行必须同时量到「14px 工具名 + 12px 耗时 + 12px 等宽命令」
 * 三项，少一项说明详情还没落地，不能算通过。
 */
async function expectSharedTextBaseline(row: import("@playwright/test").Locator, minItems: number) {
	// 先等文本段真的渲染出来（过程行只在流式窗口内存在，错过窗口就永远等不到），
	// 再量基线；否则 poll 会在窗口关闭后一直拿到空数组，把「真回归」掩盖成 NaN 超时。
	await expect(row.locator("[data-row-text]").first()).toBeAttached({ timeout: 30_000 });
	await expect
		.poll(
			async () => {
				const baselines = await readRowTextBaselines(row);
				if (baselines.length < minItems) return Number.NaN;
				return Math.max(...baselines) - Math.min(...baselines);
			},
			{ timeout: 10_000 },
		)
		.toBeLessThanOrEqual(0.75);
}

test.describe("开关开启：过程组显示", () => {
	test.use({ seedSettings: { processGroupDisplay: true } });

	test("组头与内容列同宽，组体限高且滚动条隐藏", async ({ window }) => {
		test.setTimeout(90_000);
		await runProcessTurn(window);

		// 折叠栏头有可折叠内容时常驻。
		await ensureFoldOpen(window);

		const head = window.locator("[data-process-group-head]").first();
		await expect(head).toBeVisible({ timeout: 15_000 });

		// ① 组头必须占满内容列（w-full）。inline-flex / self-start / 内在宽度收缩都会让这里失败。
		const headMetrics = await head.evaluate((el) => {
			const self = el.getBoundingClientRect();
			const parent = el.parentElement?.getBoundingClientRect();
			const style = getComputedStyle(el);
			return { selfWidth: self.width, parentWidth: parent?.width ?? 0, display: style.display };
		});
		expect(headMetrics.display).toBe("flex");
		expect(headMetrics.parentWidth).toBeGreaterThan(0);
		expect(headMetrics.selfWidth).toBeGreaterThan(headMetrics.parentWidth - 2);

		// ② 组体是限高视口：≈ min(640px,60vh)（行高 28px ≈ 22 行）、滚动条隐藏、到边不切断滚动链。
		//    限高只在这一层，内容盒必须保持自然高度（否则就是双层滚动条）。
		const scroller = window.locator("[data-process-group-scroller]").first();
		await expect(scroller).toBeVisible({ timeout: 10_000 });
		const scrollerStyle = await scroller.evaluate((el) => {
			const style = getComputedStyle(el);
			return { maxHeight: Number.parseFloat(style.maxHeight), overflowY: style.overflowY, scrollbarWidth: style.scrollbarWidth, overscrollY: style.overscrollBehaviorY };
		});
		expect(scrollerStyle.overflowY).toBe("auto");
		expect(scrollerStyle.scrollbarWidth).toBe("none");
		expect(scrollerStyle.maxHeight).toBeGreaterThan(200);
		expect(scrollerStyle.maxHeight).toBeLessThanOrEqual(640);
		expect(scrollerStyle.overscrollY).toBe("auto");
		const contentStyle = await window
			.locator("[data-process-group-content]")
			.first()
			.evaluate((el) => {
				const style = getComputedStyle(el);
				return { maxHeight: style.maxHeight, overflowY: style.overflowY };
			});
		expect(contentStyle.overflowY).toBe("visible");
		expect(contentStyle.maxHeight).toBe("none");

		// ③ 组体里必须是**既有的**工具行（复用 ToolCard，不新造行样）
		await expect(window.locator("[data-process-group-body] .tool-card").first()).toBeVisible({ timeout: 15_000 });
	});

	test("同行文本共基线：等宽详情不得比主文本高", async ({ window }) => {
		test.setTimeout(120_000);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		const composer = await startAgent(window);
		await composer.fill("SLOWDRIP THINK TOOLMANY 10 过程组基线验证");
		await window.keyboard.press("Enter");

		// 实时详情只在运行中且组体收起时显示；持续工具流为两次开合留出真实运行窗口。
		const head = window.locator("[data-process-group-head]").first();
		await expect(head).toBeVisible({ timeout: 20_000 });
		const toolRow = window.locator("[data-process-group-body] .tool-card").first();
		await expect(toolRow).toBeVisible({ timeout: 20_000 });
		await head.click();
		await expect(head).toHaveAttribute("aria-expanded", "false");
		await expectSharedTextBaseline(head, 3);
		await head.click();
		await expect(head).toHaveAttribute("aria-expanded", "true");

		// 成员行（ToolCard）：工具名 14px + 耗时 12px + 等宽命令 12px 三项必须共基线。
		// 修复前真机实测极差 2.23–3.00px（等宽详情整体偏上），修复后 0。
		await expect(toolRow).toBeVisible({ timeout: 20_000 });
		await expectSharedTextBaseline(toolRow, 3);
	});

	test("组内先滚组体，到顶后上滚交给会话，回底入口恢复最新内容", async ({ app, window }) => {
		test.setTimeout(90_000);
		await app.evaluate(({ BrowserWindow }) => {
			const win = BrowserWindow.getAllWindows()[0];
			if (win?.isMaximized()) win.unmaximize();
			win?.setBounds({ width: 1000, height: 560 });
		});
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		const composer = await startAgent(window);
		await composer.fill("SLOW TOOLMANY 30 unified-scroll");
		await window.keyboard.press("Enter");
		const timeline = window.locator(".message-timeline").first();
		const body = window.locator("[data-process-group-scroller]").first();
		await expect.poll(() => body.locator(".tool-card").count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(20);
		const bottomGap = () => timeline.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
		const innerGap = () => body.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
		// 运行中的最新组自动展开并贴底（外层时间线收不到增高通知，跟底在组体内部）。
		await expect.poll(innerGap, { timeout: 20_000 }).toBeLessThanOrEqual(4);

		// 不用 locator.hover：组体比视口高时 Playwright 会先把组体顶滚进视口，那一下就把
		// 会话位置改掉了，测的就不是「滚轮归属」。这里只把鼠标移到组体可见区域内。
		const pointInsideBody = () =>
			body.evaluate((element) => {
				const rect = element.getBoundingClientRect();
				const top = Math.max(rect.top, 0);
				const bottom = Math.min(rect.bottom, window.innerHeight);
				return { x: rect.left + 60, y: (top + bottom) / 2 };
			});

		// ① 组内还有余量：上滚只动组体，会话一像素不动，跟随态不变（没有“幽灵解锁”）。
		const inside = await pointInsideBody();
		await window.mouse.move(inside.x, inside.y);
		const timelineBefore = await timeline.evaluate((element) => element.scrollTop);
		await window.mouse.wheel(0, -180);
		await expect.poll(innerGap).toBeGreaterThan(80);
		expect(await timeline.evaluate((element) => element.scrollTop)).toBe(timelineBefore);
		expect(await bottomGap()).toBeLessThanOrEqual(28);

		// ② 组体到顶后继续上滚：手势交还会话，回底入口出现。
		await body.evaluate((element) => {
			element.scrollTop = 0;
		});
		await body.hover({ position: { x: 60, y: 60 }, force: true });
		await window.mouse.wheel(0, -200);
		await expect.poll(bottomGap).toBeGreaterThan(80);
		await expect(window.locator("[data-scroll-to-bottom]")).toBeVisible();
		await window.locator("[data-scroll-to-bottom]").click();
		await expect.poll(bottomGap).toBeLessThanOrEqual(28);
	});
});

test.describe("显式关闭（seed processGroupDisplay: false）", () => {
	// 默认值已改为开启（2026-11）：平铺渲染路径仍由本分组显式关闭开关来覆盖，
	// 保证关闭路径不会被默认开启挤掉。
	test.use({ seedSettings: { processGroupDisplay: false } });

	test("不出现过程组，保持原平铺渲染", async ({ window }) => {
		test.setTimeout(90_000);
		await runProcessTurn(window);

		// 平铺路径的折叠汇总按钮出现 → 这一轮确实有过程内容
		const toggle = window.locator(".execution-summary-toggle").first();
		await expect(toggle).toBeVisible({ timeout: 30_000 });

		// 关闭时必须一个组头都没有
		await expect(window.locator("[data-process-group-head]")).toHaveCount(0);

		// 流式中展开（幂等，不会把已展开的关掉），步骤行直接出现在折叠容器里（原扁平渲染未被挤掉）
		if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
		await expect(window.locator(".execution-summary-details .tool-card").first()).toBeVisible({ timeout: 15_000 });
	});
});
