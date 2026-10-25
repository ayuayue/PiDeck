import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import test from "node:test";
import { agent, deferred, harness, messagePage, plain, runtimeInfo, sessionRecord, sourceTarget } from "./helpers/sessionRunControlHarness.mjs";

/** 按请求参数记录暂停的读盘，便于断言同轮入口是否合并。 */
function pauseReload(h) {
	const response = deferred();
	h.sessions.readRecordMessagePage = async (...args) => {
		h.calls.push(["reload", ...args]);
		return response.promise;
	};
	return response;
}

test("same-turn reloads share a guard with activation and release it after completion", async () => {
	const h = harness({ status: "closed" });
	const response = pauseReload(h);
	const first = h.hook.reloadSessionMessages("source-a");
	const duplicate = h.hook.runSessionControl("source-a", "reload");
	await h.hook.restartSessionAnyState("source-a");
	assert.equal(h.calls.filter(([op]) => op === "reload").length, 1);
	assert.equal(h.calls.filter(([op]) => op === "restart").length, 0);
	response.resolve(messagePage());
	await Promise.all([first, duplicate]);
	assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
	await h.hook.restartSessionAnyState("source-a");
	assert.equal(h.calls.filter(([op]) => op === "restart").length, 1);
});

for (const change of ["live", "generation", "cache", "deleted", "load-state", "overlay"]) {
	test(`reload discards stale success after ${change} changes`, async () => {
		const h = harness({ status: "closed" });
		const response = pauseReload(h);
		const pending = h.hook.reloadSessionMessages("source-a");
		if (change === "live") h.runtimes.set("source-a", runtimeInfo({ status: "running" }));
		if (change === "generation") h.runtimes.set("source-a", runtimeInfo({ status: "error", runtimeGeneration: 2 }));
		if (change === "cache") h.cache["source-a"] = { messages: messagePage("new live reply").messages, source: "runtime", revision: 1 };
		if (change === "deleted") delete h.records["source-a"];
		if (change === "load-state") h.loads["source-a"] = { status: "error", error: "newer load failed" };
		if (change === "overlay") h.overlayKinds["source-a"] = "editing";
		response.resolve(messagePage("old disk reply"));
		await pending;
		assert.deepEqual(h.cacheWrites, []);
		assert.deepEqual(h.toasts, []);
		assert.equal(h.render().reloadingSessionId, null);
		if (change === "load-state") assert.deepEqual(plain(h.loads["source-a"]), { status: "error", error: "newer load failed" });
		if (change === "overlay") assert.equal(h.overlayKinds["source-a"], "editing");
	});
}

test("reload stale failure never replaces the new runtime's load state or notifies success", async () => {
	const h = harness({ status: "error" });
	const response = pauseReload(h);
	const pending = h.hook.reloadSessionMessages("source-a");
	h.runtimes.set("source-a", runtimeInfo({ runtimeGeneration: 2, status: "running" }));
	h.loads["source-a"] = { status: "ready" };
	response.reject(new Error("old disk failure"));
	await pending;
	assert.deepEqual(plain(h.loads["source-a"]), { status: "ready" });
	assert.deepEqual(h.toasts, []);
	assert.equal(h.render().reloadingSessionId, null);
});

test("discarded reload releases only its own loading state", async () => {
	const h = harness({ status: "closed" });
	h.loads["source-a"] = { status: "ready" };
	h.cache["source-a"] = { messages: messagePage().messages, source: "disk", revision: 0 };
	const response = pauseReload(h);
	const pending = h.hook.reloadSessionMessages("source-a");
	h.runtimes.set("source-a", runtimeInfo({ status: "running", runtimeGeneration: 2 }));
	response.resolve(messagePage("stale"));
	await pending;
	assert.equal(h.loads["source-a"].status, "ready");
	assert.deepEqual(h.cacheWrites, []);
	assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
});

