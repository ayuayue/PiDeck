import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { toModelKey, toggleHiddenModel, splitVisibleAndHiddenModels, filterVisibleModels, moveModelItem } = loadTsCommonJs("src/renderer/src/config/modelVisibility.ts");

const json = (value) => JSON.stringify(value);

test("toModelKey: 统一格式为 provider/modelId", () => {
	assert.equal(toModelKey("openai", "gpt-4o"), "openai/gpt-4o");
	assert.equal(toModelKey("deepseek", "deepseek-chat"), "deepseek/deepseek-chat");
});

test("toggleHiddenModel: 未隐藏加入，已隐藏移除（找回模型）", () => {
	const initial = ["openai/gpt-3.5-turbo"];
	const added = toggleHiddenModel(initial, "openai", "gpt-4o");
	assert.equal(json(added), json(["openai/gpt-3.5-turbo", "openai/gpt-4o"]));

	const removed = toggleHiddenModel(added, "openai", "gpt-3.5-turbo");
	assert.equal(json(removed), json(["openai/gpt-4o"]));
});

test("splitVisibleAndHiddenModels: 正确切分可见行与隐藏行，并保留原始索引", () => {
	const models = [
		{ id: "m1", name: "Model 1" },
		{ id: "m2", name: "Model 2" },
		{ id: "m3", name: "Model 3" },
	];
	const hiddenModels = ["tokendance/m2"];
	const result = splitVisibleAndHiddenModels("tokendance", models, hiddenModels);

	assert.equal(result.visible.length, 2);
	assert.equal(result.visible[0].model.id, "m1");
	assert.equal(result.visible[0].originalIndex, 0);
	assert.equal(result.visible[1].model.id, "m3");
	assert.equal(result.visible[1].originalIndex, 2);

	assert.equal(result.hidden.length, 1);
	assert.equal(result.hidden[0].model.id, "m2");
	assert.equal(result.hidden[0].originalIndex, 1);
});

test("splitVisibleAndHiddenModels: 空隐藏列表零开销保留全部行", () => {
	const models = [{ id: "m1" }, { id: "m2" }];
	const result = splitVisibleAndHiddenModels("openai", models, []);
	assert.equal(result.visible.length, 2);
	assert.equal(result.hidden.length, 0);
});

test("filterVisibleModels: 同时支持供应商隐藏与单模型隐藏", () => {
	const allModels = [
		{ provider: "openai", id: "gpt-4o" },
		{ provider: "openai", id: "gpt-4o-mini" },
		{ provider: "deepseek", id: "deepseek-chat" },
		{ provider: "anthropic", id: "claude-3-5-sonnet" },
	];

	// 1. 隐藏整个 deepseek 供应商 + 隐藏 openai/gpt-4o-mini 单个模型
	const filtered = filterVisibleModels(allModels, ["deepseek"], ["openai/gpt-4o-mini"]);
	assert.equal(
		json(filtered),
		json([
			{ provider: "openai", id: "gpt-4o" },
			{ provider: "anthropic", id: "claude-3-5-sonnet" },
		]),
	);

	// 2. 空隐藏列表原样返回
	assert.equal(filterVisibleModels(allModels, [], []), allModels);
});

test("moveModelItem: 向上和向下安全移动数组元素实现排序", () => {
	const list = ["A", "B", "C", "D"];

	// B 上移 -> A, B 交换 -> ["B", "A", "C", "D"]
	const moveUp = moveModelItem(list, 1, "up");
	assert.equal(json(moveUp), json(["B", "A", "C", "D"]));

	// A 已经在顶端，上移越界原样返回
	const upBoundary = moveModelItem(list, 0, "up");
	assert.equal(json(upBoundary), json(["A", "B", "C", "D"]));

	// C 下移 -> C, D 交换 -> ["A", "B", "D", "C"]
	const moveDown = moveModelItem(list, 2, "down");
	assert.equal(json(moveDown), json(["A", "B", "D", "C"]));

	// D 已经在底端，下移越界原样返回
	const downBoundary = moveModelItem(list, 3, "down");
	assert.equal(json(downBoundary), json(["A", "B", "C", "D"]));

	// 非法负索引或越界索引原样返回
	assert.equal(json(moveModelItem(list, -1, "up")), json(list));
	assert.equal(json(moveModelItem(list, 99, "down")), json(list));
});

test("契约完整性：ComposerComponents 与 ComposerPickerHost 支持 hiddenModels 并可恢复", () => {
	const composer = readFileSync("src/renderer/src/components/session/ComposerComponents.tsx", "utf8");
	const host = readFileSync("src/renderer/src/components/session/ComposerPickerHost.tsx", "utf8");
	// hiddenModels 的读写（settings 加载 + 切换持久化）在偏好读侧 hook 里：
	// 组件只负责透传给 ModelPicker（与收藏同结构，见 useSessionPreferenceState）。
	const preferenceState = readFileSync("src/renderer/src/hooks/useSessionPreferenceState.ts", "utf8");
	const modelsTab = readFileSync("src/renderer/src/config/ModelsTab.tsx", "utf8");
	const modelsTable = readFileSync("src/renderer/src/config/ModelsTable.tsx", "utf8");
	const configModal = readFileSync("src/renderer/src/ConfigModal.tsx", "utf8");

	// 选择器传递与处理
	assert.ok(composer.includes("hiddenModels?: string[];"));
	assert.ok(composer.includes("onToggleHideModel?: (provider: string, modelId: string) => void;"));
	assert.ok(preferenceState.includes("setHiddenModels(settings.hiddenModels ?? []);"));
	assert.ok(preferenceState.includes("toggleHideModel"));
	assert.ok(host.includes("hiddenModels={preference.hiddenModels}"));
	assert.ok(host.includes("onToggleHideModel="));

	// 配置页表格支持上下移动与隐藏找回
	assert.ok(modelsTable.includes("onMoveModel"));
	assert.ok(modelsTable.includes("onHideModel"));
	assert.ok(modelsTab.includes("onMoveModel"));
	assert.ok(modelsTab.includes("hiddenModelsInProvider"));
	assert.ok(configModal.includes("handleToggleHiddenModel"));
	assert.ok(configModal.includes("handleToggleHiddenAuthProvider"));

	// 认证 Tab 各自独立隐藏管理
	const authTab = readFileSync("src/renderer/src/config/AuthTab.tsx", "utf8");
	assert.ok(authTab.includes("hiddenAuthProviders"));
	assert.ok(authTab.includes("onToggleHiddenAuthProvider"));
	assert.ok(authTab.includes("hiddenAuths"));
});
