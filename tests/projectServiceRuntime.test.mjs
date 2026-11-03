import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { createProjectServiceRuntime } = loadTsCommonJs("src/renderer/src/services/projectServiceRuntime.ts");

const project = { id: "p2", name: "p2", lastOpenedAt: 0, locator: { kind: "ssh", hostId: "h1", remotePath: "/srv/p2" } };
const FULL_HELPER = ["fs.watch", "fs.searchContent", "git.status", "git.compare"];
const UPLOAD_HELPER = [...FULL_HELPER, "fs.uploadPrepare", "fs.uploadCommit", "fs.uploadAbort"];
const plain = (value) => JSON.parse(JSON.stringify(value));
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness(overrides = {}) {
	const stateHandlers = [];
	const factsHandlers = [];
	const unsubscribed = { state: 0, facts: 0 };
	let trust = { ok: true, value: { entries: [{ hostId: "h1", hostLabel: "h1", canonicalRoot: "/srv/p2", decision: "approve", decidedAt: "2026-10-31T00:00:00Z", status: "active" }] } };
	let root = { ok: true, value: { status: "ok", helperCapabilities: FULL_HELPER } };
	let states = { h1: "ready" };
	let list = async () => ({ ok: true, status: "ready", hosts: [], states });
	const api = {
		remoteHosts: {
			list: () => list(),
			rootStatus: async () => root,
			onStateChange(handler) {
				stateHandlers.push(handler);
				return () => {
					unsubscribed.state += 1;
				};
			},
			onProjectFactsChanged(projectId, handler) {
				factsHandlers.push({ projectId, handler });
				return () => {
					unsubscribed.facts += 1;
				};
			},
		},
		remoteTrust: { list: async () => trust },
		files: {},
		git: {},
	};
	return {
		api,
		stateHandlers,
		factsHandlers,
		unsubscribed,
		emitState: (change) => {
			for (const handler of stateHandlers) handler(change);
		},
		emitFacts: (change) => {
			for (const entry of factsHandlers) if (entry.projectId === change.projectId) entry.handler(change);
		},
		setTrust: (value) => {
			trust = value;
		},
		setRoot: (value) => {
			root = value;
		},
		setStates: (value) => {
			states = value;
		},
		setList: (value) => {
			list = value;
		},
		...overrides,
	};
}

test("runtime：start 订阅 host 与项目事实，并按只读事实给出能力", async () => {
	const h = harness();
	const runtime = createProjectServiceRuntime(project, h.api);
	const before = runtime.getSnapshot();
	assert.equal(before.facts.hostState, "disconnected");
	assert.equal(before.capabilities.files.read, false);
	const stop = runtime.start();
	assert.equal(h.stateHandlers.length, 1);
	assert.equal(h.factsHandlers.length, 1);
	await runtime.refresh();
	await flush();
	const snapshot = runtime.getSnapshot();
	assert.equal(snapshot.projectId, "p2");
	assert.equal(snapshot.facts.hostState, "ready");
	assert.equal(snapshot.facts.trust, "approved");
	assert.equal(snapshot.capabilities.files.read, true);
	assert.equal(snapshot.capabilities.files.write, true);
	assert.equal(snapshot.capabilities.files.contentSearch, true);
	assert.equal(snapshot.capabilities.git.read, true);
	assert.equal(snapshot.capabilities.git.write, false, "远端 Git 写仍未实现");
	assert.equal(snapshot.isCurrent(), true);
	assert.match(snapshot.generation, /^ssh:h1:/);
	stop();
	assert.equal(h.unsubscribed.state, 1);
	assert.equal(h.unsubscribed.facts, 1);
});

