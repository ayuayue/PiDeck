import { test, expect, type Page } from "./fixtures";
import { openFirstSession, makeSeedProject } from "./open-session";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * 浏览器 Agent 审批链路 e2e（与 browser-agent.spec.ts 互补）：
 * 关闭自动放行（browserAgentAutoApprove:false）后，写动作必须经渲染层审批框人工确认——
 * 覆盖 gate → CuaIpcManager → CuaApprovalDialog → 响应回传的完整人机回路。
 */

const seedProject = makeSeedProject("BrowserAgentApprovalE2E");
test.use({ seedProjects: [seedProject], seedSettings: { browserAgentEnabled: true, browserAgentAutoApprove: false } });

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Approval Smoke</title></head>
<body>
	<button id="go" type="button">Do work</button>
	<div id="out"></div>
	<script>
		document.getElementById("go").addEventListener("click", function () {
			document.getElementById("out").textContent = "approved-click-worked";
		});
	</script>
</body></html>`;

async function waitForMcpEntry(userDataRoot: string, timeoutMs = 20_000): Promise<{ url: string; token: string }> {
	const mcpPath = join(userDataRoot, ".pi", "agent", "mcp.json");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(mcpPath)) {
			try {
				const config = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: { "pideck-cua"?: { url?: string; headers?: { Authorization?: string } } } };
				const entry = config.mcpServers?.["pideck-cua"];
				const authorization = entry?.headers?.Authorization ?? "";
				if (entry?.url && authorization.startsWith("Bearer ")) return { url: entry.url, token: authorization.slice("Bearer ".length) };
			} catch {
				// 文件可能正被写入，继续等
			}
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
	}
	throw new Error(`pideck-cua entry did not appear in ${mcpPath} within ${timeoutMs}ms`);
}

function parseToolJson(result: { content?: Array<{ type: string; text?: string }> }): Record<string, unknown> {
	const text = result.content?.find((part) => part.type === "text")?.text ?? "";
	return JSON.parse(text) as Record<string, unknown>;
}

/** 打开浏览器面板并导航到本地页面（webview 初始导航会重置地址栏，循环重试直到 browser_state 确认）。 */
async function navigateBrowserPanel(window: Page, client: Client, pageUrl: string) {
	await openFirstSession(window);
	await window.locator(".header-drawer-toggle").first().click();
	await expect(window.locator(".detail-drawer")).toHaveAttribute("data-open", "true");
	await window.getByRole("button", { name: "添加常驻面板" }).click();
	await window.getByRole("menuitemcheckbox", { name: "内置浏览器" }).click();
	await window.keyboard.press("Escape");
	const browserRail = window.getByTestId("drawer-rail-browser");
	await expect(browserRail).toBeVisible();
	await browserRail.click();
	const urlInput = window.locator(".browser-panel input[type=text]");
	await expect(urlInput).toBeVisible({ timeout: 10_000 });
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const state = parseToolJson(await client.callTool({ name: "browser_state", arguments: {} }));
		const stateObj = typeof state.state === "object" && state.state !== null ? (state.state as Record<string, unknown>) : null;
		if (stateObj && String(stateObj.url ?? "").startsWith(pageUrl)) return;
		await urlInput.fill(pageUrl);
		await urlInput.press("Enter");
		await new Promise((resolve) => setTimeout(resolve, 500));
	}
	throw new Error(`browser panel never navigated to ${pageUrl}`);
}

test("browser agent write actions require approval when auto-approve is off", async ({ window, userDataRoot }) => {
	test.setTimeout(180_000);
	const server: Server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
		res.end(PAGE_HTML);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (typeof address !== "object" || address === null) throw new Error("no server address");
	const pageUrl = `http://127.0.0.1:${address.port}/`;

	let client: Client | null = null;
	try {
		const registration = await waitForMcpEntry(userDataRoot);
		client = new Client({ name: "e2e-approval-smoke", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(registration.url), {
			requestInit: { headers: { Authorization: `Bearer ${registration.token}` } },
		});
		await client.connect(transport);
		await navigateBrowserPanel(window, client, pageUrl);

		const snap = parseToolJson(await client.callTool({ name: "browser_snapshot", arguments: {} }));
		const refMatch = String(snap.snapshot ?? "").match(/- button "Do work" \[ref=(e\d+)\]/);
		expect(refMatch, "Do work button carries a ref").not.toBeNull();
		const ref = refMatch?.[1] as string;

		// 写动作发起后阻塞等待审批：并行等审批框出现
		const clickPromise = client.callTool({ name: "browser_click", arguments: { ref, sessionId: "e2e-approval-session" } });
		const dialog = window.getByText("CUA 操作审批").locator("xpath=ancestor::*[contains(@class,'fixed')]").first();
		await expect(dialog).toBeVisible({ timeout: 15_000 });
		// 审批详情展示动作与目标页面 URL（页面文本不可信，但 url/ref 是审批判断依据）
		await expect(dialog).toContainText("浏览器点击");
		await expect(dialog).toContainText(pageUrl);

		await dialog.getByRole("button", { name: "允许", exact: true }).click();
		const clickPayload = parseToolJson(await clickPromise);
		expect(clickPayload.ok).toBe(true);
		expect(clickPayload.gate).toBe("approved");

		const waitPayload = parseToolJson(await client.callTool({ name: "browser_wait_for", arguments: { text: "approved-click-worked", timeoutMs: 10_000 } }));
		expect(waitPayload.matched).toBe(true);
	} finally {
		await client?.close().catch(() => {});
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
