import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 删除项目的运行态判定（issue #360）：
 * session-catalog 的 status 只表示「已激活」，不是运行标记；是否拦住删除必须看 pi 进程是否真的存活。
 * 进程退出后 runtime 仍留在 agents 里（tab.status = closed 供 UI 重连），不能永远挡住删除。
 */
const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");

function createManager() {
	return new AgentManager(
		() => ({ id: "project-1", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
}

function createRuntime({ id, projectId = "project-1", running, standby }) {
	return {
		tab: {
			id,
			projectId,
			cwd: "C:/project",
			title: "Session",
			status: running ? "idle" : "closed",
			createdAt: 1,
			standby: standby ? true : undefined,
		},
		process: {
			pid: running ? 4242 : undefined,
			isRunning: () => running,
			stop: () => {},
			client: { request: async () => ({ success: true, data: {} }) },
		},
	};
}

test("hasAgentForProject ignores a runtime whose pi process already exited", () => {
	const manager = createManager();
	manager.agents.set("agent-dead", createRuntime({ id: "agent-dead", running: false }));

	assert.equal(manager.hasAgentForProject("project-1"), false);
});

test("hasAgentForProject still blocks while a live pi process remains", () => {
	const manager = createManager();
	manager.agents.set("agent-live", createRuntime({ id: "agent-live", running: true }));

	assert.equal(manager.hasAgentForProject("project-1"), true);
	assert.equal(manager.hasAgentForProject("project-2"), false);
});

test("discardStoppedAgentsForProject drops dead runtimes only and leaves live ones", () => {
	const manager = createManager();
	manager.agents.set("agent-dead", createRuntime({ id: "agent-dead", running: false }));
	manager.agents.set("agent-live", createRuntime({ id: "agent-live", running: true }));
	manager.agents.set("other-dead", createRuntime({ id: "other-dead", projectId: "project-2", running: false }));

	const discarded = manager.discardStoppedAgentsForProject("project-1");

	assert.equal(discarded, 1);
	assert.equal(manager.agents.has("agent-dead"), false);
	assert.equal(manager.agents.has("agent-live"), true);
	assert.equal(manager.agents.has("other-dead"), true);
});

test("standby agent never blocks project removal even before it is released", () => {
	const manager = createManager();
	manager.agents.set("standby-1", createRuntime({ id: "standby-1", running: true, standby: true }));

	assert.equal(manager.hasAgentForProject("project-1"), false);
});

test("released standby process no longer blocks project removal", () => {
	const manager = createManager();
	manager.agents.set("standby-1", createRuntime({ id: "standby-1", running: true, standby: true }));
	manager.standbyPool = {
		status: () => ({ projectId: "project-1", agentId: "standby-1", idleMs: 0 }),
		clear: () => "standby-1",
	};

	assert.equal(manager.releaseStandbyAgent("project-1"), true);
	assert.equal(manager.agents.has("standby-1"), false);
	assert.equal(manager.hasAgentForProject("project-1"), false);
});

test("projects:remove 先回收预热进程、按存活判定、删除后清理已退出 runtime", () => {
	const source = readFileSync("src/main/ipc/projectsIpc.ts", "utf8");
	const handler = source.slice(source.indexOf("ipcChannels.projectsRemove"));
	const releaseAt = handler.indexOf("releaseStandbyAgent(projectId)");
	const guardAt = handler.indexOf("hasAgentForProject(id)");
	const discardAt = handler.indexOf("discardStoppedAgentsForProject(projectId)");

	assert.ok(releaseAt >= 0, "projects:remove 必须回收本项目预热进程");
	assert.ok(guardAt >= 0, "projects:remove 必须按存活进程判定运行中 Agent");
	assert.ok(releaseAt < guardAt, "预热进程回收必须在拦截判定之前");
	assert.ok(discardAt > guardAt, "删除成功后必须清理已退出的 runtime");
});

test("stopAndWaitForExit returns immediately for an already-exited process and drops the runtime", async () => {
	const manager = createManager();
	manager.agents.set("agent-dead", createRuntime({ id: "agent-dead", running: false }));

	assert.equal(await manager.stopAndWaitForExit("agent-dead", 100), true);
	assert.equal(manager.agents.has("agent-dead"), false);
});

test("stopAndWaitForExit waits until the process reports exit", async () => {
	const manager = createManager();
	let running = true;
	const runtime = createRuntime({ id: "agent-live", running: true });
	runtime.process.isRunning = () => running;
	manager.agents.set("agent-live", runtime);

	setTimeout(() => {
		running = false;
	}, 40);

	assert.equal(await manager.stopAndWaitForExit("agent-live", 1000), true);
});

test("stopAndWaitForExit gives up after the timeout without leaving the runtime behind", async () => {
	const manager = createManager();
	manager.agents.set("agent-stuck", createRuntime({ id: "agent-stuck", running: true }));

	const startedAt = Date.now();
	assert.equal(await manager.stopAndWaitForExit("agent-stuck", 80), false);
	assert.equal(Date.now() - startedAt >= 60, true);
	// 超时只是不再等，runtime 仍要按 stop 语义移除（否则又会挡住后续删除，issue #360）。
	assert.equal(manager.agents.has("agent-stuck"), false);
});

test("stopAndWaitForExit treats an unknown agent as already exited", async () => {
	const manager = createManager();

	assert.equal(await manager.stopAndWaitForExit("missing", 10), true);
});
