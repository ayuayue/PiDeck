import assert from "node:assert/strict";
import { test } from "node:test";
import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { computeDirtyFields } = loadTsCommonJs("src/renderer/src/components/app/settings/settingsDirtyFields.ts");

test("无差异返回空集合（关闭时不应提示）", () => {
	const base = { theme: "dark", language: "zh-CN", favoriteModels: ["a/b", "c/d"] };
	const draft = { theme: "dark", language: "zh-CN", favoriteModels: ["a/b", "c/d"] };
	assert.deepEqual(Array.from(computeDirtyFields(draft, base)), []);
});

test("改回原值自动摘掉脏标记（真实差异比较，而非 touched 集合）", () => {
	const base = { theme: "dark", language: "zh-CN" };
	// 修改
	assert.deepEqual(Array.from(computeDirtyFields({ theme: "light", language: "zh-CN" }, base)), ["theme"]);
	// 改回原值：无脏字段
	assert.deepEqual(Array.from(computeDirtyFields({ theme: "dark", language: "zh-CN" }, base)), []);
});

test("数组字段按结构比较：顺序变化算差异，内容相同不算", () => {
	const base = { favoriteModels: ["a/b", "c/d"] };
	assert.deepEqual(Array.from(computeDirtyFields({ favoriteModels: ["c/d", "a/b"] }, base)), ["favoriteModels"]);
	assert.deepEqual(Array.from(computeDirtyFields({ favoriteModels: ["a/b", "c/d"] }, base)), []);
});

test("遍历键并集：草稿缺失但基准存在的字段也判脏（字段被删除）", () => {
	const base = { a: 1, b: 2 };
	const draft = { a: 1 };
	// draft 里 b 消失 = 真实差异；且 a 无差异
	assert.deepEqual(Array.from(computeDirtyFields(draft, base)), ["b"]);
});

test("嵌套数组逐层比较：内层值差异能区分（普通对象分支由 deepEqual 自测覆盖）", () => {
	// 普通对象字面量跨 vm realm 会被 isPlainObject 判为非普通对象（见 deepEqual.test.mjs 说明），
	// 这里用数组（Array.isArray 跨 realm 可靠）验证嵌套递归差异检测。
	const base = { nested: [[1, 2]] };
	assert.deepEqual(Array.from(computeDirtyFields({ nested: [[1, 2]] }, base)), []);
	assert.deepEqual(Array.from(computeDirtyFields({ nested: [[1, 3]] }, base)), ["nested"]);
});
