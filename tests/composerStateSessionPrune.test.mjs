import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { atom, createStore } from "jotai/vanilla";
import { createTsSandbox } from "./helpers/createTsSandbox.mjs";
import { quickMessageHookHost } from "./helpers/quickMessageHookHost.mjs";

/**
 * composer 域 per-session 状态的删除卫生：
 * - removeSessionComposerStateAtom 此前漏清 sessionQuotesByIdAtom（引用全文仓，体积可观）；
 * - 外部删除（会话文件被删/归档 → replaceProjectSessions 移除记录）无人清理任何
 *   composer 状态——deleteDraftSession 是唯一显式清理路径。
 * 差分语义：只清「曾经出现在 records、之后消失且 runtime 也无绑定」的会话。
 * 新建/晋升的新 id 从未入过 previous 集合（catalog 刷新窗口不误清）；
 * 引导页虚拟会话永不在 records（天然豁免）；目录源切换只过滤 records 而 runtime
 * 仍在时必须保留（与 useQueuedPrompt 的双订阅双条件同口径）。
 */
function composerStatePruneHarness() {
	const store = createStore();
	const atoms = {};
	const host = quickMessageHookHost();
	const load = createTsSandbox({
		globals: { Error },
		stubs: {
			jotai: { atom },
			react: host.react,
			"../atoms": atoms,
		},
	});
	Object.assign(atoms, load("src/renderer/src/atoms/session-atoms.ts"), load("src/renderer/src/atoms/composer-atoms.ts"));
	const { useComposerStateSessionPrune } = load("src/renderer/src/hooks/useComposerStateSessionPrune.ts");
	const addRecord = (id, projectId = "project") => store.set(atoms.upsertSessionAtom, { id, projectId, title: id, source: "pi", environment: "native", preview: "", messageCount: 0, status: "draft", createdAt: 1, updatedAt: 1 });
	const addRuntime = (id) => store.set(atoms.sessionRuntimeByIdAtom, (current) => ({ ...current, [id]: { agentId: `agent-${id}`, runtimeGeneration: 1, status: "idle", updatedAt: 1, state: {} } }));
	const seedComposerState = (id) => {
		store.set(atoms.setSessionDraftAtom, { sessionId: id, value: `draft:${id}` });
		store.set(atoms.setSessionQuotesAtom, { sessionId: id, value: { q1: { id: "q1", label: "label", content: "quoted full text" } } });
		store.set(atoms.setSessionSendStateAtom, { sessionId: id, state: { status: "sending" } });
	};
	return {
		store,
		atoms,
		addRecord,
		addRuntime,
		seedComposerState,
		render: () => host.render(() => useComposerStateSessionPrune(store)),
		unmount: () => host.unmount(),
	};
}

test("removeSessionComposerStateAtom cleans the quote warehouse too", () => {
	const h = composerStatePruneHarness();
	h.seedComposerState("A");
	h.addRecord("A");
	assert.ok(h.store.get(h.atoms.sessionQuotesByIdAtom).A, "precondition: quote warehouse holds the session");
	h.store.set(h.atoms.removeSessionComposerStateAtom, "A");
	assert.equal(h.store.get(h.atoms.sessionDraftByIdAtom).A, undefined);
	assert.equal(h.store.get(h.atoms.sessionQuotesByIdAtom).A, undefined, "quote warehouse must be cleaned on composer state removal");
	assert.equal(h.store.get(h.atoms.sessionSendStateByIdAtom).A, undefined);
});

test("external session deletion prunes composer state (records+runtime both gone)", () => {
	const h = composerStatePruneHarness();
	h.addRecord("A");
	h.addRuntime("A");
	h.render();
	h.seedComposerState("A");
	// 外部删除：catalog 刷新移除记录 + 运行时解绑，无人显式调用 composer 清理
	h.store.set(h.atoms.removeSessionStateAtom, "A");
	assert.equal(h.store.get(h.atoms.sessionDraftByIdAtom).A, undefined, "draft must be pruned");
	assert.equal(h.store.get(h.atoms.sessionQuotesByIdAtom).A, undefined, "quotes must be pruned");
	assert.equal(h.store.get(h.atoms.sessionSendStateByIdAtom).A, undefined, "send state must be pruned");
});

test("catalog-source filter keeps composer state while the runtime binding survives", () => {
	const h = composerStatePruneHarness();
	h.addRecord("A");
	h.addRuntime("A");
	h.render();
	h.seedComposerState("A");
	// 目录源/项目切换：records 被过滤，但 runtime 绑定仍在——队列先例：休眠保留
	h.store.set(h.atoms.sessionRecordsAtom, (current) => {
		const next = { ...current };
		delete next.A;
		return next;
	});
	assert.equal(h.store.get(h.atoms.sessionDraftByIdAtom).A, `draft:A`, "state must survive while runtime is bound");
	assert.ok(h.store.get(h.atoms.sessionQuotesByIdAtom).A, "quotes must survive while runtime is bound");
	// 运行时最终解绑后，休眠状态随之清理
	h.store.set(h.atoms.sessionRuntimeByIdAtom, (current) => {
		const next = { ...current };
		delete next.A;
		return next;
	});
	assert.equal(h.store.get(h.atoms.sessionDraftByIdAtom).A, undefined, "state must be pruned once runtime is gone too");
});

test("bootstrap virtual session is never pruned (no record by design)", () => {
	const h = composerStatePruneHarness();
	h.render();
	h.seedComposerState("renderer:guide-bootstrap");
	// 触发一次 records 写（新增别的会话），虚拟会话不在 records 且从未入过 previous 集合
	h.addRecord("B");
	assert.equal(h.store.get(h.atoms.sessionDraftByIdAtom)["renderer:guide-bootstrap"], "draft:renderer:guide-bootstrap", "guide-page composer state must survive records churn");
	assert.ok(h.store.get(h.atoms.sessionQuotesByIdAtom)["renderer:guide-bootstrap"]);
});

test("newly promoted session id is not mispruned during the catalog refresh window", () => {
	const h = composerStatePruneHarness();
	h.addRecord("B");
	h.render();
	// 晋升：首次发送把 composer 状态搬到新 id，dispatch 同步写 runtime（starting），
	// catalog 里还没有它的 record——所有权模式下靠 runtime 绑定保留
	h.seedComposerState("NEW");
	h.addRuntime("NEW");
	h.addRecord("C"); // 无关的 records 写，prune 顺带运行
	assert.equal(h.store.get(h.atoms.sessionDraftByIdAtom).NEW, "draft:NEW", "promoted state must survive until the record appears");
	assert.ok(h.store.get(h.atoms.sessionQuotesByIdAtom).NEW);
});

test("prune source contract: dual subscription + ownership-only removal", () => {
	const source = readFileSync("src/renderer/src/hooks/useComposerStateSessionPrune.ts", "utf8");
	assert.match(source, /store\.sub\(sessionRecordsAtom/);
	assert.match(source, /store\.sub\(sessionRuntimeByIdAtom/);
	// 所有权模式：只清理实际持有状态且 records+runtime 双双消失的会话（与 useQueuedPrompt 同构）
	assert.match(source, /const owned = new Set/);
	assert.match(source, /if \(records\[sessionId\] \|\| runtimes\[sessionId\]\) continue/);
	// 引导页虚拟会话常量必须显式豁免
	assert.match(source, /GUIDE_BOOTSTRAP_SESSION_ID/);
});
