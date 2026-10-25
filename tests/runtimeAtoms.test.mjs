import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

function session(id, projectId, title = id) {
	return {
		id,
		projectId,
		title,
		environment: "native",
		source: "pi",
		createdAt: 1,
		updatedAt: 1,
	};
}

function runtime(sessionId, agentId, projectId, generation = 1, status = "idle") {
	return {
		sessionId,
		agentId,
		runtimeGeneration: generation,
		projectId,
		cwd: `C:/${projectId}`,
		status,
		createdAt: generation,
	};
}

function runtimeEvent(sessionId, agentId, generation, sourceChannel, payload, kind = "event") {
	return {
		kind,
		sessionId,
		agentId,
		runtimeGeneration: generation,
		sourceChannel,
		payload,
	};
}

test("agent inventory is a read-only projection of canonical Session runtimes", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("session-a", "project-a", "Stable title")],
	});
	store.set(atoms.replaceSessionRuntimesAtom, [runtime("session-a", "agent-a", "project-a")]);

	assert.equal(store.get(atoms.agentByIdAtomFamily("agent-a")).title, "Stable title");
	assert.equal(
		store
			.get(atoms.agentsByProjectIdAtomFamily("project-a"))
			.map((agent) => agent.id)
			.join(","),
		"agent-a",
	);
	assert.equal(atoms.replaceAgentInventoryAtom, undefined);
	assert.equal(atoms.upsertAgentInventoryAtom, undefined);
});

test("runtime ui table keeps identity when non-ui events stream in (sidebar re-render guard)", () => {
	// 场景（2027-02 性能审计）：会话曾有 ui-request（ask/widget 历史）后，
	// 流式期间 50ms 节流的 sessions:messages flush / agents:runtime-state 轮询
	// 都带 payload 进 applySessionRuntimeUiEvent，返回原引用却仍被整表写回，
	// 侧栏五棵树的整表订阅者每秒全量重渲染数十次。
	// 必须与下面的事件写入用同一次加载：loadTsCommonJs 每次调用是独立缓存，
	// 两次加载 = 两份模块实例，读到的会是永远为空的另一张 UI 表。
	const sessionAtoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
	const store = createStore();
	store.set(sessionAtoms.replaceProjectSessionsAtom, { projectId: "project-a", sessions: [session("session-a", "project-a")] });
	store.set(sessionAtoms.replaceSessionRuntimesAtom, [runtime("session-a", "agent-a", "project-a", 1, "running")]);

	// 建立一个 UI 条目（pending select 请求），使该会话进入「有 UI 历史」状态
	store.set(sessionAtoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "agents:ui-request", { method: "select", requestId: "req-1", title: "pick", options: ["A"] }));
	const uiAtom = sessionAtoms.sessionRuntimeUiByIdAtom;
	const withRequest = store.get(uiAtom);
	assert.ok(withRequest["session-a"]?.requests?.["req-1"], "前置：UI 请求条目已建立");

	// 流式/轮询类事件连发：UI 表引用不得变化（值未变，写回只会换 Record 身份）
	store.set(sessionAtoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "agents:runtime-state", { state: { isStreaming: true } }));
	const afterStream = store.get(uiAtom);
	assert.equal(afterStream, withRequest, "非 ui-request 事件不得触碰 UI 表身份");
	store.set(sessionAtoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "sessions:messages", { messages: [] }));
	assert.equal(store.get(uiAtom), withRequest, "messages flush 同样不得触碰 UI 表身份");

	// 真实 UI 变化必须照常生效（引用更新 + revision 推进）
	store.set(sessionAtoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "agents:ui-request", { method: "select", requestId: "req-1", completed: true, value: "a" }));
	const afterComplete = store.get(uiAtom);
	assert.notEqual(afterComplete, withRequest, "真实 UI 变化必须写回新表");
	assert.equal(afterComplete["session-a"]?.requests?.["req-1"]?.status, "completed");
});

test("agent inventory keeps the same array when runtime identity is unchanged", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("session-a", "project-a", "Stable title")],
	});
	store.set(atoms.replaceSessionRuntimesAtom, [runtime("session-a", "agent-a", "project-a")]);
	const first = store.get(atoms.agentInventoryAtom);
	store.set(
		atoms.applySessionRuntimeEventAtom,
		runtimeEvent("session-a", "agent-a", 1, "agents:state", {
			id: "agent-a",
			projectId: "project-a",
			cwd: "C:/project-a",
			title: "Stable title",
			status: "idle",
			createdAt: 1,
		}),
	);
	const second = store.get(atoms.agentInventoryAtom);
	// 无实质字段变化时不得换新数组：App 的 useEffect([agents]) / displayAgents
	// 会跟着每帧 setState，把设置弹层和关窗点死。
	assert.equal(second, first);
});

