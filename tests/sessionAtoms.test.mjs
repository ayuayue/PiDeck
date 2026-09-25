import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import ts from "typescript";
import vm from "node:vm";
import { createStore } from "jotai/vanilla";

const nodeRequire = createRequire(import.meta.url);

function compileModule(filePath, imports = {}) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: {
			module: ts.ModuleKind.CommonJS,
			target: ts.ScriptTarget.ES2022,
			esModuleInterop: true,
		},
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	const localRequire = (specifier) => imports[specifier] ?? nodeRequire(specifier);
	vm.runInNewContext(
		output,
		{
			module,
			exports: module.exports,
			require: localRequire,
			console,
			Date,
			Set,
			Map,
		},
		{ filename: filePath },
	);
	return module.exports;
}

function loadAtoms() {
	const runtimeState = compileModule("src/renderer/src/utils/agentRuntimeState.ts");
	const sessionRecordIdentity = compileModule("src/renderer/src/utils/sessionRecordIdentity.ts");
	const liveTextHandoff = compileModule("src/renderer/src/utils/liveTextHandoff.ts");
	const outlineRevision = compileModule("src/renderer/src/atoms/outlineRevision.ts");
	const outlineProjectionCache = compileModule("src/renderer/src/atoms/outlineProjectionCache.ts");
	const sessions = compileModule("src/renderer/src/atoms/session-atoms.ts", {
		"./recent-session-atoms": compileModule("src/renderer/src/atoms/recent-session-atoms.ts"),
		"../utils/agentRuntimeState": runtimeState,
		"../utils/sessionRecordIdentity": sessionRecordIdentity,
		"../utils/liveTextHandoff": liveTextHandoff,
		"./outlineRevision": outlineRevision,
		"./outlineProjectionCache": outlineProjectionCache,
	});
	const composer = compileModule("src/renderer/src/atoms/composer-atoms.ts", {
		"./session-atoms": sessions,
	});
	return { ...sessions, ...composer, outlineProjectionCache };
}

function session(id, projectId = "project-1", overrides = {}) {
	return {
		id,
		projectId,
		title: id,
		source: "pi",
		environment: "native",
		preview: "",
		messageCount: 0,
		status: "draft",
		createdAt: 1,
		updatedAt: 1,
		...overrides,
	};
}

function chatMessage(id, role, text, timestamp = 1) {
	return { id, agentId: "agent", role, text, timestamp };
}

test("stores catalog records and selection by stable session ID", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [session("session-a"), session("session-b")],
	});
	store.set(atoms.currentSessionIdAtom, "session-b");
	assert.equal(store.get(atoms.currentSessionAtom).id, "session-b");
	assert.equal(store.get(atoms.sessionIdsByProjectAtom)["project-1"].join(","), "session-a,session-b");
});

test("clears current selection when a catalog refresh removes the current session", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [session("session-a"), session("session-b")],
	});
	store.set(atoms.currentSessionIdAtom, "session-a");
	// 目录刷新：session-a 已不在磁盘（删除/归档/外部同步移除）
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [session("session-b")],
	});
	assert.equal(store.get(atoms.currentSessionIdAtom), undefined);
	assert.equal(store.get(atoms.sessionRecordsAtom)["session-a"], undefined);
	assert.equal(store.get(atoms.sessionRecordsAtom)["session-b"].id, "session-b");
});

test("keeps current selection when a catalog refresh removes a different session", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [session("session-a"), session("session-b")],
	});
	store.set(atoms.currentSessionIdAtom, "session-a");
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [session("session-a")],
	});
	assert.equal(store.get(atoms.currentSessionIdAtom), "session-a");
	assert.equal(store.get(atoms.sessionRecordsAtom)["session-a"].id, "session-a");
	assert.equal(store.get(atoms.sessionRecordsAtom)["session-b"], undefined);
});

test("removeSessionState clears the current selection together with the record", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [session("session-a"), session("session-b")],
	});
	store.set(atoms.currentSessionIdAtom, "session-a");
	store.set(atoms.removeSessionStateAtom, "session-a");
	assert.equal(store.get(atoms.currentSessionIdAtom), undefined);
	assert.equal(store.get(atoms.sessionRecordsAtom)["session-a"], undefined);
});

test("keeps catalog atom identities stable when polling returns equivalent records", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [session("session-a"), session("session-b")],
	});
	const recordsBefore = store.get(atoms.sessionRecordsAtom);
	const idsBefore = store.get(atoms.sessionIdsByProjectAtom);

	// Session scanners allocate fresh objects on every poll; equal values must not redraw the sidebar.
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [session("session-a"), session("session-b")],
	});

	assert.equal(store.get(atoms.sessionRecordsAtom), recordsBefore);
	assert.equal(store.get(atoms.sessionIdsByProjectAtom), idsBefore);

	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [session("session-a"), session("session-b", "project-1", { updatedAt: 2 })],
	});
	assert.notEqual(store.get(atoms.sessionRecordsAtom), recordsBefore);
	assert.notEqual(store.get(atoms.sessionIdsByProjectAtom), idsBefore);
});

test("keeps only the 8 most recently written session message caches", () => {
	const atoms = loadAtoms();
	const store = createStore();
	for (let index = 0; index < 9; index += 1) {
		store.set(atoms.cacheSessionMessagesAtom, {
			sessionId: `session-${index}`,
			messages: [{ id: `message-${index}`, role: "user", text: String(index) }],
			source: "disk",
		});
	}
	const cache = store.get(atoms.sessionMessagesCacheAtom);
	assert.equal(Object.keys(cache).length, 8);
	assert.equal(cache["session-0"], undefined);
	assert.equal(cache["session-8"].messages[0].text, "8");
});

test("message cache eviction releases the matching outline projection", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-a",
		messages: [chatMessage("a", "user", "A")],
		source: "runtime",
	});
	const first = store.get(atoms.sessionMessagesCacheAtom)["session-a"];
	atoms.outlineProjectionCache.setSessionOutlineProjection("session-a", first.outlineRevision, [{ id: "a", role: "user", title: "A", time: "1" }]);

	for (let index = 0; index < 8; index += 1) {
		store.set(atoms.cacheSessionMessagesAtom, {
			sessionId: `session-${index}`,
			messages: [chatMessage(`message-${index}`, "assistant", String(index))],
			source: "runtime",
		});
	}

	assert.equal(atoms.outlineProjectionCache.getSessionOutlineProjection("session-a", first.outlineRevision), undefined);
});
test("does not let a stale disk write clobber a live runtime cache", () => {
	// A runtime→disk overwrite with fewer messages than currently cached is
	// treated as stale (e.g. anonymous sessions where disk always returns []).
	// This prevents the switch-back-empty-disk bug from wiping runtime messages.
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-a",
		messages: [{ id: "runtime", role: "assistant", text: "live" }],
		source: "runtime",
		pageState: { hasMoreOld: false, hasMoreNew: false, loaded: "all" },
	});
	const applied = store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-a",
		messages: [{ id: "disk", role: "assistant", text: "stale" }],
		source: "disk",
		expectedRevision: 0,
	});
	assert.equal(applied, false);
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages[0].text, "live");
});

test("force disk write replaces a live runtime cache after history mutation", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-a",
		messages: [
			{ id: "runtime-1", role: "user", text: "old" },
			{ id: "runtime-2", role: "assistant", text: "live" },
		],
		source: "runtime",
	});
	const applied = store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-a",
		messages: [{ id: "disk", role: "user", text: "edited" }],
		source: "disk",
		expectedRevision: 0,
		force: true,
	});
	assert.equal(applied, true);
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages[0].text, "edited");
});

