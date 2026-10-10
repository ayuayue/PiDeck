import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { deferred } from "./helpers/sessionRunControlHarness.mjs";

const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts");
const { COMPACT_WAIT_TIMEOUT, COMPACT_ROUTED_TO_OWNER } = loadTsCommonJs("src/shared/compactFeedback.ts");
const AGENT_ID = "agent-compact";

/** 控制真实 compact 的外部等待点，不启动 pi、不读取真实会话文件。 */
function harness({ ownership, request } = {}) {
	const requests = [];
	const states = [];
	const stateEmissions = [];
	const reloads = [];
	const overflowStates = [];
	const notices = [];
	const manager = new AgentManager(
		() => ({ id: "project-a", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({ rpcTimeout: 600_000 }) },
		{},
	);
	let running = true;
	const process = {
		isRunning: () => running,
		stop: () => {
			running = false;
		},
		client: {
			request: async (input) => {
				if (input.type === "get_state" || input.type === "get_session_stats") return { success: true, data: {} };
				requests.push(input);
				return request ? request(input) : { success: true };
			},
		},
	};
	const runtime = {
		tab: { id: AGENT_ID, projectId: "project-a", cwd: "C:/project", title: "Source", status: "idle", sessionPath: "C:/project/session.jsonl", createdAt: 1 },
		process,
	};
	manager.agents.set(AGENT_ID, runtime);
	manager.resolveSessionCompactionOwnership = ownership ?? (async () => undefined);
	manager.getSessionCacheHitStats = async () => ({ sampleCount: 0 });
	manager.emitRuntimeState = () => {
		// 与真实 emitter 一致：运行时退役后的状态查询失败静默丢弃，不产生悬空 rejection。
		const emission = manager
			.getRuntimeState(AGENT_ID)
			.then((state) => states.push(state))
			.catch(() => {});
		stateEmissions.push(emission);
		return emission;
	};
	manager.emitContextOverflowState = (_agentId, value) => overflowStates.push(value);
	manager.loadMessages = async () => reloads.push(AGENT_ID);
	manager.reloadMessagesAfterCompaction = () => {};
	manager.markIdleIfPiReportsNoWork = async () => {};
	manager.addLocalizedMessage = (_agentId, _role, key) => notices.push(key);
	manager.captureRuntimeMessageIdentities = () => {};
	manager.emitState = () => {};
	const flushStates = () => Promise.all(stateEmissions);
	return { manager, runtime, process, requests, states, reloads, overflowStates, notices, flushStates };
}

/** 立即消费拒绝结果，测试可以安全地在中途关闭 runtime。 */
function outcome(promise) {
	return promise.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
}

test("manual compact reserves the runtime before awaiting ownership and rejects a second click", async () => {
	const probe = deferred();
	let probes = 0;
	const h = harness({
		ownership: () => {
			probes++;
			return probe.promise;
		},
	});
	const first = outcome(h.manager.compact(AGENT_ID));
	const second = outcome(h.manager.compact(AGENT_ID));
	const reserved = (await h.manager.getRuntimeState(AGENT_ID)).isCompacting;
	probe.resolve(undefined);
	const [firstResult, secondResult] = await Promise.all([first, second]);
	assert.equal(reserved, true, "the ownership probe is part of the compact operation");
	assert.equal(probes, 1);
	assert.equal(firstResult.error, undefined);
	assert.match(secondResult.error?.message ?? "", /already compacting/);
	assert.equal(h.requests.filter((input) => input.type === "compact").length, 1);
});

test("manual compact publishes a non-compacting state after an RPC failure", async () => {
	const h = harness({ request: async () => ({ success: false, error: "nothing to compact" }) });
	await assert.rejects(h.manager.compact(AGENT_ID), /nothing to compact/);
	await h.flushStates();
	assert.equal(h.manager.compactingAgents.has(AGENT_ID), false);
	assert.equal(h.states.at(-1)?.isCompacting, false, "failure has to settle the meter without waiting for a pi event");
	assert.equal(h.reloads.length, 0);
});

test("ownership probe failure releases the manual compact reservation", async () => {
	const h = harness({
		ownership: async () => {
			throw new Error("probe failed");
		},
	});
	await assert.rejects(h.manager.compact(AGENT_ID), /probe failed/);
	await h.flushStates();
	assert.equal(h.manager.compactingAgents.has(AGENT_ID), false);
	assert.equal(h.states.at(-1)?.isCompacting, false);
	assert.equal(h.requests.length, 0);
});

test("closing the runtime during ownership discovery does not dispatch a late compact command", async () => {
	const probe = deferred();
	const h = harness({ ownership: () => probe.promise });
	const pending = outcome(h.manager.compact(AGENT_ID));
	await h.manager.stop(AGENT_ID);
	probe.resolve(undefined);
	const result = await pending;
	assert.ok(result.error, "a retired runtime cannot report success");
	assert.equal(h.requests.length, 0);
	assert.equal(h.manager.compactingAgents.has(AGENT_ID), false);
	assert.equal(h.reloads.length, 0);
});

test("replacing the pi process during ownership discovery does not dispatch to the replacement", async () => {
	const probe = deferred();
	const h = harness({ ownership: () => probe.promise });
	const pending = outcome(h.manager.compact(AGENT_ID));
	h.runtime.process = {
		isRunning: () => true,
		client: {
			request: async (input) => {
				if (input.type !== "get_state" && input.type !== "get_session_stats") h.requests.push(input);
				return { success: true, data: {} };
			},
		},
	};
	probe.resolve(undefined);
	const result = await pending;
	assert.ok(result.error);
	assert.equal(h.requests.length, 0, "ownership evidence belongs to the process which started the request");
	assert.equal(h.reloads.length, 0);
});

test("a late successful compact response cannot clear overflow or reload a replacement runtime", async () => {
	const reply = deferred();
	const entered = deferred();
	const h = harness({
		request: () => {
			entered.resolve();
			return reply.promise;
		},
	});
	const pending = outcome(h.manager.compact(AGENT_ID));
	await entered.promise;
	h.manager.agents.set(AGENT_ID, { ...h.runtime, process: { isRunning: () => true } });
	h.manager.contextOverflowByAgent.set(AGENT_ID, true);
	reply.resolve({ success: true });
	const result = await pending;
	assert.ok(result.error);
	assert.equal(h.manager.contextOverflowByAgent.get(AGENT_ID), true);
	assert.equal(h.overflowStates.length, 0);
	assert.equal(h.reloads.length, 0);
});

test("a compaction_end event does not release the request guard before its RPC reply", async () => {
	const reply = deferred();
	const entered = deferred();
	const h = harness({
		request: () => {
			entered.resolve();
			return reply.promise;
		},
	});
	const pending = outcome(h.manager.compact(AGENT_ID));
	await entered.promise;
	h.manager.handlePiEvent(AGENT_ID, { type: "compaction_end", result: true });
	const second = await outcome(h.manager.compact(AGENT_ID));
	assert.match(second.error?.message ?? "", /already compacting/);
	assert.equal((await h.manager.getRuntimeState(AGENT_ID)).isCompacting, true);
	reply.resolve({ success: true });
	const result = await pending;
	assert.equal(result.error, undefined);
	assert.equal(result.value.isCompacting, false);
	assert.equal(h.requests.length, 1);
});

test("a late RPC failure after close cannot restart the retired pi process", async () => {
	const reply = deferred();
	const entered = deferred();
	const h = harness({
		request: () => {
			entered.resolve();
			return reply.promise;
		},
	});
	let reconnects = 0;
	h.manager.reattachProcess = async () => reconnects++;
	const pending = outcome(h.manager.compact(AGENT_ID));
	await entered.promise;
	await h.manager.stop(AGENT_ID);
	reply.reject(new Error("pi exited"));
	const result = await pending;
	assert.match(result.error?.message ?? "", /runtime changed/);
	assert.equal(reconnects, 0);
	assert.equal(h.reloads.length, 0);
	assert.equal(h.notices.length, 0);
});

test("an old request cannot release a replacement process's pending compact", async () => {
	const oldReply = deferred();
	const oldEntered = deferred();
	const newReply = deferred();
	const newEntered = deferred();
	const h = harness({
		request: () => {
			oldEntered.resolve();
			return oldReply.promise;
		},
	});
	const oldRequest = outcome(h.manager.compact(AGENT_ID));
	await oldEntered.promise;
	await h.manager.stop(AGENT_ID);
	const replacement = {
		isRunning: () => true,
		client: {
			request: async (input) => {
				if (input.type !== "compact") return { success: true, data: {} };
				newEntered.resolve();
				return newReply.promise;
			},
		},
	};
	h.manager.agents.set(AGENT_ID, { ...h.runtime, process: replacement });
	const newRequest = outcome(h.manager.compact(AGENT_ID));
	await newEntered.promise;
	oldReply.resolve({ success: true });
	const oldResult = await oldRequest;
	assert.match(oldResult.error?.message ?? "", /runtime changed/);
	assert.equal((await h.manager.getRuntimeState(AGENT_ID)).isCompacting, true);
	const duplicate = await outcome(h.manager.compact(AGENT_ID));
	assert.match(duplicate.error?.message ?? "", /already compacting/);
	newReply.resolve({ success: true });
	const newResult = await newRequest;
	assert.equal(newResult.error, undefined);
	assert.equal(newResult.value.isCompacting, false);
});

test("closing a timed-out manual compact clears both compact state sets", async () => {
	const h = harness({
		request: async () => {
			throw new Error("RPC command timed out after 600000ms: compact");
		},
	});
	await assert.rejects(h.manager.compact(AGENT_ID), new RegExp(COMPACT_WAIT_TIMEOUT));
	assert.equal(h.manager.compactingAgents.has(AGENT_ID), true, "a running background compact must keep the meter busy");
	assert.equal(h.manager.compactTimedOutAgents.has(AGENT_ID), true);
	await h.manager.stop(AGENT_ID);
	assert.equal(h.manager.compactingAgents.has(AGENT_ID), false);
	assert.equal(h.manager.compactTimedOutAgents.has(AGENT_ID), false);
});

test("a timed-out compact remains busy until its background completion event", async () => {
	const h = harness({
		request: async () => {
			throw new Error("RPC command timed out after 600000ms: compact");
		},
	});
	await assert.rejects(h.manager.compact(AGENT_ID), new RegExp(COMPACT_WAIT_TIMEOUT));
	assert.equal((await h.manager.getRuntimeState(AGENT_ID)).isCompacting, true);
	h.manager.handlePiEvent(AGENT_ID, { type: "compaction_end", result: true });
	assert.equal((await h.manager.getRuntimeState(AGENT_ID)).isCompacting, false);
	assert.equal(h.manager.compactTimedOutAgents.has(AGENT_ID), false);
	assert.deepEqual(h.notices, ["diagnostic.compactDoneAfterTimeout"]);
});

test("a compact which exits its process can still reconnect its own runtime", async () => {
	const h = harness({
		request: async () => {
			h.process.stop();
			throw new Error("pi exited");
		},
	});
	let reconnects = 0;
	h.manager.reattachProcess = async () => {
		reconnects++;
		h.runtime.process = {
			isRunning: () => true,
			client: { request: async () => ({ success: true, data: {} }) },
		};
	};
	const state = await h.manager.compact(AGENT_ID);
	assert.equal(reconnects, 1);
	assert.equal(state.isCompacting, false);
	assert.equal(h.reloads.length, 1);
	assert.deepEqual(h.notices, ["diagnostic.compactDone"]);
});

test("successful manual compact reloads history, clears overflow, and settles its busy state", async () => {
	const h = harness();
	h.manager.contextOverflowByAgent.set(AGENT_ID, true);
	const result = await h.manager.compact(AGENT_ID);
	assert.equal(result.isCompacting, false);
	assert.equal(h.manager.contextOverflowByAgent.has(AGENT_ID), false);
	assert.deepEqual(h.overflowStates, [false]);
	assert.equal(h.reloads.length, 1);
});

for (const binding of ["deckSessionId", "runtimeGeneration", "sessionPath"]) {
	test(`changing ${binding} during ownership discovery cancels the source compact`, async () => {
		const probe = deferred();
		const h = harness({ ownership: () => probe.promise });
		const pending = outcome(h.manager.compact(AGENT_ID));
		if (binding === "runtimeGeneration") h.runtime.tab.runtimeGeneration = 2;
		else h.runtime.tab[binding] = "replacement";
		probe.resolve(undefined);
		const result = await pending;
		assert.match(result.error?.message ?? "", /runtime changed/);
		assert.equal(h.requests.length, 0);
		assert.equal(h.reloads.length, 0);
	});
}

test("a successful compact reply cannot clear overflow after the session binding changes", async () => {
	const reply = deferred();
	const entered = deferred();
	const h = harness({
		request: () => {
			entered.resolve();
			return reply.promise;
		},
	});
	const pending = outcome(h.manager.compact(AGENT_ID));
	await entered.promise;
	h.runtime.tab.deckSessionId = "session-replacement";
	h.manager.contextOverflowByAgent.set(AGENT_ID, true);
	reply.resolve({ success: true });
	const result = await pending;
	assert.match(result.error?.message ?? "", /runtime changed/);
	assert.equal(h.manager.contextOverflowByAgent.get(AGENT_ID), true);
	assert.equal(h.overflowStates.length, 0);
	assert.equal(h.reloads.length, 0);
});

test("an owner command reply cannot report completion for a new session binding", async () => {
	const reply = deferred();
	const entered = deferred();
	const h = harness({
		ownership: async () => ({ owners: ["magic-context"], ownerReady: true, manualCommand: "/ctx-wrapup", notes: [], conflicted: false, piAutoCompactionEnabled: false }),
		request: () => {
			entered.resolve();
			return reply.promise;
		},
	});
	const pending = outcome(h.manager.compact(AGENT_ID));
	await entered.promise;
	h.runtime.tab.runtimeGeneration = 2;
	reply.resolve({ success: true });
	const result = await pending;
	assert.match(result.error?.message ?? "", /runtime changed/);
	assert.equal(h.requests.length, 1);
});

test("closing during a compact reconnect prevents the real reattach method from publishing history", async () => {
	const handshake = deferred();
	const entered = deferred();
	const h = harness({
		request: async () => {
			h.process.stop();
			throw new Error("pi exited");
		},
	});
	const reconnectProcess = {
		stop: () => {},
		getDiagnostics: () => null,
	};
	h.manager.handshakePiProcess = async () => {
		h.runtime.process = reconnectProcess;
		entered.resolve();
		await handshake.promise;
		return { process: reconnectProcess, state: { success: true, data: {} }, fallbackFromExtensions: false };
	};
	const pending = outcome(h.manager.compact(AGENT_ID));
	await entered.promise;
	await h.manager.stop(AGENT_ID);
	// stop 移除 runtime；实际 closed 由进程 exit 事件写入。替身只核对迟到握手不改写退役 tab。
	const retiredStatus = h.runtime.tab.status;
	handshake.resolve();
	const result = await pending;
	assert.match(result.error?.message ?? "", /runtime changed/);
	assert.equal(h.manager.agents.has(AGENT_ID), false);
	assert.equal(h.runtime.tab.status, retiredStatus);
	assert.equal(h.reloads.length, 0);
	assert.equal(h.notices.length, 0);
});

test("an uninterrupted compact reconnect publishes history through the real reattach method", async () => {
	const h = harness({
		request: async () => {
			h.process.stop();
			throw new Error("pi exited");
		},
	});
	const reconnectProcess = {
		stop: () => {},
		isRunning: () => true,
		getDiagnostics: () => null,
		client: { request: async () => ({ success: true, data: {} }) },
	};
	h.manager.handshakePiProcess = async () => {
		h.runtime.process = reconnectProcess;
		return { process: reconnectProcess, state: { success: true, data: { sessionFile: h.runtime.tab.sessionPath } }, fallbackFromExtensions: false };
	};
	let notifications = 0;
	h.manager.startupDiagnostics.notifyExtensionsDisabled = () => notifications++;
	const result = await h.manager.compact(AGENT_ID);
	assert.equal(result.isCompacting, false);
	assert.equal(h.runtime.tab.status, "idle");
	assert.equal(h.runtime.process, reconnectProcess);
	assert.equal(notifications, 1);
	assert.deepEqual(h.notices, ["diagnostic.compactDone"]);
});

test("a replaced handshake process is stopped without stopping the replacement runtime", async () => {
	const handshake = deferred();
	const entered = deferred();
	const h = harness({
		request: async () => {
			h.process.stop();
			throw new Error("pi exited");
		},
	});
	let retiredStops = 0;
	let replacementStops = 0;
	const retiredProcess = { stop: () => retiredStops++ };
	const replacementProcess = {
		stop: () => replacementStops++,
		client: { request: async () => ({ success: true, data: {} }) },
	};
	h.manager.handshakePiProcess = async () => {
		h.runtime.process = retiredProcess;
		entered.resolve();
		await handshake.promise;
		return { process: retiredProcess, state: { success: true, data: {} }, fallbackFromExtensions: false };
	};
	const pending = outcome(h.manager.compact(AGENT_ID));
	await entered.promise;
	h.runtime.process = replacementProcess;
	handshake.resolve();
	const result = await pending;
	assert.match(result.error?.message ?? "", /runtime changed/);
	assert.equal(retiredStops, 1);
	assert.equal(replacementStops, 0);
	assert.equal(h.runtime.process, replacementProcess);
	assert.equal(h.reloads.length, 0);
	await h.flushStates();
});

test("a context owner still receives its own command rather than a native compact RPC", async () => {
	const h = harness({
		ownership: async () => ({ owners: ["magic-context"], ownerReady: true, manualCommand: "/ctx-wrapup", notes: [], conflicted: false, piAutoCompactionEnabled: false }),
	});
	await assert.rejects(h.manager.compact(AGENT_ID), new RegExp(COMPACT_ROUTED_TO_OWNER));
	assert.equal(JSON.stringify(h.requests), JSON.stringify([{ type: "prompt", message: "/ctx-wrapup" }]));
	assert.equal(h.manager.compactingAgents.has(AGENT_ID), false);
	assert.equal(h.reloads.length, 0);
});
