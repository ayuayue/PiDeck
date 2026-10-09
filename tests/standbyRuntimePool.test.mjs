import assert from "node:assert/strict";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { StandbyAgentPool } = loadTsCommonJs("src/main/pi/StandbyAgentPool.ts");
const { computeStandbyFingerprint } = loadTsCommonJs("src/main/pi/standbyFingerprint.ts");

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── StandbyAgentPool：单实例生命周期 ──────────────────────────────

test("pool: put 后可按项目+指纹认领，认领后清空且不再触发 TTL 回收", async () => {
	const expired = [];
	const pool = new StandbyAgentPool({ ttlMs: 20, onExpire: (id) => expired.push(id) });
	assert.equal(pool.has("p1"), false);
	pool.put({ projectId: "p1", fingerprint: "fp-a", agentId: "agent-a" });
	assert.equal(pool.has("p1"), true);
	assert.equal(pool.status()?.agentId, "agent-a");
	const entry = pool.take("p1", "fp-a");
	assert.equal(entry?.agentId, "agent-a");
	assert.equal(pool.has("p1"), false);
	await sleep(50);
	assert.deepEqual(expired, []);
});

test("pool: peek 只读返回同项目条目，不消费也不触发回收", async () => {
	const expired = [];
	const pool = new StandbyAgentPool({ ttlMs: 1000, onExpire: (id) => expired.push(id) });
	pool.put({ projectId: "p1", fingerprint: "fp-a", agentId: "agent-a" });
	const peeked = pool.peek("p1");
	// 跨 vm realm 对象无法 deepEqual，逐字段断言
	assert.equal(peeked?.agentId, "agent-a");
	assert.equal(peeked?.fingerprint, "fp-a");
	// peek 不消费：条目仍在，后续仍可认领
	assert.equal(pool.has("p1"), true);
	const entry = pool.take("p1", "fp-a");
	assert.equal(entry?.agentId, "agent-a");
	await sleep(30);
	assert.deepEqual(expired, [], "peek 不得重置或触发 TTL");
	pool.dispose();
});

test("pool: peek 项目不符或池空返回 null", () => {
	const pool = new StandbyAgentPool({ ttlMs: 1000, onExpire: () => undefined });
	assert.equal(pool.peek("p1"), null);
	pool.put({ projectId: "p1", fingerprint: "fp-a", agentId: "agent-a" });
	assert.equal(pool.peek("p2"), null);
	pool.dispose();
});

test("draftCommands: gateway 提供时透传，缺失或抛错一律返回 null", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createClaimHarness();
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);

	// 默认 harness 无 draftCommands 可选能力（dsh 网关形态）→ null
	assert.equal(await coordinator.draftCommands("project-1"), null);

	// pi 网关提供 → 透传
	harness.agents.draftCommands = async (projectId) => [{ name: `x:${projectId}`, description: "", source: "skill" }];
	assert.deepEqual(await coordinator.draftCommands("project-1"), [{ name: "x:project-1", description: "", source: "skill" }]);

	// 网关抛错 → 吞掉返回 null（预览是提示增强，绝不能把错误抛给 IPC 层）
	harness.agents.draftCommands = async () => {
		throw new Error("boom");
	};
	assert.equal(await coordinator.draftCommands("project-1"), null);
});

test("pool: 指纹不匹配即废弃（onExpire 回收旧进程）并返回 null", () => {
	const expired = [];
	const pool = new StandbyAgentPool({ ttlMs: 1000, onExpire: (id) => expired.push(id) });
	pool.put({ projectId: "p1", fingerprint: "fp-a", agentId: "agent-a" });
	const entry = pool.take("p1", "fp-b");
	assert.equal(entry, null);
	assert.equal(pool.has("p1"), false);
	assert.deepEqual(expired, ["agent-a"]);
	pool.dispose();
});