test("runtime：host 状态变化换代并收回写能力，旧 services 立即 stale", async () => {
	const h = harness();
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	await runtime.refresh();
	await flush();
	const previous = runtime.getSnapshot();
	assert.equal(previous.capabilities.files.write, true);
	h.setStates({ h1: "degraded" });
	h.emitState({ hostId: "h1", state: "degraded" });
	await flush();
	await runtime.refresh();
	const next = runtime.getSnapshot();
	assert.notEqual(next.generation, previous.generation);
	assert.equal(previous.isCurrent(), false);
	assert.equal(next.facts.hostState, "degraded");
	assert.equal(next.capabilities.files.read, true);
	assert.equal(next.capabilities.files.write, false);
	await assert.rejects(
		() => previous.files.listDirectory({ projectId: "p2", relativePath: "" }),
		(error) => error?.code === "PROJECT_SERVICE_GENERATION_STALE",
	);
	runtime.dispose();
});

test("runtime：首个事实事件只认领主进程连接基线，不打断同一连接上的在途任务", async () => {
	const h = harness();
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	await runtime.refresh();
	await flush();
	let notifications = 0;
	runtime.subscribe(() => {
		notifications += 1;
	});
	const previous = runtime.getSnapshot();
	h.emitFacts({ projectId: "other", generation: "other-generation", scopes: [] });
	h.emitState({ hostId: "h9", state: "offline" });
	assert.equal(runtime.getSnapshot(), previous);
	h.emitFacts({ projectId: "p2", generation: "main-generation-1", scopes: [{ kind: "dir", path: "" }] });
	assert.equal(runtime.getSnapshot(), previous, "首见 connection id 是同代基线，不能重建 services");
	assert.equal(notifications, 0);
	runtime.dispose();
});

test("runtime：已知连接基线后出现新的主进程 generation 才换代并围栏旧 services", async () => {
	const h = harness();
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	await runtime.refresh();
	await flush();
	let notifications = 0;
	runtime.subscribe(() => {
		notifications += 1;
	});
	h.emitFacts({ projectId: "p2", generation: "main-generation-1", scopes: [] });
	const baseline = runtime.getSnapshot();
	assert.match(baseline.generation, /:local$/);
	h.emitFacts({ projectId: "p2", generation: "main-generation-2", scopes: [{ kind: "dir", path: "" }] });
	const next = runtime.getSnapshot();
	assert.equal(next.generation, "ssh:h1:1:main-generation-2");
	assert.equal(baseline.isCurrent(), false);
	assert.equal(notifications, 1);
	assert.equal(next.facts.hostState, "ready");
	runtime.dispose();
});

test("runtime：状态事件后迟到的旧 generation 不得回退并复活旧代 services", async () => {
	const h = harness();
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	await runtime.refresh();
	await flush();
	h.emitFacts({ projectId: "p2", generation: "connection-1", scopes: [] });
	const baseline = runtime.getSnapshot();
	assert.match(baseline.generation, /:local$/);
	h.setStates({ h1: "degraded" });
	h.emitState({ hostId: "h1", state: "degraded" });
	await flush();
	await runtime.refresh();
	const degraded = runtime.getSnapshot();
	assert.equal(baseline.isCurrent(), false);
	assert.notEqual(degraded.generation, baseline.generation);
	// 旧连接的 facts 事件可能晚于状态事件到达：必须被拒绝，不能把 generation 设回 connection-1。
	h.emitFacts({ projectId: "p2", generation: "connection-1", scopes: [] });
	assert.equal(runtime.getSnapshot(), degraded);
	assert.equal(baseline.isCurrent(), false);
	runtime.dispose();
});

test("runtime：在途 refresh 不得用旧 ready 事实覆盖刚到的 offline 状态", async () => {
	const h = harness();
	const resolvers = [];
	h.setList(
		() =>
			new Promise((resolve) => {
				resolvers.push(resolve);
			}),
	);
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	const pending = runtime.refresh();
	assert.equal(resolvers.length, 2, "start 与手动 refresh 各有一个在途 list");
	h.setStates({ h1: "offline" });
	h.emitState({ hostId: "h1", state: "offline" });
	// 手动 refresh 的旧结果（ready）迟到：即使采集已返回，也不能覆盖 offline。
	resolvers[1]({ ok: true, status: "ready", hosts: [], states: { h1: "ready" } });
	await pending;
	await flush();
	const snapshot = runtime.getSnapshot();
	assert.equal(snapshot.facts.hostState, "offline");
	assert.equal(snapshot.capabilities.files.read, false);
	assert.equal(snapshot.capabilities.files.write, false);
	resolvers[2]?.({ ok: true, status: "ready", hosts: [], states: { h1: "offline" } });
	await flush();
	runtime.dispose();
});

