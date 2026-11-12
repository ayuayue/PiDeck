import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 远端会话在协调器层的路由与匹配（Phase 4 P4.2 收口第 1、2 项）。
 *
 * 这组用例只盯协调器自己的判断（进程怎么起来属 AgentManager/端口，由
 * `sessionRuntimeRemoteJoin.test.mjs` 走真 join 流程锁）：
 *
 * 1. **匹配按 ssh 身份**（hostId + remotePath）：同一远端路径在两台主机上是两个会话，
 *    不得互相命中（`findAgentByRemoteSession` 必须带 hostId）；
 * 2. **新建会话的远端路由**：草稿自己没有 locator，位置由项目 locator 决定 —— 回写 catalog 时
 *    也是「ssh 身份」，**绝不**把远端路径写进本机 `filePath`；
 * 3. 被转换的旧拦路码：远端 runtime 是可寻址、可停、可出现在 runtime 列表里的真 runtime。
 */

function compileModule(filePath, imports = {}) {
	return createTsSandbox({ stubs: imports })(filePath);
}

function loadCoordinator() {
	const identity = compileModule("src/shared/sessionIdentity.ts");
	return compileModule("src/main/sessions/SessionRuntimeCoordinator.ts", {
		"../../shared/sessionIdentity": identity,
		"../../shared/types": {},
	});
}

const HOST_A = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const HOST_B = "9c1d5f7a-2b3e-4c5d-8e9f-0a1b2c3d4e5f";
const REMOTE_CWD = "/srv/remote-app";
/** 两台主机上**同一个**远端会话文件路径：身份差异只可能来自 hostId。 */
const SHARED_REMOTE_PATH = "/home/dev/.pi/agent/sessions/-srv-remote-app/shared.jsonl";

/** 项目位置表：会话链路里「这条会话的 runtime 在哪台机器上」的唯一判据。 */
const PROJECT_LOCATORS = {
	"project-a": { kind: "ssh", hostId: HOST_A, remotePath: REMOTE_CWD },
	"project-b": { kind: "ssh", hostId: HOST_B, remotePath: REMOTE_CWD },
	"project-local": { kind: "local", environment: "native", localPath: "C:/projects/local-app" },
};

function createHarness(SessionRuntimeCoordinator, { entries = [], tabs = [] } = {}) {
	const state = { entries: [...entries], tabs: [...tabs] };
	const calls = { create: 0, createInputs: [], attach: 0, attachInputs: [], stop: 0, abort: 0, rename: 0, update: 0 };
	const catalog = {
		get: (sessionId) => {
			const entry = state.entries.find((candidate) => candidate.id === sessionId);
			return entry ? { ...entry } : undefined;
		},
		getRecord: (sessionId) => {
			const entry = state.entries.find((candidate) => candidate.id === sessionId);
			return entry ? { ...entry, preview: "", messageCount: 0 } : undefined;
		},
		getLocator: (sessionId) => {
			const entry = state.entries.find((candidate) => candidate.id === sessionId);
			return entry?.locator;
		},
		getLocalFilePath: (sessionId) => {
			const entry = state.entries.find((candidate) => candidate.id === sessionId);
			if (entry?.locator?.kind === "ssh") throw new Error("UNSUPPORTED_PROJECT_LOCATION");
			return entry?.locator?.kind === "local" ? entry.locator.filePath : undefined;
		},
		update: async (sessionId, patch) => {
			calls.update += 1;
			const entry = state.entries.find((candidate) => candidate.id === sessionId);
			Object.assign(entry, patch);
			return { ...entry };
		},
		attachRuntime: async (input) => {
			calls.attach += 1;
			calls.attachInputs.push(input);
			const entry = state.entries.find((candidate) => candidate.id === input.sessionId);
			if (input.remoteLocator) {
				entry.locator = { ...input.remoteLocator };
				entry.status = "active";
				return { ...entry };
			}
			entry.filePath = input.filePath;
			entry.locator = input.filePath ? { kind: "local", environment: entry.environment, filePath: input.filePath } : undefined;
			entry.status = input.filePath ? "active" : entry.status;
			return { ...entry };
		},
	};
	const agents = {
		backend: "pi",
		list: () => state.tabs,
		getMessages: () => [],
		create: async (input) => {
			calls.create += 1;
			calls.createInputs.push(input);
			const tab = {
				id: `agent-${calls.create}`,
				projectId: input.projectId,
				cwd: input.projectId === "project-local" ? "C:/projects/local-app" : REMOTE_CWD,
				title: input.title ?? "Session",
				status: "idle",
				sessionId: `pi-${calls.create}`,
				// 远端 runtime 上报的是**远端**会话文件；本机 runtime 上报本机路径。
				sessionPath: input.sessionPath ?? (input.projectId === "project-local" ? `C:/sessions/${calls.create}.jsonl` : SHARED_REMOTE_PATH),
				sessionEnvironment: "native",
				sessionSource: "pi",
				createdAt: calls.create,
			};
			state.tabs.push(tab);
			return tab;
		},
		stop: async (agentId) => {
			calls.stop += 1;
			const index = state.tabs.findIndex((tab) => tab.id === agentId);
			if (index >= 0) state.tabs.splice(index, 1);
		},
		abort: async () => {
			calls.abort += 1;
		},
		rename: async (agentId, name) => {
			calls.rename += 1;
			const tab = state.tabs.find((candidate) => candidate.id === agentId);
			tab.title = name;
			return tab;
		},
		publishRuntimeState: async () => undefined,
		getRuntimeState: async () => ({ isStreaming: false }),
		setModel: async () => undefined,
		setThinking: async () => undefined,
		getAvailableModels: async () => [],
		notifyAskPending: () => undefined,
		sendUIResponse: async () => undefined,
		onOutput: () => () => undefined,
	};
	const coordinator = new SessionRuntimeCoordinator(
		catalog,
		agents,
		async (input) => ({ accepted: true, requestId: input.requestId }),
		undefined,
		(projectId) => PROJECT_LOCATORS[projectId],
	);
	return { coordinator, catalog, agents, calls, state };
}