test("pool: 项目不匹配同样丢弃（单槽池，旧项目条目服务不了本次认领）并返回 null", () => {
	const expired = [];
	const pool = new StandbyAgentPool({ ttlMs: 1000, onExpire: (id) => expired.push(id) });
	pool.put({ projectId: "p1", fingerprint: "fp-a", agentId: "agent-a" });
	assert.equal(pool.take("p2", "fp-a"), null);
	assert.equal(pool.has("p1"), false);
	assert.deepEqual(expired, ["agent-a"]);
	pool.dispose();
});

test("pool: put 顶替旧条目时立即回收旧进程", () => {
	const expired = [];
	const pool = new StandbyAgentPool({ ttlMs: 1000, onExpire: (id) => expired.push(id) });
	pool.put({ projectId: "p1", fingerprint: "fp-a", agentId: "agent-a" });
	pool.put({ projectId: "p1", fingerprint: "fp-a", agentId: "agent-b" });
	assert.deepEqual(expired, ["agent-a"]);
	assert.equal(pool.status()?.agentId, "agent-b");
	pool.dispose();
});

test("pool: TTL 到期自动回收；clear/dispose 后不再触发", async () => {
	const expired = [];
	const pool = new StandbyAgentPool({ ttlMs: 20, onExpire: (id) => expired.push(id) });
	pool.put({ projectId: "p1", fingerprint: "fp-a", agentId: "agent-a" });
	await sleep(60);
	assert.deepEqual(expired, ["agent-a"]);
	assert.equal(pool.has("p1"), false);

	pool.put({ projectId: "p1", fingerprint: "fp-a", agentId: "agent-b" });
	pool.clear();
	await sleep(50);
	assert.deepEqual(expired, ["agent-a"]);

	pool.put({ projectId: "p1", fingerprint: "fp-a", agentId: "agent-c" });
	pool.dispose();
	await sleep(50);
	assert.deepEqual(expired, ["agent-a"]);
});

// ── computeStandbyFingerprint：稳定性与敏感性 ─────────────────────

function fingerprintInput(overrides = {}) {
	return {
		projectPath: "C:/project",
		trustMarker: "prompt-free",
		piCliPath: undefined,
		offline: false,
		noExtensions: false,
		noSkills: false,
		piProxyEnabled: false,
		piProxyUrl: "",
		piProxyBypass: "",
		disabledExtensions: [],
		disabledSkills: [],
		disabledPrompts: [],
		extensionRoots: ["C:/ext/a", "C:/ext/b"],
		wsl: undefined,
		bridgeAvailable: true,
		bridgeUrl: "54321",
		autoSessionTitle: true,
		...overrides,
	};
}

test("fingerprint: 相同输入稳定同值，数组顺序不敏感但集合敏感", () => {
	const a = computeStandbyFingerprint(fingerprintInput());
	assert.equal(a, computeStandbyFingerprint(fingerprintInput()));
	// 顺序不敏感：同样的集合、不同书写顺序 → 同指纹。
	const reordered = computeStandbyFingerprint(fingerprintInput({ extensionRoots: ["C:/ext/b", "C:/ext/a"], disabledExtensions: ["y", "x"] }));
	const canonical = computeStandbyFingerprint(fingerprintInput({ disabledExtensions: ["x", "y"] }));
	assert.equal(reordered, canonical);
	// 集合敏感：少一个元素必须变指纹。
	assert.notEqual(canonical, computeStandbyFingerprint(fingerprintInput({ disabledExtensions: ["x"] })));
	assert.notEqual(a, canonical);
});