test("runtime capabilities merge in the canonical Session runtime without message data", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("session-a", "project-a")],
	});
	store.set(atoms.replaceSessionRuntimesAtom, [runtime("session-a", "agent-a", "project-a")]);
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "agents:runtime-state", { agentId: "agent-a", state: { modelName: "Model A", isStreaming: true } }));
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "agents:runtime-state", { agentId: "agent-a", state: { isExecutingTool: true } }));

	const capability = store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("agent-a"));
	assert.equal(capability.modelName, "Model A");
	assert.equal(capability.isStreaming, true);
	assert.equal(capability.isExecutingTool, true);
	assert.equal("messages" in capability, false);
	assert.equal(atoms.applyRuntimeCapabilityAtom, undefined);
});

test("project capability selectors ignore unrelated canonical Session updates", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("session-a", "project-a")],
	});
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-b",
		sessions: [session("session-b", "project-b")],
	});
	store.set(atoms.replaceSessionRuntimesAtom, [runtime("session-a", "agent-a", "project-a"), runtime("session-b", "agent-b", "project-b")]);
	for (const [sessionId, agentId, modelName] of [
		["session-a", "agent-a", "Model A"],
		["session-b", "agent-b", "Model B"],
	]) {
		store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent(sessionId, agentId, 1, "agents:runtime-state", { agentId, state: { modelName } }));
	}

	const projectAAtom = atoms.runtimeCapabilitiesByProjectIdAtomFamily("project-a");
	const before = store.get(projectAAtom);
	let notifications = 0;
	const unsubscribe = store.sub(projectAAtom, () => {
		notifications += 1;
	});

	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-b", "agent-b", 1, "agents:runtime-state", { agentId: "agent-b", state: { isStreaming: true } }));
	assert.equal(store.get(projectAAtom), before);
	assert.equal(notifications, 0);

	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "agents:runtime-state", { agentId: "agent-a", state: { isStreaming: true } }));
	assert.notEqual(store.get(projectAAtom), before);
	assert.equal(notifications, 1);
	unsubscribe();
});

test("replacement binding clears stale runtime state before new events arrive", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("session-a", "project-a")],
	});
	// 旧绑定 agent-a（generation 1）带旧模型 state
	store.set(atoms.replaceSessionRuntimesAtom, [runtime("session-a", "agent-a", "project-a", 1)]);
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "agents:runtime-state", { agentId: "agent-a", state: { modelName: "Old Model", provider: "old" } }));
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state.modelName, "Old Model");

	// 新绑定 agent-b（generation 2）attach：只推 agents:state（tab 无 state 字段），
	// 模拟懒启动后 applyPreferences 的 runtime-state 事件尚未到达的窗口期。
	store.set(
		atoms.applySessionRuntimeEventAtom,
		runtimeEvent("session-a", "agent-b", 2, "agents:state", {
			id: "agent-b",
			projectId: "project-a",
			cwd: "C:/project-a",
			title: "replacement",
			status: "idle",
			createdAt: 2,
		}),
	);
	// bindingChanged 必须清空残留 state：底栏 state?.modelName 回退到 record，而不是旧模型。
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].agentId, "agent-b");
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state, undefined);

	// 新绑定收到 runtime-state 事件后 state 正常填充
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-b", 2, "agents:runtime-state", { agentId: "agent-b", state: { modelName: "New Model", provider: "new" } }));
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state.modelName, "New Model");
});

test("late events from runtime A cannot revive its inventory or capabilities after replacement B", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("session-a", "project-a")],
	});
	store.set(atoms.replaceSessionRuntimesAtom, [runtime("session-a", "agent-a", "project-a", 2)]);
	store.set(
		atoms.applySessionRuntimeEventAtom,
		runtimeEvent("session-a", "agent-b", 3, "agents:state", {
			id: "agent-b",
			projectId: "project-a",
			cwd: "C:/project-a",
			title: "replacement",
			status: "idle",
			createdAt: 3,
		}),
	);
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-b", 3, "agents:runtime-state", { agentId: "agent-b", state: { modelName: "B", isStreaming: true } }));

	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 2, "agents:state", { id: "agent-a", projectId: "project-a", cwd: "C:/project-a", title: "old", status: "closed", createdAt: 1 }));
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 2, "agents:detach", undefined, "detach"));

	assert.equal(
		store
			.get(atoms.agentInventoryAtom)
			.map((agent) => agent.id)
			.join(","),
		"agent-b",
	);
	assert.equal(store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("agent-a")), undefined);
	assert.equal(store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("agent-b")).modelName, "B");
});

