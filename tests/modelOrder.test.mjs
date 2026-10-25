/**
 * 模型展示顺序统一比较器（shared/modelOrder）单测 + 落盘链路集成断言。
 *
 * 回归背景：用户反馈「获取模型列表后选择保存，顺序很乱；模型下拉列表已经有排序了」。
 * 根因是各处各写一份 localeCompare，TokenDance catalog→installer 这条路径完全没排。
 * 这里既测比较器本身，也测「解析结果即有序」，保证落盘顺序 = 下拉顺序。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const order = loadTsCommonJs("src/shared/modelOrder.ts");
const catalog = loadTsCommonJs("src/main/config/tokendanceCatalog.ts");
const providerModels = loadTsCommonJs("src/main/config/parseProviderModels.ts");

const { compareModelRows, modelSortKey, sortModelRows } = order;

test("modelSortKey：name 优先，去空白后为空才回退 id", () => {
	assert.equal(modelSortKey({ id: "glm-4.7", name: "Z.ai: GLM 4.7" }), "z.ai: glm 4.7");
	assert.equal(modelSortKey({ id: "glm-4.7", name: "   " }), "glm-4.7");
	assert.equal(modelSortKey({ id: "GLM-4.7" }), "glm-4.7");
	// 两者都缺失时退化成空串（不抛异常，排序时按同键走 id 兜底）
	assert.equal(modelSortKey({}), "");
});

test("compareModelRows：按展示名正序且大小写不敏感", () => {
	assert.ok(compareModelRows({ name: "apple" }, { name: "Zebra" }) < 0);
	assert.ok(compareModelRows({ name: "Zebra" }, { name: "apple" }) > 0);
	// 大小写不敏感：同一词的不同大小写视为同键，转由 id 兜底
	assert.equal(compareModelRows({ id: "a", name: "GLM" }, { id: "b", name: "glm" }), -1);
});

test("sortModelRows：name/id 混合列表按统一键排序，不随输入顺序变化", () => {
	const rows = [{ name: "Zebra" }, { id: "Mango" }, { name: "apple" }, { id: "banana" }];
	assert.deepEqual(
		sortModelRows(rows).map((row) => row.name ?? row.id),
		["apple", "banana", "Mango", "Zebra"],
	);
});

test("sortModelRows：同键按 id 兜底，保证顺序稳定可预期", () => {
	const rows = [
		{ id: "glm-5", name: "GLM" },
		{ id: "glm-4.7", name: "GLM" },
		{ id: "glm-4.6", name: "GLM" },
	];
	assert.deepEqual(
		sortModelRows(rows).map((row) => row.id),
		["glm-4.6", "glm-4.7", "glm-5"],
	);
});

test("回归：用户实报的乱序目录（MiniMax/Z.ai/Qwen/DeepSeek）保存后为正序", () => {
	const messy = [
		{ id: "minimax-h3-max", name: "MiniMax H3 Max" },
		{ id: "glm-4.7", name: "Z.ai: GLM 4.7" },
		{ id: "glm-5", name: "Z.ai: GLM 5" },
		{ id: "qwen3-max", name: "Qwen: Qwen3 Max" },
		{ id: "deepseek-v3.2", name: "DeepSeek: DeepSeek V3.2" },
	];
	assert.deepEqual(
		sortModelRows(messy).map((row) => row.name),
		["DeepSeek: DeepSeek V3.2", "MiniMax H3 Max", "Qwen: Qwen3 Max", "Z.ai: GLM 4.7", "Z.ai: GLM 5"],
	);
});

test("parseTokenDanceCatalog：平台 /models 返回顺序即被打乱，解析结果仍有序", () => {
	const parsed = catalog.parseTokenDanceCatalog({
		data: [
			{ id: "qwen3-max", name: "Qwen: Qwen3 Max", context_length: 262144 },
			{ id: "glm-4.7", name: "Z.ai: GLM 4.7", context_length: 200000 },
			{ id: "deepseek-v3.2", name: "DeepSeek: DeepSeek V3.2" },
		],
	});
	// vm 跨 realm：对 vm 数组调 .map() 得到的仍是 vm 数组，deepStrictEqual 会因 prototype 不同误报；
	// 先用展开把容器换回测试 realm 再比较（与 tokendanceInstaller.test.mjs 的快照比较同一考量）。
	assert.deepEqual(
		[...parsed].map((model) => model.name),
		["DeepSeek: DeepSeek V3.2", "Qwen: Qwen3 Max", "Z.ai: GLM 4.7"],
	);
	// 排序不得丢字段：contextWindow 仍跟随各自的模型行
	assert.equal(parsed.find((model) => model.id === "glm-4.7").contextWindow, 200000);
});

test("parseProviderModelsResponse：/models 解析结果按名称正序（配置页拉取路径）", () => {
	const parsed = providerModels.parseProviderModelsResponse({
		data: [{ id: "zzz-model", name: "Zeta Model" }, { id: "aaa-model", name: "Alpha Model" }, { id: "mmm-model" }],
	});
	assert.deepEqual(
		[...parsed].map((model) => model.name ?? model.id),
		["Alpha Model", "mmm-model", "Zeta Model"],
	);
});
