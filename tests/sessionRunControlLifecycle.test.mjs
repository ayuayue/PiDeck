import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { agent, deferred, harness, plain, queuedPrompt, replacement, runtimeInfo, sessionRecord, sourceTarget } from "./helpers/sessionRunControlHarness.mjs";

test("an explicit missing agent never restarts the focused agent", async () => {
	const h = harness();
	await h.hook.restartActiveAgent("obsolete-agent");
	assert.equal(h.calls.filter(([op]) => op === "restart").length, 0);
	assert.deepEqual(h.toasts, ["sessionCommand.runtimeUnavailable"]);
});

for (const change of ["session", "generation", "detach"]) {
	test(`runtime refresh discards a response after ${change} changes`, async () => {
		const h = harness();
		const response = deferred();
		h.sessions.getRuntimeState = async () => response.promise;
		const pending = h.hook.refreshRuntimeState("agent-a");
		if (change === "session") {
			h.runtimes.delete("source-a");
			h.runtimes.set("source-b", runtimeInfo({ sessionId: "source-b", runtimeGeneration: 2 }));
		} else if (change === "detach") h.runtimes.delete("source-a");
		else h.runtimes.set("source-a", runtimeInfo({ runtimeGeneration: 2 }));
		response.resolve({ ok: true, value: { target: sourceTarget, value: { modelId: "old-model" } } });
		await pending;
		assert.deepEqual(h.runtimeEvents, []);
	});
}

test("runtime refresh preserves the response target when its binding is unchanged", async () => {
	const h = harness();
	await h.hook.refreshRuntimeState("agent-a");
	assert.deepEqual(h.runtimeEvents, [{ ...sourceTarget, sourceChannel: "agents:runtime-state", payload: { agentId: "agent-a", state: { modelId: "refreshed-model" } } }]);
});

test("same-turn restarts share a synchronous guard across both entry points", async () => {
	const h = harness();
	const response = deferred();
	h.sessions.restartRuntime = async (target) => {
		h.calls.push(["restart", plain(target)]);
		return response.promise;
	};
	const first = h.hook.restartActiveAgent("agent-a");
	const second = h.hook.restartSessionAnyState("source-a");
	assert.equal(h.calls.filter(([op]) => op === "restart").length, 1);
	assert.equal(h.hook.getSessionRunCapabilities("source-a").pending, true);
	response.resolve({ ok: true, value: replacement() });
	await Promise.all([first, second]);
	assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
	await h.hook.restartSessionAnyState("source-a");
	assert.equal(h.calls.filter(([op]) => op === "restart").length, 2);
});

test("a pending restart excludes clone until the operation settles", async () => {
	const h = harness();
	const response = deferred();
	h.sessions.restartRuntime = async (target) => {
		h.calls.push(["restart", plain(target)]);
		return response.promise;
	};
	const pending = h.hook.restartActiveAgent("agent-a");
	await h.hook.cloneAgentSession("agent-a");
	assert.equal(
		h.calls.some(([op]) => op === "clone"),
		false,
	);
	response.resolve({ ok: true, value: replacement() });
	await pending;
	await h.hook.cloneAgentSession("agent-a");
	assert.equal(h.calls.filter(([op]) => op === "clone").length, 1);
});

test("confirmation rechecks queued delivery before restarting", async () => {
	const h = harness();
	await h.hook.runSessionControl("source-a", "restart");
	assert.equal(h.confirmations.length, 1);
	h.deps.queuedPromptsRef.current["source-a"] = [queuedPrompt("unknown")];
	h.confirmations[0].onConfirm();
	await Promise.resolve();
	assert.equal(h.calls.filter(([op]) => op === "restart").length, 0);
});

for (const state of ["starting", "queued", "flushing"]) {
	test(`unified run control refuses restart when ${state}`, async () => {
		const h = harness({ status: state === "starting" ? "starting" : "idle" });
		if (state === "queued") h.deps.queuedPromptsRef.current["source-a"] = [queuedPrompt("sending")];
		if (state === "flushing") h.deps.queueFlushBySessionRef.current.add("source-a");
		await h.hook.runSessionControl("source-a", "restart");
		assert.equal(h.confirmations.length, 0);
		assert.equal(h.calls.filter(([op]) => op === "restart").length, 0);
	});
}

test("clone resolves the project from its source record rather than the focused project", async () => {
	const h = harness();
	const hook = h.render({ agents: [], activeAgent: agent("agent-b", "project-b"), activeAgentId: "agent-b", activeProjectId: "project-b" });
	await hook.cloneAgentSession("agent-a");
	assert.deepEqual(
		h.calls.find(([op]) => op === "refresh-project"),
		["refresh-project", "project-a"],
	);
});

test("clone rejects same-turn duplicate and restart until it settles", async () => {
	const h = harness();
	const response = deferred();
	h.sessions.cloneRuntime = async (target) => {
		h.calls.push(["clone", plain(target)]);
		return response.promise;
	};
	const first = h.hook.cloneAgentSession("agent-a");
	const second = h.hook.cloneAgentSession("agent-a");
	const restart = h.hook.restartSessionAnyState("source-a");
	assert.equal(h.calls.filter(([op]) => op === "clone").length, 1);
	assert.equal(h.calls.filter(([op]) => op === "restart").length, 0);
	response.resolve({ ok: true, value: { cancelled: true } });
	await Promise.all([first, second, restart]);
	await h.hook.restartSessionAnyState("source-a");
	assert.equal(h.calls.filter(([op]) => op === "restart").length, 1);
});

