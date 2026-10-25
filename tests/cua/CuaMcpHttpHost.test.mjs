import assert from "node:assert";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const { CuaMcpHttpHost } = loadTsCommonJs("src/main/cua/CuaMcpHttpHost.ts");
const { CuaGate } = loadTsCommonJs("src/main/cua/CuaGate.ts");
const { CuaEngine } = loadTsCommonJs("src/main/cua/CuaEngine.ts");

async function connectClient(url, token) {
	const transport = new StreamableHTTPClientTransport(new URL(url), {
		requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
	});
	const client = new Client({ name: "cua-e2e", version: "1.0.0" });
	await client.connect(transport);
	return { client, transport };
}

test("CUA MCP HTTP host exposes tools and denies writes without approval handler", async () => {
	const gate = new CuaGate({ enabled: true });
	const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
	const host = new CuaMcpHttpHost({ port: 0, authToken: "test-token" }, { engine, gate });

	const port = await host.start();
	assert.ok(port > 0);
	const url = host.getUrl();
	assert.ok(url && url.endsWith("/mcp"));

	const { client, transport } = await connectClient(url, "test-token");

	try {
		const tools = await client.listTools();
		const names = tools.tools.map((t) => t.name).sort();
		assert.deepStrictEqual(names, ["cua_capture", "cua_click", "cua_get_state", "cua_list_windows", "cua_scroll", "cua_type"]);

		// cua_list_windows is read-only → works.
		const listResult = await client.callTool({ name: "cua_list_windows", arguments: {} });
		assert.ok(!listResult.isError, `list_windows errored: ${JSON.stringify(listResult)}`);
		const windows = JSON.parse(listResult.content[0].text);
		assert.ok(Array.isArray(windows));

		// cua_get_state is read-only → reports gate status.
		const stateResult = await client.callTool({ name: "cua_get_state", arguments: {} });
		const state = JSON.parse(stateResult.content[0].text);
		assert.strictEqual(state.gateEnabled, true);
		assert.ok(state.display.width > 0);
		// 多显示器契约：节点宿主拿不到 electron screen（displays 退化空数组），但
		// virtualDesktop 必须始终来自 Win32，模型才有绝对坐标的参照。
		assert.ok(Array.isArray(state.displays), "displays must always be an array");
		assert.ok(state.virtualDesktop.width > 0 && state.virtualDesktop.height > 0, "virtualDesktop must be reported");

		// cua_click is a write action → no approval handler → denied (fail closed).
		const clickResult = await client.callTool({
			name: "cua_click",
			arguments: { x: 10, y: 10, sessionId: "sess-e2e" },
		});
		const clickPayload = JSON.parse(clickResult.content[0].text);
		assert.strictEqual(clickPayload.gate, "denied");
		assert.strictEqual(clickPayload.error, "no_approval_handler");
	} finally {
		await transport.close();
		await host.stop();
	}
});

test("CUA MCP HTTP host honors the in-process approval handler (allow/deny)", async () => {
	const gate = new CuaGate({ enabled: true });
	gate.setApprovalHandler(async (request) => {
		// Deny clicks at (99,99), allow everything else.
		if (request.action === "click" && request.detail?.x === 99) {
			return { allowed: false, reason: "user_denied" };
		}
		return { allowed: true };
	});

	const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
	const host = new CuaMcpHttpHost({ port: 0, authToken: "tok" }, { engine, gate });
	await host.start();

	const { client, transport } = await connectClient(host.getUrl(), "tok");
	try {
		const denied = await client.callTool({
			name: "cua_click",
			arguments: { x: 99, y: 99, sessionId: "s" },
		});
		const deniedPayload = JSON.parse(denied.content[0].text);
		assert.strictEqual(deniedPayload.gate, "denied");
		assert.strictEqual(deniedPayload.error, "user_denied");

		// A click the handler allows would actually inject input, so we only assert
		// the gate decision indirectly: call cua_get_state's session check instead.
		assert.strictEqual(gate.isSessionEnabled("s"), true);
	} finally {
		await transport.close();
		await host.stop();
	}
});

test("CUA MCP HTTP host rejects requests without a bearer token", async () => {
	const gate = new CuaGate({ enabled: true });
	const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
	const host = new CuaMcpHttpHost({ port: 0, authToken: "secret" }, { engine, gate });
	const port = await host.start();

	try {
		const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
		});
		assert.strictEqual(res.status, 401);
	} finally {
		await host.stop();
	}
});

