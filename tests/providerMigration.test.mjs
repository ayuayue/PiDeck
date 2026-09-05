import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const mapping = loadTsCommonJs("src/main/config/providerMigration.ts");
const service = loadTsCommonJs("src/main/config/providerMigrationService.ts");

test("credentialRefFor uses explicit env then derived ROUTE_API_KEY", () => {
  assert.equal(mapping.credentialRefFor({ apiKeyEnv: "MY_KEY" }, "weishiair"), "MY_KEY");
  assert.equal(mapping.credentialRefFor({}, "opencode-go"), "OPENCODE_GO_API_KEY");
});

test("legacy provider route names get valid unique credential refs", () => {
  const first = mapping.credentialRefFor({}, "输入");
  const second = mapping.credentialRefFor({}, "供应商");
  assert.match(first, /^PIDECK_[0-9A-F]{8}_API_KEY$/);
  assert.match(second, /^[A-Za-z_][A-Za-z0-9_]*$/);
  assert.notEqual(first, second);
});
test("pi custom gateway maps into llm-pi-ai with catalog fields only", () => {
  const dsh = mapping.piToDshSnapshot({
    name: "weishiair",
    baseUrl: "https://api.weishiair.de/v1",
    api: "openai-completions",
    apiKey: "sk-test",
    headers: { "User-Agent": "pideck" },
    models: [
      {
        id: "grok-4.6",
        name: "grok-4.6",
        contextWindow: 128000,
        input: ["text", "image"],
        reasoning: true,
        thinkingLevelMap: { xhigh: "xhigh", max: "max" },
        cost: { input: 1 },
      },
    ],
  });
  assert.equal(dsh.namespace, "llm-pi-ai");

test("dsh custom model round-trips input and reasoningEfforts into Pi metadata", () => {
  const pi = mapping.dshToPiSnapshot({
    name: "组",
    namespace: "llm-pi-ai",
    profile: {
      api: "openai-responses",
      models: [{
        id: "gpt-5.6-terra",
        input: ["text", "image"],
        reasoningEfforts: { xhigh: "xhigh", max: "max" },
      }],
    },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(pi.models)), [{
    id: "gpt-5.6-terra",
    input: ["text", "image"],
    reasoning: true,
    thinkingLevelMap: { xhigh: "xhigh", max: "max" },
  }]);
});

// 回归：pi 的 thinkingLevelMap null 表恒等（发档位名本身），DSH 校验除 off 外每档必须
// 给非空 wire 值（settings-rejected: "needs the wire value dispatch should send"）。
// 迁移必须把非 off 档的 null 展开为档位名，否则 settings.update 被 DSH 拒。
test("pi null thinkingLevelMap entries expand to identity wire values for DSH", () => {
  const dsh = mapping.piToDshSnapshot({
    name: "tr",
    baseUrl: "https://x/v1",
    apiKey: "sk-test",
    models: [{
      id: "deepseek-v4-flash",
      name: "DeepSeek V4 Flash",
      contextWindow: 1000000,
      maxTokens: 384000,
      reasoning: true,
      input: ["text"],
      thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high" },
    }],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(dsh.profile.models?.[0]?.reasoningEfforts)), {
    minimal: "minimal",
    low: "low",
    medium: "medium",
    high: "high",
  });
});

test("off null stays null; off-only map becomes false (DSH rejects off-only efforts)", () => {
  const dsh = mapping.piToDshSnapshot({
    name: "tr",
    baseUrl: "https://x/v1",
    apiKey: "sk-test",
    models: [
      { id: "m1", reasoning: true, thinkingLevelMap: { off: null, xhigh: null, max: "max" } },
      { id: "m2", reasoning: true, thinkingLevelMap: { off: "none" } },
      { id: "m3", reasoning: true, thinkingLevelMap: { off: null } },
    ],
  });
  assert.deepEqual(JSON.parse(JSON.stringify(dsh.profile.models?.[0]?.reasoningEfforts)), {
    off: null,
    xhigh: "xhigh",
    max: "max",
  });
  // 只有 off 档（无思考级别）：按 DSH 官方指引 set false 声明为非思考模型，
  // 否则 settings.update 报 settings-rejected("reasoningEfforts offers no level beyond off")。
  assert.equal(dsh.profile.models?.[1]?.reasoningEfforts, false);
  assert.equal(dsh.profile.models?.[2]?.reasoningEfforts, false);
});

  assert.equal(dsh.profile.baseURL, "https://api.weishiair.de/v1");
  assert.equal(dsh.profile.apiKeyEnv, "WEISHIAIR_API_KEY");
  assert.equal(dsh.profile.models?.length, 1);
  assert.equal(dsh.profile.models?.[0]?.id, "grok-4.6");
  assert.equal(dsh.profile.models?.[0]?.name, "grok-4.6");
  assert.equal(dsh.profile.models?.[0]?.contextWindow, 128000);
  assert.deepEqual(dsh.profile.models?.[0]?.input, ["text", "image"]);
  assert.deepEqual(JSON.parse(JSON.stringify(dsh.profile.models?.[0]?.reasoningEfforts)), { xhigh: "xhigh", max: "max" });
  assert.equal(dsh.profile.models?.[0]?.cost, undefined);
});