test("reload stays source-addressed after focus changes and preserves pagination", async () => {
	const h = harness({ status: "error" });
	const response = pauseReload(h);
	const pending = h.hook.reloadSessionMessages("source-a");
	h.records["source-b"] = sessionRecord("source-b", "project-b");
	h.runtimes.set("source-b", runtimeInfo({ sessionId: "source-b", agentId: "agent-b" }));
	h.render({ activeAgent: agent("agent-b", "project-b"), activeAgentId: "agent-b", activeProjectId: "project-b" });
	const page = { ...messagePage(), total: 8, nextBefore: 6 };
	response.resolve(page);
	await pending;
	assert.deepEqual(h.cacheWrites, [{ sessionId: "source-a", messages: page.messages, source: "disk", expectedRevision: 0, page: { total: 8, nextBefore: 6 }, force: true }]);
	assert.deepEqual(plain(h.loads["source-a"]), { status: "ready" });
	assert.deepEqual(h.toasts, ["app.sessionReloaded"]);
	assert.equal(h.render().reloadingSessionId, null);
});

for (const status of ["starting", "idle", "running"]) {
	test(`reload never queries disk while a runtime is ${status}`, async () => {
		const h = harness({ status });
		await h.hook.reloadSessionMessages("source-a");
		assert.deepEqual(h.calls, []);
		assert.deepEqual(h.overlays, []);
	});
}

test("DSH stopped-host reload preserves cached messages and its recoverable error reason", async () => {
	const h = harness({ status: "closed" });
	const cached = { messages: messagePage().messages, source: "runtime", revision: 1 };
	h.cache["source-a"] = cached;
	h.sessions.readRecordMessagePage = async () => ({ messages: [], total: 0, nextBefore: null, unavailable: "dsh-host-stopped" });
	await h.hook.reloadSessionMessages("source-a");
	assert.equal(h.cache["source-a"], cached);
	assert.deepEqual(h.cacheWrites, []);
	assert.deepEqual(plain(h.loads["source-a"]), { status: "error", reason: "dsh-host-stopped" });
	assert.deepEqual(h.toasts, []);
	assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
});

test("reload failure is visible and allows a successful manual retry", async () => {
	const h = harness({ status: "closed" });
	const read = h.sessions.readRecordMessagePage;
	h.sessions.readRecordMessagePage = async () => {
		throw new Error("disk unavailable");
	};
	await h.hook.reloadSessionMessages("source-a");
	assert.deepEqual(plain(h.loads["source-a"]), { status: "error", error: "disk unavailable" });
	assert.deepEqual(h.toasts, ["app.sessionReloadFailed"]);
	const hook = h.render();
	assert.equal(hook.reloadingSessionId, null);
	assert.equal(hook.getSessionRunCapabilities("source-a").pending, false);
	h.sessions.readRecordMessagePage = read;
	await hook.reloadSessionMessages("source-a");
	assert.equal(h.cacheWrites.length, 1);
	assert.deepEqual(plain(h.loads["source-a"]), { status: "ready" });
});

test("hot reload writes the refreshed command table and bumps the composer refresh tick", async () => {
	const h = harness({ status: "idle" });
	await h.hook.reloadResources("source-a");
	assert.deepEqual(
		h.calls.filter(([op]) => op === "reload-resources"),
		[["reload-resources", sourceTarget]],
	);
	assert.equal(h.commandWrites.length, 1);
	assert.deepEqual(plain(h.commandWrites[0].commands), [{ name: "reload", source: "extension" }]);
	assert.equal(h.tickWrites.length, 1);
	assert.deepEqual(h.toasts, ["app.sessionResourcesReloaded"]);
	assert.equal(h.render().reloadingSessionId, null);
	assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
});

for (const status of ["starting", "running", "error", "closed"]) {
	test(`hot reload is refused while the runtime is ${status}`, async () => {
		const h = harness({ status });
		await h.hook.reloadResources("source-a");
		assert.deepEqual(
			h.calls.filter(([op]) => op === "reload-resources"),
			[],
		);
		assert.equal(h.commandWrites.length, 0);
		assert.equal(h.tickWrites.length, 0);
		assert.deepEqual(h.toasts, ["sessionCommand.reloadResourcesBusy"]);
	});
}

test("hot reload failure is visible and releases the busy state", async () => {
	const h = harness({ status: "idle" });
	h.sessions.reloadResources = async () => ({ ok: false, error: { code: "SESSION_COMMAND_FAILED", debugDetails: "reload failed" } });
	await h.hook.reloadResources("source-a");
	assert.deepEqual(h.commandWrites, []);
	assert.equal(h.tickWrites.length, 0);
	assert.equal(h.toasts.length, 1);
	assert.match(h.toasts[0], /commandFailed/);
	assert.equal(h.render().reloadingSessionId, null);
	assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
});

