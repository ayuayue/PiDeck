// 逐模型 User-Agent 覆盖（provider.modelOverrides[modelId].headers）的纯函数测试。
// 背景：pi 侧 `core/provider-composer.js` 的 rawModelHeaders 会把 modelOverrides[id].headers
// 展开在**最后**，因此逐模型 UA 优先级高于供应商级 UA。这段逻辑在渲染层，必须可单测。
import { test } from "node:test";
// 注意：用非 strict 的 assert。loadTsCommonJs 在沙箱里构造对象，其原型与宿主 realm
// 不同源，deepStrictEqual 会因原型不等而误报；deepEqual 不比较原型，正合此处"只比结构"。
import assert from "node:assert";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// providerHeaders.ts 经 ../i18n（目录 import）依赖时，裸 node --test 会报
// ERR_UNSUPPORTED_DIR_IMPORT，因此走完整依赖图加载 helper。
const { getModelUserAgentOverride, getProviderHeaders, setModelUserAgentOverride, setHeaderValue, PROVIDER_API_OPTIONS, DSH_PROVIDER_API_OPTIONS, API_TYPE_LABELS, getApiTypeDescription } = loadTsCommonJs("src/renderer/src/config/providerHeaders.ts");

/**
 * API 类型下拉必须覆盖 pi 1.0.4 pi-ai 的聊天协议全集（BUILTIN_APIS 里的非 image/
 * classifier 项），否则用户配 Azure / Vertex / Bedrock / Radius 时无从选择，只能手改 JSON。
 *
 * 同时锁定「不把生图与分类协议混进聊天下拉」：openrouter-images 是图片生成协议，
 * typesafe-system-one / cloudflare-workers-ai-system-one 是分类器协议，选到它们
 * 会让聊天 provider 拿到一个不会聊天的协议。
 */
test("API 类型下拉覆盖 pi 1.0.4 聊天协议全集", () => {
	const chatProtocols = ["openai-completions", "openai-responses", "openai-codex-responses", "azure-openai-responses", "anthropic-messages", "google-generative-ai", "google-vertex", "mistral-conversations", "bedrock-converse-stream", "pi-messages"];
	assert.deepEqual([...PROVIDER_API_OPTIONS].sort(), [...chatProtocols].sort());
});

test("API 类型下拉不含生图 / 分类器协议", () => {
	for (const nonChat of ["openrouter-images", "typesafe-system-one", "cloudflare-workers-ai-system-one", "llama-cpp-classify"]) {
		assert.ok(!PROVIDER_API_OPTIONS.includes(nonChat), `${nonChat} 不是聊天协议，不应出现在下拉里`);
	}
});

/**
 * DSH（llm-pi-ai 适配器）与 pi 共用 ApiTypeInput，但它的设置 schema 只注册了三种协议。
 * 若 DSH 表单沿用 pi 的十项列表，用户会选到一个写不进 DSH 配置的值。
 */
test("DSH 表单只列 DSH 适配器注册的三种协议", () => {
	assert.deepEqual([...DSH_PROVIDER_API_OPTIONS].sort(), ["anthropic-messages", "openai-completions", "openai-responses"].sort());
	for (const api of DSH_PROVIDER_API_OPTIONS) {
		assert.ok(PROVIDER_API_OPTIONS.includes(api), `DSH 协议 ${api} 应是 pi 列表的子集`);
	}
});

test("每个下拉选项都有展示名与 i18n 描述", () => {
	for (const api of PROVIDER_API_OPTIONS) {
		assert.ok(API_TYPE_LABELS[api], `${api} 缺 API_TYPE_LABELS 展示名`);
		assert.ok(getApiTypeDescription(api), `${api} 缺 i18n 描述（getApiTypeDescription 返回空串）`);
	}
});