test("runtime：同项目两个 runtime 共享一份 preload 订阅，最后一个释放才退订", async () => {
	const h = harness();
	const first = createProjectServiceRuntime(project, h.api);
	const second = createProjectServiceRuntime(project, h.api);
	first.start();
	second.start();
	assert.equal(h.stateHandlers.length, 1, "preload 只订阅一次");
	assert.equal(h.factsHandlers.length, 1, "项目事实只订阅一次");
	first.dispose();
	assert.equal(h.unsubscribed.state, 0, "还有一个消费者，不能退订");
	assert.equal(h.unsubscribed.facts, 0);
	h.setStates({ h1: "degraded" });
	h.emitState({ hostId: "h1", state: "degraded" });
	await flush();
	assert.equal(second.getSnapshot().facts.hostState, "degraded", "剩余消费者仍收到事件");
	second.dispose();
	assert.equal(h.unsubscribed.state, 1, "最后一个消费者释放才真正退订");
	assert.equal(h.unsubscribed.facts, 1);
});

test("runtime：dispose 退订并丢弃在途采集；再次 start 可重新订阅（StrictMode 复用）", async () => {
	const h = harness();
	let release;
	h.setList(
		() =>
			new Promise((resolve) => {
				release = resolve;
			}),
	);
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	const pending = runtime.refresh();
	let notifications = 0;
	runtime.subscribe(() => {
		notifications += 1;
	});
	runtime.dispose();
	assert.equal(h.unsubscribed.state, 1);
	assert.equal(h.unsubscribed.facts, 1);
	release({ ok: true, status: "ready", hosts: [], states: { h1: "ready" } });
	await pending;
	assert.equal(notifications, 0);
	assert.equal(runtime.getSnapshot().facts.hostState, "disconnected");
	// StrictMode：dispose 后同一 runtime 再 start 必须重新订阅，而不是永久死亡。
	h.setList(async () => ({ ok: true, status: "ready", hosts: [], states: { h1: "ready" } }));
	runtime.start();
	assert.equal(h.stateHandlers.length, 2);
	await runtime.refresh();
	await flush();
	assert.equal(runtime.getSnapshot().facts.hostState, "ready");
	runtime.dispose();
});

