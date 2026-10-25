import type { ElectronApplication, Page } from "@playwright/test";
import { test, expect } from "./mock-pi-fixture";

/**
 * 历史轮虚拟化（#401）的真机契约。
 *
 * 单测只能覆盖纯策略（切分 / 高度 / 偏移）；本文件覆盖必须真实 DOM + 虚拟器测量循环
 * 才能验的三件事：
 * 1. 扩窗到阈值以上后只挂视口附近的轮，虚拟区靠估值撑总高（不是退化成实挂全部）；
 * 2. 无用户输入时视口内容不漂移，连续上滚后旧行被回收；
 * 3. 「显示更早」插页与会话恢复落位期间，钉住的行保持在原偏移（±28px，与既有
 *    session-scroll-anchor.spec.ts 同一容差）。
 *
 * 历史用 mock pi 的 LONG 模式真实发送 15 轮构造（每轮 120 行正文，足以撑出多屏高度）：
 * 项目级 seedSessionFiles 在当前基线上扫描不到会话（既有 branch-tree-panel.spec.ts
 * 同样失败），不走那条不稳的路径。
 *
 * known limitations（本轮未重构，登记在此；与 VirtualRunList 顶部注释同源）：
 * - solid 期（多选导出 / 锚点恢复 / 挂起跳转）整表真实渲染，turn 窗口轮数无上限：长历史上
 *   打开多选可能一次挂出全部已加载轮（回到 #213 治理前的全量挂载形态）；
 * - solid 与虚拟分支的 DOM 层级不同，同一 id 的行在切换时会被卸载重建，行内局部展开态
 *   （过程组批次计数、组内滚动位置）随之重置。
 */
const TURN_COUNT = 15;

async function constrainTimelineViewport(app: ElectronApplication) {
	await app.evaluate(({ BrowserWindow }) => {
		const target = BrowserWindow.getAllWindows()[0];
		if (!target) return;
		if (target.isMinimized()) target.restore();
		if (target.isMaximized()) target.unmaximize();
		target.setBounds({ width: 1000, height: 560 });
	});
}

async function openFreshSession(window: Page) {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const newSession = window.getByRole("button", { name: "新建会话", exact: true }).first();
	await expect(newSession).toBeVisible({ timeout: 15_000 });
	await newSession.click();
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

const turnLabel = (index: number) => `轮次-${String(index).padStart(2, "0")}`;

/** 发一轮 LONG（120 行正文）：mock 流完 + 发送按钮回到空闲才算本轮结束。 */
async function sendLongTurn(window: Page, index: number) {
	const composer = window.locator(".composer .rich-input");
	await composer.click();
	await composer.fill(`LONG ${turnLabel(index)}`);
	await window.keyboard.press("Enter");
	await expect(window.locator(".message-timeline")).toContainText(turnLabel(index), { timeout: 20_000 });
	await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 30_000 });
}

async function buildHistory(window: Page, mode: "long" | "short" = "long", turns = TURN_COUNT) {
	const composer = await openFreshSession(window);
	await expect(composer).toHaveAttribute("contenteditable", "true");
	for (let index = 1; index <= turns; index += 1) {
		if (mode === "long") {
			await sendLongTurn(window, index);
			continue;
		}
		await composer.click();
		await composer.fill(`${turnLabel(index)} 短回复巡检`);
		await window.keyboard.press("Enter");
		await expect(window.locator(".message-timeline")).toContainText(`Mock 回复：「${turnLabel(index)} 短回复巡检」`, { timeout: 20_000 });
		await expect(window.locator(".composer-send-primary")).toHaveAttribute("aria-label", "发送", { timeout: 20_000 });
	}
}

/**
 * 时间线的「加载更多」按钮：整段文案精确匹配。
 * /显示更早/ 也会命中 TurnRow 里「显示更早的 N 条步骤」的挂载预算按钮，点错那个不会扩轮次
 * 窗口，断言会假绿（#401 评审）。
 */
function loadMoreButton(window: Page) {
	return window.getByRole("button", { name: /^(加载更多对话|显示更早)$/ }).first();
}

