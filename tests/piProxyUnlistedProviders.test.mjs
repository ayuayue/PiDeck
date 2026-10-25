import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

/**
 * 回归（issue #356）：设置页保存了供应商，会话模型选择器与「代理设置」里都找不到它。
 *
 * 根因不是「两份 models.json」（WSL 正常启用时两侧读写同一份），而是 pi 只列出凭据可解析的
 * 供应商（pi docs/models.md「The picker shows models whose providers have usable authentication」）：
 * 实测 `pi --list-models` 在 PI_CODING_AGENT_DIR 指向的 models.json 里，只列有 apiKey 的
 * 自定义供应商，没 apiKey 的那个一条都不列（同一份文件、同一命令）。
 * PiDeck 允许保存不带 API Key 的供应商（走 /login 或环境变量的场景合法），于是「设置页有
 * / 会话与代理名单没有」——两者数据源不同，观感却像丢配置。
 *
 * 要守的是「界面必须自曝原因」：把「models.json 里有、pi 报告里没有」的供应商按
 * 「有模型但凭据解析不到」与「只建了供应商名还没加模型」分开提示——两者可操作动作不同，
 * 混成一句话就会把人引向错误的修复（补模型 vs 补凭据）。
 *
 * 正则按仓库约定做空白容忍。
 */

const { configuredProviderSummariesFromModelsConfig, splitUnlistedProviders } = loadTsCommonJs("src/shared/piProxyList.ts");

/** vm 沙箱内的数组/对象有各自的原型，deepStrictEqual 会按原型链比较 → 统一过一遍 JSON 转成本 realm 的普通值。 */
const plain = (value) => JSON.parse(JSON.stringify(value));

const PROXY_TAB = "src/renderer/src/components/app/settings/ProxyTab.tsx";
const ENDPOINT_FIELDS = "src/renderer/src/config/ProviderEndpointFields.tsx";

test("splitUnlistedProviders: 有模型条目 → withModels，没有 → withoutModels，pi 已列出的两组都不进", () => {
	const result = splitUnlistedProviders(
		[
			{ name: "with-key", modelCount: 2 },
			{ name: "no-key", modelCount: 1 },
			{ name: "name-only", modelCount: 0 },
		],
		["with-key"],
	);
	assert.deepEqual(plain(result.withModels), ["no-key"], "配置了模型但 pi 未列出 → 凭据类");
	assert.deepEqual(plain(result.withoutModels), ["name-only"], "没有模型条目 → 补模型类");
});

test("splitUnlistedProviders: 结果按名称排序且不受入参顺序影响", () => {
	const configured = [
		{ name: "zeta", modelCount: 1 },
		{ name: "alpha", modelCount: 1 },
		{ name: "beta", modelCount: 1 },
	];
	assert.deepEqual(plain(splitUnlistedProviders(configured, []).withModels), ["alpha", "beta", "zeta"]);
	assert.deepEqual(plain(splitUnlistedProviders([...configured].reverse(), []).withModels), ["alpha", "beta", "zeta"]);
});

test("configuredProviderSummariesFromModelsConfig: 只认 providers[name].models 数组，判据与 modelsFromPiConfig 一致", () => {
	const summaries = configuredProviderSummariesFromModelsConfig({
		providers: {
			"two-models": { models: [{ id: "a" }, { id: "b" }] },
			"no-models-field": { baseUrl: "https://example.invalid" },
			"models-not-array": { models: "oops" },
			"empty-models": { models: [] },
		},
	});
	assert.deepEqual(plain(summaries), [
		{ name: "empty-models", modelCount: 0 },
		{ name: "models-not-array", modelCount: 0 },
		{ name: "no-models-field", modelCount: 0 },
		{ name: "two-models", modelCount: 2 },
	]);
});

test("configuredProviderSummariesFromModelsConfig: 非法/空输入返回空数组（配置损坏时不炸设置页）", () => {
	for (const input of [undefined, null, "text", 42, [], { providers: null }, { providers: [] }, {}]) {
		assert.deepEqual(plain(configuredProviderSummariesFromModelsConfig(input)), []);
	}
});

test("ProxyTab: 两种未列出的供应商分节渲染，判据走 shared 纯函数（不在组件里另写一份）", () => {
	const source = readFileSync(PROXY_TAB, "utf8");
	assert.match(source, /import\s*\{[^}]*\bsplitUnlistedProviders\b[^}]*\}\s*from\s*"[^"]*shared\/piProxyList"/, "必须从 shared/piProxyList 导入分组判据");
	assert.match(source, /splitUnlistedProviders\(\s*scoped\s*,\s*visibleProviders\s*\)/, "分组必须由 shared 纯函数给出");
	assert.doesNotMatch(source, /\bemptyProviderNames\b/, "旧的单一「无模型供应商」名单已被分组结果取代");
	assert.match(source, /unlistedProviders\.withModels\.length\s*>\s*0[\s\S]{0,400}?settings\.piProxyModelsUnlistedProviders/, "凭据类未列出供应商必须单独成节并给出标题");
	assert.match(source, /unlistedProviders\.withModels[\s\S]{0,600}?settings\.piProxyModelsUnlistedHint/, "该节必须写清原因（pi 只列凭据可解析的供应商）");
	assert.match(source, /unlistedProviders\.withoutModels[\s\S]{0,600}?settings\.piProxyModelsNoModelHint/, "没有模型条目的供应商仍走「去补模型」提示");
});

test("供应商表单：API Key 留空时提示 pi 不会列出该供应商（且不再复述于已填写的场景）", () => {
	const source = readFileSync(ENDPOINT_FIELDS, "utf8");
	assert.match(source, /props\.apiKey\.trim\(\)\s*===\s*""[\s\S]{0,200}?config\.field\.apiKeyEmptyHint/, "空 Key 时必须渲染原因提示");
	assert.match(source, /props\.backend\s*!==\s*"dsh"/, "提示只属于 pi 后端（DSH 的凭据语义不同）");
});

test("i18n：新增文案在 zh-CN 与 en-US 词典都存在（繁体为生成物，由 genZhTwCopy 同步）", () => {
	const zh = readFileSync("src/renderer/src/i18n/rendererCopy.zh-CN.ts", "utf8");
	const en = readFileSync("src/renderer/src/i18n/rendererCopy.en-US.ts", "utf8");
	const zhTw = readFileSync("src/renderer/src/i18n/rendererCopy.zh-TW.ts", "utf8");
	for (const key of ["settings.piProxyModelsUnlistedProviders", "settings.piProxyModelsUnlistedHint", "config.field.apiKeyEmptyHint"]) {
		for (const [label, source] of [
			["zh-CN", zh],
			["en-US", en],
			["zh-TW", zhTw],
		]) {
			assert.match(source, new RegExp(`"${key.replace(/\./g, "\\.")}":\\s*"`), `${key} 在 ${label} 词典缺失`);
		}
	}
});
