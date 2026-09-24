import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const nodeRequire = createRequire(import.meta.url);
// 与 vm 内 require("react") / require("jotai") 共用同一份 CJS 实例：react-dom/server 的
// dispatcher 与 jotai 的 React context 必须来自同一模块实例，否则 hook 渲染不出值。
const React = nodeRequire("react");
const { renderToString } = nodeRequire("react-dom/server");
const { Provider, createStore } = nodeRequire("jotai");

// session-atoms 按 sessionId 记忆状态；这里显式共享同一实例，保证 hook 写进去的 atom
// 与测试读出来的 atom 是同一个（loadTsCommonJs 默认会各自加载一份）。
const sessionAtoms = loadTsCommonJs("src/renderer/src/atoms/session-atoms.ts");
const stateModule = loadTsCommonJs("src/renderer/src/components/session/turn/useProcessGroupState.ts", {
	stubs: { "../../../atoms/session-atoms": sessionAtoms },
});

const { EMPTY_PROCESS_GROUP_STATE, advanceAutoGroup, isGroupOpen, resetProcessGroupState, toggleGroupByUser, useProcessGroupOpenState } = stateModule;

/**
 * 跨 realm 归一化：loadTsCommonJs 在独立 vm realm 执行，vm 里的 Object/Array 原型与宿主
 * 不同，deepEqual 会因原型不同判不等 —— 先 JSON 往返剥掉原型再比对（仓库既有手法）。
 * autoGroupId 的 undefined 会在 JSON 里被丢掉，统一补成 null 便于整体比对。
 */
function snapState(state) {
	return JSON.parse(JSON.stringify({ autoGroupId: state.autoGroupId ?? null, manualGroupIds: Array.from(state.manualGroupIds) }));
}
const EMPTY_SNAPSHOT = { autoGroupId: null, manualGroupIds: [] };

function stateOf(autoGroupId, manualGroupIds) {
	return { autoGroupId, manualGroupIds };
}

// ---------------------------------------------------------------------------
// 纯函数：契约 §3 冻结接口
// ---------------------------------------------------------------------------

test("导出的冻结签名齐全（名字不得漂移）", () => {
	assert.equal(typeof advanceAutoGroup, "function");
	assert.equal(typeof isGroupOpen, "function");
	assert.equal(typeof toggleGroupByUser, "function");
	assert.equal(typeof resetProcessGroupState, "function");
	assert.equal(typeof useProcessGroupOpenState, "function");
	assert.deepEqual(snapState(EMPTY_PROCESS_GROUP_STATE), EMPTY_SNAPSHOT);
});

test("isGroupOpen：自动槽与手动集合任一命中即为打开", () => {
	const state = stateOf("auto-1", ["manual-1"]);
	assert.equal(isGroupOpen(state, "auto-1"), true);
	assert.equal(isGroupOpen(state, "manual-1"), true);
	assert.equal(isGroupOpen(state, "other"), false);
	assert.equal(isGroupOpen(EMPTY_PROCESS_GROUP_STATE, "any"), false);
});

test("advanceAutoGroup：推进到新组后旧自动组自动关闭", () => {
	const first = advanceAutoGroup(EMPTY_PROCESS_GROUP_STATE, "grp:1");
	assert.equal(isGroupOpen(first, "grp:1"), true);
	assert.deepEqual(snapState(first), { autoGroupId: "grp:1", manualGroupIds: [] });

	const second = advanceAutoGroup(first, "grp:2");
	assert.equal(isGroupOpen(second, "grp:2"), true);
	assert.equal(isGroupOpen(second, "grp:1"), false, "旧自动组必须随推进关闭");
	assert.deepEqual(snapState(second), { autoGroupId: "grp:2", manualGroupIds: [] });
});

test("advanceAutoGroup：手动集合不受推进影响（用户点开的组一直开着）", () => {
	const manual = toggleGroupByUser(EMPTY_PROCESS_GROUP_STATE, "grp:manual", true);
	const one = advanceAutoGroup(manual, "grp:1");
	const two = advanceAutoGroup(one, "grp:2");
	assert.equal(isGroupOpen(two, "grp:manual"), true, "新组出现不得关掉手动打开的组");
	assert.equal(isGroupOpen(two, "grp:1"), false);
	assert.equal(isGroupOpen(two, "grp:2"), true);
	assert.deepEqual(snapState(two), { autoGroupId: "grp:2", manualGroupIds: ["grp:manual"] });
});

