import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

// CuaTools 依赖 electron 的屏幕/截图 API（只在工具调用时才用），这里给空壳即可。
const electronStub = {
	screen: { getAllDisplays: () => [] },
	desktopCapturer: { getSources: async () => [] },
	nativeImage: { createFromBuffer: () => ({}) },
};
const { createCuaMcpServer } = loadTsCommonJs("src/main/cua/CuaMcpServer.ts", { stubs: { electron: electronStub } });
const { CuaGate } = loadTsCommonJs("src/main/cua/CuaGate.ts");

async function listTools(server) {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	const client = new Client({ name: "tool-surface", version: "1.0.0" });
	await client.connect(clientTransport);
	try {
		const result = await client.listTools();
		return result.tools;
	} finally {
		await client.close();
	}
}

const CUA_TOOLS = ["cua_capture", "cua_click", "cua_get_state", "cua_list_windows", "cua_scroll", "cua_type"];
const BROWSER_TOOLS = ["browser_click", "browser_find", "browser_navigate", "browser_press_key", "browser_screenshot", "browser_scroll", "browser_snapshot", "browser_state", "browser_type", "browser_wait_for"];

function makeBrowserOptions(controller = {}) {
	return { enabled: () => true, controller, gate: {} };
}

test("default factory keeps the six CUA tools (backward compatible)", async () => {
	const gate = new CuaGate({ enabled: true });
	const tools = await listTools(createCuaMcpServer({}, gate));
	assert.equal(
		tools
			.map((tool) => tool.name)
			.sort()
			.join(","),
		CUA_TOOLS.join(","),
	);
});

test("browser-only host exposes exactly the ten browser tools", async () => {
	const gate = new CuaGate({ enabled: true });
	const server = createCuaMcpServer({}, gate, { cuaEnabled: false, browser: makeBrowserOptions() });
	const tools = await listTools(server);
	assert.equal(
		tools
			.map((tool) => tool.name)
			.sort()
			.join(","),
		BROWSER_TOOLS.join(","),
	);
});

test("browser tools stay hidden while the browser switch is off (CUA tools remain)", async () => {
	const gate = new CuaGate({ enabled: true });
	const server = createCuaMcpServer({}, gate, { cuaEnabled: true, browser: { enabled: () => false, controller: {}, gate } });
	const names = (await listTools(server)).map((tool) => tool.name).sort();
	assert.equal(names.join(","), CUA_TOOLS.join(","), "browser tools must not leak into a CUA-only host");
});

test("read-only hints and required approval args are declared correctly", async () => {
	const gate = new CuaGate({ enabled: true });
	const server = createCuaMcpServer({}, gate, { cuaEnabled: false, browser: makeBrowserOptions() });
	const tools = await listTools(server);
	const byName = new Map(tools.map((tool) => [tool.name, tool]));
	assert.equal(byName.get("browser_snapshot").annotations.readOnlyHint, true);
	assert.equal(byName.get("browser_state").annotations.readOnlyHint, true);
	assert.equal(byName.get("browser_screenshot").annotations.readOnlyHint, true);
	for (const name of ["browser_click", "browser_type", "browser_press_key", "browser_navigate", "browser_scroll"]) {
		assert.equal(byName.get(name).annotations.readOnlyHint, false, `${name} must not be read-only`);
		const required = byName.get(name).inputSchema.required ?? [];
		assert.ok(required.includes("sessionId"), `${name} must require sessionId`);
	}
	assert.ok((byName.get("browser_click").inputSchema.required ?? []).includes("ref"));
});
