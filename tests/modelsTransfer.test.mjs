import assert from "node:assert/strict";
import { test } from "node:test";
import { webcrypto } from "node:crypto";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// loadTsCommonJs 的 vm 上下文不含 crypto/btoa/atob/TextEncoder，必须手动注入。
// 额外注入 Object/Array，避免 vm 新上下文原型与主上下文不同导致 assert.deepEqual 误判。
const m = loadTsCommonJs("src/renderer/src/config/modelsTransfer.ts", {
	globals: {
		crypto: webcrypto,
		// btoa/atob 语义 = latin1 ↔ base64，用 Buffer 等价实现
		btoa: (s) => Buffer.from(s, "binary").toString("base64"),
		atob: (s) => Buffer.from(s, "base64").toString("binary"),
		TextEncoder,
		TextDecoder,
		structuredClone,
		Object,
		Array,
	},
});

function model(id, overrides = {}) {
	return { id, contextWindow: 128000, maxTokens: 8192, ...overrides };
}
function provider(overrides = {}) {
	return {
		api: "openai-completions",
		baseUrl: "https://api.test/v1",
		apiKey: "sk-test-1234567890",
		models: [model("m-1")],
		...overrides,
	};
}
function draft(overrides = {}) {
	return { providers: {}, ...overrides };
}

test("无密码信封 encode→decode 往返", async () => {
	const providers = { a: provider(), b: provider({ api: "anthropic-messages", baseUrl: "https://api.b/v1", customField: { x: 1 } }) };
	const b64 = await m.encodeModelsTransfer(providers);
	assert.equal(typeof b64, "string");
	assert.ok(!b64.includes("\n"));
	const r = await m.decodeModelsTransfer(b64);
	assert.ok(r.ok);
	assert.equal(r.wasEncrypted, false);
	assert.deepEqual(structuredClone(r.providers), providers);
});

test("有密码往返 + wasEncrypted", async () => {
	const b64 = await m.encodeModelsTransfer({ a: provider() }, "pw123");
	const r = await m.decodeModelsTransfer(b64, "pw123");
	assert.ok(r.ok);
	assert.equal(r.wasEncrypted, true);
	assert.equal(r.providers.a.apiKey, "sk-test-1234567890");
});

test("错密码 → wrong-password", async () => {
	const b64 = await m.encodeModelsTransfer({ a: provider() }, "pw123");
	const r = await m.decodeModelsTransfer(b64, "nope");
	assert.equal(r.ok, false);
	assert.equal(r.error, "wrong-password");
});

test("加密信封但未给密码 → encrypted-no-password", async () => {
	const b64 = await m.encodeModelsTransfer({ a: provider() }, "pw123");
	const r = await m.decodeModelsTransfer(b64);
	assert.equal(r.ok, false);
	assert.equal(r.error, "encrypted-no-password");
});

test("非法 base64 / 非法 JSON → invalid-format", async () => {
	assert.equal((await m.decodeModelsTransfer("!!!not-base64!!!")).error, "invalid-format");
	const notJson = Buffer.from("{oops").toString("base64");
	assert.equal((await m.decodeModelsTransfer(notJson)).error, "invalid-format");
});

test("schemaVersion 不认识 → unsupported-version；kind 不对 → wrong-kind", async () => {
	const v2 = Buffer.from(JSON.stringify({ schemaVersion: 2, kind: "pideck-models-export", encrypted: false, providers: {} })).toString("base64");
	assert.equal((await m.decodeModelsTransfer(v2)).error, "unsupported-version");
	const wrongKind = Buffer.from(JSON.stringify({ schemaVersion: 1, kind: "other", encrypted: false, providers: {} })).toString("base64");
	assert.equal((await m.decodeModelsTransfer(wrongKind)).error, "wrong-kind");
});

test("输入容忍首尾空白", async () => {
	const b64 = await m.encodeModelsTransfer({ a: provider() });
	const r = await m.decodeModelsTransfer(`\n  ${b64}  \n`);
	assert.ok(r.ok);
});