const sshEntry = (id, projectId, hostId, remotePath = SHARED_REMOTE_PATH) => ({
	id,
	projectId,
	title: `远端会话 ${id}`,
	source: "pi",
	environment: "native",
	status: "active",
	locator: { kind: "ssh", hostId, remotePath, remoteSessionId: "-srv-remote-app/shared.jsonl" },
	createdAt: 1,
	updatedAt: 1,
});

test("两个同路径不同 hostId 的远端记录不得互相命中（匹配带 hostId）", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createHarness(SessionRuntimeCoordinator, {
		entries: [sshEntry("session-a", "project-a", HOST_A), sshEntry("session-b", "project-b", HOST_B)],
		// 主机 A 上已经有这条会话的 runtime（同一远端路径、同一 hostId）。
		tabs: [{ id: "agent-a", projectId: "project-a", cwd: REMOTE_CWD, title: "A", status: "idle", sessionId: "pi-a", sessionPath: SHARED_REMOTE_PATH, sessionEnvironment: "native", sessionSource: "pi", createdAt: 1 }],
	});
	const { coordinator, calls, state } = harness;

	// A：命中既有 runtime，不新建进程。
	const activatedA = await coordinator.activateRuntime("session-a");
	assert.equal(activatedA.ok, true, activatedA.ok ? "" : activatedA.error.debugDetails);
	assert.equal(activatedA.value.agentId, "agent-a");
	assert.equal(calls.create, 0, "同一主机同一远端会话必须复用既有 runtime");

	// B：同路径但另一台主机 ⇒ 另一个会话，必须起自己的 runtime。
	const activatedB = await coordinator.activateRuntime("session-b");
	assert.equal(activatedB.ok, true, activatedB.ok ? "" : activatedB.error.debugDetails);
	assert.notEqual(activatedB.value.agentId, "agent-a", "同路径不同 hostId 不得互相顶掉");
	assert.equal(calls.create, 1);
	assert.equal(calls.createInputs[0].sessionPath, SHARED_REMOTE_PATH);
	assert.equal(calls.createInputs[0].projectId, "project-b");
	// 两条绑定各自独立存活。
	assert.equal(coordinator.getTarget("session-a").agentId, "agent-a");
	assert.equal(coordinator.getTarget("session-b").agentId, activatedB.value.agentId);
	assert.equal(state.tabs.length, 2);
});

test("远端项目的草稿（无 locator）：回写的是 ssh 身份，本机 filePath 一个字节都不写", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createHarness(SessionRuntimeCoordinator, {
		entries: [
			{
				id: "draft-a",
				projectId: "project-a",
				title: "新会话",
				source: "pi",
				environment: "native",
				status: "draft",
				createdAt: 1,
				updatedAt: 1,
			},
		],
	});
	const { coordinator, catalog, calls } = harness;

	const result = await coordinator.activateRuntime("draft-a");

	assert.equal(result.ok, true, result.ok ? "" : result.error.debugDetails);
	// 新建会话没有远端会话文件可带：sessionPath 交给远端 pi 自己挑（不得凭空造一条本机可读的会话文件）。
	const createInput = calls.createInputs.at(-1);
	assert.equal(createInput.sessionPath, undefined);
	assert.equal(createInput.sessionLocator, undefined);
	// 回写按 locator 路由：只给 ssh 身份（hostId 来自项目位置，路径来自运行时上报）。
	assert.equal(calls.attach, 1);
	const attachInput = calls.attachInputs.at(-1);
	assert.equal(attachInput.filePath, undefined);
	assert.deepEqual({ ...attachInput.remoteLocator }, { kind: "ssh", hostId: HOST_A, remotePath: SHARED_REMOTE_PATH });
	assert.equal(catalog.get("draft-a").filePath, undefined);
	assert.equal(catalog.get("draft-a").locator.hostId, HOST_A);
});