test("official DeepSeek keeps the composition defaults when Pi only supplies its built-in catalog", () => {
  const dsh = mapping.piToDshSnapshot({
    name: "deepseek",
    baseUrl: "https://api.deepseek.com",
    api: "openai-completions",
    apiKey: "sk-ds",
    models: [{ id: "deepseek-v4-flash", input: ["text"] }],
    catalogOnly: true,
  });
  assert.equal(dsh.namespace, "llm-deepseek");
  // DSH's direct adapter already owns its endpoint, credential reference and catalog.
  // Migrating an auth.json-only Pi builtin must not materialize a user settings override.
  assert.deepEqual(JSON.parse(JSON.stringify(dsh.profile)), {});
  const merged = mapping.mergeDshProviderIntoSettings(
    { "ui-onboarding": { welcomeNoticeVersion: "keep-me" } },
    dsh,
  );
  assert.equal(merged["llm-deepseek"], undefined);
  assert.equal(merged["ui-onboarding"].welcomeNoticeVersion, "keep-me");
});

test("explicit official DeepSeek model overrides use the direct-adapter schema", () => {
  const dsh = mapping.piToDshSnapshot({
    name: "deepseek",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    models: [{
      id: "private-vision",
      name: "Private Vision",
      contextWindow: 512000,
      maxTokens: 64000,
      input: ["text", "image"],
      reasoning: true,
      thinkingLevelMap: { high: "high" },
    }],
  });
  assert.equal(dsh.namespace, "llm-deepseek");
  assert.equal(dsh.profile.api, undefined);
  assert.equal(dsh.profile.apiKeyEnv, undefined);
  assert.equal(dsh.profile.baseURL, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(dsh.profile.models)), [{
    id: "private-vision",
    name: "Private Vision",
    contextWindow: 512000,
    maxTokens: 64000,
    inputModalities: ["text", "image"],
  }]);
});

test("dsh settings yaml parse + merge keeps sibling namespaces", () => {
  const parsed = mapping.parseDshSettingsDocument({
    "ui-onboarding": { welcomeNoticeVersion: "1" },
    "llm-pi-ai": {
      providers: {
        weishiair: { baseURL: "https://api.weishiair.de/v1", models: [{ id: "grok-4.6" }] },
      },
    },
  });
  assert.equal(parsed.piAi.weishiair.baseURL, "https://api.weishiair.de/v1");
  const next = mapping.mergeDshProviderIntoSettings(
    { "ui-onboarding": { welcomeNoticeVersion: "1" }, "llm-pi-ai": { providers: { old: {} } } },
    {
      name: "weishiair",
      namespace: "llm-pi-ai",
      profile: { baseURL: "https://api.weishiair.de/v1", apiKeyEnv: "WEISHIAIR_API_KEY" },
    },
  );
  assert.equal(next["ui-onboarding"].welcomeNoticeVersion, "1");
  assert.ok(next["llm-pi-ai"].providers.old);
  assert.equal(next["llm-pi-ai"].providers.weishiair.baseURL, "https://api.weishiair.de/v1");
});

