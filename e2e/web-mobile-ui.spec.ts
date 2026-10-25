import { test, expect } from "./mock-pi-fixture";

/**
 * Web 端移动端专项（第三批 DeepSeek 式交互 + 移动可用性）：
 * 手机视口（375×812）下验证——
 * 1) 布局：无横向溢出；composer 两行工具区（操作行 + 模型行）展开后可见且对齐
 * 2) C1：窄屏空闲时输入区折叠为单行，聚焦展开、有草稿保持展开
 * 2) 模型 BottomSheet：贴底弹出、选择后关闭并更新 pill
 * 3) 思考 BottomSheet：档位列表可选、pill 标签更新
 * 4) 触屏（pointer:coarse）：消息操作按钮常驻可见（CDP 模拟，不可用则跳过）
 *
 * 语言敏感的断言一律用结构定位（按钮顺序/文本变化），不依赖 zh/en 文案。
 */
test.use({
	seedSettings: {
		webServiceEnabled: true,
		webServiceHost: "127.0.0.1",
		webServicePort: 8765,
		webServiceRequiresAuth: false,
	},
});

const MOBILE = { width: 375, height: 812 };

async function waitForHealthy(baseUrl: string): Promise<boolean> {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const health = await fetch(`${baseUrl}/api/health`).catch(() => null);
		if (health?.ok) return true;
	}
	return false;
}

async function openMobilePage(app: import("@playwright/test").ElectronApplication) {
	const baseUrl = "http://127.0.0.1:8765";
	expect(await waitForHealthy(baseUrl)).toBe(true);
	const page = await app.firstWindow();
	await page.setViewportSize(MOBILE);
	await page.goto(baseUrl);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("textarea#prompt")).toBeVisible();
	return page;
}

/** 窄屏默认折叠（C1）：聚焦输入框才展开两行工具区；折叠时两行留在 DOM 里但收成 0 高 + inert。 */
async function expandComposer(page: import("@playwright/test").Page) {
	await page.locator("textarea#prompt").click();
	const toolRows = page.getByTestId("web-composer-tool-rows");
	await expect(toolRows).not.toHaveAttribute("inert", "");
	// 等展开动画（grid-rows 240ms）落定再量几何：动画中两行会被逐步裁出，逐个按钮取 box 会拿到不同 y
	await expect.poll(async () => (await page.locator(".composer-box").boundingBox())?.height ?? 0, { timeout: 3_000 }).toBeGreaterThan(150);
	await page.waitForTimeout(80);
	return { toolRows, opsRow: page.getByTestId("web-composer-ops-row"), modelRow: page.getByTestId("web-composer-model-row") };
}

test("mobile: layout fits and composer toolbar stays reachable", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openMobilePage(app);

	// 无横向溢出（html 层）
	const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
	expect(overflow).toBeLessThanOrEqual(0);

	// 头部契约：图标按钮 32px 见方（曾因 legacy .chat-header-actions button min-width:60px 撑成 60px 宽）；
	// 标题不被动作区挤压截断（曾因旧移动端规则 actions width:100% 把标题挤到 5 个字）
	const headerActions = page.locator(".web-header-actions");
	await expect(headerActions).toBeVisible();
	for (const button of await headerActions.locator("button:visible").all()) {
		const btnBox = await button.boundingBox();
		expect(Math.abs((btnBox?.width ?? 0) - 32)).toBeLessThanOrEqual(1);
		expect(Math.abs((btnBox?.height ?? 0) - 32)).toBeLessThanOrEqual(1);
	}
	const titleBlock = page.locator(".web-title-block strong");
	await expect(titleBlock).toBeVisible();
	const titleTruncated = await titleBlock.evaluate((el) => el.scrollWidth > el.clientWidth + 1);
	expect(titleTruncated).toBe(false);
	const [titleBox, actionsBox] = await Promise.all([titleBlock.boundingBox(), headerActions.boundingBox()]);
	expect((titleBox?.x ?? 0) + (titleBox?.width ?? 0)).toBeLessThanOrEqual((actionsBox?.x ?? 999) + 1);

	// 工具区两行：操作行（附件/提示词/计划/发送）+ 模型行（模型/思考 pill）；窄屏默认折叠，先聚焦展开
	const { opsRow, modelRow } = await expandComposer(page);
	const sendButton = opsRow.getByTestId("web-composer-send");
	await expect(sendButton).toBeVisible();
	const sendBox = await sendButton.boundingBox();
	expect(sendBox?.x ?? 999).toBeGreaterThanOrEqual(0);
	expect((sendBox?.x ?? 0) + (sendBox?.width ?? 0)).toBeLessThanOrEqual(MOBILE.width);

	// 布局对齐契约：每行内所有可见控件高度一致（h-8=32px）且在同一中心线
	// ——曾因图标按钮 h-7 与 pill h-8 混排、legacy textarea height:100% 挤压而错位（2027-02 修复）
	for (const row of [opsRow, modelRow]) {
		const visibleButtons = await row.locator("button:visible").all();
		expect(visibleButtons.length).toBeGreaterThanOrEqual(2);
		let baselineCenter = 0;
		for (const button of visibleButtons) {
			const btnBox = await button.boundingBox();
			expect(Math.abs((btnBox?.height ?? 0) - 32)).toBeLessThanOrEqual(1);
			const center = (btnBox?.y ?? 0) + (btnBox?.height ?? 0) / 2;
			if (baselineCenter === 0) baselineCenter = center;
			else expect(Math.abs(center - baselineCenter)).toBeLessThanOrEqual(1);
		}
	}
});

