import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { orderProviderGroups } = loadTsCommonJs("src/renderer/src/components/session/sessionPickerOptions.ts");

const settingsStore = readFileSync("src/main/settings/SettingsStore.ts", "utf8");
const sessionIpc = readFileSync("src/main/ipc/sessionIpc.ts", "utf8");
const components = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
const pickerHost = readFileSync("src/renderer/src/components/session/ComposerPickerHost.tsx", "utf8");
/** 模型/思考域状态由 state hook + controller 持有（选择器渲染壳只透传）。 */
const preferenceController = [readFileSync("src/renderer/src/hooks/useSessionPreferenceState.ts", "utf8"), readFileSync("src/renderer/src/hooks/useSessionPreferenceController.ts", "utf8")].join("\n");
const settingsTypes = readFileSync("src/shared/types/settings.ts", "utf8");

describe("orderProviderGroups（模型选择器供应商排序）", () => {
	test("最近使用过的供应商排最前，其余保持内置置顶+字母序", () => {
		// 最近使用 deepseek / openai（deepseek 最新）：它们应排到未使用的 anthropic 之前。
		const ordered = orderProviderGroups(["anthropic", "openai", "deepseek", "zhipu", "other"], ["deepseek", "openai"]);
		assert.equal(ordered.join(","), "deepseek,openai,anthropic,zhipu,other");
	});

	test("recentProviders 内部顺序即最近顺序（最新在前）", () => {
		const ordered = orderProviderGroups(["openai", "deepseek", "zhipu"], ["zhipu", "deepseek", "openai"]);
		assert.equal(ordered.join(","), "zhipu,deepseek,openai");
	});

	test("未提供 recentProviders 时保持内置置顶顺序", () => {
		// 内置置顶 tokendance > anthropic > openai > deepseek；未列出的按字母序。
		const ordered = orderProviderGroups(["deepseek", "openai", "anthropic", "tokendance", "zhipu", "other"], undefined);
		assert.equal(ordered.join(","), "tokendance,anthropic,openai,deepseek,zhipu,other");
	});

	test("other 兜底组恒最后，即使它出现在最近使用列表里", () => {
		const ordered = orderProviderGroups(["other", "deepseek"], ["other", "deepseek"]);
		assert.equal(ordered.join(","), "deepseek,other");
	});

	test("recentProviders 里的未知供应商不参与排序时仍按字母序兜底", () => {
		// 'ghost' 既不在 recentProviders（虽在列表中）也不在 PROVIDER_ORDER，按字母序排在 zhipu 前。
		const ordered = orderProviderGroups(["zhipu", "ghost"], ["ghost"]);
		assert.equal(ordered.join(","), "ghost,zhipu");
	});

	test("输入数组不被原地修改（纯函数）", () => {
		const input = ["openai", "deepseek"];
		const snapshot = [...input];
		orderProviderGroups(input, ["deepseek"]);
		assert.deepEqual(input, snapshot);
	});
});

describe("recentProviders 链路契约（源码级）", () => {
	test("settings 类型声明 recentProviders（最新在前，可选）", () => {
		assert.match(settingsTypes, /recentProviders\?: string\[\]/);
	});

	test("SettingsStore 校验 recentProviders：去重、去空、截断 8", () => {
		assert.match(settingsStore, /"recentProviders" in safePatch/);
		assert.match(settingsStore, /cleaned\.length >= 8/);
		assert.match(settingsStore, /seen\.has\(item\)/);
		// 无变化（含非法清空）要从 patch 剔除，避免每条消息触发写盘。
		assert.match(settingsStore, /if \(unchanged\) delete safePatch\.recentProviders/);
	});

	test("sessionIpc 发送接受时与 lastUsedModel 同点记录 recentProviders", () => {
		assert.match(sessionIpc, /recentProviders/);
		assert.match(sessionIpc, /settingsStore\.get\(\)\.recentProviders/);
		// 当前供应商提到首位：最近使用的语义由「数组顺序」承载。
		assert.match(sessionIpc, /\[provider, \.\.\.current\.filter/);
		// DSH 会话跳过记录（与 lastUsedModel 同规则）。
		const acceptedBlock = sessionIpc.slice(sessionIpc.indexOf('record?.backend !== "dsh"'), sessionIpc.indexOf('"Session prompt IPC completed"'));
		assert.match(acceptedBlock, /recentProviders/);
	});

	test("ModelPicker 接收 recentProviders 并按 orderProviderGroups 排序", () => {
		assert.match(components, /recentProviders\?: string\[\]/);
		assert.match(components, /orderProviderGroups\(Object\.keys\(groupedModels\)/);
		assert.match(components, /props\.recentProviders/);
		// 旧的内联 providerOrder 排序已移除。
		assert.doesNotMatch(components, /const providerOrder = \[/);
	});

	test("ComposerPickerHost 读 settings.recentProviders 并传给 ModelPicker", () => {
		assert.match(preferenceController, /setRecentProviders\(settings\.recentProviders/);
		assert.match(pickerHost, /recentProviders=\{preference\.recentProviders\}/);
	});
});
