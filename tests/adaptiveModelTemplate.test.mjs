/**
 * 自适应模板纯函数测试（utils/modelSpecAutoFill.ts 的 merge/apply 部分）。
 *
 * 规则：
 * - mergeAdaptiveModelTemplate：endpoint /models 实报字段优先，bundled catalog 模板补空；
 * - applyAdaptiveTemplateReset：只覆盖模板有值的字段；模板未提供的容量字段保留用户手填值
 *   （避免未匹配时把容量清空 → Pi 回退 128k 静默降级），推理/思考档位始终按模板重置。
 */

import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import ts from "typescript";
import vm from "node:vm";

const nodeRequire = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));
void __dirname;

function compileModule(filePath) {
	const source = readFileSync(filePath, "utf8");
	const output = ts.transpileModule(source, {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: filePath,
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(output, { module, exports: module.exports, require: nodeRequire, console }, { filename: filePath });
	return module.exports;
}

const mod = compileModule("src/renderer/src/utils/modelSpecAutoFill.ts");
const { mergeAdaptiveModelTemplate, applyAdaptiveTemplateReset } = mod;

function catalogSpec(overrides = {}) {
	return {
		contextWindow: 400000,
		maxTokens: 128000,
		reasoning: true,
		input: ["text", "image"],
		thinkingLevelMap: { off: null, high: "high", xhigh: "xhigh", max: "max" },
		source: "pi-ai",
		matchedId: "gpt-5.6",
		...overrides,
	};
}

function listing(overrides = {}) {
	return { id: "gpt-5.6", ...overrides };
}

function plainModel(model) {
	return JSON.parse(JSON.stringify(model));
}

test("merge: endpoint 实报字段优先于 catalog 模板", () => {
	const template = mergeAdaptiveModelTemplate(
		listing({ contextWindow: 200000, maxTokens: 65536 }),
		catalogSpec(),
	);
	assert.equal(template.contextWindow, 200000);
	assert.equal(template.maxTokens, 65536);
	// catalog 独有的字段照常补上
	assert.equal(template.reasoning, true);
	assert.deepEqual(JSON.parse(JSON.stringify(template.input)), ["text", "image"]);
	assert.equal(template.thinkingLevelMap?.max, "max");
	assert.equal(template.matchedId, "gpt-5.6");
});

test("merge: 无 endpoint listing 时全部来自 catalog", () => {
	const template = mergeAdaptiveModelTemplate(undefined, catalogSpec());
	assert.equal(template.contextWindow, 400000);
	assert.equal(template.maxTokens, 128000);
	assert.equal(template.reasoning, true);
});

test("merge: 无 catalog 模板时只用 endpoint 实报字段，缺省推理默认开放", () => {
	const template = mergeAdaptiveModelTemplate(listing({ contextWindow: 64000 }), null);
	assert.equal(template.contextWindow, 64000);
	assert.equal(template.maxTokens, undefined);
	// 端点未声明推理 → 默认支持思考并开放全部档位（用户有得选）
	assert.equal(template.reasoning, true);
	assert.deepEqual(JSON.parse(JSON.stringify(template.thinkingLevelMap)), {
		xhigh: "xhigh",
		max: "max",
	});
	assert.equal(template.matchedId, undefined);
});

test("merge: 都无数据时默认开放思考档位，不猜容量", () => {
	const template = mergeAdaptiveModelTemplate(undefined, null);
	assert.deepEqual(JSON.parse(JSON.stringify(template)), {
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	});
});

test("merge: 端点明确 reasoning=false 不被默认值覆盖", () => {
	const template = mergeAdaptiveModelTemplate(listing({ reasoning: false }), null);
	assert.equal(template.reasoning, false);
	// 非推理模型不开放档位映射
	assert.equal(template.thinkingLevelMap, undefined);
});

test("merge: 端点已声明档位映射时默认映射不覆盖", () => {
	const template = mergeAdaptiveModelTemplate(
		listing({ reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: null, medium: null } }),
		null,
	);
	assert.equal(template.reasoning, true);
	// 端点的 null 禁用语义完整保留（MiniMax-M2.7 只支持 high 的场景）
	assert.deepEqual(JSON.parse(JSON.stringify(template.thinkingLevelMap)), {
		off: null,
		minimal: null,
		low: null,
		medium: null,
	});
});

test("merge: 端点 reasoning=true 未声明档位 → 默认开放 xhigh/max", () => {
	const template = mergeAdaptiveModelTemplate(listing({ reasoning: true }), null);
	assert.equal(template.reasoning, true);
	assert.deepEqual(JSON.parse(JSON.stringify(template.thinkingLevelMap)), {
		xhigh: "xhigh",
		max: "max",
	});
});

test("merge: catalog 明确非推理 → 不开放档位", () => {
	const template = mergeAdaptiveModelTemplate(undefined, catalogSpec({ reasoning: false, thinkingLevelMap: undefined }));
	assert.equal(template.reasoning, false);
	assert.equal(template.thinkingLevelMap, undefined);
});

test("reset: 清空五个能力字段后写模板有值字段", () => {
	const next = applyAdaptiveTemplateReset(
		{
			id: "gpt-5.6",
			contextWindow: 999,
			maxTokens: 111,
			input: ["text"],
			reasoning: false,
			thinkingLevelMap: { off: null },
		},
		mergeAdaptiveModelTemplate(listing({ contextWindow: 200000 }), catalogSpec()),
	);
	assert.equal(next.contextWindow, 200000);
	assert.equal(next.maxTokens, 128000);
	assert.equal(next.reasoning, true);
	assert.deepEqual(JSON.parse(JSON.stringify(next.input)), ["text", "image"]);
	assert.equal(next.thinkingLevelMap?.max, "max");
	// 用户字段被模板覆盖（重置是显式动作）
	assert.equal(next.contextWindow, 200000);
});

test("reset: 模板缺失的容量字段保留手填值，推理/档位仍按模板重置", () => {
	const template = mergeAdaptiveModelTemplate(undefined, null);
	const next = applyAdaptiveTemplateReset(
		{ id: "unknown-model", contextWindow: 100, maxTokens: 200, reasoning: true, input: ["text"] },
		template,
	);
	// 未匹配到目录时：手填容量/模态必须保留（清空后 Pi 回退 128k，等于静默降级）；
	// 推理默认开放（自适应未匹配的兜底策略）照常写入。
	assert.deepEqual(plainModel(next), {
		id: "unknown-model",
		contextWindow: 100,
		maxTokens: 200,
		input: ["text"],
		reasoning: true,
		thinkingLevelMap: { xhigh: "xhigh", max: "max" },
	});
});

test("reset: 纯文本模板显式清掉图片输入与 reasoning", () => {
	const next = applyAdaptiveTemplateReset(
		{ id: "deepseek-chat", input: ["text", "image"], reasoning: true, thinkingLevelMap: { max: "max" } },
		mergeAdaptiveModelTemplate(undefined, catalogSpec({ input: ["text"], reasoning: false, thinkingLevelMap: undefined })),
	);
	assert.deepEqual(JSON.parse(JSON.stringify(next.input)), ["text"]);
	assert.equal(next.reasoning, false);
	assert.equal(next.thinkingLevelMap, undefined);
});

test("reset: 目录未收录的视觉 ID 模板兜底补图片能力", () => {
	// deepseek-v4-flash-vision-exp 未被目录收录时，「重置为自适应」也应补 input [text,image]，
	// 否则模型保持旧值（如被 text-only 别名误写入的 [text]），图片能力无法恢复。
	const template = mergeAdaptiveModelTemplate(undefined, null, "deepseek-v4-flash-vision-exp");
	assert.deepEqual(JSON.parse(JSON.stringify(template.input)), ["text", "image"]);
	const next = applyAdaptiveTemplateReset(
		{ id: "deepseek-v4-flash-vision-exp", input: ["text"] },
		template,
	);
	assert.deepEqual(JSON.parse(JSON.stringify(next.input)), ["text", "image"]);
	// 非视觉 ID 且目录未收录：仍不猜 input（旧行为）
	assert.equal(mergeAdaptiveModelTemplate(undefined, null, "my-custom-model").input, undefined);
});