/** 跳顶 + 派发 scroll，触发 controller 的扩窗（每次 cohort +3 轮），直到虚拟区出现。 */
async function expandIntoVirtualRegion(window: Page) {
	for (let attempt = 0; attempt < 14; attempt += 1) {
		const snapshot = await window.locator(".message-timeline").evaluate((timeline) => ({
			virtual: timeline.querySelectorAll("[data-virtual-run-id]").length,
			solid: timeline.querySelectorAll("[data-solid-run-id]").length,
			turns: timeline.querySelectorAll(".turn-row").length,
			top: Math.round(timeline.scrollTop),
			height: Math.round(timeline.scrollHeight),
			client: timeline.clientHeight,
			loadMore: Array.from(document.querySelectorAll("button")).some((button) => /加载更多对话|显示更早/.test(button.textContent ?? "")),
		}));
		if (snapshot.virtual > 0) return snapshot.virtual;
		// 扩窗按钮（「加载更多对话」/「显示更早」）是 controller 的原子 expandWindow 入口；
		// 直接派发点击，避免真实 click 先把按钮滚入视口而改变窗口状态。
		const button = loadMoreButton(window);
		if ((await button.count()) > 0) await button.dispatchEvent("click");
		await window.waitForTimeout(800);
	}
	return window.locator("[data-virtual-run-id]").count();
}
async function virtualStats(window: Page) {
	return window.locator(".message-timeline").evaluate((timeline) => {
		const rows = Array.from(timeline.querySelectorAll<HTMLElement>("[data-virtual-run-id]"));
		const container = rows[0]?.parentElement ?? null;
		const mountedHeight = rows.reduce((sum, row) => sum + row.getBoundingClientRect().height, 0);
		return {
			virtualRows: rows.length,
			solidRows: timeline.querySelectorAll("[data-solid-run-id]").length,
			containerHeight: container?.getBoundingClientRect().height ?? 0,
			mountedHeight,
			viewport: timeline.clientHeight,
			scrollTop: timeline.scrollTop,
			scrollHeight: timeline.scrollHeight,
		};
	});
}

/** 把视口停到 MIDDLE 比例处，返回覆盖视口中线的那条虚拟行的 id 与偏移。 */
async function placeAtMiddle(window: Page, ratio = 0.35) {
	return window.locator(".message-timeline").evaluate((timeline, fraction) => {
		timeline.scrollTop = Math.max(0, Math.round((timeline.scrollHeight - timeline.clientHeight) * fraction));
		timeline.dispatchEvent(new Event("scroll", { bubbles: true }));
		const viewport = timeline.getBoundingClientRect();
		const middle = viewport.top + viewport.height / 2;
		const rows = Array.from(timeline.querySelectorAll<HTMLElement>("[data-virtual-run-id]"));
		// 长回答的行高可能超过一屏：取「覆盖视口中线」的那一行，而不是要求完整可见。
		for (const row of rows) {
			const rect = row.getBoundingClientRect();
			if (rect.top <= middle && rect.bottom >= middle) {
				return { id: row.dataset.virtualRunId ?? "", top: rect.top - viewport.top };
			}
		}
		const first = rows[0];
		return first ? { id: first.dataset.virtualRunId ?? "", top: first.getBoundingClientRect().top - viewport.top } : null;
	}, ratio);
}

async function rowOffset(window: Page, id: string): Promise<number> {
	return window.locator(".message-timeline").evaluate((timeline, runId) => {
		const row = timeline.querySelector<HTMLElement>(`[data-virtual-run-id="${runId}"], [data-solid-run-id="${runId}"]`);
		if (!row) return Number.NaN;
		return row.getBoundingClientRect().top - timeline.getBoundingClientRect().top;
	}, id);
}

test("expanded history mounts viewport rows only, not every turn", async ({ app, window }) => {
	test.setTimeout(300_000);
	await constrainTimelineViewport(app);
	await buildHistory(window);
	const virtualRows = await expandIntoVirtualRegion(window);
	expect(virtualRows).toBeGreaterThan(0);

	// 停到中部再量：视口附近只挂少量行，尾部 3 轮始终真实渲染。
	await placeAtMiddle(window);
	await window.waitForTimeout(600);
	const stats = await virtualStats(window);
	// 尾部真实区的「行」条目不等于轮数：每轮含 user 气泡 + agent-run（尾部 3 轮 ≈ 6 条）。
	expect(stats.solidRows).toBeGreaterThanOrEqual(3);
	expect(stats.solidRows).toBeLessThanOrEqual(8);
	expect(stats.virtualRows).toBeGreaterThan(0);
	expect(stats.virtualRows).toBeLessThanOrEqual(10);
	// 虚拟区容器高度必须显著高于「已挂载行高度 + 一屏」：剩余高度由估值撑起，
	// 说明未挂载的轮仍然占据文档高度（不是把历史凭空删掉）。
	expect(stats.containerHeight).toBeGreaterThan(stats.mountedHeight + stats.viewport);
});

