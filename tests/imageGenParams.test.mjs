/**
 * 生图参数解析：官方字段只在 extraParams 勾选后写入请求体。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test, { describe } from "node:test";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const ts = require("typescript");

function transpile(fileName) {
	return ts.transpileModule(readFileSync(fileName, "utf8"), {
		compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
		fileName,
	}).outputText;
}

function loadParams() {
	const configModule = { exports: {} };
	vm.runInNewContext(transpile("src/shared/imageGenConfig.ts"), { module: configModule, exports: configModule.exports }, { filename: "imageGenConfig.ts" });
	const paramsModule = { exports: {} };
	vm.runInNewContext(
		transpile("src/shared/imageGenParams.ts"),
		{
			module: paramsModule,
			exports: paramsModule.exports,
			require: (id) => {
				if (id === "./imageGenConfig") return configModule.exports;
				throw new Error(`unexpected require ${id}`);
			},
		},
		{ filename: "imageGenParams.ts" },
	);
	return paramsModule.exports;
}

describe("parseImageGenSize", () => {
	test("accepts OpenAI pixel sizes, Volc 1K-4K, unset, and custom WxH", () => {
		const { parseImageGenSize, IMAGE_GEN_SIZE_UNSET } = loadParams();
		assert.equal(parseImageGenSize("1024x1024"), "1024x1024");
		assert.equal(parseImageGenSize(" 2k "), "2K");
		assert.equal(parseImageGenSize("4K"), "4K");
		assert.equal(parseImageGenSize("2048x2048"), "2048x2048");
		assert.equal(parseImageGenSize("1280x720"), "1280x720");
		assert.equal(parseImageGenSize("unset"), IMAGE_GEN_SIZE_UNSET);
		assert.equal(parseImageGenSize(""), IMAGE_GEN_SIZE_UNSET);
		assert.equal(parseImageGenSize("auto"), null);
		assert.equal(parseImageGenSize("1024"), null);
	});
});

describe("buildImageGenApiBody", () => {
	test("omits optional fields when extraParams are off", () => {
		const { buildImageGenApiBody } = loadParams();
		const body = buildImageGenApiBody({
			model: "gpt-image-1",
			prompt: "cat",
			size: "1024x1024",
			watermark: true,
			outputFormat: "jpeg",
		});
		assert.equal("size" in body, false);
		assert.equal("watermark" in body, false);
		assert.equal("output_format" in body, false);
		assert.equal(body.response_format, "b64_json");
	});

	test("includes only the extraParams that are enabled", () => {
		const { buildImageGenApiBody } = loadParams();
		const body = buildImageGenApiBody({
			model: "doubao-seedream",
			prompt: "cat",
			extraParams: { size: true, output_format: true, watermark: true },
			size: "2K",
			watermark: false,
			outputFormat: "jpeg",
		});
		assert.equal(body.size, "2K");
		assert.equal(body.watermark, false);
		assert.equal(body.output_format, "jpeg");
	});

	test("unset size is omitted even when extraParams.size is on", () => {
		const { buildImageGenApiBody } = loadParams();
		const body = buildImageGenApiBody({
			model: "gpt-image-1",
			prompt: "cat",
			extraParams: { size: true, output_format: false, watermark: false },
			size: "unset",
		});
		assert.equal("size" in body, false);
	});

	test("custom WxH is sent when extraParams.size is on", () => {
		const { buildImageGenApiBody } = loadParams();
		const body = buildImageGenApiBody({
			model: "gpt-image-1",
			prompt: "cat",
			extraParams: { size: true, output_format: false, watermark: false },
			size: "1280x720",
		});
		assert.equal(body.size, "1280x720");
	});

	test("size-only extraParams does not send watermark", () => {
		const { buildImageGenApiBody } = loadParams();
		const body = buildImageGenApiBody({
			model: "gpt-image-1",
			prompt: "cat",
			extraParams: { size: true, output_format: false, watermark: false },
			size: "1024x1024",
			watermark: true,
			outputFormat: "jpeg",
		});
		assert.equal(body.size, "1024x1024");
		assert.equal("watermark" in body, false);
		assert.equal("output_format" in body, false);
	});

	test("siliconflow 方言：image_size 替代 size，不发 watermark/output_format/response_format", () => {
		const { buildImageGenApiBody } = loadParams();
		const body = buildImageGenApiBody({
			model: "Kwai-Kolors/Kolors",
			prompt: "cat",
			extraParams: { size: true, output_format: true, watermark: true },
			size: "1024x1024",
			watermark: true,
			outputFormat: "jpeg",
			apiStyle: "siliconflow",
		});
		// 字段名方言差异：尺寸走 image_size
		assert.equal(body.image_size, "1024x1024");
		assert.equal("size" in body, false);
		// 硅基无这些概念：即使 extraParams 全勾也不发
		assert.equal("watermark" in body, false);
		assert.equal("output_format" in body, false);
		assert.equal("response_format" in body, false);
		assert.equal("n" in body, false);
	});

	test("siliconflow 方言：参考图取首张转单 dataURI string（不认数组）", () => {
		const { buildImageGenApiBody } = loadParams();
		const body = buildImageGenApiBody({
			model: "Kwai-Kolors/Kolors",
			prompt: "cat",
			apiStyle: "siliconflow",
			referenceImages: [
				{ type: "image", data: "YWJj", mimeType: "image/png" },
				{ type: "image", data: "ZGVm", mimeType: "image/jpeg" },
			],
		});
		assert.equal(body.image, "data:image/png;base64,YWJj");
	});

	test("openai 方言默认：参考图仍是 dataURI 数组（方舟 seedream 官方格式）", () => {
		const { buildImageGenApiBody } = loadParams();
		const body = buildImageGenApiBody({
			model: "doubao-seedream-5-0",
			prompt: "cat",
			referenceImages: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
		});
		assert.deepEqual(body.image, ["data:image/png;base64,YWJj"]);
	});
});

describe("parseImageGenOutputFormat", () => {
	test("normalizes jpg to jpeg and rejects unknown", () => {
		const { parseImageGenOutputFormat } = loadParams();
		assert.equal(parseImageGenOutputFormat("PNG"), "png");
		assert.equal(parseImageGenOutputFormat("jpg"), "jpeg");
		assert.equal(parseImageGenOutputFormat("webp", null), null);
	});
});

describe("parseImageGenReferenceImages", () => {
	test("accepts valid image contents and rejects bad mime/oversize/extra type", () => {
		const { parseImageGenReferenceImages } = loadParams();
		const good = [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }];
		assert.deepEqual(JSON.parse(JSON.stringify(parseImageGenReferenceImages(good))), good);
		assert.equal(parseImageGenReferenceImages([{ type: "image", data: "x", mimeType: "application/pdf" }]), null);
		assert.equal(parseImageGenReferenceImages([{ type: "text", data: "x", mimeType: "image/png" }]), null);
		// 超过 4 张直接整体拒绝（all-or-null），避免静默截断
		assert.equal(parseImageGenReferenceImages(new Array(5).fill(good[0])), null);
	});

	test("buildImageGenImageField converts to dataURI array", () => {
		const { buildImageGenImageField } = loadParams();
		assert.deepEqual(buildImageGenImageField([{ type: "image", data: "abc", mimeType: "image/jpeg" }]), ["data:image/jpeg;base64,abc"]);
	});
});
