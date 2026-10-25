/**
 * runtime 派生缓存（2027-02 性能治理）。
 *
 * 契约：
 * 1. runtime map / 会话记录都未变时，agentInventorySourceAtom 返回同一数组引用
 *    （否则每次 runtime 事件都会重跑 O(N log N) 建数组并分配全新 AgentTab）；
 * 2. runtime 能力反查结果与「逐条 find」语义一致（同一 agentId 取插入序第一个）；
 * 3. 同一 agentId 出现在多个会话时，能力表取第一条而非最后一条。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

function runtime(agentId, overrides = {}) {
	return {
		agentId,
		projectId: "p1",
		cwd: "/p",
		createdAt: 1,
		status: "idle",
		state: { agentId, pending: false },
		...overrides,
	};
}

test("runtime/records 未变时库存数组引用稳定", () => {
	const store = createStore();
	store.set(atoms.sessionRuntimeByIdAtom, { s1: runtime("a1") });
	const first = store.get(atoms.agentInventoryAtom);
	assert.equal(first.length, 1);
	const second = store.get(atoms.agentInventoryAtom);
	assert.ok(second === first, "输入未变必须复用同一数组（否则每次读都重建 O(N log N) + 全新对象）");
	// runtime 真有变化（新 map 引用）才重建
	store.set(atoms.sessionRuntimeByIdAtom, { s1: runtime("a1", { status: "running" }) });
	const changed = store.get(atoms.agentInventoryAtom);
	assert.notEqual(changed, first, "输入变化必须重建");
	assert.equal(changed[0].status, "running");
});

test("能力反查与逐条 find 语义一致（同 agentId 取插入序第一个）", () => {
	const store = createStore();
	// 两个会话共用同一 agentId：插入序第一个带 state A，第二个带 state B
	store.set(atoms.sessionRuntimeByIdAtom, {
		s1: runtime("a1", { state: { agentId: "a1", tag: "first" } }),
		s2: runtime("a1", { state: { agentId: "a1", tag: "second" } }),
	});
	assert.equal(store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("a1")).tag, "first", "必须取插入序第一条");
	assert.equal(store.get(atoms.runtimeCapabilityByAgentIdAtomFamily("missing")), undefined, "未知 agent 无能力值");
});
