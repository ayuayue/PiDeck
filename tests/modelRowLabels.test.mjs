import assert from "node:assert/strict";
import test from "node:test";

import { loadTsCommonJs } from "./helpers/loadTsCommonJs.mjs";

const { modelRowLabel } = loadTsCommonJs("src/renderer/src/components/session/sessionPickerOptions.ts");

/**
 * 模型选择器行文案的回归测试。
 *
 * 行文案为单行 `provider/名称`：名称取「模型」页配置的 name（渠道别名、中文名很常见），
 * 缺失时回退 id。provider 前缀必须保留——收藏栏/已隐藏栏跨供应商混排时没有分组标题提供
 * 上下文，且不同渠道可能取了同一个别名。曾短暂改为「主行 name / 副行 provider/id」双行，
 * 视觉太重已回退；本测试锁定单行格式与回落规则。
 */
function labelOf(model) {
	return modelRowLabel(model);
}

test("name 存在：显示 provider/名称", () => {
	assert.equal(labelOf({ provider: "tokendance", id: "gpt-4o", name: "通义千问 Max" }), "tokendance/通义千问 Max");
});

test("name 缺失：回退 id，显示 provider/id", () => {
	assert.equal(labelOf({ provider: "openai", id: "gpt-4o" }), "openai/gpt-4o");
});

test("name 为空白：视为缺失回退 id（避免渲染空名称）", () => {
	assert.equal(labelOf({ provider: "openai", id: "gpt-4o", name: "   " }), "openai/gpt-4o");
});

test("name 带首尾空白：trim 后拼接", () => {
	assert.equal(labelOf({ provider: "openai", id: "gpt-4o", name: " GPT-4o " }), "openai/GPT-4o");
});

test("name 与 id 相同：显示 provider/id（调用方据此省略 tooltip 后缀）", () => {
	assert.equal(labelOf({ provider: "openai", id: "gpt-4o", name: "gpt-4o" }), "openai/gpt-4o");
});
