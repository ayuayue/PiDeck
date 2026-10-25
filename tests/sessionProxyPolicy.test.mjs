import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const {
	applyPiProxyMode,
	aggregateDshProxyMode,
	buildHostProxyEnvPatch,
	applyProxyEnvPatch,
	PROXY_ENV_KEYS,
	PIDECK_PI_PROXY_SCOPE,
	PIDECK_PI_PROXY_SCOPE_MODEL_ONLY,
	resolveModelProxyMode,
	resolveListedProxyMode,
	resolveEffectiveSessionProxyMode,
	resolveDshHostProxyMode,
	applyPiProxyModeWithProvider,
	computeGenProxyKey,
	buildPiProxyEnvPatch,
} = loadTsCommonJs("src/main/sessions/sessionProxyPolicy.ts");

// 名单启用判据与设置页共用（设置页据此置灰主开关）。
const { hasPiProxyListFilter } = loadTsCommonJs("src/shared/piProxyList.ts");

// 注：loadTsCommonJs 跨 vm realm 加载，对象原型与本地不同，deepEqual 会因 prototype
// 不等而失败；统一用逐字段断言。

test("applyPiProxyMode: follow/undefined 原样返回（同一引用）", () => {
	const settings = { piProxyEnabled: true, piProxyUrl: "http://127.0.0.1:7890" };
	assert.equal(applyPiProxyMode(settings, undefined), settings);
	assert.equal(applyPiProxyMode(settings, "follow"), settings);
	assert.equal(applyPiProxyMode(undefined, "on"), undefined);
});

test("applyPiProxyMode: on 强制开启、保留全局 URL，off 强制关闭", () => {
	const on = applyPiProxyMode({ piProxyEnabled: false, piProxyUrl: "http://127.0.0.1:7890" }, "on");
	assert.equal(on.piProxyEnabled, true);
	assert.equal(on.piProxyUrl, "http://127.0.0.1:7890");
	// 全局开着时 off 仍强制关闭（“不想开代理的会话”核心诉求）
	const off = applyPiProxyMode({ piProxyEnabled: true, piProxyUrl: "http://127.0.0.1:7890" }, "off");
	assert.equal(off.piProxyEnabled, false);
	assert.equal(off.piProxyUrl, "http://127.0.0.1:7890");
});

test("aggregateDshProxyMode: 空/全 follow → follow；任一 off 一票否决；无 off 有 on → on", () => {
	assert.equal(aggregateDshProxyMode([]), "follow");
	assert.equal(aggregateDshProxyMode([undefined, { mode: "follow" }]), "follow");
	// off 优先于 on（直连是安全默认，显式直连表达最强意图）
	assert.equal(aggregateDshProxyMode([{ mode: "on" }, { mode: "off" }]), "off");
	assert.equal(aggregateDshProxyMode([{ mode: "off" }, { mode: "follow" }]), "off");
	assert.equal(aggregateDshProxyMode([{ mode: "on" }, undefined, { mode: "follow" }]), "on");
});