test("mergePiProvider writes the api key inline into models.json (ModelsTab-compatible)", () => {
  const merged = mapping.mergePiProvider(
    { providers: {} },
    {},
    {
      name: "weishiair",
      baseUrl: "https://api.weishiair.de/v1",
      api: "openai-completions",
      apiKey: "sk-test",
      models: [{ id: "grok-4.6" }],
    },
  );
  // 密钥内联进 models.json：PiDeck 的 ModelsTab 只读/写 provider.apiKey，
  // 若只写 auth.json 会让迁移后的 key 在 Models 页显示为空。
  assert.equal(merged.models.providers.weishiair.apiKey, "sk-test");
  assert.equal(merged.auth.weishiair, undefined);
});

test("unsafe provider names are rejected", () => {
  assert.equal(mapping.isSafeProviderName("../etc"), false);
  assert.equal(mapping.isSafeProviderName("weishiair"), true);
});

test("apply pi-to-dsh writes settings.yaml and credentials without starting host", async () => {
  const home = await mkdtemp(join(tmpdir(), "pideck-migrate-"));
  await writeFile(join(home, "settings.yaml"), "ui-onboarding:\n  welcomeNoticeVersion: keep-me\n", "utf8");
  const deps = {
    configManager: {
      getModelsConfig: async () => ({
        parsed: {
          providers: {
            weishiair: {
              baseUrl: "https://api.weishiair.de/v1",
              api: "openai-completions",
              apiKey: "sk-from-pi",
              models: [{ id: "grok-4.6", name: "grok-4.6" }],
            },
          },
        },
      }),
      getAuthConfig: async () => ({ parsed: {} }),
      saveModelsConfig: async () => ({ valid: true }),
      saveAuthConfig: async () => ({ valid: true }),
    },
    dshHost: {
      getHomeDir: () => home,
      isHostReady: () => false,
      updateSettings: async () => {
        throw new Error("must not start host");
      },
      setCredential: async () => {
        throw new Error("must not start host");
      },
      describeSettings: async () => ({ namespaces: [] }),
      readCredentialValue: async () => undefined,
    },
  };
  const result = await service.applyProviderMigration(deps, "pi-to-dsh", "weishiair");
  assert.equal(result.ok, true);
  assert.equal(result.copiedKey, true);
  assert.equal(result.wroteViaHost, false);
  const yaml = await readFile(join(home, "settings.yaml"), "utf8");
  assert.match(yaml, /welcomeNoticeVersion: keep-me/);
  assert.match(yaml, /weishiair:/);
  assert.match(yaml, /baseURL: https:\/\/api\.weishiair\.de\/v1/);
  const creds = await readFile(join(home, ".credentials.yaml"), "utf8");
  assert.match(creds, /WEISHIAIR_API_KEY:/);
  assert.match(creds, /sk-from-pi/);
});

test("apply pi-to-dsh uses the same valid legacy credential ref through a ready host", async () => {
  const calls = { patch: null, ref: null };
  const deps = {
    configManager: {
      getModelsConfig: async () => ({
        parsed: {
          providers: {
            输入: {
              baseUrl: "https://gateway.example/v1",
              api: "openai-completions",
              apiKey: "sk-from-pi",
              models: [{ id: "legacy-model" }],
            },
          },
        },
      }),
      getAuthConfig: async () => ({ parsed: {} }),
      saveModelsConfig: async () => ({ valid: true }),
      saveAuthConfig: async () => ({ valid: true }),
    },
    dshHost: {
      getHomeDir: () => "",
      isHostReady: () => true,
      updateSettings: async (_ns, patch) => {
        calls.patch = patch;
      },
      setCredential: async (ref) => {
        calls.ref = ref;
      },
      describeSettings: async () => ({
        namespaces: [{ ns: "llm-pi-ai", revision: 7, value: { providers: {} } }],
      }),
      readCredentialValue: async () => undefined,
    },
  };
  const result = await service.applyProviderMigration(deps, "pi-to-dsh", "输入");
  assert.equal(result.ok, true);
  assert.equal(result.wroteViaHost, true);
  const profile = calls.patch.providers["输入"];
  assert.match(profile.apiKeyEnv, /^PIDECK_[0-9A-F]{8}_API_KEY$/);
  assert.equal(calls.ref, profile.apiKeyEnv);
});
test("apply dsh-to-pi copies credential inline into models.json", async () => {
  const home = await mkdtemp(join(tmpdir(), "pideck-migrate-"));
  await writeFile(
    join(home, "settings.yaml"),
    "llm-pi-ai:\n  providers:\n    weishiair:\n      baseURL: https://api.weishiair.de/v1\n      api: openai-completions\n      models:\n        - id: grok-4.6\n",
    "utf8",
  );
  const saved = { models: null, auth: null };
  const deps = {
    configManager: {
      getModelsConfig: async () => ({ parsed: { providers: {} } }),
      getAuthConfig: async () => ({ parsed: {} }),
      saveModelsConfig: async (data) => {
        saved.models = data;
        return { valid: true };
      },
      saveAuthConfig: async (data) => {
        saved.auth = data;
        return { valid: true };
      },
    },
    dshHost: {
      getHomeDir: () => home,
      isHostReady: () => false,
      updateSettings: async () => undefined,
      setCredential: async () => undefined,
      describeSettings: async () => ({ namespaces: [] }),
      readCredentialValue: async (ref) => (ref === "WEISHIAIR_API_KEY" ? "sk-from-dsh" : undefined),
    },
  };
  const result = await service.applyProviderMigration(deps, "dsh-to-pi", "weishiair");
  assert.equal(result.ok, true);
  assert.equal(result.copiedKey, true);
  // key 内联进 models.json，ModelsTab 才能读到；auth.json 不再被迁移改动。
  assert.equal(saved.models.providers.weishiair.baseUrl, "https://api.weishiair.de/v1");
  assert.equal(saved.models.providers.weishiair.apiKey, "sk-from-dsh");
  assert.equal(saved.auth.weishiair, undefined);
});