test("scrolling the virtualized history stays put and recycles earlier rows", async ({ app, window }) => {
	test.setTimeout(300_000);
	await constrainTimelineViewport(app);
	await buildHistory(window);
	await expandIntoVirtualRegion(window);
	await placeAtMiddle(window);
	await window.waitForTimeout(800);

	const pinned = await placeAtMiddle(window);
	expect(pinned).not.toBeNull();
	if (!pinned) return;

	// 无用户输入：测量循环收敛后，钉住的行不得继续漂移。
	await window.waitForTimeout(1200);
	const settled = await rowOffset(window, pinned.id);
	expect(Number.isNaN(settled)).toBe(false);
	expect(Math.abs(settled - pinned.top)).toBeLessThanOrEqual(2);

	// 用真实滚轮手势回到顶部：直接写 scrollTop 会被引擎当成布局位移，
	// 内容 ResizeObserver 的 pinBrowseRow 会把视口拉回钉住的行（实测 scrollTop 从 0 弹回 18743）。
	const timeline = window.locator(".message-timeline");
	await timeline.hover();
	for (let attempt = 0; attempt < 80; attempt += 1) {
		const atTop = await timeline.evaluate((element) => element.scrollTop <= 1);
		if (atTop) break;
		await window.mouse.wheel(0, -1200);
		await window.waitForTimeout(40);
	}
	// 收敛判定用轮询而不是固定 sleep：上滚到顶要跨过虚拟行的测量补偿与 pinBrowseRow 的续补，
	// 固定等待在不同机器上会假红/假绿（#401 评审）。
	await expect.poll(() => timeline.evaluate((element) => element.scrollTop), { timeout: 20_000, intervals: [200, 500, 1000] }).toBeLessThanOrEqual(1);
	await window.waitForTimeout(300);
	const after = await virtualStats(window);
	expect(after.virtualRows).toBeLessThanOrEqual(10);
	expect(await window.locator(`[data-virtual-run-id="${pinned.id}"]`).count()).toBe(0);
});

test("showing earlier turns keeps the pinned row at the same viewport offset", async ({ app, window }) => {
	test.setTimeout(300_000);
	await constrainTimelineViewport(app);
	await buildHistory(window);
	await expandIntoVirtualRegion(window);
	await window.waitForTimeout(600);

	const pinned = await placeAtMiddle(window);
	expect(pinned).not.toBeNull();
	if (!pinned) return;

	const loadMore = loadMoreButton(window);
	await expect(loadMore).toBeVisible({ timeout: 10_000 });
	const beforeHeight = await window.locator(".message-timeline").evaluate((element) => element.scrollHeight);
	// 常规 click 会先把按钮滚入视口（改变窗口状态）；直接派发已验证的点击 handler。
	await loadMore.dispatchEvent("click");
	// 必须证明真的插入了更早的轮次：虚拟区只挂视口附近的行，.turn-row 数量不一定变，
	// 但文档总高一定增长（新增轮次按实测/估值占位）；只看偏移断言会把「点到步骤按钮」判成通过。
	await expect.poll(() => window.locator(".message-timeline").evaluate((element) => element.scrollHeight), { timeout: 15_000 }).toBeGreaterThan(beforeHeight);
	await window.waitForTimeout(400);

	const after = await rowOffset(window, pinned.id);
	expect(Number.isNaN(after)).toBe(false);
	expect(Math.abs(after - pinned.top)).toBeLessThanOrEqual(28);
});

test("returning to the live edge and back keeps the virtual region usable", async ({ app, window }) => {
	test.setTimeout(300_000);
	await constrainTimelineViewport(app);
	await buildHistory(window);
	await expandIntoVirtualRegion(window);
	const beforeBottom = await virtualStats(window);
	expect(beforeBottom.virtualRows).toBeGreaterThan(0);

	// 回底：窗口收回尾部 3 轮（真实区），虚拟区整块卸载。
	const bottom = window.getByRole("button", { name: /移动到最新|Scroll to bottom/ }).first();
	expect(await bottom.count()).toBeGreaterThan(0);
	await bottom.click();
	await window.waitForTimeout(1200);
	const atBottom = await virtualStats(window);
	expect(atBottom.virtualRows).toBe(0);
	expect(atBottom.solidRows).toBeLessThanOrEqual(8);

	// 再回历史：窗口重新扩到虚拟化阈值以上，虚拟区恢复且测量收敛（行不漂移）。
	await expandIntoVirtualRegion(window);
	await window.waitForTimeout(600);
	const pinned = await placeAtMiddle(window);
	expect(pinned).not.toBeNull();
	if (!pinned) return;
	await window.waitForTimeout(1200);
	const settled = await rowOffset(window, pinned.id);
	expect(Number.isNaN(settled)).toBe(false);
	expect(Math.abs(settled - pinned.top)).toBeLessThanOrEqual(2);
});

