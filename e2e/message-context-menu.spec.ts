import { test, expect } from "./mock-pi-fixture";
import type { Locator, Page } from "@playwright/test";

/**
 * 时间线消息右键菜单（用户需求：「现在回复的选中，没有操作，是否可以加一些右键操作，比如复制」）。
 *
 * 为什么必须在这一层守：
 * - 「右键不塌陷选区」依赖浏览器真实的 pointerdown → contextmenu 事件顺序（Chromium 在选区外
 *   按右键会把选区收掉），单测只能测纯策略，测不到快照时机；
 * - 坐标菜单的定位、Radix 菜单项点击、剪贴板真实写入只能端到端验证；
 * - 流式期间 live 正文没有 data-message-id（最近锚点是 turn row 的 run id），必须证明走的是
 *   DOM 文本回退而不是复制到本轮首条工具/思考消息。
 *
 * 断言设计：右键 → 菜单出现 → 点复制项 → 读回真实剪贴板（preload 同步 IPC）。
 */

/** 等待合成器可用（UI 2.0 首次输入即激活 runtime，同 selection-quote.spec.ts）。 */
async function startComposer(window: Page): Promise<Locator> {
	await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
	const composer = window.locator(".composer .rich-input");
	await expect(composer).toHaveAttribute("contenteditable", "true", { timeout: 30_000 });
	return composer;
}

/** 真实鼠标拖选（右键菜单的选区快照挂在原生 pointerdown 上，必须走真实指针事件）。 */
async function dragSelect(window: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
	await window.mouse.move(from.x, from.y);
	await window.mouse.down();
	await window.mouse.move(to.x, to.y, { steps: 12 });
	await window.mouse.up();
}

/** 当前浏览器选区文本。 */
function selectedText(window: Page): Promise<string> {
	return window.evaluate(() => window.getSelection()?.toString() ?? "");
}

/** 读系统剪贴板纯文本（preload 暴露的同步 IPC，不依赖 document focus）。 */
function readClipboard(window: Page): Promise<string> {
	return window.evaluate(() => {
		const api = (window as unknown as { piDesktop?: { clipboard?: { readText?: () => string } } }).piDesktop;
		return api?.clipboard?.readText?.() ?? "";
	});
}

/** 消息右键菜单（Radix DropdownMenu 的 portal 内容）。 */
function menuLocator(window: Page) {
	return window.locator("[data-slot='dropdown-menu-content']");
}

type ViewportPoint = { x: number; y: number };
type ViewportRect = { x: number; y: number; width: number; height: number };

/**
 * 最终回答第一段的视口矩形（页面内一次 scroll + 量取）。
 *
 * 为什么不用 Playwright locator 做坐标：settle 后 MarkdownStream 先保持流式末帧的轻量渲染，
 * 再用 requestIdleCallback（timeout 1500）在空闲时把正文整块重挂成全量渲染；这段时间里
 * 段落节点会被替换，已拿到的 locator 句柄随即 detached —— scrollIntoViewIfNeeded /
 * boundingBox 会抛 "Element is not attached to the DOM"（实测在负载高的机器上第一条用例
 * 就命中了）。每次都在页面里按当下 DOM 重新查询，就不会踩到「量完坐标、点击前节点被换掉」。
 * 重试走 expect.poll：DOM 尚未挂载 / 尺寸为零 / 不在视口内时返回 null 继续轮询。
 */
async function answerParagraphRect(window: Page): Promise<ViewportRect> {
	let latest: ViewportRect | null = null;
	await expect
		.poll(
			async () => {
				latest = await window.evaluate(() => {
					const paragraph = document.querySelector(".message-timeline [data-final-answer] p");
					if (!(paragraph instanceof HTMLElement)) return null;
					// 每次重新居中：复制/上一次右键后的滚动不影响下一次落点。
					paragraph.scrollIntoView({ block: "center" });
					const rect = paragraph.getBoundingClientRect();
					if (rect.width < 40 || rect.height <= 0) return null;
					// 鼠标事件用视口坐标：完整落在视口内才可点
					if (rect.top < 8 || rect.bottom > window.innerHeight - 8) return null;
					return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
				});
				return latest;
			},
			{ timeout: 10_000, message: "最终回答第一段必须已挂载且可测量" },
		)
		.not.toBeNull();
	const rect: ViewportRect | null = latest;
	if (!rect) throw new Error("final answer paragraph rect is unavailable");
	return rect;
}