test("allows a richer disk write to replace a leaner runtime cache", () => {
	// If disk has strictly more messages than the runtime cache, the overwrite is
	// real progress (e.g. runtime missed early windowed messages), so allow it.
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-b",
		messages: [{ id: "r1", role: "assistant", text: "live" }],
		source: "runtime",
	});
	const applied = store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-b",
		messages: [
			{ id: "d1", role: "user", text: "old" },
			{ id: "r1", role: "assistant", text: "live" },
		],
		source: "disk",
		expectedRevision: 0,
	});
	assert.equal(applied, true);
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)["session-b"].messages.length, 2);
});

test("rejects a late disk page continuation whose revision does not match", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-c",
		messages: [{ id: "m1", role: "user", text: "v1" }],
		source: "disk",
		revision: 2,
	});
	const applied = store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-c",
		messages: [{ id: "m1", role: "user", text: "v0" }],
		source: "disk",
		expectedRevision: 1,
	});
	assert.equal(applied, false);
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)["session-c"].messages[0].text, "v1");
});

test("promoteSessionMessagesCacheAtom moves the guide bootstrap bubble and leaves nothing behind for the next send", () => {
	// 回归：引导页虚拟会话 ID 是常量、永不经 removeSessionStateAtom 清理。此前提升只「拷」
	// 不「搬」，第 N 次从引导页发送时 useSessionSend 把残留缓存当 previousMessages 追加，
	// 新会话一开始就带着之前 N-1 条消息。
	const atoms = loadAtoms();
	const store = createStore();
	const GUIDE = "renderer:guide-bootstrap";
	store.set(atoms.cacheSessionMessagesAtom, { sessionId: GUIDE, messages: [chatMessage("req-1", "user", "first")], source: "runtime" });
	store.set(atoms.promoteSessionMessagesCacheAtom, { fromSessionId: GUIDE, toSessionId: "session-1" });
	assert.deepEqual([...store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages.map((m) => m.text)], ["first"]);
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)[GUIDE], undefined);
	assert.ok(!store.get(atoms.sessionMessageLruAtom).includes(GUIDE));

	// 第二次从引导页发送：模拟 useSessionSend 的 previousMessages 追加，然后再提升
	const leftovers = store.get(atoms.sessionMessagesCacheAtom)[GUIDE]?.messages ?? [];
	store.set(atoms.cacheSessionMessagesAtom, { sessionId: GUIDE, messages: [...leftovers, chatMessage("req-2", "user", "second")], source: "runtime" });
	store.set(atoms.promoteSessionMessagesCacheAtom, { fromSessionId: GUIDE, toSessionId: "session-2" });
	assert.deepEqual([...store.get(atoms.sessionMessagesCacheAtom)["session-2"].messages.map((m) => m.text)], ["second"]);
	assert.deepEqual([...store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages.map((m) => m.text)], ["first"]);
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)[GUIDE], undefined);
});

test("promoteSessionMessagesCacheAtom is a no-op without a source cache and appends onto an existing target", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.promoteSessionMessagesCacheAtom, { fromSessionId: "ghost", toSessionId: "session-1" });
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)["session-1"], undefined);

	store.set(atoms.cacheSessionMessagesAtom, { sessionId: "session-1", messages: [chatMessage("old", "assistant", "existing")], source: "runtime" });
	store.set(atoms.cacheSessionMessagesAtom, { sessionId: "virtual", messages: [chatMessage("new", "user", "incoming")], source: "runtime" });
	store.set(atoms.promoteSessionMessagesCacheAtom, { fromSessionId: "virtual", toSessionId: "session-1" });
	assert.deepEqual([...store.get(atoms.sessionMessagesCacheAtom)["session-1"].messages.map((m) => m.text)], ["existing", "incoming"]);
	assert.equal(store.get(atoms.sessionMessagesCacheAtom).virtual, undefined);
});

test("anonymous session switch-back does not wipe runtime messages via empty disk write", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "anon-42",
		messages: [{ id: "m1", role: "user", text: "hi" }],
		source: "runtime",
		revision: 1,
		pageState: { hasMoreOld: false, hasMoreNew: false, loaded: "all" },
	});
	const applied = store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "anon-42",
		messages: [],
		source: "disk",
		expectedRevision: 1,
	});
	assert.equal(applied, false);
	assert.deepEqual(store.get(atoms.sessionMessagesCacheAtom)["anon-42"].messages, [{ id: "m1", role: "user", text: "hi" }]);
});

test("routes runtime payloads into session-keyed messages and state", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:state",
		payload: { id: "agent-a", status: "running" },
	});
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: { agentId: "agent-a", messages: [{ id: "m1", role: "user", text: "hello" }] },
	});
	const runtime = store.get(atoms.sessionRuntimeByIdAtom)["session-a"];
	assert.equal(runtime.agentId, "agent-a");
	assert.equal(runtime.status, "running");
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages[0].text, "hello");
});

test("ignores late events from an older runtime generation", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-old",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: {
			messages: [{ id: "old", role: "assistant", text: "old runtime" }],
		},
	});
	store.set(atoms.bindSessionRuntimeAtom, {
		sessionId: "session-a",
		agentId: "agent-new",
		runtimeGeneration: 2,
		status: "idle",
	});
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-old",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: {
			messages: [{ id: "late", role: "assistant", text: "late old runtime" }],
		},
	});
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-old",
		runtimeGeneration: 2,
		sourceChannel: "agents:state",
		payload: { status: "closed" },
	});
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-new",
		runtimeGeneration: 2,
		sourceChannel: "agents:message",
		payload: {
			messages: [{ id: "new", role: "assistant", text: "new runtime" }],
		},
	});

	const runtime = store.get(atoms.sessionRuntimeByIdAtom)["session-a"];
	const messages = store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages;
	assert.equal(runtime.agentId, "agent-new");
	assert.equal(runtime.runtimeGeneration, 2);
	assert.equal(runtime.status, "idle");
	assert.equal(messages.length, 1);
	assert.equal(messages[0].text, "new runtime");
});

test("anonymous detach clears its record and rejects a late catalog refresh", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const anonymous = session("anonymous-1", "project-1", {
		noSession: true,
		status: "active",
	});
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [anonymous],
	});
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: anonymous.id,
		agentId: "anonymous-agent",
		runtimeGeneration: 1,
		sourceChannel: "agents:state",
		payload: {
			id: "anonymous-agent",
			projectId: "project-1",
			cwd: "C:/project",
			status: "idle",
			createdAt: 1,
			noSession: true,
		},
	});
	store.set(atoms.applySessionRuntimeEventAtom, {
		kind: "detach",
		sessionId: anonymous.id,
		agentId: "anonymous-agent",
		runtimeGeneration: 1,
		sourceChannel: "sessions:runtime-detach",
		payload: null,
	});
	assert.equal(store.get(atoms.sessionRecordsAtom)[anonymous.id], undefined);
	assert.equal(store.get(atoms.discardedTransientSessionIdsAtom).has(anonymous.id), true);

	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-1",
		sessions: [anonymous],
	});
	assert.equal(store.get(atoms.sessionRecordsAtom)[anonymous.id], undefined);
	assert.deepEqual(store.get(atoms.sessionIdsByProjectAtom)["project-1"], []);
});

