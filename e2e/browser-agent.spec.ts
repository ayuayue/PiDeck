import { test, expect } from "./fixtures";
import { openFirstSession, makeSeedProject } from "./open-session";
import { createServer, type Server } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * 浏览器 Agent 端到端 smoke（计划文档 T6）：
 * 真实 MCP 客户端 → 主进程 HTTP host → 工具注册 → BrowserController → 真实 webview guest → CDP。
 * 覆盖：条件注册（只开浏览器时不暴露 cua_*）、快照 ref、CDP 点击（默认自动放行）、
 * waitFor 页面内匹配、面板页面的真实 DOM。
 *
 * 隔离：fixtures 已把 USERPROFILE/HOME 重定向到临时目录，mcp.json 写进 userDataRoot
 * （不会碰开发者真实的 ~/.pi/agent/mcp.json），随临时目录一并清理。
 */

const seedProject = makeSeedProject("BrowserAgentE2E");
test.use({ seedProjects: [seedProject], seedSettings: { browserAgentEnabled: true } });

const PAGE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Agent Smoke</title></head>
<body>
	<main>
		<button id="add" type="button">Add item</button>
		<input id="query" type="text" placeholder="Search things" aria-label="Search" />
		<div id="out" aria-live="polite"></div>
	</main>
	<script>
		var count = 0;
		document.getElementById("add").addEventListener("click", function () {
			count += 1;
			var line = document.createElement("div");
			line.textContent = "clicked-once-" + count;
			document.getElementById("out").appendChild(line);
		});
	</script>