test("fingerprint: 每个 spawn 输入字段翻转都改变指纹", () => {
	const base = computeStandbyFingerprint(fingerprintInput());
	const variants = [
		fingerprintInput({ projectPath: "D:/other" }),
		fingerprintInput({ offline: true }),
		fingerprintInput({ noExtensions: true }),
		fingerprintInput({ noSkills: true }),
		fingerprintInput({ piProxyEnabled: true }),
		fingerprintInput({ piProxyUrl: "http://127.0.0.1:7890" }),
		fingerprintInput({ piProxyBypass: "localhost" }),
		fingerprintInput({ piCliPath: "C:/pi/bin/pi.cmd" }),
		fingerprintInput({ disabledSkills: ["s1"] }),
		fingerprintInput({ disabledPrompts: ["p1"] }),
		fingerprintInput({ extensionRoots: ["C:/ext/a"] }),
		fingerprintInput({ wsl: { distro: "Ubuntu", user: "root", projectPath: "/home/x" } }),
		fingerprintInput({ bridgeAvailable: false }),
		fingerprintInput({ bridgeUrl: "54322" }),
		fingerprintInput({ autoSessionTitle: false }),
	];
	for (const [index, variant] of variants.entries()) {
		assert.notEqual(computeStandbyFingerprint(variant), base, `variant #${index} must change the fingerprint`);
	}
});

// ── Coordinator 激活链路：standby 认领 ────────────────────────────

function catalogEntry(overrides = {}) {
	return {
		id: "session-1",
		projectId: "project-1",
		title: "Session 1",
		source: "pi",
		environment: "native",
		status: "draft",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

/** 极简 harness：只覆盖 activate 认领路径需要的方法面。 */
function createClaimHarness(options = {}) {
	const entry = catalogEntry(options.entry);
	const calls = { create: 0, claim: 0, claimInputs: [], ensureStandby: [], stop: [], attach: [], publish: 0 };
	const catalog = {
		get: (sessionId) => (sessionId === entry.id ? { ...entry } : undefined),
		getRecord: (sessionId) => (sessionId === entry.id ? { ...entry, preview: "", messageCount: 0 } : undefined),
		update: async (_sessionId, patch) => {
			Object.assign(entry, patch);
			return { ...entry };
		},
		attachRuntime: async (input) => {
			calls.attach.push(input);
			entry.filePath = input.filePath;
			entry.status = input.filePath ? "active" : entry.status;
		},
	};
	const claimedTab = {
		id: "agent-standby",
		projectId: "project-1",
		cwd: "C:/project",
		title: "Standby",
		status: "idle",
		sessionId: "pi-pooled",
		sessionPath: "C:/sessions/pooled.jsonl",
		standby: true,
		createdAt: 1,
	};
	// 与真实 AgentManager 一致：claim/create 成功的 tab 必须能通过 list() 查到，
	// 否则 Coordinator.getAgentId 的活性校验会把新绑定当死绑定解绑。
	const tabs = [];
	const agents = {
		backend: "pi",
		list: () => tabs,
		getMessages: () => [],
		create: async (input) => {
			calls.create += 1;
			const tab = {
				id: "agent-created",
				projectId: input.projectId,
				cwd: "C:/project",
				title: "Session 1",
				status: "idle",
				sessionId: "pi-created",
				sessionPath: input.sessionPath ?? "C:/sessions/created.jsonl",
				createdAt: 2,
			};
			tabs.push(tab);
			return tab;
		},
		claimStandbyAgent: async (input) => {
			calls.claim += 1;
			calls.claimInputs.push(input);
			if (options.claimError) throw new Error(options.claimError);
			const result = options.claimResult === null ? null : (options.claimResult ?? claimedTab);
			if (result) tabs.push(result);
			return result;
		},
		ensureStandbyAgent: (projectId) => {
			calls.ensureStandby.push(projectId);
		},
		stop: async (agentId) => {
			calls.stop.push(agentId);
		},
		setModel: async () => {
			if (options.modelError) throw new Error(options.modelError);
		},
		setThinking: async () => undefined,
		getRuntimeModelThinkingState: async () => undefined,
		publishRuntimeState: async () => {
			calls.publish += 1;
		},
		sendUIResponse: async () => undefined,
		notifyAskPending: () => undefined,
	};
	const sender = async () => ({ accepted: true });
	return { entry, calls, catalog, agents, sender };
}

test("activation claims a standby runtime for a fresh draft instead of spawning", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createClaimHarness();
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);

	const result = await coordinator.activateRuntime("session-1");
	assert.equal(result.ok, true);
	assert.equal(harness.calls.claim, 1);
	assert.equal(harness.calls.claimInputs.length, 1);
	assert.equal(harness.calls.claimInputs[0].projectId, "project-1");
	assert.equal(harness.calls.claimInputs[0].sessionId, "session-1");
	assert.equal(harness.calls.claimInputs[0].noSession, undefined);
	assert.equal(harness.calls.create, 0, "命中 standby 后绝不能再 spawn");
	assert.equal(coordinator.getAgentId("session-1"), "agent-standby");
	// attach 回写的是池化进程预分配的会话文件，不是另造路径（沙箱跨 realm 对象逐字段断言）。
	assert.equal(harness.calls.attach.length, 1);
	assert.equal(harness.calls.attach[0].sessionId, "session-1");
	assert.equal(harness.calls.attach[0].filePath, "C:/sessions/pooled.jsonl");
	assert.equal(harness.calls.attach[0].piSessionId, "pi-pooled");
	// 补热：认领消耗后立刻为下一个新会话补一个 standby。
	assert.deepEqual(harness.calls.ensureStandby, ["project-1"]);
});

