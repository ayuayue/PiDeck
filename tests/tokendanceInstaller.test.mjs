import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

// 加载真实 TS 依赖图（installer 经动态 import 复用 providerMigrationService 的写盘策略）
const installer = loadTsCommonJs("src/main/config/tokendanceInstaller.ts");

/** 目录 store 替身：getModels/refresh 返回固定目录（免真实网络）；refresh 默认成功。 */
function makeCatalog(models = [{ id: "glm-4.7" }, { id: "deepseek-v4-flash", contextWindow: 128000 }]) {
	let refreshCount = 0;
	return {
		getModels: async () => ({ models, fromCache: false, at: 1700000000000 }),
		refresh: async () => {
			refreshCount += 1;
			return { models, fromCache: false, at: 1700000000000 };
		},
		_refreshCount: () => refreshCount,
	};
}

/** ConfigManager 替身：内存版 models.json（save 后可从 _dump 读回断言）。 */
function makeConfigManager(initialProviders = {}) {
	let providers = { ...initialProviders };
	return {
		getModelsConfig: async () => ({ parsed: { providers } }),
		getAuthConfig: async () => ({ parsed: {} }),
		saveModelsConfig: async (next) => {
			providers = { ...(next?.providers ?? {}) };
			return { valid: true };
		},
		_dump: () => providers,
	};
}

/** DSH host 替身：ready 时走官方 settings API（记录调用），否则磁盘直写（读临时目录文件）。 */
function makeDshHost({ ready = true, home = undefined } = {}) {
	const calls = { updateSettings: [], setCredential: [] };
	return {
		isHostReady: () => ready,
		getHomeDir: () => home ?? "/tmp/dsh-home",
		describeSettings: async () => ({
			namespaces: [{ ns: "llm-pi-ai", value: { providers: {} }, revision: 1 }],
		}),
		updateSettings: async (ns, patch, revision) => {
			calls.updateSettings.push({ ns, patch, revision });
		},
		setCredential: async (ref, value) => {
			calls.setCredential.push({ ref, value });
		},
		readCredentialValue: async () => undefined,
		_calls: calls,
	};
}

test("一键安装：pi models.json 写入 provider（baseUrl/归因头/模型），DSH 走 host 写入", async () => {
	const configManager = makeConfigManager();
	const dshHost = makeDshHost({ ready: true });
	const result = await installer.installTokendanceProvider(
		{ configManager, dshHost, tokendanceCatalog: makeCatalog() },
		{},
	);
	assert.equal(result.ok, true);
	assert.equal(result.modelCount, 2);
	assert.equal(result.piSaved, true);
	assert.equal(result.dshSaved, true);

	const provider = configManager._dump()["tokendance"];
	assert.equal(provider.baseUrl, "https://tokendance.space/gateway/v1");
	assert.equal(provider.api, "openai-completions");
	// 请求维度归因：X-App-URL 覆盖 Key 上的 app_url
	assert.equal(provider.headers["X-App-URL"], "https://pideck.caoayu.top/");
	assert.equal(provider.models.length, 2);
	assert.equal(provider.models[1].contextWindow, 128000);

	// DSH 侧：llm-pi-ai.providers.tokendance（displayName/baseURL/api/apiKeyEnv/models）+ 凭证
	const dshCall = dshHost._calls.updateSettings[0];
	assert.equal(dshCall.ns, "llm-pi-ai");
	assert.equal(dshCall.patch.providers.tokendance.displayName, "TokenDance");
	assert.equal(dshCall.patch.providers.tokendance.baseURL, "https://tokendance.space/gateway/v1");
	assert.equal(dshCall.patch.providers.tokendance.apiKeyEnv, "TOKENDANCE_API_KEY");
	assert.equal(dshCall.patch.providers.tokendance.models.length, 2);
	// 未传 apiKey 时不写凭证（Key 由用户后续经 OAuth/粘贴提供）
	assert.equal(dshHost._calls.setCredential.length, 0);
});

test("传入 apiKey：写入 pi provider.apiKey（与 ModelsTab 编辑器一致）", async () => {
	const configManager = makeConfigManager();
	const dshHost = makeDshHost({ ready: true });
	const result = await installer.installTokendanceProvider(
		{ configManager, dshHost, tokendanceCatalog: makeCatalog() },
		{ apiKey: "sk-test-123" },
	);
	assert.equal(result.ok, true);
	assert.equal(configManager._dump()["tokendance"].apiKey, "sk-test-123");
	// Key 同步写入 DSH 凭证
	assert.equal(dshHost._calls.setCredential[0]?.value, "sk-test-123");
});

test("幂等：models.json 已有 tokendance 条目时保留既有 apiKey，仅更新模型/端点", async () => {
	const configManager = makeConfigManager({
		tokendance: { apiKey: "sk-old", models: [], baseUrl: "https://old.example/v1" },
	});
	const dshHost = makeDshHost({ ready: true });
	const result = await installer.installTokendanceProvider(
		{ configManager, dshHost, tokendanceCatalog: makeCatalog() },
		{},
	);
	assert.equal(result.ok, true);
	const provider = configManager._dump()["tokendance"];
	assert.equal(provider.apiKey, "sk-old", "用户已有 Key 不应被覆盖");
	assert.equal(provider.baseUrl, "https://tokendance.space/gateway/v1");
	assert.equal(provider.models.length, 2);
});

