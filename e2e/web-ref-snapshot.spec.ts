import { test, expect } from "./mock-pi-fixture";

/**
 * 临时截图脚本（DeepSeek 参考改造前后对照，非回归测试）：
 * 起 Web 服务 + mock pi，截桌面/移动、空态/会话态。
 * 截图写到 e2e/.snapshots/（已 gitignore，仅本地对照，不入库）。
 * 默认跳过，避免混进回归套件；需要时显式开启：
 *   PIDECK_CAPTURE_SCREENSHOTS=1 npx playwright test e2e/web-ref-snapshot.spec.ts
 */
test.skip(process.env.PIDECK_CAPTURE_SCREENSHOTS !== "1", "manual screenshot script; set PIDECK_CAPTURE_SCREENSHOTS=1 to run");

test.use({
	seedSettings: {
		webServiceEnabled: true,
		webServiceHost: "127.0.0.1",
		webServicePort: 8766,
		webServiceRequiresAuth: false,
	},
});

const BASE = "http://127.0.0.1:8766";

async function waitForHealthy(baseUrl) {
	for (let attempt = 0; attempt < 40; attempt += 1) {
		await new Promise((resolve) => setTimeout(resolve, 500));
		const health = await fetch(`${baseUrl}/api/health`).catch(() => null);
		if (health?.ok) return true;
	}
	return false;
}

test("ref snapshot: before/after", async ({ app }) => {
	test.setTimeout(120_000);
	expect(await waitForHealthy(BASE)).toBe(true);
	const page = await app.firstWindow();

	// 桌面空态
	await page.setViewportSize({ width: 1440, height: 900 });
	await page.goto(BASE);
	await expect(page.locator(".app")).toBeVisible({ timeout: 20_000 });
	await expect(page.locator("textarea#prompt")).toBeVisible();
	await page.waitForTimeout(800);
	await page.screenshot({ path: "e2e/.snapshots/ref-desktop-empty.png" });

	// 建会话发一条消息（THINK+TOOL 触发思考块与工具卡）
	await page.locator(".project-group .project-action").first().click();
	await expect(page.locator(".chat-list-pane .session-row.active")).toHaveCount(1, { timeout: 20_000 });
	const textarea = page.locator("textarea#prompt");
	await textarea.fill("THINK TOOL 帮我看一下目录");
	await page.keyboard.press("Enter");
	await expect(page.locator(".assistant-text").last()).toContainText("Mock", { timeout: 30_000 });
	await page.waitForTimeout(800);
	await page.screenshot({ path: "e2e/.snapshots/ref-desktop-chat.png" });

	// 移动端：空态 + 抽屉
	await page.setViewportSize({ width: 390, height: 844 });
	await page.waitForTimeout(600);
	await page.screenshot({ path: "e2e/.snapshots/ref-mobile-chat.png" });
	await page.locator(".mobile-sidebar-toggle").first().click();
	await page.waitForTimeout(500);
	await page.screenshot({ path: "e2e/.snapshots/ref-mobile-drawer.png" });
});