test("incremental message flush merges tail upserts and discards non-contiguous deltas", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const readMessages = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages;

	// 1) 全量基线（终态校准形态）
	emit({
		agentId: "agent-a",
		messages: [
			{ id: "m1", role: "user", text: "q" },
			{ id: "m2", role: "assistant", text: "a" },
		],
	});
	assert.equal(readMessages().length, 2);

	// 2) 纯 append：upsertFrom == 旧长度 → 尾部追加
	emit({ agentId: "agent-a", upsertFrom: 2, totalLength: 3, messages: [{ id: "m3", role: "tool", text: "tool" }] });
	// vm realm 数组与字面量数组原型不同，deepStrictEqual 会误判，展开为本 realm 数组再比
	assert.deepEqual([...readMessages().map((m) => m.id)], ["m1", "m2", "m3"]);

	// 3) 尾部替换：upsertFrom < 旧长度 → 从该处起覆盖（流式 delta 形态）
	emit({ agentId: "agent-a", upsertFrom: 2, totalLength: 3, messages: [{ id: "m3", role: "tool", text: "tool-done" }] });
	assert.equal(readMessages()[2].text, "tool-done");
	assert.equal(readMessages().length, 3);

	// 4) 长度不连续（upsertFrom > 旧长度，漏了事件）→ 丢弃，等终态全量
	emit({ agentId: "agent-a", upsertFrom: 9, totalLength: 10, messages: [{ id: "m10", role: "assistant", text: "lost" }] });
	assert.equal(readMessages().length, 3, "non-contiguous upsert must be discarded");

	// 5) totalLength 校验失败（本地合并后与主进程不一致）→ 丢弃
	emit({ agentId: "agent-a", upsertFrom: 2, totalLength: 99, messages: [{ id: "m3", role: "tool", text: "bad" }] });
	assert.equal(readMessages()[2].text, "tool-done", "totalLength mismatch must be discarded");

	// 6) 终态全量校准：一次 full 覆盖所有中间态
	emit({
		agentId: "agent-a",
		messages: [
			{ id: "m1", role: "user", text: "q" },
			{ id: "m2", role: "assistant", text: "final" },
		],
	});
	assert.deepEqual([...readMessages().map((m) => m.text)], ["q", "final"]);
});

test("runtime assistant tail upserts preserve the outline revision", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

	emit({ agentId: "agent-a", messages: [chatMessage("first", "user", "First"), chatMessage("first-answer", "assistant", "Answer"), chatMessage("last", "user", "Last"), chatMessage("last-answer", "assistant", "Partial")] });
	const outlineRevision = entry().outlineRevision;

	emit({ agentId: "agent-a", upsertFrom: 3, totalLength: 4, messages: [chatMessage("last-answer", "assistant", "Completed")] });

	assert.equal(entry().outlineRevision, outlineRevision);
});

test("runtime upserts touching an earlier user checkpoint advance the outline revision", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

	emit({ agentId: "agent-a", messages: [chatMessage("first", "user", "First"), chatMessage("first-answer", "assistant", "Answer"), chatMessage("last", "user", "Last"), chatMessage("last-answer", "assistant", "Partial")] });
	const outlineRevision = entry().outlineRevision;

	emit({ agentId: "agent-a", upsertFrom: 0, totalLength: 4, messages: [chatMessage("first", "user", "Edited first"), chatMessage("first-answer", "assistant", "Answer"), chatMessage("last", "user", "Last"), chatMessage("last-answer", "assistant", "Completed")] });

	assert.ok(entry().outlineRevision > outlineRevision);
});
test("history prefix loading and clearing advance the outline revision", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

	emit({ agentId: "agent-a", messages: [chatMessage("latest-question", "user", "Latest"), chatMessage("latest-answer", "assistant", "Answer")] });
	const initialOutlineRevision = entry().outlineRevision;

	assert.equal(
		store.set(atoms.prependSessionHistoryPageAtom, {
			sessionId: "session-a",
			expectedRevision: entry().revision,
			before: undefined,
			page: {
				messages: [chatMessage("older-question", "user", "Older")],
				total: 3,
				nextBefore: null,
			},
		}),
		true,
	);
	const afterPrependOutlineRevision = entry().outlineRevision;
	assert.ok(afterPrependOutlineRevision > initialOutlineRevision);

	assert.equal(store.set(atoms.clearSessionHistoryAtom, "session-a"), true);
	assert.ok(entry().outlineRevision > afterPrependOutlineRevision);
});
test("incremental upsert is ignored while cache holds disk-sourced messages", () => {
	const atoms = loadAtoms();
	const store = createStore();
	// 磁盘分页来源的缓存（激活前磁盘加载）：runtime 增量不可合入，防止错乱
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-a",
		messages: [{ id: "d1", role: "user", text: "disk" }],
		source: "disk",
		page: { total: 1, nextBefore: null },
	});
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: {
			agentId: "agent-a",
			upsertFrom: 0,
			totalLength: 2,
			messages: [
				{ id: "r1", role: "user", text: "runtime" },
				{ id: "r2", role: "assistant", text: "runtime-a" },
			],
		},
	});
	const entry = store.get(atoms.sessionMessagesCacheAtom)["session-a"];
	assert.equal(entry.source, "disk", "disk entry must not be clobbered by runtime upsert");
	assert.equal(entry.messages.length, 1);

	// 随后的全量（激活完成）可以正常接管
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: { agentId: "agent-a", messages: [{ id: "r1", role: "user", text: "runtime" }] },
	});
	const next = store.get(atoms.sessionMessagesCacheAtom)["session-a"];
	assert.equal(next.source, "runtime");
	assert.equal(next.messages[0].text, "runtime");
});

test("isolates composer state and only clears the submitted snapshot", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.setSessionDraftAtom, { sessionId: "session-a", value: "first" });
	store.set(atoms.setSessionDraftAtom, { sessionId: "session-b", value: "second" });
	store.set(atoms.currentSessionIdAtom, "session-a");
	assert.equal(store.get(atoms.currentSessionDraftAtom), "first");

	store.set(atoms.setSessionDraftAtom, { sessionId: "session-a", value: "new edit" });
	store.set(atoms.clearSessionComposerSnapshotAtom, {
		sessionId: "session-a",
		draft: "first",
		attachments: [],
	});
	assert.equal(store.get(atoms.sessionDraftByIdAtom)["session-a"], "new edit");
	assert.equal(store.get(atoms.sessionDraftByIdAtom)["session-b"], "second");
});

test("windowed full snapshot stores segment with windowStart and merges later upserts by window offset", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

	// 窗口化全量：主进程数组 5 条，窗口起点 2 → 只下发 [2..5)
	emit({
		agentId: "agent-a",
		windowStart: 2,
		totalLength: 5,
		messages: [
			{ id: "m3", role: "user", text: "q3" },
			{ id: "m4", role: "assistant", text: "a3" },
			{ id: "m5", role: "assistant", text: "tail" },
		],
	});
	assert.equal(entry().windowStart, 2);
	assert.equal(entry().messages.length, 3);

	// 流式增量：upsertFrom=4 是绝对下标 → 窗口偏移 2，尾部替换；W+len===T 校验
	emit({ agentId: "agent-a", upsertFrom: 4, totalLength: 5, messages: [{ id: "m5", role: "assistant", text: "tail-longer" }] });
	assert.equal(entry().messages[2].text, "tail-longer");
	assert.equal(entry().messages.length, 3);

	// append 新消息：upsertFrom=5（绝对）→ offset 3 → 追加
	emit({ agentId: "agent-a", upsertFrom: 5, totalLength: 6, messages: [{ id: "m6", role: "tool", text: "tool" }] });
	assert.deepEqual([...entry().messages.map((m) => m.id)], ["m3", "m4", "m5", "m6"]);

	// 非法偏移（upsertFrom < windowStart）→ 丢弃，等窗口化全量校准
	emit({ agentId: "agent-a", upsertFrom: 1, totalLength: 6, messages: [{ id: "m2", role: "assistant", text: "out-of-window" }] });
	assert.equal(entry().messages.length, 4, "upsert before window start must be discarded");
});

