import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	normalizeDshSchema,
	objectFields,
	unionConstOptions,
	dictEntries,
	isSecretSet,
	collectCredentialRefs,
	collectCredentialRefsWithValue,
	readPath,
	readDshEntryValue,
	readDshDraftValue,
	hasDshDraftChanges,
	normalizeDshNumberDraft,
	setPath,
	deletePath,
	pruneEmptyObjects,
	readDshRetryPolicy,
	patchDshRetryMaxRetries,
	DSH_DEFAULT_RETRY_MAX,
} = loadTsCommonJs("src/renderer/src/config/dshSchema.ts");

/** 构造最小 schemastery 风格 schema：{ uid, refs: { id: ref } }。 */
function makeSchema(refs) {
	return { uid: 1, refs: { 1: { type: "object", dict: { ...refs.dict } }, ...refs.refs } };
}

test("normalizeDshSchema 解析 schemastery JSON（数字键 refs）", () => {
	const raw = {
		uid: 2,
		refs: {
			1: { type: "object", dict: { apiKeyEnv: 3 } },
			3: { type: "string", meta: { role: "credential-ref", default: "DEEPSEEK_API_KEY" } },
		},
	};
	const schema = normalizeDshSchema(raw);
	assert.ok(schema);
	assert.equal(schema.uid, 2);
	assert.equal(schema.refs[1].type, "object");
	assert.deepEqual(schema.refs[1].dict, { apiKeyEnv: 3 });
	assert.equal(schema.refs[3].meta?.role, "credential-ref");
});

test("objectFields 展开固定字段（保持声明顺序）", () => {
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "object", dict: { b: 2, a: 3 } },
			2: { type: "number" },
			3: { type: "string" },
		},
	});
	const fields = objectFields(schema, schema.refs[1]);
	assert.equal(fields.map((field) => field.name).join(","), "b,a");
	assert.equal(fields[1].ref.type, "string");
});

test("unionConstOptions 提取 const 分支（非 const 分支忽略）", () => {
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "union", list: [2, 3, 4] },
			2: { type: "const", value: "read-only" },
			3: { type: "const", value: "workspace-write" },
			4: { type: "object" },
		},
	});
	const options = unionConstOptions(schema, schema.refs[1]);
	assert.equal(options.length, 2);
	assert.equal(options[0].value, "read-only");
	assert.equal(options[1].value, "workspace-write");
});

test("dictEntries 列出动态 dict 条目（llm-pi-ai.providers）", () => {
	const entries = dictEntries({
		opencode: { apiKeyEnv: "OPENCODE_API_KEY" },
		weishiair: { apiKeyEnv: "WEISHIAIR_API_KEY" },
	});
	assert.equal(entries.length, 2);
	assert.equal(entries[0].key, "opencode");
	assert.equal(entries[0].value.apiKeyEnv, "OPENCODE_API_KEY");
	assert.equal(entries[1].key, "weishiair");
	assert.equal(dictEntries(null).length, 0);
	assert.equal(dictEntries([]).length, 0);
});

test("isSecretSet 按 path 匹配 secrets 槽位", () => {
	const secrets = [
		{ path: ["apiKey"], set: true },
		{ path: ["proxy", "password"], set: false },
	];
	assert.equal(isSecretSet(secrets, ["apiKey"]), true);
	assert.equal(isSecretSet(secrets, ["proxy", "password"]), false);
	assert.equal(isSecretSet(secrets, ["other"]), false);
});

test("collectCredentialRefs 收集所有 credential-ref env 名（嵌套 dict/object）", () => {
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "object", dict: { apiKeyEnv: 2, providers: 3 } },
			2: { type: "string", meta: { role: "credential-ref", default: "DEEPSEEK_API_KEY" } },
			3: { type: "dict", inner: 4 },
			4: { type: "object", dict: { apiKeyEnv: 5 } },
			5: { type: "string", meta: { role: "credential-ref", default: "WEISHIAIR_API_KEY" } },
		},
	});
	const out = new Set();
	collectCredentialRefs(schema, schema.refs[1], out);
	assert.deepEqual([...out], ["DEEPSEEK_API_KEY", "WEISHIAIR_API_KEY"]);
});

test("collectCredentialRefsWithValue 补充收集 value 里的动态 env 名（llm-pi-ai 场景）", () => {
	// llm-pi-ai 的真实形态：providers 是 dict，apiKeyEnv 的 schema 只有 role 标注、
	// 没有 default；env 名由用户配置在 value.providers[*].apiKeyEnv 里，必须读 value 才不漏。
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "object", dict: { providers: 2 } },
			2: { type: "dict", inner: 3 },
			3: { type: "object", dict: { apiKeyEnv: 4 } },
			4: { type: "string", meta: { role: "credential-ref" } },
		},
	});
	const value = {
		providers: {
			opencode: { apiKeyEnv: "OPENCODE_GO_API_KEY" },
			weishiair: { apiKeyEnv: "WEISHIAIR_API_KEY" },
		},
	};
	const out = new Set();
	collectCredentialRefsWithValue(schema, schema.refs[1], value, out);
	assert.deepEqual([...out].sort(), ["OPENCODE_GO_API_KEY", "WEISHIAIR_API_KEY"]);
});

