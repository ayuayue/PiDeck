import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";

/**
 * 加载生产模块：统一走 createTsSandbox（相对 import 自动按源文件目录解析）。
 * imports 的键是源码里写的 specifier，与 createTsSandbox 的 stubs 同语义。
 */
/**
 * 加载生产模块：统一走 createTsSandbox（相对 import 自动按源文件目录解析）。
 * imports 的键是源码里写的 specifier，与 createTsSandbox 的 stubs 同语义。
 */
function compileModule(filePath, imports = {}) {
	return createTsSandbox({ stubs: imports })(filePath);
}
function loadCoordinator() {
	const identity = compileModule("src/shared/sessionIdentity.ts");
	return compileModule("src/main/sessions/SessionRuntimeCoordinator.ts", {
		"../../shared/sessionIdentity": identity,
		// rewind 校验纯函数在 Coordinator 里运行时 import（isRewindCheckpointId/isRewindRestoreScope）；
		// 本测试不触发 rewind 方法，空桩满足加载契约。
		"../../shared/types": {},
	});
}

function deferred() {
	let resolve;
	const promise = new Promise((resolvePromise) => {
		resolve = resolvePromise;
	});
	return { promise, resolve };
}

function makeHarness() {
	const records = new Set(["old-session", "clone-session", "fork-session", "switch-session"]);
	const tabs = [
		{
			id: "agent-1",
			projectId: "project-1",
			title: "Origin",
			status: "idle",
			sessionPath: "C:/sessions/old.jsonl",
			sessionSource: "pi",
			sessionEnvironment: "native",
			createdAt: 1,
		},
	];
	const catalog = {
		get: (sessionId) => (records.has(sessionId) ? { id: sessionId } : undefined),
		getLocator: () => undefined,
		attachRuntime: async () => undefined,
	};
	const agents = {
		list: () => tabs,
		publishRuntimeState: async () => undefined,
	};
	return { catalog, agents, records, tabs };
}

for (const operation of ["clone", "fork", "switch"]) {
	test(`${operation} success detaches old Session, blocks bridge, and binds one target`, async () => {
		const { SessionRuntimeCoordinator } = loadCoordinator();
		const harness = makeHarness();
		const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
		assert.equal(coordinator.bindExistingAgent("old-session", "agent-1"), 1);
		const order = [];
		const targetSessionId = `${operation}-session`;
		const result = await coordinator.replaceBoundRuntime({
			agentId: "agent-1",
			replace: async () => {
				order.push("operation");
				assert.equal(coordinator.getSessionId("agent-1"), undefined);
				assert.equal(coordinator.getRuntimeBinding("agent-1"), undefined);
				return { text: operation };
			},
			resolveTargetSessionId: async () => targetSessionId,
			canRestoreOrigin: () => false,
			onDetached: (binding) => {
				order.push("detach");
				assert.equal(binding.sessionId, "old-session");
			},
			onAttached: (binding) => {
				order.push("attach");
				assert.equal(binding.sessionId, targetSessionId);
			},
			onRestored: () => order.push("restore"),
		});
		assert.equal(result.targetSessionId, targetSessionId);
		assert.deepEqual(order, ["detach", "operation", "attach"]);
		assert.equal(coordinator.getSessionId("agent-1"), targetSessionId);
		assert.equal(coordinator.getAgentId("old-session"), undefined);
		assert.equal(coordinator.getAgentId(targetSessionId), "agent-1");
	});
}

test("replacement failure restores the old binding when identity is unchanged", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
	assert.equal(coordinator.bindExistingAgent("old-session", "agent-1"), 1);
	const order = [];
	await assert.rejects(
		coordinator.replaceBoundRuntime({
			agentId: "agent-1",
			replace: async () => {
				order.push("operation");
				throw new Error("replacement failed");
			},
			resolveTargetSessionId: async () => "switch-session",
			canRestoreOrigin: () => true,
			onDetached: () => order.push("detach"),
			onAttached: () => order.push("attach"),
			onRestored: (binding) => {
				order.push("restore");
				assert.equal(binding.sessionId, "old-session");
				assert.equal(binding.runtimeGeneration, 3);
			},
		}),
		/replacement failed/,
	);
	assert.deepEqual(order, ["detach", "operation", "restore"]);
	assert.equal(coordinator.getSessionId("agent-1"), "old-session");
	assert.equal(coordinator.getRuntimeBinding("agent-1").runtimeGeneration, 3);
});