test("windowed full reconciles disk history prefix: seam dedupe by entryId and version-drop on compaction", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

	// 基线：窗口段 + disk 前缀（前缀尾部 e3 与即将到达的窗口段首部重叠）
	emit({
		agentId: "agent-a",
		windowStart: 2,
		totalLength: 4,
		fileVersion: "100:2000",
		messages: [
			{ id: "r1", role: "user", text: "q", meta: { entryId: "e3" } },
			{ id: "r2", role: "assistant", text: "a", meta: { entryId: "e4" } },
		],
	});
	store.set(atoms.prependSessionHistoryPageAtom, {
		sessionId: "session-a",
		expectedRevision: entry().revision,
		before: undefined,
		page: {
			messages: [
				{ id: "h1", role: "user", text: "old-q", meta: { entryId: "e1" } },
				{ id: "h2", role: "assistant", text: "old-a", meta: { entryId: "e2" } },
				{ id: "h3", role: "user", text: "dup-q", meta: { entryId: "e3" } },
			],
			total: 4,
			nextBefore: 1,
			indexVersion: "100:2000",
		},
	});
	// 接缝去重：e3 在窗口段已存在（运行时权威）→ 前缀只剩 e1/e2
	assert.deepEqual([...entry().history.messages.map((m) => m.meta.entryId)], ["e1", "e2"]);

	// 窗口右移（新一轮对话后重载）：窗口段首部 e2 与前缀尾部重叠 → 前缀收缩为 e1
	emit({
		agentId: "agent-a",
		windowStart: 3,
		totalLength: 6,
		fileVersion: "100:2000",
		messages: [
			{ id: "r0", role: "assistant", text: "old-a", meta: { entryId: "e2" } },
			{ id: "r1", role: "user", text: "q", meta: { entryId: "e3" } },
			{ id: "r2", role: "assistant", text: "a", meta: { entryId: "e4" } },
		],
	});
	assert.deepEqual([...entry().history.messages.map((m) => m.meta.entryId)], ["e1"]);

	// 压缩改写 JSONL：fileVersion 变化 → 前缀整段失效
	emit({
		agentId: "agent-a",
		windowStart: 1,
		totalLength: 3,
		fileVersion: "200:800",
		messages: [
			{ id: "c1", role: "user", text: "after-compaction", meta: { entryId: "n1" } },
			{ id: "c2", role: "assistant", text: "a", meta: { entryId: "n2" } },
		],
	});
	assert.equal(entry().history, undefined, "compaction version change must drop the prefix");
	assert.equal(entry().windowStart, 1);
});

test("edit/delete fileVersion drop stale history even when the prefix has no version", () => {
	// 用户上滚补历史后，前缀可能还没带上 indexVersion。
	// 编辑/删除改了 JSONL 却只下发尾部 3 轮时，无 version 的旧前缀会把窗外旧文本继续拼回去，
	// 表现为「编辑了不刷新，再编一条才看到」。
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

	emit({
		agentId: "agent-a",
		windowStart: 2,
		totalLength: 4,
		fileVersion: "100:2000",
		messages: [
			{ id: "r1", role: "user", text: "q", meta: { entryId: "e3" } },
			{ id: "r2", role: "assistant", text: "a", meta: { entryId: "e4" } },
		],
	});
	store.set(atoms.sessionMessagesCacheAtom, {
		...store.get(atoms.sessionMessagesCacheAtom),
		"session-a": {
			...entry(),
			history: {
				messages: [
					{ id: "h1", role: "user", text: "old-q", meta: { entryId: "e1" } },
					{ id: "h2", role: "assistant", text: "old-a", meta: { entryId: "e2" } },
				],
				nextBefore: null,
			},
		},
	});

	// 编辑落在窗口外：全量 flush 仍只带尾部 3 轮。旧前缀没有 version 时，
	// 不能继续按 entryId 拼回去，否则窗外那条永远是编辑前的文本。
	emit({
		agentId: "agent-a",
		windowStart: 2,
		totalLength: 4,
		fileVersion: "200:2100",
		messages: [
			{ id: "r1", role: "user", text: "q", meta: { entryId: "e3" } },
			{ id: "r2", role: "assistant", text: "a", meta: { entryId: "e4" } },
		],
	});
	assert.equal(entry().history, undefined, "versionless prefix must not survive a new fileVersion");
	assert.equal(
		entry().messages.some((message) => message.text === "old-a"),
		false,
		"stale edited text must not remain in the spliced timeline",
	);
});

test("incremental upsert offset accounts for leading compaction cards (H1 regression)", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

	// 压缩会话：主进程数组 = [摘要卡片, q1..a8, q9..q12]（16 条），窗口起点 9（q9 起尾部 3 轮）；
	// 全量载荷 = [卡片, q9..q12 段]（8 条）→ 本地布局 [卡片, 段]，cardCount 由全量推导 = 1
	emit({
		agentId: "agent-a",
		windowStart: 9,
		totalLength: 16,
		messages: [
			{ id: "sum", role: "system", text: "compacted", meta: { type: "compaction" } },
			{ id: "m9", role: "user", text: "q9" },
			{ id: "m10", role: "assistant", text: "a9" },
			{ id: "m11", role: "user", text: "q10" },
			{ id: "m12", role: "assistant", text: "a10" },
			{ id: "m13", role: "user", text: "q11" },
			{ id: "m14", role: "assistant", text: "a11" },
			{ id: "m15", role: "user", text: "q12" },
		],
	});
	assert.equal(entry().cardCount, 1);
	assert.deepEqual([...entry().messages.map((m) => m.id)], ["sum", "m9", "m10", "m11", "m12", "m13", "m14", "m15"]);

	// 流式增量改写尾部：upsertFrom=14（main 绝对下标，m14 起）→ 本地偏移 = 14 − 9 + 卡片(1) = 6；
	// 修复前偏移 = 5：q11（m13）连同 m14/m15 一起被替换切掉（长度恒等式 W+len===T 恰好抵消）
	emit({
		agentId: "agent-a",
		upsertFrom: 14,
		totalLength: 16,
		messages: [
			{ id: "m14", role: "assistant", text: "a11-streaming" },
			{ id: "m15", role: "user", text: "q12" },
		],
	});
	assert.deepEqual([...entry().messages.map((m) => m.id)], ["sum", "m9", "m10", "m11", "m12", "m13", "m14", "m15"]);
	assert.equal(entry().messages[6].text, "a11-streaming", "q11 不得被静默切掉");

	// append 新消息：upsertFrom=16（绝对）→ 本地偏移 8 → 追加
	emit({ agentId: "agent-a", upsertFrom: 16, totalLength: 17, messages: [{ id: "m16", role: "assistant", text: "a12" }] });
	assert.deepEqual([...entry().messages.map((m) => m.id)], ["sum", "m9", "m10", "m11", "m12", "m13", "m14", "m15", "m16"]);
});