test("getModelUserAgentOverride: 未配置 / 空壳都返回空串（语义=继承供应商 UA）", () => {
	assert.equal(getModelUserAgentOverride(undefined, "gpt-5"), "");
	assert.equal(getModelUserAgentOverride({}, "gpt-5"), "");
	// 模型存在但没有 headers 字段
	assert.equal(getModelUserAgentOverride({ "gpt-5": { maxTokens: 4096 } }, "gpt-5"), "");
	// headers 存在但没写 UA
	assert.equal(getModelUserAgentOverride({ "gpt-5": { headers: { "x-foo": "1" } } }, "gpt-5"), "");
	// headers 不是对象（脏数据）也不能抛
	assert.equal(getModelUserAgentOverride({ "gpt-5": { headers: "bad" } }, "gpt-5"), "");
});

test("getModelUserAgentOverride: 命中且大小写不敏感", () => {
	const overrides = { "gpt-5": { headers: { "user-agent": "claude-cli/2.1.161" } } };
	assert.equal(getModelUserAgentOverride(overrides, "gpt-5"), "claude-cli/2.1.161");
});

test("setModelUserAgentOverride: 写入保留同模型其它覆盖字段", () => {
	const next = setModelUserAgentOverride({ "gpt-5": { maxTokens: 4096 } }, "gpt-5", "claude-cli/2.1.161");
	assert.deepEqual(next, {
		"gpt-5": { maxTokens: 4096, headers: { "User-Agent": "claude-cli/2.1.161" } },
	});
});

test("setModelUserAgentOverride: 写入不改动入参（不可变）", () => {
	const before = { "gpt-5": {} };
	setModelUserAgentOverride(before, "gpt-5", "ua");
	assert.deepEqual(before, { "gpt-5": {} }, "入参被就地改写了");
});

test("setModelUserAgentOverride: 清空=删除 UA 键，模型其它字段保留", () => {
	const next = setModelUserAgentOverride({ "gpt-5": { maxTokens: 4096, headers: { "User-Agent": "ua" } } }, "gpt-5", "   ");
	// 只剩 maxTokens —— modelOverrides 条目本身要留着，整块删掉会丢用户的其它配置
	assert.deepEqual(next, { "gpt-5": { maxTokens: 4096 } });
});

test("setModelUserAgentOverride: 清空后模型变空壳则整条删除，不留 { id: {} }", () => {
	const next = setModelUserAgentOverride({ "gpt-5": { headers: { "User-Agent": "ua" } } }, "gpt-5", "");
	assert.equal(next, undefined, "空壳应连同 modelOverrides 一起清掉");
});

test("setModelUserAgentOverride: 覆盖已有 UA 且不产生重复键", () => {
	const next = setModelUserAgentOverride({ "gpt-5": { headers: { "user-agent": "old", "x-keep": "1" } } }, "gpt-5", "new");
	assert.deepEqual(next, { "gpt-5": { headers: { "x-keep": "1", "User-Agent": "new" } } });
});

test("setModelUserAgentOverride: 空 modelId 直接原样返回，不写空键", () => {
	assert.deepEqual(setModelUserAgentOverride({ "gpt-5": {} }, "  ", "ua"), { "gpt-5": {} });
});

test("setModelUserAgentOverride: 多模型互不干扰", () => {
	const next = setModelUserAgentOverride({ "gpt-5": { headers: { "User-Agent": "a" } } }, "gpt-6", "b");
	assert.deepEqual(next, {
		"gpt-5": { headers: { "User-Agent": "a" } },
		"gpt-6": { headers: { "User-Agent": "b" } },
	});
});

// setHeaderValue / getProviderHeaders 是供应商级 UA 的同一套原语，逐模型路径复用它们，
// 这里补基础回归：大小写不敏感去重、留空返回 undefined、脏输入不抛。
test("setHeaderValue: 大小写不敏感去重 + 留空返回 undefined", () => {
	assert.deepEqual(setHeaderValue({ "user-agent": "old" }, "User-Agent", "new"), {
		"User-Agent": "new",
	});
	assert.equal(setHeaderValue({ "User-Agent": "old" }, "User-Agent", "  "), undefined);
});

test("getProviderHeaders: 非对象输入返回 undefined 而不是抛", () => {
	assert.equal(getProviderHeaders(undefined), undefined);
	assert.equal(getProviderHeaders("bad"), undefined);
	assert.equal(getProviderHeaders([]), undefined);
});
