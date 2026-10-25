import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回归（issue #381 后续）：DSH 后端的 fork/clone 必须像 pi 一样生成**新的会话条目**
 * （侧栏两条：原会话 + 带 (fork) 后缀的副本），不能原地把当前 SessionRecord 换绑到
 * fork 出来的 host 会话。现场（2026-10-20）：DSH fork 后 host 侧确实新建了会话，但
 * catalog 仍只有一条记录，用户看到「fork 没生效，还是只有一个会话」；旧 host 会话
 * 随后被外部同步重新导入，表现为标题不同的重复会话。
 *
 * 这里用真实 SessionCatalog + 真实 SessionRuntimeCoordinator（replacement 绑定机）
 * 驱动 createDshSessionFork，断言用户可见结果而不是实现细节。
 */

const nodeRequire = createRequire(import.meta.url);

function loadCatalog() {
	return loadTsCommonJs("src/main/sessions/SessionCatalog.ts", {
		stubs: {
			"node:fs/promises": nodeRequire("node:fs/promises"),
			"node:fs": { existsSync: () => true },
			"../logging/sharedLogger": { getAppLogger: () => null },
		},
	});
}

function loadCoordinator() {
	const sandbox = createTsSandbox({ stubs: { "../../shared/types": {} } });
	const identity = sandbox("src/shared/sessionIdentity.ts");
	const coordinator = sandbox("src/main/sessions/SessionRuntimeCoordinator.ts");
	return coordinator;
}

function loadDshFork() {
	return loadTsCommonJs("src/main/sessions/dshSessionFork.ts");
}

function makeAgents(initialSessionId) {
	const tab = {
		id: "dsh:" + initialSessionId,
		projectId: "project-1",
		cwd: "C:/project",
		title: "Topic",
		status: "idle",
		sessionId: initialSessionId,
		backend: "dsh",
		agentPreset: "standard",
		createdAt: 1,
	};
	const calls = { fork: [], clone: 0, rename: [], setModel: 0, setThinking: 0 };
	const agents = {
		backend: "dsh",
		list: () => [tab],
		forkSession: async (agentId, entryId) => {
			calls.fork.push({ agentId, entryId });
			tab.sessionId = "session-forked";
			return { text: "hello" };
		},
		cloneSession: async () => {
			calls.clone += 1;
			tab.sessionId = "session-cloned";
			return {};
		},
		rename: async (_agentId, name) => {
			calls.rename.push(name);
			tab.title = name;
			return tab;
		},
		getRuntimeModelThinkingState: async () => ({ provider: "magpie", modelId: "group/free", thinkingLevel: "max" }),
		setModel: async () => {
			calls.setModel += 1;
		},
		setThinking: async () => {
			calls.setThinking += 1;
		},
	};
	return { agents, calls, tab };
}

async function createFixture() {
	const { SessionCatalog } = loadCatalog();
	const { SessionRuntimeCoordinator } = loadCoordinator();
	const { createDshSessionFork } = loadDshFork();
	const dir = await mkdtemp(join(tmpdir(), "pideck-dsh-fork-"));
	const catalog = new SessionCatalog(join(dir, "sessions.json"));
	await catalog.load();
	const origin = await catalog.createDraft({
		projectId: "project-1",
		title: "Topic",
		environment: "native",
		backend: "dsh",
		dshSessionId: "session-origin",
		agentPreset: "standard",
		model: { provider: "magpie", modelId: "group/free", modelName: "Free" },
		thinkingLevel: "max",
		titleOrigin: "manual",
	});
	const { agents, calls, tab } = makeAgents("session-origin");
	const coordinator = new SessionRuntimeCoordinator(catalog, agents, async () => ({ accepted: true }));
	coordinator.bind(origin.id, tab.id);
	const events = { detached: 0, attached: 0, restored: 0, renameFailed: 0 };
	const fork = createDshSessionFork({
		catalog,
		agents,
		coordinator,
		forkedSuffix: () => "(fork)",
		onDetached: () => {
			events.detached += 1;
		},
		onAttached: () => {
			events.attached += 1;
		},
		onRestored: () => {
			events.restored += 1;
		},
		onTitleRenameFailed: () => {
			events.renameFailed += 1;
		},
		logger: { warn: () => undefined },
	});
	return {
		dir,
		catalog,
		coordinator,
		fork,
		origin,
		agents,
		calls,
		tab,
		events,
		target: () => ({ sessionId: origin.id, agentId: tab.id, runtimeGeneration: 0 }),
		cleanup: () => rm(dir, { recursive: true, force: true }),
	};
}

function dshEntries(catalog) {
	return catalog.listEntries().filter((entry) => entry.backend === "dsh");
}