test("full flush merges trim slide-out turns into the history prefix (H2 regression)", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

	// 基线：窗口段 [e5..e9]（main 数组 [m1..m9] 窗口起点 4）+ disk 前缀 [e1..e4]
	emit({
		agentId: "agent-a",
		windowStart: 4,
		totalLength: 9,
		messages: [
			{ id: "m5", role: "user", text: "q3", meta: { entryId: "e5" } },
			{ id: "m6", role: "assistant", text: "a3", meta: { entryId: "e6" } },
			{ id: "m7", role: "user", text: "q4", meta: { entryId: "e7" } },
			{ id: "m8", role: "assistant", text: "a4", meta: { entryId: "e8" } },
			{ id: "m9", role: "user", text: "q5", meta: { entryId: "e9" } },
		],
	});
	store.set(atoms.prependSessionHistoryPageAtom, {
		sessionId: "session-a",
		expectedRevision: entry().revision,
		before: undefined,
		page: {
			messages: [
				{ id: "h1", role: "user", text: "q1", meta: { entryId: "e1" } },
				{ id: "h2", role: "assistant", text: "a1", meta: { entryId: "e2" } },
				{ id: "h3", role: "user", text: "q2", meta: { entryId: "e3" } },
				{ id: "h4", role: "assistant", text: "a2", meta: { entryId: "e4" } },
			],
			total: 9,
			nextBefore: 1,
			indexVersion: "100:2000",
		},
	});
	assert.deepEqual([...entry().history.messages.map((m) => m.meta.entryId)], ["e1", "e2", "e3", "e4"]);

	// trim 窗口右移：新窗口起点 7（旧空间）→ 滑出 [e5, e6]（q3/a3）随全量 flush 下发
	emit({
		agentId: "agent-a",
		windowStart: 7,
		totalLength: 9,
		slideOut: [
			{ id: "m5", role: "user", text: "q3", meta: { entryId: "e5" } },
			{ id: "m6", role: "assistant", text: "a3", meta: { entryId: "e6" } },
		],
		messages: [
			{ id: "m7", role: "user", text: "q4", meta: { entryId: "e7" } },
			{ id: "m8", role: "assistant", text: "a4", meta: { entryId: "e8" } },
			{ id: "m9", role: "user", text: "q5", meta: { entryId: "e9" } },
		],
	});
	// 前缀 = 旧前缀 + 滑出轮 → e1..e6 连续无洞；窗口段 = [e7..e9]
	assert.deepEqual([...entry().history.messages.map((m) => m.meta.entryId)], ["e1", "e2", "e3", "e4", "e5", "e6"]);
	assert.deepEqual([...entry().messages.map((m) => m.meta.entryId)], ["e7", "e8", "e9"]);
	assert.equal(entry().windowStart, 7);

	// 滑出轮与窗口段重叠的防御去重：slideOut 尾部与段首部同 entryId → 前缀只留一份
	emit({
		agentId: "agent-a",
		windowStart: 8,
		totalLength: 9,
		slideOut: [{ id: "m7", role: "user", text: "q4", meta: { entryId: "e7" } }],
		messages: [
			{ id: "m8", role: "assistant", text: "a4", meta: { entryId: "e8" } },
			{ id: "m9", role: "user", text: "q5", meta: { entryId: "e9" } },
		],
	});
	assert.deepEqual([...entry().history.messages.map((m) => m.meta.entryId)], ["e1", "e2", "e3", "e4", "e5", "e6", "e7"]);
	assert.deepEqual([...entry().messages.map((m) => m.meta.entryId)], ["e8", "e9"]);

	// 压缩改写 + 滑出轮：文件版本变化 → 旧前缀整段失效，仅以滑出轮重建前缀
	emit({ agentId: "agent-a", windowStart: 1, totalLength: 3, fileVersion: "200:800", slideOut: [{ id: "m1", role: "user", text: "kept", meta: { entryId: "n1" } }], messages: [{ id: "c1", role: "user", text: "after-compaction", meta: { entryId: "n2" } }] });
	assert.deepEqual([...entry().history.messages.map((m) => m.meta.entryId)], ["n1"]);
});

test("slideOut-only history keeps an entryId cursor so older pages stay reachable", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});

	// 基线窗口段：e5..e6（历史前缀尚未创建）
	emit({
		agentId: "agent-a",
		windowStart: 4,
		totalLength: 6,
		messages: [
			{ id: "m5", role: "user", text: "q3", meta: { entryId: "e5" } },
			{ id: "m6", role: "assistant", text: "a3", meta: { entryId: "e6" } },
		],
	});
	assert.equal(entry().history, undefined);

	// 窗口右移，e3..e4 作为 slideOut 单独重建前缀
	emit({
		agentId: "agent-a",
		windowStart: 6,
		totalLength: 6,
		slideOut: [
			{ id: "m3", role: "user", text: "q2", meta: { entryId: "e3" } },
			{ id: "m4", role: "assistant", text: "a2", meta: { entryId: "e4" } },
		],
		messages: [
			{ id: "m5", role: "user", text: "q3", meta: { entryId: "e5" } },
			{ id: "m6", role: "assistant", text: "a3", meta: { entryId: "e6" } },
		],
	});
	assert.equal(entry().history.nextBefore, null);
	assert.equal(entry().history.nextBeforeEntryId, "e3", "slideOut 最旧消息必须成为续页锚点");

	// 首次续页 before=null 必须被接受，并接在 slideOut 前缀之前
	assert.equal(
		store.set(atoms.prependSessionHistoryPageAtom, {
			sessionId: "session-a",
			expectedRevision: entry().revision,
			before: null,
			page: {
				messages: [
					{ id: "m1", role: "user", text: "q1", meta: { entryId: "e1" } },
					{ id: "m2", role: "assistant", text: "a1", meta: { entryId: "e2" } },
				],
				total: 6,
				nextBefore: 0,
				nextBeforeEntryId: "e1",
				indexVersion: "100:2000",
			},
		}),
		true,
	);
	assert.deepEqual([...entry().history.messages.map((m) => m.meta.entryId)], ["e1", "e2", "e3", "e4"]);
	assert.equal(entry().history.nextBefore, 0);
	assert.equal(entry().history.nextBeforeEntryId, "e1");
});

test("prependSessionHistoryPageAtom guards revision and cursor continuity, dedupes against segment", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: {
			agentId: "agent-a",
			windowStart: 2,
			totalLength: 4,
			messages: [
				{ id: "r1", role: "user", text: "q", meta: { entryId: "e3" } },
				{ id: "r2", role: "assistant", text: "a", meta: { entryId: "e4" } },
			],
		},
	});

	// revision 不符 → 拒绝
	assert.equal(
		store.set(atoms.prependSessionHistoryPageAtom, {
			sessionId: "session-a",
			expectedRevision: 999,
			before: undefined,
			page: { messages: [{ id: "x", role: "user", text: "x" }], total: 4, nextBefore: 0 },
		}),
		false,
	);
	assert.equal(entry().history, undefined);

	// 首次加载：建立前缀（与窗口段去重：e3 已在段内，不入前缀）
	assert.equal(
		store.set(atoms.prependSessionHistoryPageAtom, {
			sessionId: "session-a",
			expectedRevision: entry().revision,
			before: undefined,
			page: {
				messages: [
					{ id: "h1", role: "user", text: "q1", meta: { entryId: "e1" } },
					{ id: "h3", role: "user", text: "q3", meta: { entryId: "e3" } },
				],
				total: 4,
				nextBefore: 1,
				indexVersion: "100:2000",
			},
		}),
		true,
	);
	assert.deepEqual([...entry().history.messages.map((m) => m.meta.entryId)], ["e1"]);
	assert.equal(entry().history.nextBefore, 1);

	// 游标不连续（before 与当前 nextBefore 不符）→ 拒绝
	assert.equal(
		store.set(atoms.prependSessionHistoryPageAtom, {
			sessionId: "session-a",
			expectedRevision: entry().revision,
			before: 0,
			page: { messages: [{ id: "h0", role: "user", text: "q0" }], total: 4, nextBefore: null },
		}),
		false,
	);

	// 续页：游标连续 → prepend
	assert.equal(
		store.set(atoms.prependSessionHistoryPageAtom, {
			sessionId: "session-a",
			expectedRevision: entry().revision,
			before: 1,
			page: {
				messages: [{ id: "h0", role: "user", text: "q0", meta: { entryId: "e0" } }],
				total: 4,
				nextBefore: null,
				indexVersion: "100:2000",
			},
		}),
		true,
	);
	assert.deepEqual([...entry().history.messages.map((m) => m.meta.entryId)], ["e0", "e1"]);
	assert.equal(entry().history.nextBefore, null);
});