/** 最终回答第一段的右键落点（段落左侧 20px、垂直居中）。 */
async function answerParagraphPoint(window: Page): Promise<ViewportPoint> {
	const rect = await answerParagraphRect(window);
	return { x: rect.x + 20, y: rect.y + rect.height / 2 };
}

/**
 * 当前高亮选区的可命中点（选区矩形中心偏左）。
 *
 * 为什么不在拖选前把坐标算死：settle 后的「回复定位」流水线会在停顿若干百毫秒后把本轮
 * 拉到视口中上方，段落位置会整体移动（实测拖选后高亮矩形比拖选前量到的段落坐标高 40+px），
 * 按旧坐标右键就落到高亮外，Chromium 先清选区、菜单退化成「整条消息复制」。
 * 这里在拖选完成后按**实时选区矩形**重新取点，天然跟着布局漂移走。
 */
async function selectionCenterPoint(window: Page): Promise<ViewportPoint> {
	let latest: ViewportPoint | null = null;
	await expect
		.poll(
			async () => {
				latest = await window.evaluate(() => {
					const selection = window.getSelection();
					if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
					const rect = selection.getRangeAt(0).getBoundingClientRect();
					if (rect.width < 4 || rect.height <= 0) return null;
					if (rect.top < 8 || rect.bottom > window.innerHeight - 8) return null;
					return { x: rect.left + Math.min(24, rect.width / 2), y: rect.top + rect.height / 2 };
				});
				return latest;
			},
			{ timeout: 10_000, message: "拖选后必须有可见的高亮矩形" },
		)
		.not.toBeNull();
	const point: ViewportPoint | null = latest;
	if (!point) throw new Error("selection center point is unavailable");
	return point;
}

/**
 * 在最终回答第一段里拖出非空选区（失败重试）。
 *
 * settle 后的「回复定位」流水线会延迟把本轮拉到视口中上方，段落可能在「量坐标 → 拖选」
 * 之间整体位移，导致 mouse down/up 落在空白上、选区为空。重试时重新量取即可；
 * 后面的右键落点走「实时选区矩形」，不依赖这里的旧坐标。
 */
async function dragSelectParagraphText(window: Page): Promise<string> {
	let last = "";
	for (let attempt = 0; attempt < 6; attempt += 1) {
		const rect = await answerParagraphRect(window);
		const y = rect.y + rect.height / 2;
		await dragSelect(window, { x: rect.x + 16, y }, { x: rect.x + Math.min(120, rect.width - 8), y });
		last = (await selectedText(window)).trim();
		if (last.length > 0) return last;
		await window.waitForTimeout(120);
	}
	throw new Error(`拖不出非空选区（最后一次：${JSON.stringify(last)}）`);
}

/**
 * live 流式正文的可点击点（页面内实时量取，单次 evaluate）。
 *
 * 不能用 locator.boundingBox()：流式正文每次 chunk 都重挂/位移，等它「稳定」往往等到流结束、
 * live 副本卸载，坐标随即失效（实测右键落到 settled 正文上，菜单项与断言全变）。
 */
async function liveAnswerPoint(window: Page): Promise<ViewportPoint> {
	let latest: ViewportPoint | null = null;
	await expect
		.poll(
			async () => {
				latest = await window.evaluate(() => {
					const nodes = document.querySelectorAll<HTMLElement>(".message-timeline [data-live-answer]");
					const element = nodes[nodes.length - 1];
					if (!element) return null;
					const rect = element.getBoundingClientRect();
					if (rect.width < 40 || rect.height < 20 || rect.top < 8 || rect.bottom > window.innerHeight - 8) return null;
					return { x: rect.left + 24, y: rect.top + 14 };
				});
				return latest;
			},
			{ timeout: 30_000, message: "live 流式正文必须仍挂载且可点击" },
		)
		.not.toBeNull();
	const point: ViewportPoint | null = latest;
	if (!point) throw new Error("live answer point is unavailable");
	return point;
}

