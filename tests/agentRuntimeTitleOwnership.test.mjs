import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

function createManager() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	const runtime = {
		tab: {
			id: "agent-live",
			projectId: "project-1",
			cwd: "C:/project",
			title: "PiDeck title",
			status: "idle",
			sessionId: "pi-session-1",
			sessionPath: "C:/project/.pi/sessions/session.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			runtimeGeneration: 7,
			createdAt: 1,
		},
		process: { client: { request: async () => ({ success: true, data: {} }) } },
	};
	manager.agents.set("agent-live", runtime);
	return { manager, runtime };
}

test("ordinary pi session_info changes cannot alter a PiDeck runtime title", () => {
	const { manager, runtime } = createManager();
	const automaticTitles = [];
	manager.setAutomaticTitleChangedHandler((agentId, title) => automaticTitles.push({ agentId, title }));

	manager.handlePiEvent("agent-live", { type: "session_info_changed", name: "TUI renamed title" });

	assert.equal(runtime.tab.title, "PiDeck title");
	assert.deepEqual(automaticTitles, []);
});

test("only a matching auto-title marker for the active runtime updates the title", () => {
	const { manager, runtime } = createManager();
	const automaticTitles = [];
	manager.setAutomaticTitleChangedHandler((agentId, title, source) => automaticTitles.push({ agentId, title, source }));

	manager.handlePiEvent("agent-live", {
		type: "extension_ui_request",
		method: "setStatus",
		statusKey: "pideck:auto-title",
		statusText: "Generated title",
	});
	manager.handlePiEvent("agent-live", { type: "session_info_changed", name: "Generated title" });

	assert.equal(runtime.tab.title, "Generated title");
	// 来源必须是 "auto"（终态）：catalog 据此允许它升级首条消息的 fallback（#266）。
	assert.deepEqual(automaticTitles, [{ agentId: "agent-live", title: "Generated title", source: "auto" }]);
});

// #266 回归：refreshAutoTitle 的首条消息兜底名来源标记必须是 "fallback"（可被扩展 auto 升级），
// 而不是终态——否则扩展模型标题会因「先到先锁」被拒，自动命名变成时序抽奖。
test("a first-message auto title is marked as fallback so the extension can still upgrade it", () => {
	const { manager, runtime } = createManager();
	const automaticTitles = [];
	manager.setAutomaticTitleChangedHandler((agentId, title, source) => automaticTitles.push({ agentId, title, source }));
	runtime.tab.title = "Untitled session";
	manager.messages.set("agent-live", [{ id: "m1", agentId: "agent-live", role: "user", text: "帮我看看这个报错", timestamp: 1 }]);

	manager.refreshAutoTitle("agent-live");

	assert.equal(runtime.tab.title, "帮我看看这个报错");
	assert.deepEqual(automaticTitles, [{ agentId: "agent-live", title: "帮我看看这个报错", source: "fallback" }]);
});

test("a marker without a complete runtime identity is ignored", () => {
	const { manager, runtime } = createManager();
	const automaticTitles = [];
	manager.setAutomaticTitleChangedHandler((agentId, title) => automaticTitles.push({ agentId, title }));
	delete runtime.tab.sessionId;
	delete runtime.tab.runtimeGeneration;

	manager.handlePiEvent("agent-live", {
		type: "extension_ui_request",
		method: "setStatus",
		statusKey: "pideck:auto-title",
		statusText: "Unbound generated title",
	});
	manager.handlePiEvent("agent-live", { type: "session_info_changed", name: "Unbound generated title" });

	assert.equal(runtime.tab.title, "PiDeck title");
	assert.deepEqual(automaticTitles, []);
});

test("an auto-title marker from a stale runtime generation is ignored", () => {
	const { manager, runtime } = createManager();
	const automaticTitles = [];
	manager.setAutomaticTitleChangedHandler((agentId, title) => automaticTitles.push({ agentId, title }));

	manager.handlePiEvent("agent-live", {
		type: "extension_ui_request",
		method: "setStatus",
		statusKey: "pideck:auto-title",
		statusText: "Old generated title",
	});
	runtime.tab.runtimeGeneration = 8;
	manager.handlePiEvent("agent-live", { type: "session_info_changed", name: "Old generated title" });

	assert.equal(runtime.tab.title, "PiDeck title");
	assert.deepEqual(automaticTitles, []);
});
