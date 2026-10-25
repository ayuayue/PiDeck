/**
 * 会话删除时 atomFamily 实例释放（2027-02 慢泄漏治理）。
 *
 * Jotai atomFamily 无自动 GC：按 sessionId 建过的实例必须显式 remove，否则一次
 * 运行内打开过的每个会话都永久驻留若干原子实例（含命令表、草稿、附件、回显文本）。
 * 本测试以「remove 后再取到的是**新的** atom 实例」作为可观测判据。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/index.ts");

function session(id, projectId = "p1") {
	return { id, projectId, title: id, environment: "native", source: "pi", createdAt: 1, updatedAt: 1 };
}

test("删除会话后：composer / 命令表 / outline / 侧栏状态等 family 实例被释放", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, { projectId: "p1", sessions: [session("s1")] });
	const families = [
		["sessionDraftBySessionIdAtomFamily", atoms.sessionDraftBySessionIdAtomFamily],
		["sessionAttachmentsBySessionIdAtomFamily", atoms.sessionAttachmentsBySessionIdAtomFamily],
		["sessionPasteFilesBySessionIdAtomFamily", atoms.sessionPasteFilesBySessionIdAtomFamily],
		["sessionQuotesBySessionIdAtomFamily", atoms.sessionQuotesBySessionIdAtomFamily],
		["sessionComposerModeBySessionIdAtomFamily", atoms.sessionComposerModeBySessionIdAtomFamily],
		["sessionSendStateBySessionIdAtomFamily", atoms.sessionSendStateBySessionIdAtomFamily],
		["sessionCommandsAtomFamily", atoms.sessionCommandsAtomFamily],
		["outlineItemsBySessionIdAtomFamily", atoms.outlineItemsBySessionIdAtomFamily],
		["sessionStatusInSidebarAtomFamily", atoms.sessionStatusInSidebarAtomFamily],
		["sessionRuntimeUiBySessionIdAtomFamily", atoms.sessionRuntimeUiBySessionIdAtomFamily],
		["sessionHistoryMutationOverlayBySessionIdAtomFamily", atoms.sessionHistoryMutationOverlayBySessionIdAtomFamily],
		["sessionRecordByIdAtomFamily", atoms.sessionRecordByIdAtomFamily],
	];
	const before = new Map();
	for (const [name, family] of families) {
		assert.equal(typeof family, "function", `${name} 必须是 atomFamily`);
		const atom = family("s1");
		store.get(atom); // 建实例
		before.set(name, atom);
	}
	// 删除会话
	store.set(atoms.removeSessionStateAtom, "s1");
	for (const [name, family] of families) {
		const after = family("s1");
		assert.notEqual(after, before.get(name), `${name} 的 s1 实例必须在删除会话时被 remove`);
	}
});

test("删除会话后：DSH 提问回显（含整段回答文本）键被清除", () => {
	const store = createStore();
	store.set(atoms.replaceProjectSessionsAtom, { projectId: "p1", sessions: [session("s2")] });
	store.set(atoms.clearAskEchoForSessionAtom, "s2");
	assert.equal(store.get(atoms.askEchoBySessionIdAtomFamily("s2")), undefined, "清空后回显查询为空");
	// 删除会话路径同样触发清理钩子（登记表里的写 atom）
	const beforeAtom = atoms.askEchoBySessionIdAtomFamily("s2");
	store.get(beforeAtom);
	store.set(atoms.removeSessionStateAtom, "s2");
	assert.notEqual(atoms.askEchoBySessionIdAtomFamily("s2"), beforeAtom, "删除会话必须释放回显 family 实例");
});
