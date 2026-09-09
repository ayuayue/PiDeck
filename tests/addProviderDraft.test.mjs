import { test } from "node:test";
import assert from "node:assert/strict";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { buildProviderConfigFromDraft, mergeProviderDraft } = loadTsCommonJs(
  "src/renderer/src/config/addProviderDraft.ts",
);

// loadTsCommonJs 在独立 VM realm 执行，对象原型不同导致 deepStrictEqual 报
// “same structure but not reference-equal”，统一用 JSON 比较跨 realm 结果。
const json = (value) => JSON.stringify(value);

function emptyDraft() {
  return {
    name: "deepseek",
    baseUrl: "",
    api: "",
    apiKey: "",
    userAgent: "",
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
    models: [],
  };
}

function sampleModels() {
  return [
    {
      id: "deepseek-chat",
      name: "DeepSeek Chat",
      inputCost: 1,
      outputCost: 2,
      thinking: true,
    },
    { id: "deepseek-reasoner" },
  ];
}

test("空草稿：只写 models: []，不写入任何空字段（与手写 models.json 一致）", () => {
  const provider = buildProviderConfigFromDraft(emptyDraft());
  assert.equal(json(provider), json({ models: [] }));
});

test("完整草稿：baseUrl/api/apiKey 原样写入并 trim", () => {
  const provider = buildProviderConfigFromDraft({
    ...emptyDraft(),
    baseUrl: "  https://api.deepseek.com/v1  ",
    api: "openai-completions",
    apiKey: "  sk-test  ",
  });
  assert.equal(provider.baseUrl, "https://api.deepseek.com/v1");
  assert.equal(provider.api, "openai-completions");
  assert.equal(provider.apiKey, "sk-test");
  assert.equal(json(provider.models), json([]));
});

test("User-Agent 草稿：写入 headers（与卡片手填同一存储位置）", () => {
  const provider = buildProviderConfigFromDraft({
    ...emptyDraft(),
    userAgent: "pi-coding-agent",
  });
  assert.equal(json(provider.headers), json({ "User-Agent": "pi-coding-agent" }));
});

test("compat 全 false 不写入（与 pi 默认一致）", () => {
  const provider = buildProviderConfigFromDraft(emptyDraft());
  assert.equal(provider.compat, undefined);
});

test("compat 勾选任一项即写入两个布尔字段", () => {
  const devRole = buildProviderConfigFromDraft({
    ...emptyDraft(),
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: false },
  });
  assert.equal(
    json(devRole.compat),
    json({ supportsDeveloperRole: true, supportsReasoningEffort: false }),
  );

  const reasoning = buildProviderConfigFromDraft({
    ...emptyDraft(),
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  });
  assert.equal(
    json(reasoning.compat),
    json({ supportsDeveloperRole: false, supportsReasoningEffort: true }),
  );
});

test("models 草稿：整体透传（含空列表），与页面模型列表一一对应", () => {
  const provider = buildProviderConfigFromDraft({
    ...emptyDraft(),
    models: sampleModels(),
  });
  assert.equal(json(provider.models), json(sampleModels()));

  // 空列表也显式写入 []，保证「清空模型」的编辑操作能落盘
  const cleared = buildProviderConfigFromDraft(emptyDraft());
  assert.equal(json(cleared.models), json([]));
});

test("models 字段未提供时兜底为空数组（兼容旧调用方）", () => {
  const draft = emptyDraft();
  delete draft.models;
  const provider = buildProviderConfigFromDraft(draft);
  assert.equal(json(provider.models), json([]));
});

// ── mergeProviderDraft（编辑页保存：保留表单不拥有的字段）────────────────

/** 带高级字段的原 provider（模拟手写 models.json / 其他工具写入）。 */
function originalWithAdvanced() {
  return {
    models: [{ id: "m1" }],
    baseUrl: "https://old.example.com/v1",
    api: "openai-completions",
    apiKey: "sk-old",
    headers: { "User-Agent": "old-ua", "X-App-URL": "https://pideck.app" },
    compat: { supportsDeveloperRole: true, supportsReasoningEffort: false, customFlag: true },
    oauth: { refreshToken: "r1" },
    authHeader: "X-Api-Key",
    modelOverrides: { m1: { maxTokens: 4096 } },
    customUnknown: { keep: 1 },
  };
}