test("advanceAutoGroup：同值返回原引用（含 undefined → undefined）", () => {
	assert.equal(advanceAutoGroup(EMPTY_PROCESS_GROUP_STATE, undefined), EMPTY_PROCESS_GROUP_STATE);
	const state = advanceAutoGroup(EMPTY_PROCESS_GROUP_STATE, "grp:1");
	assert.equal(advanceAutoGroup(state, "grp:1"), state);
	const cleared = advanceAutoGroup(state, undefined);
	assert.notEqual(cleared, state);
	assert.equal(advanceAutoGroup(cleared, undefined), cleared);
});

test("toggleGroupByUser(open=true)：加入手动集合；占着自动槽时同时清空", () => {
	// 该组正占自动槽：用户接手 → 自动槽清空，手工集合接管
	const autoState = advanceAutoGroup(EMPTY_PROCESS_GROUP_STATE, "grp:1");
	const takenOver = toggleGroupByUser(autoState, "grp:1", true);
	assert.equal(takenOver.autoGroupId, undefined, "用户手开自动组时必须清空自动槽");
	assert.deepEqual(snapState(takenOver), { autoGroupId: null, manualGroupIds: ["grp:1"] });
	assert.equal(isGroupOpen(takenOver, "grp:1"), true);

	// 该组没占自动槽：自动槽保持不动
	const kept = toggleGroupByUser(autoState, "grp:2", true);
	assert.deepEqual(snapState(kept), { autoGroupId: "grp:1", manualGroupIds: ["grp:2"] });

	// 已在手动集合且不占自动槽：同值返回原引用
	assert.equal(toggleGroupByUser(kept, "grp:2", true), kept);
});

test("toggleGroupByUser(open=false)：从手动集合移除；占自动槽也一并清空", () => {
	const manual = { autoGroupId: "grp:auto", manualGroupIds: ["grp:manual", "grp:auto"] };

	const closedManual = toggleGroupByUser(manual, "grp:manual", false);
	assert.deepEqual(snapState(closedManual), { autoGroupId: "grp:auto", manualGroupIds: ["grp:auto"] });

	// 点关的组正占自动槽：必须同时清空自动槽（否则下次重算又会自动弹开）
	const closedAuto = toggleGroupByUser(manual, "grp:auto", false);
	assert.equal(closedAuto.autoGroupId, undefined);
	assert.equal(isGroupOpen(closedAuto, "grp:auto"), false, "点关后不得再被任何通道命中");
	assert.deepEqual(snapState(closedAuto), { autoGroupId: null, manualGroupIds: ["grp:manual"] });

	// 两个通道都没命中：同值返回原引用
	assert.equal(toggleGroupByUser(manual, "grp:missing", false), manual);
	assert.equal(toggleGroupByUser(EMPTY_PROCESS_GROUP_STATE, "grp:any", false), EMPTY_PROCESS_GROUP_STATE);
});

test("resetProcessGroupState：两通道一起清空，返回空常量原引用", () => {
	const opened = toggleGroupByUser(advanceAutoGroup(EMPTY_PROCESS_GROUP_STATE, "grp:1"), "grp:2", true);
	const reset = resetProcessGroupState();
	assert.equal(reset, EMPTY_PROCESS_GROUP_STATE);
	assert.notEqual(reset, opened);
	assert.deepEqual(snapState(reset), EMPTY_SNAPSHOT);
	assert.equal(isGroupOpen(reset, "grp:1"), false);
	assert.equal(isGroupOpen(reset, "grp:2"), false);
	assert.equal(resetProcessGroupState(), resetProcessGroupState());
});

