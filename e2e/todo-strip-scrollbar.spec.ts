import { test, expect } from "./mock-pi-fixture";
import type { Page } from "@playwright/test";
import { makeSeedProject } from "./open-session";

/**
 * 待办条滚动条闪烁回归（2027-01）。
 *
 * 根因：进行中图标的旋转挂在 <svg> 根上，Chromium 用后代**变换后的包围盒**算滚动溢出；
 * 16×16 方盒转到 45° 时 AABB ≈ 22.6px > 20px 行高，把外层 ul（overflow-y:auto）的
 * scrollHeight 从 104 顶到 105 → 原生滚动条出现/消失以旋转频率闪。
 * 只有**最后一行底部**的溢出会计入 scrollHeight，所以复现条件是「最后一条 in-progress」。
 *
 * 断言方式：展开待办条后逐帧采样 ul 的（scrollHeight / clientHeight / clientWidth /
 * 滚动条占用宽度）指纹，必须全程只有一个取值且不出现滚动条。
 * 若旋转被挪回 svg 根（或又引入同类动画图标），指纹会立刻分裂 → 用例失败。
 */
const seedProject = makeSeedProject("todo-strip-scrollbar-seed");

test.use({
	seedProjects: [seedProject],
	seedSessionFiles: [
		{
			projectPath: seedProject.path,
			entries: [
				{
					type: "session",
					version: 3,
					id: "e1",
					parentId: null,
					name: "待办滚动条回归",
					cwd: seedProject.path,
					timestamp: new Date(Date.now() - 60_000).toISOString(),
				},
				{
					type: "message",
					id: "e2",
					parentId: "e1",
					timestamp: new Date(Date.now() - 59_000).toISOString(),
					message: { role: "user", content: [{ type: "text", text: "待办滚动条回归前置轮" }] },
				},
				{
					type: "message",
					id: "e3",
					parentId: "e2",
					timestamp: new Date(Date.now() - 58_000).toISOString(),
					message: { role: "assistant", content: [{ type: "text", text: "前置轮回复，用于让会话进入有内容的常规态。" }] },
				},
				// 历史会话（未启动 agent）走 sessions:list-session-todo 快照路径 → 真实待办条渲染。
				// v3 三态快照：最后一条 in_progress 才会把旋转图标放到末行。
				{
					type: "custom",
					id: "e4",
					parentId: "e3",
					timestamp: new Date(Date.now() - 57_000).toISOString(),
					customType: "pi-deck-todo",
					data: {
						version: 3,
						activePlan: {
							id: 1,
							todos: [
								{ id: 1, text: "审查昨天与会话历史滚动相关的提交和当前工作区", status: "completed" },
								{ id: 2, text: "添加可复现会长会话上滚、预加载锚点与滚动条消失问题的回归测试", status: "completed" },
								{ id: 3, text: "实现聚焦修复并保留原有预加载与自动跟随行为", status: "completed" },
								{ id: 4, text: "运行格式化、针对性测试和 TypeScript 类型检查，复核改动", status: "in_progress" },
							],
						},
					},
				},
			],
		},
	],
});

/** 打开种子历史会话（未启动 agent → todo 快照路径）。 */
async function openSeededSession(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	await window.getByRole("tab", { name: "项目" }).click();
	const projectRow = window.locator(".conversation", { hasText: "todo-strip-scrollbar-seed" }).first();
	await expect(projectRow).toBeVisible({ timeout: 30_000 });
	await projectRow.click();
	const historyRow = window.locator(".conversation", { hasText: "待办滚动条回归" }).first();
	await expect(historyRow).toBeVisible({ timeout: 15_000 });
	await historyRow.click();
}

/** 展开待办条（默认折叠）并返回条目列表。 */
async function expandTodoStrip(window: Page) {
	const strip = window.locator('[data-testid="session-todo-strip"]');
	await expect(strip).toBeVisible({ timeout: 30_000 });
	await strip.locator("button[aria-expanded]").click();
	const list = strip.locator("ul");
	await expect(list).toBeVisible({ timeout: 10_000 });
	// 让 motion-safe:animate-in 的入场动画先跑完，避免把入场帧算进指纹
	await window.waitForTimeout(300);
	return list;
}

/**
 * 逐帧采样列表的滚动指纹：
 * `scrollHeight/clientHeight/clientWidth/滚动条占用宽度`。
 * 一帧一个取值 = 列表既没有滚动条出现/消失，也没有宽度抖动。
 */
async function sampleListFingerprint(list: ReturnType<Page["locator"]>, frames = 60) {
	return list.evaluate(async (ul: HTMLElement, count: number) => {
		const samples: string[] = [];
		for (let i = 0; i < count; i += 1) {
			samples.push(`${ul.scrollHeight}/${ul.clientHeight}/${ul.clientWidth}/${ul.offsetWidth - ul.clientWidth}`);
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		}
		const distinct = [...new Set(samples)];
		return {
			frames: samples.length,
			distinct,
			scrollbarFrames: samples.filter((sample) => !sample.endsWith("/0")).length,
		};
	}, frames);
}

