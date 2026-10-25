/**
 * 独立生图配置白名单：无 API 类型；extraParams 按官方字段勾选；旧 kind=ark 迁移。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function loadConfig() {
	const source = ts.transpileModule(readFileSync("src/shared/imageGenConfig.ts", "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName: "imageGenConfig.ts",
	}).outputText;
	const module = { exports: {} };
	vm.runInNewContext(source, { module, exports: module.exports }, { filename: "imageGenConfig.ts" });
	return module.exports;
}

test("empty / invalid input → empty config", () => {
	const { sanitizeImageGenConfig, EMPTY_IMAGE_GEN_CONFIG } = loadConfig();
	assert.deepEqual(sanitizeImageGenConfig(null), EMPTY_IMAGE_GEN_CONFIG);
	assert.deepEqual(sanitizeImageGenConfig([]), EMPTY_IMAGE_GEN_CONFIG);
});

test("apiStyle 白名单：siliconflow 保留，非法回退 undefined（语义 openai）", () => {
	const { sanitizeImageGenConfig } = loadConfig();
	const next = sanitizeImageGenConfig({
		providers: [
			{
				id: "ig-sf",
				name: "SiliconFlow",
				baseUrl: "https://api.siliconflow.cn/v1",
				apiKey: "k",
				models: ["Kwai-Kolors/Kolors"],
				apiStyle: "siliconflow",
				referenceMode: "image-field",
			},
		],
	});
	assert.equal(next.providers[0].apiStyle, "siliconflow");
	assert.equal(next.providers[0].referenceMode, "image-field");

	// 旧配置无 apiStyle → undefined（向 openai 方言兼容）
	const legacy = sanitizeImageGenConfig({
		providers: [
			{
				id: "ig-legacy",
				name: "Legacy",
				baseUrl: "https://x/v1",
				apiKey: "k",
				models: ["m"],
			},
		],
	});
	assert.equal(legacy.providers[0].apiStyle, undefined);

	// 非法值（手改文件/脏数据）→ undefined，不写未知方言
	const bad = sanitizeImageGenConfig({
		providers: [
			{
				id: "ig-bad",
				name: "Bad",
				baseUrl: "https://x/v1",
				apiKey: "k",
				models: ["m"],
				apiStyle: "baidu",
			},
		],
	});
	assert.equal(bad.providers[0].apiStyle, undefined);
});

test("strips kind and keeps extraParams flags", () => {
	const { sanitizeImageGenConfig } = loadConfig();
	const next = sanitizeImageGenConfig({
		providers: [
			{
				id: "ig-a",
				name: "Ark",
				kind: "ark",
				baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
				apiKey: "sk-test",
				models: ["doubao-seedream", "doubao-seedream", ""],
				extraParams: { size: true, output_format: true, watermark: false },
			},
		],
		activeProviderId: "ig-a",
		activeModel: "doubao-seedream",
	});
	assert.equal(next.providers.length, 1);
	assert.equal("kind" in next.providers[0], false);
	assert.equal(next.providers[0].extraParams.size, true);
	assert.equal(next.providers[0].extraParams.output_format, true);
	assert.equal(next.providers[0].extraParams.watermark, false);
	assert.equal(next.providers[0].models.join(","), "doubao-seedream");
	assert.equal(next.activeModel, "doubao-seedream");
});

test("empty or invalid active selection stays unset instead of selecting the first provider/model", () => {
	const { sanitizeImageGenConfig } = loadConfig();
	const input = {
		providers: [
			{ id: "ig-a", name: "A", baseUrl: "https://a.example/v1", apiKey: "k", models: ["m1"] },
			{ id: "ig-b", name: "B", baseUrl: "https://b.example/v1", apiKey: "k", models: ["m2"] },
		],
	};

	const empty = sanitizeImageGenConfig({ ...input, activeProviderId: "", activeModel: "" });
	assert.equal(empty.activeProviderId, "");
	assert.equal(empty.activeModel, "");

	const invalidProvider = sanitizeImageGenConfig({ ...input, activeProviderId: "missing", activeModel: "m1" });
	assert.equal(invalidProvider.activeProviderId, "");
	assert.equal(invalidProvider.activeModel, "");

	const emptyModel = sanitizeImageGenConfig({ ...input, activeProviderId: "ig-a", activeModel: "" });
	assert.equal(emptyModel.activeProviderId, "ig-a");
	assert.equal(emptyModel.activeModel, "");
});

test("legacy kind=ark without extraParams enables all three official fields", () => {
	const { sanitizeImageGenConfig } = loadConfig();
	const next = sanitizeImageGenConfig({
		providers: [
			{
				id: "ig-old",
				name: "old",
				kind: "ark",
				baseUrl: "https://ark.cn-beijing.volces.com/api/v3",
				apiKey: "k",
				models: ["m1"],
			},
		],
	});
	assert.equal(next.providers[0].extraParams.size, true);
	assert.equal(next.providers[0].extraParams.output_format, true);
	assert.equal(next.providers[0].extraParams.watermark, true);
});

test("encode/decode selection round-trips model ids that contain slashes", () => {
	const { encodeImageGenSelection, decodeImageGenSelection } = loadConfig();
	const encoded = encodeImageGenSelection("ig-ark", "org/doubao-seedream");
	assert.equal(encoded.includes("/"), true);
	const decoded = decodeImageGenSelection(encoded);
	assert.equal(decoded?.providerId, "ig-ark");
	assert.equal(decoded?.modelId, "org/doubao-seedream");
	assert.equal(decodeImageGenSelection("no-sep"), null);
	assert.equal(decodeImageGenSelection("\u001fmodel"), null);
});

test("rejects non-http baseUrl and unknown extraParams keys", () => {
	const { sanitizeImageGenConfig, DEFAULT_IMAGE_GEN_EXTRA_PARAMS } = loadConfig();
	const next = sanitizeImageGenConfig({
		providers: [
			{
				id: "ig-1",
				name: "x",
				baseUrl: "file:///tmp",
				apiKey: "k",
				models: ["m"],
				extraParams: { size: true, foo: true },
			},
		],
	});
	assert.equal(next.providers[0].baseUrl, "");
	assert.equal(next.providers[0].extraParams.size, true);
	assert.equal(next.providers[0].extraParams.output_format, false);
	assert.equal(next.providers[0].extraParams.watermark, false);
	assert.equal("foo" in next.providers[0].extraParams, false);
	assert.equal(DEFAULT_IMAGE_GEN_EXTRA_PARAMS.size, false);
});
