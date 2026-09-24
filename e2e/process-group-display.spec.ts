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

async function startAgent(window: Page) {
	const startButton = window.getByRole("button", { name: "启动 Agent" });
	const composer = window.locator(".composer .rich-input");
	for (let attempt = 0; attempt < 4; attempt += 1) {
		await startButton.click();
		const gone = await startButton
			.waitFor({ state: "hidden", timeout: 5000 })
			.then(() => true)
			.catch(() => false);
		if (gone) break;
	}
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

/** 发送一条同时触发思考与工具调用的消息。 */
async function runProcessTurn(window: Page) {
	await startAgent(window);
	await window.keyboard.type("THINK TOOL 过程组验证");
	await window.keyboard.press("Enter");
}

test.describe("开关开启：过程组显示", () => {
	test.use({ seedSettings: { processGroupDisplay: true } });

	test("组头与内容列同宽，且组体限高真的生效", async ({ window }) => {
		await runProcessTurn(window);

		const head = window.locator("[data-process-group-head]").first();
		await expect(head).toBeVisible({ timeout: 30_000 });

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
		await head.click();
		const scroller = window.locator("[data-process-group-scroller]").first();
		await expect(scroller).toBeVisible();
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
});

test.describe("默认（开关关闭）", () => {
	test("不出现过程组，保持原平铺渲染", async ({ window }) => {
		await runProcessTurn(window);

		// 平铺路径的折叠汇总按钮出现 → 这一轮确实有过程内容
		const toggle = window.locator(".execution-summary-toggle").first();
		await expect(toggle).toBeVisible({ timeout: 30_000 });

		// 关闭时必须一个组头都没有
		await expect(window.locator("[data-process-group-head]")).toHaveCount(0);

		// 展开折叠栏后，步骤行直接出现在折叠容器里（原扁平渲染未被挤掉）
		await toggle.click();
		await expect(window.locator(".execution-summary-details .tool-card").first()).toBeVisible({ timeout: 15_000 });
	});
});
