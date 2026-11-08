import { createServer, type Server } from "node:http";
import { test, expect } from "./mock-pi-fixture";
import { makeSeedProject, openFirstSession } from "./open-session";

/**
 * 内置浏览器生命周期回归（issue #508 第一步）：抽屉 ↔ 全屏切换不能让页面重载。
 *
 * 复现的病：BrowserSurface 此前在两种形态各渲染一个 <BrowserPanel>（两棵不同的元素树），
 * 切换时 React 卸载重挂 → <webview> 被销毁 → WebContents 重建。从 agent 侧看到的是
 * webContentsId 变化、SPA 状态与滚动位置丢失、browser_* 工具短暂报 browser_not_open。
 *
 * 两个观测点，都只随「真实文档重新加载」变化：
 * 1. 页面脚本加载时把计数器写进 <body data-boots>（DOM 属性，跨 executeJavaScript 可读）；
 * 2. 页面的滚动位置用几何量表达（占位块相对视口的位置），滚动过就是负值。
 * 页面不重载 = data-boots 仍是 1、占位块仍在视口外；任何一次重挂都会让两者复位。
 */

/** 从页面 DOM 读回「本份文档」的状态：加载标记与页面自己记下的滚动位置。 */
/**
 * 读回「本份文档」的状态：
 * - boots：页面脚本加载时写进 DOM 的标记（重载/重挂会被新文档重置或丢失）；
 * - fillerTop：首屏占位块相对于视口的位置 —— 页面向下滚过就能变成负数，
 *   用几何而不是 JS 变量表达滚动位置，避免依赖 webview 各次执行上下文是否共享。
 */
const READ_STATE = "JSON.stringify({ boots: document.body.dataset.boots || '', fillerTop: Math.round(document.getElementById('filler').getBoundingClientRect().top) })";

/**
 * 抽屉态 / 全屏态各自的 stage 容器。
 * 新结构带 data-browser-surface 标记；旧结构（修复前的两个 BrowserPanel 实例）没有该标记，
 * 回退到抽屉框 / 全屏框选择器 —— 这样同一份用例在修复前后都能定位到元素，
 * 失败信息才落在「页面是否重载」而不是「找不到夹具」上。
 */
// 抽屉里可能有多层 .drawer-content-frame（LazyWrapper 叠层），只认「直接装着浏览器面板」的那层：
// 用 :has() 反选「其上还有 .drawer-content-frame 包着」的祖先，保证拿到最内层。
// 抽屉态与全屏态是同一个 stage 节点（只换 class），这里是它两种形态的选择器。
// 抽屉态与全屏态是同一个 stage 节点（只换 class）；旧实现在抽屉里没有标记，回退到最内层抽屉框，
// 这样同一份用例在修复前后都能走到「页面是否重载」这一步，而不是卡在找不到元素。
const drawerStageLocator = (page: import("@playwright/test").Page) => page.locator(".detail-drawer .drawer-content-frame:not(:has(.drawer-content-frame)):has(.browser-panel)");
const fullscreenStageLocator = (page: import("@playwright/test").Page) => page.locator('[data-browser-surface="fullscreen"], .browser-modal:has(.browser-panel)');
const drawerWebviewLocator = (page: import("@playwright/test").Page) => page.locator(".detail-drawer .browser-panel webview.browser-webview");

const seedProject = makeSeedProject("BrowserLifecycleE2E");
test.use({ seedProjects: [seedProject] });

/**
 * 每次文档加载时服务端自增的序号（不再由页面自己写死 1）：
 * 重载 = 新文档请求 = 序号 +1，标记落进 DOM 后宿主侧能直接比对。
 */
const pageHtml = (loads: number) => `<!doctype html><html><head><meta charset="utf-8"><title>lifecycle</title></head>
<body style="margin:0">
  <div id="filler" style="height:4000px;background:linear-gradient(#fff,#cde)">tall page</div>
  <a id="deep" style="display:block;height:20px"></a>
  <script>
    // 每次真实文档加载都会重新执行，并带上这次加载的序号（重载后序号变大）。
    document.body.dataset.boots = "${loads}";
  </script>
</body></html>`;

