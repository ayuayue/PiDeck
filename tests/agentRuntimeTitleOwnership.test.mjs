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
	manager.setAutomaticTitleChangedHandler((agentId, title) => automaticTitles.push({ agentId, title }));

	manager.handlePiEvent("agent-live", {
		type: "extension_ui_request",
		method: "setStatus",
		statusKey: "pideck:auto-title",
		statusText: "Generated title",
	});
	manager.handlePiEvent("agent-live", { type: "session_info_changed", name: "Generated title" });

	assert.equal(runtime.tab.title, "Generated title");
	assert.deepEqual(automaticTitles, [{ agentId: "agent-live", title: "Generated title" }]);
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