test("本地项目草稿走原路径：本机 filePath 由运行时上报（远端路由不得渗进本地）", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createHarness(SessionRuntimeCoordinator, {
		entries: [{ id: "draft-local", projectId: "project-local", title: "本地会话", source: "pi", environment: "native", status: "draft", createdAt: 1, updatedAt: 1 }],
	});
	const { coordinator, catalog, calls } = harness;

	const result = await coordinator.activateRuntime("draft-local");

	assert.equal(result.ok, true, result.ok ? "" : result.error.debugDetails);
	assert.equal(calls.attachInputs.at(-1).remoteLocator, undefined);
	assert.equal(calls.attachInputs.at(-1).filePath, "C:/sessions/1.jsonl");
	assert.equal(catalog.get("draft-local").filePath, "C:/sessions/1.jsonl");
});

test("远端 runtime 是可寻址、可停、可出现在列表里的真 runtime（旧 ssh 拦路码已转换）", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createHarness(SessionRuntimeCoordinator, {
		entries: [sshEntry("session-a", "project-a", HOST_A)],
		tabs: [{ id: "agent-a", projectId: "project-a", cwd: REMOTE_CWD, title: "A", status: "idle", sessionId: "pi-a", sessionPath: SHARED_REMOTE_PATH, sessionEnvironment: "native", sessionSource: "pi", createdAt: 1 }],
	});
	const { coordinator, calls, state } = harness;

	const activated = await coordinator.activateRuntime("session-a");
	assert.equal(activated.ok, true, activated.ok ? "" : activated.error.debugDetails);

	// getTarget 不再对 ssh 返回 undefined（它就是运行实例的地址）。
	const target = coordinator.getTarget("session-a");
	assert.deepEqual({ ...target }, { sessionId: "session-a", agentId: "agent-a", runtimeGeneration: activated.value.runtimeGeneration });
	// runtime 列表包含远端 runtime（侧栏的运行标记靠它）。
	assert.equal(
		coordinator.listRuntimes().some((runtime) => runtime.sessionId === "session-a"),
		true,
	);
	// 目标命令走同一条 RPC 链路：改名与中断都必须可用。
	const renamed = await coordinator.renameRuntime(target, "新标题");
	assert.equal(renamed.ok, true, renamed.ok ? "" : renamed.error.debugDetails);
	assert.equal(calls.rename, 1);
	const aborted = await coordinator.abortRuntime(target);
	assert.equal(aborted.ok, true, aborted.ok ? "" : aborted.error.debugDetails);
	assert.equal(calls.abort, 1);

	// 停止打到那个远端运行实例上（它是个真进程）。
	const stopped = await coordinator.stopRuntime(target);
	assert.equal(stopped.ok, true, stopped.ok ? "" : stopped.error.debugDetails);
	assert.equal(calls.stop, 1);
	assert.equal(state.tabs.length, 0);
	assert.equal(coordinator.getTarget("session-a"), undefined);
});

test("启动失败时必须先读错误卡再 stop：稳定码与 debugDetails 不得被 messages.delete 吞掉", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createHarness(SessionRuntimeCoordinator, {
		entries: [{ id: "draft-a", projectId: "project-a", title: "新会话", source: "pi", environment: "native", status: "draft", createdAt: 1, updatedAt: 1 }],
	});
	const { coordinator, agents, calls, state } = harness;

	// 现场形状：create 返回 error 终态，并且有一条带 debugDetails 的 error 卡；stop() 会删掉它。
	const messages = new Map();
	const debugDetails = "⚠️ Pi RPC 启动失败\n\nREMOTE_SESSION_LOCATOR_UNRESOLVED\n\nplatform=linux";
	agents.create = async (input) => {
		const tab = {
			id: "agent-failed",
			projectId: input.projectId,
			cwd: REMOTE_CWD,
			title: "新会话",
			status: "error",
			sessionId: "pi-failed",
			sessionPath: ".pi/sessions/failed.jsonl",
			sessionEnvironment: "native",
			sessionSource: "pi",
			createdAt: 1,
		};
		state.tabs.push(tab);
		messages.set(tab.id, [{ role: "error", text: "远端会话登记失败", meta: { debugDetails } }]);
		return tab;
	};
	agents.getMessages = (agentId) => messages.get(agentId) ?? [];
	agents.stop = async (agentId) => {
		calls.stop += 1;
		messages.delete(agentId);
		const index = state.tabs.findIndex((tab) => tab.id === agentId);
		if (index >= 0) state.tabs.splice(index, 1);
	};

	const result = await coordinator.activateRuntime("draft-a");

	assert.equal(result.ok, false, "error 终态的 runtime 必须让本次激活失败");
	// 关键断言：用户看到的必须是真实原因，而不是「Failed to start session runtime (error)」。
	assert.match(result.error.debugDetails, /REMOTE_SESSION_LOCATOR_UNRESOLVED/);
	assert.doesNotMatch(result.error.debugDetails, /Failed to start session runtime \(error\)/);
	// 失败清理照旧：进程被停掉，不留影子 runtime。
	assert.equal(calls.stop, 1);
	assert.equal(state.tabs.length, 0);
});