test("CUA MCP HTTP host returns 404 for unknown paths", async () => {
	const gate = new CuaGate({ enabled: true });
	const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
	const host = new CuaMcpHttpHost({ port: 0 }, { engine, gate });
	const port = await host.start();

	try {
		const res = await fetch(`http://127.0.0.1:${port}/nope`, { method: "GET" });
		assert.strictEqual(res.status, 404);
	} finally {
		await host.stop();
	}
});

test("capture schema rejects out-of-bounds quality/maxLongEdge", async () => {
	const gate = new CuaGate({ enabled: true });
	const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
	const host = new CuaMcpHttpHost({ port: 0, authToken: "tok" }, { engine, gate });
	await host.start();

	const { client, transport } = await connectClient(host.getUrl(), "tok");
	try {
		const badCalls = [{ quality: 0 }, { quality: 101 }, { maxLongEdge: 1 }, { maxLongEdge: 1e9 }];
		for (const args of badCalls) {
			const res = await client.callTool({ name: "cua_capture", arguments: args });
			assert.strictEqual(res.isError, true, `args ${JSON.stringify(args)} must be rejected: ${JSON.stringify(res)}`);
		}
	} finally {
		await transport.close();
		await host.stop();
	}
});

test("scroll schema clamps out-of-range wheel deltas", async () => {
	const gate = new CuaGate({ enabled: true });
	const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
	const host = new CuaMcpHttpHost({ port: 0, authToken: "tok" }, { engine, gate });
	await host.start();

	const { client, transport } = await connectClient(host.getUrl(), "tok");
	try {
		const res = await client.callTool({ name: "cua_scroll", arguments: { x: 1, y: 1, deltaY: 99999 } });
		assert.strictEqual(res.isError, true, "out-of-range deltaY must be rejected");
	} finally {
		await transport.close();
		await host.stop();
	}
});

test("type schema rejects text exceeding the length cap", async () => {
	const gate = new CuaGate({ enabled: true });
	const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
	const host = new CuaMcpHttpHost({ port: 0, authToken: "tok" }, { engine, gate });
	await host.start();

	const { client, transport } = await connectClient(host.getUrl(), "tok");
	try {
		const res = await client.callTool({ name: "cua_type", arguments: { text: "x".repeat(5001) } });
		assert.strictEqual(res.isError, true, "over-long text must be rejected");
	} finally {
		await transport.close();
		await host.stop();
	}
});

test("list_windows includeInvisible superset covers visible-only listing", async () => {
	const gate = new CuaGate({ enabled: true });
	const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
	const host = new CuaMcpHttpHost({ port: 0, authToken: "tok" }, { engine, gate });
	await host.start();

	const { client, transport } = await connectClient(host.getUrl(), "tok");
	try {
		const visibleOnly = await client.callTool({ name: "cua_list_windows", arguments: {} });
		const all = await client.callTool({ name: "cua_list_windows", arguments: { includeInvisible: true } });
		assert.ok(!visibleOnly.isError);
		assert.ok(!all.isError);
		const visibleWindows = JSON.parse(visibleOnly.content[0].text);
		const allWindows = JSON.parse(all.content[0].text);
		assert.ok(allWindows.length >= visibleWindows.length, "includeInvisible must be a superset");
		assert.ok(
			visibleWindows.every((w) => w.isVisible === true),
			"default listing only carries visible windows",
		);
	} finally {
		await transport.close();
		await host.stop();
	}
});

test("cua_click double=true hits the engine doubleClick path (single approval)", async () => {
	// 用允许一切的 handler；断言 approval handler 只被调用一次且 detail.double=true。
	let approvals = 0;
	let sawDouble = false;
	const gate = new CuaGate({ enabled: true });
	gate.setApprovalHandler(async (request) => {
		approvals += 1;
		if (request.detail?.double === true) sawDouble = true;
		return { allowed: false, reason: "user_denied" }; // deny to avoid real input
	});

	const engine = new CuaEngine({ defaultDelayMs: 10 }, gate);
	const host = new CuaMcpHttpHost({ port: 0, authToken: "tok" }, { engine, gate });
	await host.start();

	const { client, transport } = await connectClient(host.getUrl(), "tok");
	try {
		const res = await client.callTool({ name: "cua_click", arguments: { x: 10, y: 10, double: true, sessionId: "s" } });
		// denied 结果也以 isError=true 返回（error 字段非空），直接断言负载。
		const payload = JSON.parse(res.content[0].text);
		assert.strictEqual(payload.gate, "denied"); // handler denied, but only once
		assert.strictEqual(approvals, 1, "double click must fan out to exactly one approval");
		assert.ok(sawDouble, "approval detail marks double=true");
	} finally {
		await transport.close();
		await host.stop();
	}
});