test("buildHostProxyEnvPatch: off → 剥离全部标准代理 env（含 NO_PROXY）与 NODE_USE_ENV_PROXY", () => {
	const patch = buildHostProxyEnvPatch("off", { url: "http://127.0.0.1:7890", bypass: "localhost" });
	assert.ok(patch);
	assert.equal(Object.keys(patch.set).length, 0);
	assert.deepEqual([...patch.unset].sort(), ["ALL_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "all_proxy", "http_proxy", "https_proxy", "no_proxy", "NODE_USE_ENV_PROXY"].sort());
});

test("buildHostProxyEnvPatch: on → 注入大小写双份 + bypass + NODE_USE_ENV_PROXY=1；URL 为空返回 undefined", () => {
	const patch = buildHostProxyEnvPatch("on", { url: "  http://127.0.0.1:7890  ", bypass: "localhost,127.0.0.1" });
	assert.ok(patch);
	for (const key of PROXY_ENV_KEYS) assert.equal(patch.set[key], "http://127.0.0.1:7890");
	assert.equal(patch.set.NO_PROXY, "localhost,127.0.0.1");
	assert.equal(patch.set.no_proxy, "localhost,127.0.0.1");
	// NODE_USE_ENV_PROXY=1：undici fetch 的 env 代理开关（没有它注入的代理 env 不生效）
	assert.equal(patch.set.NODE_USE_ENV_PROXY, "1");
	// 全局 URL 空：无法代理，返回 undefined 表示不动（等用户先配 URL）
	assert.equal(buildHostProxyEnvPatch("on", { url: "  ", bypass: "" }), undefined);
});

test("buildHostProxyEnvPatch: follow → undefined（保持 host 现有行为）", () => {
	assert.equal(buildHostProxyEnvPatch("follow", { url: "http://x", bypass: "" }), undefined);
});

test("resolveModelProxyMode: 空名单/无模型 → undefined；命中 provider/modelId → on，未命中 → off", () => {
	assert.equal(resolveModelProxyMode("openai", "gpt-4o", undefined), undefined);
	assert.equal(resolveModelProxyMode("openai", "gpt-4o", []), undefined);
	// 会话还没选模型时不做模型级判定（交供应商名单/全局兜底）
	assert.equal(resolveModelProxyMode(undefined, undefined, ["openai/gpt-4o"]), undefined);
	assert.equal(resolveModelProxyMode("openai", undefined, ["openai/gpt-4o"]), undefined);
	assert.equal(resolveModelProxyMode("openai", "gpt-4o", ["openai/gpt-4o"]), "on");
	assert.equal(resolveModelProxyMode("openai", "gpt-4o", ["openai/gpt-4o", "anthropic/claude-3-5-sonnet"]), "on");
	assert.equal(resolveModelProxyMode("openai", "gpt-4o", ["anthropic/claude-3-5-sonnet"]), "off");
	// 同名模型在不同 provider 下不互相误伤（条目是 provider/modelId 组合）
	assert.equal(resolveModelProxyMode("deepseek", "deepseek-r1", ["azure/deepseek-r1"]), "off");
});

test("resolveListedProxyMode: 两级名单都空 → undefined（跟随全局）", () => {
	assert.equal(resolveListedProxyMode("openai", "gpt-4o", undefined, undefined), undefined);
	assert.equal(resolveListedProxyMode("openai", "gpt-4o", [], []), undefined);
});

test("resolveListedProxyMode: 仅供应商名单时与旧版行为一致（名单内 on、名单外 off）", () => {
	assert.equal(resolveListedProxyMode("openai", "gpt-4o", ["openai"], []), "on");
	assert.equal(resolveListedProxyMode("openai", undefined, ["openai"], []), "on");
	assert.equal(resolveListedProxyMode("anthropic", "claude-3-5-sonnet", ["openai"], []), "off");
});

test("resolveListedProxyMode: 仅模型名单时按 provider/modelId 判定", () => {
	assert.equal(resolveListedProxyMode("openai", "gpt-4o", [], ["openai/gpt-4o"]), "on");
	assert.equal(resolveListedProxyMode("openai", "gpt-4o-mini", [], ["openai/gpt-4o"]), "off");
});

test("resolveListedProxyMode: 模型名单优先匹配，供应商名单兜底，名单已启用但都未命中 → off", () => {
	// 模型命中 → on（即使供应商也在名单，模型粒度更精确）
	assert.equal(resolveListedProxyMode("openai", "gpt-4o", ["openai", "anthropic"], ["openai/gpt-4o"]), "on");
	// 模型未命中但供应商命中 → on（供应商名单是粗粒度兜底：整个供应商都走代理）
	assert.equal(resolveListedProxyMode("openai", "gpt-4o-mini", ["openai"], ["openai/gpt-4o"]), "on");
	assert.equal(resolveListedProxyMode("openai", "gpt-4o-mini", ["openai"], ["anthropic/claude-3-5-sonnet"]), "on");
	// 两级名单都启用但均未命中 → off（黑白名单语义：名单外强制直连）
	assert.equal(resolveListedProxyMode("anthropic", "claude-3-5-sonnet", ["openai"], ["openai/gpt-4o"]), "off");
});

test("resolveEffectiveSessionProxyMode: 会话显式 on/off 最高优，名单其次，最终 follow", () => {
	assert.equal(resolveEffectiveSessionProxyMode("on", "openai", "gpt-4o", [], []), "on");
	assert.equal(resolveEffectiveSessionProxyMode("off", "openai", "gpt-4o", ["openai"], []), "off");
	assert.equal(resolveEffectiveSessionProxyMode(undefined, "openai", "gpt-4o", [], ["openai/gpt-4o"]), "on");
	assert.equal(resolveEffectiveSessionProxyMode(undefined, "openai", "gpt-4o-mini", ["openai"], []), "on");
	assert.equal(resolveEffectiveSessionProxyMode(undefined, "openai", "gpt-4o-mini", [], ["openai/gpt-4o"]), "off");
	assert.equal(resolveEffectiveSessionProxyMode(undefined, "openai", "gpt-4o", [], []), "follow");
});

test("applyPiProxyModeWithProvider: 模型名单内即使全局关闭也强制开启（force_on），名单外强制关闭", () => {
	const base = {
		piProxyEnabled: false,
		piProxyUrl: "http://127.0.0.1:7890",
		piProxyProviders: [],
		piProxyModels: ["openai/gpt-4o"],
	};
	// 全局关闭 + 模型在名单 → 强制开启并复用全局 URL
	const on = applyPiProxyModeWithProvider(base, "follow", "openai", "gpt-4o");
	assert.equal(on.piProxyEnabled, true);
	assert.equal(on.piProxyUrl, "http://127.0.0.1:7890");
	// 全局关闭 + 模型不在名单 → 强制关闭
	const off = applyPiProxyModeWithProvider(base, "follow", "openai", "gpt-4o-mini");
	assert.equal(off.piProxyEnabled, false);
	// 无模型命中时回落供应商名单（force_on 语义同样生效）
	const providersOnly = {
		...base,
		piProxyModels: [],
		piProxyProviders: ["openai"],
	};
	assert.equal(applyPiProxyModeWithProvider(providersOnly, "follow", "openai", "gpt-4o-mini").piProxyEnabled, true);
	assert.equal(applyPiProxyModeWithProvider(providersOnly, "follow", "anthropic", "claude-3-5-sonnet").piProxyEnabled, false);
	// 名单都空 → 原样返回（跟随全局，不创建新对象）
	const noList = { ...base, piProxyProviders: [], piProxyModels: [] };
	assert.equal(applyPiProxyModeWithProvider(noList, "follow", "openai", "gpt-4o"), noList);
});

test("hasPiProxyListFilter: 为真 ⟺ 主开关不再参与决策（设置页置灰判据与策略同源）", () => {
	const cases = [
		{ providers: [], models: [] },
		{ providers: [], models: ["openai/gpt-4o"] },
		{ providers: ["openai"], models: [] },
		{ providers: ["openai"], models: ["anthropic/claude-3-5-sonnet"] },
	];
	for (const { providers, models } of cases) {
		const listActive = hasPiProxyListFilter(providers, models);
		for (const provider of ["openai", "anthropic"]) {
			for (const modelId of ["gpt-4o", "claude-3-5-sonnet"]) {
				const base = { piProxyUrl: "http://127.0.0.1:7890", piProxyProviders: providers, piProxyModels: models };
				const off = applyPiProxyModeWithProvider({ ...base, piProxyEnabled: false }, "follow", provider, modelId);
				const on = applyPiProxyModeWithProvider({ ...base, piProxyEnabled: true }, "follow", provider, modelId);
				const switchMatters = off.piProxyEnabled !== on.piProxyEnabled;
				// 名单非空 → 开关彻底失效（置灰是诚实的）；名单为空 → 开关决定结果（不能误置灰）。
				assert.equal(switchMatters, !listActive, `名单 ${JSON.stringify({ providers, models })} 在 ${provider}/${modelId} 上主开关应${listActive ? "失效" : "生效"}`);
			}
		}
	}
});

test("computeGenProxyKey: 序列化实际生效的代理状态（含名单命中/绕过列表）", () => {
	const base = { piProxyEnabled: false, piProxyUrl: "http://127.0.0.1:7890", piProxyBypass: "", piProxyModels: ["openai/gpt-4o"] };
	// 全局关但名单命中 → 强制 on（指纹 on + URL）
	assert.equal(computeGenProxyKey(base, "openai", "gpt-4o"), "on|http://127.0.0.1:7890|");
	// 名单启用但未命中 → off（黑白名单语义）
	assert.equal(computeGenProxyKey(base, "openai", "gpt-4o-mini"), "off");
	// 名单未启用 + 全局关 → off
	assert.equal(computeGenProxyKey({ piProxyEnabled: false, piProxyUrl: "x", piProxyBypass: "b", piProxyModels: [] }, "openai", "gpt-4o"), "off");
	// 全局开 → on（即使名单为空）；绕过列表参与指纹（改 bypass 需重建进程）
	assert.equal(computeGenProxyKey({ piProxyEnabled: true, piProxyUrl: "http://127.0.0.1:7890", piProxyBypass: "localhost", piProxyModels: [] }, "openai", "gpt-4o"), "on|http://127.0.0.1:7890|localhost");
});

test("resolveDshHostProxyMode: 会话聚合非 follow 时直接返回（不兜底）", () => {
	assert.equal(resolveDshHostProxyMode("on", { piProxyEnabled: false, hasList: false }), "on");
	// off 一票否决优先于全局开关
	assert.equal(resolveDshHostProxyMode("off", { piProxyEnabled: true, hasList: false }), "off");
});

test("resolveDshHostProxyMode: follow + 全局开且无名单 → on（与 pi 跟随全局一致）", () => {
	assert.equal(resolveDshHostProxyMode("follow", { piProxyEnabled: true, hasList: false }), "on");
	// 全局关 → follow（host 不动，保持现有行为）
	assert.equal(resolveDshHostProxyMode("follow", { piProxyEnabled: false, hasList: false }), "follow");
});

test("resolveDshHostProxyMode: 名单启用时不 fallback（follow 保持直连语义）", () => {
	// 名单非空时全局开关无法覆盖：follow 表示会话未被名单命中，应保持直连
	// （与 pi 会话名单外强制直连一致），避免全局开关破坏名单语义
	assert.equal(resolveDshHostProxyMode("follow", { piProxyEnabled: true, hasList: true }), "follow");
});

test("applyProxyEnvPatch: 先剥离后注入，顺序固定", () => {
	const env = { HTTP_PROXY: "http://system", PATH: "/usr/bin", NO_PROXY: "old" };
	applyProxyEnvPatch(env, {
		set: { HTTP_PROXY: "http://127.0.0.1:7890" },
		unset: ["NO_PROXY"],
	});
	assert.equal(env.HTTP_PROXY, "http://127.0.0.1:7890");
	assert.equal(env.NO_PROXY, undefined);
	assert.equal(env.PATH, "/usr/bin");
	// off 场景：无 set，只剥离
	const env2 = { HTTP_PROXY: "http://system", http_proxy: "http://system" };
	const off = buildHostProxyEnvPatch("off", { url: "x", bypass: "" });
	applyProxyEnvPatch(env2, off);
	assert.deepEqual(Object.keys(env2), []);
});
// ── buildPiProxyEnvPatch：pi 子进程代理 env（★2026-09 故障回归） ──────────────
// 真实故障：用户报告 anyrouter.top / agentrouter.org 在 PiDeck 里「拉不到模型 +
// 手填模型也用不了」，但 cc-switch 正常。根因之一是 pi 子进程只注入了 HTTPS_PROXY
// 等 URL，漏了 NODE_USE_ENV_PROXY —— pi 的 LLM 调用走 undici，默认不读这些 env，
// 于是「配了代理 = 没配代理」，请求仍直连而失败。

test("buildPiProxyEnvPatch: 开启代理必须带 NODE_USE_ENV_PROXY=1（否则 undici 无视 HTTPS_PROXY）", () => {
	const patch = buildPiProxyEnvPatch({
		piProxyEnabled: true,
		piProxyUrl: "http://127.0.0.1:7890",
		piProxyBypass: "",
	});
	assert.ok(patch, "开启且 URL 非空时必须返回 patch");
	// 回归核心：这一项缺失 = 用户的代理设置对 pi 的模型请求完全无效。
	assert.equal(patch.NODE_USE_ENV_PROXY, "1");
	assert.equal(patch[PIDECK_PI_PROXY_SCOPE], PIDECK_PI_PROXY_SCOPE_MODEL_ONLY);
	// 标准代理键大小写双份（覆盖 win/mac/linux 工具链）
	for (const key of PROXY_ENV_KEYS) assert.equal(patch[key], "http://127.0.0.1:7890");
	// 未配 bypass 时不注入 NO_PROXY，避免空值把系统既有绕过规则清掉
	assert.equal(patch.NO_PROXY, undefined);
	assert.equal(patch.no_proxy, undefined);
});

test("buildPiProxyEnvPatch: 关闭开关 / URL 为空 → 不注入任何代理 env", () => {
	assert.equal(buildPiProxyEnvPatch({ piProxyEnabled: false, piProxyUrl: "http://127.0.0.1:7890", piProxyBypass: "" }), undefined);
	// 开关开着但没填地址：无法代理，应保持原 env 而不是注入半个配置
	assert.equal(buildPiProxyEnvPatch({ piProxyEnabled: true, piProxyUrl: "   ", piProxyBypass: "" }), undefined);
	assert.equal(buildPiProxyEnvPatch(undefined), undefined);
});

test("buildPiProxyEnvPatch: bypass 非空 → 注入 NO_PROXY 大小写双份并 trim URL", () => {
	const patch = buildPiProxyEnvPatch({
		piProxyEnabled: true,
		piProxyUrl: "  http://127.0.0.1:7890  ",
		piProxyBypass: " localhost,127.0.0.1 ",
	});
	assert.ok(patch);
	assert.equal(patch.HTTPS_PROXY, "http://127.0.0.1:7890");
	assert.equal(patch.NO_PROXY, "localhost,127.0.0.1");
	assert.equal(patch.no_proxy, "localhost,127.0.0.1");
	assert.equal(patch.NODE_USE_ENV_PROXY, "1");
});