test("terminal status (error/closed) drops runtime state and rejects late runtime-state refills", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("session-a", "project-a")],
	});
	store.set(atoms.replaceSessionRuntimesAtom, [runtime("session-a", "agent-a", "project-a", 1, "running")]);
	// 先填入运行时状态，模拟 agent 运行期 goal/todos/model 已就绪
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "agents:runtime-state", { agentId: "agent-a", state: { modelName: "Model A", isStreaming: true } }));
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state.modelName, "Model A");

	// 进入终态：error。终态后 state 应被清空（仅保留 status 等轻量身份字段）。
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "agents:state", { id: "agent-a", projectId: "project-a", cwd: "C:/project-a", title: "t", status: "error", createdAt: 1 }));
	const terminal = store.get(atoms.sessionRuntimeByIdAtom)["session-a"];
	assert.equal(terminal.status, "error");
	assert.equal(terminal.state, undefined, "terminal status must drop runtime state");

	// 同绑定迟到的 runtime-state 事件不得把 state 填回（否则回收失效）。
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-a", "agent-a", 1, "agents:runtime-state", { agentId: "agent-a", state: { modelName: "Late Model" } }));
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-a"].state, undefined, "late runtime-state must not revive state after terminal status");
});

test("fork replacement detaches the origin session and binds the fork record to the same agent", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("session-origin", "project-a", "Origin"), session("session-fork", "project-a", "Fork")],
	});
	store.set(atoms.replaceSessionRuntimesAtom, [runtime("session-origin", "agent-a", "project-a", 1, "running")]);
	// 主进程 fork 广播顺序：detach 旧绑定 → attach 新绑定（runtimeGeneration 递增）
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-origin", "agent-a", 1, "sessions:runtime-detach", null, "detach"));
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("session-fork", "agent-a", 2, "agents:state", { id: "agent-a", projectId: "project-a", cwd: "C:/project-a", title: "Fork", status: "idle", createdAt: 2 }));
	// 旧会话不再持有 live runtime（侧栏按历史行展示，不再显示运行中）；
	// detached 条目按设计丢弃 agentId（不保留可反查的活 agent 身份）
	const origin = store.get(atoms.sessionRuntimeByIdAtom)["session-origin"];
	assert.equal(origin.status, "detached");
	assert.equal(origin.agentId, undefined);
	// 同一 agent 换绑到 fork 记录
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-fork"].agentId, "agent-a");
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["session-fork"].status, "idle");
	// agent 清单只保留 fork 记录，且不会把旧会话视为 live
	const agents = store.get(atoms.agentInventoryAtom);
	assert.equal(
		agents.some((agent) => agent.id === "agent-a" && agent.sessionId === "session-origin"),
		false,
	);
	assert.equal(
		agents.some((agent) => agent.id === "agent-a"),
		true,
	);
});

test("agents:state 事件透传 deckSessionId 到 agent 清单（ACP 侧栏配对依赖）", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("deck-sess-1", "project-a", "ACP 会话")],
	});
	// ACP 激活：主进程 tab 带 deckSessionId（PiDeck 会话身份），状态 starting → idle。
	// 若渲染层把 deckSessionId 丢掉，侧栏 ACP「agent↔会话」配对永不命中，
	// 同一会话会被画成「agent 行 + 会话行」两行（2027-03 重复会话事故）。
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("deck-sess-1", "agent-acp", 1, "agents:state", { id: "agent-acp", projectId: "project-a", cwd: "C:/project-a", title: "ACP 会话", status: "starting", createdAt: 1, deckSessionId: "deck-sess-1", backend: "acp" }));

	const runtimeEntry = store.get(atoms.sessionRuntimeByIdAtom)["deck-sess-1"];
	assert.equal(runtimeEntry.deckSessionId, "deck-sess-1");

	const tab = store.get(atoms.agentByIdAtomFamily("agent-acp"));
	assert.equal(tab.deckSessionId, "deck-sess-1");
	assert.equal(tab.backend, "acp");

	// selectAtom 相等比较必须覆盖 deckSessionId：同代事件只更新该字段时清单仍要重发。
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("deck-sess-1", "agent-acp", 1, "agents:state", { id: "agent-acp", projectId: "project-a", cwd: "C:/project-a", title: "ACP 会话", status: "idle", createdAt: 1, deckSessionId: "deck-sess-1", backend: "acp" }));
	assert.equal(store.get(atoms.agentByIdAtomFamily("agent-acp"))?.status, "idle");
});