test("apply dsh-to-pi for a pi built-in provider writes the key to auth.json only (layered storage)", async () => {
  const home = await mkdtemp(join(tmpdir(), "pideck-migrate-"));
  await writeFile(
    join(home, "settings.yaml"),
    "llm-pi-ai:\n  providers:\n    openrouter:\n      apiKeyEnv: OPENROUTER_API_KEY\n      baseURL: https://openrouter.ai/api/v1\n      api: openai-completions\n      models:\n        - id: stealth/ox-alpha\n",
    "utf8",
  );
  const calls = { modelsSaved: false, authSaved: null };
  const deps = {
    configManager: {
      getModelsConfig: async () => ({ parsed: { providers: {} } }),
      getAuthConfig: async () => ({ parsed: { OLD_PROVIDER: { type: "api_key", key: "sk-old" } } }),
      saveModelsConfig: async (data) => {
        calls.modelsSaved = true;
        return { valid: true };
      },
      saveAuthConfig: async (data) => {
        calls.authSaved = data;
        return { valid: true };
      },
    },
    dshHost: {
      getHomeDir: () => home,
      isHostReady: () => false,
      updateSettings: async () => undefined,
      setCredential: async () => undefined,
      describeSettings: async () => ({ namespaces: [] }),
      readCredentialValue: async (ref) => (ref === "OPENROUTER_API_KEY" ? "sk-or-from-dsh" : undefined),
    },
  };
  const result = await service.applyProviderMigration(deps, "dsh-to-pi", "openrouter");
  assert.equal(result.ok, true);
  assert.equal(result.copiedKey, true);
  // 内置名：key 落 auth.json，且不新建/不碰 models.json 条目
  assert.equal(calls.modelsSaved, false);
  assert.equal(calls.authSaved.openrouter.type, "api_key");
  assert.equal(calls.authSaved.openrouter.key, "sk-or-from-dsh");
  // 其它 auth 条目保留
  assert.equal(calls.authSaved.OLD_PROVIDER.key, "sk-old");
  assert.equal(calls.authSaved.OLD_PROVIDER.type, "api_key");
});