test("saveSessionScrollAnchorAtom: per-session anchor save/clear with out-of-order protection", () => {
	const store = createStore();
	const atoms = loadAtoms();
	const anchor = (savedAt, messageId = "m1") => ({
		messageId,
		offsetTop: 120,
		windowTurns: 9,
		savedAt,
	});

	// 初始无锚点
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"], undefined);

	// 保存锚点
	store.set(atoms.saveSessionScrollAnchorAtom, { sessionId: "session-a", anchor: anchor(100) });
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"].messageId, "m1");

	// 更早的保存（savedAt 更小）不得覆盖更新的锚点（乱序滚动事件保护）
	store.set(atoms.saveSessionScrollAnchorAtom, { sessionId: "session-a", anchor: anchor(50, "m-stale") });
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"].messageId, "m1");

	// 更新的保存正常覆盖
	store.set(atoms.saveSessionScrollAnchorAtom, { sessionId: "session-a", anchor: anchor(150, "m2") });
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"].messageId, "m2");

	// 不同会话互不干扰
	store.set(atoms.saveSessionScrollAnchorAtom, { sessionId: "session-b", anchor: anchor(80, "mb") });
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"].messageId, "m2");
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-b"].messageId, "mb");

	// 传 null 清除（在底部跟流切走 → 切回继续跟底）
	store.set(atoms.saveSessionScrollAnchorAtom, { sessionId: "session-a", anchor: null });
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"], undefined);
	// 清除不误伤其他会话
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-b"].messageId, "mb");
});

test("saveSessionScrollAnchorAtom: identical content skips write (stable reference for subscribers)", () => {
	const store = createStore();
	const atoms = loadAtoms();
	const anchor = (savedAt) => ({
		messageId: "m1",
		offsetTop: 120,
		windowTurns: 9,
		savedAt,
	});

	store.set(atoms.saveSessionScrollAnchorAtom, { sessionId: "session-a", anchor: anchor(100) });
	const first = store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"];
	assert.equal(first.messageId, "m1");

	// 内容相同（仅 savedAt 不同）：引用必须保持稳定，订阅者零重渲染
	store.set(atoms.saveSessionScrollAnchorAtom, { sessionId: "session-a", anchor: anchor(200) });
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"], first);

	// 窗口轮数变化同样必须覆盖：否则切回时会继续使用旧窗口，锚点仍可能被裁掉。
	store.set(atoms.saveSessionScrollAnchorAtom, {
		sessionId: "session-a",
		anchor: { messageId: "m1", offsetTop: 120, windowTurns: 12, savedAt: 300 },
	});
	assert.notEqual(store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"], first);
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"].windowTurns, 12);

	// 偏移变化仍会覆盖。
	store.set(atoms.saveSessionScrollAnchorAtom, {
		sessionId: "session-a",
		anchor: { messageId: "m1", offsetTop: 300, windowTurns: 12, savedAt: 400 },
	});
	assert.equal(store.get(atoms.sessionScrollAnchorByIdAtom)["session-a"].offsetTop, 300);
});

test("opened tabs survive cache LRU eviction (switch-back must not re-read disk)", () => {
	const atoms = loadAtoms();
	const store = createStore();
	// 生图会话：无 runtime 事件持续 touch，切走期间最容易被挤出 8 槽；
	// 但它的 Tab 仍打开着——被挤出后切回会重读盘并闪「正在加载历史」骨架。
	store.set(atoms.sessionTabIdsAtom, ["imagegen-session"]);
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "imagegen-session",
		messages: [{ id: "img1", role: "assistant", text: "", meta: { imageGen: { status: "complete", prompt: "猫" } } }],
		source: "runtime",
	});
	// 连续写入 8 个其它会话（模拟分屏常驻 + 预览 + 流式写入），均不在 Tab
	for (let i = 0; i < 8; i += 1) {
		const id = `other-${i}`;
		store.set(atoms.cacheSessionMessagesAtom, {
			sessionId: id,
			messages: [{ id: `m${i}`, role: "user", text: String(i) }],
			source: "runtime",
		});
		assert.ok(store.get(atoms.sessionMessagesCacheAtom)[id], `other-${i} cached`);
	}
	// 打开着 Tab 的会话不应被挤出：切回时缓存条目仍在，不重新读盘、不闪骨架
	assert.ok(store.get(atoms.sessionMessagesCacheAtom)["imagegen-session"], "session with an open tab must survive LRU eviction");
	// 关闭 Tab 后不再受保护：按普通 LRU 顺序继续写，占满 8 槽后即可被淘汰（缓存可回收）
	store.set(atoms.sessionTabIdsAtom, []);
	for (let i = 0; i < 8; i += 1) {
		store.set(atoms.cacheSessionMessagesAtom, {
			sessionId: `new-${i}`,
			messages: [{ id: `n${i}`, role: "user", text: `n${i}` }],
			source: "runtime",
		});
	}
	assert.ok(!store.get(atoms.sessionMessagesCacheAtom)["imagegen-session"], "closed tab is evictable once cache refills");
});

test("open tabs are never evicted even when tab count exceeds the cache limit (restart multi-tab recovery)", () => {
	const atoms = loadAtoms();
	const store = createStore();
	// 重启后恢复大量 Tab（分屏 + 常驻 + 预览），超过 8 槽上限：已打开的会话
	// 是用户正在引用的，绝不能因其它会话写入被挤出（挤掉 → 重读盘 → 再挤掉 = 闪循环）。
	const opened = Array.from({ length: 10 }, (_, i) => `tab-${i}`);
	store.set(atoms.sessionTabIdsAtom, opened);
	for (const id of opened) {
		store.set(atoms.cacheSessionMessagesAtom, {
			sessionId: id,
			messages: [{ id: `x-${id}`, role: "user", text: id }],
			source: "runtime",
		});
	}
	// 未打开的会话再写入：只挤未打开的部分，已打开的 10 个全部保留
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "not-opened",
		messages: [{ id: "n1", role: "user", text: "n1" }],
		source: "runtime",
	});
	for (const id of opened) {
		assert.ok(store.get(atoms.sessionMessagesCacheAtom)[id], `opened tab ${id} must never be evicted`);
	}
});

test("clearSessionHistoryAtom drops browsed history on bottom-settle, keeps runtime window", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-a",
		messages: [{ id: "w1", role: "user", text: "window", meta: { entryId: "e9" } }],
		source: "runtime",
		windowStart: 0,
		history: {
			messages: [{ id: "h1", role: "user", text: "history", meta: { entryId: "e1" } }],
			nextBefore: 0,
			nextBeforeEntryId: "e1",
		},
	});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

	assert.ok(entry().history, "history present before clear");
	assert.equal(store.set(atoms.clearSessionHistoryAtom, "session-a"), true);
	assert.equal(entry().history, undefined, "history cleared");
	assert.equal(entry().messages.length, 1, "runtime window segment kept");
	assert.equal(entry().messages[0].id, "w1");

	// 幂等：无 history 时返回 false
	assert.equal(store.set(atoms.clearSessionHistoryAtom, "session-a"), false);
});