/**
 * 发送 MDEMO 提示让 mock pi 回复多段落富文本，并等到 settle（final answer 常驻 + live 副本卸载）。
 * 返回最终回答容器（[data-final-answer]，data-message-id 指向原文消息）。
 */
async function sendMdemoAndSettle(window: Page, composer: Locator, prompt: string): Promise<Locator> {
	const timeline = window.locator(".message-timeline");
	await composer.click();
	await window.keyboard.type(prompt);
	await window.keyboard.press("Enter");
	const answer = timeline.locator("[data-final-answer]").last();
	await expect(answer).toContainText("以下是渲染元素巡检", { timeout: 30_000 });
	await expect(timeline.locator(".turn-row--complete")).toHaveCount(1, { timeout: 60_000 });
	await expect(timeline.locator("[data-live-answer]")).toHaveCount(0, { timeout: 30_000 });
	// live 副本卸载只代表「settled 副本接管」——MarkdownStream 这时仍可能顶着流式末帧的
	// 轻量渲染，等待 requestIdleCallback（timeout 1500）空闲时才切全量渲染并整块重挂正文。
	// [data-md-frozen] 冻结包装节点只存在于轻量渲染路径：它归零才说明全量渲染已提交、DOM 稳定。
	await expect(answer.locator("[data-md-frozen]")).toHaveCount(0, { timeout: 5_000 });
	// 全量渲染提交后再给一拍，让 React 的后续 microtask/paint 收尾（替换裸 1200ms 的赌注）。
	await window.waitForTimeout(150);
	return answer;
}

test("message context menu: right click on a selection copies exactly the selected text", async ({ window }) => {
	test.setTimeout(180_000);
	const composer = await startComposer(window);
	const answer = await sendMdemoAndSettle(window, composer, "MDEMO 右键复制选区回归");

	// 第一段是单行短句：拖选后段内选区稳定，右键落点按实时选区矩形取（见 selectionCenterPoint）。
	// 坐标全部走页面内量取，避免 locator 在 settle 重挂/定位漂移时 detached。
	const selected = await dragSelectParagraphText(window);
	expect(selected.length, "拖选必须真的选中了文本").toBeGreaterThan(0);

	// 右键落在高亮文字上：落点必须压在高亮矩形内，否则 Chromium 会把「点在选区外」
	// 当成新的光标动作、先清掉选区（快照也会因此为空）。按实时选区矩形取点，避开布局漂移。
	const inside = await selectionCenterPoint(window);
	await window.mouse.click(inside.x, inside.y, { button: "right" });
	const menu = menuLocator(window);
	await expect(menu).toBeVisible({ timeout: 5_000 });
	// 复制项互斥：有选区时菜单只能有一个「复制」（用户反馈「复制就有三个」），
	// 整条消息的「复制为文本 / 复制为 Markdown」不得与选区复制并列。
	await expect(menu.getByRole("menuitem", { name: "复制为文本", exact: true })).toHaveCount(0);
	await expect(menu.getByRole("menuitem", { name: "复制为 Markdown", exact: true })).toHaveCount(0);
	await expect(menu.getByRole("menuitem", { name: "全选", exact: true })).toBeVisible();
	await menu.getByRole("menuitem", { name: "复制", exact: true }).click();

	// 剪贴板写入是异步 IPC：poll 到内容到位或超时（不能立即读，避免时序假红）。
	await expect.poll(() => readClipboard(window), { timeout: 5_000 }).toBe(selected);
});