test("planProviderMerge：字段不一致检出、一致不检出、undefined≡缺失", () => {
	const local = provider({ compat: { noStream: true }, modelOverrides: { "m-1": { maxTokens: 100 } } });
	const same = provider({ compat: { noStream: true }, modelOverrides: { "m-1": { maxTokens: 100 } } });
	assert.deepEqual(structuredClone(m.planProviderMerge(local, same)), { providerFields: [], newModels: [], modelFieldDiffs: [] });

	const imported = provider({ baseUrl: "https://other/v2", apiKey: undefined, modelOverrides: { "m-1": { maxTokens: 200 } }, models: [model("m-1", { maxTokens: 4000 }), model("m-2")] });
	const plan = m.planProviderMerge(local, imported);
	// baseUrl 不一致；apiKey 一侧 undefined 一侧缺失 → 视为相等不检出；modelOverrides 整字段 diff
	assert.deepEqual(structuredClone(plan.providerFields.map((d) => d.field).sort()), ["baseUrl", "modelOverrides"]);
	assert.deepEqual(structuredClone(plan.newModels.map((n) => n.modelId)), ["m-2"]);
	assert.deepEqual(structuredClone(plan.modelFieldDiffs), [{ modelId: "m-1", field: "maxTokens", local: 8192, imported: 4000 }]);
});

test("planProviderMerge：自定义字段参与 diff", () => {
	const local = provider({ extra: { a: 1 } });
	const imported = provider({ extra: { a: 2 } });
	const plan = m.planProviderMerge(local, imported);
	assert.deepEqual(structuredClone(plan.providerFields), [{ field: "extra", local: { a: 1 }, imported: { a: 2 } }]);
});

test("applyProviderMerge：选择生效、默认 local、新模型并入、入参不可变", () => {
	const local = provider({ models: [model("m-1"), model("local-only")] });
	const imported = provider({ baseUrl: "https://other/v2", models: [model("m-1", { maxTokens: 4000, cost: { input: 1 } }), model("m-2")] });
	const localSnap = JSON.stringify(local);
	const importedSnap = JSON.stringify(imported);
	const merged = m.applyProviderMerge(local, imported, { baseUrl: "imported" }, { "m-1::maxTokens": "imported" });
	assert.equal(merged.baseUrl, "https://other/v2"); // 选择 imported 生效
	assert.equal(merged.models.find((x) => x.id === "m-1").maxTokens, 4000);
	assert.equal(merged.models.find((x) => x.id === "m-1").cost.input, 1); // 导入独有字段并入
	assert.equal(merged.models.find((x) => x.id === "local-only").id, "local-only"); // 本地独有保留
	assert.deepEqual(structuredClone(merged.models.map((x) => x.id).sort()), ["local-only", "m-1", "m-2"]);
	const merged2 = m.applyProviderMerge(local, imported, {}, {}); // 全默认
	assert.equal(merged2.baseUrl, "https://api.test/v1"); // 默认 local
	assert.equal(merged2.models.find((x) => x.id === "m-1").maxTokens, 8192);
	assert.deepEqual(structuredClone(merged2.models.map((x) => x.id).sort()), ["local-only", "m-1", "m-2"]);
	assert.equal(JSON.stringify(local), localSnap);
	assert.equal(JSON.stringify(imported), importedSnap);
});

test("applyTransferToDraft：覆盖/合并/跳过/新增 + 顶层默认不动 + 入参不可变", () => {
	const base = draft({ providers: { keep: provider({ baseUrl: "https://keep/v1" }), edit: provider({}) } });
	const snap = JSON.stringify(base);
	const imported = { edit: provider({ baseUrl: "https://new/v9" }), fresh: provider({ baseUrl: "https://fresh/v1" }), unchecked: provider({ baseUrl: "https://unchecked/v1" }) };
	const next = m.applyTransferToDraft(base, imported, {
		edit: { merge: { providerFieldChoices: { baseUrl: "imported" }, modelChoices: {} } },
		keep2: "overwrite", // imported 中不存在 → 忽略
		fresh: "overwrite", // 本地不存在 → 新增
	});
	assert.equal(next.providers.edit.baseUrl, "https://new/v9");
	assert.equal(next.providers.fresh.baseUrl, "https://fresh/v1");
	assert.equal(next.providers.unchecked, undefined); // 未勾选 → 跳过
	assert.equal(next.providers.keep.baseUrl, "https://keep/v1");
	assert.deepEqual(Object.keys(next.providers).sort(), ["edit", "fresh", "keep"]); // 未勾选跳过、新增进入、本地保留
	assert.equal(JSON.stringify(base), snap);
});

test("maskSecret", () => {
	assert.equal(m.maskSecret("sk-test-1234567890"), "sk-t****7890");
	assert.equal(m.maskSecret("short"), "short");
	assert.equal(m.maskSecret(undefined), "");
	assert.equal(m.maskSecret(123), "123");
});