test("纯函数不修改入参：冻结入参调用不抛错、值不变", () => {
	const frozen = Object.freeze({ autoGroupId: "grp:auto", manualGroupIds: Object.freeze(["grp:manual"]) });
	const before = snapState(frozen);
	assert.doesNotThrow(() => {
		isGroupOpen(frozen, "grp:auto");
		advanceAutoGroup(frozen, "grp:next");
		advanceAutoGroup(frozen, "grp:auto");
		advanceAutoGroup(frozen, undefined);
		toggleGroupByUser(frozen, "grp:manual", false);
		toggleGroupByUser(frozen, "grp:new", true);
		toggleGroupByUser(frozen, "grp:auto", true);
		toggleGroupByUser(frozen, "grp:auto", false);
		resetProcessGroupState();
	});
	assert.deepEqual(snapState(frozen), before, "入参不得被就地修改");
	assert.equal(advanceAutoGroup(frozen, "grp:auto"), frozen, "冻结入参 + 同值 → 原引用");
});

// ---------------------------------------------------------------------------
// Jotai 窄 hook：useProcessGroupOpenState（契约 §3 集成签名）
// ---------------------------------------------------------------------------

/** 用 React SSR 渲染一次 hook 并把返回的句柄抓出来（renderToString 无状态，重渲染即重挂载）。 */
function renderProbe(store, sessionId, runId) {
	let captured;
	function Probe() {
		captured = useProcessGroupOpenState(sessionId, runId);
		return null;
	}
	renderToString(React.createElement(Provider, { store }, React.createElement(Probe)));
	return captured;
}

test("hook：toggleGroup / syncLatestGroup / reset 写回按 sessionId→runId 记忆的 atom", () => {
	const store = createStore();
	const mapAtom = sessionAtoms.processGroupOpenBySessionIdAtomFamily("session-hook");

	let handle = renderProbe(store, "session-hook", "run-1");
	assert.deepEqual(snapState(handle.groupState), EMPTY_SNAPSHOT);

	handle.syncLatestGroup("grp:1");
	handle = renderProbe(store, "session-hook", "run-1");
	assert.deepEqual(snapState(handle.groupState), { autoGroupId: "grp:1", manualGroupIds: [] });

	handle.toggleGroup("grp:manual", true);
	handle = renderProbe(store, "session-hook", "run-1");
	assert.deepEqual(snapState(handle.groupState), { autoGroupId: "grp:1", manualGroupIds: ["grp:manual"] });

	// 换 run 不串台：同会话另一个 run 的状态独立
	handle = renderProbe(store, "session-hook", "run-2");
	assert.deepEqual(snapState(handle.groupState), EMPTY_SNAPSHOT);

	handle = renderProbe(store, "session-hook", "run-1");
	handle.reset();
	handle = renderProbe(store, "session-hook", "run-1");
	assert.deepEqual(snapState(handle.groupState), EMPTY_SNAPSHOT, "reset 后本轮两通道清空");
	assert.deepEqual(JSON.parse(JSON.stringify(store.get(mapAtom))), {}, "run-1 条目被清掉，runId 不堆积");
});

test("hook：syncLatestGroup 同值短路（最新组 id 没变时绝不写 atom / 不通知订阅者）", () => {
	const store = createStore();
	const mapAtom = sessionAtoms.processGroupOpenBySessionIdAtomFamily("session-sync");
	const handle = renderProbe(store, "session-sync", "run-1");

	let notifications = 0;
	store.sub(mapAtom, () => {
		notifications += 1;
	});

	handle.syncLatestGroup("grp:1");
	assert.equal(notifications, 1, "首次推进要写 atom");
	const afterFirst = store.get(mapAtom);

	handle.syncLatestGroup("grp:1");
	assert.equal(notifications, 1, "最新组 id 未变：不得再写 atom");
	assert.equal(store.get(mapAtom), afterFirst, "map 必须保持原引用");

	handle.syncLatestGroup("grp:2");
	assert.equal(notifications, 2, "最新组变化：推进自动槽");
	assert.equal(store.get(mapAtom)["run-1"].autoGroupId, "grp:2");

	handle.syncLatestGroup(undefined);
	assert.equal(notifications, 3, "最新组消失：清空自动槽");
	assert.equal(store.get(mapAtom)["run-1"].autoGroupId, undefined);
});