test("目录为空：返回 ok=false，不写任何配置", async () => {
	const configManager = makeConfigManager();
	const dshHost = makeDshHost({ ready: true });
	const result = await installer.installTokendanceProvider(
		{ configManager, dshHost, tokendanceCatalog: makeCatalog([]) },
		{},
	);
	assert.equal(result.ok, false);
	assert.equal(result.piSaved, false);
	assert.equal(Object.keys(configManager._dump()).length, 0);
	assert.equal(dshHost._calls.updateSettings.length, 0);
});

test("DSH 写入失败：pi 侧仍成功（dshSaved=false 且 dshError 带回原因）", async () => {
	const configManager = makeConfigManager();
	const dshHost = makeDshHost({ ready: true });
	dshHost.updateSettings = async () => {
		throw new Error("settings rejected");
	};
	const result = await installer.installTokendanceProvider(
		{ configManager, dshHost, tokendanceCatalog: makeCatalog() },
		{},
	);
	assert.equal(result.ok, true);
	assert.equal(result.piSaved, true);
	assert.equal(result.dshSaved, false);
	assert.equal(result.dshError, "settings rejected");
	assert.equal(configManager._dump()["tokendance"].models.length, 2);
});

test("contextWindow 非正整数（0）不写入：pi 报 invalid contextWindow 会拒绝整个 provider", async () => {
	const configManager = makeConfigManager();
	const dshHost = makeDshHost({ ready: true });
	const result = await installer.installTokendanceProvider(
		{
			configManager,
			dshHost,
			tokendanceCatalog: makeCatalog([
				{ id: "seedream-5.0-lite", contextWindow: 0 },
				{ id: "glm-4.7", contextWindow: 200000 },
			]),
		},
		{},
	);
	assert.equal(result.ok, true);
	const [bad, good] = configManager._dump()["tokendance"].models;
	assert.equal(bad.contextWindow, undefined);
	assert.equal(bad.id, "seedream-5.0-lite");
	assert.equal(good.contextWindow, 200000);
	// DSH 侧同步过滤：DSH schema contextWindow min(1) 拒绝 0，必须不写入
	const dshPatch = dshHost._calls.updateSettings[0].patch;
	const dshModels = dshPatch.providers.tokendance.models;
	assert.equal(dshModels[0].contextWindow, undefined);
	assert.equal(dshModels[0].id, "seedream-5.0-lite");
	assert.equal(dshModels[1].contextWindow, 200000);
});

test("安装前强制 refresh 目录（旧缓存可能含坏数据；refresh 失败降级 getModels）", async () => {
	const configManager = makeConfigManager();
	const dshHost = makeDshHost({ ready: true });
	const catalog = makeCatalog();
	const result = await installer.installTokendanceProvider(
		{ configManager, dshHost, tokendanceCatalog: catalog },
		{},
	);
	assert.equal(result.ok, true);
	assert.equal(catalog._refreshCount(), 1);
});

test("catalogLookup：目录命中时补 maxTokens/reasoning/input/thinkingLevelMap，未命中不写", async () => {
	const configManager = makeConfigManager();
	const dshHost = makeDshHost({ ready: true });
	const result = await installer.installTokendanceProvider(
		{
			configManager,
			dshHost,
			tokendanceCatalog: makeCatalog([
				{ id: "glm-4.7", name: "Z.ai: GLM 4.7", contextWindow: 200000 },
				{ id: "qq-custom-model" },
			]),
			catalogLookup: (modelId) => {
				if (modelId === "glm-4.7") {
					return {
						id: "glm-4.7",
						provider: "zai",
						maxTokens: 131072,
						reasoning: true,
						input: ["text"],
						thinkingLevelMap: { off: "off", high: "high" },
					};
				}
				return undefined;
			},
		},
		{},
	);
	assert.equal(result.ok, true);
	const [hit, miss] = configManager._dump()["tokendance"].models;
	// 目录权威：contextWindow 用 TokenDance 实报值，即使 catalog 不同也以平台为准
	assert.equal(hit.contextWindow, 200000);
	assert.equal(hit.maxTokens, 131072);
	assert.equal(hit.reasoning, true);
	// vm 跨 realm 数组 prototype 不同，deepStrictEqual 会因引用不等误报，用快照比较
	assert.equal(JSON.stringify(hit.input), JSON.stringify(["text"]));
	assert.equal(JSON.stringify(hit.thinkingLevelMap), JSON.stringify({ off: "off", high: "high" }));
	// 未命中目录的模型不写能力字段（不猜默认值，保持 omit）
	assert.equal(miss.maxTokens, undefined);
	assert.equal(miss.reasoning, undefined);
	assert.equal(miss.thinkingLevelMap, undefined);
});
