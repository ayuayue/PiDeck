import { test, expect } from "./mock-pi-fixture";

/**
 * 临时截图脚本（视觉走查用，非回归测试）：起 Web 服务 + mock pi，
 * 发一条含 THINK + TOOL 的消息触发思考块与工具卡，移动视口截图。
 * 运行：npx playwright test e2e/web-visual-snapshot.spec.ts
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

async function waitForHealthy(baseUrl) {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const health = await fetch(`${baseUrl}/api/health`).catch(() => null);
		if (health?.ok) return true;
	}
	return false;
}

test("visual snapshot: thinking + tool card on mobile", async ({ app }) => {
	test.setTimeout(120_000);
	const baseUrl = "http://127.0.0.1:8765";
	expect(await waitForHealthy(baseUrl)).toBe(true);
	const page = await app.firstWindow();
	// 先用桌面宽度建会话发消息（移动视口下侧栏是抽屉，项目行不可见）
	await page.setViewportSize({ width: 900, height: 812 });
	await page.goto(baseUrl);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("textarea#prompt")).toBeVisible();

	// 新建会话
	await page.locator(".project-group .project-action").first().click();
	await expect(page.locator(".chat-list-pane .session-row.active")).toHaveCount(1, { timeout: 20_000 });

	// 空态：Logo 水平居中（web.css 自带 empty-state 样式，不依赖桌面 foundation）
	const emptyState = await page.locator(".empty-state").evaluate((el) => {
		const s = getComputedStyle(el);
		return { display: s.display, align: s.alignItems, justify: s.justifyContent, hasLogo: Boolean(el.querySelector(".empty-logo")) };
	});
	expect(emptyState.hasLogo).toBe(true);
	expect(emptyState.display).toBe("flex");
	expect(emptyState.align).toBe("center");
	expect(emptyState.justify).toBe("center");
	const logoBox = await page.locator(".empty-logo").boundingBox();
	const listBox = await page.locator(".message-list").boundingBox();
	expect(logoBox).toBeTruthy();
	expect(listBox).toBeTruthy();
	const logoCenter = logoBox.x + logoBox.width / 2;
	const listCenter = listBox.x + listBox.width / 2;
	expect(Math.abs(logoCenter - listCenter)).toBeLessThanOrEqual(2, "empty logo must be horizontally centered in the timeline");

	// 触发思考 + 工具卡 + 正文
	const textarea = page.locator("textarea#prompt");
	await textarea.fill("THINK TOOL 帮我看一下目录");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text").last()).toContainText("Mock", { timeout: 30_000 });
	await page.waitForTimeout(600);

	// 切到移动视口截图（此时聊天区为主画面）
	await page.setViewportSize(MOBILE);
	await page.waitForTimeout(400);
	await page.screenshot({ path: "e2e/.snapshots/web-mobile-collapsed.png", fullPage: false });

	// 点开工具卡与思考块
	const toolButtons = page.locator(".tool-card button");
	if ((await toolButtons.count()) > 0) await toolButtons.first().click();
	const thinkButtons = page.locator("[data-marker-kind='thinking'] button");
	if ((await thinkButtons.count()) > 0) await thinkButtons.first().click();
	await page.waitForTimeout(500);
	await page.screenshot({ path: "e2e/.snapshots/web-mobile-expanded.png", fullPage: true });

	// ===== 计算样式断言（不依赖截图目视，回归真正可自动化）=====
	// 1. 工具卡无框：无边框、透明底（过程行哲学）。
	const toolCard = page.locator(".tool-card").first();
	const cardStyle = await toolCard.evaluate((el) => {
		const s = getComputedStyle(el);
		return { borderTop: s.borderTopWidth, bg: s.backgroundColor };
	});
	expect(cardStyle.borderTop).toBe("0px");
	expect(cardStyle.bg).toBe("rgba(0, 0, 0, 0)");
	// 2. 工具图标身份色 = info 蓝（亮 #3b82f6 / 暗 #60a5fa 二选一，随系统主题）。
	const iconColor = await page
		.locator(".tool-card .tool-card-icon")
		.first()
		.evaluate((el) => getComputedStyle(el).color);
	expect(["rgb(59, 130, 246)", "rgb(96, 165, 250)"]).toContain(iconColor);
	// 3. 思考行图标身份色 = 靖紫（亮 #6366f1 / 暗 #818cf8）。
	const thinkColor = await page
		.locator(".thinking-row-icon")
		.first()
		.evaluate((el) => getComputedStyle(el).color);
	expect(["rgb(99, 102, 241)", "rgb(129, 140, 248)"]).toContain(thinkColor);
	// 4. 状态 pill 自适应收缩（self-start），不再被 stretch 拉成整行。
	const pill = await page
		.locator(".agent-status-indicator")
		.first()
		.evaluate((el) => {
			const parent = el.parentElement;
			return { align: getComputedStyle(el).alignSelf, w: el.offsetWidth, pw: parent ? parent.offsetWidth : 0 };
		});
	expect(pill.align).toBe("flex-start");
	expect(pill.w).toBeLessThan(pill.pw);
	// 5. 时间线间距收紧到 gap-4（16px）。
	const gap = await page
		.locator(".message-list")
		.first()
		.evaluate((el) => getComputedStyle(el).rowGap);
	expect(gap).toBe("16px");
	// 6. 发送按钮不被工具行遮挡：提示词按钮收敛为纯图标后，工具行不溢出。
	const sendBtn = page.locator("button[type=submit]");
	const sendBox = await sendBtn.boundingBox();
	// boundingBox() 可空：显式抛错兼作类型守卫（e2e 不进 typecheck，历史遗留过 null 解引用）。
	if (!sendBox) throw new Error("send button bounding box not found before mobile viewport assertions");
	// playwright matcher 单参签名：自定义消息放 expect(value, message)，不是 matcher 第二参。
	expect(sendBox.x + sendBox.width, "send button must stay inside the mobile viewport").toBeLessThanOrEqual(375);
	const promptBtn = page.locator("button:has(.lucide-sparkles)").first();
	const promptLabel = ((await promptBtn.textContent()) ?? "").trim();
	expect(promptLabel, "prompt picker trigger must be icon-only").toBe("");
	const promptBox = await promptBtn.boundingBox();
	if (promptBox) {
		expect(promptBox.x + promptBox.width, "prompt trigger must not overlap the send button").toBeLessThanOrEqual(sendBox.x);
	}

	// 桌面宽度对照截图
	await page.setViewportSize({ width: 900, height: 812 });
	await page.waitForTimeout(400);
	await page.screenshot({ path: "e2e/.snapshots/web-desktop.png", fullPage: false });
});