</body></html>`;

interface McpEntry {
	url: string;
	headers?: { Authorization?: string };
}

async function waitForMcpEntry(userDataRoot: string, timeoutMs = 20_000): Promise<{ url: string; token: string }> {
	const mcpPath = join(userDataRoot, ".pi", "agent", "mcp.json");
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (existsSync(mcpPath)) {
			try {
				const config = JSON.parse(readFileSync(mcpPath, "utf8")) as { mcpServers?: Record<string, McpEntry> };
				const entry = config.mcpServers?.["pideck-cua"];
				const authorization = entry?.headers?.Authorization ?? "";
				if (entry?.url && authorization.startsWith("Bearer ")) {
					return { url: entry.url, token: authorization.slice("Bearer ".length) };
				}
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

test("browser agent end-to-end: register, snapshot, click and wait over a real webview", async ({ window, userDataRoot }) => {
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
		// 1. 打开浏览器面板并导航到本地测试页
		// 浏览器面板默认未钉住（藏在「添加常驻面板」下拉里），先钉住再切过去。
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

		// 2. mcp.json 里出现 pideck-cua 条目（host 已随 browserAgentEnabled 启动）
		const registration = await waitForMcpEntry(userDataRoot);
		client = new Client({ name: "e2e-browser-agent-smoke", version: "1.0.0" });
		const transport = new StreamableHTTPClientTransport(new URL(registration.url), {
			requestInit: { headers: { Authorization: `Bearer ${registration.token}` } },
		});
		await client.connect(transport);

		// 3. 工具表：只开浏览器能力 → 恰好 10 个 browser_*，不泄漏 cua_*
		const tools = await client.listTools();
		const names = tools.tools.map((tool) => tool.name).sort();
		expect(names).toEqual(["browser_click", "browser_find", "browser_navigate", "browser_press_key", "browser_screenshot", "browser_scroll", "browser_snapshot", "browser_state", "browser_type", "browser_wait_for"]);

		// 4. 页面就绪后快照：真实 DOM → ref 表。
		// 面板刚挂载时 webview 的初始 about:blank 导航会异步重置地址栏，且 webview 未就绪时
		// Enter 会被 loadUrl 静默丢弃——单次 fill+Enter 不可靠，改成「探 state → 重试导航」循环。
		let snapshotPayload: Record<string, unknown> | null = null;
		let lastState: Record<string, unknown> | null = null;
		for (let attempt = 0; attempt < 30 && snapshotPayload === null; attempt += 1) {
			const state = parseToolJson(await client.callTool({ name: "browser_state", arguments: {} }));
			lastState = state;
			if (typeof state.state === "object" && state.state !== null) {
				const url = String((state.state as Record<string, unknown>).url ?? "");
				if (url.startsWith(pageUrl)) {
					snapshotPayload = parseToolJson(await client.callTool({ name: "browser_snapshot", arguments: {} }));
					break;
				}
			}
			await urlInput.fill(pageUrl);
			await urlInput.press("Enter");
			await new Promise((resolve) => setTimeout(resolve, 500));
		}
		expect(snapshotPayload, `page should load and snapshot; last browser_state = ${JSON.stringify(lastState)}`).not.toBeNull();
		const snapshotText = String(snapshotPayload?.snapshot ?? "");
		expect(snapshotText).toContain('button "Add item"');
		const refMatch = snapshotText.match(/- button "Add item" \[ref=(e\d+)\]/);
		expect(refMatch, "Add item button carries a ref").not.toBeNull();
		const ref = refMatch?.[1] as string;

		// 5. CDP 点击（默认自动放行，无审批对话框）
		const clickPayload = parseToolJson(await client.callTool({ name: "browser_click", arguments: { ref, sessionId: "e2e-smoke-session" } }));
		expect(clickPayload.ok).toBe(true);
		expect(clickPayload.gate).toBe("auto_approve");
		expect(clickPayload.degraded).toBe(false);

		// 6. waitFor 在页面内匹配点击效果（单租约轮询 + 页面内 includes）
		const waitPayload = parseToolJson(await client.callTool({ name: "browser_wait_for", arguments: { text: "clicked-once-1", timeoutMs: 10_000 } }));
		expect(waitPayload.ok).toBe(true);
		expect(waitPayload.matched).toBe(true);

		// 7. 输入框：身份校验通过后 CDP 输入
		const inputMatch = snapshotText.match(/- textbox "Search" \[ref=(e\d+)\]/);
		expect(inputMatch, "search input carries a ref").not.toBeNull();
		const typePayload = parseToolJson(
			await client.callTool({
				name: "browser_type",
				arguments: { ref: inputMatch?.[1] as string, text: "hello from agent", sessionId: "e2e-smoke-session" },
			}),
		);
		expect(typePayload.ok).toBe(true);

		// 输入值经下一次快照回读（值真实落进了页面输入框）
		const after = parseToolJson(await client.callTool({ name: "browser_snapshot", arguments: {} }));
		expect(String(after.snapshot ?? "")).toContain("hello from agent");

		// 8. 截图走 CDP 当前帧（quiet 窗口下 capturePage 兜底会是过期帧，CDP 路径必须胜出）
		const shot = await client.callTool({ name: "browser_screenshot", arguments: {} });
		const imagePart = shot.content?.find((part) => part.type === "image");
		const shotMeta = JSON.parse(shot.content?.find((part) => part.type === "text")?.text ?? "{}") as Record<string, unknown>;
		expect(imagePart?.data?.length ?? 0).toBeGreaterThan(1_000);
		expect(shotMeta.ok).toBe(true);
		expect(shotMeta.source).toBe("cdp");
		expect(Number(shotMeta.width ?? 0)).toBeGreaterThan(0);
		// 本页远低于像素预算，fullPage 不应触发 clip
		const fullShot = await client.callTool({ name: "browser_screenshot", arguments: { fullPage: true } });
		const fullMeta = JSON.parse(fullShot.content?.find((part) => part.type === "text")?.text ?? "{}") as Record<string, unknown>;
		expect(fullMeta.ok).toBe(true);
		expect(fullMeta.clipped ?? false).toBe(false);
	} finally {
		await client?.close().catch(() => {});
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});