test("closing multi-select keeps a row scrolled outside the turn window", async ({ app, window }) => {
	test.setTimeout(300_000);
	await constrainTimelineViewport(app);
	await buildHistory(window);
	await expandIntoVirtualRegion(window);

	// 先真实滚轮向上，确保脱离跟随（autoScroll=false）：否则关闭多选时
	// 「回底才复位 retain」的 effect 会立刻缩窗，测不到 retain 的效果。
	const timeline = window.locator(".message-timeline");
	await timeline.hover();
	for (let attempt = 0; attempt < 8; attempt += 1) {
		await window.mouse.wheel(0, -800);
		await window.waitForTimeout(60);
	}
	await window.waitForTimeout(600);

	// 多选入口是 user-turn 上的「多选分享」按钮（hover 才显形）。DOM click 不会滚动，
	// 所以取第一个有尺寸的按钮即可（不要求落在视口内，避免长回答跨屏时找不到）。
	const opened = await window.locator(".message-timeline").evaluate((element) => {
		const button = Array.from(element.querySelectorAll<HTMLElement>(".user-turn-action-btn")).find((item) => {
			const rect = item.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		});
		button?.click();
		return Boolean(button);
	});
	expect(opened).toBe(true);
	const dialog = window.getByRole("dialog");
	await expect(dialog).toBeVisible({ timeout: 10_000 });
	await window.waitForTimeout(600);

	// 多选打开时 runs 仍是全量（只是走虚拟化）：滚到「当前 turn 窗口之外」再关。
	// 若 retain 失效，displayRuns 会缩回尾部 3 轮，这一行消失 → rowOffset 返回 NaN，用例变红。
	await placeAtMiddle(window, 0.08);
	await window.waitForTimeout(800);
	const pinned = await placeAtMiddle(window, 0.08);
	expect(pinned).not.toBeNull();
	if (!pinned) return;

	// 关闭多选：窗口不立刻缩回（retainFullRuns），锚点行必须留在原偏移；
	// 同时必须回到虚拟化，而不是永久保留全量 DOM。
	// Dialog 的「取消」在树里不唯一；Esc 是 Radix Dialog 的标准关闭路径，语义等同 onClose。
	await window.keyboard.press("Escape");
	await window.waitForTimeout(1200);
	const after = await rowOffset(window, pinned.id);
	expect(Number.isNaN(after)).toBe(false);
	expect(Math.abs(after - pinned.top)).toBeLessThanOrEqual(28);
	const stats = await virtualStats(window);
	expect(stats.virtualRows).toBeGreaterThan(0);
});