test("clearSessionHistoryAtom ignores disk-source caches", () => {
	const atoms = loadAtoms();
	const store = createStore();
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-b",
		messages: [{ id: "d1", role: "user", text: "disk" }],
		source: "disk",
		page: { total: 1, nextBefore: null },
	});
	assert.equal(store.set(atoms.clearSessionHistoryAtom, "session-b"), false);
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)["session-b"].messages.length, 1);
});

test("windowed full flush stores windowStartFilePos and preserves it through prepend/clear", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (payload) =>
		store.set(atoms.applySessionRuntimeEventAtom, {
			sessionId: "session-a",
			agentId: "agent-a",
			runtimeGeneration: 1,
			sourceChannel: "agents:message",
			payload,
		});
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];

	// 窗口化全量携带文件消息下标游标（大历史 skipEntries 路径的数值锚点）
	emit({
		agentId: "agent-a",
		windowStart: 18,
		totalLength: 24,
		windowStartFilePos: 24,
		messages: [
			{ id: "q13", role: "user", text: "q13" },
			{ id: "a13", role: "assistant", text: "a13" },
		],
	});
	assert.equal(entry().windowStartFilePos, 24);

	// 增量 flush 不携带该字段 → 保留旧值
	emit({ agentId: "agent-a", upsertFrom: 20, totalLength: 24, messages: [{ id: "tail", role: "assistant", text: "tail" }] });
	assert.equal(entry().windowStartFilePos, 24);

	// prepend 历史页与回底清理都不丢游标
	store.set(atoms.prependSessionHistoryPageAtom, {
		sessionId: "session-a",
		expectedRevision: entry().revision,
		before: undefined,
		page: { messages: [{ id: "h1", role: "user", text: "old" }], total: 24, nextBefore: 12, indexVersion: "1:1" },
	});
	store.set(atoms.clearSessionHistoryAtom, "session-a");
	assert.equal(entry().windowStartFilePos, 24, "clear must not drop the numeric cursor");
});

test("late continuation page after bottom-settle clear is rejected; fresh first page still applies", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: {
			agentId: "agent-a",
			windowStart: 2,
			totalLength: 4,
			messages: [
				{ id: "r1", role: "user", text: "q", meta: { entryId: "e3" } },
				{ id: "r2", role: "assistant", text: "a", meta: { entryId: "e4" } },
			],
		},
	});
	// 先建立历史前缀（before=undefined 首次页）
	store.set(atoms.prependSessionHistoryPageAtom, {
		sessionId: "session-a",
		expectedRevision: entry().revision,
		before: undefined,
		page: {
			messages: [{ id: "h1", role: "user", text: "q1", meta: { entryId: "e1" } }],
			total: 4,
			nextBefore: 1,
			indexVersion: "100:2000",
		},
	});
	assert.ok(entry().history);

	// 回底清理触发（1.5s 定时器）→ history 清空
	assert.equal(store.set(atoms.clearSessionHistoryAtom, "session-a"), true);
	assert.equal(entry().history, undefined);

	// 迟到的续页（before=1，旧游标）必须被拒绝，不得复活 history
	assert.equal(
		store.set(atoms.prependSessionHistoryPageAtom, {
			sessionId: "session-a",
			expectedRevision: entry().revision,
			before: 1,
			page: { messages: [{ id: "h0", role: "user", text: "q0" }], total: 4, nextBefore: null, indexVersion: "100:2000" },
		}),
		false,
	);
	assert.equal(entry().history, undefined, "late continuation page must not resurrect history");

	// 用户再次上翻的合法首次页（before=undefined）仍可建立前缀
	assert.equal(
		store.set(atoms.prependSessionHistoryPageAtom, {
			sessionId: "session-a",
			expectedRevision: entry().revision,
			before: undefined,
			page: {
				messages: [{ id: "h2", role: "user", text: "q2", meta: { entryId: "e2" } }],
				total: 4,
				nextBefore: 2,
				indexVersion: "100:2000",
			},
		}),
		true,
	);
	assert.equal(entry().history.messages.length, 1);
});

test("force disk write bypasses the revision guard on disk-sourced caches (edit/delete regression)", () => {
	// 回归场景（用户反馈「删除后消息没有删除、还重复了」）：
	// 运行过的会话继承 runtime 递增的 revision；首次编辑/删除后缓存切到 disk 源但 revision
	// 不清零（disk 写保留 revision）。reloadTimelineFromDisk 恒传 expectedRevision: 0 + force，
	// 修复前 revision 守卫不看 force，把之后的每一次编辑/删除重载都吞掉：
	// 文件已改、时间线永不刷新。force 语义 =「disk 是权威快照」，必须豁免守卫。
	const atoms = loadAtoms();
	const store = createStore();
	const cache = (sessionId) => store.get(atoms.sessionMessagesCacheAtom)[sessionId];

	// 1) 运行中：runtime 快照（revision 递增到 1）
	store.set(atoms.applySessionRuntimeEventAtom, {
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: {
			agentId: "agent-a",
			messages: [
				{ id: "m1", role: "user", text: "q1" },
				{ id: "m2", role: "assistant", text: "a1" },
				{ id: "m3", role: "user", text: "q2" },
				{ id: "m4", role: "assistant", text: "a2" },
			],
		},
	});
	assert.equal(cache("session-a").revision, 1);

	// 2) 首次删除后的 force disk 重载：文件里 m3/m4 已墓碑，disk 为权威 → 生效
	assert.equal(
		store.set(atoms.cacheSessionMessagesAtom, {
			sessionId: "session-a",
			messages: [
				{ id: "m1", role: "user", text: "q1" },
				{ id: "m2", role: "assistant", text: "a1" },
			],
			source: "disk",
			expectedRevision: 0,
			page: { total: 2, nextBefore: null },
			force: true,
		}),
		true,
	);
	assert.equal(cache("session-a").source, "disk");
	assert.equal(cache("session-a").revision, 1, "disk 写保留 revision，不归零");

	// 3) 再删一条（第二次 mutation）：disk→disk、expectedRevision 0 ≠ revision 1。
	//    修复前守卫返回 false → 时间线停留在旧内容（「删除没反应」）。
	assert.equal(
		store.set(atoms.cacheSessionMessagesAtom, {
			sessionId: "session-a",
			messages: [{ id: "m1", role: "user", text: "q1" }],
			source: "disk",
			expectedRevision: 0,
			page: { total: 1, nextBefore: null },
			force: true,
		}),
		true,
		"force disk 写必须绕过 revision 守卫",
	);
	assert.deepEqual([...cache("session-a").messages.map((m) => m.id)], ["m1"]);
});

