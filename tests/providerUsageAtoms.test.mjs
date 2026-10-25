/**
 * Provider 用量缓存 atoms 状态机：begin/resolve 幂等、失败不覆盖 ready 数据的
 * fetchedAt 语义、invalidate 全部/单个失效。三处消费共享同一 record 的前提
 * 是写路径行为可预期。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createStore } from "jotai/vanilla";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const atoms = loadTsCommonJs("src/renderer/src/atoms/provider-usage-atoms.ts");

function okResult(at) {
	return { success: true, kind: "balance", balance: { value: 10, currency: "USD" }, at };
}

function failResult() {
	return { success: false, error: "boom", at: 1 };
}

test("初始 entry：未查过 = idle 空壳（fetchedAt null；不自动查询时不显示加载态）", () => {
	const store = createStore();
	const entry = store.get(atoms.providerUsageEntryAtomFamily("oc"));
	assert.equal(entry.status, "idle");
	assert.equal(entry.result, null);
	assert.equal(entry.fetchedAt, null);
});

test("begin 幂等：loading 重复 begin 不重置；ready 后 begin 保留旧结果", () => {
	const store = createStore();
	store.set(atoms.beginProviderUsageAtom, "oc");
	store.set(atoms.resolveProviderUsageAtom, "oc", okResult(100));
	const ready = store.get(atoms.providerUsageEntryAtomFamily("oc"));
	assert.equal(ready.status, "ready");
	const readyAt = ready.fetchedAt;
	assert.ok(readyAt != null);

	// ready 后再次 begin（重查路径）：status 回 loading，但旧结果/fetchedAt 保留供降级展示
	store.set(atoms.beginProviderUsageAtom, "oc");
	const refetching = store.get(atoms.providerUsageEntryAtomFamily("oc"));
	assert.equal(refetching.status, "loading");
	assert.equal(refetching.result.success, true);
	assert.equal(refetching.fetchedAt, readyAt);

	// loading 中重复 begin：不产生变化（引用保持，避免无谓重渲染）
	const before = store.get(atoms.providerUsageEntryAtomFamily("oc"));
	store.set(atoms.beginProviderUsageAtom, "oc");
	const after = store.get(atoms.providerUsageEntryAtomFamily("oc"));
	assert.ok(before === after);
});

test("resolve 按成败分流：success→ready，失败→error（含 fetchedAt）", () => {
	const store = createStore();
	store.set(atoms.beginProviderUsageAtom, "oc");
	store.set(atoms.resolveProviderUsageAtom, "oc", failResult());
	const failed = store.get(atoms.providerUsageEntryAtomFamily("oc"));
	assert.equal(failed.status, "error");
	assert.equal(failed.result.success, false);
	assert.ok(failed.fetchedAt != null, "失败也要记 fetchedAt，TTL 判定才成立");

	store.set(atoms.beginProviderUsageAtom, "ds");
	store.set(atoms.resolveProviderUsageAtom, "ds", okResult(200));
	assert.equal(store.get(atoms.providerUsageEntryAtomFamily("ds")).status, "ready");
	// 同一 record 内两个 provider 互不影响
	assert.equal(store.get(atoms.providerUsageEntryAtomFamily("oc")).status, "error");
});

test("invalidateAll 清空全部；invalidate 单个只清指定 provider", () => {
	const store = createStore();
	for (const provider of ["oc", "ds", "glm"]) {
		store.set(atoms.beginProviderUsageAtom, provider);
		store.set(atoms.resolveProviderUsageAtom, provider, okResult(1));
	}
	store.set(atoms.invalidateProviderUsageAtom, "ds");
	assert.equal(store.get(atoms.providerUsageEntryAtomFamily("oc")).status, "ready");
	assert.equal(store.get(atoms.providerUsageEntryAtomFamily("ds")).status, "idle");
	assert.equal(store.get(atoms.providerUsageEntryAtomFamily("ds")).fetchedAt, null);

	store.set(atoms.invalidateAllProviderUsageAtom);
	const json = JSON.stringify(store.get(atoms.providerUsageRecordsReadAtom));
	assert.equal(json, "{}");
});