test("in-progress todo row keeps the strip list scrollbar-free (no scrollHeight oscillation)", async ({ app, window }) => {
	test.setTimeout(120_000);
	await app.evaluate(({ BrowserWindow }) => {
		const target = BrowserWindow.getAllWindows()[0];
		if (!target) return;
		if (target.isMinimized()) target.restore();
		if (!target.isVisible()) target.showInactive();
	});
	await openSeededSession(window);
	const list = await expandTodoStrip(window);

	// 前置事实：4 条待办、末条 in-progress（复现条件），且旋转图标确实在渲染
	const rows = list.locator("li");
	await expect(rows).toHaveCount(4);
	await expect(rows.last()).toContainText("TypeScript 类型检查");
	await expect(rows.last().locator("svg.animate-pideck-spin")).toHaveCount(1);
	// 旋转不能下放到 circle：SVG 子元素默认 transform-origin:0 0，会围绕 viewBox
	// 左上角甩出盒子，被行 overflow-hidden 裁成一道小弧
	await expect(rows.last().locator("circle.animate-pideck-spin")).toHaveCount(0);

	// 采样覆盖一整个旋转周期（1s ≈ 60 帧），确保跨过 AABB 峰值相位
	const fingerprint = await sampleListFingerprint(list);
	expect(fingerprint.frames).toBe(60);
	expect(fingerprint.distinct, `list scroll fingerprint must stay constant, got: ${JSON.stringify(fingerprint.distinct)}`).toHaveLength(1);
	expect(fingerprint.scrollbarFrames, "list must never show a scrollbar while the in-progress glyph spins").toBe(0);

	// 卡片列必须与输入框/消息列同宽：曾给 widget 栈加 [scrollbar-gutter:stable] 治闪烁，
	// 闪烁没治好，反而把卡片压窄了一个滚动条宽度（实测 993.2 vs 1003.2）。
	const widths = await window.evaluate(() => {
		const width = (selector: string) => {
			const el = document.querySelector(selector);
			return el ? el.getBoundingClientRect().width : Number.NaN;
		};
		return {
			card: width('[data-testid="session-todo-strip"]'),
			composerBox: width(".composer-box"),
			messageLog: width('[role="log"]'),
		};
	});
	expect(widths.card).toBeCloseTo(widths.composerBox, 0);
	expect(widths.card).toBeCloseTo(widths.messageLog, 0);
});

/**
 * 待办列表溢出时的行高回归（2027-01 排版事故）。
 *
 * 根因：ul 是「flex 列 + max-h-[180px]」容器，flex 子项默认 flex-shrink:1，而行上的
 * overflow-hidden 会把 flex 自动最小尺寸（min-height:auto）清零 → 内容超过 180px 时
 * 每行都能被继续压缩。条目少时（≤6 条）内容装得下不触发；13 条实测从 20px 被线性压到
 * 6.47px —— 文字被行 overflow-hidden 切成横条、相邻行叠在一起，且 scrollHeight 收缩到
 * 与 clientHeight 相等 → 滚动条根本不出现，用户滚不动（用户截图实况）。
 *
 * 断言方式：13 条待办（远超 180px）展开后，每行必须保持 20px 固有高度、文字不被行高
 * 切断，且列表必须真实溢出（scrollHeight > clientHeight、出现滚动条、可滚到底部）。
 */