test("late runtime snapshot after detach is dropped (deleted message must not resurrect)", () => {
	// stop 流程：主进程先发 detach（status→detached、agentId 清除，同代守卫随之失效），
	// 节流 50ms 的最终 messages flush 可能晚于渲染层对 JSONL 的编辑/删除重载到达。
	// 迟到快照会覆盖刚写回的 disk 缓存（已删消息复活）——terminal 状态必须拒绝同代写入。
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (event) => store.set(atoms.applySessionRuntimeEventAtom, event);

	// 绑定运行中 runtime（gen 1, agent-a）
	emit({
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:state",
		payload: { id: "agent-a", status: "idle" },
	});

	// detach：agent 停止 → 状态 detached、agentId 移除
	emit({
		kind: "detach",
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "sessions:runtime-detach",
		payload: null,
	});
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].status, "detached");

	// 删除消息已生效：渲染层 force disk 重载写入（缓存内容 = 删除后的文件）
	assert.equal(
		store.set(atoms.cacheSessionMessagesAtom, {
			sessionId: "session-a",
			messages: [{ id: "m1", role: "user", text: "kept" }],
			source: "disk",
			expectedRevision: 0,
			force: true,
		}),
		true,
	);

	// 迟到的同代全量快照（包含已删的 m2）必须被丢弃
	emit({
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: {
			agentId: "agent-a",
			messages: [
				{ id: "m1", role: "user", text: "kept" },
				{ id: "m2", role: "assistant", text: "deleted-but-resurrecting" },
			],
		},
	});
	const entry = store.get(atoms.sessionMessagesCacheAtom)["session-a"];
	assert.equal(entry.source, "disk", "迟到快照不得覆盖 disk 缓存");
	assert.deepEqual([...entry.messages.map((m) => m.id)], ["m1"]);

	// 新代际（restart）的消息快照不受影响：bindingChanged=true → 正常接管
	emit({
		sessionId: "session-a",
		agentId: "agent-b",
		runtimeGeneration: 2,
		sourceChannel: "agents:state",
		payload: { id: "agent-b", status: "running" },
	});
	emit({
		sessionId: "session-a",
		agentId: "agent-b",
		runtimeGeneration: 2,
		sourceChannel: "agents:message",
		payload: {
			agentId: "agent-b",
			messages: [
				{ id: "m1", role: "user", text: "kept" },
				{ id: "n1", role: "assistant", text: "fresh turn" },
			],
		},
	});
	const afterRestart = store.get(atoms.sessionMessagesCacheAtom)["session-a"];
	assert.equal(afterRestart.source, "runtime", "新代际快照正常接管");
	assert.deepEqual([...afterRestart.messages.map((m) => m.id)], ["m1", "n1"]);
});

test("same-generation snapshots keep flowing while the binding is alive", () => {
	// 守卫只针对「绑定已消失（detach 清掉 agentId）+ 同代际」的迟到快照；
	// 正常流式中绑定仍在（agentId 存在），同代际快照必须照常写入。
	const atoms = loadAtoms();
	const store = createStore();
	const emit = (event) => store.set(atoms.applySessionRuntimeEventAtom, event);
	emit({
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:state",
		payload: { id: "agent-a", status: "running" },
	});
	emit({
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: { agentId: "agent-a", messages: [{ id: "m1", role: "user", text: "q" }] },
	});
	// 流式增量（同代际、绑定未消失）：照常合并
	emit({
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: { agentId: "agent-a", upsertFrom: 1, totalLength: 2, messages: [{ id: "m2", role: "assistant", text: "a" }] },
	});
	assert.deepEqual([...store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages.map((m) => m.id)], ["m1", "m2"]);

	// closed 状态但绑定未清除（agentId 仍在）：写入仍被接受——主进程 stop/close 路径
	// 已通过 cancelMessageEmit 取消节流定时器，不会发出迟到快照，渲染层无需额外拦截。
	emit({
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:state",
		payload: { id: "agent-a", status: "closed" },
	});
	emit({
		sessionId: "session-a",
		agentId: "agent-a",
		runtimeGeneration: 1,
		sourceChannel: "agents:message",
		payload: {
			agentId: "agent-a",
			messages: [
				{ id: "m1", role: "user", text: "q" },
				{ id: "m2", role: "assistant", text: "final" },
			],
		},
	});
	assert.equal(store.get(atoms.sessionMessagesCacheAtom)["session-a"].messages[1].text, "final");
});

test("prependSessionMessagePageAtom trims overflowing oldest messages and advances cursor", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];
	const LIMIT = atoms.DISK_HISTORY_MESSAGE_LIMIT;
	const makeMessages = (count, prefix, start) =>
		Array.from({ length: count }, (_, i) => ({
			id: `${prefix}${start + i}`,
			role: "user",
			text: `${prefix}${start + i}`,
			meta: { entryId: `e${start + i}` },
		}));

	// 初始 disk 缓存恰好差 1 条到上限（游标 = 文件下标空间，nextBefore = 最旧下标）
	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-a",
		messages: makeMessages(LIMIT - 1, "m", 0),
		source: "disk",
		page: { total: LIMIT + 5, nextBefore: LIMIT - 1 },
	});
	assert.equal(entry().messages.length, LIMIT - 1);

	// prepend 3 条更早页 → 溢出 2 条，只丢新页头部 2 条：
	// 保留段最旧一条的下标 = 页最旧下标(2396) + 丢弃数(2) = 2398
	assert.equal(
		store.set(atoms.prependSessionMessagePageAtom, {
			sessionId: "session-a",
			expectedRevision: entry().revision,
			before: LIMIT - 1,
			page: {
				messages: makeMessages(3, "h", -3),
				total: LIMIT + 5,
				nextBefore: LIMIT - 4,
			},
		}),
		true,
	);
	assert.equal(entry().messages.length, LIMIT, "裁剪后不超过上限");
	assert.equal(entry().messages[0].id, "h-1", "最旧的溢出条被丢弃，第三条保留");
	assert.equal(entry().page.nextBefore, LIMIT - 4 + 2, "部分丢弃：游标 = 页最旧下标 + 丢弃数");
	assert.equal(entry().messages[LIMIT - 1].id, "m2398", "当前视窗尾部不受影响");

	// 整页丢弃：再 prepend 2 条更早页（无重叠）→ 溢出 2 条恰好等于整页，
	// 游标回到请求游标（= 保留段最旧一条的文件下标）
	const beforeCursor = entry().page.nextBefore;
	assert.equal(
		store.set(atoms.prependSessionMessagePageAtom, {
			sessionId: "session-a",
			expectedRevision: entry().revision,
			before: beforeCursor,
			page: {
				messages: makeMessages(2, "g", -5),
				total: LIMIT + 5,
				nextBefore: beforeCursor - 2,
			},
		}),
		true,
	);
	assert.equal(entry().messages.length, LIMIT);
	assert.equal(entry().page.nextBefore, beforeCursor, "整页丢弃：游标回到请求游标");
	assert.equal(entry().messages[0].id, "h-1", "新页整体丢弃，原视窗原样保留");
});

test("prependSessionMessagePageAtom dedupes overlapping pages by entryId", () => {
	const atoms = loadAtoms();
	const store = createStore();
	const entry = () => store.get(atoms.sessionMessagesCacheAtom)["session-a"];
	const LIMIT = atoms.DISK_HISTORY_MESSAGE_LIMIT;

	store.set(atoms.cacheSessionMessagesAtom, {
		sessionId: "session-a",
		messages: [
			{ id: "m1", role: "user", text: "q1", meta: { entryId: "e1" } },
			{ id: "m2", role: "assistant", text: "a1", meta: { entryId: "e2" } },
		],
		source: "disk",
		page: { total: 4, nextBefore: 2 },
	});

	// 页尾 e1/e2 与缓存头部重复（游标回退场景）→ 只并入新的 e0
	assert.equal(
		store.set(atoms.prependSessionMessagePageAtom, {
			sessionId: "session-a",
			expectedRevision: entry().revision,
			before: 2,
			page: {
				messages: [
					{ id: "m0", role: "user", text: "q0", meta: { entryId: "e0" } },
					{ id: "m1", role: "user", text: "q1", meta: { entryId: "e1" } },
					{ id: "m2", role: "assistant", text: "a1", meta: { entryId: "e2" } },
				],
				total: 4,
				nextBefore: 0,
			},
		}),
		true,
	);
	// vm realm 数组与字面量数组原型不同，需展开为本 realm 数组再比
	assert.deepEqual([...entry().messages.map((m) => m.meta.entryId)], ["e0", "e1", "e2"], "重叠部分按 entryId 去重，不重复显示");
	assert.equal(entry().messages.length, 3);
	assert.equal(entry().page.nextBefore, 0);
});