test("collectCredentialRefsWithValue 同时收 schema default 与 value 值（合并去重）", () => {
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "object", dict: { apiKeyEnv: 2 } },
			2: { type: "string", meta: { role: "credential-ref", default: "DEEPSEEK_API_KEY" } },
		},
	});
	const out = new Set();
	// 用户改了 env 名：default 与 value 并存时都收（credentials.describe 按 refs 查询，多余 ref 无害）
	collectCredentialRefsWithValue(schema, schema.refs[1], { apiKeyEnv: "MY_KEY" }, out);
	assert.deepEqual([...out].sort(), ["DEEPSEEK_API_KEY", "MY_KEY"]);
});

test("readPath/setPath 读写嵌套 path", () => {
	const root = { a: { b: 1 } };
	assert.equal(readPath(root, ["a", "b"]), 1);
	assert.equal(readPath(root, ["a", "c"]), undefined);
	setPath(root, ["x", "y"], 2);
	assert.equal(root.x?.y, 2);
});

test("readDshEntryValue 草稿缺中间路径时仍回退已保存值", () => {
	// 回归：draft 只有 providers.my-gateway.models 时，读 baseURL/api 不能中途返回 undefined，
	// 否则卡片「自定义设置」打开后不显示已保存的接口地址/协议。
	const draft = {
		providers: {
			"my-gateway": { models: [{ id: "gpt-4o", name: "GPT-4o" }] },
		},
	};
	const saved = {
		providers: {
			"my-gateway": {
				baseURL: "https://gateway.example/v1",
				api: "openai-completions",
				displayName: "My Gateway",
			},
		},
	};
	assert.equal(readDshEntryValue(draft, saved, "my-gateway", ["baseURL"]), "https://gateway.example/v1");
	assert.equal(readDshEntryValue(draft, saved, "my-gateway", ["api"]), "openai-completions");
	assert.equal(readDshEntryValue(draft, saved, "my-gateway", ["displayName"]), "My Gateway");
	// 草稿显式覆盖时仍以草稿为准
	assert.equal(readDshEntryValue({ providers: { "my-gateway": { baseURL: "https://draft.example/v1" } } }, saved, "my-gateway", ["baseURL"]), "https://draft.example/v1");
});

test("readDshRetryPolicy 省略时按 normal 默认，always 不捏造次数", () => {
	// loadTsCommonJs 在 vm 里编译，对象字面量与测试进程不同 realm，deepEqual 会误报。
	const omitted = readDshRetryPolicy(undefined);
	assert.equal(omitted.mode, "normal");
	assert.equal(omitted.maxRetries, undefined);
	assert.equal(readDshRetryPolicy({ mode: "normal", maxRetries: 3 }).maxRetries, 3);
	assert.equal(readDshRetryPolicy({ mode: "always" }).mode, "always");
	assert.equal(readDshRetryPolicy({ mode: "always" }).maxRetries, undefined);
});

test("patchDshRetryMaxRetries 把次数写成有限 normal，空值写回默认 5", () => {
	assert.equal(DSH_DEFAULT_RETRY_MAX, 5);
	const fromEmpty = patchDshRetryMaxRetries(undefined, 2);
	assert.equal(fromEmpty.mode, "normal");
	assert.equal(fromEmpty.maxRetries, 2);
	const cleared = patchDshRetryMaxRetries({ mode: "normal", maxRetries: 8 }, undefined);
	assert.equal(cleared.mode, "normal");
	assert.equal(cleared.maxRetries, 5);
	const fromAlways = patchDshRetryMaxRetries({ mode: "always" }, 1);
	assert.equal(fromAlways.mode, "normal");
	assert.equal(fromAlways.maxRetries, 1);
	const keepAlways = patchDshRetryMaxRetries({ mode: "always" }, undefined);
	assert.equal(keepAlways.mode, "always");
	const withBackoff = patchDshRetryMaxRetries({ mode: "normal", maxRetries: 2, backoff: { initialMs: 800 } }, 4);
	assert.equal(withBackoff.maxRetries, 4);
	assert.equal(withBackoff.backoff.initialMs, 800);
});

