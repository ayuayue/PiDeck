import assert from "node:assert/strict";
import * as fsPromises from "node:fs/promises";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";
import { deferred } from "./helpers/sessionRunControlHarness.mjs";

const AGENT_ID = "history-owner";
const snapshotResponse = () => ({ success: true, data: { messages: [{ role: "user", content: [{ type: "text", text: "snapshot history" }] }] } });

/** 暂停真实 loadMessages 的读盘步骤；不启动 pi，也不读取用户会话。 */
function harness({ waitAt } = {}) {
	const entered = deferred();
	const release = deferred();
	const effects = [];
	const pause = async (step, value) => {
		if (waitAt === step) {
			entered.resolve();
			await release.promise;
		}
		return value;
	};
	const { AgentManager } = loadTsCommonJs("src/main/pi/AgentManager.ts", {
		stubs: { "node:fs/promises": { ...fsPromises, stat: () => pause("stat", { mtimeMs: 1, size: 64 }) } },
	});
	const process = { client: { request: async () => ({ success: true, data: {} }) } };
	const runtime = {
		tab: { id: AGENT_ID, projectId: "project-a", cwd: "C:/project", title: "Source", status: "idle", sessionPath: "C:/project/session.jsonl", deckSessionId: "session-a", runtimeGeneration: 1, createdAt: 1 },
		process,
	};
	const manager = new AgentManager(
		() => ({ id: "project-a", name: "Project", path: "C:/project" }),
		() => null,
		{ get: () => ({}) },
		{},
	);
	manager.agents.set(AGENT_ID, runtime);
	const cachedMessages = [{ id: "cached", agentId: AGENT_ID, role: "user", text: "current history", timestamp: 1 }];
	manager.messages.set(AGENT_ID, cachedMessages);
	manager.messageHeadOffsetByAgent.set(AGENT_ID, 7);
	manager.sessionFileVersionByAgent.set(AGENT_ID, "current-version");
	manager.abortedDuringAsk.add(AGENT_ID);
	manager.readRecentMessagesFromSessionFile = () => pause("messages", snapshotResponse());
	manager.sessionHistoryReader.getRecentActiveEntryIds = () => pause("entryIds", ["u1"]);
	manager.sessionHistoryReader.getActiveEntryCount = () => pause("entryCount", 1);
	manager.scanCompactions = () => pause("archives", { compactions: [{ id: "compact-1", summary: "summary", firstKeptEntryId: "u1", tokensBefore: 12 }] });
	manager.messageEmit.setWindowStart = () => effects.push("window");
	manager.rebindInFlightMessages = () => effects.push("rebind");
	manager.refreshAutoTitle = () => effects.push("title");
	manager.scheduleMessageEmit = () => effects.push("messages");
	manager.emitState = () => effects.push("state");
	return { manager, runtime, process, entered, release, effects, cachedMessages };
}

/** 立即观察拒绝，避免暂停点之后更换运行时产生未处理 rejection。 */
function outcome(promise) {
	return promise.then(
		(value) => ({ value }),
		(error) => ({ error }),
	);
}

for (const step of ["messages", "entryIds", "entryCount", "archives", "stat"]) {
	test(`history waiting for ${step} cannot publish after its runtime is removed`, async () => {
		const h = harness({ waitAt: step });
		const pending = outcome(h.manager.loadMessages(AGENT_ID));
		await h.entered.promise;
		h.manager.agents.delete(AGENT_ID);
		h.release.resolve();
		const result = await pending;
		assert.match(result.error?.message ?? "", /runtime changed/);
		assert.equal(h.manager.messages.get(AGENT_ID), h.cachedMessages);
		assert.equal(h.manager.messageHeadOffsetByAgent.get(AGENT_ID), 7);
		assert.equal(h.manager.sessionFileVersionByAgent.get(AGENT_ID), "current-version");
		assert.equal(h.manager.abortedDuringAsk.has(AGENT_ID), true);
		assert.equal(h.runtime.tab.compactionCount, undefined);
		assert.deepEqual(h.effects, []);
	});
}

