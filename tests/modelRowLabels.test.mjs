import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

test("name 与 id 相同：仍显示 provider/id", () => {
	assert.equal(labelOf({ provider: "openai", id: "gpt-4o", name: "gpt-4o" }), "openai/gpt-4o");
});

test("Web 选择器同样用保存名称显示，identity 信息在弹层行内可见", () => {
	// WebHeader 第三批瘦身把模型选择迁到 WebModelSheet：pill 只显示保存名称（provider 在弹层内呈现），
	// identity（item.id）从旧版的 title tooltip 改为行内 caption ——信息仍可见，形式随 UI 迁移。
	const source = readFileSync("src/renderer/src/web/WebModelSheet.tsx", "utf8");
	assert.match(source, /resolveModelDisplayName\(model\.modelName,\s*model\.modelId\)/);
	assert.match(source, /const pillLabel\s*=\s*selectedName \?\? t\("web\.model"\);/);
	// 窗口化后模型行拆成独立组件 ModelRow(props)，不再闭包捕获 item
	assert.match(source, /const name = resolveModelDisplayName\(props\.item\.name, props\.item\.id\);/);
	assert.match(source, /\{name\}[\s\S]{0,120}\{props\.item\.id\}/);
});