test("activation falls back to create when the pool misses", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createClaimHarness({ claimResult: null });
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);

	const result = await coordinator.activateRuntime("session-1");
	assert.equal(result.ok, true);
	assert.equal(harness.calls.claim, 1);
	assert.equal(harness.calls.create, 1);
	assert.equal(coordinator.getAgentId("session-1"), "agent-created");
	assert.deepEqual(harness.calls.ensureStandby, ["project-1"]);
});

test("activation falls back to create when claim throws", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createClaimHarness({ claimError: "pool exploded" });
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);

	const result = await coordinator.activateRuntime("session-1");
	assert.equal(result.ok, true);
	assert.equal(harness.calls.claim, 1);
	assert.equal(harness.calls.create, 1);
});

test("activation never claims standby for a historical session with a file", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createClaimHarness({ entry: { filePath: "C:/sessions/history.jsonl", status: "active" } });
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);

	const result = await coordinator.activateRuntime("session-1");
	assert.equal(result.ok, true);
	assert.equal(harness.calls.claim, 0, "历史会话必须 --session 恢复，不能认领池化进程");
	assert.equal(harness.calls.create, 1);
});

test("activation never claims standby for a dsh session", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createClaimHarness({ entry: { backend: "dsh" } });
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);

	const result = await coordinator.activateRuntime("session-1");
	assert.equal(result.ok, true);
	assert.equal(harness.calls.claim, 0);
	assert.equal(harness.calls.create, 1);
	assert.deepEqual(harness.calls.ensureStandby, [], "dsh 激活不补 pi standby");
});

test("activation passes noSession through to claim so the gateway can decline", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const harness = createClaimHarness({ entry: { noSession: true }, claimResult: null });
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);

	const result = await coordinator.activateRuntime("session-1");
	assert.equal(result.ok, true);
	assert.equal(harness.calls.claimInputs[0]?.noSession, true);
	assert.equal(harness.calls.create, 1);
});

test("a claimed standby is stopped when preference application fails", async () => {
	const { SessionRuntimeCoordinator } = loadCoordinator();
	// catalog 带模型偏好 → applyPreferences 必走 setModel → 失败进入清理路径。
	const harness = createClaimHarness({ entry: { model: { provider: "p", modelId: "m" } }, modelError: "model exploded" });
	const coordinator = new SessionRuntimeCoordinator(harness.catalog, harness.agents, harness.sender);

	const result = await coordinator.activateRuntime("session-1");
	assert.equal(result.ok, false);
	assert.deepEqual(harness.calls.stop, ["agent-standby"], "认领来的进程归本次激活所有，失败必须停掉防泄漏");
	assert.equal(harness.calls.create, 0);
});
