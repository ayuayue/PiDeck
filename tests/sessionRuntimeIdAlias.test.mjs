import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildSessionOriginKey } = loadTsCommonJs("src/shared/sessionIdentity.ts");
const { SessionCatalog } = loadTsCommonJs("src/main/sessions/SessionCatalog.ts", { stubs: { "../logging/sharedLogger": { getAppLogger: () => null } } });
const { SessionRuntimeCoordinator } = loadTsCommonJs("src/main/sessions/SessionRuntimeCoordinator.ts");

/**
 * 归并后的存活记录：`old-id` 是被它吸收的历史稳定 ID（启动修复写在 mergedSessionIds 里）。
 * 渲染层/持久化引用可能仍拿 `old-id` 调用运行时入口（#354 复审：归一化必须覆盖整个状态机，
 * 不只是 ensureRuntime）。
 */
function mergedEntry(filePath) {
	const record = {
		id: "legacy-id",
		projectId: "project-1",
		filePath,
		title: "A",
		titleOrigin: "manual",
		titleLocked: true,
		source: "pi",
		environment: "native",
		status: "active",
		createdAt: 10,
		updatedAt: 100,
		mergedSessionIds: ["old-id"],
	};
	return { originKey: buildSessionOriginKey(record), ...record };
}

/** 最小 AgentGateway 夹具：只覆盖激活/发送链路需要的成员。 */
function agentsFixture(path) {
	const tabs = [];
	const calls = { create: 0, send: 0 };
	const agents = {
		list: () => tabs,
		create: async (input) => {
			calls.create++;
			const tab = {
				id: "agent-1",
				projectId: "project-1",
				cwd: "/project",
				title: "A",
				status: "idle",
				createdAt: 1,
				sessionPath: path,
				sessionId: "pi-session",
				sessionEnvironment: "native",
				sessionSource: "pi",
				deckSessionId: input.deckSessionId,
			};
			tabs.push(tab);
			return tab;
		},
		publishRuntimeState: async () => {},
		setModel: async () => {},
		setThinking: async () => {},
		stop: async () => {},
		getMessages: () => [],
	};
	return {
		agents,
		calls,
		send: async () => {
			calls.send++;
			return { accepted: true };
		},
	};
}

async function withAliasCatalog(run) {
	const dir = await mkdtemp(join(tmpdir(), "pideck-354-runtime-alias-"));
	try {
		const filePath = join(dir, "2026-10-07T12-34-56-000Z_abcdef01.jsonl");
		await writeFile(filePath, '{"type":"session"}\n', "utf8");
		const catalogPath = join(dir, "session-catalog.json");
		await writeFile(catalogPath, JSON.stringify({ version: 1, sessions: [mergedEntry(filePath)] }), "utf8");
		const catalog = new SessionCatalog(catalogPath);
		await catalog.load();
		await run({ catalog, filePath });
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

test("activating a merged session ID addresses the canonical runtime instead of a binding-changed failure", async () => {
	await withAliasCatalog(async ({ catalog, filePath }) => {
		const harness = agentsFixture(filePath);
		const coordinator = new SessionRuntimeCoordinator(catalog, harness.agents, harness.send);
		const activated = await coordinator.activateRuntime("old-id");
		assert.equal(activated.ok, true, "ensureRuntime canonicalizes, so the returned runtime state must be built from the canonical ID too");
		assert.equal(activated.value.sessionId, "legacy-id");
		assert.equal(harness.calls.create, 1, "an alias activation must not create a second runtime");
		// 别名与现存 ID 指向同一个 runtime，而不是各自一份绑定。
		const canonicalTarget = coordinator.getTarget("legacy-id");
		assert.equal(coordinator.getTarget("old-id").agentId, canonicalTarget.agentId);
		assert.equal(coordinator.getTarget("old-id").sessionId, "legacy-id");
		assert.equal(coordinator.getAgentId("old-id"), canonicalTarget.agentId);
		assert.equal(coordinator.hasLiveRuntime("old-id"), true);
	});
});

test("sending through a merged session ID uses the canonical dispatch lease and shares request deduplication", async () => {
	await withAliasCatalog(async ({ catalog, filePath }) => {
		const harness = agentsFixture(filePath);
		const coordinator = new SessionRuntimeCoordinator(catalog, harness.agents, harness.send);
		const first = await coordinator.send({ sessionId: "old-id", requestId: "request-1", message: "hello" });
		assert.equal(first.accepted, true, "dispatch must not look for the old ID after ensureRuntime created a canonical binding");
		assert.equal(first.sessionId, "legacy-id");
		const second = await coordinator.send({ sessionId: "legacy-id", requestId: "request-1", message: "hello" });
		assert.equal(second.accepted, true);
		assert.equal(harness.calls.send, 1, "an alias and the canonical ID must share one delivery cache entry");
		assert.equal(harness.calls.create, 1);
	});
});