test("hook：用户点关最新组后，重复同步同一个最新组 id 不得重新弹开", () => {
	const store = createStore();
	const mapAtom = sessionAtoms.processGroupOpenBySessionIdAtomFamily("session-close");
	const handle = renderProbe(store, "session-close", "run-1");

	handle.syncLatestGroup("grp:1");
	handle.toggleGroup("grp:1", false);
	assert.equal(store.get(mapAtom)["run-1"].autoGroupId, undefined, "点关正占自动槽的组必须清空自动槽");
	assert.equal(isGroupOpen(store.get(mapAtom)["run-1"], "grp:1"), false);

	handle.syncLatestGroup("grp:1");
	assert.equal(isGroupOpen(store.get(mapAtom)["run-1"], "grp:1"), false, "同值同步不得把它重新弹开");
});

test("纯函数：用户主动关掉自动组后抑制位随状态保存，reset 解除抑制", () => {
	const opened = advanceAutoGroup(EMPTY_PROCESS_GROUP_STATE, "grp:1");
	const closed = toggleGroupByUser(opened, "grp:1", false);
	assert.equal(isGroupOpen(closed, "grp:1"), false, "点关后两个通道都不再命中");
	// 抑制位在状态里（不是隐藏 ref）：同值同步不得把它重新弹开
	assert.equal(advanceAutoGroup(closed, "grp:1"), closed, "同值同步返回原引用（含抑制语义）");
	// 新组照常推进自动槽
	assert.equal(advanceAutoGroup(closed, "grp:2").autoGroupId, "grp:2");
	// reset（大折叠栏关闭）= 两通道 + 抑制位一起清空 → 最新组可以再次自动展开
	const afterReset = resetProcessGroupState();
	assert.equal(advanceAutoGroup(afterReset, "grp:1").autoGroupId, "grp:1", "reset 后抑制位必须解除");
});

test("回归：关掉大折叠栏再打开，最新组必须重新自动展开", () => {
	// 复现的缺陷：抑制位原本放在 hook 的隐藏 ref 里，reset 只清 atom、不清 ref，
	// 于是重开大折叠栏时 syncLatestGroup 被「同值短路」吃掉，最新组不再自动展开
	// ——违背已确认语义「大折叠栏展开时自动展开最新的过程组」。
	// 修法：把抑制位挪进状态对象，整条行为因此可纯函数化验证。
	const store = createStore();
	const mapAtom = sessionAtoms.processGroupOpenBySessionIdAtomFamily("session-reopen");
	const handle = renderProbe(store, "session-reopen", "run-1");

	handle.syncLatestGroup("grp:1");
	assert.equal(isGroupOpen(store.get(mapAtom)["run-1"], "grp:1"), true, "展开时自动槽指向最新组");

	handle.reset(); // 大折叠栏关闭
	assert.deepEqual(JSON.parse(JSON.stringify(store.get(mapAtom))), {}, "关闭后本轮状态清空");

	handle.syncLatestGroup("grp:1"); // 重新打开大折叠栏
	assert.equal(isGroupOpen(store.get(mapAtom)["run-1"], "grp:1"), true, "重开后最新组必须重新自动展开（回归点）");
});

test("hook：sessionId / runId 为空时 groupState 为空常量、三条命令安全 no-op", () => {
	// 无 sessionId + 无 runId
	const noSessionStore = createStore();
	const noSession = renderProbe(noSessionStore, undefined, undefined);
	assert.equal(noSession.groupState, EMPTY_PROCESS_GROUP_STATE);
	assert.doesNotThrow(() => {
		noSession.toggleGroup("grp:1", true);
		noSession.syncLatestGroup("grp:1");
		noSession.reset();
	});
	assert.deepEqual(JSON.parse(JSON.stringify(noSessionStore.get(sessionAtoms.processGroupOpenBySessionIdAtomFamily("")))), {}, "空 session 不得被写入");

	// 有 sessionId 但无 runId：命令同样 no-op，不产生任何 runId 条目
	const store = createStore();
	const emptyRun = renderProbe(store, "session-no-run", undefined);
	assert.equal(emptyRun.groupState, EMPTY_PROCESS_GROUP_STATE);
	assert.doesNotThrow(() => {
		emptyRun.toggleGroup("grp:1", true);
		emptyRun.syncLatestGroup("grp:1");
		emptyRun.reset();
	});
	assert.deepEqual(JSON.parse(JSON.stringify(store.get(sessionAtoms.processGroupOpenBySessionIdAtomFamily("session-no-run")))), {});
});
