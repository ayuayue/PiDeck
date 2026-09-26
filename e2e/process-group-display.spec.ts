import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";

/**
 * 过程组显示（设置项 `processGroupDisplay`）的**真实 DOM 验证**。
 *
 * 为什么必须有这一层：typecheck / 单测 / 源码正则断言全都证明不了「界面上真的长这样」。
 * 尤其这三件事只有真跑起来才知道：
 * 1. 组头宽度是否等于内容列宽度 —— 用户反复强调「hover 框要和流式输出同宽，不许按文字宽度收缩」，
 *    `inline-flex` 或 `self-start` 会让它退化成「文字多宽框多宽」；
 * 2. 组体限高是否真的生效 —— Tailwind 的 arbitrary class（`max-h-[min(320px,30vh)]`）
 *    写错语法时**不会报错、只是不生成 CSS**，界面看起来"没限高"，静态检查一律看不出来；
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

test.describe("开关开启：过程组显示", () => {
	test.use({ seedSettings: { processGroupDisplay: true } });

	test("组头与内容列同宽，且组体限高真的生效", async ({ window }) => {
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

		// ② 组体限高：arbitrary class 必须真的编译出 max-height / overflow-y:auto / overscroll-behavior。
		// 语法写错时 Tailwind 静默不生成 CSS，只有计算样式能戳穿。
		// 流式中「最新过程组」走自动槽已展开，scroller 直接可见；不要再点组头（会把组收起来）。
		const scroller = window.locator("[data-process-group-scroller]").first();
		await expect(scroller).toBeVisible({ timeout: 10_000 });
		const scrollerStyle = await scroller.evaluate((el) => {
			const style = getComputedStyle(el);
			return { maxHeight: style.maxHeight, overflowY: style.overflowY, overscrollY: style.overscrollBehaviorY };
		});
		expect(scrollerStyle.overflowY).toBe("auto");
		expect(scrollerStyle.maxHeight).not.toBe("none");
		expect(scrollerStyle.maxHeight).not.toBe("");
		expect(scrollerStyle.overscrollY).toBe("contain");

		// ③ 组体里必须是**既有的**工具行（复用 ToolCard，不新造行样）
		await expect(window.locator("[data-process-group-body] .tool-card").first()).toBeVisible({ timeout: 15_000 });
	});

	test("组内滚轮不得幽灵解锁外层：到边后时间线一像素不动，也不得出回底按钮", async ({ window }) => {
		test.setTimeout(180_000);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });

		// ① 预热：必须先把外层时间线撑到**可滚动**。
		// 这不是为了好看：`decideFollowFromUserInput` 在 `canScroll === false` 时把上滚降级成
		// `intent`（虚拟窗口展开），永远走不到 `escape`。时间线不可滚时，本用例即使去掉整段
		// 滚轮归属守卫也照样通过 —— 换句话说，不铺长内容的话这条断言是**空气断言**
		// （2026-08 用 mutate 版 `resolveGestureOwner` 实测验证：短会话下按钮恒为 0）。
		const composer = await startAgent(window);
		await composer.click();
		await window.keyboard.type("SLOW LONG 幽灵解锁预热长内容");
		await window.keyboard.press("Enter");
		const timeline = window.locator(".message-timeline").first();
		const timelineOverflow = () => timeline.evaluate((el) => el.scrollHeight - el.clientHeight);
		await expect.poll(timelineOverflow, { timeout: 90_000 }).toBeGreaterThan(400);

		// ② 第二轮：过程组持续增长（TOOLMANY 14，间隔 ≥250ms）
		await composer.click();
		await window.keyboard.type("SLOW TOOLMANY 14 幽灵解锁");
		await window.keyboard.press("Enter");
		const scroller = window.locator("[data-process-group-scroller]").first();
		await expect(scroller).toBeVisible({ timeout: 30_000 });
		await expect.poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 60_000 }).toBeGreaterThan(40);
		const box = await scroller.boundingBox();
		if (!box) throw new Error("组体没有可点击区域");

		// 先把组体滚到顶（上滚到 0）——此时内层往上已无余量。
		// 关键：组体是 `overflow-y-auto overscroll-contain`，到边后手势**不会**链到外层时间线。
		// 修复前，引擎的滚轮归属只看「第一个 overflow 容器在该方向还能不能滚」，
		// 已到顶 → 直接当成时间线手势 → 外层时间线一像素没动，却把跟随态静默解锁
		// （弹回底按钮、流式内容从此不再跟随）。本用例把「画面没动就不许改跟随态」钉死。
		await scroller.evaluate((el) => {
			el.scrollTop = 0;
		});
		// 前置断言：组体确实已在顶部（上滚无余量），且时间线此刻确实在贴底跟随。
		// 否则后面的「没被解锁」无从谈起。
		await expect.poll(async () => scroller.evaluate((el) => el.scrollTop), { timeout: 10_000 }).toBeLessThanOrEqual(2);
		await expect.poll(() => timeline.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), { timeout: 15_000 }).toBeLessThanOrEqual(4);
		// 跟随态的可视锚点就是回底按钮（`useSessionTimelineController`：跟随被解锁 → 按钮出现）。
		// 用稳定 DOM 锚点定位，避免测试随中英文按钮文案变化；按钮本身仍可由辅助技术访问。
		const backToBottom = window.locator("[data-scroll-to-bottom]");
		await expect(backToBottom).toHaveCount(0);

		// 在组体上向上滚：内层已到顶、链被 contain 切断 → 谁都不该滚。
		await window.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		for (let i = 0; i < 6; i += 1) await window.mouse.wheel(0, -240);
		await window.waitForTimeout(400);

		// ① 手势没有滚到外层时间线。
		// 不能用 scrollTop 的原始差值判：组体成员仍在到达，跟随态下时间线会随内容增高
		// 合法地往上走（scrollTop 变大），「原始差值 > 2」会把跟底误判成手势外溢。
		// 距底距离对「跟底」是守恒的（scrollHeight 与 scrollTop 同增），只有真被滚上去才会变大。
		await expect.poll(() => timeline.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), { timeout: 10_000 }).toBeLessThanOrEqual(4);
		// ② 组体自己也没被滚上去（本来就在顶）
		expect(await scroller.evaluate((el) => el.scrollTop)).toBeLessThanOrEqual(2);
		// ③ 最关键的可见后果：跟随态没被幽灵解锁 → 不得出现回底按钮
		await expect(backToBottom).toHaveCount(0);
		// ④ 而且跟随必须**继续有效**：后续成员到达时时间线仍要贴底。
		// 只看按钮会被「解锁了但恰好没触发重渲染」放过；这里等组体再长一截，
		// 用几何距离钉死。mutate 版实测此处距底会涨到 ~39px（贴底容差 4px 直接打穿）。
		await expect.poll(timelineOverflow, { timeout: 30_000 }).toBeGreaterThan(0);
		await window.waitForTimeout(2500);
		await expect.poll(() => timeline.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight), { timeout: 15_000 }).toBeLessThanOrEqual(4);
		await expect(backToBottom).toHaveCount(0);
	});

	test("组体内部滚轮自己跟底：展开后成员继续到达，滚珠不能停在上面", async ({ window }) => {
		test.setTimeout(120_000);
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		const composer = await startAgent(window);
		await composer.click();
		// TOOLMANY 14：mock 会逐个推 14 次工具调用（间隔 250ms），制造「组体已展开、成员仍在到达」的增长窗口。
		// 不需要点开组头——`expandInterimDuringStream` 默认开，最新过程组走自动槽自动展开，
		// 这正是用户报「思考时组体在长、滚珠却不跟底」的场景。
		await window.keyboard.type("TOOLMANY 14");
		await window.keyboard.press("Enter");

		const scroller = window.locator("[data-process-group-scroller]").first();
		await expect(scroller).toBeVisible({ timeout: 30_000 });

		// 成员持续到达必须把组体撑出**内部**滚动（限高 320px）；撑不开就说明这批断言没测到东西。
		await expect.poll(async () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight), { timeout: 30_000 }).toBeGreaterThan(40);

		// 增长过程中就要贴底。这里判的是几何距离（≤2px）：
		// 没有跟底引擎时 scrollTop 会停在 0，距离 ≈ 内容高差 ＞ 2，直接失败。
		const bottomGap = () => scroller.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
		await expect.poll(bottomGap, { timeout: 30_000 }).toBeLessThanOrEqual(2);

		// 增长结束（14 个工具都到达）后再断言一次：防止「刚好在某一帧被弹簧带上、随后又掉回去」。
		await expect(scroller.locator(".tool-card")).toHaveCount(14, { timeout: 30_000 });
		await expect.poll(bottomGap, { timeout: 10_000 }).toBeLessThanOrEqual(2);
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