test("message context menu: without selection copies the whole message as text and markdown", async ({ window }) => {
	test.setTimeout(180_000);
	const composer = await startComposer(window);
	await sendMdemoAndSettle(window, composer, "MDEMO 右键复制整条消息");

	// 无选区右键：菜单第一组是「复制为文本 / 复制为 Markdown」（没有「复制」项）。
	// 坐标全部走页面内量取（见 answerParagraphPoint）：settle 全量渲染会重挂正文，
	// 先量好一次的 locator 坐标在点击前可能已经 detached。
	const firstPoint = await answerParagraphPoint(window);
	expect(firstPoint.y, "段落必须落在视口内").toBeGreaterThan(0);
	const menu = menuLocator(window);
	const openMenu = async () => {
		// 上一次菜单必须已卸载，否则 toBeVisible 会命中旧菜单（复制后 Radix 关闭是异步的）。
		await expect(menu).toHaveCount(0);
		// 每次右键前重新量取同一段落坐标（页面内查询，不持有 locator 句柄）。
		const point = await answerParagraphPoint(window);
		await window.mouse.click(point.x, point.y, { button: "right" });
		await expect(menu).toBeVisible({ timeout: 5_000 });
	};

	await openMenu();
	await expect(menu.getByRole("menuitem", { name: "复制", exact: true })).toHaveCount(0);
	await menu.getByRole("menuitem", { name: "复制为文本", exact: true }).click();
	await expect.poll(() => readClipboard(window), { timeout: 5_000 }).toContain("以下是渲染元素巡检");
	const copiedText = await readClipboard(window);
	// 纯文本形态已剥掉 markdown 语法（围栏代码块只剩代码内容）
	expect(copiedText).not.toContain("\u0060\u0060\u0060");

	// 再开一次菜单取原文：Markdown 形态保留围栏等语法，供用户粘进文档。
	await openMenu();
	await menu.getByRole("menuitem", { name: "复制为 Markdown", exact: true }).click();
	await expect.poll(() => readClipboard(window), { timeout: 5_000 }).toContain("\u0060\u0060\u0060ts");

	// 「全选」把命中消息的正文全部选中（settled 正文根节点 data-message-id / .markdown-body）。
	await openMenu();
	await menu.getByRole("menuitem", { name: "全选", exact: true }).click();
	await expect.poll(async () => (await selectedText(window)).includes("以下是渲染元素巡检")).toBe(true);
});

test("message context menu: works while the reply is still streaming (live body fallback)", async ({ window }) => {
	test.setTimeout(180_000);
	const composer = await startComposer(window);
	const timeline = window.locator(".message-timeline");

	// SLOW 让 mock pi 每 220ms 才吐一块：留出「右键时仍在流式」的稳定窗口。
	await composer.click();
	await window.keyboard.type("SLOW MDEMO 流式右键复制");
	await window.keyboard.press("Enter");
	const live = timeline.locator("[data-live-answer]");
	await expect(live).toHaveCount(1, { timeout: 30_000 });
	await expect(live).toContainText("以下是渲染元素巡检", { timeout: 30_000 });
	// 自校验：此刻还没 settle（最终回答尚未出现），确实在流式窗口里
	await expect(timeline.locator("[data-final-answer]")).toHaveCount(0);

	// 坐标右键：live 正文每次 chunk 都会重挂 DOM，按元素句柄点容易撞上 detached，
	// 页面内实时量取坐标后立刻点击，才能保证这一击仍落在流式副本上。
	const point = await liveAnswerPoint(window);
	await window.mouse.click(point.x, point.y, { button: "right" });
	const menu = menuLocator(window);
	await expect(menu).toBeVisible({ timeout: 5_000 });
	// live 正文没有原始 markdown：只有文本回退一项 + 全选，不能出现「复制为 Markdown」。
	await expect(menu.getByRole("menuitem", { name: "复制为 Markdown", exact: true })).toHaveCount(0);
	await expect(menu.getByRole("menuitem", { name: "全选", exact: true })).toBeVisible();
	await menu.getByRole("menuitem", { name: "复制为文本", exact: true }).click();

	// 复制的是「菜单打开那一刻」的 DOM 文本快照（流式仍在推进，不能按最新全文断言）。
	await expect.poll(() => readClipboard(window), { timeout: 5_000 }).toContain("以下是渲染元素巡检");
});