test("DSH fork creates a sibling session and moves the runtime binding to it", async () => {
	const fixture = await createFixture();
	try {
		const result = await fixture.fork.fork(fixture.target(), "seq:12");

		assert.equal(result.text, "hello");
		assert.equal(typeof result.targetSessionId, "string");
		assert.notEqual(result.targetSessionId, fixture.origin.id);

		const entries = dshEntries(fixture.catalog);
		assert.equal(entries.length, 2, "fork 后侧栏必须有两条独立会话");
		const origin = fixture.catalog.get(fixture.origin.id);
		assert.equal(origin.title, "Topic", "原会话标题不被改写");
		assert.equal(origin.dshSessionId, "session-origin", "原会话仍绑定 fork 前的 host 会话");

		const forked = fixture.catalog.get(result.targetSessionId);
		assert.equal(forked.title, "Topic (fork)");
		assert.equal(forked.forked, true);
		assert.equal(forked.dshSessionId, "session-forked");
		assert.equal(forked.projectId, "project-1");
		assert.equal(forked.backend, "dsh");
		assert.equal(forked.model.provider, "magpie");
		assert.equal(forked.model.modelId, "group/free");
		assert.equal(forked.thinkingLevel, "max");
		assert.equal(forked.agentPreset, "standard");

		// host 标题是 DSH 的权威名：必须把 (fork) 写回 host，重新 attach 时才不会被覆盖回原名。
		assert.deepEqual(fixture.calls.rename, ["Topic (fork)"]);

		// 运行时绑定跟着 fork 走：当前 agent 就是新会话，原会话解绑。
		assert.equal(fixture.coordinator.getRuntimeBinding(fixture.tab.id).sessionId, forked.id);
		assert.equal(fixture.coordinator.getAgentId(origin.id), undefined);
		assert.equal(fixture.events.detached, 1);
		assert.equal(fixture.events.attached, 1);
	} finally {
		await fixture.cleanup();
	}
});

test("DSH clone also creates a sibling session instead of rebinding in place", async () => {
	const fixture = await createFixture();
	try {
		const result = await fixture.fork.clone(fixture.target());
		const entries = dshEntries(fixture.catalog);
		assert.equal(entries.length, 2);
		const cloned = fixture.catalog.get(result.targetSessionId);
		assert.equal(cloned.title, "Topic (fork)");
		assert.equal(cloned.dshSessionId, "session-cloned");
		assert.equal(fixture.catalog.get(fixture.origin.id).dshSessionId, "session-origin");
		assert.equal(fixture.coordinator.getRuntimeBinding(fixture.tab.id).sessionId, cloned.id);
	} finally {
		await fixture.cleanup();
	}
});

test("DSH fork keeps going when the host rejects the (fork) rename, but reports it", async () => {
	const fixture = await createFixture();
	try {
		// DshAgentManager.rename 在 host 拒绝时不抛错，只返回旧 tab：必须按回传标题判定失败。
		fixture.agents.rename = async () => ({ title: "Topic" });
		const result = await fixture.fork.fork(fixture.target(), "seq:12");
		assert.equal(fixture.catalog.get(result.targetSessionId).title, "Topic (fork)");
		assert.equal(fixture.events.renameFailed, 1);
		assert.equal(fixture.coordinator.getRuntimeBinding(fixture.tab.id).sessionId, result.targetSessionId);
	} finally {
		await fixture.cleanup();
	}
});

test("fork command layer passes the new DSH session id through to the renderer", async () => {
	const { createSessionForkCommands } = loadTsCommonJs("src/main/sessions/sessionForkCommands.ts");
	const notified = [];
	const target = { sessionId: "session-1", agentId: "dsh:session-1", runtimeGeneration: 1 };
	const commands = createSessionForkCommands({
		sessionRuntimeCoordinator: { validateTarget: () => ({ ok: true, value: target }) },
		agentManager: { forkSession: async () => ({}), cloneSession: async () => ({}) },
		replaceAgentSession: async () => ({}),
		isDshAgent: () => true,
		replaceDshAgentSession: async () => ({ text: "anchor text", targetSessionId: "session-forked" }),
		replaceDshCloneSession: async () => ({ targetSessionId: "session-cloned" }),
		logger: { info: () => undefined },
		notifyForkCatalogRefreshed: (sessionId) => notified.push(sessionId),
	});

	const forked = await commands.forkRuntimeSession(target, "seq:12");
	assert.equal(forked.ok, true);
	assert.equal(forked.value.targetSessionId, "session-forked");
	assert.equal(forked.value.text, "anchor text");

	const cloned = await commands.cloneRuntimeSession(target);
	assert.equal(cloned.value.targetSessionId, "session-cloned");

	// 重发/编辑的 fork 化仍不支持 DSH：必须回结构化错误而不是偷偷原地换绑。
	const mutation = await commands.forkRuntimeSession(target, "seq:12", { mutationFork: true });
	assert.equal(mutation.ok, false);
	assert.match(mutation.error.debugDetails, /mutation/i);
	assert.deepEqual(notified, ["session-1", "session-1"]);
});

test("DSH fork failure restores the origin binding and creates no session", async () => {
	const fixture = await createFixture();
	try {
		fixture.agents.forkSession = async () => {
			throw new Error("host fork failed");
		};
		await assert.rejects(() => fixture.fork.fork(fixture.target(), "seq:12"), /host fork failed/);
		assert.equal(dshEntries(fixture.catalog).length, 1);
		assert.equal(fixture.coordinator.getRuntimeBinding(fixture.tab.id).sessionId, fixture.origin.id);
		assert.equal(fixture.events.restored, 1);
	} finally {
		await fixture.cleanup();
	}
});