test("mobile: idle composer collapses to one line and re-expands on focus", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openMobilePage(app);

	// 折叠态：只有 textarea + 发送钮；两行工具区留在 DOM 里但收成 0 高 + inert
	// （不卸载：否则提示词弹层、文件输入框、prefill 焦点都会随之销毁）
	const box = page.locator(".composer-box");
	const toolRows = page.getByTestId("web-composer-tool-rows");
	await expect(toolRows).toHaveAttribute("inert", "");
	await expect(page.getByTestId("web-composer-send")).toBeVisible();
	const collapsedBox = await box.boundingBox();
	expect(collapsedBox?.height ?? 999).toBeLessThanOrEqual(80);

	// 聚焦展开：两行工具区回来，高度明显抬升
	await expandComposer(page);
	const expandedBox = await box.boundingBox();
	expect((expandedBox?.height ?? 0) - (collapsedBox?.height ?? 0)).toBeGreaterThanOrEqual(60);

	// 有草稿时即使失焦也不折叠（否则用户看不到自己正在输入的内容）
	await page.locator("textarea#prompt").fill("draft");
	await page.locator(".message-timeline").click({ position: { x: 10, y: 10 } });
	await expect(toolRows).not.toHaveAttribute("inert", "");

	// 清空并失焦 → 回到折叠态
	await page.locator("textarea#prompt").fill("");
	await page.locator(".message-timeline").click({ position: { x: 10, y: 10 } });
	await expect(toolRows).toHaveAttribute("inert", "", { timeout: 5_000 });
});

test("mobile: model bottom sheet opens from bottom and selection updates pill", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openMobilePage(app);

	// 模型 pill = 模型行第一个按钮（折叠态不存在，先聚焦展开）
	const { modelRow } = await expandComposer(page);
	const modelPill = modelRow.locator("button").first();
	const before = ((await modelPill.textContent()) ?? "").trim();

	await modelPill.click();
	// 弹层出现（role=dialog）且贴底（底边 ≈ 视口高）
	const sheet = page.locator("[role='dialog']");
	await expect(sheet).toBeVisible({ timeout: 5_000 });
	const sheetBox = await sheet.boundingBox();
	expect(sheetBox).not.toBeNull();
	expect(MOBILE.height - ((sheetBox?.y ?? 0) + (sheetBox?.height ?? 0))).toBeLessThanOrEqual(2);

	// 模型列表有可选行（h-12 大触控行）；点第一行 → 弹层关闭
	const firstRow = sheet.locator("ul button, div ul button").first();
	await expect(firstRow).toBeVisible();
	await firstRow.click();
	await expect(sheet).toBeHidden({ timeout: 5_000 });

	// pill 文本更新（选中模型名替换初始占位）。弹层内点选后焦点已离开输入区，
	// 窄屏会回到折叠态：重新聚焦再读 pill（同时验证折叠语义本身）
	const reopened = await expandComposer(page);
	const after = ((await reopened.modelRow.locator("button").first().textContent()) ?? "").trim();
	expect(after).not.toBe(before);
});

test("mobile: thinking sheet lists levels and updates pill", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openMobilePage(app);

	// 思考 pill = 模型行第二个按钮（相机仅 coarse 显示，鼠标模式不占位）
	const { modelRow } = await expandComposer(page);
	const thinkingPill = modelRow.locator("button").nth(1);
	const before = ((await thinkingPill.textContent()) ?? "").trim();

	await thinkingPill.click();
	const sheet = page.locator("[role='dialog']");
	await expect(sheet).toBeVisible({ timeout: 5_000 });

	// 档位列表至少 5 行（off..max 7 档，宽言断言≥5 防御增删档位）
	const rows = sheet.locator("ul li button, ul button");
	expect(await rows.count()).toBeGreaterThanOrEqual(5);

	await rows.last().click();
	await expect(sheet).toBeHidden({ timeout: 5_000 });
	const reopened = await expandComposer(page);
	const after = ((await reopened.modelRow.locator("button").nth(1).textContent()) ?? "").trim();
	expect(after).not.toBe(before);
});

test("mobile: message actions reachable without hover (focus-within path)", async ({ app }) => {
	test.setTimeout(120_000);
	const page = await openMobilePage(app);

	// 发一条消息拿到用户气泡（mock pi 自动回复）
	const textarea = page.locator("textarea#prompt");
	await textarea.fill("mobile touch");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text").first()).toBeVisible({ timeout: 30_000 });

	// 触屏无 hover：操作条依赖 focus-within 常驻（tap 即聚焦）；CSS 层另有
	// [@media(pointer:coarse)]:opacity-100 常驻（Electron CDP 无法模拟 pointer 特性，行为路径在此验证）
	const actionBar = page.locator("[class*='group/user'] .opacity-0").first();
	const actionButton = actionBar.locator("button").first();
	await expect(actionButton).toBeVisible();
	await actionButton.focus();
	// 操作条带 150ms opacity 过渡：轮询到终态而非立即读中间值
	await expect.poll(async () => Number(await actionBar.evaluate((el) => getComputedStyle(el).opacity)), { timeout: 2_000 }).toBe(1);
});
