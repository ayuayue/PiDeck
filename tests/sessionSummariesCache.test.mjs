/**
 * 会话摘要派生缓存（2027-02 性能治理）。
 *
 * 契约：
 * 1. 同一 sessionRecordsAtom 引用下重复读同一 projectId → 返回**同一个数组引用**
 *    （否则每次 catalog 写入都会让 App 根 / composer 侧重渲）；
 * 2. 未变化的会话拿到同一个 summary 对象引用（下游 memo 可跳过）；
 * 3. 会话内容真的变了 → 新数组 + 该条新对象。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

function record(id, projectId, updatedAt, title = id) {
	return {
		id,
		projectId,
		title,
		filePath: `/p/${id}.jsonl`,
		environment: "native",
		source: "pi",
		createdAt: updatedAt,
		updatedAt,
		messageCount: 1,
	};
}

test("重复读同一项目：数组引用稳定，未变化会话的 summary 引用稳定", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, {
		projectId: "p1",
		sessions: [record("s1", "p1", 100), record("s2", "p1", 200)],
	});
	const family = atoms.sessionSummariesByProjectIdAtomFamily("p1");
	const first = store.get(family);
	assert.equal(first.length, 2);
	assert.equal(first[0].id, "s2", "按 updatedAt 降序");
	const again = store.get(family);
	assert.ok(again === first, "输入未变必须返回同一数组引用");
	// 另一个项目写记录：p1 的摘要不得被重建
	store.set(atoms.replaceProjectSessionsAtom, { projectId: "p2", sessions: [record("s9", "p2", 300)] });
	const afterOtherProject = store.get(family);
	assert.ok(afterOtherProject === first, "其它项目更新不得影响本项目的数组引用");
	// 真变化：新数组 + 变化的会话是新对象，其余仍是旧引用
	store.set(atoms.replaceProjectSessionsAtom, { projectId: "p1", sessions: [record("s1", "p1", 100), record("s2", "p1", 400, "s2-新标题")] });
	const changed = store.get(family);
	assert.notEqual(changed, first, "内容变化必须换数组");
	assert.equal(changed[0].name, "s2-新标题");
	assert.ok(changed[1] === first[1], "未变化的 s1 摘要沿用旧对象引用");
});
