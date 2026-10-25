import assert from "node:assert";
import test from "node:test";
import { loadTsCommonJs } from "../helpers/loadTsCommonJs.mjs";

const { CuaGate } = loadTsCommonJs("src/main/cua/CuaGate.ts");

test("readonly actions bypass the gate", async () => {
	const gate = new CuaGate();
	const captureDecision = await gate.check("capture", "sess1", {});
	assert.strictEqual(captureDecision.allowed, true);

	const listDecision = await gate.check("list_windows", "sess1", {});
	assert.strictEqual(listDecision.allowed, true);

	const stateDecision = await gate.check("get_state", "sess1", {});
	assert.strictEqual(stateDecision.allowed, true);
});

test("global kill switch blocks write actions", async () => {
	const gate = new CuaGate({ enabled: false });
	const clickDecision = await gate.check("click", "sess1", { x: 100, y: 100 });
	assert.strictEqual(clickDecision.allowed, false);
	assert.strictEqual(clickDecision.reason, "cua_disabled");
});

test("session override blocks write actions for that session", async () => {
	const gate = new CuaGate({ enabled: true });
	gate.setSessionOverride("sess1", false);

	const blocked = await gate.check("click", "sess1", { x: 100, y: 100 });
	assert.strictEqual(blocked.allowed, false);
	assert.strictEqual(blocked.reason, "cua_disabled");

	// Other sessions have no override; with a handler wired they fall through to it.
	gate.setApprovalHandler(async () => ({ allowed: true }));
	const allowed = await gate.check("click", "sess2", { x: 100, y: 100 });
	assert.strictEqual(allowed.allowed, true);
});

test("session override null inherits global", async () => {
	const gate = new CuaGate({ enabled: true });
	gate.setApprovalHandler(async () => ({ allowed: true }));
	gate.setSessionOverride("sess1", false);
	gate.setSessionOverride("sess1", null);

	const decision = await gate.check("click", "sess1", { x: 100, y: 100 });
	assert.strictEqual(decision.allowed, true);
});

test("no approval handler fails closed for write actions", async () => {
	const gate = new CuaGate({ enabled: true });

	const clickDecision = await gate.check("click", "sess1", { x: 100, y: 100 });
	assert.strictEqual(clickDecision.allowed, false);
	assert.strictEqual(clickDecision.reason, "no_approval_handler");

	const typeDecision = await gate.check("type", "sess1", { text: "hello" });
	assert.strictEqual(typeDecision.allowed, false);
});

test("in-process handler allows the action", async () => {
	const gate = new CuaGate({ enabled: true });
	gate.setApprovalHandler(async (request) => {
		assert.strictEqual(request.action, "click");
		assert.strictEqual(request.sessionId, "sess1");
		return { allowed: true };
	});

	const decision = await gate.check("click", "sess1", { x: 100, y: 100 });
	assert.strictEqual(decision.allowed, true);
});

test("in-process handler denies the action", async () => {
	const gate = new CuaGate({ enabled: true });
	gate.setApprovalHandler(async () => ({ allowed: false, reason: "user_denied" }));

	const decision = await gate.check("type", "sess1", { text: "hello" });
	assert.strictEqual(decision.allowed, false);
	assert.strictEqual(decision.reason, "user_denied");
});

test("handler that throws denies the action (fail closed)", async () => {
	const gate = new CuaGate({ enabled: true });
	gate.setApprovalHandler(async () => {
		throw new Error("bridge_down");
	});

	const decision = await gate.check("click", "sess1", { x: 100, y: 100 });
	assert.strictEqual(decision.allowed, false);
	assert.ok(decision.reason?.startsWith("approval_request_failed"), `reason was: ${decision.reason}`);
});