test("replacement failure after identity changes fails closed without restoring origin", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
	coordinator.bindExistingAgent("old-session", "agent-1");
	let restored = 0;
	await assert.rejects(
		coordinator.replaceBoundRuntime({
			agentId: "agent-1",
			replace: async () => {
				harness.tabs[0].sessionPath = "C:/sessions/changed.jsonl";
				throw new Error("replacement failed after switch");
			},
			resolveTargetSessionId: async () => "switch-session",
			canRestoreOrigin: () => false,
			onDetached: () => undefined,
			onAttached: () => assert.fail("failed replacement must not attach"),
			onRestored: () => {
				restored += 1;
			},
		}),
		/replacement failed after switch/,
	);
	assert.equal(restored, 0);
	assert.equal(coordinator.getSessionId("agent-1"), undefined);
	assert.equal(coordinator.getAgentId("old-session"), undefined);
});

test("target resolver failure after tab path changes fails closed without restoring origin", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
	coordinator.bindExistingAgent("old-session", "agent-1");
	let restored = 0;
	await assert.rejects(
		coordinator.replaceBoundRuntime({
			agentId: "agent-1",
			replace: async () => {
				harness.tabs[0].sessionPath = "C:/sessions/switched.jsonl";
				return { text: "switched" };
			},
			resolveTargetSessionId: async () => {
				throw new Error("target catalog failed");
			},
			canRestoreOrigin: () => false,
			onDetached: () => undefined,
			onAttached: () => assert.fail("failed target resolver must not attach"),
			onRestored: () => {
				restored += 1;
			},
		}),
		/target catalog failed/,
	);
	assert.equal(restored, 0);
	assert.equal(coordinator.getSessionId("agent-1"), undefined);
	assert.equal(coordinator.getAgentId("old-session"), undefined);
});

test("attached snapshot failure keeps the committed target binding and never restores origin", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
	coordinator.bindExistingAgent("old-session", "agent-1");
	let restored = 0;
	await assert.rejects(
		coordinator.replaceBoundRuntime({
			agentId: "agent-1",
			replace: async () => ({ text: "clone" }),
			resolveTargetSessionId: async () => "clone-session",
			canRestoreOrigin: () => true,
			onDetached: () => undefined,
			onAttached: () => {
				throw new Error("snapshot emit failed");
			},
			onRestored: () => {
				restored += 1;
			},
		}),
		/snapshot emit failed/,
	);
	assert.equal(restored, 0);
	assert.equal(coordinator.getSessionId("agent-1"), "clone-session");
	assert.equal(coordinator.getAgentId("clone-session"), "agent-1");
	assert.equal(coordinator.getAgentId("old-session"), undefined);
});

test("target active binding conflict fails closed without orphaning the existing target agent", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	harness.tabs.push({
		id: "agent-2",
		projectId: "project-1",
		title: "Clone",
		status: "idle",
		sessionPath: "C:/sessions/clone.jsonl",
		sessionSource: "pi",
		sessionEnvironment: "native",
		createdAt: 2,
	});
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
	coordinator.bindExistingAgent("old-session", "agent-1");
	coordinator.bindExistingAgent("clone-session", "agent-2");
	await assert.rejects(
		coordinator.replaceBoundRuntime({
			agentId: "agent-1",
			replace: async () => ({ text: "clone" }),
			resolveTargetSessionId: async () => "clone-session",
			canRestoreOrigin: () => false,
			onDetached: () => undefined,
			onAttached: () => assert.fail("target conflict must not attach"),
			onRestored: () => assert.fail("changed identity must fail closed"),
		}),
		/target already bound/,
	);
	assert.equal(coordinator.getSessionId("agent-1"), undefined);
	assert.equal(coordinator.getSessionId("agent-2"), "clone-session");
	assert.equal(coordinator.getAgentId("clone-session"), "agent-2");
	assert.equal(coordinator.getAgentId("old-session"), undefined);
});

