import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", {
	// 与 agentNotifyStripAnsi.test.mjs 同因：本机没有 electron 二进制，
	// handleUIRequest 不触达 electron.app / Notification，stub 即可。
	stubs: {
		electron: { app: {}, Notification: class {} },
	},
});

function createManager() {
	return new AgentManager(
		() => undefined,
		() => null,
		{ get: () => ({}) },
		{},
	);
}

/** 收集 agents:ui-request 的载荷。 */
function collect(manager, typed) {
	const received = [];
	const off = manager.onOutput((channel, payload) => {
		if (channel === "agents:ui-request") received.push(payload);
	});
	manager.uiGate.handleUIRequest("agent-1", typed);
	off();
	return received;
}

const MCP_ANSI = "\u001b[38;2;138;190;183m🔌 MCP: 3 servers enabled\u001b[39m";
const MCP_CLEAN = "🔌 MCP: 3 servers enabled";

/**
 * 复现（同类事故的第二条通道）：`ctx.ui.setWidget(key, string[])` 的**字符串形式**
 * 被桥刻意保持原路（§14.4 只补不拆），因此不过桥的出帧净化口；渲染层却把这些行
 * 原样画进输入框上下方的 widget 卡（`ComposerComponents.renderWidgetLine`）。
 * 扩展若用 `ctx.ui.theme.fg()` 上色，界面上就是一行 `[38;2;…m` 乱码。
 */
test("extension widget string lines are stripped of ANSI at the process boundary", () => {
	const received = collect(createManager(), {
		type: "extension_ui_request",
		method: "setWidget",
		id: "req-widget",
		widgetKey: "pi-deck-todo",
		widgetLines: [`${MCP_ANSI} 完成 1/3`, "\u001b[2Kplain line"],
		widgetPlacement: "aboveEditor",
	});
	assert.equal(received.length, 1);
	assert.deepEqual(received[0].widgetLines, [`${MCP_CLEAN} 完成 1/3`, "plain line"]);
	assert.equal(received[0].widgetKey, "pi-deck-todo");
	assert.equal(received[0].widgetPlacement, "aboveEditor");
});

test("widget lines without ANSI pass through unchanged", () => {
	const received = collect(createManager(), {
		type: "extension_ui_request",
		method: "setWidget",
		id: "req-widget-plain",
		widgetKey: "pi-deck-todo",
		widgetLines: ["✓ 写代码", "○ 跑测试"],
	});
	assert.deepEqual(received[0].widgetLines, ["✓ 写代码", "○ 跑测试"]);
});

test("widget clear (undefined lines) still clears instead of crashing", () => {
	const received = collect(createManager(), {
		type: "extension_ui_request",
		method: "setWidget",
		id: "req-widget-clear",
		widgetKey: "pi-deck-todo",
		widgetLines: undefined,
	});
	assert.equal(received[0].widgetLines, undefined);
});

/** 输入框正文（editor 通道）：同样是扩展给的文本，同样不能把转义码写进 composer。 */
test("set_editor_text strips ANSI before it reaches the composer", () => {
	const received = collect(createManager(), {
		type: "extension_ui_request",
		method: "set_editor_text",
		id: "req-editor",
		text: MCP_ANSI,
	});
	assert.equal(received[0].text, MCP_CLEAN);
});