for (const binding of ["process", "deckSessionId", "runtimeGeneration", "sessionPath"]) {
	test(`changing ${binding} before history finishes cannot overwrite the replacement snapshot`, async () => {
		const h = harness({ waitAt: "messages" });
		const pending = outcome(h.manager.loadMessages(AGENT_ID));
		await h.entered.promise;
		if (binding === "process") h.runtime.process = { client: { request: async () => ({ success: true, data: {} }) } };
		else if (binding === "runtimeGeneration") h.runtime.tab.runtimeGeneration = 2;
		else h.runtime.tab[binding] = "replacement";
		h.release.resolve();
		const result = await pending;
		assert.match(result.error?.message ?? "", /runtime changed/);
		assert.equal(h.manager.messages.get(AGENT_ID), h.cachedMessages);
		assert.deepEqual(h.effects, []);
	});
}

test("history load started before the first bind publishes after the runtime is bound", async () => {
	const h = harness({ waitAt: "messages" });
	// create() 的后台历史加载先于协调器 bind 启动：捕获到的 runtimeGeneration 是 undefined。
	h.runtime.tab.runtimeGeneration = undefined;
	const pending = outcome(h.manager.loadMessages(AGENT_ID));
	await h.entered.promise;
	// 首次 bind 写入具体代际：这是同一运行时的绑定动作，不是「换了运行时」。
	h.runtime.tab.runtimeGeneration = 1;
	h.release.resolve();
	const result = await pending;
	assert.equal(result.error, undefined);
	assert.equal(result.value.at(-1)?.text, "snapshot history");
	assert.equal(h.manager.messages.get(AGENT_ID), result.value);
});

test("history load started before the first bind cancels when the binding changes again", async () => {
	const h = harness({ waitAt: "messages" });
	h.runtime.tab.runtimeGeneration = undefined;
	// 第二个暂停点：首个 assert 已经观察到首次绑定，之后的换绑必须取消。
	const entryIdsEntered = deferred();
	const entryIdsRelease = deferred();
	h.manager.sessionHistoryReader.getRecentActiveEntryIds = async () => {
		entryIdsEntered.resolve();
		await entryIdsRelease.promise;
		return ["u1"];
	};
	const pending = outcome(h.manager.loadMessages(AGENT_ID));
	await h.entered.promise;
	h.runtime.tab.runtimeGeneration = 1;
	h.release.resolve();
	// 修复前首个 assert 会先抛取消：与 pending 竞争，避免测试挂死而不是变红。
	await Promise.race([entryIdsEntered.promise, pending]);
	h.runtime.tab.runtimeGeneration = 2;
	entryIdsRelease.resolve();
	const result = await pending;
	assert.match(result.error?.message ?? "", /runtime changed/);
	assert.equal(h.manager.messages.get(AGENT_ID), h.cachedMessages);
});

test("replacing the runtime object during history loading leaves the new runtime unchanged", async () => {
	const h = harness({ waitAt: "archives" });
	const pending = outcome(h.manager.loadMessages(AGENT_ID));
	await h.entered.promise;
	const replacement = { ...h.runtime, tab: { ...h.runtime.tab, title: "Replacement", compactionCount: 5 } };
	h.manager.agents.set(AGENT_ID, replacement);
	h.release.resolve();
	const result = await pending;
	assert.match(result.error?.message ?? "", /runtime changed/);
	assert.equal(replacement.tab.title, "Replacement");
	assert.equal(replacement.tab.compactionCount, 5);
	assert.equal(h.manager.messages.get(AGENT_ID), h.cachedMessages);
	assert.deepEqual(h.effects, []);
});

test("an uninterrupted history load publishes messages and pagination from the same snapshot", async () => {
	const h = harness();
	const messages = await h.manager.loadMessages(AGENT_ID);
	assert.equal(messages.at(-1)?.text, "snapshot history");
	assert.equal(messages.at(-1)?.meta?.entryId, "u1");
	assert.equal(h.manager.messages.get(AGENT_ID), messages);
	assert.equal(h.manager.messageHeadOffsetByAgent.get(AGENT_ID), 0);
	assert.equal(h.manager.sessionFileVersionByAgent.get(AGENT_ID), "1:64");
	assert.equal(h.manager.abortedDuringAsk.has(AGENT_ID), false);
	assert.equal(h.runtime.tab.compactionCount, 1);
	assert.ok(h.effects.includes("messages"));
});
