import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

function createRuntimeHarness() {
	const manager = new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	manager.agents.set("agent-1", {
		tab: {
			id: "agent-1",
			projectId: "project-1",
			cwd: "C:/project",
			title: "Session",
			status: "idle",
			createdAt: 1,
		},
		process: {
			client: {
				request: async () => ({ success: true, data: {} }),
			},
		},
	});
	return manager;
}

test("agent_end keeps the logical turn closed while runtime bookkeeping continues", async () => {
	const manager = createRuntimeHarness();

	manager.handlePiEvent("agent-1", { type: "agent_start" });
	assert.equal((await manager.getRuntimeState("agent-1")).isTurnActive, true);

	manager.handlePiEvent("agent-1", { type: "agent_end", messages: [] });
	assert.equal(manager.agents.get("agent-1")?.tab.status, "running");
	assert.equal((await manager.getRuntimeState("agent-1")).isTurnActive, false, "a later compaction/idle check must not reopen the completed answer turn");
});