test("same-turn closes are deduplicated and exclude replacement until stop settles", async () => {
	const h = harness();
	const response = deferred();
	h.sessions.stopRuntime = async (target) => {
		h.calls.push(["stop", target]);
		return response.promise;
	};
	const first = h.hook.closeAgent("agent-a");
	const duplicate = h.hook.requestCloseAgent({ id: "agent-a" });
	await h.hook.restartActiveAgent("agent-a");
	await h.hook.cloneAgentSession("agent-a");
	assert.equal(h.calls.filter(([op]) => op === "stop").length, 1);
	assert.equal(h.calls.filter(([op]) => op === "restart" || op === "clone").length, 0);
	assert.equal(h.hook.getSessionRunCapabilities("source-a").pending, true);
	response.resolve({ ok: true, value: undefined });
	await Promise.all([first, duplicate]);
	assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
	await h.hook.cloneAgentSession("agent-a");
	assert.equal(h.calls.filter(([op]) => op === "clone").length, 1);
});

for (const failure of ["structured", "rejected"]) {
	test(`close ${failure} failure is caught at the owner and releases progress for retry`, async () => {
		const h = harness();
		const stop = h.sessions.stopRuntime;
		h.sessions.stopRuntime = async () => {
			if (failure === "rejected") throw new Error("stop IPC failed");
			return { ok: false, error: { code: "SESSION_COMMAND_FAILED" } };
		};
		await assert.doesNotReject(h.hook.closeAgent("agent-a"));
		assert.equal(h.toasts.length, 1);
		assert.match(h.toasts[0], /commandFailed|stop IPC failed/);
		const hook = h.render();
		assert.equal(hook.stoppingAgentId, null);
		assert.equal(hook.getSessionRunCapabilities("source-a").pending, false);
		assert.deepEqual(h.overlayKinds, {});
		h.sessions.stopRuntime = stop;
		await hook.closeAgent("agent-a");
		assert.deepEqual(
			h.calls.filter(([op]) => op === "stop"),
			[["stop", sourceTarget]],
		);
	});
}

test("closing a starting runtime remains the escape hatch and never deletes a persisted record", async () => {
	const h = harness({ status: "starting" });
	await h.hook.closeAgent("agent-a");
	assert.deepEqual(h.calls, [["stop", sourceTarget]]);
	assert.equal(h.records["source-a"].id, "source-a");
	assert.equal(h.render().stoppingAgentId, null);
});

for (const firstCompleted of ["activation", "close"]) {
	test(`closing a starting activation stays available with ${firstCompleted} completing first`, async () => {
		const h = harness();
		h.runtimes.clear();
		const activation = deferred();
		const stop = deferred();
		h.sessions.activateRuntime = async (sessionId) => {
			h.calls.push(["activate", sessionId]);
			return activation.promise;
		};
		h.sessions.stopRuntime = async (target) => {
			h.calls.push(["stop", plain(target)]);
			return stop.promise;
		};
		const starting = h.hook.restartSessionAnyState("source-a");
		h.runtimes.set("source-a", runtimeInfo({ status: "starting" }));
		const closing = h.hook.closeAgent("agent-a");
		await h.hook.closeAgent("agent-a");
		assert.equal(h.calls.filter(([op]) => op === "stop").length, 1);
		// stop 的 runtime 事件可能早于 IPC 完成；pending 必须由操作 owner 而非 starting 状态维持。
		h.runtimes.set("source-a", runtimeInfo({ status: "closed" }));
		if (firstCompleted === "activation") {
			activation.resolve({ ok: false, error: { code: "SESSION_RUNTIME_CHANGED" } });
			await starting;
			assert.equal(h.overlayKinds["source-a"], "stopping");
		} else {
			stop.resolve({ ok: true, value: sourceTarget });
			await closing;
		}
		const hook = h.render();
		assert.equal(hook.getSessionRunCapabilities("source-a").pending, true);
		await hook.restartSessionAnyState("source-a");
		await hook.cloneAgentSession("agent-a");
		assert.equal(h.calls.filter(([op]) => op === "activate").length, 1);
		assert.equal(h.calls.filter(([op]) => op === "restart" || op === "clone").length, 0);
		activation.resolve({ ok: false, error: { code: "SESSION_RUNTIME_CHANGED" } });
		stop.resolve({ ok: true, value: sourceTarget });
		await Promise.all([starting, closing]);
		assert.deepEqual(h.overlayKinds, {});
		assert.equal(h.render().getSessionRunCapabilities("source-a").pending, false);
	});
}