test("target origin reservation conflict fails closed and preserves the existing replacement", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	harness.tabs.push({
		id: "agent-2",
		projectId: "project-1",
		title: "Clone",
		status: "idle",
		sessionPath: "C:/sessions/clone.jsonl",
		sessionSource: "pi",
		sessionEnvironment: "native",
		createdAt: 2,
	});
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
	coordinator.bindExistingAgent("old-session", "agent-1");
	coordinator.bindExistingAgent("clone-session", "agent-2");
	let releaseSecond;
	const secondReplacement = coordinator.replaceBoundRuntime({
		agentId: "agent-2",
		replace: async () =>
			new Promise((resolve) => {
				releaseSecond = () => resolve({ cancelled: true });
			}),
		resolveTargetSessionId: async () => "fork-session",
		canRestoreOrigin: () => assert.fail("cancelled replacement restores without identity callback"),
		onDetached: () => undefined,
		onAttached: () => assert.fail("held replacement must be cancelled"),
		onRestored: () => undefined,
	});
	await Promise.resolve();

	await assert.rejects(
		coordinator.replaceBoundRuntime({
			agentId: "agent-1",
			replace: async () => ({ text: "clone" }),
			resolveTargetSessionId: async () => "clone-session",
			canRestoreOrigin: () => false,
			onDetached: () => undefined,
			onAttached: () => assert.fail("reserved target must not attach"),
			onRestored: () => assert.fail("changed identity must fail closed"),
		}),
		/reservation conflict/,
	);
	assert.equal(coordinator.getSessionId("agent-1"), undefined);
	assert.equal(coordinator.getSessionId("agent-2"), undefined);
	assert.equal(coordinator.getAgentId("clone-session"), undefined);
	releaseSecond();
	await secondReplacement;
	assert.equal(coordinator.getSessionId("agent-2"), "clone-session");
});

test("concurrent replacements competing for the same target allow only one binding", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	harness.tabs.push({ id: "agent-2", status: "idle", createdAt: 2 });
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
	coordinator.bindExistingAgent("old-session", "agent-1");
	coordinator.bindExistingAgent("fork-session", "agent-2");

	const results = await Promise.allSettled([
		coordinator.replaceBoundRuntime({
			agentId: "agent-1",
			replace: async () => ({ text: "first" }),
			resolveTargetSessionId: async () => "switch-session",
			canRestoreOrigin: () => false,
			onDetached: () => undefined,
			onAttached: () => undefined,
			onRestored: () => assert.fail("changed identity must fail closed"),
		}),
		coordinator.replaceBoundRuntime({
			agentId: "agent-2",
			replace: async () => ({ text: "second" }),
			resolveTargetSessionId: async () => "switch-session",
			canRestoreOrigin: () => false,
			onDetached: () => undefined,
			onAttached: () => undefined,
			onRestored: () => assert.fail("changed identity must fail closed"),
		}),
	]);
	assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
	assert.equal(results.filter((result) => result.status === "rejected").length, 1);
	const winner = coordinator.getAgentId("switch-session");
	assert.ok(winner === "agent-1" || winner === "agent-2");
	const loser = winner === "agent-1" ? "agent-2" : "agent-1";
	assert.equal(coordinator.getSessionId(winner), "switch-session");
	assert.equal(coordinator.getSessionId(loser), undefined);
	assert.equal(coordinator.getAgentId("old-session"), undefined);
	assert.equal(coordinator.getAgentId("fork-session"), undefined);
});