test("runtime：trust 查询失败 => Git 全关、文件不受影响；root needs-attention 关读面", async () => {
	const h = harness();
	h.setTrust({ ok: false, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" });
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	await runtime.refresh();
	await flush();
	let snapshot = runtime.getSnapshot();
	assert.equal(snapshot.facts.trust, "unknown");
	assert.equal(snapshot.capabilities.files.read, true);
	assert.equal(snapshot.capabilities.files.write, true);
	assert.equal(snapshot.capabilities.git.read, false);
	assert.equal(snapshot.capabilities.blocked["git.read"], "PROJECT_SERVICE_CAPABILITY_TRUST_UNKNOWN");
	runtime.dispose();

	const rootHarness = harness();
	rootHarness.setRoot({ ok: true, value: { status: "needs-attention", code: "REMOTE_PROJECT_ROOT_MOVED", helperCapabilities: FULL_HELPER } });
	const blocked = createProjectServiceRuntime(project, rootHarness.api);
	blocked.start();
	await blocked.refresh();
	await flush();
	snapshot = blocked.getSnapshot();
	assert.equal(snapshot.facts.rootStatus, "needs-attention");
	assert.equal(snapshot.capabilities.files.read, false);
	assert.equal(snapshot.capabilities.files.write, false);
	assert.equal(snapshot.capabilities.blocked["files.read"], "PROJECT_SERVICE_CAPABILITY_ROOT_NEEDS_ATTENTION");
	blocked.dispose();
});

test("runtime：rootStatus 读取失败不冒充 needs-attention，也不阻断读面", async () => {
	const h = harness();
	h.setRoot({ ok: false, code: "REMOTE_FEATURE_DISABLED", outcome: "rejected" });
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	await runtime.refresh();
	await flush();
	const snapshot = runtime.getSnapshot();
	assert.equal(snapshot.facts.rootStatus, "unknown");
	assert.equal(snapshot.capabilities.files.read, true);
	assert.equal(snapshot.capabilities.files.contentSearch, false, "helper 能力未知 => 内容搜索不可用");
	runtime.dispose();
});

test("runtime：services.refresh() 重新采集 trust（没有推送事件）并更新能力", async () => {
	const h = harness();
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	await runtime.refresh();
	await flush();
	const before = runtime.getSnapshot();
	assert.equal(before.capabilities.git.read, true);
	h.setTrust({ ok: true, value: { entries: [{ hostId: "h1", hostLabel: "h1", canonicalRoot: "/srv/p2", decision: "deny", decidedAt: "2026-10-31T00:00:00Z", status: "active" }] } });
	await before.refresh();
	const after = runtime.getSnapshot();
	assert.equal(after.facts.trust, "denied");
	assert.equal(after.capabilities.files.write, true, "文件 API 不读 trust");
	assert.equal(after.capabilities.git.read, false);
	assert.equal(after.generation, before.generation, "只读事实重采集不换连接代");
	runtime.dispose();
});

test("runtime：首个 helper 建立后补采事实才能开放上传", async () => {
	const h = harness();
	h.setRoot({ ok: true, value: { status: "ok" } });
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	await runtime.refresh();
	await flush();
	const before = runtime.getSnapshot();
	assert.equal(before.facts.hostState, "ready");
	assert.equal(before.capabilities.files.upload, false, "a side-effect-free root probe cannot see a helper that does not exist yet");

	h.setRoot({ ok: true, value: { status: "ok", helperCapabilities: UPLOAD_HELPER } });
	await before.refresh();
	const after = runtime.getSnapshot();
	assert.equal(after.generation, before.generation, "refilling facts for the same connection is not a generation change");
	assert.equal(after.capabilities.files.upload, true);
	runtime.dispose();
});

test("runtime：事实订阅装配失败时收回已建立的 state 订阅，只读采集仍可用", async () => {
	const h = harness();
	const originalState = h.api.remoteHosts.onStateChange;
	let stateStops = 0;
	h.api.remoteHosts.onStateChange = (handler) => {
		const stop = originalState(handler);
		return () => {
			stateStops += 1;
			stop();
		};
	};
	h.api.remoteHosts.onProjectFactsChanged = () => {
		throw new Error("facts subscription unwired");
	};
	const runtime = createProjectServiceRuntime(project, h.api);
	runtime.start();
	await runtime.refresh();
	await flush();
	assert.equal(stateStops, 1, "已建立的 state 订阅必须被收回");
	assert.equal(runtime.getSnapshot().facts.hostState, "ready");
	runtime.dispose();
});

test("runtime：本机项目无订阅、无事实采集，能力来自本机 provider", () => {
	const local = { id: "p1", name: "p1", lastOpenedAt: 0, path: "C:/p1", environment: "windows" };
	const h = harness();
	const runtime = createProjectServiceRuntime(local, h.api);
	runtime.start();
	const snapshot = runtime.getSnapshot();
	assert.equal(h.stateHandlers.length, 0);
	assert.equal(snapshot.kind, "local");
	assert.equal(snapshot.capabilities.files.read, true);
	assert.equal(snapshot.capabilities.git.write, true);
	runtime.dispose();
	assert.deepEqual(plain(snapshot.facts), { projectId: "p1", locationKind: "local", hostState: "local", environment: "windows", rootStatus: "ok", trust: "none", generation: "local" });
});
