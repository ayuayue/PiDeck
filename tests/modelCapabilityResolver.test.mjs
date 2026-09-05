import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { resolveModelSpecFromPiCatalogs, resolveModelSpecFromCatalogs } = loadTsCommonJs(
  "src/main/pi/modelCapabilityResolver.ts",
);
const { buildPiAiCatalogIndex } = loadTsCommonJs("src/main/pi/piAiBuiltinCatalog.ts");

test("bundled pi-ai catalog fills a renamed third-party GPT model without changing its provider", () => {
  const index = buildPiAiCatalogIndex([
    // Marks openai as a built-in provider and carries the gpt-5.6 template.
    { provider: "openai", id: "gpt-5.6", name: "GPT-5.6", contextWindow: 400000, maxTokens: 128000, reasoning: true, input: ["text", "image"], thinkingLevelMap: { off: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max" } },
  ]);

  const spec = resolveModelSpecFromPiCatalogs(
    {
      providerName: "luna-relay",
      modelId: "GPT-5.6 Luna",
      modelName: "GPT-5.6 Luna",
    },
    index,
  );

  assert.equal(spec?.source, "pi-ai");
  assert.equal(spec?.matchKind, "name-alias");
  assert.equal(spec?.matchedId, "gpt-5.6");
  assert.equal(spec?.contextWindow, 400000);
  assert.equal(spec?.maxTokens, 128000);
  assert.equal(spec?.reasoning, true);
  assert.deepEqual(JSON.parse(JSON.stringify(spec?.input)), ["text", "image"]);
  assert.equal(spec?.thinkingLevelMap?.max, "max");
});

test("exact model id resolves across a third-party provider from bundled catalog", () => {
  const index = buildPiAiCatalogIndex([
    { provider: "openai", id: "gpt-5.6", contextWindow: 400000 },
  ]);

  const spec = resolveModelSpecFromPiCatalogs(
    { providerName: "luna-relay", modelId: "gpt-5.6" },
    index,
  );

  assert.equal(spec?.source, "pi-ai");
  assert.equal(spec?.matchKind, "model-id");
  assert.equal(spec?.matchedId, "gpt-5.6");
  assert.equal(spec?.contextWindow, 400000);
});

test("unknown model resolves to null instead of guessing", () => {
  const index = buildPiAiCatalogIndex([
    { provider: "openai", id: "gpt-4o", contextWindow: 128000 },
  ]);

  const spec = resolveModelSpecFromPiCatalogs(
    { providerName: "luna-relay", modelId: "luna-pro-2026-beta" },
    index,
  );

  assert.equal(spec, null);
});

// ── 运行中 pi 模型列表（pi-runtime source）──────────────────────────────

test("runtime model missing from bundled catalog resolves with pi-reported capacity", () => {
  // 模拟 bundled 快照尚未收录 qwen3.8-max；运行中 pi 已有它 → 必须能匹配上
  const index = buildPiAiCatalogIndex([
    { provider: "opencode-go", id: "qwen3.8-max-preview", contextWindow: 1000000, maxTokens: 131072 },
  ]);
  const runtime = [
    { provider: "opencode-go", id: "qwen3.8-max", contextWindow: 1000000, maxTokens: 131072, reasoning: true },
  ];

  const spec = resolveModelSpecFromCatalogs(
    { providerName: "opencode-go", modelId: "qwen3.8-max" },
    index,
    runtime,
  );

  assert.equal(spec?.source, "pi-runtime");
  assert.equal(spec?.matchedId, "qwen3.8-max");
  assert.equal(spec?.contextWindow, 1000000);
  assert.equal(spec?.maxTokens, 131072);
  assert.equal(spec?.reasoning, true);
});

test("runtime capacity wins over bundled for same provider+id (pi uses its own resolved values)", () => {
  const index = buildPiAiCatalogIndex([
    { provider: "zai1", id: "glm-5.3", contextWindow: 1000000, maxTokens: 131072, reasoning: true },
  ]);
  // 用户 provider 在 models.json/auth.json 里把容量改小 → 运行中 pi 实报为准
  const runtime = [
    { provider: "zai1", id: "glm-5.3", contextWindow: 128000, maxTokens: 16384, reasoning: true },
  ];

  const spec = resolveModelSpecFromCatalogs(
    { providerName: "zai1", modelId: "glm-5.3" },
    index,
    runtime,
  );

  assert.equal(spec?.source, "pi-runtime");
  assert.equal(spec?.contextWindow, 128000);
  assert.equal(spec?.maxTokens, 16384);
});

test("runtime candidate without capacity inherits bundled capacity for same provider+id", () => {
  // CLI 失败回退 models.json 时条目可能缺容量；bundled 已知则补上，不能丢
  const index = buildPiAiCatalogIndex([
    { provider: "qwen", id: "qwen3.7-max", contextWindow: 1000000, maxTokens: 131072 },
  ]);
  const runtime = [{ provider: "qwen", id: "qwen3.7-max" }];

  const spec = resolveModelSpecFromCatalogs(
    { providerName: "qwen", modelId: "qwen3.7-max" },
    index,
    runtime,
  );

  assert.equal(spec?.source, "pi-runtime");
  assert.equal(spec?.contextWindow, 1000000);
  assert.equal(spec?.maxTokens, 131072);
});

test("no runtime models → bundled-only fallback (same as resolveModelSpecFromPiCatalogs)", () => {
  const index = buildPiAiCatalogIndex([
    { provider: "openai", id: "gpt-4o", contextWindow: 128000 },
  ]);

  const spec = resolveModelSpecFromCatalogs(
    { providerName: "luna-relay", modelId: "gpt-4o" },
    index,
    undefined,
  );

  assert.equal(spec?.source, "pi-ai");
  assert.equal(spec?.contextWindow, 128000);
});