test("browser webview survives drawer → fullscreen → drawer without reloading", async ({ window }) => {
	test.setTimeout(180_000);
	// 服务端按请求计数：webview 一旦重载就会重新请求一次文档。
	let documentLoads = 0;
	const server: Server = createServer((_req, res) => {
		documentLoads += 1;
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(pageHtml(documentLoads));
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("no server address");
	const pageUrl = `http://127.0.0.1:${address.port}/`;

	try {
		await expect(window.locator("#boot-overlay")).toHaveCount(0, { timeout: 20_000 });
		await openFirstSession(window);
		await window.locator(".header-drawer-toggle").first().click();
		await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true");

		// 浏览器面板默认未钉住（藏在「添加常驻面板」下拉里），先钉住再切过去。
		await window.getByRole("button", { name: "添加常驻面板" }).click();
		await window.getByRole("menuitemcheckbox", { name: "内置浏览器" }).click();
		await window.keyboard.press("Escape");
		const browserRail = window.getByTestId("drawer-rail-browser");
		await expect(browserRail).toBeVisible();
		await browserRail.click();
		await expect(browserRail).toHaveAttribute("aria-selected", "true");

		// 抽屉态：stage 标记 + 页面加载完成
		const drawerStage = drawerStageLocator(window);
		await expect(drawerStage).toBeVisible({ timeout: 10_000 });
		const webview = drawerStage.locator("webview.browser-webview");
		await expect(webview).toHaveCount(1);

		const urlInput = window.locator(".browser-panel input[type=text]");
		await urlInput.click();
		await urlInput.fill(pageUrl);
		await urlInput.press("Enter");

		// 等页面真正跑起来（本地页的加载标记出现在 DOM 上）
		// webview 的宿主接口只挂在元素本身上，且只经 Playwright 的 evaluate 才拿得到句柄：
		// elementHandle 在自定义标签上不可用，统一走 evaluate + 传入脚本字符串。
		const runInPage = (locator: ReturnType<typeof window.locator>, code: string) => locator.evaluate((node, script) => (node as unknown as { executeJavaScript: (s: string) => Promise<unknown> }).executeJavaScript(script), code);
		await expect.poll(() => runInPage(webview, "document.body.dataset.boots || ''"), { timeout: 20_000 }).not.toBe("");
		const loadsAfterFirstLoad = documentLoads;

		// 滚动到页面深处：走文档内锚点（#deep），滚动由浏览器自身完成。
		// 不用 window.scrollTo —— 本环境里每次 executeJavaScript 都落在独立上下文，脚本里的副作用不可靠。
		await window.locator(".browser-panel input[type=text]").click();
		await window.locator(".browser-panel input[type=text]").fill(pageUrl + "#deep");
		await window.locator(".browser-panel input[type=text]").press("Enter");
		await expect.poll(() => runInPage(webview, "Math.round(document.getElementById('filler').getBoundingClientRect().top)"), { timeout: 20_000 }).toBeLessThan(0);
		const scrolled = await runInPage(webview, READ_STATE);
		expect(JSON.parse(scrolled as string).boots).toBe(String(loadsAfterFirstLoad));

		// ── 切到全屏 ──
		await window.locator(".browser-panel svg.lucide-maximize-2").click();
		const fullStage = fullscreenStageLocator(window);
		await expect(fullStage).toBeVisible({ timeout: 10_000 });
		await expect(window.locator("[data-browser-surface-backdrop], .modal-backdrop")).toBeVisible();

		// 关键断言：全屏后仍是同一份文档 —— 加载标记没有被重置，滚动位置也还在。
		const fullWebview = fullStage.locator("webview.browser-webview");
		const fullState = JSON.parse((await runInPage(fullWebview, READ_STATE)) as string);
		// 文档没有被重新请求（序号不变），且仍停在滚动后的位置。
		expect(fullState.boots).toBe(String(loadsAfterFirstLoad));
		expect(documentLoads).toBe(loadsAfterFirstLoad);
		expect(fullState.fillerTop).toBeLessThan(0);

		// ── 切回抽屉（全屏态的最小化钮）──
		await fullStage.locator(".browser-panel svg.lucide-minus").click();
		await expect(drawerStageLocator(window)).toBeVisible({ timeout: 10_000 });

		const drawerWebview = drawerWebviewLocator(window);
		const drawerState = JSON.parse((await runInPage(drawerWebview, READ_STATE)) as string);
		expect(drawerState.boots).toBe(String(loadsAfterFirstLoad));
		expect(documentLoads).toBe(loadsAfterFirstLoad);
		expect(drawerState.fillerTop).toBeLessThan(0);

		// 全程只有一个 webview（没有残留第二个实例）
		await expect(window.locator("webview.browser-webview")).toHaveCount(1);
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