test("mergeProviderDraft: 新增模式（无原 provider）等价于 buildProviderConfigFromDraft", () => {
  const draft = {
    ...emptyDraft(),
    baseUrl: "https://new.example.com/v1",
    api: "openai",
    apiKey: "sk-new",
    userAgent: "ua",
  };
  assert.equal(
    json(mergeProviderDraft(undefined, draft)),
    json(buildProviderConfigFromDraft(draft)),
  );
});

test("mergeProviderDraft: 保留 oauth/authHeader/modelOverrides/自定义字段（不静默丢字段）", () => {
  const merged = mergeProviderDraft(originalWithAdvanced(), {
    ...emptyDraft(),
    models: [{ id: "m2" }],
  });
  assert.equal(json(merged.oauth), json({ refreshToken: "r1" }));
  assert.equal(merged.authHeader, "X-Api-Key");
  assert.equal(json(merged.modelOverrides), json({ m1: { maxTokens: 4096 } }));
  assert.equal(json(merged.customUnknown), json({ keep: 1 }));
  assert.equal(json(merged.models), json([{ id: "m2" }]));
});

test("mergeProviderDraft: 表单字段以草稿为准，空值删除字段", () => {
  const merged = mergeProviderDraft(originalWithAdvanced(), { ...emptyDraft(), models: [] });
  assert.ok(!("baseUrl" in merged));
  assert.ok(!("api" in merged));
  assert.ok(!("apiKey" in merged));
  assert.equal(json(merged.models), json([]));
  // 未知字段不因表单空值而被删
  assert.equal(json(merged.oauth), json({ refreshToken: "r1" }));
});

test("mergeProviderDraft: headers 逐键合并，只覆盖 User-Agent 并保留自定义头", () => {
  const changed = mergeProviderDraft(originalWithAdvanced(), {
    ...emptyDraft(),
    userAgent: "new-ua",
  });
  // 键顺序会因 setHeaderValue 先删后加而变化，按字段断言而非 JSON 字符串
  assert.equal(changed.headers["User-Agent"], "new-ua");
  assert.equal(changed.headers["X-App-URL"], "https://pideck.app");
  assert.equal(Object.keys(changed.headers).length, 2);
  // 清空 User-Agent：只移除它，自定义头保留
  const clearedUa = mergeProviderDraft(originalWithAdvanced(), { ...emptyDraft(), userAgent: "" });
  assert.ok(!("User-Agent" in clearedUa.headers));
  assert.equal(clearedUa.headers["X-App-URL"], "https://pideck.app");
  // 原本没有 headers 且草稿为空：不写入空对象
  const none = mergeProviderDraft({ models: [] }, { ...emptyDraft(), userAgent: "" });
  assert.ok(!("headers" in none));
});

test("mergeProviderDraft: compat 合并保留未知子键；原无 compat 且全 false 不创建", () => {
  const merged = mergeProviderDraft(originalWithAdvanced(), {
    ...emptyDraft(),
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: true },
  });
  assert.equal(
    json(merged.compat),
    json({ supportsDeveloperRole: false, supportsReasoningEffort: true, customFlag: true }),
  );
  const noCompat = mergeProviderDraft({ models: [] }, emptyDraft());
  assert.ok(!("compat" in noCompat));
});

test("mergeProviderDraft: 改名场景（调用方迁移 key）内容不丢", () => {
  const merged = mergeProviderDraft(originalWithAdvanced(), {
    ...emptyDraft(),
    name: "renamed",
    baseUrl: "https://renamed.example.com/v1",
  });
  assert.equal(merged.baseUrl, "https://renamed.example.com/v1");
  assert.equal(json(merged.oauth), json({ refreshToken: "r1" }));
  assert.equal(merged.authHeader, "X-Api-Key");
});