const overflowSeedProject = makeSeedProject("todo-strip-overflow-seed");
// 单元素数组可直传（>=2 元素才会被 Playwright 当 [value, options] 元组，见 mock-pi-fixture）
const overflowSessionFile = {
	projectPath: overflowSeedProject.path,
	entries: [
		{
			type: "session",
			version: 3,
			id: "f1",
			parentId: null,
			name: "待办溢出回归",
			cwd: overflowSeedProject.path,
			timestamp: new Date(Date.now() - 60_000).toISOString(),
		},
		{
			type: "message",
			id: "f2",
			parentId: "f1",
			timestamp: new Date(Date.now() - 59_000).toISOString(),
			message: { role: "user", content: [{ type: "text", text: "待办溢出回归前置轮" }] },
		},
		{
			type: "message",
			id: "f3",
			parentId: "f2",
			timestamp: new Date(Date.now() - 58_000).toISOString(),
			message: { role: "assistant", content: [{ type: "text", text: "前置轮回复，用于让会话进入有内容的常规态。" }] },
		},
		{
			type: "custom",
			id: "f4",
			parentId: "f3",
			timestamp: new Date(Date.now() - 57_000).toISOString(),
			customType: "pi-deck-todo",
			data: {
				version: 3,
				activePlan: {
					id: 1,
					todos: [
						{ id: 1, text: "审查昨天与会话历史滚动相关的提交和当前工作区", status: "completed" },
						{ id: 2, text: "添加可复现长会话上滚、预加载锚点与滚动条消失问题的回归测试", status: "completed" },
						{ id: 3, text: "实现聚焦修复并保留原有预加载与自动跟随行为", status: "completed" },
						{ id: 4, text: "运行格式化、针对性测试和 TypeScript 类型检查，复核改动", status: "completed" },
						{ id: 5, text: "补充回归测试与代码注释说明根因与业务规则", status: "completed" },
						{ id: 6, text: "复核 e2e 用例与滚动指纹采样脚本", status: "completed" },
						{ id: 7, text: "更新 AGENTS.md 记录本次修复经验", status: "completed" },
						{ id: 8, text: "确认 compact 窗口同样不受影响", status: "completed" },
						{ id: 9, text: "Linux 下滚动条宽度差异核对", status: "completed" },
						{ id: 10, text: "整理 elf 解析与回退路径", status: "pending" },
						{ id: 11, text: "归档本轮回滚方案", status: "pending" },
						{ id: 12, text: "补充第二语言文案", status: "pending" },
						{ id: 13, text: "最后一条：确认溢出时滚动可到底", status: "pending" },
					],
				},
			},
		},
	],
};

test.describe("todo strip overflow layout", () => {
	test.use({
		seedProjects: [overflowSeedProject],
		seedSessionFiles: [overflowSessionFile],
	});

	test("many todo rows keep 20px height and the list scrolls instead of compressing", async ({ app, window }) => {
		test.setTimeout(120_000);
		await app.evaluate(({ BrowserWindow }) => {
			const target = BrowserWindow.getAllWindows()[0];
			if (!target) return;
			if (target.isMinimized()) target.restore();
			if (!target.isVisible()) target.showInactive();
		});
		// 打开种子历史会话（与上述用例同一项目导航路径，会话名不同）
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await window.getByRole("tab", { name: "项目" }).click();
		const projectRow = window.locator(".conversation", { hasText: "todo-strip-overflow-seed" }).first();
		await expect(projectRow).toBeVisible({ timeout: 30_000 });
		await projectRow.click();
		const historyRow = window.locator(".conversation", { hasText: "待办溢出回归" }).first();
		// 项目点开后要等 SessionScanner 扫完 .pi/sessions（冷启动常 >10s，给足余量）
		await expect(historyRow).toBeVisible({ timeout: 30_000 });
		await historyRow.click();
		const list = await expandTodoStrip(window);

		const rows = list.locator("li");
		await expect(rows).toHaveCount(13);
		const layout = await list.evaluate((ul: HTMLElement) => {
			const rowEls = [...ul.querySelectorAll("li")];
			return {
				rowHeights: rowEls.map((row) => +row.getBoundingClientRect().height.toFixed(2)),
				// 文字盒不得高出行盒：压缩态文字会溢出行、再被行 overflow-hidden 切成横条
				textOverflowsRow: rowEls.some((row) => {
					const text = row.querySelector("span:last-child");
					return text ? text.getBoundingClientRect().height > row.getBoundingClientRect().height + 0.5 : false;
				}),
				scrollHeight: ul.scrollHeight,
				clientHeight: ul.clientHeight,
				scrollbarPx: ul.offsetWidth - ul.clientWidth,
			};
		});

		for (const height of layout.rowHeights) {
			expect(height, `every row must keep its 20px intrinsic height, got: ${JSON.stringify(layout.rowHeights)}`).toBe(20);
		}
		expect(layout.textOverflowsRow, "todo text must not overflow its row (compressed rows slice the glyphs)").toBe(false);
		expect(layout.scrollHeight, `list must really overflow so it can scroll (scrollHeight ${layout.scrollHeight} vs clientHeight ${layout.clientHeight})`).toBeGreaterThan(layout.clientHeight);
		expect(layout.scrollbarPx, "an overflowing list must show its scrollbar so users can reach hidden rows").toBeGreaterThan(0);

		// 滚到底部后末行必须完整可见：压缩态下 scrollTop 恒为 0，用户根本滚不动
		await list.evaluate((ul: HTMLElement) => ul.scrollTo(0, ul.scrollHeight));
		const bottom = await list.evaluate((ul: HTMLElement) => {
			const last = ul.querySelector("li:last-child") as HTMLElement;
			return { scrollTop: ul.scrollTop, lastRowFullyVisible: last.getBoundingClientRect().bottom <= ul.getBoundingClientRect().bottom + 1 };
		});
		expect(bottom.scrollTop).toBeGreaterThan(0);
		expect(bottom.lastRowFullyVisible).toBe(true);
	});
});