test("opening a replaced runtime waits for selection completion", async () => {
	const h = harness();
	const response = deferred();
	const hook = h.render({ selectSessionCommand: () => response.promise });
	let settled = false;
	const pending = hook.openReplacedRuntimeSession("project-a", "clone-a").then(() => {
		settled = true;
	});
	await setImmediate();
	assert.equal(settled, false);
	response.resolve();
	await pending;
	assert.equal(settled, true);
});

for (const failure of ["structured", "rejected"]) {
	test(`clone ${failure} failure is visible and releases the guard for manual retry`, async () => {
		const h = harness();
		const clone = h.sessions.cloneRuntime;
		h.sessions.cloneRuntime = async () => {
			if (failure === "rejected") throw new Error("clone IPC failed");
			return { ok: false, error: { code: "SESSION_COMMAND_FAILED" } };
		};
		await h.hook.cloneAgentSession("agent-a");
		assert.equal(h.toasts.length, 1);
		assert.match(h.toasts[0], /commandFailed|clone IPC failed/);
		assert.equal(
			h.calls.some(([op]) => op === "select"),
			false,
		);
		assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
		h.sessions.cloneRuntime = clone;
		await h.hook.cloneAgentSession("agent-a");
		assert.equal(h.calls.filter(([op]) => op === "clone").length, 1);
	});

	test(`restart ${failure} failure clears progress and permits manual retry`, async () => {
		const h = harness();
		const restart = h.sessions.restartRuntime;
		h.sessions.restartRuntime = async () => {
			if (failure === "rejected") throw new Error("restart IPC failed");
			return { ok: false, error: { code: "SESSION_COMMAND_FAILED" } };
		};
		await h.hook.restartActiveAgent("agent-a");
		assert.equal(h.toasts.length, 1);
		assert.match(h.toasts[0], /commandFailed|restart IPC failed/);
		assert.equal(h.deps.pendingAgentsRef.current[0]?.status, "error");
		const hook = h.render();
		assert.equal(hook.restartingAgentId, null);
		assert.equal(hook.getSessionRunCapabilities("source-a").pending, false);
		h.sessions.restartRuntime = restart;
		await hook.restartActiveAgent("agent-a");
		assert.deepEqual(plain(h.deps.pendingAgentsRef.current), []);
		assert.equal(h.calls.filter(([op]) => op === "restart").length, 1);
	});
}

for (const code of ["SESSION_RUNTIME_UNAVAILABLE", "SESSION_RUNTIME_CHANGED"]) {
	test(`restart ${code} falls back once to activation without a stale pending agent`, async () => {
		const h = harness();
		h.sessions.restartRuntime = async (target) => {
			h.calls.push(["restart", plain(target)]);
			return { ok: false, error: { code } };
		};
		await h.hook.restartSessionAnyState("source-a");
		assert.equal(h.calls.filter(([op]) => op === "restart").length, 1);
		assert.deepEqual(
			h.calls.filter(([op]) => op === "activate"),
			[["activate", "source-a"]],
		);
		assert.deepEqual(plain(h.deps.pendingAgentsRef.current), []);
		assert.deepEqual(h.toasts, ["app.sessionStarted"]);
		assert.deepEqual(h.overlays, [
			{ sessionId: "source-a", kind: "activating" },
			{ sessionId: "source-a", kind: null },
		]);
		assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
	});
}

test("activation rejects duplicate starts and clears its overlay after IPC failure", async () => {
	const h = harness();
	h.runtimes.clear();
	const response = deferred();
	const activate = h.sessions.activateRuntime;
	h.sessions.activateRuntime = async (sessionId) => {
		h.calls.push(["activate", sessionId]);
		return response.promise;
	};
	const first = h.hook.restartSessionAnyState("source-a");
	const second = h.hook.restartSessionAnyState("source-a");
	assert.equal(h.calls.filter(([op]) => op === "activate").length, 1);
	response.reject(new Error("activation IPC failed"));
	await Promise.all([first, second]);
	assert.match(h.toasts[0], /activation IPC failed/);
	assert.deepEqual(h.overlays, [
		{ sessionId: "source-a", kind: "activating" },
		{ sessionId: "source-a", kind: null },
	]);
	const hook = h.render();
	assert.equal(hook.activatingSessionId, null);
	assert.equal(hook.getSessionRunCapabilities("source-a").pending, false);
	h.sessions.activateRuntime = activate;
	await hook.restartSessionAnyState("source-a");
	assert.equal(h.calls.filter(([op]) => op === "activate").length, 2);
});

test("restart confirmation retains its source after focus changes", async () => {
	const h = harness();
	await h.hook.runSessionControl("source-a", "restart");
	h.records["source-b"] = sessionRecord("source-b", "project-b");
	h.runtimes.set("source-b", runtimeInfo({ sessionId: "source-b", agentId: "agent-b" }));
	h.render({ activeAgent: agent("agent-b", "project-b"), activeAgentId: "agent-b", activeProjectId: "project-b" });
	h.confirmations[0].onConfirm();
	await setImmediate();
	assert.deepEqual(
		h.calls.filter(([op]) => op === "restart"),
		[["restart", sourceTarget]],
	);
});

test("clone catches asynchronous selection failure and allows a subsequent operation", async () => {
	const h = harness();
	const hook = h.render({
		selectSessionCommand: async () => {
			throw new Error("selection failed");
		},
	});
	await hook.cloneAgentSession("agent-a");
	assert.match(h.toasts.at(-1), /selection failed/);
	assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
	await h.hook.cloneAgentSession("agent-a");
	assert.equal(h.calls.filter(([op]) => op === "clone").length, 2);
});