test("listRuntimes 快照缺 deckSessionId 时不冲掉事件流已写入的身份", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("deck-sess-2", "project-a", "ACP 会话 2")],
	});
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("deck-sess-2", "agent-acp-2", 1, "agents:state", { id: "agent-acp-2", projectId: "project-a", cwd: "C:/project-a", title: "ACP 会话 2", status: "idle", createdAt: 1, deckSessionId: "deck-sess-2", backend: "acp" }));
	// 旧主进程/快照未带 deckSessionId：不能把已知身份抹回 undefined。
	store.set(atoms.replaceSessionRuntimesAtom, [runtime("deck-sess-2", "agent-acp-2", "project-a", 1, "idle")]);
	assert.equal(store.get(atoms.agentByIdAtomFamily("agent-acp-2")).deckSessionId, "deck-sess-2");
});

test("激活窗口合成 starting 事件（agentId 空占位）能推进发送态并被真实事件接管", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("deck-act-1", "project-a", "ACP 激活")],
	});
	// 审计发现 A：coordinator bind() 之前 emitSessionRuntimeEvent 丢弃一切状态事件，
	// 主进程在激活 IPC 入口发 session 级合成 starting（agentId=""、代数取 bind 前值）。
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("deck-act-1", "", 0, "agents:state", { status: "starting" }));
	let runtimeEntry = store.get(atoms.sessionRuntimeByIdAtom)["deck-act-1"];
	assert.equal(runtimeEntry.status, "starting", "合成事件必须立即可见（加载动画数据源）");

	// 激活进行中发送：activating 的发送态必须被 starting 推进到 sending（首回合卡 activating 修复）
	store.set(atoms.setSessionSendStateAtom, { sessionId: "deck-act-1", state: { status: "activating", requestId: "req-1" } });
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("deck-act-1", "", 0, "agents:state", { status: "starting" }));
	assert.equal(store.get(atoms.sessionSendStateByIdAtom)["deck-act-1"].status, "sending");

	// 激活完成：真实 agent 的同代 agents:state 事件不被空 agentId 挡住，deckSessionId/backend 落地
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("deck-act-1", "agent-real", 1, "agents:state", { id: "agent-real", projectId: "project-a", cwd: "C:/project-a", title: "ACP 激活", status: "idle", createdAt: 2, deckSessionId: "deck-act-1", backend: "acp" }));
	runtimeEntry = store.get(atoms.sessionRuntimeByIdAtom)["deck-act-1"];
	assert.equal(runtimeEntry.agentId, "agent-real");
	assert.equal(runtimeEntry.status, "idle");
	assert.equal(runtimeEntry.deckSessionId, "deck-act-1", "侧栏 ACP 配对身份必须随激活完成立即落地");
	assert.equal(runtimeEntry.backend, "acp");
});

test("runtimeUnchanged 守卫覆盖 backend/deckSessionId：仅身份字段变化不得吞写", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("deck-act-2", "project-a", "守卫字段")],
	});
	// agents:runtime-state 只建 state 不带身份 → 条目缺 deckSessionId/backend；
	// 随后同 agentId、同状态(手动构造 idle→idle) 的 agents:state 只补身份字段：
	// 旧守卫比较列表缺这两个字段 → runtimeUnchanged=true → 写入被跳过 → 配对身份丢失。
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("deck-act-2", "agent-g", 1, "agents:runtime-state", { agentId: "agent-g", state: { isStreaming: false } }));
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("deck-act-2", "agent-g", 1, "agents:state", { id: "agent-g", projectId: "project-a", cwd: "C:/project-a", title: "守卫字段", status: "idle", createdAt: 1, deckSessionId: "deck-act-2", backend: "acp" }));
	const runtimeEntry = store.get(atoms.sessionRuntimeByIdAtom)["deck-act-2"];
	assert.equal(runtimeEntry.deckSessionId, "deck-act-2", "仅 deckSessionId 变化也必须写入条目");
	assert.equal(runtimeEntry.backend, "acp");
});

test("合成 starting 事件不产生空 agentId 的侧栏 agent 行", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "project-a",
		sessions: [session("deck-act-3", "project-a", "无幽灵行")],
	});
	store.set(atoms.applySessionRuntimeEventAtom, runtimeEvent("deck-act-3", "", 0, "agents:state", { status: "starting" }));
	// agent 清单投影要求 agentId/projectId/cwd/createdAt 齐全：空 agentId 必须被过滤，
	// 否则激活窗口会在侧栏画出一行无身份的「幽灵 agent」。
	const agents = store.get(atoms.agentsByProjectIdAtomFamily("project-a"));
	assert.equal(agents.length, 0);
	assert.equal(store.get(atoms.sessionRuntimeByIdAtom)["deck-act-3"].status, "starting", "加载态数据源不受影响");
});