test("entryId reveal brings a virtual-region row back into view", async ({ app, window }) => {
	test.setTimeout(300_000);
	await constrainTimelineViewport(app);
	await buildHistory(window);
	await expandIntoVirtualRegion(window);

	// 先滚到顶部拿一条早期轮的行 id（此时它在 DOM 里），再回底让它被虚拟器回收。
	const timeline = window.locator(".message-timeline");
	await timeline.hover();
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (await timeline.evaluate((element) => element.scrollTop <= 1)) break;
		await window.mouse.wheel(0, -1200);
		await window.waitForTimeout(40);
	}
	// 必须真的到顶：没到顶时抓到的是尾部轮，跳转等于原地不动，断言会变成恒真。
	await expect.poll(() => timeline.evaluate((element) => element.scrollTop), { timeout: 20_000, intervals: [200, 500, 1000] }).toBeLessThanOrEqual(1);
	await window.waitForTimeout(400);
	const early = await timeline.evaluate((element) => {
		// 只取轮根里的用户气泡：它的 data-message-id 就是投影消息 id（.turn-row 上是 run id，
		// 不在 combinedMessages 里，会走错补页分支）。
		const row = element.querySelector<HTMLElement>("article.user-turn[data-message-id]");
		// 会话 id 必须取时间线内部的持有者：文档里别处的 data-session-id 可能是条目 id，
		// 与 props.sessionId 不等会让监听端把请求存成「跨会话待重放」，永不落地。
		const holder = element.querySelector<HTMLElement>("[data-session-id]");
		return { id: row?.dataset.messageId ?? "", sessionId: holder?.dataset.sessionId ?? "" };
	});
	expect(early.id).not.toBe("");
	if (!early.id) return;

	// 离开顶部后目标行会被虚拟器回收：从这里派发导航，才能证明 jumpToMessage 挂得出虚拟区外的行。
	await placeAtMiddle(window, 0.35);
	await window.waitForTimeout(800);
	// 虚拟区只挂视口附近的行：底部时早期行必须已卸出 DOM，否则本用例测不到目标路径。
	expect(await window.locator(`[data-message-id="${early.id}"]`).count()).toBe(0);

	// 渲染层通道（宿主插件导航的消费端）：目标在虚拟区外，只能靠 jumpToMessage 挂出来。
	await window.evaluate(
		(detail) => {
			window.dispatchEvent(new CustomEvent("pideck:reveal-timeline-entry", { detail }));
			// 只带 entryId：监听端对「没有 sessionId」的事件直接落位（跨会话过滤由下一条用例覆盖），
			// 这里要验的是从跟底态导航到虚拟区外那一轮的完整链路。
		},
		{ entryId: early.id },
	);

	// 先证明跳转把行挂了出来（虚拟化下这一步必须经过 pendingJump → solid），
	// 再验它落在视口里 —— 两个断言分开，失败位置能直接区分「没挂载」与「没落位」。
	await expect.poll(() => window.locator(`[data-message-id="${early.id}"]`).count(), { timeout: 25_000 }).toBeGreaterThan(0);
	await expect
		.poll(
			() =>
				timeline.evaluate((element, id) => {
					const row = element.querySelector<HTMLElement>(`[data-message-id="${id}"]`);
					if (!row) return false;
					const rect = row.getBoundingClientRect();
					const view = element.getBoundingClientRect();
					return rect.bottom > view.top && rect.top < view.bottom;
				}, early.id),
			{ timeout: 25_000 },
		)
		.toBe(true);
});

test("entryId reveal for another session does not steal the viewport", async ({ app, window }) => {
	test.setTimeout(300_000);
	await constrainTimelineViewport(app);
	await buildHistory(window);
	await expandIntoVirtualRegion(window);

	const timeline = window.locator(".message-timeline");
	await timeline.hover();
	for (let attempt = 0; attempt < 80; attempt += 1) {
		if (await timeline.evaluate((element) => element.scrollTop <= 1)) break;
		await window.mouse.wheel(0, -1200);
		await window.waitForTimeout(40);
	}
	await expect.poll(() => timeline.evaluate((element) => element.scrollTop), { timeout: 20_000, intervals: [200, 500, 1000] }).toBeLessThanOrEqual(1);
	await window.waitForTimeout(400);
	const early = await timeline.evaluate((element) => {
		const row = element.querySelector<HTMLElement>("article.user-turn[data-message-id]");
		const holder = element.querySelector<HTMLElement>("[data-session-id]");
		return { id: row?.dataset.messageId ?? "", sessionId: holder?.dataset.sessionId ?? "" };
	});
	expect(early.id).not.toBe("");
	expect(early.sessionId).not.toBe("");
	if (!early.id || !early.sessionId) return;

	await placeAtMiddle(window, 0.4);
	await window.waitForTimeout(600);
	const before = await timeline.evaluate((element) => element.scrollTop);
	expect(await window.locator(`[data-message-id="${early.id}"]`).count()).toBe(0);

	// 别的会话的事件：必须被丢弃，不能把用户手边的位置拽走（跨会话只存不跳）。
	await window.evaluate(
		(detail) => {
			window.dispatchEvent(new CustomEvent("pideck:reveal-timeline-entry", { detail }));
		},
		{ entryId: early.id, sessionId: "another-session" },
	);
	await window.waitForTimeout(900);
	const afterForeign = await timeline.evaluate((element) => element.scrollTop);
	expect(Math.abs(afterForeign - before)).toBeLessThanOrEqual(300);
	expect(await window.locator(`[data-message-id="${early.id}"]`).count()).toBe(0);

	// 同一会话再来一次：落到目标行（跨会话存下的请求不会被误用，同会话请求直接落位）。
	await window.evaluate(
		(detail) => {
			window.dispatchEvent(new CustomEvent("pideck:reveal-timeline-entry", { detail }));
		},
		{ entryId: early.id, sessionId: early.sessionId },
	);
	await expect.poll(() => window.locator(`[data-message-id="${early.id}"]`).count(), { timeout: 25_000 }).toBeGreaterThan(0);
});