test("piBuiltinSnapshotFromCatalog builds a Pi snapshot from the catalog view", () => {
  const catalog = {
    byProviderId: new Map([
      ["openrouter", new Map([
        ["stealth/ox-alpha", { id: "stealth/ox-alpha", name: "Ox Alpha", contextWindow: 1048576, api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1", input: ["text", "image"], reasoning: true }],
        ["deepseek/deepseek-chat", { id: "deepseek/deepseek-chat" }],
      ])],
    ]),
  };
  const snapshot = mapping.piBuiltinSnapshotFromCatalog("openrouter", "  sk-or-1  ", catalog);
  assert.ok(snapshot);
  assert.equal(snapshot.name, "openrouter");
  assert.equal(snapshot.baseUrl, "https://openrouter.ai/api/v1");
  assert.equal(snapshot.api, "openai-completions");
  assert.equal(snapshot.apiKey, "sk-or-1");
  assert.equal(snapshot.models.length, 2);
  assert.equal(snapshot.models[0].id, "stealth/ox-alpha");
  assert.equal(snapshot.models[0].contextWindow, 1048576);
  assert.deepEqual(snapshot.models[0].input, ["text", "image"]);
});

test("piBuiltinSnapshotFromCatalog returns undefined when the catalog has no models", () => {
  const catalog = { byProviderId: new Map([["openrouter", new Map()]]) };
  assert.equal(mapping.piBuiltinSnapshotFromCatalog("openrouter", "sk", catalog), undefined);
  assert.equal(mapping.piBuiltinSnapshotFromCatalog("unknown", "sk", catalog), undefined);
});

test("apply pi-to-dsh migrates an auth.json-only builtin provider into DSH (catalog profile)", async () => {
  const home = await mkdtemp(join(tmpdir(), "pideck-migrate-"));
  await writeFile(
    join(home, "settings.yaml"),
    "llm-pi-ai:\n  providers:\n    openrouter:\n      apiKeyEnv: OPENROUTER_API_KEY\n      baseURL: https://openrouter.ai/api/v1\n      api: openai-completions\n",
    "utf8",
  );
  const saved = { settings: null, creds: null };
  const deps = {
    configManager: {
      getModelsConfig: async () => ({ parsed: { providers: {} } }),
      getAuthConfig: async () => ({ parsed: { openrouter: { type: "api_key", key: "sk-or-from-pi" } } }),
      saveModelsConfig: async (data) => ({ valid: true }),
      saveAuthConfig: async (data) => ({ valid: true }),
    },
    dshHost: {
      getHomeDir: () => home,
      isHostReady: () => false,
      updateSettings: async () => undefined,
      setCredential: async () => undefined,
      describeSettings: async () => ({ namespaces: [] }),
      readCredentialValue: async () => undefined,
    },
  };
  const result = await service.applyProviderMigration(deps, "pi-to-dsh", "openrouter");
  assert.equal(result.ok, true);
  assert.equal(result.copiedKey, true);
  assert.equal(result.wroteViaHost, false);
  const settings = await readFile(join(home, "settings.yaml"), "utf8");
  const creds = await readFile(join(home, ".credentials.yaml"), "utf8");
  assert.match(settings, /openrouter:/);
  assert.match(settings, /OPENROUTER_API_KEY/);
  assert.match(creds, /OPENROUTER_API_KEY:/);
  assert.match(creds, /sk-or-from-pi/);
});

test("apply pi-to-dsh rejects an OAuth-only builtin provider", async () => {
  const home = await mkdtemp(join(tmpdir(), "pideck-migrate-"));
  await writeFile(join(home, "settings.yaml"), "llm-pi-ai:\n  providers: {}\n", "utf8");
  const deps = {
    configManager: {
      getModelsConfig: async () => ({ parsed: { providers: {} } }),
      getAuthConfig: async () => ({ parsed: { "openai-codex": { type: "oauth", access: "x", refresh: "y", expires: 0 } } }),
      saveModelsConfig: async (data) => ({ valid: true }),
      saveAuthConfig: async (data) => ({ valid: true }),
    },
    dshHost: {
      getHomeDir: () => home,
      isHostReady: () => false,
      updateSettings: async () => undefined,
      setCredential: async () => undefined,
      describeSettings: async () => ({ namespaces: [] }),
      readCredentialValue: async () => undefined,
    },
  };
  const result = await service.applyProviderMigration(deps, "pi-to-dsh", "openai-codex");
  assert.equal(result.ok, false);
  assert.match(result.error || "", /OAuth/);
});

test("apply pi-to-dsh migrates an auth.json-only builtin provider even when DSH settings has no matching entry", async () => {
  const home = await mkdtemp(join(tmpdir(), "pideck-migrate-"));
  await writeFile(join(home, "settings.yaml"), "llm-pi-ai:\n  providers: {}\n", "utf8");
  const deps = {
    configManager: {
      getModelsConfig: async () => ({ parsed: { providers: {} } }),
      getAuthConfig: async () => ({ parsed: { deepseek: { type: "api_key", key: "sk-ds" } } }),
      saveModelsConfig: async (data) => ({ valid: true }),
      saveAuthConfig: async (data) => ({ valid: true }),
    },
    dshHost: {
      getHomeDir: () => home,
      isHostReady: () => false,
      updateSettings: async () => undefined,
      setCredential: async () => undefined,
      describeSettings: async () => ({ namespaces: [] }),
      readCredentialValue: async () => undefined,
    },
  };
  // DSH settings.yaml has no llm-deepseek user override: the direct adapter's
  // composition already provides the route, model catalog and DEEPSEEK_API_KEY ref.
  const result = await service.applyProviderMigration(deps, "pi-to-dsh", "deepseek");
  assert.equal(result.ok, true);
  assert.equal(result.copiedKey, true);
  assert.equal(result.wroteViaHost, false);
  const settings = await readFile(join(home, "settings.yaml"), "utf8");
  const creds = await readFile(join(home, ".credentials.yaml"), "utf8");
  assert.doesNotMatch(settings, /llm-deepseek:/);
  assert.doesNotMatch(settings, /DEEPSEEK_API_KEY/);
  assert.match(creds, /DEEPSEEK_API_KEY:/);
  assert.match(creds, /sk-ds/);
});

test("auth-only official DeepSeek migration to a ready host writes only the credential", async () => {
  const home = await mkdtemp(join(tmpdir(), "pideck-migrate-"));
  const calls = { describe: 0, update: 0, credential: null };
  const deps = {
    configManager: {
      getModelsConfig: async () => ({ parsed: { providers: {} } }),
      getAuthConfig: async () => ({ parsed: { deepseek: { type: "api_key", key: "sk-ds-host" } } }),
      saveModelsConfig: async () => ({ valid: true }),
      saveAuthConfig: async () => ({ valid: true }),
    },
    dshHost: {
      getHomeDir: () => home,
      isHostReady: () => true,
      describeSettings: async () => {
        calls.describe += 1;
        return { namespaces: [] };
      },
      updateSettings: async () => {
        calls.update += 1;
      },
      setCredential: async (ref, value) => {
        calls.credential = { ref, value };
      },
      readCredentialValue: async () => undefined,
    },
  };
  const result = await service.applyProviderMigration(deps, "pi-to-dsh", "deepseek");
  assert.equal(result.ok, true);
  assert.equal(result.wroteViaHost, true);
  assert.equal(calls.describe, 0);
  assert.equal(calls.update, 0);
  assert.deepEqual(calls.credential, { ref: "DEEPSEEK_API_KEY", value: "sk-ds-host" });
});

test("apply dsh-to-pi migrates the built-in DeepSeek credential without a settings override", async () => {
  const home = await mkdtemp(join(tmpdir(), "pideck-migrate-"));
  await writeFile(join(home, "settings.yaml"), "ui-onboarding:\n  welcomeNoticeVersion: keep-me\n", "utf8");
  const calls = { modelsSaved: false, authSaved: null };
  const deps = {
    configManager: {
      getModelsConfig: async () => ({ parsed: { providers: {} } }),
      getAuthConfig: async () => ({ parsed: {} }),
      saveModelsConfig: async () => {
        calls.modelsSaved = true;
        return { valid: true };
      },
      saveAuthConfig: async (data) => {
        calls.authSaved = data;
        return { valid: true };
      },
    },
    dshHost: {
      getHomeDir: () => home,
      isHostReady: () => false,
      updateSettings: async () => undefined,
      setCredential: async () => undefined,
      describeSettings: async () => ({ namespaces: [] }),
      readCredentialValue: async (ref) => (ref === "DEEPSEEK_API_KEY" ? "sk-from-dsh" : undefined),
    },
  };
  const result = await service.applyProviderMigration(deps, "dsh-to-pi", "deepseek");
  assert.equal(result.ok, true);
  assert.equal(result.copiedKey, true);
  assert.equal(calls.modelsSaved, false);
  assert.equal(calls.authSaved.deepseek.type, "api_key");
  assert.equal(calls.authSaved.deepseek.key, "sk-from-dsh");
});

test("source contracts keep IPC / preload / UI wired", async () => {
  const ipc = await readFile(join(process.cwd(), "src/shared/ipc.ts"), "utf8");
  const preload = await readFile(join(process.cwd(), "src/preload/index.ts"), "utf8");
  const systemIpc = await readFile(join(process.cwd(), "src/main/ipc/systemIpc.ts"), "utf8");
  const modelsTab = await readFile(join(process.cwd(), "src/renderer/src/config/ModelsTab.tsx"), "utf8");
  const authTab = await readFile(join(process.cwd(), "src/renderer/src/config/AuthTab.tsx"), "utf8");
  const dshCards = await readFile(join(process.cwd(), "src/renderer/src/config/DshProviderCards.tsx"), "utf8");
  assert.match(ipc, /configPreviewProviderMigration/);
  assert.match(preload, /previewProviderMigration/);
  assert.match(systemIpc, /applyProviderMigration/);
  assert.match(modelsTab, /direction="pi-to-dsh"/);
  assert.match(authTab, /ProviderMigrationButton/);
  assert.match(authTab, /direction="pi-to-dsh"/);
  assert.match(dshCards, /direction="dsh-to-pi"/);
});

test("mergeCredentialDocument writes dsh-credentials-local v1 layout (version:1 + refs)", () => {
  // 空文档 → v1
  const fromEmpty = mapping.mergeCredentialDocument("", "DEEPSEEK_API_KEY", "sk-abc");
  const parsedEmpty = JSON.parse(JSON.stringify(mapping.loadYamlObject(fromEmpty)));
  assert.equal(parsedEmpty.version, 1);
  assert.equal(parsedEmpty.refs.DEEPSEEK_API_KEY, "sk-abc");

  // 旧扁平布局 → 迁入 refs 层，输出 v1
  const fromFlat = mapping.mergeCredentialDocument(
    ["DEEPSEEK_API_KEY: sk-old", "WBX_API_KEY: sk-wbx", ""].join("\n"),
    "WBX_API_KEY",
    "sk-wbx-new",
  );
  const parsedFlat = JSON.parse(JSON.stringify(mapping.loadYamlObject(fromFlat)));
  assert.equal(parsedFlat.version, 1);
  assert.equal(parsedFlat.refs.DEEPSEEK_API_KEY, "sk-old");
  assert.equal(parsedFlat.refs.WBX_API_KEY, "sk-wbx-new");

  // 已是 v1 → 只改 refs 层，保留 records
  const fromV1 = mapping.mergeCredentialDocument(
    ["version: 1", "refs:", "  A_KEY: sk-a", "records:", "  r: x", ""].join("\n"),
    "A_KEY",
    "sk-a-new",
  );
  const parsedV1 = JSON.parse(JSON.stringify(mapping.loadYamlObject(fromV1)));
  assert.equal(parsedV1.version, 1);
  assert.equal(parsedV1.refs.A_KEY, "sk-a-new");
  assert.equal(parsedV1.records.r, "x");
});
test("resolvePiApiKey 优先内联 key，其次 auth.key，OAuth 凭据兜底读 access", () => {
  // 内联 apiKey 优先
  assert.equal(mapping.resolvePiApiKey({ apiKey: "inline-key" }, undefined), "inline-key");
  // auth.key 次之
  assert.equal(mapping.resolvePiApiKey({}, { type: "api_key", key: "auth-key" }), "auth-key");
  // OAuth 凭据（type:oauth）没有 key 时兜底 access（Codex/xAI/Copilot 消费者订阅用量查询用）
  assert.equal(mapping.resolvePiApiKey({}, { type: "oauth", access: "oauth-access", refresh: "r", expires: 1 }), "oauth-access");
  // 非 oauth 类型没有 access 不误读
  assert.equal(mapping.resolvePiApiKey({}, { type: "api_key", key: "k" }), "k");
  // oauth 凭据缺 access 返回 undefined
  assert.equal(mapping.resolvePiApiKey({}, { type: "oauth", refresh: "r", expires: 1 }), undefined);
  // 无任何凭据返回 undefined
  assert.equal(mapping.resolvePiApiKey(undefined, undefined), undefined);
});