test("handler that never settles times out and denies", async () => {
	const gate = new CuaGate({ enabled: true, approvalTimeoutMs: 50 });
	gate.setApprovalHandler(() => new Promise(() => {}));

	const decision = await gate.check("click", "sess1", { x: 100, y: 100 });
	assert.strictEqual(decision.allowed, false);
	assert.ok(decision.reason?.includes("approval_timeout"), `reason was: ${decision.reason}`);
});

test("in-process handler receives agentId + runtimeGeneration metadata", async () => {
	const gate = new CuaGate({ enabled: true });
	let seen = null;
	gate.setApprovalHandler(async (request) => {
		seen = request;
		return { allowed: true };
	});

	const decision = await gate.check("click", "sess1", { x: 1, y: 2 }, { agentId: "agent-7", runtimeGeneration: 42 });
	assert.strictEqual(decision.allowed, true);
	assert.ok(seen, "handler should have been called");
	assert.strictEqual(seen.agentId, "agent-7");
	assert.strictEqual(seen.runtimeGeneration, 42);
	assert.strictEqual(seen.sessionId, "sess1");
});

test("metadata is optional and omitted when not provided", async () => {
	const gate = new CuaGate({ enabled: true });
	let seen = null;
	gate.setApprovalHandler(async (request) => {
		seen = request;
		return { allowed: true };
	});

	await gate.check("type", "sess1", { text: "hi" });
	assert.strictEqual(seen.agentId, undefined);
	assert.strictEqual(seen.runtimeGeneration, undefined);
});

test("getSessionOverrides reflects setSessionOverride", () => {
	const gate = new CuaGate({ enabled: true });
	gate.setSessionOverride("sess1", false);
	gate.setSessionOverride("sess2", true);

	const overrides = gate.getSessionOverrides();
	assert.strictEqual(overrides.sess1, false);
	assert.strictEqual(overrides.sess2, true);
});

// ── 免审批模式（cuaAutoApprove 设置）：只绕过审批对话框，杀开关仍生效 ──

test("auto-approve allows write actions without an approval handler", async () => {
	const gate = new CuaGate({ enabled: true, autoApprove: true });
	const decision = await gate.check("click", "sess1", { x: 100, y: 100 });
	assert.strictEqual(decision.allowed, true);
	assert.strictEqual(decision.reason, "auto_approve");
});

test("auto-approve does not override the global kill switch", async () => {
	const gate = new CuaGate({ enabled: false, autoApprove: true });
	const decision = await gate.check("type", "sess1", { text: "hello" });
	assert.strictEqual(decision.allowed, false);
	assert.strictEqual(decision.reason, "cua_disabled");
});

test("auto-approve does not override session-level kill switches", async () => {
	const gate = new CuaGate({ enabled: true, autoApprove: true });
	gate.setSessionOverride("sess1", false);
	const decision = await gate.check("scroll", "sess1", { x: 10, y: 10 });
	assert.strictEqual(decision.allowed, false);
	assert.strictEqual(decision.reason, "cua_disabled");
});

test("auto-approve accepts a provider function resolved per check", async () => {
	let on = false;
	const gate = new CuaGate({ enabled: true, autoApprove: () => on });
	gate.setApprovalHandler(async () => ({ allowed: false, reason: "denied_by_user" }));

	const denied = await gate.check("click", "sess1", {});
	assert.strictEqual(denied.allowed, false);
	assert.strictEqual(denied.reason, "denied_by_user");

	on = true;
	const allowed = await gate.check("click", "sess1", {});
	assert.strictEqual(allowed.allowed, true);
	assert.strictEqual(allowed.reason, "auto_approve");
});

test("setAutoApprove updates the bypass at runtime", async () => {
	const gate = new CuaGate({ enabled: true });
	gate.setApprovalHandler(async () => ({ allowed: true }));
	gate.setAutoApprove(true);
	assert.strictEqual(gate.isAutoApprove(), true);
	const decision = await gate.check("click", "sess1", {});
	assert.strictEqual(decision.reason, "auto_approve");
});