test("close 遇到 SESSION_RUNTIME_UNAVAILABLE 时把过期绑定收敛成本地 detach 并给出可见反馈", async () => {
	// 回归（2026-10）：主进程对终态且进程已死的 agent 会在查询路径里惰性解绑且不推 detach，
	// 渲染层快照因而停在 error——此时关闭 Agent 只能拿到「运行实例不可用」。
	// 修复后必须本地收敛（红点熄灭、菜单回落「启动 Agent」）并给出明确文案。
	const h = harness({ status: "error" });
	h.sessions.stopRuntime = async (target) => {
		h.calls.push(["stop", plain(target)]);
		return { ok: false, error: { code: "SESSION_RUNTIME_UNAVAILABLE", debugDetails: "Session runtime is not available" } };
	};
	await h.hook.closeAgent("agent-a");
	assert.deepEqual(plain(h.runtimeEvents), [
		{
			kind: "detach",
			sessionId: "source-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "sessions:runtime-detach",
			payload: null,
		},
	]);
	assert.deepEqual(h.toasts, ["app.runtimeAlreadyGone"]);
	const hook = h.render();
	assert.equal(hook.stoppingAgentId, null);
	assert.equal(hook.getSessionRunCapabilities("source-a").pending, false);
	assert.deepEqual(h.overlayKinds, {});
});

test("close 的过期绑定收敛不覆盖期间换绑的新运行实例", async () => {
	const h = harness({ status: "error" });
	const response = deferred();
	h.sessions.stopRuntime = async () => response.promise;
	const pending = h.hook.closeAgent("agent-a");
	// 关闭在途期间会话被换绑（新 agentId/新一代）：失败回执既不得收敛新绑定，也不能报「已不存在」
	h.runtimes.set("source-a", runtimeInfo({ agentId: "agent-b", runtimeGeneration: 2 }));
	response.resolve({ ok: false, error: { code: "SESSION_RUNTIME_UNAVAILABLE" } });
	await pending;
	assert.deepEqual(h.runtimeEvents, []);
	assert.deepEqual(h.toasts, ["sessionCommand.runtimeChanged"]);
	assert.equal(h.render().stoppingAgentId, null);
});

test("close 遇到同轮互斥操作时给出可重试提示，不静默丢弃点击", async () => {
	const h = harness();
	const response = deferred();
	h.sessions.stopRuntime = async (target) => {
		h.calls.push(["stop", plain(target)]);
		return response.promise;
	};
	const first = h.hook.closeAgent("agent-a");
	await h.hook.closeAgent("agent-a");
	assert.equal(h.calls.filter(([op]) => op === "stop").length, 1);
	assert.deepEqual(h.toasts, ["sessionCommand.runtimeBusy"]);
	response.resolve({ ok: true, value: sourceTarget });
	await first;
	assert.equal(h.render().stoppingAgentId, null);
});

test("late close completion does not clear a newer same-session overlay", async () => {
	const h = harness();
	const response = deferred();
	h.sessions.stopRuntime = async () => response.promise;
	const pending = h.hook.closeAgent("agent-a");
	h.overlayKinds["source-a"] = "activating";
	response.resolve({ ok: true, value: undefined });
	await pending;
	assert.equal(h.overlayKinds["source-a"], "activating");
	assert.equal(h.render().stoppingAgentId, null);
});

test("anonymous close confirmation rejects the same agent rebound to another session", async () => {
	const h = harness();
	await h.hook.requestCloseAgent({ id: "agent-a", noSession: true });
	assert.equal(h.confirmations.length, 1);
	assert.deepEqual(h.calls, []);
	h.runtimes.delete("source-a");
	h.runtimes.set("source-b", runtimeInfo({ sessionId: "source-b", agentId: "agent-a", runtimeGeneration: 2 }));
	h.confirmations[0].onConfirm();
	await setImmediate();
	assert.equal(h.calls.filter(([op]) => op === "stop").length, 0);
	assert.deepEqual(h.toasts, ["sessionCommand.runtimeChanged"]);
});