test("scan and bindExisting cannot cross an active replacement reservation", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	harness.tabs.push({
		id: "agent-2",
		projectId: "project-1",
		title: "Origin Duplicate",
		status: "idle",
		sessionPath: "c:/sessions/old.jsonl",
		sessionSource: "pi",
		sessionEnvironment: "native",
		createdAt: 2,
	});
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
	coordinator.bindExistingAgent("old-session", "agent-1");
	let release;
	const replacement = coordinator.replaceBoundRuntime({
		agentId: "agent-1",
		replace: async () =>
			new Promise((resolve) => {
				release = () => resolve({ cancelled: true });
			}),
		resolveTargetSessionId: async () => "switch-session",
		canRestoreOrigin: () => assert.fail("cancelled replacement restores without identity callback"),
		onDetached: () => undefined,
		onAttached: () => assert.fail("held replacement must be cancelled"),
		onRestored: () => undefined,
	});
	await Promise.resolve();

	assert.throws(() => coordinator.bindExistingAgent("old-session", "agent-2"), /reservation conflict/);
	assert.throws(() => coordinator.bindExistingAgent("clone-session", "agent-1"), /already in progress/);
	const bindings = coordinator.attachCatalogRuntimes([
		{
			id: "old-session",
			projectId: "project-1",
			title: "Origin",
			source: "pi",
			environment: "native",
			filePath: "C:/sessions/old.jsonl",
			status: "active",
			createdAt: 1,
			updatedAt: 1,
			preview: "",
			messageCount: 0,
		},
	]);
	assert.equal(bindings.length, 0);
	assert.equal(coordinator.getSessionId("agent-2"), undefined);

	release();
	await replacement;
	assert.equal(coordinator.getSessionId("agent-1"), "old-session");
});

test("replacement cannot cross an active prompt dispatch lease", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	const started = deferred();
	const release = deferred();
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => {
		started.resolve();
		await release.promise;
		return { accepted: true };
	});
	coordinator.bindExistingAgent("old-session", "agent-1");

	const sending = coordinator.send({
		sessionId: "old-session",
		requestId: "request-1",
		message: "hold dispatch",
	});
	await started.promise;
	await assert.rejects(
		coordinator.replaceBoundRuntime({
			agentId: "agent-1",
			replace: async () => ({ text: "must not run" }),
			resolveTargetSessionId: async () => "clone-session",
			canRestoreOrigin: () => false,
			onDetached: () => assert.fail("must remain attached while dispatch is active"),
			onAttached: () => assert.fail("must not attach while dispatch is active"),
			onRestored: () => assert.fail("must not restore while dispatch is active"),
		}),
		/prompt dispatch is in progress/,
	);
	assert.equal(coordinator.getSessionId("agent-1"), "old-session");

	release.resolve();
	assert.equal((await sending).accepted, true);
	const result = await coordinator.replaceBoundRuntime({
		agentId: "agent-1",
		replace: async () => ({ text: "after dispatch" }),
		resolveTargetSessionId: async () => "clone-session",
		canRestoreOrigin: () => false,
		onDetached: () => undefined,
		onAttached: () => undefined,
		onRestored: () => assert.fail("successful replacement must not restore"),
	});
	assert.equal(result.targetSessionId, "clone-session");
});

test("cancelled replacement restores the old binding and preserves cancellation fields", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
	coordinator.bindExistingAgent("old-session", "agent-1");
	let restored = 0;
	const result = await coordinator.replaceBoundRuntime({
		agentId: "agent-1",
		replace: async () => ({ cancelled: true, text: "kept" }),
		resolveTargetSessionId: async () => "clone-session",
		canRestoreOrigin: () => assert.fail("cancelled replacement restores without identity callback"),
		onDetached: () => undefined,
		onAttached: () => assert.fail("cancelled replacement must not attach target"),
		onRestored: () => {
			restored += 1;
		},
	});
	assert.deepEqual(result, { cancelled: true, text: "kept" });
	assert.equal(restored, 1);
	assert.equal(coordinator.getSessionId("agent-1"), "old-session");
});

test("unbound external runtime keeps the legacy result and does not create a Session", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = makeHarness();
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, async () => ({ accepted: true }));
	const result = await coordinator.replaceBoundRuntime({
		agentId: "external-agent",
		replace: async () => ({ cancelled: false, text: "legacy" }),
		resolveTargetSessionId: async () => assert.fail("external runtime must not resolve a Session"),
		canRestoreOrigin: () => assert.fail("external runtime must not check origin identity"),
		onDetached: () => assert.fail("external runtime must not detach"),
		onAttached: () => assert.fail("external runtime must not attach"),
		onRestored: () => assert.fail("external runtime must not restore"),
	});
	assert.deepEqual(result, { cancelled: false, text: "legacy" });
});