test("readDshDraftValue 草稿显式空串不被吞（清空输入停留空串，不弹回已保存值）", () => {
	const saved = { reasoningEffort: "max" };
	// 用户清空：草稿存空串，读值必须返回空串（否则输入框立刻弹回 "max"）
	assert.equal(readDshDraftValue({ reasoningEffort: "" }, saved, ["reasoningEffort"]), "");
	// 草稿缺失：回退已保存值
	assert.equal(readDshDraftValue({}, saved, ["reasoningEffort"]), "max");
	// 草稿覆盖：优先草稿
	assert.equal(readDshDraftValue({ reasoningEffort: "high" }, saved, ["reasoningEffort"]), "high");
	// 嵌套路径同样生效
	assert.equal(readDshDraftValue({ a: { b: "" } }, { a: { b: 1 } }, ["a", "b"]), "");
});

test("hasDshDraftChanges 只按「草稿 vs 已保存」判脏（等于原值不打断输入）", () => {
	// 回归：旧策略在「输入等于已保存值」时删除覆盖，导致打到一半的值被吞掉/弹回。
	// 新策略：覆盖保留在草稿里，脏状态由逐路径比较决定。
	assert.equal(hasDshDraftChanges({}, { reasoningEffort: "max" }), false);
	assert.equal(hasDshDraftChanges({ reasoningEffort: "max" }, { reasoningEffort: "max" }), false);
	assert.equal(hasDshDraftChanges({ reasoningEffort: "high" }, { reasoningEffort: "max" }), true);
	// 清空已保存的非空字段：空串 ≠ 已保存值 → 脏
	assert.equal(hasDshDraftChanges({ reasoningEffort: "" }, { reasoningEffort: "max" }), true);
	// 嵌套对象按顶层键深比较（草稿里没碰的键不参与）
	assert.equal(hasDshDraftChanges({ a: { b: 1 } }, { a: { b: 1 }, c: 2 }), false);
	assert.equal(hasDshDraftChanges({ a: { b: 2 } }, { a: { b: 1 } }), true);
});

test("normalizeDshNumberDraft 保存前把字符串草稿转回数值（非法/空串删键）", () => {
	const schema = normalizeDshSchema({
		uid: 1,
		refs: {
			1: { type: "object", dict: { retries: 2, note: 3, providers: 4 } },
			2: { type: "number" },
			3: { type: "string" },
			4: { type: "dict", inner: 5 },
			5: { type: "object", dict: { maxRetries: 6 } },
			6: { type: "number" },
		},
	});
	const root = schema.refs[1];
	// vm 编译模块构造的对象与测试进程跨 realm，经 JSON 归一化后比较
	const toJson = (value) => JSON.parse(JSON.stringify(value));
	// 数值转 number；字符串字段原样保留
	assert.deepEqual(toJson(normalizeDshNumberDraft(schema, root, { retries: "5", note: "hello" })), { retries: 5, note: "hello" });
	// 清空/非法输入删键（patch 省略该字段，host 保持已保存值）
	assert.deepEqual(toJson(normalizeDshNumberDraft(schema, root, { retries: "", note: "x" })), { note: "x" });
	assert.deepEqual(toJson(normalizeDshNumberDraft(schema, root, { retries: "abc", note: "x" })), { note: "x" });
	// 嵌套 dict 条目：内部 number 字段同样转换
	assert.deepEqual(toJson(normalizeDshNumberDraft(schema, root, { providers: { gw: { maxRetries: "8" } } })), { providers: { gw: { maxRetries: 8 } } });
	// 已是数值的不动
	assert.deepEqual(toJson(normalizeDshNumberDraft(schema, root, { retries: 3 })), { retries: 3 });
});

test("deletePath 删除叶子并清理空父节点，脏计数不会残留空键", () => {
	const root = { providers: { "my-gateway": { baseUrl: "x", api: "openai" } }, other: 1 };
	deletePath(root, ["providers", "my-gateway", "baseUrl"]);
	assert.equal(Object.hasOwn(root.providers["my-gateway"], "baseUrl"), false);
	assert.equal(root.providers["my-gateway"].api, "openai");
	// 删到只剩空对象时，父节点也应被自底向上清掉，避免 Object.keys(draft) 仍算脏
	deletePath(root, ["providers", "my-gateway", "api"]);
	assert.deepEqual(Object.keys(root), ["other"]);
	assert.equal(Object.hasOwn(root, "providers"), false);
	// 中间路径不是对象时静默返回，不抛异常
	const flat = { a: 1 };
	deletePath(flat, ["a", "b"]);
	assert.deepEqual(flat, { a: 1 });
});

test("pruneEmptyObjects 清理空对象（patch 提交前）", () => {
	const cleaned = pruneEmptyObjects({ a: {}, b: { c: 1 }, d: { e: {} } });
	// vm 编译产物里的对象字面量原型与测试进程不同，deepEqual 会因跨 realm 报错；
	// 这里按字段断言。
	assert.deepEqual(Object.keys(cleaned), ["b"]);
	assert.equal(cleaned.b?.c, 1);
});
