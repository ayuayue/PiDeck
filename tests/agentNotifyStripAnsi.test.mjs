import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", {
	// 本机 node_modules/electron 未装二进制：真实 require 会触发 install.js 下载（60s+ 超时）。
	// AgentManager 只在 createPiProcess 路径用到 electron.app/Notification，handleUIRequest 不触达，stub 即可。
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

/**
 * 复现：billion-context-pi 等扩展用 ctx.ui.notify() 发通知时，消息自带终端颜色
 * 转义（如 `\x1B[32m✔ ACP auto-updated 0.1.34 → 0.1.36...\x1B[0m`）。toast 不是终端，
 * 若在进程边界不清洗，渲染层 sonner toast 会显示乱码转义符。
 */
test("extension notify strips ANSI escapes before delivering to renderer", () => {
	const manager = createManager();
	const received = [];
	const off = manager.onOutput((channel, payload) => {
		if (channel === "agents:ui-request") received.push(payload);
	});
	manager.uiGate.handleUIRequest("agent-1", {
		type: "extension_ui_request",
		method: "notify",
		id: "req-1",
		message: "\u001B[32m\u2714 ACP auto-updated 0.1.34 \u2192 0.1.36. Restart Pi to finish.\u001B[0m",
		notifyType: "info",
	});
	off();
	assert.equal(received.length, 1);
	assert.equal(received[0].message, "\u2714 ACP auto-updated 0.1.34 \u2192 0.1.36. Restart Pi to finish.");
	assert.equal(received[0].requestId, "req-1");
	assert.equal(received[0].notifyType, "info");
});

test("extension notify without ANSI escapes passes through unchanged", () => {
	const manager = createManager();
	const received = [];
	const off = manager.onOutput((channel, payload) => {
		if (channel === "agents:ui-request") received.push(payload);
	});
	manager.uiGate.handleUIRequest("agent-1", {
		type: "extension_ui_request",
		method: "notify",
		id: "req-2",
		message: "Plain message",
	});
	off();
	assert.equal(received.length, 1);
	assert.equal(received[0].message, "Plain message");
});
